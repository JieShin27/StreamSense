import { exportSession } from '@/lib/session';
import { getState } from '@/lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Download session.json for the post-live team. Also the read endpoint a connector would call. */
export async function GET() {
  return new Response(JSON.stringify(exportSession(getState()), null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="session.json"',
      'Cache-Control': 'no-store',
    },
  });
}
