'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ViewerVideo } from '@/components/liveVideo';
import { buyerAct, postComment, useLiveState } from '@/components/useLiveState';
import type { LiveState } from '@/lib/types';

const rm = (n: number) => `RM${n.toFixed(2)}`;
const TRY = ['nak 2 jar sambal', 'sambal 多少钱?', 'is it spicy?', 'sambal RM5 boleh?'];
type Tab = 'live' | 'cart' | 'chat';

export default function BuyerRoom() {
  const { state } = useLiveState();
  const [name, setName] = useState('');
  const [tab, setTab] = useState<Tab>('live');
  const [seenChat, setSeenChat] = useState(0);

  useEffect(() => {
    let saved = '';
    try {
      saved = localStorage.getItem('streamsense.name') ?? '';
    } catch {}
    setName(saved || `guest${Math.floor(100 + Math.random() * 900)}`);
  }, []);

  function rename(next: string) {
    setName(next);
    try {
      localStorage.setItem('streamsense.name', next);
    } catch {}
  }

  const cart = useMemo(() => state?.reservations.filter((r) => r.buyer === name && r.status === 'reserved') ?? [], [state, name]);
  const fromShop = useMemo(() => state?.messages.filter((m) => m.buyer === name && m.from === 'shop').length ?? 0, [state, name]);
  useEffect(() => {
    if (tab === 'chat') setSeenChat(fromShop);
  }, [tab, fromShop]);

  if (!state) return <main className="loading">Joining the live…</main>;
  const unread = Math.max(0, fromShop - seenChat);
  const status = state.session.status;

  return (
    <main className="buyer">
      <header>
        {status === 'live' ? <span className="live-badge">LIVE</span> : <span className="pill">{status === 'ended' ? 'Ended' : 'Soon'}</span>}
        <b>Kak Ina Homemade</b>
        <label className="name">
          <span>You</span>
          <input value={name} onChange={(e) => rename(e.target.value)} maxLength={24} />
        </label>
      </header>

      <div className="buyer-body">
        {tab === 'live' && <LiveTab state={state} name={name} />}
        {tab === 'cart' && <CartTab state={state} name={name} />}
        {tab === 'chat' && <ChatTab state={state} name={name} />}
      </div>

      <nav className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'live'} onClick={() => setTab('live')}>Live</button>
        <button role="tab" aria-selected={tab === 'cart'} onClick={() => setTab('cart')}>
          Cart{cart.length > 0 && <span className="badge">{cart.reduce((n, r) => n + r.qty, 0)}</span>}
        </button>
        <button role="tab" aria-selected={tab === 'chat'} onClick={() => setTab('chat')}>
          Chat{unread > 0 && <span className="badge">{unread}</span>}
        </button>
      </nav>
    </main>
  );
}

function LiveTab({ state, name }: { state: LiveState; name: string }) {
  const [text, setText] = useState('');
  const feed = useRef<HTMLDivElement>(null);
  const last = state.comments[state.comments.length - 1]?.id;
  useEffect(() => {
    feed.current?.scrollTo({ top: feed.current.scrollHeight });
  }, [last]);

  const status = state.session.status;
  const live = status === 'live';

  async function send(value: string) {
    const body = value.trim();
    if (!body || !live) return;
    setText('');
    await postComment(name, body);
  }

  const spotlight = state.products.find((p) => p.sku === state.spotlightSku);
  const caption = !live
    ? status === 'ended' ? 'The live has ended' : 'The live starts soon'
    : spotlight ? `Now showing: ${spotlight.name}` : 'Live';

  return (
    <>
      <ViewerVideo name={name} caption={caption} />

      {state.vouchers.filter((v) => v.active && v.usedBy.length < v.limit).map((v) => {
        const claimed = v.claimedBy.includes(name);
        return (
          <div key={v.id} className="voucher">
            <span>
              🎟 <b>{rm(v.amountOff)} off</b> {v.minSpend ? `when you spend ${rm(v.minSpend)}` : 'any order'}
              <small> · {v.limit - v.usedBy.length} left</small>
            </span>
            <button className="small" disabled={claimed || v.usedBy.includes(name)} onClick={() => buyerAct({ type: 'claim', user: name, id: v.id })}>
              {v.usedBy.includes(name) ? 'Used' : claimed ? 'Claimed ✓' : 'Claim'}
            </button>
          </div>
        );
      })}

      <div className="strip">
        {state.products.map((p) => (
          <div key={p.sku} className={`strip-item ${p.stock === 0 ? 'out' : ''} ${p.sku === state.spotlightSku ? 'spot' : ''}`}>
            <b>{p.name}</b>
            <span className="price">{rm(state.deals[p.sku] ?? p.price)}</span>
            <span className="muted">{p.stock === 0 ? 'sold out' : `${p.stock} left`}</span>
            <button className="small" disabled={p.stock === 0} onClick={() => buyerAct({ type: 'add', user: name, sku: p.sku, qty: 1 })}>
              Add to cart
            </button>
          </div>
        ))}
      </div>

      <div className="feed" ref={feed}>
        {state.comments.length === 0 && <p className="empty">{live ? 'Be the first to comment.' : 'Comments open when the live starts.'}</p>}
        {state.comments.slice(-60).map((c) => (
          <div key={c.id} className={`line ${c.role === 'buyer' ? '' : c.role} ${c.user === name ? 'mine' : ''}`}>
            <b>{c.role === 'buyer' ? c.user : c.role === 'ai' ? 'Shop assistant' : 'Kak Ina'}</b> {c.text}
          </div>
        ))}
      </div>

      {live && (
        <div className="suggest">
          {TRY.map((t) => (
            <button key={t} className="small ghost" onClick={() => send(t)}>{t}</button>
          ))}
        </div>
      )}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={200}
          disabled={!live}
          placeholder={live ? 'Comment on the live…' : 'Comments are closed'}
          aria-label="Comment"
        />
        <button className="primary" type="submit" disabled={!live}>Send</button>
      </form>
    </>
  );
}

function CartTab({ state, name }: { state: LiveState; name: string }) {
  const [note, setNote] = useState('');
  const names = new Map(state.products.map((p) => [p.sku, p.name]));
  const myItems = state.reservations.filter((r) => r.buyer === name);
  const cart = myItems.filter((r) => r.status === 'reserved');
  const paid = myItems.filter((r) => r.status === 'paid');
  const total = cart.reduce((sum, r) => sum + r.qty * r.unitPrice, 0);
  // Shown as a preview; the shop checks it again at checkout.
  const mine = state.vouchers.filter((v) => v.active && v.claimedBy.includes(name) && !v.usedBy.includes(name) && v.usedBy.length < v.limit);
  const usable = mine.filter((v) => total >= v.minSpend).sort((a, b) => b.amountOff - a.amountOff).at(0);
  const almost = usable ? undefined : [...mine].sort((a, b) => a.minSpend - b.minSpend).at(0);

  async function pay() {
    const res = await buyerAct({ type: 'checkout', user: name });
    setNote(res.ok ? `Paid ${rm(res.total)}${res.discount ? ` (voucher saved you ${rm(res.discount)})` : ''}. Terima kasih!` : res.error);
  }

  return (
    <div className="pane">
      <h3>Your cart</h3>
      {cart.length === 0 && <p className="empty">Nothing here yet. Comment “nak 2 sambal” or tap Add to cart on a product.</p>}
      {cart.map((r) => (
        <div key={r.id} className="cart-line">
          <span>
            {r.qty} × {names.get(r.sku) ?? r.sku}
          </span>
          <span>{rm(r.qty * r.unitPrice)}</span>
          <button className="small ghost" onClick={() => buyerAct({ type: 'remove', user: name, id: r.id })}>Remove</button>
        </div>
      ))}
      {cart.length > 0 && (
        <>
          {usable && (
            <div className="cart-total small">
              <span>🎟 Voucher</span>
              <span className="paid">− {rm(usable.amountOff)}</span>
            </div>
          )}
          {almost && <p className="muted small-print">Add {rm(almost.minSpend - total)} more to use your {rm(almost.amountOff)} voucher.</p>}
          <div className="cart-total">
            <span>Total</span>
            <b>{rm(total - (usable?.amountOff ?? 0))}</b>
          </div>
          <button className="primary big" onClick={pay}>Checkout</button>
          <p className="muted small-print">Simulated payment — no money moves.</p>
        </>
      )}
      {note && <p className="verdict ok">{note}</p>}

      {paid.length > 0 && (
        <>
          <h3 className="spaced">Paid orders</h3>
          {paid.map((r) => (
            <div key={r.id} className="cart-line done">
              <span>
                {r.qty} × {names.get(r.sku) ?? r.sku}
              </span>
              <span>{rm(r.qty * r.unitPrice)}</span>
              <span className="paid">paid</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function ChatTab({ state, name }: { state: LiveState; name: string }) {
  const [text, setText] = useState('');
  const inbox = state.messages.filter((m) => m.buyer === name);
  return (
    <div className="pane">
      <h3>Chat with the shop</h3>
      <div className="inbox">
        {inbox.length === 0 && <p className="empty">Private messages from the shop appear here.</p>}
        {inbox.map((m) => (
          <div key={m.id} className={`bubble ${m.from}`}>{m.text}</div>
        ))}
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          const body = text.trim();
          if (!body) return;
          setText('');
          buyerAct({ type: 'message', user: name, text: body });
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={300} placeholder="Message the shop…" aria-label="Message" />
        <button className="primary" type="submit">Send</button>
      </form>
    </div>
  );
}
