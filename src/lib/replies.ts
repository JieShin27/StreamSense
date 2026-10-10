import type { Lang, Product, Topic } from './types';
import { rm } from './priceGuard';

// Every buyer-facing sentence is assembled here from live numbers and
// seller-confirmed facts. The model never writes text that buyers read.

export function reservedReply(lang: Lang, user: string, qty: number, p: Product, asked: number): string {
  const short = qty < asked;
  switch (lang) {
    case 'zh':
      return `@${user} 已为你保留 ${qty} × ${p.name} ✅${short ? `（只剩 ${qty} 个）` : ''} 已放进你的购物车，请点 Checkout 付款`;
    case 'en':
      return `@${user} reserved ${qty} × ${p.name} for you ✅${short ? ` (only ${qty} left)` : ''} It is in your cart, tap Checkout to pay`;
    default:
      return `@${user} dah reserve ${qty} × ${p.name} ✅${short ? ` (tinggal ${qty} je)` : ''} Dah masuk cart, tekan Checkout untuk bayar ya`;
  }
}

export function soldOutReply(lang: Lang, user: string, p: Product): string {
  switch (lang) {
    case 'zh':
      return `@${user} 不好意思，${p.name} 卖完了 🙏`;
    case 'en':
      return `@${user} sorry, ${p.name} is sold out 🙏`;
    default:
      return `@${user} maaf, ${p.name} dah habis 🙏`;
  }
}

export function cancelledReply(lang: Lang, user: string, units: number): string {
  switch (lang) {
    case 'zh':
      return `@${user} 已为你取消 ${units} 件，购物车已更新`;
    case 'en':
      return `@${user} done, ${units} item(s) removed from your cart`;
    default:
      return `@${user} ok dah cancel ${units} item dari cart awak`;
  }
}

export function nothingToCancelReply(lang: Lang, user: string): string {
  switch (lang) {
    case 'zh':
      return `@${user} 你的购物车里没有未付款的商品`;
    case 'en':
      return `@${user} there is nothing unpaid in your cart to cancel`;
    default:
      return `@${user} tak ada item belum bayar dalam cart awak`;
  }
}

export function priceReply(lang: Lang, user: string, p: Product, unit: number): string {
  switch (lang) {
    case 'zh':
      return `@${user} ${p.name} ${rm(unit)}，想要可以直接留言数量`;
    case 'en':
      return `@${user} ${p.name} is ${rm(unit)}. Comment how many you want`;
    default:
      return `@${user} ${p.name} ${rm(unit)} je. Komen berapa nak ya`;
  }
}

export function stockReply(lang: Lang, user: string, p: Product): string {
  if (p.stock <= 0) return soldOutReply(lang, user, p);
  switch (lang) {
    case 'zh':
      return `@${user} ${p.name} 还有货，剩 ${p.stock} 个`;
    case 'en':
      return `@${user} yes, ${p.stock} left of ${p.name}`;
    default:
      return `@${user} ada lagi! ${p.name} tinggal ${p.stock}`;
  }
}

export function voucherReply(lang: Lang, user: string, vouchers?: string): string {
  if (!vouchers) {
    switch (lang) {
      case 'zh':
        return `@${user} 现在没有优惠券，有的话会马上通知`;
      case 'en':
        return `@${user} no voucher right now — we will announce it here when there is one`;
      default:
        return `@${user} sekarang belum ada voucher, nanti kami umum kat sini ya`;
    }
  }
  switch (lang) {
    case 'zh':
      return `@${user} 有优惠券：${vouchers}，点 Claim 领取`;
    case 'en':
      return `@${user} yes: ${vouchers}. Tap Claim above the products`;
    default:
      return `@${user} ada: ${vouchers}. Tekan Claim kat atas produk ya`;
  }
}

export function factReply(user: string, fact: string): string {
  return `@${user} ${fact}`;
}

export function declineOfferReply(lang: Lang, user: string, p: Product, unit: number): string {
  switch (lang) {
    case 'zh':
      return `@${user} 不好意思，${p.name} 今天最低 ${rm(unit)} 🙏`;
    case 'en':
      return `@${user} sorry, best price today for ${p.name} is ${rm(unit)} 🙏`;
    default:
      return `@${user} maaf ya, harga terbaik ${p.name} hari ni ${rm(unit)} 🙏`;
  }
}

export const TOPIC_LABEL: Record<Topic, string> = {
  price: 'price',
  stock: 'stock',
  halal: 'halal status',
  spicy: 'spiciness',
  expiry: 'shelf life',
  shipping: 'shipping',
  ingredients: 'ingredients',
  size: 'size',
  voucher: 'vouchers',
  discount: 'discount',
  other: 'details',
};
