import { NextResponse } from 'next/server';
import { hostSpeech } from '@/lib/speech';
import { getState } from '@/lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// A few seconds of the seller's microphone in, text out. Uses a multilingual
// speech model, so she can switch between Bahasa Malaysia, English and Mandarin
// in the same sentence — which the browser's built-in recognition cannot follow.

// What the model tends to "hear" in silence or background noise.
const NOISE = /^(thank you\.?|thanks( for watching)?\.?|terima kasih( kerana menonton)?\.?|you\.?|bye\.?|\.+|okay\.?|谢谢(观看|收看)?。?|字幕.*|subtitles? by.*)$/i;

export async function POST(req: Request) {
  const base = process.env.LLM_BASE_URL;
  const key = process.env.LLM_API_KEY;
  if (!base || !key) return NextResponse.json({ ok: false, error: 'No speech model is configured.' }, { status: 503 });
  if (getState().session.status !== 'live') return NextResponse.json({ ok: true, text: '' });

  const audio = await req.arrayBuffer();
  if (audio.byteLength < 2000) return NextResponse.json({ ok: true, text: '' });
  if (audio.byteLength > 4_000_000) return NextResponse.json({ ok: false, error: 'Clip too long.' }, { status: 413 });

  const s = getState();
  const form = new FormData();
  const type = req.headers.get('content-type') ?? 'audio/webm';
  const ext = /wav/.test(type) ? 'wav' : /mp4|m4a|aac/.test(type) ? 'm4a' : /ogg/.test(type) ? 'ogg' : 'webm';
  form.append('file', new Blob([audio], { type }), `clip.${ext}`);
  form.append('model', process.env.STT_MODEL || 'whisper-large-v3-turbo');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  // Names she is likely to say, so they are spelled the way the catalog spells them.
  form.append('prompt', `Live selling in Malaysia, mixing Bahasa Malaysia, English and 中文. Products: ${s.products.map((p) => p.name).join(', ')}. Prices in ringgit, RM.`);

  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      return NextResponse.json({ ok: false, error: res.status === 429 ? 'Speech model is rate-limited; try again shortly.' : `Speech model answered ${res.status}: ${detail}` }, { status: 502 });
    }
    const text = String((await res.json())?.text ?? '').trim();
    if (!text || NOISE.test(text)) return NextResponse.json({ ok: true, text: '' });
    const result = hostSpeech(text);
    return NextResponse.json({ ok: true, text, flagged: result.flagged });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}
