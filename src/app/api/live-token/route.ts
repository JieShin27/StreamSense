import { NextResponse } from 'next/server';
import { AccessToken } from 'livekit-server-sdk';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ROOM = 'streamsense-live';

/**
 * Hands the browser a short-lived pass into the video room. The seller may
 * publish camera and microphone; buyers may only watch. Keys stay on the server.
 * Simulation note: the seller role is not authenticated.
 */
export async function GET(req: Request) {
  const { LIVEKIT_URL: url, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret } = process.env;
  if (!url || !key || !secret) return NextResponse.json({ enabled: false });

  const params = new URL(req.url).searchParams;
  const host = params.get('role') === 'host';
  const name = (params.get('name') ?? '').trim().slice(0, 24) || 'guest';
  // Identities must be unique per connection, or a second tab kicks the first out.
  const identity = `${host ? 'host' : 'viewer'}-${name}-${Math.random().toString(36).slice(2, 8)}`;

  const at = new AccessToken(key, secret, { identity, name: host ? 'Seller' : name, ttl: '3h' });
  at.addGrant({ roomJoin: true, room: ROOM, canPublish: host, canSubscribe: true, canPublishData: false });
  return NextResponse.json({ enabled: true, url, token: await at.toJwt() });
}
