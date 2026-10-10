'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { SellerNav } from '@/components/SellerNav';
import { SellerStudio } from '@/components/SellerStudio';
import { act, useLiveState } from '@/components/useLiveState';
import type { Activity, AgentStep, Comment, CoachAlert, Escalation, LiveState, Product } from '@/lib/types';

const rm = (n: number) => `RM${n.toFixed(2)}`;
const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour12: false });

export default function LivePage() {
  const { state, online } = useLiveState();
  if (!state) return <main className="loading">Connecting to the live room…</main>;

  const sum = (status: 'reserved' | 'paid') =>
    state.reservations.filter((r) => r.status === status).reduce((n, r) => n + r.qty * r.unitPrice, 0);
  const waiting = state.escalations.filter((e) => e.status === 'open').length;

  return (
    <main className="console">
      <SellerNav state={state}>
        <div className="mini-stats">
          <span><b>{rm(sum('paid'))}</b> paid</span>
          <span><b>{rm(sum('reserved'))}</b> in carts</span>
          <span className={waiting ? 'hot' : ''}><b>{waiting}</b> need you</span>
        </div>
        <AgentChip state={state} online={online} />
        <Tools state={state} />
      </SellerNav>

      <div className="live-grid">
        <section className="col">
          <SellerStudio state={state} />
        </section>
        <section className="col">
          <Timeline state={state} />
        </section>
        <section className="col">
          <NeedsYou state={state} />
          <Stock state={state} />
          <Vouchers state={state} />
          <Carts state={state} />
        </section>
      </div>
    </main>
  );
}

function AgentChip({ state, online }: { state: LiveState; online: boolean }) {
  if (!online) return <span className="chip">reconnecting…</span>;
  if (state.triageMode === 'agents') return <span className="chip chip-on">Agents working</span>;
  if (state.agentsRestingUntil) return <span className="chip chip-warn">Agents resting · rules covering</span>;
  return <span className="chip">Agents ready</span>;
}

function Tools({ state }: { state: LiveState }) {
  const file = useRef<HTMLInputElement>(null);
  const [buyerUrl, setBuyerUrl] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => setBuyerUrl(`${window.location.origin}/buyer`), []);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    e.target.value = '';
    if (!picked) return;
    try {
      const res = await act({ type: 'floors', payload: JSON.parse(await picked.text()) });
      setNote(res.ok ? `Loaded ${res.count} products` : res.error);
    } catch {
      setNote('That file is not valid JSON');
    }
  }

  return (
    <details className="menu">
      <summary>Buyer link &amp; tools</summary>
      <div className="menu-body">
        <div className="join">
          {buyerUrl && <QRCodeSVG value={buyerUrl} size={96} marginSize={1} />}
          <div>
            <b>Buyer room</b>
            <p className="muted">Scan to join as a buyer.</p>
            <a href="/buyer" target="_blank" rel="noreferrer">{buyerUrl.replace(/^https?:\/\//, '')}</a>
          </div>
        </div>
        <hr />
        <p className="muted">Rehearsal</p>
        <button onClick={() => act({ type: 'replay', action: state.replay.running ? 'stop' : 'start' })}>
          {state.replay.running ? `Pause sample comments (${state.replay.index}/${state.replay.total})` : 'Play sample comments'}
        </button>
        <button onClick={() => file.current?.click()}>Import price_floors.json</button>
        <input ref={file} type="file" accept="application/json,.json" hidden onChange={onFile} />
        <a className="button" href="/api/session">Export session.json</a>
        <button
          className="ghost"
          onClick={() => {
            if (window.confirm('Clear this live and start again?')) act({ type: 'reset' });
          }}
        >
          Reset live
        </button>
        {note && <p className="muted">{note}</p>}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Middle: everything that happens, in order. Each buyer comment carries the
// trail of agents that handled it and the reply it got.
// ---------------------------------------------------------------------------

type Entry =
  | { kind: 'comment'; ts: string; c: Comment; steps: AgentStep[]; replies: Comment[] }
  | { kind: 'event'; ts: string; a: Activity }
  | { kind: 'host'; ts: string; c: Comment };

function Timeline({ state }: { state: LiveState }) {
  const feed = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  const entries = useMemo(() => {
    // One comment can be acted on more than once (two products in one order): join the steps.
    const trails = new Map<string, AgentStep[]>();
    for (const a of state.activities) if (a.commentId) trails.set(a.commentId, [...(trails.get(a.commentId) ?? []), ...a.steps]);
    const replies = new Map<string, Comment[]>();
    for (const c of state.comments) {
      if (c.role !== 'buyer' && c.replyTo) replies.set(c.replyTo, [...(replies.get(c.replyTo) ?? []), c]);
    }
    const out: Entry[] = [];
    for (const c of state.comments) {
      if (c.role === 'buyer') out.push({ kind: 'comment', ts: c.ts, c, steps: trails.get(c.id) ?? [], replies: replies.get(c.id) ?? [] });
      else if (!c.replyTo) out.push({ kind: 'host', ts: c.ts, c });
    }
    // Things that were not about one comment: deals checked, WorkBuddy acting, carts changing.
    for (const a of state.activities) {
      if (!a.commentId && !(a.steps.length === 1 && a.steps[0].agent === 'Coach')) out.push({ kind: 'event', ts: a.ts, a });
    }
    return out.sort((x, y) => x.ts.localeCompare(y.ts));
  }, [state.comments, state.activities]);

  const last = entries[entries.length - 1];
  const lastKey = last ? `${last.ts}:${last.kind === 'comment' ? `${last.steps.length}.${last.replies.length}.${last.c.routedTo ?? ''}` : 0}` : '';
  useEffect(() => {
    if (pinned) feed.current?.scrollTo({ top: feed.current.scrollHeight });
  }, [lastKey, pinned]);

  return (
    <div className="panel timeline">
      <h3>
        Live comments
        <span className="muted">· each one shows which agents handled it</span>
      </h3>
      <div
        className="feed"
        ref={feed}
        onScroll={(e) => {
          const el = e.currentTarget;
          setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
        }}
      >
        {entries.length === 0 && (
          <p className="empty">
            {state.session.status === 'live'
              ? 'No comments yet. Share the buyer link, or play sample comments from the tools menu.'
              : 'Comments appear here once you go live.'}
          </p>
        )}
        {entries.map((e) =>
          e.kind === 'comment' ? (
            <div key={e.c.id} className="entry">
              <p className="said-by">
                <b>{e.c.user}</b> {e.c.text}
                {e.c.label ? (
                  <span className={`tag ${e.c.label}`}>{e.c.label.replace('_', ' ')}</span>
                ) : (
                  <span className="tag pending">{e.c.routedTo ? `Triage → ${e.c.routedTo}…` : 'Triage reading…'}</span>
                )}
              </p>
              {e.steps.length > 0 && <Trail steps={e.steps} compact />}
              {e.replies.map((r) => (
                <p key={r.id} className={`reply ${r.role}`}>
                  <b>{r.role === 'ai' ? (r.by ?? 'Assistant') : 'You'}</b> {r.text}
                  {r.draft && <span className="tag pending">say this</span>}
                </p>
              ))}
            </div>
          ) : e.kind === 'host' ? (
            <p key={e.c.id} className="entry announce">{e.c.text}</p>
          ) : (
            <div key={e.a.id} className="entry event">
              {e.a.text && (
                <p className="said-by">
                  <b>{e.a.user}</b> {e.a.text}
                </p>
              )}
              <Trail steps={e.a.steps} />
            </div>
          ),
        )}
      </div>
      {!pinned && (
        <button className="small jump" onClick={() => setPinned(true)}>↓ Latest</button>
      )}
    </div>
  );
}

/** Compact: one chip per agent in order, then what finally happened. Full: every step. */
function AgentBadge({ name }: { name: AgentStep['agent'] }) {
  return <i className={`agent a-${name.replace(/[^a-z]/gi, '').toLowerCase()}`}>{name}</i>;
}

function Trail({ steps, compact }: { steps: AgentStep[]; compact?: boolean }) {
  if (compact) {
    const chain: { agent: AgentStep['agent']; ok?: boolean }[] = [];
    for (const s of steps) {
      const last = chain[chain.length - 1];
      if (last?.agent === s.agent) last.ok = s.ok === false ? false : (last.ok ?? s.ok);
      else chain.push({ agent: s.agent, ok: s.ok });
    }
    const outcome = [...steps].reverse().find((s) => s.ok !== undefined) ?? steps[steps.length - 1];
    return (
      <div className="trail one-line">
        {chain.map((c, i) => (
          <span key={i} className={`hop ${c.ok === false ? 'bad' : c.ok === true ? 'ok' : ''}`}>
            <i className={`agent a-${c.agent.replace(/[^a-z]/gi, '').toLowerCase()}`}>{c.agent}</i>
          </span>
        ))}
        <span className={`outcome ${outcome.ok === false ? 'bad' : ''}`}>{outcome.summary}</span>
      </div>
    );
  }
  return (
    <div className="trail">
      {steps.map((s, i) => (
        <span key={i} className={`step ${s.ok === false ? 'bad' : s.ok === true ? 'ok' : ''}`}>
          <i className={`agent a-${s.agent.replace(/[^a-z]/gi, '').toLowerCase()}`}>{s.agent}</i>
          {s.summary}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right: the few things that need her, then stock.
// ---------------------------------------------------------------------------

function NeedsYou({ state }: { state: LiveState }) {
  const open = state.escalations.filter((e) => e.status === 'open');
  const alerts = state.alerts.slice(-5).reverse();
  return (
    <div className="panel">
      <h3>Needs you {open.length > 0 && <span className="badge">{open.length}</span>} <span className="muted">· each item says which agent raised it</span></h3>
      {open.length === 0 && alerts.length === 0 && <p className="empty">Nothing right now. Your team is handling the comments.</p>}
      {open.slice(0, 3).map((e) => (
        <EscalationCard key={e.id} e={e} />
      ))}
      {open.length > 3 && <p className="muted">+{open.length - 3} more waiting</p>}
      {alerts.map((a) => (
        <AlertLine key={a.id} a={a} />
      ))}
    </div>
  );
}

function AlertLine({ a }: { a: CoachAlert }) {
  return (
    <div className={`alert ${a.kind}`}>
      {a.by && <AgentBadge name={a.by} />}
      <span className="muted">{clock(a.ts)}</span> {a.text}
    </div>
  );
}

function EscalationCard({ e }: { e: Escalation }) {
  const [answer, setAnswer] = useState('');
  return (
    <form
      className="escalation"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (answer.trim()) act({ type: 'answer', id: e.id, answer });
      }}
    >
      <p>
        {e.by && <AgentBadge name={e.by} />}
        <b>{e.user}</b> “{e.text}”
      </p>
      <p className="muted">
        {e.reason}
        {e.hint ? ` — ${e.hint}` : ''}
      </p>
      {e.suggestion && (
        <p className="suggestion">
          <i className="agent a-workbuddy">WorkBuddy</i> suggests: “{e.suggestion}”
          <button type="button" className="small" onClick={() => act({ type: 'answer', id: e.id, answer: e.suggestion })}>Send this</button>
          <button type="button" className="small ghost" onClick={() => setAnswer(e.suggestion ?? '')}>Edit</button>
        </p>
      )}
      <div className="row">
        <input value={answer} onChange={(ev) => setAnswer(ev.target.value)} placeholder="Answer once, it is remembered" aria-label={`Answer ${e.user}`} />
        <button className="small" type="submit">Send</button>
      </div>
    </form>
  );
}

function Stock({ state }: { state: LiveState }) {
  const [openSku, setOpenSku] = useState<string | null>(null);
  return (
    <div className="panel">
      <h3>Stock</h3>
      {state.products.map((p) => (
        <StockRow key={p.sku} p={p} state={state} open={openSku === p.sku} onToggle={() => setOpenSku(openSku === p.sku ? null : p.sku)} />
      ))}
    </div>
  );
}

function StockRow({ p, state, open, onToggle }: { p: Product; state: LiveState; open: boolean; onToggle: () => void }) {
  const [price, setPrice] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const deal = state.deals[p.sku];
  const pct = p.stockStart ? Math.round((p.stock / p.stockStart) * 100) : 0;
  const level = p.stock === 0 ? 'out' : pct <= 15 ? 'low' : 'ok';
  const onCamera = state.spotlightSku === p.sku;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = Number(price);
    if (!value) return;
    const res = await act({ type: 'deal', sku: p.sku, price: value });
    setMsg(
      res.ok
        ? { ok: true, text: `Deal live at ${rm(res.price)}` }
        : res.blocked
          ? { ok: false, text: `Blocked. Your floor is ${rm(res.floor)}. Safe deal: ${rm(res.safePrice)}` }
          : { ok: false, text: res.error ?? 'Could not set the deal' },
    );
    setPrice('');
  }

  return (
    <div className={`stock ${onCamera ? 'on-camera' : ''}`}>
      <button className="stock-row" onClick={onToggle} aria-expanded={open}>
        <span className="stock-name">
          <b>{p.name}</b>
          <small>
            {deal ? (
              <>
                <s>{rm(p.price)}</s> <em>{rm(deal)}</em>
              </>
            ) : (
              rm(p.price)
            )}
            {onCamera && ' · on camera'}
          </small>
        </span>
        <span className={`count ${level}`}>
          <b key={p.stock}>{p.stock}</b>
          <small>/ {p.stockStart}</small>
        </span>
      </button>
      <div className="bar">
        <i className={level} style={{ width: `${pct}%` }} />
      </div>
      {open && (
        <div className="stock-more">
          <p className="muted">Floor {rm(p.floor)} — the lowest price that still makes money.</p>
          <div className="row">
            <button className="small" disabled={onCamera} onClick={() => act({ type: 'spotlight', sku: p.sku })}>
              {onCamera ? 'On camera' : 'Put on camera'}
            </button>
            <form className="row grow" onSubmit={submit}>
              <input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Flash deal RM" aria-label={`Flash deal price for ${p.name}`} />
              <button className="small" type="submit">Check price</button>
            </form>
          </div>
          {msg && <p className={`verdict ${msg.ok ? 'ok' : 'bad'}`}>{msg.ok ? '✓' : '✕'} Price Guard: {msg.text}</p>}
        </div>
      )}
    </div>
  );
}

function Vouchers({ state }: { state: LiveState }) {
  const [amount, setAmount] = useState('');
  const [minSpend, setMinSpend] = useState('');
  const [limit, setLimit] = useState('20');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const open = state.vouchers.filter((v) => v.active);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const res = await act({ type: 'voucher', amountOff: Number(amount), minSpend: Number(minSpend) || 0, limit: Number(limit) || 1 });
    setMsg(
      res.ok
        ? { ok: true, text: `Voucher is live: ${rm(res.voucher.amountOff)} off, min spend ${rm(res.voucher.minSpend)}` }
        : res.blocked
          ? { ok: false, text: res.safeAmount >= 1 ? `Blocked. A cart could fall below your floors. Largest safe voucher at this minimum spend: ${rm(res.safeAmount)}` : 'Blocked. No voucher is safe at this minimum spend — raise the minimum spend.' }
          : { ok: false, text: res.error ?? 'Could not create the voucher' },
    );
    if (res.ok) setAmount('');
  }

  return (
    <details className="panel fold" open={open.length > 0}>
      <summary>
        <h3>Vouchers <span className="muted">· {open.length} live</span></h3>
      </summary>
      {open.map((v) => (
        <div key={v.id} className="cart-row">
          <span>
            <b>{rm(v.amountOff)} off</b> {v.minSpend ? `min ${rm(v.minSpend)}` : 'no minimum'}
          </span>
          <span className="muted">{v.usedBy.length}/{v.limit} used · {v.claimedBy.length} claimed</span>
          <button className="small ghost" onClick={() => act({ type: 'end_voucher', id: v.id })}>End</button>
        </div>
      ))}
      <form className="voucher-form" onSubmit={submit}>
        <label>RM off<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="5" /></label>
        <label>Min spend<input inputMode="decimal" value={minSpend} onChange={(e) => setMinSpend(e.target.value)} placeholder="30" /></label>
        <label>Buyers<input inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value)} /></label>
        <button className="small" type="submit" disabled={state.session.status !== 'live'}>Check &amp; offer</button>
      </form>
      {state.session.status !== 'live' && <p className="muted small-print">Vouchers can be offered once you are live.</p>}
      {msg && <p className={`verdict ${msg.ok ? 'ok' : 'bad'}`}>{msg.ok ? '✓' : '✕'} Price Guard: {msg.text}</p>}
    </details>
  );
}

function Carts({ state }: { state: LiveState }) {
  const names = useMemo(() => new Map(state.products.map((p) => [p.sku, p.name])), [state.products]);
  const items = state.reservations.filter((r) => r.status !== 'released').slice(-12).reverse();
  return (
    <details className="panel fold">
      <summary>
        <h3>Carts &amp; orders <span className="muted">· {items.length}</span></h3>
      </summary>
      {items.length === 0 && <p className="empty">Nothing in carts yet.</p>}
      {items.map((r) => (
        <div key={r.id} className="cart-row">
          <span>
            <b>{r.buyer}</b> {r.qty} × {names.get(r.sku) ?? r.sku}
          </span>
          <span className="muted">{rm(r.qty * r.unitPrice)}</span>
          {r.status === 'paid' ? (
            <span className="paid">paid</span>
          ) : (
            <button className="small ghost" onClick={() => act({ type: 'release', id: r.id })}>Release</button>
          )}
        </div>
      ))}
    </details>
  );
}
