import { log, say, unitPrice } from './backstage';
import { rm } from './priceGuard';
import { nextId, now, update } from './store';
import type { LiveState, Reservation, Voucher } from './types';

// Vouchers take money off a whole cart, so the Price Guard has to reason about
// carts, not single prices: a voucher is only allowed if no cart that qualifies
// for it could end up below the combined floor of what is in it.

/**
 * The largest amount that is safe for a given minimum spend. The worst case is
 * the cheapest qualifying cart made entirely of the product with the least room
 * between its price and its floor.
 */
export function maxSafeVoucher(s: LiveState, minSpend: number): number {
  let safe = Infinity;
  for (const p of s.products) {
    if (p.stock <= 0) continue;
    const price = unitPrice(s, p);
    const units = Math.max(1, Math.ceil(minSpend / price));
    safe = Math.min(safe, units * (price - p.floor));
  }
  return Number.isFinite(safe) ? Math.max(0, Math.floor(safe * 100) / 100) : 0;
}

/** The seller offers a voucher. Below-floor vouchers never go live. */
export function createVoucher(amountOff: number, minSpend: number, limit: number) {
  return update((s) => {
    if (!(amountOff > 0) || !(minSpend >= 0) || !(limit >= 1)) return { ok: false as const, error: 'Enter an amount, a minimum spend and how many buyers can use it.' };
    if (minSpend > 0 && amountOff >= minSpend) return { ok: false as const, error: 'The voucher must be smaller than the minimum spend.' };
    const safe = maxSafeVoucher(s, minSpend);
    const label = `${rm(amountOff)} off, min spend ${rm(minSpend)}`;
    if (amountOff > safe) {
      const suggestion = Math.floor(safe);
      s.blockedDiscounts.push({ sku: 'VOUCHER', attempted: amountOff, floor: safe, ts: now() });
      log(s, [{
        agent: 'Price Guard',
        summary: `BLOCKED voucher ${label} — a qualifying cart could fall below your floors. ${suggestion >= 1 ? `Largest safe voucher at this minimum spend: ${rm(suggestion)}` : 'No voucher is safe at this minimum spend; raise it'}`,
        ok: false,
      }]);
      return { ok: false as const, blocked: true, safeAmount: suggestion };
    }
    const v: Voucher = {
      id: nextId('v'), code: `LIVE${Math.round(amountOff)}`, amountOff, minSpend, limit: Math.floor(limit),
      claimedBy: [], usedBy: [], active: true, ts: now(),
    };
    s.vouchers.push(v);
    log(s, [{ agent: 'Price Guard', summary: `voucher ${label} approved — every qualifying cart stays above your floors`, ok: true }]);
    say(s, `🎟 VOUCHER: ${rm(amountOff)} off${minSpend ? ` bila belanja ${rm(minSpend)} ke atas` : ''} — untuk ${v.limit} pembeli pertama. Tekan Claim!`, undefined, 'host');
    return { ok: true as const, voucher: v };
  });
}

export function endVoucher(id: string): void {
  update((s) => {
    const v = s.vouchers.find((x) => x.id === id);
    if (v) v.active = false;
  });
}

export function claimVoucher(buyer: string, id: string) {
  return update((s) => {
    const v = s.vouchers.find((x) => x.id === id && x.active);
    if (!v) return { ok: false as const, error: 'That voucher has ended' };
    if (v.usedBy.length >= v.limit) return { ok: false as const, error: 'Fully redeemed' };
    if (!v.claimedBy.includes(buyer)) v.claimedBy.push(buyer);
    return { ok: true as const };
  });
}

/**
 * The best voucher this buyer has claimed that fits this cart — checked again
 * against the floors of what is actually in the cart, since prices may have
 * changed since the voucher was created.
 */
export function voucherForCart(s: LiveState, buyer: string, cart: Reservation[]): { voucher: Voucher; discount: number } | undefined {
  const total = cart.reduce((n, r) => n + r.qty * r.unitPrice, 0);
  const floors = cart.reduce((n, r) => n + r.qty * (s.products.find((p) => p.sku === r.sku)?.floor ?? r.unitPrice), 0);
  return s.vouchers
    .filter((v) => v.active && v.claimedBy.includes(buyer) && !v.usedBy.includes(buyer) && v.usedBy.length < v.limit)
    .filter((v) => total >= v.minSpend && total - v.amountOff >= floors - 1e-9)
    .sort((a, b) => b.amountOff - a.amountOff)
    .map((voucher) => ({ voucher, discount: voucher.amountOff }))[0];
}

export function describeVouchers(s: LiveState): string | undefined {
  const open = s.vouchers.filter((v) => v.active && v.usedBy.length < v.limit);
  if (open.length === 0) return undefined;
  return open.map((v) => `${rm(v.amountOff)} off${v.minSpend ? ` (min ${rm(v.minSpend)})` : ''}`).join(', ');
}
