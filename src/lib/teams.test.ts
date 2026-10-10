import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLive } from './pipeline';
import { getState } from './store';
import { startTeam } from './teams';
import { stopTeam } from './workbuddy';
import { addUpload } from './workspace';

// The before/after teams running in the app, with a stand-in for the model.
// These prove the order of work, the rework loop and what gets saved — not how
// well a real model writes.

const SHEET = `sku,name,unit_cost,packaging,platform_fee_pct,min_margin,list_price,stock
KOPI-250,Kopi O Kampung,8.00,1.00,10,2.00,18.00,60
MADU-200,Madu Kelulut,17.00,1.00,10,4.00,35.00,5`;

/** Answer each role by a phrase in its instructions; a role's answers are used in order, the last one repeating. */
function fakeModel(script: Record<string, string[]>) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const system: string = JSON.parse(init.body).messages[0].content;
    const role = Object.keys(script).find((k) => system.includes(k)) ?? '';
    asked.push(role);
    const answers = script[role] ?? ['ok'];
    return Response.json({ choices: [{ message: { role: 'assistant', content: answers.length > 1 ? answers.shift() : answers[0] } }] });
  });
  return asked;
}

const run = () => getState().workspace.run;
const finished = () => vi.waitFor(() => expect(run()?.status).not.toBe('running'));

beforeEach(() => {
  getState().workspace = { uploads: [] };
  resetLive();
  vi.stubEnv('LLM_BASE_URL', 'http://model.test/v1');
  vi.stubEnv('LLM_API_KEY', 'k');
  vi.stubEnv('LLM_MODEL', 'm');
  vi.stubEnv('TEAM_RUNNER', 'model');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('teams running in the app', () => {
  it('prepares the live: rejected lines go back to Sales, floors come from the cost sheet', async () => {
    addUpload('cost_sheet.csv', SHEET);
    const asked = fakeModel({
      'You are Finance': ['- Kopi has room.'],
      'Write a 30-minute': ['Script v1: madu ni ubat batuk'],
      'cue card': ['| Kopi | RM18.00 | RM12.00 |'],
      'You are Compliance': ['REVISE\n"ubat batuk" is a health claim.', 'PASS'],
      'Compliance rejected': ['Script v2: madu asli'],
    });
    expect(startTeam('prepare', 'http://app.test')).toEqual({ ok: true });
    await finished();

    expect(run()).toMatchObject({ status: 'done', engine: 'model' });
    expect(asked.filter((r) => r === 'You are Compliance')).toHaveLength(2);
    expect(run()!.spans.filter((s) => s.role === 'Sales')).toHaveLength(2);
    const prep = getState().workspace.prep!;
    expect(prep.script).toBe('Script v2: madu asli');
    expect(prep.complianceLog).toContain('health claim');
    expect(prep.floorNotes).toContain('Kopi has room');
    // The cue card left out a floor, so the real ones are added under it.
    expect(prep.cueCard).toContain('RM24.00');
    expect(getState().products.map((p) => [p.sku, p.floor])).toEqual([['KOPI-250', 12], ['MADU-200', 24]]);
  });

  it('settles the live, and skips roles that have nothing to do', async () => {
    addUpload('cost_sheet.csv', SHEET);
    const asked = fakeModel({
      'You are Reconciliation': ['| Product | Profit |'],
      'You are Planner': ['Here it is: [{"question": "Halal?", "asked_count": 2, "suggested_answer": ""}]'],
      'team lead': ['- Nothing sold.'],
    });
    expect(startTeam('wrapup', 'http://app.test')).toEqual({ ok: true });
    await finished();

    expect(run()?.status).toBe('done');
    expect(asked).not.toContain('You are Restock');
    expect(asked).not.toContain('You are Follow-up');
    expect(getState().workspace.wrapup).toMatchObject({
      summary: '- Nothing sold.',
      salesSheet: '| Product | Profit |',
      followups: [],
      nextFaq: [{ question: 'Halal?', asked_count: 2 }],
    });
  });

  it('saves nothing after the seller presses Stop', async () => {
    addUpload('cost_sheet.csv', SHEET);
    fakeModel({});
    startTeam('prepare', 'http://app.test');
    stopTeam();
    await new Promise((r) => setTimeout(r, 50));
    expect(run()).toMatchObject({ status: 'failed', error: 'Stopped.' });
    expect(getState().workspace.prep).toBeUndefined();
  });

  it('says what is missing when there is no model and no WorkBuddy', () => {
    vi.stubEnv('LLM_API_KEY', '');
    addUpload('cost_sheet.csv', SHEET);
    expect(startTeam('prepare', 'http://app.test')).toMatchObject({ ok: false });
    expect(startTeam('prepare', 'http://app.test').error).toContain('LLM_API_KEY');
  });
});
