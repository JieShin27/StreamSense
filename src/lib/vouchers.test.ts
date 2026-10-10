import { beforeEach, describe, expect, it } from 'vitest';
import { addToCart, checkout } from './buyer';
import { answerEscalation, applyDecision, resetLive } from './pipeline';
import { exportSession } from './session';
import { getState, nextId, now } from './store';
import { rulesTriage } from './triage';
import type { Comment } from './types';
import { claimVoucher, createVoucher, maxSafeVoucher } from './vouchers';

beforeEach(() => {
  getState().workspace = { uploads: [] };
  resetLive();
});

function comment(user: string, text: string): Comment {
  const s = getState();
  const c: Comment = { id: nextId('c'), role: 'buyer', user, text, ts: now(), handled: false };
  s.comments.push(c);
  applyDecision(s, c, rulesTriage(c, s.products, s.spotlightSku));
  return c;
}
const lastReply = () => getState().comments.filter((c) => c.role !== 'buyer').at(-1)?.text ?? '';

describe('vouchers and the Price Guard', () => {
  it('works out the largest voucher no qualifying cart can lose money on', () => {
    // To reach RM30, two sambal (RM15.00, floor RM11.50) leave the least room: 2 × RM3.50.
    expect(maxSafeVoucher(getState(), 30)).toBe(7);
    // With no minimum, one kerepek (RM9.00, floor RM6.80) is the tightest cart.
    expect(maxSafeVoucher(getState(), 0)).toBe(2.2);
  });

  it('blocks a voucher that could push a cart below its floors, and suggests a safe one', () => {
    const res = createVoucher(12, 30, 20);
    expect(res).toMatchObject({ ok: false, blocked: true, safeAmount: 7 });
    expect(getState().vouchers).toHaveLength(0);
  });

  it('applies a claimed voucher at checkout, once per buyer, within its limit', () => {
    const made = createVoucher(5, 30, 1);
    expect(made.ok).toBe(true);
    const id = getState().vouchers[0].id;

    addToCart('aina', 'SAMBAL-200', 2);
    claimVoucher('aina', id);
    expect(checkout('aina')).toMatchObject({ ok: true, total: 25, discount: 5 });

    // The single use is gone, so the next buyer pays in full.
    addToCart('wei', 'SAMBAL-200', 2);
    expect(claimVoucher('wei', id).ok).toBe(false);
    expect(checkout('wei')).toMatchObject({ total: 30, discount: 0 });
  });

  it('does not apply below the minimum spend, or without a claim', () => {
    createVoucher(5, 30, 10);
    const id = getState().vouchers[0].id;
    addToCart('aina', 'SAMBAL-200', 1);
    claimVoucher('aina', id);
    expect(checkout('aina')).toMatchObject({ total: 15, discount: 0 });
    addToCart('wei', 'SAMBAL-200', 2);
    expect(checkout('wei')).toMatchObject({ total: 30, discount: 0 });
  });

  it('takes voucher cost off profit in the sales summary', () => {
    createVoucher(5, 30, 10);
    addToCart('aina', 'SAMBAL-200', 2);
    claimVoucher('aina', getState().vouchers[0].id);
    checkout('aina');
    const totals = exportSession(getState()).sales_summary.totals;
    expect(totals).toMatchObject({ revenue: 30, voucher_discounts: 5 });
  });

  it('tells a buyer who asks whether there is a voucher', () => {
    comment('sam', 'ada voucher tak?');
    expect(lastReply()).toContain('belum ada voucher');
    createVoucher(5, 30, 10);
    comment('sam', 'got voucher?');
    expect(lastReply()).toContain('RM5.00 off');
  });
});

describe('what she confirms is remembered for the next live', () => {
  it('answers a question in the next live that she answered in this one', () => {
    comment('fizah', 'sambal ni halal ke?');
    expect(getState().escalations).toHaveLength(1);
    answerEscalation(getState().escalations[0].id, 'Ya, semua bahan halal.');

    resetLive(); // a new live

    comment('nurul', 'sambal halal tak?');
    expect(getState().escalations).toHaveLength(0);
    expect(lastReply()).toContain('semua bahan halal');
  });
});
