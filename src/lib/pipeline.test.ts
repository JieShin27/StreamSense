import { beforeEach, describe, expect, it } from 'vitest';
import { answerEscalation, applyDecision, importFloors, proposeDeal, releaseReservation, resetLive } from './pipeline';
import { checkPrice, safeDealPrice } from './priceGuard';
import { exportSession } from './session';
import { getState, nextId, now } from './store';
import { rulesTriage } from './triage';
import type { Comment } from './types';

/** Push a buyer comment through triage rules and the backstage team, synchronously. */
function comment(user: string, text: string): Comment {
  const s = getState();
  const c: Comment = { id: nextId('c'), role: 'buyer', user, text, ts: now(), handled: false };
  s.comments.push(c);
  applyDecision(s, c, rulesTriage(c, s.products, s.spotlightSku));
  return c;
}

const sambal = () => getState().products.find((p) => p.sku === 'SAMBAL-200')!;
const lastReply = () => getState().comments.filter((c) => c.role !== 'buyer').at(-1)?.text ?? '';

beforeEach(() => {
  // Each test starts as a first-ever live: nothing uploaded, nothing remembered.
  getState().workspace = { uploads: [] };
  resetLive();
});

describe('Price Guard', () => {
  it('passes prices at or above the floor and blocks anything below', () => {
    expect(checkPrice(11.5, 11.5).ok).toBe(true);
    expect(checkPrice(11.49, 11.5).ok).toBe(false);
  });

  it('suggests a round price that stays above the floor', () => {
    expect(safeDealPrice(11.5)).toBe(12);
    expect(safeDealPrice(6.8)).toBe(8);
  });

  it('blocks a loss-making flash deal and records it', () => {
    const res = proposeDeal('SAMBAL-200', 8);
    expect(res).toMatchObject({ ok: false, blocked: true, floor: 11.5, safePrice: 12 });
    expect(getState().deals).toEqual({});
    expect(getState().blockedDiscounts).toHaveLength(1);
  });

  it('lets a safe flash deal through, and new reservations use it', () => {
    expect(proposeDeal('SAMBAL-200', 12).ok).toBe(true);
    comment('aina', 'nak 2 sambal');
    expect(getState().reservations[0]).toMatchObject({ qty: 2, unitPrice: 12 });
  });

  it('declines a buyer offer below the floor without bothering the host', () => {
    comment('zul', 'sambal RM8 boleh?');
    expect(getState().escalations).toHaveLength(0);
    expect(lastReply()).toContain('RM15.00');
  });

  it('hands a buyer offer above the floor to the host', () => {
    comment('zul', 'sambal RM13 boleh?');
    expect(getState().escalations[0]).toMatchObject({ topic: 'discount', status: 'open' });
  });
});

describe('Order & Stock', () => {
  it('reserves stock and tells the buyer where to check out', () => {
    comment('aina', 'nak 3 jar sambal!');
    expect(sambal().stock).toBe(117);
    expect(getState().reservations[0]).toMatchObject({ buyer: 'aina', qty: 3, unitPrice: 15, status: 'reserved' });
    expect(lastReply()).toContain('Checkout');
  });

  it('never reserves more than is left', () => {
    sambal().stock = 2;
    comment('farah', 'want 20 jar sambal');
    expect(sambal().stock).toBe(0);
    expect(getState().reservations[0].qty).toBe(2);
    comment('din', 'nak 3 sambal');
    expect(getState().reservations).toHaveLength(1);
    expect(lastReply()).toContain('habis');
  });

  it('puts stock back when a reservation is released', () => {
    comment('aina', 'nak 3 sambal');
    releaseReservation(getState().reservations[0].id);
    expect(sambal().stock).toBe(120);
    expect(getState().reservations[0].status).toBe('released');
  });
});

describe('Grounding gate and host memory', () => {
  it('answers from live numbers and seller-confirmed facts', () => {
    comment('wei', 'sambal 多少钱?');
    expect(lastReply()).toContain('RM15.00');
    comment('sarah', 'Is the sambal very spicy?');
    expect(lastReply()).toContain('medium spicy');
  });

  it('escalates instead of guessing, then learns the host answer', () => {
    comment('fizah', 'sambal ni halal ke?');
    comment('nurul', 'sambal halal tak?');
    expect(getState().escalations.filter((e) => e.status === 'open')).toHaveLength(2);

    answerEscalation(getState().escalations[0].id, 'Ya, semua bahan halal.');
    expect(getState().escalations.every((e) => e.status === 'answered')).toBe(true);

    comment('ika', 'sambal halal?');
    expect(getState().escalations).toHaveLength(2);
    expect(lastReply()).toContain('semua bahan halal');
  });

  it('warns the host about health claims and says nothing to the buyer', () => {
    const before = getState().comments.length;
    comment('ros', 'sambal ni boleh turunkan darah tinggi kan?');
    expect(getState().alerts.at(-1)?.kind).toBe('policy');
    expect(getState().comments.length).toBe(before + 1);
  });
});

describe('WorkBuddy hand-off', () => {
  it('starts a clean live from price_floors.json', () => {
    const res = importFloors({ products: [{ sku: 'SAMBAL-200', name: 'Sambal', price: 16, floor: 12, stock: 50 }] });
    expect(res).toMatchObject({ ok: true, count: 1 });
    expect(sambal()).toMatchObject({ price: 16, floor: 12, stock: 50, stockStart: 50 });
    expect(importFloors({ products: [{ sku: 'X' }] }).ok).toBe(false);
  });

  it('exports session.json in the agreed shape', () => {
    comment('aina', 'nak 3 sambal');
    comment('fizah', 'sambal ni halal ke?');
    proposeDeal('SAMBAL-200', 8);
    const out = exportSession(getState());
    expect(out.products[0]).toMatchObject({ sku: 'SAMBAL-200', stock_start: 120, stock_end: 117, floor: 11.5 });
    expect(out.reservations[0]).toMatchObject({ buyer: 'aina', qty: 3, unit_price: 15, status: 'reserved' });
    expect(out.unanswered[0]).toMatchObject({ user: 'fizah', topic: 'halal' });
    expect(out.blocked_discounts[0]).toMatchObject({ attempted: 8, floor: 11.5 });
    expect(out.comments).toHaveLength(2);
  });
});
