'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import type { LiveState } from '@/lib/types';

/** The seller's day in three steps, each with a one-word status. */
export function SellerNav({ state, children }: { state: LiveState; children?: ReactNode }) {
  const path = usePathname();
  const { prep, wrapup, run } = state.workspace;
  const working = (kind: 'prepare' | 'wrapup') => run?.kind === kind && run.status === 'running';

  const steps = [
    { href: '/prepare', n: 1, label: 'Prepare', status: working('prepare') ? 'team working' : prep ? 'pack ready' : 'not started', done: !!prep },
    { href: '/', n: 2, label: 'Live', status: state.session.status === 'live' ? 'on air' : state.session.status === 'ended' ? 'ended' : 'not started', done: state.session.status === 'ended' },
    { href: '/wrapup', n: 3, label: 'Wrap-up', status: working('wrapup') ? 'team working' : wrapup ? 'ready' : 'not started', done: !!wrapup },
  ];

  return (
    <header className="seller-nav">
      <span className="logo">StreamSense</span>
      <nav aria-label="Seller steps">
        {steps.map((s) => (
          <Link key={s.href} href={s.href} aria-current={path === s.href ? 'page' : undefined} className={s.done ? 'done' : ''}>
            <b>{s.done ? '✓' : s.n}</b>
            <span>
              {s.label}
              <small>{s.status}</small>
            </span>
          </Link>
        ))}
      </nav>
      <div className="nav-right">
        {children}
        <a className="chip" href="/agents" target="_blank" rel="noreferrer">Agents view ↗</a>
      </div>
    </header>
  );
}
