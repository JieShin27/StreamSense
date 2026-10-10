'use client';

import { Markdown } from '@/components/Markdown';
import { SellerNav } from '@/components/SellerNav';
import { TeamRunPanel } from '@/components/TeamRunPanel';
import { act, useLiveState } from '@/components/useLiveState';
import { salesSummary } from '@/lib/session';

const rm = (n: number) => `RM${n.toFixed(2)}`;
const PROMPT = `Live dah habis, settle everything.

Get tonight's live with get_session and my cost sheet with get_uploaded_documents. Work as four roles:
- Reconciliation: report the figures in the session's sales_summary (never recalculate): paid orders, revenue, fees, profit per product, stock left, and who still has items in their cart unpaid.
- Restock: a purchase message to my supplier in Bahasa Malaysia for anything low or sold out.
- Follow-up: one short chat message per buyer who left items unpaid or whose question was never answered, in the language they used.
- Planner: the top questions for next live's FAQ, with a suggested answer where I already gave one.

Finish by calling save_wrapup with the summary, the sales sheet, the restock message, the follow-ups and the FAQ.`;

export default function WrapupPage() {
  const { state } = useLiveState();
  if (!state) return <main className="loading">Loading…</main>;

  const { wrapup } = state.workspace;
  const paid = state.reservations.filter((r) => r.status === 'paid');
  const unpaid = state.reservations.filter((r) => r.status === 'reserved');
  const sum = (rows: typeof paid) => rows.reduce((n, r) => n + r.qty * r.unitPrice, 0);
  const waiting = wrapup?.followups.filter((f) => !f.sent).length ?? 0;
  const live = state.session.status === 'live';
  const { profit, voucher_discounts: voucherCost } = salesSummary(state).totals;

  return (
    <main className="console">
      <SellerNav state={state} />
      <div className="flow">
        <section className="panel">
          <h2>Tonight at a glance</h2>
          <div className="glance">
            <div><b>{rm(sum(paid))}</b><span>paid by {new Set(paid.map((r) => r.buyer)).size} buyer(s)</span></div>
            <div><b>{rm(sum(unpaid))}</b><span>left in carts by {new Set(unpaid.map((r) => r.buyer)).size} buyer(s)</span></div>
            <div><b>{profit === null ? '—' : rm(profit)}</b><span>{profit === null ? 'profit needs your cost sheet' : voucherCost ? `profit after fees, costs and ${rm(voucherCost)} of vouchers` : 'profit after fees and costs'}</span></div>
            <div><b>{state.escalations.filter((e) => e.status === 'open').length}</b><span>questions unanswered</span></div>
          </div>
        </section>

        <section className="panel">
          <h2><span className="num">1</span> Let your team settle the live</h2>
          <TeamRunPanel
            state={state}
            kind="wrapup"
            button="Settle everything"
            roles="Reconciliation builds your sales sheet, Restock drafts the supplier message, Follow-up writes to buyers who left items behind, and Planner prepares next live’s FAQ."
            manualPrompt={PROMPT}
            disabledReason={live ? 'End your live first.' : undefined}
          />
        </section>

        <section className="panel">
          <h2>
            <span className="num">2</span> Your wrap-up
            {wrapup && <small className="muted"> · {new Date(wrapup.ts).toLocaleTimeString()}</small>}
          </h2>
          {!wrapup ? (
            <p className="empty">Your sales sheet, supplier message, follow-ups and next FAQ appear here when the team is done.</p>
          ) : (
            <>
              <Markdown text={wrapup.summary} />
              <h3 className="sub">Sales sheet <span className="muted">· by Reconciliation</span></h3>
              <Markdown text={wrapup.salesSheet} />
              {wrapup.restockMessage && (
                <>
                  <h3 className="sub">Message to your supplier <span className="muted">· by Restock</span></h3>
                  <pre className="prompt">{wrapup.restockMessage}</pre>
                  <button onClick={() => navigator.clipboard?.writeText(wrapup.restockMessage)}>Copy message</button>
                </>
              )}
            </>
          )}
        </section>

        {wrapup && (
          <section className="panel">
            <h2>
              <span className="num">3</span> Follow up with buyers <small className="muted">by Follow-up</small> {waiting > 0 && <span className="badge">{waiting}</span>}
            </h2>
            {wrapup.followups.length === 0 && <p className="empty">Nobody to follow up with.</p>}
            {wrapup.followups.map((f) => (
              <div key={f.id} className="escalation">
                <p>
                  <b>{f.buyer}</b> <span className={f.sent ? 'paid' : 'muted'}>{f.sent ? 'sent' : 'draft'}</span>
                </p>
                <p>{f.text}</p>
              </div>
            ))}
            {waiting > 0 && (
              <button className="primary big" onClick={() => act({ type: 'send_followups' })}>
                Send {waiting} message{waiting > 1 ? 's' : ''} to buyers’ chat
              </button>
            )}
            <p className="muted small-print">Nothing is sent until you press the button.</p>
          </section>
        )}

        {wrapup && (
          <section className="panel">
            <h2><span className="num">4</span> For your next live <small className="muted">by Planner</small></h2>
            {wrapup.nextFaq.length === 0 && <p className="empty">No open questions.</p>}
            {wrapup.nextFaq.map((q, i) => (
              <div key={i} className="escalation">
                <p>
                  <b>{q.question}</b> <span className="muted">· asked {q.asked_count}×</span>
                </p>
                <p className={q.suggested_answer ? '' : 'muted'}>{q.suggested_answer || 'Not answered yet — your team will ask you before the next live.'}</p>
              </div>
            ))}
            <p className="muted small-print">These go to your team the next time you prepare a live.</p>
          </section>
        )}
      </div>
    </main>
  );
}
