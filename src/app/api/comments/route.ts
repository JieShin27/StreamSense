import { NextResponse } from 'next/server';
import { addBuyerComment } from '@/lib/pipeline';
import { getState } from '@/lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const text = typeof body?.text === 'string' ? body.text.trim().slice(0, 200) : '';
  const user = (typeof body?.user === 'string' ? body.user.trim().replace(/^@+/, '').slice(0, 24) : '') || 'guest';
  if (!text) return NextResponse.json({ error: 'Empty comment' }, { status: 400 });
  if (getState().session.status !== 'live') {
    return NextResponse.json({ error: 'The live is not on air' }, { status: 409 });
  }
  // Set by a platform bridge (see bridges/): marks the feed as real and read-only.
  const source = typeof body?.source === 'string' ? body.source.trim().slice(0, 40) : '';
  if (source && process.env.INGEST_TOKEN && req.headers.get('authorization') !== `Bearer ${process.env.INGEST_TOKEN}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const c = addBuyerComment(user, text, source || undefined);
  return NextResponse.json({ id: c.id });
}
