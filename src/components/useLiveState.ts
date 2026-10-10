'use client';

import { useEffect, useState } from 'react';
import type { LiveState } from '@/lib/types';

/** Subscribe to the room. EventSource reconnects by itself if the connection drops. */
export function useLiveState(): { state: LiveState | null; online: boolean } {
  const [state, setState] = useState<LiveState | null>(null);
  const [online, setOnline] = useState(false);

  useEffect(() => {
    const es = new EventSource('/api/stream');
    es.onopen = () => setOnline(true);
    es.onerror = () => setOnline(false);
    es.onmessage = (e) => {
      setOnline(true);
      setState(JSON.parse(e.data));
    };
    return () => es.close();
  }, []);

  return { state, online };
}

export async function act(body: Record<string, unknown>) {
  const res = await fetch('/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function buyerAct(body: Record<string, unknown>) {
  const res = await fetch('/api/buyer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function postComment(user: string, text: string) {
  await fetch('/api/comments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, text }),
  });
}
