import { alertHost, applyDecision, cancelItems, log, unitPrice } from '../backstage';
import type { Outcome } from '../backstage';
import { checkPrice, rm } from '../priceGuard';
import { getState, update } from '../store';
import { detectLang } from '../triage';
import { TOPICS } from '../types';
import type { AgentName, AgentStep, Comment, Lang, LiveState, Topic, TriageResult } from '../types';
import { runAgent } from './runtime';
import type { Tool } from './runtime';

// The live backstage team. Each agent is a model with its own instructions and
// its own tools; it decides which tool to use on which comment. The tools are
// plain code (see backstage.ts), so an agent can choose to reserve stock but
// cannot invent a price, a stock level or a product fact.

const str = { type: 'string' } as const;
const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object', properties, required, additionalProperties: false,
});

const asLang = (v: unknown, text: string): Lang => (v === 'ms' || v === 'en' || v === 'zh' ? v : detectLang(text));
const fmtArgs = (args: Record<string, unknown>) =>
  Object.entries(args).filter(([k]) => k !== 'comment_id').map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');

function catalog(s: LiveState) {
  return s.products.map((p) => ({
    sku: p.sku,
    name: p.name,
    also_called: p.aliases.slice(0, 3),
    price_now: unitPrice(s, p),
    stock: p.stock,
    confirmed_topics: ['price', 'stock', 'voucher', ...Object.keys(p.facts)],
  }));
}

interface Assignment {
  to: 'order' | 'support' | 'ignore';
  lang: Lang;
  reason: string;
}

// ---------------------------------------------------------------------------
// Triage Agent — reads every comment and hands it to a specialist
// ---------------------------------------------------------------------------

const TRIAGE_SYSTEM = `You are the Triage Agent backstage at a Malaysian live-selling stream. Buyers write in Bahasa Malaysia, English, Mandarin and Manglish, often mixed.

Call assign_comments once, with one entry for every comment you were given:
- "order": the buyer wants to buy now, is bargaining over price, or wants to cancel or change what they reserved ("nak 3 jar", "我要2罐", "+2", "RM8 boleh?", "cancel", "tukar jadi 2", "make it 3 instead of 2", "add one more")
  A buyer naming their own price is bargaining, not a price question: "sambal 10 ringgit can ah?", "RM8 boleh?" are "order".
- "support": a question about a product or the shop, or a claim the seller is asked to confirm (price, stock, halal, spicy, shelf life, shipping, payment, ingredients, size, health effects, wholesale, what else is sold)
- "ignore": greetings, compliments, emoji, spam, chatter between viewers. A real question is never "ignore": "ada jual kuih lain tak?", "boleh COD?", "what else do you sell" are all "support".
lang is the language to reply in: "ms", "en" or "zh". reason is at most 8 words.`;

async function triage(batch: Comment[]): Promise<Map<string, Assignment>> {
  const out = new Map<string, Assignment>();
  const tool: Tool = {
    name: 'assign_comments',
    description: 'Hand each comment to the specialist who should handle it.',
    parameters: obj({
      assignments: {
        type: 'array',
        items: obj({ comment_id: str, to: { type: 'string', enum: ['order', 'support', 'ignore'] }, lang: { type: 'string', enum: ['ms', 'en', 'zh'] }, reason: str },
          ['comment_id', 'to', 'lang', 'reason']),
      },
    }, ['assignments']),
    run: (args) => {
      const rows = Array.isArray(args.assignments) ? (args.assignments as Record<string, unknown>[]) : [];
      for (const row of rows) {
        const c = batch.find((x) => x.id === row.comment_id);
        if (!c || (row.to !== 'order' && row.to !== 'support' && row.to !== 'ignore')) continue;
        out.set(c.id, { to: row.to, lang: asLang(row.lang, c.text), reason: String(row.reason ?? row.to).slice(0, 80) });
      }
      return { assigned: out.size };
    },
  };
  await runAgent({ name: 'Triage', system: TRIAGE_SYSTEM, tools: [tool], maxSteps: 1 }, {
    products: getState().products.map((p) => p.name),
    comments: batch.map((c) => ({ comment_id: c.id, user: c.user, text: c.text })),
  });
  return out;
}

// ---------------------------------------------------------------------------
// Specialists
// ---------------------------------------------------------------------------

interface Desk {
  agent: AgentName;
  work: Map<string, Assignment>;
  handled: Set<string>;
  /** comment + tool + product already acted on, so one comment can order several products but not the same one twice. */
  acted: Set<string>;
}

/** Wrap one backstage effect as a tool: validate the comment, apply, record who decided. */
function effect(
  desk: Desk,
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  decide: (args: Record<string, unknown>, a: Assignment) => Omit<TriageResult, 'id' | 'lang'>,
  perProduct = false,
): Tool {
  return {
    name,
    description,
    parameters,
    run: (args) => {
      const id = String(args.comment_id);
      const a = desk.work.get(id);
      if (!a) return { error: 'that comment is not assigned to you' };
      const key = `${id}:${name}:${perProduct ? String(args.sku) : ''}`;
      if (desk.acted.has(key) || (desk.handled.has(id) && !perProduct)) return { error: 'that comment is already handled' };
      // The hand-off is shown once per comment; later tool calls on it only add their own step.
      const lead: AgentStep[] = [
        ...(desk.handled.has(id) ? [] : [{ agent: 'Triage' as const, summary: `hand-off → ${desk.agent} · ${a.reason}` }]),
        { agent: desk.agent, summary: `${name}(${fmtArgs(args)})` },
      ];
      return update((s): Outcome | { error: string } => {
        const c = s.comments.find((x) => x.id === id);
        if (!c) return { error: 'comment not found' };
        const decision = decide(args, a);
        if (decision.sku && !s.products.some((p) => p.sku === decision.sku)) return { error: `unknown sku ${decision.sku}` };
        desk.handled.add(id);
        desk.acted.add(key);
        return applyDecision(s, c, { id, lang: a.lang, ...decision }, lead);
      });
    },
  };
}

const ORDER_SYSTEM = `You are the Order & Stock Agent backstage at a Malaysian live-selling stream. Each comment you receive is from a buyer who wants to buy or is bargaining.

Handle every comment with a tool:
- reserve_stock: the buyer wants a quantity of a product. If they name no product at all, use the product on camera. If they name no quantity, reserve 1. If one comment asks for several products, call it once per product, all in the same turn.
- cancel_reservation: the buyer wants to cancel what they reserved. To change a quantity ("tukar jadi 2", "make it 3 instead"), call cancel_reservation for that product and reserve_stock with the new quantity in the same turn.
- check_buyer_offer: the buyer proposes a price ("RM8 boleh?"). The Price Guard decides; you never agree to a price yourself.
- ask_host: you cannot tell what they want, they ask for a discount without naming a price, or they name a product that is not in the product list. Never substitute a different product for the one they asked for.
A tool result tells you what really happened (for example fewer units reserved than asked, or sold out). You never write to the buyer; replies are sent for you. When every comment is handled, stop.`;

const SUPPORT_SYSTEM = `You are the Support Agent backstage at a Malaysian live-selling stream. Each comment you receive is a buyer question or a claim.

Use exactly one tool per comment:
- answer_from_facts: the question is about one of: ${TOPICS.filter((t) => t !== 'discount' && t !== 'other').join(', ')}. The tool only answers from the seller's confirmed facts and live numbers; if there is no confirmed fact it sends the question to the host by itself. So for these topics always call answer_from_facts and let the tool decide; never judge yourself whether a fact exists.
- flag_health_claim: the buyer asks the seller to confirm a medical or health effect (lowers blood pressure, cures diabetes, slimming). Never answer these.
- ask_host: anything else that needs the seller. This includes discounts, wholesale or bulk prices, a price the buyer proposes, payment methods, and products that are not in the list. answer_from_facts with topic "price" is only for "how much is it?", and topic "shipping" is only for delivery areas and postage, not for COD or how to pay.
You never write to the buyer and you never state a fact yourself. When every comment is handled, stop.`;

function orderTools(desk: Desk): Tool[] {
  return [
    effect(desk, 'reserve_stock', 'Reserve units of a product for a buyer and send them the checkout nudge.',
      obj({ comment_id: str, sku: str, qty: { type: 'integer', minimum: 1 } }, ['comment_id', 'sku', 'qty']),
      (a) => ({ label: 'order', sku: String(a.sku), qty: Math.max(1, Math.min(Math.floor(Number(a.qty)) || 1, 99)), reason: 'buying intent' }), true),
    {
      name: 'cancel_reservation',
      description: "Remove a buyer's unpaid items from their cart and return them to stock. Give sku to cancel one product, or leave it out to cancel everything unpaid.",
      parameters: obj({ comment_id: str, sku: str }, ['comment_id']),
      run: (args) => {
        const id = String(args.comment_id);
        const a = desk.work.get(id);
        if (!a) return { error: 'that comment is not assigned to you' };
        const sku = args.sku ? String(args.sku) : undefined;
        return update((s) => {
          const c = s.comments.find((x) => x.id === id);
          if (!c) return { error: 'comment not found' };
          if (sku && !s.products.some((p) => p.sku === sku)) return { error: `unknown sku ${sku}` };
          const lead: AgentStep[] = [
            ...(desk.handled.has(id) ? [] : [{ agent: 'Triage' as const, summary: `hand-off → ${desk.agent} · ${a.reason}` }]),
            { agent: desk.agent, summary: `cancel_reservation(${fmtArgs(args)})` },
          ];
          desk.handled.add(id);
          return cancelItems(s, c, a.lang, sku, lead);
        });
      },
    },
    effect(desk, 'check_buyer_offer', 'Ask the Price Guard whether a price proposed by a buyer is acceptable.',
      obj({ comment_id: str, sku: str, offer_price: { type: 'number' } }, ['comment_id', 'sku', 'offer_price']),
      (a) => ({ label: 'escalate', topic: 'discount', sku: String(a.sku), offerPrice: Number(a.offer_price) || 0, reason: `buyer offers ${rm(Number(a.offer_price) || 0)}` })),
    effect(desk, 'ask_host', 'Send the comment to the seller because it needs a human decision.',
      obj({ comment_id: str, sku: str, reason: str }, ['comment_id', 'reason']),
      (a) => ({ label: 'escalate', topic: 'discount', sku: a.sku ? String(a.sku) : getState().spotlightSku, reason: String(a.reason).slice(0, 120) })),
  ];
}

function supportTools(desk: Desk): Tool[] {
  return [
    effect(desk, 'answer_from_facts', "Answer from the seller's confirmed facts and live numbers. Escalates by itself when no fact is confirmed.",
      obj({ comment_id: str, sku: str, topic: { type: 'string', enum: TOPICS.filter((t) => t !== 'discount' && t !== 'other') } }, ['comment_id', 'sku', 'topic']),
      (a) => ({ label: 'auto_reply', sku: String(a.sku), topic: TOPICS.includes(a.topic as Topic) ? (a.topic as Topic) : 'other', reason: `asks about ${a.topic}` })),
    effect(desk, 'flag_health_claim', 'Warn the seller not to confirm a medical or health claim. Nothing is sent to the buyer.',
      obj({ comment_id: str, sku: str }, ['comment_id']),
      (a) => ({ label: 'warn', sku: a.sku ? String(a.sku) : getState().spotlightSku, reason: 'health claim' })),
    effect(desk, 'ask_host', 'Send the question to the seller because only they can answer.',
      obj({ comment_id: str, sku: str, reason: str }, ['comment_id', 'reason']),
      (a) => ({ label: 'escalate', topic: 'other', sku: a.sku ? String(a.sku) : getState().spotlightSku, reason: String(a.reason).slice(0, 120) })),
  ];
}

const SEVERAL_ACTIONS = /\b(and|dan|dgn|dengan|sama|with|plus|also|juga|jugak|instead|tukar|change|make it|jadi)\b|[,&+]|和|跟|还有|加|改|换/i;

async function runDesk(agent: AgentName, system: string, tools: (d: Desk) => Tool[], work: Map<string, Assignment>, batch: Comment[]): Promise<Set<string>> {
  const desk: Desk = { agent, work, handled: new Set(), acted: new Set() };
  if (work.size === 0) return desk.handled;
  const s = getState();
  try {
    // Once every comment has been dealt with there is nothing left to decide: skip the closing model call.
    const mine = batch.filter((c) => work.has(c.id));
    // Two products in one comment, or a change of mind, can take a second round of tool calls.
    const mayNeedMore = mine.some((c) => SEVERAL_ACTIONS.test(c.text));
    await runAgent({ name: agent, system, tools: tools(desk), maxSteps: 4, done: () => !mayNeedMore && desk.handled.size >= work.size }, {
      on_camera_sku: s.spotlightSku,
      products: catalog(s),
      comments: mine.map((c) => ({ comment_id: c.id, user: c.user, text: c.text, reply_language: work.get(c.id)!.lang })),
    });
  } catch (err) {
    // Keep whatever the agent already did; the rest falls back to rules.
    console.warn(`[agents] ${agent} stopped early:`, (err as Error).message);
  }
  return desk.handled;
}

/**
 * Run one batch through the team. Returns the ids the agents dealt with; the
 * caller sends everything else through the keyword rules.
 */
export async function runTeam(batch: Comment[]): Promise<Set<string>> {
  const assigned = await triage(batch);
  // Show the hand-off on screen straight away, before the specialists finish.
  update((s) => {
    for (const [id, a] of assigned) {
      const c = s.comments.find((x) => x.id === id);
      if (c && a.to !== 'ignore') c.routedTo = a.to === 'order' ? 'Order & Stock' : 'Support';
    }
  });
  const pick = (to: Assignment['to']) => new Map([...assigned].filter(([, a]) => a.to === to));

  const done = new Set<string>();
  update((s) => {
    for (const [id, a] of pick('ignore')) {
      const c = s.comments.find((x) => x.id === id);
      if (!c) continue;
      applyDecision(s, c, { id, lang: a.lang, label: 'ignore', reason: a.reason });
      done.add(id);
    }
  });

  // Order and Support work their own queues at the same time.
  const [orders, answers] = await Promise.all([
    runDesk('Order & Stock', ORDER_SYSTEM, orderTools, pick('order'), batch),
    runDesk('Support', SUPPORT_SYSTEM, supportTools, pick('support'), batch),
  ]);
  for (const id of [...orders, ...answers]) done.add(id);
  return done;
}

// ---------------------------------------------------------------------------
// Coach Agent — steps back every so often and advises the host
// ---------------------------------------------------------------------------

const COACH_SYSTEM = `You are the Coach Agent for a solo Malaysian live seller. You see a snapshot of her live: stock, reservations, what buyers are asking, and what is waiting for her.

Give at most two pieces of advice that would change what she does in the next minute. Prefer concrete actions: which product to show next, what to announce, which question to answer on camera.
- nudge_host: a short instruction she can read at a glance (max 20 words, plain English).
- suggest_flash_deal: propose a deal price for a slow product. You do not know her costs. The Price Guard will reject a price that loses money and tell you the lowest safe price; if rejected, propose again at or above it, or drop the idea.
If nothing is worth saying, call no tool.`;

export async function runCoachAgent(): Promise<void> {
  const s = getState();
  const recent = s.comments.filter((c) => c.role === 'buyer').slice(-25);
  const tools: Tool[] = [
    {
      name: 'nudge_host',
      description: 'Show the host one short instruction.',
      parameters: obj({ text: str, sku: str }, ['text']),
      run: (args) => update((st) => {
        const text = String(args.text).slice(0, 200);
        alertHost(st, { kind: 'coach', by: 'Coach', text, sku: args.sku ? String(args.sku) : undefined });
        log(st, [{ agent: 'Coach', summary: `nudge_host: ${text}` }]);
        return { shown: true };
      }),
    },
    {
      name: 'suggest_flash_deal',
      description: 'Propose a flash-deal price for a product. Checked by the Price Guard before the host sees it.',
      parameters: obj({ sku: str, price: { type: 'number' }, pitch: str }, ['sku', 'price', 'pitch']),
      run: (args) => update((st) => {
        const p = st.products.find((x) => x.sku === args.sku);
        const price = Number(args.price);
        if (!p || !(price > 0)) return { error: 'unknown product or price' };
        const verdict = checkPrice(price, p.floor);
        if (!verdict.ok) {
          log(st, [
            { agent: 'Coach', summary: `suggest_flash_deal(${p.name}, ${rm(price)})` },
            { agent: 'Price Guard', summary: `rejected — ${rm(price)} would lose money. Lowest safe: ${rm(verdict.safePrice)}`, ok: false },
          ]);
          return { rejected: true, reason: 'below the seller’s floor price', lowest_safe_price: verdict.safePrice };
        }
        const text = `Flash deal idea: ${p.name} at ${rm(price)} (now ${rm(unitPrice(st, p))}). ${String(args.pitch).slice(0, 140)}`;
        alertHost(st, { kind: 'flash_deal', by: 'Coach', sku: p.sku, text });
        log(st, [
          { agent: 'Coach', summary: `suggest_flash_deal(${p.name}, ${rm(price)})` },
          { agent: 'Price Guard', summary: `${rm(price)} ≥ floor ${rm(p.floor)} — shown to host`, ok: true },
        ]);
        return { accepted: true, shown_to_host: true };
      }),
    },
  ];

  await runAgent({ name: 'Coach', system: COACH_SYSTEM, tools, maxSteps: 3 }, {
    on_camera_sku: s.spotlightSku,
    products: s.products.map((p) => ({
      sku: p.sku, name: p.name, price_now: unitPrice(s, p), stock: p.stock, stock_at_start: p.stockStart,
      reserved_units: s.reservations.filter((r) => r.sku === p.sku && r.status === 'reserved').reduce((n, r) => n + r.qty, 0),
    })),
    waiting_for_host: s.escalations.filter((e) => e.status === 'open').map((e) => ({ sku: e.sku, topic: e.topic, text: e.text })),
    recent_comments: recent.map((c) => ({ text: c.text, label: c.label })),
    advice_already_given: s.alerts.slice(-6).map((a) => a.text),
  });
}
