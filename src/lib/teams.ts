import { agentsRestingUntil, llmConfigured, RateLimited, writeText } from './agents/runtime';
import { floorsFromUploads } from './floors';
import { exportSession } from './session';
import { getState, now, update } from './store';
import type { TeamRun } from './types';
import { beginRun, finish, startTeam as startInWorkBuddy, step, workbuddyAvailable } from './workbuddy';
import { savePrelivePack, saveWrapup } from './workspace';

// The before/after teams, started from a button. On the seller's laptop the
// roles run in WorkBuddy (workbuddy.ts). Where that is not installed — a hosted
// copy — the same roles run here, each one a call to the model the live agents
// use, in the same order: Finance ∥ Sales → Compliance ⇄ Sales, and
// Reconciliation → Restock ∥ Follow-up ∥ Planner. Money still comes from code;
// the roles read the figures and write around them.

const SHARED = 'You work for a solo Malaysian live seller. Be concrete and brief. Never invent a cost, a price or a product fact that is not in what you are given. Answer with the document only: no preamble, no closing remarks.';

const ROLE = {
  finance: `${SHARED} You are Finance. The floor prices are already calculated by the system; never recalculate or change them, and do not repeat them as a table. Write one plain sentence per product on what its floor means for her and how much room she has to discount, and flag any product with less than RM3 of room. Markdown bullet list.`,
  script: `${SHARED} You are Sales. Write a 30-minute run-of-show in Bahasa Malaysia with English and 中文 lines for the key moments: product order, an opening hook, one talking point per product, when to announce low stock, and one flash deal per product that is at or above its floor. The floor prices are private: she never says a floor on camera, so no line may name one. If there is an FAQ from her previous live, answer those questions inside the script. No medical or health claims, no guarantees, no halal claim that her documents do not back. Markdown.`,
  cueCard: `${SHARED} You are Sales. Write a one-page cue card she can print: a Markdown table with, per product, the list price and the lowest price she may say (the floor), copied exactly from the floor prices, then at most three short reminders.`,
  compliance: `${SHARED} You are Compliance. Read the script and the product notes. Reject any medical or health claim, any guarantee, and any halal claim not backed by her documents. Check that no price in the script is below its floor, and that no line tells buyers what a floor price is. The first line of your answer is exactly one word: PASS if nothing must change, REVISE otherwise. Then, for each rejected line: quote it, say why, and give a safe replacement.`,
  rewrite: `${SHARED} You are Sales. Compliance rejected lines in your script. Return the complete script again with every rejected line replaced by a safe one, and nothing else changed. Markdown.`,
  reconciliation: `${SHARED} You are Reconciliation. "sales_summary" already holds the correct money figures; copy them, never recalculate. Produce one Markdown table with a row per product and a totals row: units paid, revenue, platform fees, cost of goods, profit, stock left, units left unpaid. Amounts in RM. Then list each buyer with unpaid items, and add two plain sentences on what the numbers mean for her.`,
  restock: `${SHARED} You are Restock. Write one short purchase message to her supplier in Bahasa Malaysia for the products listed, with quantities based on tonight's demand. Plain text, no Markdown.`,
  followup: `${SHARED} You are Follow-up. Write one short, friendly chat message per buyer who left items unpaid, and one per buyer whose question is in "unanswered" (answer it if "learned_answers" covers it). Use the language that buyer wrote in and the buyer name exactly as it appears. Never include a phone number or a link. Answer with a JSON array only: [{"buyer": "...", "text": "..."}].`,
  planner: `${SHARED} You are Planner. Group the questions in "unanswered", "learned_answers" and "comments" by topic and count them. Produce the FAQ for her next live. Give a suggested answer only where "learned_answers" has one; otherwise leave it empty. Answer with a JSON array only: [{"question": "...", "asked_count": 1, "suggested_answer": "..."}].`,
  summary: `${SHARED} You are the team lead. In three short Markdown bullet points tell her: what she earned after fees (the profit in the totals, copied exactly, in RM), what to reorder, and who gets a message.`,
};

class Stopped extends Error {}
interface Run { stopped: boolean }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (run: Run) => {
  if (run.stopped) throw new Stopped();
};

/**
 * One role's answer. A free model tier runs dry mid-team; the role waits for it
 * instead of giving up. A model that answers with nothing is asked again, then
 * the next model in the list is.
 */
async function ask(run: Run, system: string, input: string): Promise<string> {
  let empty = 0;
  for (let waits = 0; ; ) {
    alive(run);
    try {
      const text = await writeText(system, input, empty);
      alive(run);
      if (text) return text;
      if (++empty >= 4) throw new Error('The model returned an empty answer four times. Try again in a minute.');
    } catch (err) {
      if (!(err instanceof RateLimited) || ++waits > 8) throw err;
      const wait = Math.min(Math.max((agentsRestingUntil() ?? 0) - Date.now(), 3000), 120_000);
      step('Team lead', `The model has reached its limit; continuing in ${Math.ceil(wait / 1000)} seconds.`);
      await sleep(wait);
    }
  }
}

/** A role at work: shown in the log, and as a bar on the team timeline. */
async function role<T>(run: Run, name: string, task: string, work: () => Promise<T>): Promise<T> {
  alive(run);
  const span: TeamRun['spans'][number] = { role: name, start: now() };
  update((s) => void s.workspace.run?.spans.push(span));
  step('Team lead', `→ asks ${name === 'Followup' ? 'Follow-up' : name}: ${task}`);
  try {
    return await work();
  } finally {
    update(() => void (span.end ??= now()));
  }
}

const block = (title: string, value: unknown) => `${title}:\n${typeof value === 'string' ? value : JSON.stringify(value)}`;

function list(text: string): Record<string, unknown>[] {
  try {
    const found = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? '[]');
    return Array.isArray(found) ? found : [];
  } catch {
    return [];
  }
}

async function prepare(run: Run): Promise<void> {
  const { uploads, wrapup } = getState().workspace;
  step('Team lead', 'reading her documents');
  const rows = floorsFromUploads(uploads);
  if (!rows) throw new Error('No cost sheet found. It needs the columns sku, name, unit_cost, list_price and stock.');
  step('Team lead', 'getting the floor prices calculated from her cost sheet');

  const floors = block('Floor prices (calculated by the system, authoritative)', rows.map((r) => ({
    sku: r.sku, name: r.name, list_price: r.price, floor: r.floor, stock: r.stock, room_to_discount: Math.round((r.price - r.floor) * 100) / 100,
  })));
  const documents = block('Her documents', uploads.map((u) => `## ${u.name}\n${u.text.slice(0, 6000)}`).join('\n\n'));
  const faq = wrapup?.nextFaq.length ? block('FAQ from her previous live', wrapup.nextFaq) : '';
  const brief = [floors, documents, faq].filter(Boolean).join('\n\n');

  const [financeNotes, drafts] = await Promise.all([
    role(run, 'Finance', 'what each floor price means and where the room to discount is thin', () => ask(run, ROLE.finance, brief)),
    role(run, 'Sales', 'the run-of-show and the one-page cue card', () => Promise.all([ask(run, ROLE.script, brief), ask(run, ROLE.cueCard, floors)])),
  ]);
  let [script, cueCard] = drafts;
  step('Finance', 'Floor notes are ready.');
  step('Sales', 'Script and cue card are drafted.');

  // The one page she reads prices from on camera must carry the real floors.
  const rm = (n: number) => `RM${n.toFixed(2)}`;
  if (!rows.every((r) => cueCard.includes(r.floor.toFixed(2)))) {
    cueCard += ['', '', '**Prices checked against your cost sheet**', '', '| Product | List price | Lowest price you may say |', '|---|---|---|', ...rows.map((r) => `| ${r.name} | ${rm(r.price)} | ${rm(r.floor)} |`)].join('\n');
  }

  const reviews: string[] = [];
  for (let round = 1; ; round++) {
    const review = await role(run, 'Compliance', round === 1 ? 'check every line of the script' : 'check the rewritten script', () =>
      ask(run, ROLE.compliance, [floors, documents, block('Script', script)].join('\n\n')));
    reviews.push(`### Review ${round}\n\n${review}`);
    if (/^\W*PASS\b/i.test(review)) {
      step('Compliance', 'The script passes.');
      break;
    }
    if (round === 3) {
      step('Compliance', 'Some lines are still not cleared. Read the review before you go live.');
      reviews.push('**Not every line was cleared after three reviews. Read the last review before you go live.**');
      break;
    }
    step('Compliance', 'Rejected some lines; sending them back to Sales.');
    script = await role(run, 'Sales', 'rewrite the lines Compliance rejected', () =>
      ask(run, ROLE.rewrite, [floors, block('Compliance review', review), block('Script', script)].join('\n\n')));
  }

  alive(run);
  const saved = savePrelivePack({
    products: rows,
    script_markdown: script,
    cue_card_markdown: cueCard,
    compliance_log_markdown: reviews.join('\n\n'),
    finance_notes_markdown: financeNotes,
  }, 'Your team');
  if (!saved.ok) throw new Error(saved.error);
}

async function wrapup(run: Run): Promise<void> {
  step('Team lead', "reading tonight's live");
  const session = exportSession(getState());
  const names = new Map(session.products.map((p) => [p.sku, p.name]));
  const unpaid = session.reservations.filter((r) => r.status === 'reserved').map((r) => ({ buyer: r.buyer, product: names.get(r.sku) ?? r.sku, qty: r.qty }));
  const comments = session.comments.slice(-120).map((c) => ({ user: c.user, text: c.text.slice(0, 160), label: c.label }));

  const salesSheet = await role(run, 'Reconciliation', 'the sales sheet with profit after fees', () =>
    ask(run, ROLE.reconciliation, [block('sales_summary', session.sales_summary), block('unpaid items', unpaid)].join('\n\n')));
  step('Reconciliation', 'The sales sheet is ready.');

  const low = session.sales_summary.products.filter((p) => p.stock_left <= p.stock_at_start * 0.2);
  const needsMessage = new Set([...unpaid.map((u) => u.buyer), ...session.unanswered.map((u) => u.user)]);

  const [restockMessage, followups, faq] = await Promise.all([
    role(run, 'Restock', 'a purchase message for anything sold out or running low', async () =>
      low.length ? ask(run, ROLE.restock, block('Products sold out or below 20% of starting stock', low)) : 'Nothing needs restocking after this live.'),
    role(run, 'Followup', 'messages to buyers who left items unpaid or a question unanswered', async () =>
      needsMessage.size
        ? list(await ask(run, ROLE.followup, [
            block('unpaid items', unpaid),
            block('unanswered', session.unanswered),
            block('learned_answers', session.learned_answers),
            block('what these buyers wrote', comments.filter((c) => needsMessage.has(c.user))),
          ].join('\n\n')))
        : []),
    role(run, 'Planner', "next live's FAQ from tonight's questions", async () =>
      list(await ask(run, ROLE.planner, [
        block('unanswered', session.unanswered),
        block('learned_answers', session.learned_answers),
        block('comments', comments.filter((c) => c.label !== 'order')),
      ].join('\n\n')))),
  ]);
  step('Restock', low.length ? 'The supplier message is drafted.' : 'Nothing needs restocking.');
  step('Follow-up', followups.length ? `${followups.length} message(s) drafted for her to approve.` : 'Nobody needs a message.');
  step('Planner', `${faq.length} question(s) for the next FAQ.`);

  const summary = await ask(run, ROLE.summary, [
    block('totals', session.sales_summary.totals),
    block('supplier message', restockMessage),
    block('buyers getting a message', followups.map((f) => f.buyer)),
    block('prices she tried to give below her floor', session.blocked_discounts),
  ].join('\n\n'));

  alive(run);
  const saved = saveWrapup({ summary, sales_sheet_markdown: salesSheet, restock_message: restockMessage, followups, next_live_faq: faq }, 'Your team');
  if (!saved.ok) throw new Error(saved.error);
}

function startInApp(kind: TeamRun['kind']): { ok: boolean; error?: string } {
  if (!llmConfigured()) return { ok: false, error: 'No model is set up on the computer running StreamSense. Add LLM_API_KEY, or install WorkBuddy on it.' };
  const run: Run = { stopped: false };
  beginRun(kind, 'model', () => (run.stopped = true));
  (kind === 'prepare' ? prepare(run) : wrapup(run)).catch((err: Error) => {
    if (err instanceof Stopped) return;
    console.error('[team]', err);
    finish('failed', err instanceof RateLimited ? 'The model is still at its limit. Try again in a few minutes.' : err.message.slice(0, 400));
  });
  return { ok: true };
}

/** Put a team to work: in WorkBuddy when it is on this computer, otherwise here. TEAM_RUNNER=model always runs it here. */
export function startTeam(kind: TeamRun['kind'], origin: string): { ok: boolean; error?: string } {
  if (getState().workspace.run?.status === 'running') return { ok: false, error: 'A team is already working.' };
  if (kind === 'prepare' && getState().workspace.uploads.length === 0) return { ok: false, error: 'Upload your cost sheet first.' };
  return workbuddyAvailable() && process.env.TEAM_RUNNER !== 'model' ? startInWorkBuddy(kind, origin) : startInApp(kind);
}
