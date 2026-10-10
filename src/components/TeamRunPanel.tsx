'use client';

import { useEffect, useRef, useState } from 'react';
import { act } from '@/components/useLiveState';
import type { LiveState, TeamRun } from '@/lib/types';

const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour12: false });

/**
 * One button that puts a WorkBuddy team to work, and a live view of what each
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
  const [copied, setCopied] = useState(false);
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
        <p className="muted">Paste this into a WorkBuddy chat that has the StreamSense connection turned on.</p>
        <pre className="prompt">{manualPrompt}</pre>
        <button
          onClick={() => navigator.clipboard?.writeText(manualPrompt).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })}
        >
          {copied ? 'Copied' : 'Copy prompt'}
        </button>
      </details>
    </>
  );
}
