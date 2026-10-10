import type { AgentName, AgentStep, CoachAlert, Comment, LiveState, Product, Topic, TriageResult } from './types';
import { checkPrice, rm } from './priceGuard';
import { cancelledReply, declineOfferReply, factReply, nothingToCancelReply, priceReply, reservedReply, soldOutReply, stockReply, TOPIC_LABEL, voucherReply } from './replies';
import { nextId, now } from './store';

// The effects every decision ends in. Whoever decides — a tool-calling agent or
// the keyword rules — the stock, the price check and the buyer-facing sentence
// all come from this file, so they are identical and auditable either way.

/** One comment may reserve at most this many units; more needs the seller. */
const BULK_LIMIT = 20;

export const unitPrice = (s: LiveState, p: Product) => s.deals[p.sku] ?? p.price;

export function say(s: LiveState, text: string, replyTo?: string, role: Comment['role'] = 'ai', by?: AgentName): void {
  s.comments.push({
    id: nextId('c'), role, user: role === 'ai' ? 'StreamSense' : 'Host', text, ts: now(), handled: true, replyTo, by,
    // On a read-only platform feed we cannot post, so the reply is a line for the host to say.
    draft: role === 'ai' && s.source?.readOnly ? true : undefined,
  });
}

export function log(s: LiveState, steps: AgentStep[], c?: Pick<Comment, 'user' | 'text'> & { id?: string }): void {
  s.activities.push({ id: nextId('a'), ts: now(), commentId: c?.id, user: c?.user, text: c?.text, steps });
}

/** Record an answer the seller confirmed: usable now, and carried into her next live. */
export function confirmFact(s: LiveState, p: Product, topic: Topic, text: string): void {
  p.facts[topic] = text;
  const known = (s.workspace.knownFacts ??= {});
  (known[p.sku] ??= {})[topic] = text;
}

export function alertHost(s: LiveState, alert: Omit<CoachAlert, 'id' | 'ts'>): void {
  s.alerts.push({ id: nextId('w'), ts: now(), ...alert });
}

export interface Outcome {
  result: 'cancelled' | 'nothing_to_cancel' | 'reserved' | 'sold_out' | 'answered' | 'sent_to_host' | 'declined_offer' | 'host_warned' | 'ignored';
  detail?: string;
}

/** A buyer takes back what they reserved but have not paid for; the units return to the shelf. */
export function cancelItems(s: LiveState, c: Comment, lang: Comment['lang'] & string, sku: string | undefined, lead: AgentStep[]): Outcome {
  const mine = s.reservations.filter((r) => r.buyer === c.user && r.status === 'reserved' && (!sku || r.sku === sku));
  const steps = [...lead];
  c.label = 'order';
  c.lang = lang as Comment['lang'];
  c.handled = true;
  let units = 0;
  for (const r of mine) {
    const p = s.products.find((x) => x.sku === r.sku);
    if (!p) continue;
    r.status = 'released';
    const before = p.stock;
    p.stock += r.qty;
    units += r.qty;
    steps.push({ agent: 'Order & Stock', summary: `released ${r.qty} × ${p.name} · stock ${before} → ${p.stock}`, ok: true });
  }
  if (units === 0) {
    steps.push({ agent: 'Order & Stock', summary: 'nothing unpaid in this buyer’s cart', ok: false });
    say(s, nothingToCancelReply(lang as 'ms' | 'en' | 'zh', c.user), c.id, 'ai', 'Order & Stock');
  } else {
    say(s, cancelledReply(lang as 'ms' | 'en' | 'zh', c.user, units), c.id, 'ai', 'Order & Stock');
  }
  log(s, steps, c);
  return units ? { result: 'cancelled', detail: `${units} unit(s) returned to stock` } : { result: 'nothing_to_cancel' };
}

/**
 * Carry out one decision about one comment.
 * `lead` is the trace of who decided (agent hand-offs and tool calls); without
 * it the decision is attributed to the Triage rules.
 */
export function applyDecision(s: LiveState, c: Comment, r: TriageResult, lead?: AgentStep[]): Outcome {
  const p = s.products.find((x) => x.sku === r.sku);
  const lang = r.lang;
  const steps: AgentStep[] = lead ? [...lead] : [{ agent: 'Triage', summary: `${r.label} · ${r.reason}` }];
  let outcome: Outcome = { result: 'ignored' };
  c.label = r.label;
  c.lang = lang;
  c.sku = p?.sku;
  c.topic = r.topic;
  c.handled = true;

  const escalate = (reason: string, hint?: string) => {
    c.label = 'escalate';
    c.handled = false;
    s.escalations.push({
      id: nextId('e'), commentId: c.id, user: c.user, text: c.text, sku: p?.sku,
      topic: r.topic ?? 'other', reason, hint, status: 'open', ts: now(),
      // Whoever acted last is the one handing it over (a specialist, or a gate that refused).
      by: steps[steps.length - 1]?.agent,
    });
    outcome = { result: 'sent_to_host', detail: reason };
  };

  if (r.label === 'order' && p) {
    const asked = r.qty ?? 1;
    const qty = Math.min(asked, p.stock);
    if (asked > BULK_LIMIT) {
      steps.push({ agent: 'Order & Stock', summary: `${asked} units is a bulk order — not reserved without the host`, ok: false });
      escalate(`Bulk order: ${asked} × ${p.name}`, `${p.stock} in stock. Confirm with the buyer, then they can add to cart.`);
    } else if (qty <= 0) {
      steps.push({ agent: 'Order & Stock', summary: `${p.name} is sold out — nothing reserved`, ok: false });
      say(s, soldOutReply(lang, c.user, p), c.id, 'ai', 'Order & Stock');
      outcome = { result: 'sold_out' };
    } else {
      const unit = unitPrice(s, p);
      const before = p.stock;
      p.stock -= qty;
      s.reservations.push({ id: nextId('r'), commentId: c.id, buyer: c.user, sku: p.sku, qty, unitPrice: unit, status: 'reserved', ts: now() });
      steps.push({ agent: 'Order & Stock', summary: `reserved ${qty} × ${p.name} · stock ${before} → ${p.stock}`, ok: true });
      steps.push({ agent: 'Price Guard', summary: `${rm(unit)} ≥ floor ${rm(p.floor)}`, ok: checkPrice(unit, p.floor).ok });
      say(s, reservedReply(lang, c.user, qty, p, asked), c.id, 'ai', 'Order & Stock');
      outcome = { result: 'reserved', detail: `${qty} of ${asked} asked; ${p.stock} left` };
    }
  } else if (r.label === 'auto_reply' && p) {
    const topic = r.topic ?? 'other';
    outcome = { result: 'answered' };
    if (topic === 'price') {
      say(s, priceReply(lang, c.user, p, unitPrice(s, p)), c.id, 'ai', 'Support');
    } else if (topic === 'voucher') {
      const open = s.vouchers.filter((v) => v.active && v.usedBy.length < v.limit);
      say(s, voucherReply(lang, c.user, open.length ? open.map((v) => `${rm(v.amountOff)} off${v.minSpend ? ` (min ${rm(v.minSpend)})` : ''}`).join(', ') : undefined), c.id, 'ai', 'Support');
    } else if (topic === 'stock') {
      say(s, stockReply(lang, c.user, p), c.id, 'ai', 'Support');
    } else if (p.facts[topic]) {
      steps.push({ agent: 'Grounding Gate', summary: `answer backed by seller fact "${topic}"`, ok: true });
      say(s, factReply(c.user, p.facts[topic]!), c.id, 'ai', 'Support');
    } else {
      // The model proposes, the gate disposes: no confirmed fact, no auto-reply.
      steps.push({ agent: 'Grounding Gate', summary: `no confirmed fact for ${TOPIC_LABEL[topic]} → ask the host`, ok: false });
      escalate(`No confirmed answer about ${TOPIC_LABEL[topic]}`);
    }
  } else if (r.label === 'escalate') {
    if (p && r.offerPrice !== undefined) {
      const verdict = checkPrice(r.offerPrice, p.floor);
      if (verdict.ok) {
        steps.push({ agent: 'Price Guard', summary: `offer ${rm(r.offerPrice)} ≥ floor ${rm(p.floor)} — safe to accept`, ok: true });
        escalate(`Buyer offers ${rm(r.offerPrice)} for ${p.name}`, `Above your floor of ${rm(p.floor)}. Your call.`);
      } else {
        steps.push({ agent: 'Price Guard', summary: `offer ${rm(r.offerPrice)} < floor ${rm(p.floor)} — declined for you`, ok: false });
        c.label = 'auto_reply';
        say(s, declineOfferReply(lang, c.user, p, unitPrice(s, p)), c.id, 'ai', 'Price Guard');
        outcome = { result: 'declined_offer' };
      }
    } else {
      escalate(r.reason, p && r.topic === 'discount' ? `Lowest safe price for ${p.name}: ${rm(p.floor)}` : undefined);
    }
  } else if (r.label === 'warn') {
    steps.push({ agent: 'Coach', summary: 'policy risk — do not confirm this claim', ok: false });
    alertHost(s, {
      kind: 'policy', by: 'Support', sku: p?.sku,
      text: `@${c.user} asked "${c.text}". Do NOT confirm health claims — say it's food, not medicine.`,
    });
    outcome = { result: 'host_warned' };
  } else if (r.label !== 'ignore') {
    // An order or question that names no product we sell.
    escalate('Could not tell which product');
  }

  if (r.label !== 'ignore') log(s, steps, c);
  return outcome;
}
