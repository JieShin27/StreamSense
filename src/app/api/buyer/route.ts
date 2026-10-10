import { NextResponse } from 'next/server';
import { addToCart, buyerMessage, checkout, removeFromCart } from '@/lib/buyer';
import { claimVoucher } from '@/lib/vouchers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Buyer-screen actions: { type, user, ... }. Identity is the name the buyer typed — this is a simulation. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const user = typeof body?.user === 'string' ? body.user.trim().replace(/^@+/, '').slice(0, 24) : '';
  if (!user) return NextResponse.json({ ok: false, error: 'Missing name' }, { status: 400 });

  switch (body?.type) {
    case 'add':
      return NextResponse.json(addToCart(user, String(body.sku), Number(body.qty) || 1));
    case 'remove':
      return NextResponse.json(removeFromCart(user, String(body.id)));
    case 'claim':
      return NextResponse.json(claimVoucher(user, String(body.id)));
    case 'checkout':
      return NextResponse.json(checkout(user));
    case 'message': {
      const text = typeof body.text === 'string' ? body.text.trim().slice(0, 300) : '';
      if (!text) return NextResponse.json({ ok: false, error: 'Empty message' }, { status: 400 });
      return NextResponse.json(buyerMessage(user, text));
    }
    default:
      return NextResponse.json({ ok: false, error: 'Unknown action' }, { status: 400 });
  }
}
