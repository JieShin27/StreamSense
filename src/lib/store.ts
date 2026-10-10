import type { LiveState } from './types';
import { REPLAY_SCRIPT, seedProducts } from './seed';

type Listener = (state: LiveState) => void;

interface Runtime {
  state: LiveState;
  listeners: Set<Listener>;
  seq: number;
  notifyTimer?: ReturnType<typeof setTimeout>;
}

function freshState(): LiveState {
  const products = seedProducts();
  return {
    session: { id: `live-${Date.now().toString(36)}`, status: 'setup', startedAt: new Date().toISOString() },
    products,
    spotlightSku: products[0]?.sku ?? '',
    deals: {},
    comments: [],
    reservations: [],
    activities: [],
    alerts: [],
    escalations: [],
    blockedDiscounts: [],
    messages: [],
    vouchers: [],
    payments: [],
    transcript: [],
    workspace: { uploads: [] },
    coachFired: [],
    replay: { running: false, index: 0, total: REPLAY_SCRIPT.length },
    triageMode: 'rules',
  };
}

// One live room held in memory. Kept on globalThis so every route handler (and
// every dev hot-reload) sees the same room. Needs a single long-running server.
const g = globalThis as unknown as { __streamsense?: Runtime };
const rt: Runtime = (g.__streamsense ??= { state: freshState(), listeners: new Set(), seq: 0 });

for (const [key, value] of Object.entries(freshState())) {
  const room = rt.state as unknown as Record<string, unknown>;
  if (room[key] === undefined) room[key] = value;
}

export function getState(): LiveState {
  return rt.state;
}

export function nextId(prefix: string): string {
  return `${prefix}${++rt.seq}`;
}

export const now = () => new Date().toISOString();

/** Mutate the room, then tell every connected screen. */
export function update<T>(fn: (state: LiveState) => T): T {
  const out = fn(rt.state);
  // Coalesce bursts (a replay can change state many times per tick).
  rt.notifyTimer ??= setTimeout(() => {
    rt.notifyTimer = undefined;
    const snap = snapshot();
    for (const l of rt.listeners) l(snap);
  }, 40);
  return out;
}

export function subscribe(fn: Listener): () => void {
  rt.listeners.add(fn);
  return () => rt.listeners.delete(fn);
}

/** What the browser receives: the room, trimmed so a long live stays light. */
export function snapshot(): LiveState {
  const s = rt.state;
  return { ...s, comments: s.comments.slice(-150), activities: s.activities.slice(-80) };
}

export function reset(products = seedProducts()): void {
  update(() => {
    const workspace = rt.state.workspace;
    rt.state = freshState();
    // A new live starts clean, but her documents and the teams' work stay.
    rt.state.workspace = workspace;
    // What she confirmed in earlier lives is known from the first minute of this one.
    for (const p of products) Object.assign(p.facts, workspace.knownFacts?.[p.sku] ?? {});
    rt.state.products = products;
    rt.state.spotlightSku = products[0]?.sku ?? '';
  });
}
