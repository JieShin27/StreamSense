'use client';

import { useRef, useState } from 'react';
import { Markdown } from '@/components/Markdown';
import { SellerNav } from '@/components/SellerNav';
import { TeamRunPanel } from '@/components/TeamRunPanel';
import { act, useLiveState } from '@/components/useLiveState';

const rm = (n: number) => `RM${n.toFixed(2)}`;
type Doc = 'script' | 'cue' | 'floors' | 'compliance';

export default function PreparePage() {
  const { state } = useLiveState();
  const file = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState('');
  const [doc, setDoc] = useState<Doc>('script');

  if (!state) return <main className="loading">Loading…</main>;
  const { uploads, prep } = state.workspace;

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = [...(e.target.files ?? [])];
    e.target.value = '';
    for (const f of picked) {
      const res = await act({ type: 'upload', name: f.name, text: await f.text() });
      setNote(res.ok ? `Uploaded ${f.name}` : `${f.name}: ${res.error}`);
    }
  }

  return (
    <main className="console">
      <SellerNav state={state} />
      <div className="flow">
        <section className="panel no-print">
          <h2><span className="num">1</span> Upload your documents</h2>
          <p className="muted">Your cost sheet and product notes. CSV or plain text.</p>
          <div className="row spaced">
            <button onClick={() => file.current?.click()}>Choose files</button>
            <input ref={file} type="file" multiple accept=".csv,.txt,.md,.json,text/*" hidden onChange={onFiles} />
            {note && <span className="muted">{note}</span>}
          </div>
          {uploads.length === 0 && <p className="empty">Nothing uploaded yet.</p>}
          {uploads.map((u) => (
            <div key={u.id} className="cart-row">
              <span>
                <b>{u.name}</b>
              </span>
              <span className="muted">{u.text.split('\n').length} lines</span>
              <button className="small ghost" onClick={() => act({ type: 'remove_upload', id: u.id })}>Remove</button>
            </div>
          ))}
        </section>

        <section className="panel no-print">
          <h2><span className="num">2</span> Let your team prepare the live</h2>
          {uploads.length > 0 && (
            <p className="muted">
              In a hurry?{' '}
              <button
                className="small"
                onClick={async () => {
                  const res = await act({ type: 'load_sheet' });
                  setNote(res.ok ? `Loaded ${res.count} products into your live with calculated floor prices.` : res.error);
                }}
              >
                Load products and floor prices only
              </button>{' '}
              No script or cue card, but your live is ready in a second.
            </p>
          )}
          <TeamRunPanel
            state={state}
            kind="prepare"
            button="Prepare my live"
            roles="Finance works out your floor prices, Sales writes your script and cue card, and Compliance checks every line. They hand the results back here."
            disabledReason={uploads.length === 0 ? 'Upload at least your cost sheet first.' : undefined}
          />
        </section>

        <section className="panel">
          <h2 className="no-print">
            <span className="num">3</span> Your live pack
            {prep && <small className="muted"> · prepared {new Date(prep.ts).toLocaleTimeString()}</small>}
          </h2>
          {!prep ? (
            <p className="empty">Your script, price floors and cue card appear here when the team is done.</p>
          ) : (
            <>
              <div className="seg no-print" role="tablist">
                <button role="tab" aria-selected={doc === 'script'} onClick={() => setDoc('script')}>Script <small>by Sales</small></button>
                <button role="tab" aria-selected={doc === 'floors'} onClick={() => setDoc('floors')}>Price floors <small>by Finance</small></button>
                <button role="tab" aria-selected={doc === 'cue'} onClick={() => setDoc('cue')}>Cue card <small>by Sales</small></button>
                <button role="tab" aria-selected={doc === 'compliance'} onClick={() => setDoc('compliance')}>Review <small>by Compliance</small></button>
              </div>

              {doc === 'script' && <Markdown text={prep.script} />}
              {doc === 'compliance' && <Markdown text={prep.complianceLog ?? 'No compliance log was sent.'} />}
              {doc === 'cue' && (
                <>
                  <button className="no-print" onClick={() => window.print()}>Print cue card</button>
                  <div className="cue-card"><Markdown text={prep.cueCard} /></div>
                </>
              )}
              {doc === 'floors' && (
                <>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr><th>Product</th><th>List price</th><th>Floor</th><th>Room to discount</th><th>Stock</th></tr>
                      </thead>
                      <tbody>
                        {state.products.map((p) => (
                          <tr key={p.sku}>
                            <td>{p.name}</td>
                            <td>{rm(p.price)}</td>
                            <td><b>{rm(p.floor)}</b></td>
                            <td>{rm(p.price - p.floor)}</td>
                            <td>{p.stockStart}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="muted">These floors are enforced in your live by the Price Guard.</p>
                  {prep.floorNotes && <Markdown text={prep.floorNotes} />}
                </>
              )}
              <a className="button primary big next no-print" href="/">Continue to your live →</a>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
