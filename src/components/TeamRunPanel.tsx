'use client';

import { useEffect, useRef, useState } from 'react';
import { act } from '@/components/useLiveState';
import type { LiveState, TeamRun } from '@/lib/types';

const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour12: false });

/**
 * One button that puts a team to work, and a live view of what each
 * role is doing. The written prompt stays available as a manual fallback.
 */
export function TeamRunPanel({
  state, kind, button, roles, manualPrompt, disabledReason,
}: {
  state: LiveState;
  kind: TeamRun['kind'];
  button: string;
  roles: string;
  manualPrompt: string;
  disabledReason?: string;
}) {
  const run = state.workspace.run?.kind === kind ? state.workspace.run : undefined;
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  // WorkBuddy on her desktop reaches this copy of the app, hosted or local, at the address she has open.
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);
  const log = useRef<HTMLDivElement>(null);
  const steps = run?.steps.length ?? 0;
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [steps]);

  async function start() {
    setError('');
    const res = await act({ type: 'run_team', kind });
    if (!res.ok) setError(res.error ?? 'Could not start the team.');
  }

  const working = run?.status === 'running';
  const hosted = !!origin && !/\/\/(localhost|127\.0\.0\.1)/.test(origin);
  const connection = JSON.stringify({
    mcpServers: { streamsense: { url: `${origin}/api/mcp`, ...(hosted ? { headers: { Authorization: 'Bearer YOUR_MCP_TOKEN' } } : {}) } },
  }, null, 2);
  const copy = (what: string, text: string) => navigator.clipboard?.writeText(text).then(() => {
    setCopied(what);
    setTimeout(() => setCopied(''), 1500);
  });

  return (
    <>
      <p className="muted">{roles}</p>
      <div className="row spaced">
        <button className="primary big" onClick={start} disabled={working || !!disabledReason}>
          {working ? 'Your team is working…' : button}
        </button>
        {working && <button className="ghost" onClick={() => act({ type: 'stop_team' })}>Stop</button>}
      </div>
      {disabledReason && !working && <p className="muted">{disabledReason}</p>}
      {error && <p className="verdict bad">{error}</p>}

      {run && (
        <div className={`run ${run.status}`}>
          <p className="run-head">
            <b>{run.status === 'running' ? 'Working' : run.status === 'done' ? 'Finished' : 'Stopped'}</b>
            <span className="muted">
              started {clock(run.startedAt)}
              {run.endedAt ? ` · ended ${clock(run.endedAt)}` : ''}
            </span>
          </p>
          <div className="run-log" ref={log}>
            {run.steps.map((s, i) => (
              <p key={i}>
                <i className={`who w-${s.who.toLowerCase().replace(/[^a-z]/g, '')}`}>{s.who}</i> {s.text}
              </p>
            ))}
          </div>
          {run.error && <p className="verdict bad">{run.error}</p>}
        </div>
      )}

      <details className="fold manual">
        <summary>Or run it yourself in WorkBuddy</summary>
        <p className="muted">
          <b>1.</b> Once, in WorkBuddy on your computer: add this as a custom connection (MCP). It points WorkBuddy at this page, so what it does shows up here.
          {hosted && ' Replace YOUR_MCP_TOKEN with the MCP_TOKEN value from your host’s environment settings.'}
        </p>
        <pre className="prompt">{connection}</pre>
        <button onClick={() => copy('connection', connection)}>{copied === 'connection' ? 'Copied' : 'Copy connection'}</button>
        <p className="muted"><b>2.</b> Paste this into a WorkBuddy chat that has the StreamSense connection turned on.</p>
        <pre className="prompt">{manualPrompt}</pre>
        <button onClick={() => copy('prompt', manualPrompt)}>{copied === 'prompt' ? 'Copied' : 'Copy prompt'}</button>
      </details>
    </>
  );
}
