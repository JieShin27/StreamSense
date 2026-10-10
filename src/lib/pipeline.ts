import type { Comment, LiveState } from './types';
import { runCoachAgent, runTeam } from './agents/team';
import { agentsRestingUntil, clearCooling, llmConfigured } from './agents/runtime';
import { alertHost, applyDecision, confirmFact, log, say } from './backstage';
import { coachRules } from './coach';
import { checkPrice, rm } from './priceGuard';
import { factReply } from './replies';
import { productsFromFloors, REPLAY_SCRIPT } from './seed';
import type { FloorRow } from './seed';
import { getState, nextId, now, reset, update } from './store';
import { rulesTriage } from './triage';

export { applyDecision } from './backstage';

// Long enough to gather a burst into one batch: fewer model calls for the same comments.
const BATCH_MS = 2500;
const BATCH_MAX = 20;

interface Timers {
  queue: string[];
  flush?: ReturnType<typeof setTimeout>;
  replay?: ReturnType<typeof setTimeout>;
  ttl?: ReturnType<typeof setInterval>;
  busy: boolean;
  coachBusy?: boolean;
  lastFlushAt?: number;
  /** Buyer-comment count when the Coach Agent last ran. */
  coachAt?: number;
}
const g = globalThis as unknown as { __streamsenseTimers?: Timers };
const timers: Timers = (g.__streamsenseTimers ??= { queue: [], busy: false });

const COACH_EVERY = 10;

function runCoach(s: LiveState, agentsOn: boolean): void {
  for (const d of coachRules(s)) {
    // With agents running, flash-deal ideas come from the Coach Agent instead.
    if (agentsOn && d.kind === 'flash_deal') continue;
    const { key, ...alert } = d;
    s.coachFired.push(key);
    alertHost(s, { ...alert, by: 'Coach' });
    log(s, [{ agent: 'Coach', summary: alert.text }]);
  }
}

/** The Coach Agent thinks in the background; comments never wait for it. */
function maybeRunCoachAgent(): void {
  const seen = getState().comments.filter((c) => c.role === 'buyer').length;
  if (timers.coachBusy || seen - (timers.coachAt ?? 0) < COACH_EVERY) return;
  timers.coachBusy = true;
  timers.coachAt = seen;
  runCoachAgent()
    .catch((err) => console.warn('[agents] Coach skipped:', (err as Error).message))
    .finally(() => (timers.coachBusy = false));
}

async function flush(): Promise<void> {
  timers.flush = undefined;
  if (timers.busy) return schedule();
  const ids = timers.queue.splice(0, BATCH_MAX);
  if (ids.length === 0) return;

  timers.busy = true;
  timers.lastFlushAt = Date.now();
  try {
    const batch = ids.map((id) => getState().comments.find((c) => c.id === id)).filter((c): c is Comment => !!c);
    // While every model is rate-limited, do not spend requests finding that out again.
    const resting = agentsRestingUntil();
    const agentsOn = llmConfigured() && !resting;
    let done = new Set<string>();
    if (agentsOn) {
      try {
        done = await runTeam(batch);
      } catch (err) {
        console.warn('[agents] team unavailable, using rules:', (err as Error).message);
      }
    }
    update((s) => {
      s.triageMode = done.size > 0 ? 'agents' : 'rules';
      const until = agentsRestingUntil();
      s.agentsRestingUntil = until ? new Date(until).toISOString() : undefined;
      // Safety net: anything the agents did not touch still gets a decision.
      for (const b of batch) {
        if (done.has(b.id)) continue;
        const c = s.comments.find((x) => x.id === b.id);
        if (c) applyDecision(s, c, rulesTriage(c, s.products, s.spotlightSku));
      }
      runCoach(s, done.size > 0);
    });
    if (done.size > 0) maybeRunCoachAgent();
  } catch (err) {
    console.error('[pipeline] batch failed:', err);
  } finally {
    timers.busy = false;
    if (timers.queue.length) schedule();
  }
}

function schedule(): void {
  // A lone comment in a quiet room goes straight to the team; batching only kicks in during a flood.
  const quiet = !timers.busy && Date.now() - (timers.lastFlushAt ?? 0) > BATCH_MS;
  timers.flush ??= setTimeout(flush, quiet ? 150 : BATCH_MS);
}

/**
 * A buyer comment enters the room. `source` names a real platform feed
 * (e.g. "TikTok @shop"); those are read-only, so replies become drafts.
 */
export function addBuyerComment(user: string, text: string, source?: string): Comment {
  const c: Comment = { id: nextId('c'), role: 'buyer', user, text, ts: now(), handled: false };
  update((s) => {
    if (source) {
      s.source = { name: source, readOnly: true, received: (s.source?.name === source ? s.source.received : 0) + 1 };
    }
    s.comments.push(c);
  });
  timers.queue.push(c.id);
  schedule();
  ensureTtlSweep();
  return c;
}

/** A note for the host from outside the live team (WorkBuddy over MCP). */
export function hostNote(text: string, from: 'WorkBuddy' = 'WorkBuddy'): void {
  update((s) => {
    alertHost(s, { kind: 'workbuddy', by: 'WorkBuddy', text });
    log(s, [{ agent: from, summary: text }]);
  });
}

/** The seller presses Go live: the clock starts and buyers can comment. */
export function goLive(): void {
  update((s) => {
    if (s.session.status === 'live') return;
    s.session.status = 'live';
    s.session.startedAt = now();
    s.session.endedAt = undefined;
    say(s, 'We are live! Selamat datang 👋', undefined, 'host');
  });
}

/** The seller ends the live. Carts and private chat stay open for the wrap-up. */
export function endLive(): void {
  stopReplay();
  update((s) => {
    if (s.session.status !== 'live') return;
    s.session.status = 'ended';
    s.session.endedAt = now();
    say(s, 'The live has ended. Terima kasih! Your cart stays open for checkout.', undefined, 'host');
  });
}

// ---------------------------------------------------------------------------
// Host actions
// ---------------------------------------------------------------------------

/** The seller proposes a flash-deal price. Below the floor, it never goes live. */
export function proposeDeal(sku: string, price: number, by: 'host' | 'WorkBuddy' = 'host') {
  return update((s) => {
    const p = s.products.find((x) => x.sku === sku);
    if (!p || !Number.isFinite(price) || price <= 0) return { ok: false as const, error: 'Unknown product or price' };
    const verdict = checkPrice(price, p.floor);
    if (!verdict.ok) {
      s.blockedDiscounts.push({ sku, attempted: price, floor: p.floor, ts: now() });
      log(s, [
        ...(by === 'WorkBuddy' ? [{ agent: 'WorkBuddy' as const, summary: `propose_flash_deal(${p.name}, ${rm(price)})` }] : []),
        { agent: 'Price Guard', summary: `BLOCKED ${rm(price)} deal on ${p.name} — floor is ${rm(p.floor)}. Safe deal: ${rm(verdict.safePrice)}`, ok: false },
      ]);
      return { ok: false as const, blocked: true, floor: p.floor, safePrice: verdict.safePrice };
    }
    s.deals[sku] = price;
    log(s, [
      ...(by === 'WorkBuddy' ? [{ agent: 'WorkBuddy' as const, summary: `propose_flash_deal(${p.name}, ${rm(price)})` }] : []),
      { agent: 'Price Guard', summary: `flash deal ${rm(price)} on ${p.name} approved (floor ${rm(p.floor)})`, ok: true },
    ]);
    say(s, `⚡ FLASH DEAL: ${p.name} ${rm(price)} (biasa ${rm(p.price)})`, undefined, 'host');
    return { ok: true as const, price };
  });
}

/**
 * WorkBuddy proposes a flash-deal price. The Price Guard checks it; a price
 * that passes is shown to the seller as a suggestion — it is not put live for her.
 */
export function suggestDeal(sku: string, price: number, why = '') {
  return update((s) => {
    const p = s.products.find((x) => x.sku === sku);
    if (!p || !Number.isFinite(price) || price <= 0) return { ok: false as const, error: 'Unknown product or price' };
    const verdict = checkPrice(price, p.floor);
    const lead = { agent: 'WorkBuddy' as const, summary: `proposes ${rm(price)} for ${p.name}` };
    if (!verdict.ok) {
      s.blockedDiscounts.push({ sku, attempted: price, floor: p.floor, ts: now() });
      log(s, [lead, { agent: 'Price Guard', summary: `rejected — ${rm(price)} would lose money. Lowest safe: ${rm(verdict.safePrice)}`, ok: false }]);
      return { ok: false as const, blocked: true, safePrice: verdict.safePrice };
    }
    alertHost(s, { kind: 'flash_deal', by: 'WorkBuddy', sku, text: `Flash deal idea: ${p.name} at ${rm(price)} (now ${rm(s.deals[sku] ?? p.price)}). ${why}`.trim() });
    log(s, [lead, { agent: 'Price Guard', summary: `${rm(price)} ≥ floor ${rm(p.floor)} — shown to the seller`, ok: true }]);
    return { ok: true as const, price };
  });
}

/** WorkBuddy drafts an answer for a buyer who is waiting on the seller; she approves or edits it. */
export function suggestAnswer(buyer: string, answer: string) {
  return update((s) => {
    const name = buyer.replace(/^@+/, '').toLowerCase();
    const e = s.escalations.find((x) => x.status === 'open' && x.user.toLowerCase() === name && !x.suggestion);
    const text = answer.trim().slice(0, 300);
    if (!e || !text) return { ok: false as const, error: 'No open question from that buyer' };
    e.suggestion = text;
    log(s, [{ agent: 'WorkBuddy', summary: `drafted an answer for @${e.user}: “${text}”`, ok: true }]);
    return { ok: true as const };
  });
}

export function setSpotlight(sku: string): void {
  update((s) => {
    if (s.products.some((p) => p.sku === sku)) s.spotlightSku = sku;
  });
}

/** The host answers once; the answer becomes a product fact and clears every matching question. */
export function answerEscalation(id: string, answer: string): void {
  update((s) => {
    const e = s.escalations.find((x) => x.id === id);
    if (!e || e.status !== 'open' || !answer.trim()) return;
    const text = answer.trim();
    const p = s.products.find((x) => x.sku === e.sku);
    const reusable = p && e.topic !== 'discount' && e.topic !== 'other';
    if (reusable) confirmFact(s, p, e.topic, text);

    const same = reusable
      ? s.escalations.filter((x) => x.status === 'open' && x.sku === e.sku && x.topic === e.topic)
      : [e];
    for (const x of same) {
      x.status = 'answered';
      x.answer = text;
      const c = s.comments.find((k) => k.id === x.commentId);
      if (c) c.handled = true;
      say(s, factReply(x.user, text), x.commentId, 'host');
    }
    log(s, [{
      agent: 'Triage',
      summary: reusable
        ? `learned "${e.topic}" for ${p.name} from the host — answered ${same.length} buyer(s), will auto-reply next time`
        : `host answered @${e.user}`,
      ok: true,
    }]);
  });
}

export function releaseReservation(id: string, why = 'released by host'): void {
  update((s) => {
    const r = s.reservations.find((x) => x.id === id);
    if (!r || r.status !== 'reserved') return;
    r.status = 'released';
    const p = s.products.find((x) => x.sku === r.sku);
    if (!p) return;
    const before = p.stock;
    p.stock += r.qty;
    log(s, [{ agent: 'Order & Stock', summary: `${why}: ${r.qty} × ${p.name} from @${r.buyer} · stock ${before} → ${p.stock}` }]);
  });
}

function ensureTtlSweep(): void {
  const ttl = Number(process.env.RESERVATION_TTL_SEC) || 0;
  if (!ttl || timers.ttl) return;
  timers.ttl = setInterval(() => {
    const cutoff = Date.now() - ttl * 1000;
    for (const r of getState().reservations) {
      if (r.status === 'reserved' && Date.parse(r.ts) < cutoff) releaseReservation(r.id, 'unpaid, auto-released');
    }
  }, 5000);
}

/** Load the pre-live output (price_floors.json) and start a clean live with it. */
export function importFloors(payload: unknown): { ok: boolean; error?: string; count?: number } {
  const rows = (payload as { products?: unknown })?.products;
  if (!Array.isArray(rows) || rows.length === 0) return { ok: false, error: 'Expected { "products": [...] }' };
  const clean: FloorRow[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    const price = Number(row?.price);
    const floor = Number(row?.floor);
    const stock = Number(row?.stock);
    if (typeof row?.sku !== 'string' || typeof row?.name !== 'string' || !(price > 0) || !(floor > 0) || !(stock >= 0)) {
      return { ok: false, error: `Bad row: ${JSON.stringify(row)}` };
    }
    const aliases = Array.isArray(row.aliases) ? (row.aliases as unknown[]).filter((a): a is string => typeof a === 'string' && !!a.trim()).map((a) => a.trim().slice(0, 40)).slice(0, 8) : undefined;
    const facts = row.facts && typeof row.facts === 'object' ? Object.fromEntries(Object.entries(row.facts as Record<string, unknown>).filter(([, v]) => typeof v === 'string' && v).map(([k, v]) => [k, String(v).slice(0, 200)])) : undefined;
    clean.push({ sku: row.sku, name: row.name, price, floor, stock: Math.floor(stock), aliases, facts });
  }
  stopReplay();
  reset(productsFromFloors(clean));
  return { ok: true, count: clean.length };
}

// ---------------------------------------------------------------------------
// Scripted replay — a believable comment flood that needs no audience.
// ---------------------------------------------------------------------------

export function startReplay(): void {
  if (getState().replay.running) return;
  goLive();
  update((s) => {
    s.replay.running = true;
    if (s.replay.index >= REPLAY_SCRIPT.length) s.replay.index = 0;
  });
  const tick = () => {
    const s = getState();
    if (!s.replay.running) return;
    const line = REPLAY_SCRIPT[s.replay.index];
    if (!line) return stopReplay();
    addBuyerComment(line.user, line.text);
    update((st) => void (st.replay.index += 1));
    timers.replay = setTimeout(tick, 700 + Math.random() * 900);
  };
  tick();
}

export function stopReplay(): void {
  clearTimeout(timers.replay);
  timers.replay = undefined;
  update((s) => void (s.replay.running = false));
}

export function resetLive(): void {
  stopReplay();
  timers.queue.length = 0;
  timers.coachAt = 0;
  clearCooling();
  reset();
}
