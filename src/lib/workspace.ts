import { shopMessage } from './buyer';
import { alertHost, log } from './backstage';
import { floorNotes, floorsFromUploads } from './floors';
import { importFloors } from './pipeline';
import { getState, nextId, now, update } from './store';
import type { FaqItem } from './types';
import { teamHandedIn } from './workbuddy';

// The seller's desk outside the live: what she uploaded, what the pre-live team
// produced, and what the post-live team produced. WorkBuddy reads and writes
// this through MCP; the Prepare and Wrap-up pages show it.

const MAX_UPLOAD_CHARS = 200_000;
const str = (v: unknown, max = 60_000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function addUpload(name: string, text: string) {
  const clean = name.trim().slice(0, 80) || 'untitled.txt';
  if (!text.trim()) return { ok: false as const, error: 'The file is empty' };
  if (text.length > MAX_UPLOAD_CHARS) return { ok: false as const, error: 'File too large — keep it under 200 KB of text' };
  return update((s) => {
    s.workspace.uploads = s.workspace.uploads.filter((u) => u.name !== clean);
    s.workspace.uploads.push({ id: nextId('u'), name: clean, text, ts: now() });
    return { ok: true as const };
  });
}

export function removeUpload(id: string) {
  update((s) => {
    s.workspace.uploads = s.workspace.uploads.filter((u) => u.id !== id);
  });
}

/** Start a clean live with the products and floor prices worked out from her cost sheet. No model involved. */
export function loadFromCostSheet() {
  const computed = floorsFromUploads(getState().workspace.uploads);
  if (!computed) return { ok: false as const, error: 'No cost sheet found. It needs the columns sku, name, unit_cost, list_price and stock.' };
  const res = importFloors({ products: computed });
  if (!res.ok) return { ok: false as const, error: res.error };
  update((s) => {
    alertHost(s, { kind: 'workbuddy', by: 'Price Guard', text: `Loaded ${res.count} products with floor prices calculated from your cost sheet.` });
  });
  return { ok: true as const, count: res.count };
}

/** Pre-live team hands in its work: floors go live in the room, documents go on the Prepare page. */
export function savePrelivePack(args: Record<string, unknown>) {
  const script = str(args.script_markdown);
  const cueCard = str(args.cue_card_markdown);
  if (!script || !cueCard) return { ok: false as const, error: 'script_markdown and cue_card_markdown are both required' };
  // Money is arithmetic, not opinion: when her cost sheet can be read, the floors
  // are computed from it here and whatever numbers the team wrote are ignored.
  const computed = floorsFromUploads(getState().workspace.uploads);
  const floors = importFloors({ products: computed ?? args.products });
  if (!floors.ok) return { ok: false as const, error: `products: ${floors.error}` };
  return update((s) => {
    s.workspace.prep = {
      script,
      cueCard,
      complianceLog: str(args.compliance_log_markdown) || undefined,
      floorNotes: computed ? floorNotes(computed) : str(args.floor_notes_markdown) || undefined,
      ts: now(),
    };
    alertHost(s, { kind: 'workbuddy', by: 'WorkBuddy', text: `Your live is prepared: ${floors.count} products with floor prices, script and cue card are ready.` });
    log(s, [{ agent: 'WorkBuddy', summary: `save_prelive_pack — ${floors.count} floors loaded, script and cue card saved`, ok: true }]);
    teamHandedIn('prepare');
    return { ok: true as const, products_loaded: floors.count, floors_from: computed ? ('cost sheet' as const) : ('team' as const), view_at: '/prepare' };
  });
}

/** Post-live team hands in its work. Follow-ups wait for the seller to approve sending. */
export function saveWrapup(args: Record<string, unknown>) {
  const summary = str(args.summary, 2000);
  const salesSheet = str(args.sales_sheet_markdown);
  if (!summary || !salesSheet) return { ok: false as const, error: 'summary and sales_sheet_markdown are both required' };

  const followups = (Array.isArray(args.followups) ? args.followups : [])
    .map((f) => ({ buyer: str((f as Record<string, unknown>)?.buyer, 24).replace(/^@+/, ''), text: str((f as Record<string, unknown>)?.text, 500) }))
    .filter((f) => f.buyer && f.text)
    .map((f) => ({ id: nextId('f'), ...f, sent: false }));
  const nextFaq: FaqItem[] = (Array.isArray(args.next_live_faq) ? args.next_live_faq : [])
    .map((q) => q as Record<string, unknown>)
    .filter((q) => str(q?.question, 300))
    .map((q) => ({ question: str(q.question, 300), asked_count: Number(q.asked_count) || 1, suggested_answer: str(q.suggested_answer, 500) }));

  return update((s) => {
    s.workspace.wrapup = { summary, salesSheet, restockMessage: str(args.restock_message, 3000), followups, nextFaq, ts: now() };
    log(s, [{ agent: 'WorkBuddy', summary: `save_wrapup — sales sheet, ${followups.length} follow-ups, ${nextFaq.length} FAQ items`, ok: true }]);
    teamHandedIn('wrapup');
    return { ok: true as const, followups_waiting_for_approval: followups.length, view_at: '/wrapup' };
  });
}

/** The seller approves: every drafted follow-up goes to that buyer's private chat. */
export function sendFollowups() {
  return update((s) => {
    const waiting = s.workspace.wrapup?.followups.filter((f) => !f.sent) ?? [];
    for (const f of waiting) {
      shopMessage(f.buyer, f.text);
      f.sent = true;
    }
    if (waiting.length) log(s, [{ agent: 'WorkBuddy', summary: `host approved — ${waiting.length} follow-up message(s) sent to buyers' chat`, ok: true }]);
    return { ok: true as const, sent: waiting.length };
  });
}
