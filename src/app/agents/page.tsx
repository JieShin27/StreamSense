'use client';

import { useEffect, useState } from 'react';
import { useLiveState } from '@/components/useLiveState';
import type { AgentName, AgentStep, LiveState, TeamRun } from '@/lib/types';

// The projector view: who is on the team, who hands to whom, and each comment
// travelling through the agents as it happens.

const ACTIVE_MS = 3500;

interface Card {
  name: string;
  job: string;
  gate?: boolean;
}

const PRE: Card[] = [
  { name: 'Finance', job: 'Explains her floor prices and room to discount' },
  { name: 'Sales', job: 'Writes the script and cue card' },
  { name: 'Compliance', job: 'Rejects risky lines, sends them back to Sales' },
];
const LIVE: (Card & { agent: AgentName })[] = [
  { agent: 'Triage', name: 'Triage', job: 'Reads every comment, hands it to a specialist' },
  { agent: 'Order & Stock', name: 'Order & Stock', job: 'Reserves, cancels, checks buyer offers' },
  { agent: 'Support', name: 'Support', job: 'Answers from confirmed facts, flags claims' },
  { agent: 'Coach', name: 'Coach', job: 'Watches the live, nudges the seller' },
  { agent: 'Price Guard', name: 'Price Guard', job: 'Rule: nothing below her floor price', gate: true },
  { agent: 'Grounding Gate', name: 'Grounding Gate', job: 'Rule: no answer without a confirmed fact', gate: true },
];
const POST: Card[] = [
  { name: 'Reconciliation', job: 'Reports sales, fees and profit' },
  { name: 'Restock', job: 'Drafts the supplier message' },
  { name: 'Followup', job: 'Writes to buyers who left items behind' },
  { name: 'Planner', job: "Builds next live's FAQ" },
];

function useTick(ms: number): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setT(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return t;
}

export default function AgentsView() {
  const { state } = useLiveState();
  const nowMs = useTick(700);
  if (!state) return <main className="loading">Connecting…</main>;

  const runs = {
    prepare: state.workspace.run?.kind === 'prepare' ? state.workspace.run : state.workspace.lastRuns?.prepare,
    wrapup: state.workspace.run?.kind === 'wrapup' ? state.workspace.run : state.workspace.lastRuns?.wrapup,
  };

  return (
    <main className="agents-view">
      <header>
        <span className="logo">StreamSense</span>
        <b>Agents view</b>
        <span className="muted">11 agents in 3 teams · 2 rule gates</span>
        {state.session.status === 'live' ? <span className="live-badge">LIVE</span> : <span className="pill">{state.session.status === 'ended' ? 'Live ended' : 'Not live'}</span>}
        <span className={`chip ${state.triageMode === 'agents' ? 'chip-on' : ''}`}>
          {state.triageMode === 'agents' ? 'Live team: AI model' : state.agentsRestingUntil ? 'Live team: resting, rules covering' : 'Live team: ready'}
        </span>
      </header>

      <section className="team-map">
        <TeamGroup title="Before the live" where={runs.prepare?.engine === 'model' ? 'StreamSense' : 'WorkBuddy'} flow="Finance ∥ Sales → Compliance ⇄ Sales">
          {PRE.map((c) => (
            <RoleCard key={c.name} card={c} run={runs.prepare} />
          ))}
        </TeamGroup>
        <span className="handoff">price floors<br />→</span>
        <TeamGroup title="During the live" where="StreamSense" flow="Triage → Order & Stock / Support → gates" wide>
          {LIVE.map((c) => (
            <LiveCard key={c.name} card={c} state={state} nowMs={nowMs} />
          ))}
        </TeamGroup>
        <span className="handoff">session<br />→</span>
        <TeamGroup title="After the live" where={runs.wrapup?.engine === 'model' ? 'StreamSense' : 'WorkBuddy'} flow="Reconciliation → Restock ∥ Follow-up ∥ Planner">
          {POST.map((c) => (
            <RoleCard key={c.name} card={c} run={runs.wrapup} />
          ))}
        </TeamGroup>
      </section>

      <Lanes state={state} nowMs={nowMs} />

      <section className="gantts">
        <Gantt title="Before the live" run={runs.prepare} nowMs={nowMs} />
        <Gantt title="After the live" run={runs.wrapup} nowMs={nowMs} />
      </section>
    </main>
  );
}

function TeamGroup({ title, where, flow, wide, children }: { title: string; where: string; flow: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={`team ${wide ? 'wide' : ''}`}>
      <h3>
        {title} <span className="muted">· {where}</span>
      </h3>
      <div className="cards">{children}</div>
      <p className="flow-line">{flow}</p>
    </div>
  );
}

function LiveCard({ card, state, nowMs }: { card: Card & { agent: AgentName }; state: LiveState; nowMs: number }) {
  let count = 0;
  let lastTs = 0;
  let lastBad = false;
  for (const a of state.activities) {
    for (const s of a.steps) {
      if (s.agent !== card.agent) continue;
      count++;
      lastTs = Date.parse(a.ts);
      lastBad = s.ok === false;
    }
  }
  // An agent is also "working" while a comment is waiting on it.
  const waiting = state.comments.some((c) => c.role === 'buyer' && !c.label && (card.agent === 'Triage' ? !c.routedTo : c.routedTo === card.agent));
  const active = waiting || nowMs - lastTs < ACTIVE_MS;
  return (
    <div className={`agent-card ${card.gate ? 'gate' : ''} ${active ? (lastBad && !waiting ? 'blocked' : 'active') : ''}`}>
      <b>{card.name}</b>
      <small>{card.job}</small>
      <span className="count">{count}</span>
    </div>
  );
}

function RoleCard({ card, run }: { card: Card; run?: TeamRun }) {
  const spans = (run?.spans ?? []).filter((s) => s.role === card.name);
  const working = run?.status === 'running' && spans.some((s) => !s.end);
  return (
    <div className={`agent-card ${working ? 'active' : ''} ${spans.length && !working ? 'done' : ''}`}>
      <b>{card.name === 'Followup' ? 'Follow-up' : card.name}</b>
      <small>{card.job}</small>
      <span className="count">{spans.length ? (working ? '…' : spans.length > 1 ? `✓×${spans.length}` : '✓') : ''}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One row per comment, one column per agent.
// ---------------------------------------------------------------------------

const cut = (s: string) => s.replace(/^hand-off → [^·]+· /, '');

function Lanes({ state, nowMs }: { state: LiveState; nowMs: number }) {
  const buyers = state.comments.filter((c) => c.role === 'buyer').slice(-9).reverse();
  return (
    <section className="lanes">
      <div className="lane-head">
        <span>Comment</span>
        <span>Triage</span>
        <span>Order &amp; Stock</span>
        <span>Support</span>
        <span>Gates</span>
        <span>Result</span>
      </div>
      {buyers.length === 0 && <p className="empty">Comments will travel through these lanes as they arrive.</p>}
      {buyers.map((c) => {
        const steps: AgentStep[] = state.activities.filter((a) => a.commentId === c.id).flatMap((a) => a.steps);
        const by = (...agents: AgentName[]) => steps.filter((s) => agents.includes(s.agent));
        const reply = state.comments.find((x) => x.replyTo === c.id);
        const fresh = nowMs - Date.parse(c.ts) < 6000;
        const result = !c.label
          ? ''
          : c.label === 'ignore' ? 'no reply needed'
            : c.label === 'warn' ? 'seller warned, nothing sent'
              : c.label === 'escalate' ? 'waiting for the seller'
                : reply ? reply.text.replace(/^@\S+\s*/, '') : '';
        const triage = by('Triage')[0];
        return (
          <div key={c.id} className={`lane-row ${fresh ? 'fresh' : ''}`}>
            <span className="lane-comment">
              <b>{c.user}</b> {c.text}
            </span>
            <Cell
              steps={triage ? [{ ...triage, summary: cut(triage.summary) }] : []}
              pending={!c.label && !c.routedTo ? 'reading…' : undefined}
              note={!triage && c.routedTo ? `→ ${c.routedTo}` : c.label === 'ignore' && !triage ? 'chatter' : undefined}
              arrow={triage ? triage.summary.match(/^hand-off → ([^·]+)/)?.[1]?.trim() : undefined}
            />
            <Cell steps={by('Order & Stock')} pending={!c.label && c.routedTo === 'Order & Stock' ? 'working…' : undefined} />
            <Cell steps={by('Support')} pending={!c.label && c.routedTo === 'Support' ? 'working…' : undefined} />
            <Cell steps={by('Price Guard', 'Grounding Gate', 'Coach')} showAgent />
            <span className={`lane-result ${c.label ?? ''}`}>{result}</span>
          </div>
        );
      })}
    </section>
  );
}

function Cell({ steps, pending, note, arrow, showAgent }: { steps: AgentStep[]; pending?: string; note?: string; arrow?: string; showAgent?: boolean }) {
  return (
    <span className="lane-cell">
      {pending && <i className="pending">{pending}</i>}
      {arrow && <em className="to">→ {arrow}</em>}
      {note && <i className="muted">{note}</i>}
      {steps.map((s, i) => (
        <i key={i} className={s.ok === false ? 'bad' : s.ok === true ? 'ok' : ''}>
          {showAgent && <b>{s.agent}: </b>}
          {s.summary}
        </i>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// When each WorkBuddy role was working: overlaps are parallel work, repeats are rework.
// ---------------------------------------------------------------------------

function Gantt({ title, run, nowMs }: { title: string; run?: TeamRun; nowMs: number }) {
  const spans = run?.spans ?? [];
  if (!run || spans.length === 0) {
    return (
      <div className="gantt">
        <h3>
          {title} <span className="muted">· team timeline</span>
        </h3>
        <p className="empty">{run ? 'Starting…' : 'Runs here when the seller starts this team.'}</p>
      </div>
    );
  }
  const start = Date.parse(run.startedAt);
  const end = run.endedAt ? Date.parse(run.endedAt) : nowMs;
  const total = Math.max(1, end - start);
  const roles = [...new Set(spans.map((s) => s.role))];
  const mins = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
  return (
    <div className="gantt">
      <h3>
        {title} <span className="muted">· team timeline · {run.status === 'running' ? 'running' : 'finished'} · {mins(total)}</span>
      </h3>
      {roles.map((role) => (
        <div key={role} className="gantt-row">
          <span>{role === 'Followup' ? 'Follow-up' : role}</span>
          <div className="gantt-track">
            {spans.filter((s) => s.role === role).map((s, i) => {
              const a = Date.parse(s.start);
              const b = s.end ? Date.parse(s.end) : nowMs;
              return (
                <i
                  key={i}
                  className={`bar r-${role.toLowerCase()} ${s.end ? '' : 'open'}`}
                  style={{ left: `${((a - start) / total) * 100}%`, width: `${Math.max(1.5, ((b - a) / total) * 100)}%` }}
                  title={`${role} · ${mins(b - a)}`}
                >
                  {i > 0 ? 'again' : ''}
                </i>
              );
            })}
          </div>
        </div>
      ))}
      <p className="muted small-print left">Bars side by side are roles working at the same time. A second bar on a row is rework after a rejection.</p>
    </div>
  );
}
