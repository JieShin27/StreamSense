import { floorsFromUploads } from './floors';
import type { LiveState } from './types';

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Tonight's money, worked out in code from paid orders and her cost sheet.
 * The post-live team reports these figures; it does not redo the arithmetic.
 */
export function salesSummary(s: LiveState) {
  const costs = new Map((floorsFromUploads(s.workspace.uploads) ?? []).map((r) => [r.sku, r]));
  const products = s.products.map((p) => {
    const paid = s.reservations.filter((r) => r.sku === p.sku && r.status === 'paid');
    const unpaid = s.reservations.filter((r) => r.sku === p.sku && r.status === 'reserved');
    const units = paid.reduce((n, r) => n + r.qty, 0);
    const revenue = paid.reduce((n, r) => n + r.qty * r.unitPrice, 0);
    const c = costs.get(p.sku);
    const fees = c ? revenue * (c.feePct / 100) : null;
    const cost = c ? units * c.cost : null;
    return {
      sku: p.sku,
      name: p.name,
      units_paid: units,
      revenue: round(revenue),
      platform_fees: fees === null ? null : round(fees),
      cost_of_goods: cost === null ? null : round(cost),
      profit: fees === null || cost === null ? null : round(revenue - fees - cost),
      units_left_unpaid: unpaid.reduce((n, r) => n + r.qty, 0),
      stock_left: p.stock,
      stock_at_start: p.stockStart,
    };
  });
  const total = (key: 'revenue' | 'platform_fees' | 'cost_of_goods' | 'profit') =>
    products.some((p) => p[key] === null) ? null : round(products.reduce((n, p) => n + (p[key] ?? 0), 0));
  const vouchers = round(s.payments.reduce((n, p) => n + p.discount, 0));
  return {
    note: costs.size ? 'Calculated by StreamSense from paid orders and the cost sheet.' : 'No cost sheet uploaded: revenue only, profit unknown.',
    products,
    totals: {
      revenue: total('revenue'),
      platform_fees: total('platform_fees'),
      cost_of_goods: total('cost_of_goods'),
      voucher_discounts: vouchers,
      // Profit after everything, including the vouchers buyers used.
      profit: total('profit') === null ? null : round((total('profit') ?? 0) - vouchers),
    },
    vouchers: s.vouchers.map((v) => ({ amount_off: v.amountOff, min_spend: v.minSpend, limit: v.limit, claimed: v.claimedBy.length, used: v.usedBy.length })),
    buyers_with_unpaid_items: [...new Set(s.reservations.filter((r) => r.status === 'reserved').map((r) => r.buyer))],
  };
}

/** session.json — the hand-off the post-live team reads. Field names are a contract; see BUILD.md. */
export function exportSession(s: LiveState) {
  return {
    session: { id: s.session.id, status: s.session.status, started_at: s.session.startedAt, ended_at: s.session.endedAt ?? new Date().toISOString() },
    products: s.products.map((p) => ({
      sku: p.sku,
      name: p.name,
      price: p.price,
      floor: p.floor,
      stock_start: p.stockStart,
      stock_end: p.stock,
    })),
    reservations: s.reservations.map((r) => ({
      buyer: r.buyer,
      sku: r.sku,
      qty: r.qty,
      unit_price: r.unitPrice,
      status: r.status,
      ts: r.ts,
    })),
    // Buyers who checked out. Anything in `reservations` still "reserved" was never paid.
    orders: s.reservations
      .filter((r) => r.status === 'paid')
      .map((r) => ({ buyer: r.buyer, sku: r.sku, qty: r.qty, paid_amount: r.qty * r.unitPrice, order_time: r.paidAt ?? r.ts })),
    comments: s.comments
      .filter((c) => c.role === 'buyer')
      .map((c) => ({ user: c.user, text: c.text, lang: c.lang ?? null, label: c.label ?? null, handled: c.handled })),
    unanswered: s.escalations
      .filter((e) => e.status === 'open')
      .map((e) => ({ user: e.user, text: e.text, sku: e.sku ?? null, topic: e.topic })),
    blocked_discounts: s.blockedDiscounts.map((b) => ({ sku: b.sku, attempted: b.attempted, floor: b.floor, ts: b.ts })),
    sales_summary: salesSummary(s),
    learned_answers: s.escalations
      .filter((e) => e.status === 'answered' && e.answer)
      .map((e) => ({ sku: e.sku ?? null, topic: e.topic, question: e.text, answer: e.answer })),
  };
}
