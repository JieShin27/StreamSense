import { alertHost, log, unitPrice } from './backstage';
import { checkPrice, rm } from './priceGuard';
import { nextId, now, update } from './store';
import { voucherForCart } from './vouchers';

// What a buyer can do from their own screen, besides commenting.

/** Tap "Add" on a product: same stock ledger and Price Guard as an order made by comment. */
export function addToCart(buyer: string, sku: string, qty = 1) {
  return update((s) => {
    const p = s.products.find((x) => x.sku === sku);
    if (!p) return { ok: false as const, error: 'Unknown product' };
    const take = Math.min(Math.max(1, Math.floor(qty) || 1), p.stock);
    if (take <= 0) return { ok: false as const, error: 'Sold out' };
    const unit = unitPrice(s, p);
    const before = p.stock;
    p.stock -= take;
    s.reservations.push({ id: nextId('r'), commentId: '', buyer, sku, qty: take, unitPrice: unit, status: 'reserved', ts: now() });
    log(s, [
      { agent: 'Order & Stock', summary: `@${buyer} added ${take} × ${p.name} to cart · stock ${before} → ${p.stock}`, ok: true },
      { agent: 'Price Guard', summary: `${rm(unit)} ≥ floor ${rm(p.floor)}`, ok: checkPrice(unit, p.floor).ok },
    ]);
    return { ok: true as const, qty: take };
  });
}

/** Pay for everything in the cart (simulated payment). */
export function checkout(buyer: string) {
  return update((s) => {
    const cart = s.reservations.filter((r) => r.buyer === buyer && r.status === 'reserved');
    if (cart.length === 0) return { ok: false as const, error: 'Your cart is empty' };
    const total = cart.reduce((sum, r) => sum + r.qty * r.unitPrice, 0);
    const applied = voucherForCart(s, buyer, cart);
    const discount = applied?.discount ?? 0;
    for (const r of cart) {
      r.status = 'paid';
      r.paidAt = now();
    }
    if (applied) applied.voucher.usedBy.push(buyer);
    s.payments.push({ id: nextId('p'), buyer, total, discount, voucherId: applied?.voucher.id, ts: now() });
    const units = cart.reduce((n, r) => n + r.qty, 0);
    log(s, [
      { agent: 'Order & Stock', summary: `@${buyer} checked out ${units} item(s) · ${rm(total - discount)} paid`, ok: true },
      ...(applied ? [{ agent: 'Price Guard' as const, summary: `voucher ${rm(discount)} applied — cart still above its floors`, ok: true }] : []),
    ]);
    return { ok: true as const, total: total - discount, discount, items: cart.length };
  });
}

/** Take one line out of the cart; the units go back on the shelf. */
export function removeFromCart(buyer: string, id: string) {
  return update((s) => {
    const r = s.reservations.find((x) => x.id === id && x.buyer === buyer && x.status === 'reserved');
    const p = r && s.products.find((x) => x.sku === r.sku);
    if (!r || !p) return { ok: false as const, error: 'Not in your cart' };
    r.status = 'released';
    const before = p.stock;
    p.stock += r.qty;
    log(s, [{ agent: 'Order & Stock', summary: `@${buyer} removed ${r.qty} × ${p.name} from cart · stock ${before} → ${p.stock}` }]);
    return { ok: true as const };
  });
}

/** A buyer writes in the private chat. The seller is told; agents do not answer here. */
export function buyerMessage(buyer: string, text: string) {
  return update((s) => {
    s.messages.push({ id: nextId('m'), buyer, from: 'buyer', text, ts: now() });
    alertHost(s, { kind: 'coach', text: `Private message from @${buyer}: "${text}"` });
    return { ok: true as const };
  });
}

/** The shop writes to one buyer's private chat (follow-ups after the live). */
export function shopMessage(buyer: string, text: string) {
  return update((s) => {
    s.messages.push({ id: nextId('m'), buyer, from: 'shop', text, ts: now() });
    return { ok: true as const };
  });
}
