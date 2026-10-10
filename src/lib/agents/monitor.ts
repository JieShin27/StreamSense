import { alertHost, confirmFact, log, unitPrice } from '../backstage';
import { getState, nextId, now, update } from '../store';
import { matchProduct } from '../triage';
import type { Topic } from '../types';
import { agentsRestingUntil, llmConfigured, runAgent } from './runtime';
import type { Tool } from './runtime';

// The Host Monitor listens to the seller. Each thing she says on camera is
// checked against what is actually true tonight — prices, stock, the facts she
// has confirmed — and she is warned when they do not match. When she states a
// new product fact, it is remembered so buyers' questions about it can be
// answered without her.

const FACT_TOPICS: Topic[] = ['halal', 'spicy', 'expiry', 'shipping', 'ingredients', 'size'];

const SYSTEM = `You are the Host Monitor for a solo Malaysian live seller. You hear what she says on camera, as text from speech recognition (it may contain small transcription mistakes, and mixes Bahasa Malaysia, English and Mandarin). You are given tonight's true data.

For what she just said, decide:
- warn_seller — only when she clearly said something that is wrong or risky:
    wrong_price   a price that differs from price_now for that product (if it is lower, tell her the listed price and that a real flash deal must be set in Stock so buyers actually get it)
    wrong_stock   a stock figure that contradicts the stock number
    wrong_fact    a statement that contradicts confirmed_facts
    health_claim  any medical or health benefit
    risky_promise a guarantee or promise that is not in confirmed_facts: money back, refunds, free shipping, "confirm halal", "the best", delivery dates; or a voucher or discount that is not in active_vouchers (tell her to create it on her screen first so buyers can actually use it)
  Give a correction she can say out loud in one short sentence, in the language she was speaking.
- remember_fact — she states a product fact on one of these topics that is not yet in confirmed_facts: ${FACT_TOPICS.join(', ')}. Never use it for health claims, prices or stock.
- Otherwise call no tool. Greetings, selling talk, opinions ("sedap", "very nice") and anything you are unsure about need no action. Do not warn twice about the same thing. If one sentence contains two different problems, call warn_seller once for each.`;

const str = { type: 'string' } as const;
const RELEVANT = /\d|voucher|baucar|kupon|coupon|diskaun|discount|rm\b|ringgit|harga|price|stok|stock|tinggal|left|habis|halal|tahan|expire|luput|pedas|spicy|辣|bahan|ingredient|gram|saiz|size|pos\b|postage|shipping|hantar|free|percuma|jamin|guarantee|refund|return|money|duit|pulang|confirm|sure|ubat|cure|sembuh|sihat|health|darah|kencing|kurus|slim|best|terbaik|免费|保证|退|清真|多少/i;

interface Pending {
  lines: { id: string; text: string; codeFlag?: string }[];
  timer?: ReturnType<typeof setTimeout>;
  busy: boolean;
}
const g = globalThis as unknown as { __streamsenseMonitor?: Pending };
const pending: Pending = (g.__streamsenseMonitor ??= { lines: [], busy: false });

/** Called for every finished sentence. Cheap talk is dropped here so the model only sees what could matter. */
export function monitorHeard(id: string, text: string, codeFlag?: string): void {
  if (!llmConfigured()) return;
  const s = getState();
  if (!RELEVANT.test(text) && !matchProduct(text, s.products)) return;
  pending.lines.push({ id, text, codeFlag });
  // She often says one thought across two recognised sentences: wait a moment and check them together.
  pending.timer ??= setTimeout(review, 1200);
}

async function review(): Promise<void> {
  pending.timer = undefined;
  if (pending.busy) {
    pending.timer = setTimeout(review, 1500);
    return;
  }
  const lines = pending.lines.splice(0, 6);
  if (lines.length === 0 || agentsRestingUntil()) return;
  pending.busy = true;

  const s = getState();
  const said = lines.map((l) => l.text).join(' ');
  const tools: Tool[] = [
    {
      name: 'warn_seller',
      description: 'Show the seller an urgent correction on her own screen.',
      parameters: {
        type: 'object',
        required: ['problem', 'what_she_said', 'correction'],
        properties: {
          problem: { type: 'string', enum: ['wrong_price', 'wrong_stock', 'wrong_fact', 'health_claim', 'risky_promise'] },
          what_she_said: str,
          correction: { type: 'string', description: 'One short sentence she can say to fix it.' },
          sku: str,
        },
      },
      run: (args) => update((st) => {
        const quote = String(args.what_she_said ?? said).slice(0, 160);
        const fix = String(args.correction ?? '').slice(0, 200);
        const problem = String(args.problem ?? 'wrong_fact').replace('_', ' ');
        // Only what she said just now can be warned about; earlier lines are context and were already judged.
        const words = (t: string) => t.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, ' ').trim();
        const about = lines.filter((l) => words(l.text).includes(words(quote).slice(0, 24)) || words(quote).includes(words(l.text).slice(0, 24)));
        if (about.length === 0) return { ignored: 'that was said earlier and has already been handled' };
        if (about.every((l) => l.codeFlag) && /price|health/.test(problem)) return { ignored: 'she has already been warned about this' };
        alertHost(st, { kind: 'monitor', by: 'Host Monitor', sku: args.sku ? String(args.sku) : undefined, text: `You said: “${quote}”. That is a ${problem}. Say: “${fix}”` });
        log(st, [{ agent: 'Host Monitor', summary: `${problem}: “${quote}” → ${fix}`, ok: false }], { user: 'Seller (mic)', text: said });
        for (const l of about) {
          const line = st.transcript.find((t) => t.id === l.id);
          if (line && !line.flag) line.flag = 'claim';
        }
        return { shown: true };
      }),
    },
    {
      name: 'remember_fact',
      description: 'Save a product fact the seller just stated, so buyers asking about it get an answer without her.',
      parameters: {
        type: 'object',
        required: ['sku', 'topic', 'fact'],
        properties: { sku: str, topic: { type: 'string', enum: FACT_TOPICS }, fact: { type: 'string', description: 'The fact in her own words, one sentence.' } },
      },
      run: (args) => update((st) => {
        const p = st.products.find((x) => x.sku === args.sku);
        const topic = args.topic as Topic;
        const fact = String(args.fact ?? '').trim().slice(0, 200);
        if (!p || !FACT_TOPICS.includes(topic) || !fact) return { error: 'unknown product, topic or empty fact' };
        if (p.facts[topic]) return { already_confirmed: p.facts[topic], note: 'If what she said contradicts this, warn her instead.' };
        confirmFact(st, p, topic, fact);
        // Buyers who were waiting on exactly this get their answer now.
        const waiting = st.escalations.filter((e) => e.status === 'open' && e.sku === p.sku && e.topic === topic);
        for (const e of waiting) {
          e.status = 'answered';
          e.answer = fact;
          const c = st.comments.find((k) => k.id === e.commentId);
          if (c) c.handled = true;
          st.comments.push({ id: nextId('c'), role: 'ai', user: 'StreamSense', by: 'Support', text: `@${e.user} ${fact}`, ts: now(), handled: true, replyTo: e.commentId });
        }
        log(st, [{ agent: 'Host Monitor', summary: `learned “${topic}” for ${p.name} from what she said${waiting.length ? ` — answered ${waiting.length} waiting buyer(s)` : ''}`, ok: true }], { user: 'Seller (mic)', text: said });
        return { remembered: true, buyers_answered: waiting.length };
      }),
    },
  ];

  try {
    await runAgent({ name: 'Host Monitor', system: SYSTEM, tools, maxSteps: 2 }, {
      she_just_said: lines.map((l) => ({ text: l.text, already_warned_about: l.codeFlag ?? null })),
      context_only_said_earlier_do_not_warn_about_these: s.transcript.slice(-(lines.length + 3), -lines.length).map((t) => t.text),
      on_camera_sku: s.spotlightSku,
      active_vouchers: s.vouchers.filter((v) => v.active).map((v) => ({ amount_off: `RM${v.amountOff.toFixed(2)}`, min_spend: `RM${v.minSpend.toFixed(2)}` })),
      products: s.products.map((p) => ({
        sku: p.sku, name: p.name, also_called: p.aliases.slice(0, 3), price_now: `RM${unitPrice(s, p).toFixed(2)}`, list_price: `RM${p.price.toFixed(2)}`, stock: p.stock, confirmed_facts: p.facts,
      })),
    });
  } catch (err) {
    console.warn('[agents] Host Monitor skipped:', (err as Error).message);
  } finally {
    pending.busy = false;
    if (pending.lines.length) pending.timer ??= setTimeout(review, 300);
  }
}
