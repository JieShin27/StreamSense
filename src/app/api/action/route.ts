import { NextResponse } from 'next/server';
import {
  answerEscalation,
  endLive,
  goLive,
  importFloors,
  proposeDeal,
  releaseReservation,
  resetLive,
  setSpotlight,
  startReplay,
  stopReplay,
} from '@/lib/pipeline';
import { hostSpeech } from '@/lib/speech';
import { startTeam } from '@/lib/teams';
import { stopTeam } from '@/lib/workbuddy';
import { createVoucher, endVoucher } from '@/lib/vouchers';
import { addUpload, loadFromCostSheet, removeUpload, sendFollowups } from '@/lib/workspace';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Every host-console button posts here: { type, ...args }. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  switch (body?.type) {
    case 'deal':
      return NextResponse.json(proposeDeal(String(body.sku), Number(body.price)));
    case 'voucher':
      return NextResponse.json(createVoucher(Number(body.amountOff), Number(body.minSpend) || 0, Number(body.limit) || 1));
    case 'end_voucher':
      endVoucher(String(body.id));
      return NextResponse.json({ ok: true });
    case 'spotlight':
      setSpotlight(String(body.sku));
      return NextResponse.json({ ok: true });
    case 'answer':
      answerEscalation(String(body.id), String(body.answer ?? ''));
      return NextResponse.json({ ok: true });
    case 'release':
      releaseReservation(String(body.id));
      return NextResponse.json({ ok: true });
    case 'floors': {
      const result = importFloors(body.payload);
      return NextResponse.json(result, { status: result.ok ? 200 : 400 });
    }
    case 'replay':
      if (body.action === 'stop') stopReplay();
      else startReplay();
      return NextResponse.json({ ok: true });
    case 'run_team': {
      // A WorkBuddy team connects back to this same server, wherever it is running.
      const origin = new URL(req.url).origin.replace('://localhost', '://127.0.0.1');
      return NextResponse.json(startTeam(body.kind === 'wrapup' ? 'wrapup' : 'prepare', origin));
    }
    case 'stop_team':
      stopTeam();
      return NextResponse.json({ ok: true });
    case 'go_live':
      goLive();
      return NextResponse.json({ ok: true });
    case 'end_live':
      endLive();
      return NextResponse.json({ ok: true });
    case 'speech':
      return NextResponse.json(hostSpeech(String(body.text ?? '')));
    case 'upload':
      return NextResponse.json(addUpload(String(body.name ?? ''), String(body.text ?? '')));
    case 'remove_upload':
      removeUpload(String(body.id));
      return NextResponse.json({ ok: true });
    case 'load_sheet':
      return NextResponse.json(loadFromCostSheet());
    case 'send_followups':
      return NextResponse.json(sendFollowups());
    case 'reset':
      resetLive();
      return NextResponse.json({ ok: true });
    default:
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  }
}
