import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getState, now, update } from './store';
import type { TeamRun } from './types';

// Starts a WorkBuddy agent team from a button in the app. The agent engine
// WorkBuddy runs on can also be started without its chat window; we start it
// with one goal, three or four named roles,
// and a connection back to this app (MCP). Its agents then read the seller's
// documents and hand in their work through the tools described in /api/mcp.
//
// The engine is installed and signed in once on the seller's computer
// (`npm run workbuddy:login`). A hosted copy of the app does not have it; there
// the same roles run in the app (teams.ts).

function cliPath(): string | undefined {
  const candidates = [
    process.env.WORKBUDDY_CLI,
    process.env.APPDATA && join(process.env.APPDATA, 'npm', 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy'),
    '/usr/local/lib/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy',
    join(process.cwd(), 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'WorkBuddyAI', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'),
    '/Applications/WorkBuddyAI.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy',
  ];
  return candidates.find((p): p is string => !!p && existsSync(p));
}

export function workbuddyAvailable(): boolean {
  return !!cliPath();
}

interface Brief {
  goal: string;
  roles: Record<string, { description: string; prompt: string }>;
}

const SHARED = 'You work for a solo Malaysian live seller. Use only the streamsense tools. Be concrete and brief. Never invent a cost, a price or a product fact that is not in her documents.';

const BRIEFS: Record<TeamRun['kind'], Brief> = {
  prepare: {
    goal: `The seller is going live tonight. Her documents are in StreamSense. Prepare her.

1. Call get_uploaded_documents and get_price_floors. Give both results to your roles so they do not fetch them again.
2. Delegate to your three roles: finance and sales at the same time, then compliance on the sales draft. Send every line compliance rejects back to sales and repeat until the script passes.
3. Call save_prelive_pack exactly once, with the complete documents: products (sku, name, price = list price, floor, stock — copied from get_price_floors), script_markdown, cue_card_markdown and compliance_log_markdown.

Only you call save_prelive_pack. The roles return text to you and save nothing.

Finish with five lines: what was saved, her floor price per product, and what she must not say on camera.`,
    roles: {
      finance: {
        description: 'Explains the floor price per product and how much room there is to discount.',
        prompt: `${SHARED} You are Finance. The floor prices are already calculated by the system (get_price_floors); never recalculate or change them. Return a table of sku, name, list price, floor, stock and room to discount, one plain sentence per product on what the floor means for her, and flag any product with less than RM3 of room. Save nothing.`,
      },
      sales: {
        description: 'Writes the run-of-show and the one-page cue card.',
        prompt: `${SHARED} You are Sales. Write a 30-minute run-of-show in Bahasa Malaysia with English and 中文 lines for the key moments: product order, an opening hook, one talking point per product, when to announce low stock, and one flash deal per product that is at or above its floor from get_price_floors. Then a one-page cue card: per product, list price and the lowest price she may say (the floor). Save nothing; return the documents. If there is an FAQ from her previous live, answer those questions inside the script. Markdown.`,
      },
      compliance: {
        description: 'Reviews the script and product notes; rejects risky claims.',
        prompt: `${SHARED} You are Compliance. Read the script and the product notes. Reject any medical or health claim, any guarantee, and any halal claim not backed by a certificate. For each: quote the line, say why, and give a safe replacement. Check that no price in the script is below its floor. If nothing is wrong, say the script passes. Save nothing.`,
      },
    },
  },
  wrapup: {
    goal: `The live has ended. Settle everything.

1. Call get_session and get_uploaded_documents. Give both results to your roles so they do not fetch them again.
2. Delegate: reconciliation first, then restock, followup and planner at the same time using its results.
3. Call save_wrapup once with: summary, sales_sheet_markdown, restock_message, followups (buyer, text) and next_live_faq (question, asked_count, suggested_answer).

Finish with what she earned after fees, what to reorder, and who gets a message.`,
    roles: {
      reconciliation: {
        description: 'Turns the session into a sales sheet with profit after fees.',
        prompt: `${SHARED} You are Reconciliation. The session's "sales_summary" already holds the correct money figures; copy them, never recalculate. Produce a Markdown table per product: units paid, revenue, platform fees, cost of goods, profit, stock left, units left unpaid, with a totals row. Then list each buyer with unpaid items, and add two plain sentences on what the numbers mean for her.`,
      },
      restock: {
        description: 'Drafts the purchase message to her supplier.',
        prompt: `${SHARED} You are Restock. For any product sold out or below 20% of its starting stock, write one short purchase message to her supplier in Bahasa Malaysia, with quantities based on tonight's demand. Plain text. If nothing needs restocking, say so.`,
      },
      followup: {
        description: 'Drafts private chat messages to buyers.',
        prompt: `${SHARED} You are Follow-up. Write one short, friendly chat message per buyer who left items unpaid, and one per buyer whose question is in "unanswered" (answer it if "learned_answers" covers it). Use the language that buyer wrote in. Use the buyer name exactly as it appears. Never include a phone number or a link.`,
      },
      planner: {
        description: "Builds next live's FAQ from tonight's questions.",
        prompt: `${SHARED} You are Planner. Group "unanswered" and "learned_answers" by topic and count them. Produce the FAQ for her next live: question, how many times asked, and a suggested answer only where she already gave one. Note any prices in "blocked_discounts" she tried to give below her floor.`,
      },
    },
  },
};

const NOT_SIGNED_IN = 'WorkBuddy is not signed in on this computer. Open its command line once, type /login, then press the button again.';
const needsLogin = (text: string) => /authentication required|\/login/i.test(text);
let signInNeeded = false;

const g = globalThis as unknown as { __streamsenseRun?: { kill: () => void } };

/** Put a new run on the page. `kill` is what Stop does to whatever is doing the work. */
export function beginRun(kind: TeamRun['kind'], engine: NonNullable<TeamRun['engine']>, kill: () => void): void {
  update((s) => {
    s.workspace.run = { kind, status: 'running', engine, startedAt: now(), steps: [], spans: [] };
  });
  g.__streamsenseRun = { kill };
  step('Team lead', kind === 'prepare' ? 'Starting: Finance, Sales and Compliance.' : 'Starting: Reconciliation, Restock, Follow-up and Planner.');
}

export function step(who: string, text: string): void {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return;
  if (needsLogin(clean)) {
    // The engine answers with a sign-in notice instead of working; say so plainly when it stops.
    signInNeeded = true;
    return;
  }
  update((s) => {
    const run = s.workspace.run;
    if (!run) return;
    run.steps.push({ ts: now(), who, text: clean.slice(0, 400) });
    if (run.steps.length > 80) run.steps.splice(0, run.steps.length - 80);
  });
}

export function finish(status: 'done' | 'failed', error?: string): void {
  update((s) => {
    const run = s.workspace.run;
    if (!run || run.status !== 'running') return;
    run.status = status;
    run.endedAt = now();
    run.error = status === 'failed' && signInNeeded ? NOT_SIGNED_IN : error;
    signInNeeded = false;
    for (const span of run.spans) span.end ??= run.endedAt;
    if (status === 'done') s.workspace.lastRuns = { ...s.workspace.lastRuns, [run.kind]: run };
  });
}

const TOOL_LABEL: Record<string, string> = {
  get_uploaded_documents: 'reading her documents',
  get_price_floors: 'getting the floor prices calculated from her cost sheet',
  save_prelive_pack: 'handing in the script, cue card and price floors',
  get_session: "reading tonight's live",
  save_wrapup: 'handing in the wrap-up',
  get_live_state: 'checking the live room',
};

/** Translate one line of the engine's event stream into something the seller can follow. */
function onEvent(ev: Record<string, unknown>, agents: Map<string, string>): void {
  const content = (ev.message as { content?: unknown } | undefined)?.content;
  if (ev.type === 'assistant' && Array.isArray(content)) {
    const who = agents.get(String(ev.parent_tool_use_id ?? '')) ?? 'Team lead';
    for (const block of content as Record<string, unknown>[]) {
      if (block.type === 'text' && typeof block.text === 'string') step(who, block.text);
      if (block.type === 'tool_use') {
        const name = String(block.name ?? '');
        const input = (block.input ?? {}) as Record<string, unknown>;
        const role = input.subagent_type ?? input.agent ?? input.name;
        if (typeof role === 'string' && /task|agent/i.test(name)) {
          const label = role.charAt(0).toUpperCase() + role.slice(1);
          agents.set(String(block.id), label);
          update((s) => void s.workspace.run?.spans.push({ role: label, start: now() }));
          step(who, `→ asks ${label}: ${String(input.description ?? input.prompt ?? '').slice(0, 160)}`);
        } else {
          // StreamSense tools are often reached through a generic "run tool" call; look inside for the name.
          const tool = (`${name} ${JSON.stringify(input)}`.match(/mcp__streamsense__([a-z_]+)/) ?? [])[1];
          if (tool) step(who, TOOL_LABEL[tool] ?? `uses ${tool}`);
        }
      }
    }
  }
  // A role's work comes back to the lead as the result of the call that started it.
  if (ev.type === 'user' && Array.isArray(content)) {
    for (const block of content as Record<string, unknown>[]) {
      const role = block.type === 'tool_result' ? agents.get(String(block.tool_use_id)) : undefined;
      if (!role) continue;
      update((s) => {
        const open = s.workspace.run?.spans.find((x) => x.role === role && !x.end);
        if (open) open.end = now();
      });
    }
  }
  if (ev.type === 'result') {
    const said = String(ev.result ?? ev.error ?? '');
    if (needsLogin(said)) finish('failed', NOT_SIGNED_IN);
    else if (ev.is_error || ev.subtype === 'error') finish('failed', said.slice(0, 400) || 'The team stopped with an error.');
    else {
      finish('done');
    }
  }
}

export function startTeam(kind: TeamRun['kind'], origin: string): { ok: boolean; error?: string } {
  const cli = cliPath();
  if (!cli) return { ok: false, error: 'WorkBuddy is not installed on the computer running StreamSense.' };

  const brief = BRIEFS[kind];
  const server: Record<string, unknown> = { type: 'http', url: `${origin}/api/mcp` };
  if (process.env.MCP_TOKEN) server.headers = { Authorization: `Bearer ${process.env.MCP_TOKEN}` };

  // An empty folder of its own: the team needs no files, only the StreamSense tools.
  const cwd = join(tmpdir(), 'streamsense-team');
  mkdirSync(cwd, { recursive: true });

  const child = spawn(process.execPath, [
    cli, '-p', brief.goal,
    '--output-format', 'stream-json', '--verbose',
    '--mcp-config', JSON.stringify({ mcpServers: { streamsense: server } }), '--strict-mcp-config',
    '--agents', JSON.stringify(brief.roles),
    '--permission-mode', 'bypassPermissions',
    '--disallowedTools', 'Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch',
    '--max-turns', '40',
  ], { cwd, windowsHide: true, env: { ...process.env, NO_COLOR: '1' } });
  beginRun(kind, 'workbuddy', () => child.kill());

  const agents = new Map<string, string>();
  let buffer = '';
  let plain = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        onEvent(JSON.parse(line), agents);
      } catch {
        plain += line + '\n';
      }
    }
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));

  const timer = setTimeout(() => {
    child.kill();
    finish('failed', 'The team took longer than 15 minutes and was stopped.');
  }, 15 * 60 * 1000);

  child.on('error', (err) => {
    clearTimeout(timer);
    finish('failed', `Could not start WorkBuddy: ${err.message}`);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    const said = `${plain}\n${stderr}`.trim();
    if (needsLogin(said)) {
      finish('failed', NOT_SIGNED_IN);
    } else if (code !== 0) {
      finish('failed', said.slice(-400) || `WorkBuddy exited with code ${code}.`);
    } else {
      finish('done');
    }
  });

  return { ok: true };
}

/**
 * The team has handed in its work: the run is finished as far as the seller is
 * concerned. The engine gets a short grace period to wrap up, then is stopped.
 */
export function teamHandedIn(kind: TeamRun['kind']): void {
  const run = getState().workspace.run;
  if (!run || run.kind !== kind || run.status !== 'running') return;
  step('Team lead', kind === 'prepare' ? 'Handed in: script, cue card and price floors.' : 'Handed in: sales sheet, supplier message, follow-ups and next FAQ.');
  finish('done');
  const working = g.__streamsenseRun;
  setTimeout(() => working?.kill(), 20_000);
}

export function stopTeam(): void {
  g.__streamsenseRun?.kill();
  finish('failed', 'Stopped.');
}
