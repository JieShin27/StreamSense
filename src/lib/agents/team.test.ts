import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLive } from '../pipeline';
import { getState, nextId, now } from '../store';
import type { Comment } from '../types';
import { runCoachAgent, runTeam } from './team';

// These tests replace the model with a stand-in that returns chosen tool calls.
// They prove the plumbing — hand-offs, tool execution, guards, fallbacks — not
// how well a real model decides. That needs a run with a real key.

type Call = { name: string; args: Record<string, unknown> };
type Turn = Call[] | 'stop' | 'fail';

/** Queue model turns per agent, matched by a phrase in that agent's system prompt. */
function fakeModel(script: Record<string, Turn[]>) {
  const seen: { agent: string; toolResults: unknown[] }[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const system: string = body.messages[0].content;
    const agent = Object.keys(script).find((k) => system.includes(k))!;
    seen.push({
      agent,
      toolResults: body.messages.filter((m: { role: string }) => m.role === 'tool').map((m: { content: string }) => JSON.parse(m.content)),
    });
    const turn = script[agent].shift() ?? 'stop';
    if (turn === 'fail') return new Response('boom', { status: 500 });
    const tool_calls = turn === 'stop' ? undefined : turn.map((c, i) => ({
      id: `call_${seen.length}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) },
    }));
    return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls } }] });
  });
  return seen;
}

function buyer(user: string, text: string): Comment {
  const c: Comment = { id: nextId('c'), role: 'buyer', user, text, ts: now(), handled: false };
  getState().comments.push(c);
  return c;
}

const assign = (rows: [Comment, string, string][]): Call => ({
  name: 'assign_comments',
  args: { assignments: rows.map(([c, to, lang]) => ({ comment_id: c.id, to, lang, reason: 'test' })) },
});
const sambal = () => getState().products.find((p) => p.sku === 'SAMBAL-200')!;
const replies = () => getState().comments.filter((c) => c.role === 'ai').map((c) => c.text);

beforeEach(() => {
  getState().workspace = { uploads: [] };
  resetLive();
  vi.stubEnv('LLM_BASE_URL', 'http://model.test/v1');
  vi.stubEnv('LLM_API_KEY', 'k');
  vi.stubEnv('LLM_MODEL', 'm');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('live agent team', () => {
  it('routes comments to specialists, whose tool calls change the room', async () => {
    const order = buyer('aina', 'nak 3 jar sambal');
    const ask = buyer('wei', 'sambal 多少钱?');
    const hello = buyer('yana', 'hi kak');
    fakeModel({
      'Triage Agent': [[assign([[order, 'order', 'ms'], [ask, 'support', 'zh'], [hello, 'ignore', 'ms']])]],
      'Order & Stock Agent': [[{ name: 'reserve_stock', args: { comment_id: order.id, sku: 'SAMBAL-200', qty: 3 } }], 'stop'],
      'Support Agent': [[{ name: 'answer_from_facts', args: { comment_id: ask.id, sku: 'SAMBAL-200', topic: 'price' } }], 'stop'],
    });

    const done = await runTeam([order, ask, hello]);

    expect([...done].sort()).toEqual([order.id, ask.id, hello.id].sort());
    expect(sambal().stock).toBe(117);
    expect(getState().reservations[0]).toMatchObject({ buyer: 'aina', qty: 3, unitPrice: 15 });
    expect(replies().some((r) => r.includes('reserve 3'))).toBe(true);
    expect(replies().some((r) => r.includes('RM15.00') && r.includes('@wei'))).toBe(true);
    // The activity rail shows the real chain: who handed off, which tool, which guard.
    const trail = getState().activities.find((a) => a.user === 'aina')!.steps.map((s) => s.agent);
    expect(trail).toEqual(['Triage', 'Order & Stock', 'Order & Stock', 'Price Guard']);
  });

  it('tells the agent what really happened so it can adapt', async () => {
    sambal().stock = 2;
    const big = buyer('farah', 'want 20 jar sambal');
    const next = buyer('din', 'nak 1 sambal');
    const seen = fakeModel({
      'Triage Agent': [[assign([[big, 'order', 'en'], [next, 'order', 'ms']])]],
      'Order & Stock Agent': [
        [{ name: 'reserve_stock', args: { comment_id: big.id, sku: 'SAMBAL-200', qty: 20 } }],
        [{ name: 'reserve_stock', args: { comment_id: next.id, sku: 'SAMBAL-200', qty: 1 } }],
      ],
    });
    await runTeam([big, next]);
    const rounds = seen.filter((s) => s.agent === 'Order & Stock Agent');
    expect(rounds.at(-1)!.toolResults[0]).toMatchObject({ result: 'reserved', detail: '2 of 20 asked; 0 left' });
    // Both comments handled after the second round, so no third model call is made.
    expect(rounds).toHaveLength(2);
    expect(replies().at(-1)).toContain('habis');
  });

  it('reserves several products from one comment, and cancels on request', async () => {
    const two = buyer('aina', 'nak 2 sambal and 1 tart');
    fakeModel({
      'Triage Agent': [[assign([[two, 'order', 'ms']])]],
      'Order & Stock Agent': [[
        { name: 'reserve_stock', args: { comment_id: two.id, sku: 'SAMBAL-200', qty: 2 } },
        { name: 'reserve_stock', args: { comment_id: two.id, sku: 'TART-50', qty: 1 } },
        { name: 'reserve_stock', args: { comment_id: two.id, sku: 'TART-50', qty: 1 } },
      ]],
    });
    await runTeam([two]);
    expect(getState().reservations.map((r) => [r.sku, r.qty])).toEqual([['SAMBAL-200', 2], ['TART-50', 1]]);

    const undo = buyer('aina', 'cancel tart');
    fakeModel({
      'Triage Agent': [[assign([[undo, 'order', 'ms']])]],
      'Order & Stock Agent': [[{ name: 'cancel_reservation', args: { comment_id: undo.id, sku: 'TART-50' } }]],
    });
    await runTeam([undo]);
    expect(getState().reservations.find((r) => r.sku === 'TART-50')!.status).toBe('released');
    expect(getState().products.find((p) => p.sku === 'TART-50')!.stock).toBe(30);
    expect(sambal().stock).toBe(118);
  });

  it('never lets an agent agree to a price: the Price Guard decides', async () => {
    const low = buyer('zul', 'sambal RM8 boleh?');
    fakeModel({
      'Triage Agent': [[assign([[low, 'order', 'ms']])]],
      'Order & Stock Agent': [[{ name: 'check_buyer_offer', args: { comment_id: low.id, sku: 'SAMBAL-200', offer_price: 8 } }], 'stop'],
    });
    await runTeam([low]);
    expect(getState().reservations).toHaveLength(0);
    expect(replies().at(-1)).toContain('RM15.00');
    expect(getState().activities.at(-1)!.steps.at(-1)).toMatchObject({ agent: 'Price Guard', ok: false });
  });

  it('will not answer without a confirmed fact, whatever the agent asks for', async () => {
    const halal = buyer('fizah', 'sambal ni halal ke?');
    fakeModel({
      'Triage Agent': [[assign([[halal, 'support', 'ms']])]],
      'Support Agent': [[{ name: 'answer_from_facts', args: { comment_id: halal.id, sku: 'SAMBAL-200', topic: 'halal' } }], 'stop'],
    });
    await runTeam([halal]);
    expect(replies()).toHaveLength(0);
    expect(getState().escalations[0]).toMatchObject({ topic: 'halal', status: 'open' });
  });

  it('refuses tool calls on comments that are not the agent’s, and unknown products', async () => {
    const mine = buyer('aina', 'nak 1 sambal');
    const other = buyer('wei', 'sambal 多少钱?');
    const seen = fakeModel({
      'Triage Agent': [[assign([[mine, 'order', 'ms'], [other, 'support', 'zh']])]],
      'Order & Stock Agent': [[
        { name: 'reserve_stock', args: { comment_id: other.id, sku: 'SAMBAL-200', qty: 50 } },
        { name: 'reserve_stock', args: { comment_id: mine.id, sku: 'GOLD-BAR', qty: 1 } },
      ], 'stop'],
      'Support Agent': ['stop'],
    });
    const done = await runTeam([mine, other]);
    expect(sambal().stock).toBe(120);
    expect(done.size).toBe(0);
    const results = seen.filter((s) => s.agent === 'Order & Stock Agent').at(-1)!.toolResults as { error?: string }[];
    expect(results.every((r) => r.error)).toBe(true);
  });

  it('leaves comments for the rules safety net when a specialist fails', async () => {
    const order = buyer('aina', 'nak 3 jar sambal');
    fakeModel({ 'Triage Agent': [[assign([[order, 'order', 'ms']])]], 'Order & Stock Agent': ['fail'] });
    const done = await runTeam([order]);
    expect(done.has(order.id)).toBe(false);
  });
});

describe('Coach Agent', () => {
  it('has its deal idea rejected by the Price Guard, then adapts', async () => {
    const seen = fakeModel({
      'Coach Agent': [
        [{ name: 'suggest_flash_deal', args: { sku: 'SERUNDING-150', price: 12, pitch: 'clear slow stock' } }],
        [{ name: 'suggest_flash_deal', args: { sku: 'SERUNDING-150', price: 19, pitch: 'clear slow stock' } }],
        'stop',
      ],
    });
    await runCoachAgent();
    expect(seen[1].toolResults[0]).toMatchObject({ rejected: true, lowest_safe_price: 19 });
    expect(getState().alerts).toHaveLength(1);
    expect(getState().alerts[0]).toMatchObject({ kind: 'flash_deal', sku: 'SERUNDING-150' });
    expect(getState().alerts[0].text).toContain('RM19.00');
  });
});
