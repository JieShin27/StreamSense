#!/usr/bin/env node
// Checks the keys in .env.local without printing them.
//   npm run check:keys

import { readFileSync } from 'node:fs';

const env = {};
try {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  console.error('✕ .env.local not found. Copy .env.example to .env.local first.');
  process.exit(1);
}

const ok = (msg) => console.log(`✓ ${msg}`);
const bad = (msg) => console.log(`✕ ${msg}`);
const skip = (msg) => console.log(`– ${msg}`);
let failed = false;

// --- 1. Model -------------------------------------------------------------
console.log('\nModel for the live agents');
const { LLM_BASE_URL: base, LLM_API_KEY: key } = env;
const model = (env.LLM_MODEL ?? '').split(',')[0].trim();
if (!key) {
  skip('LLM_API_KEY is empty — the app will run on keyword rules.');
} else if (!base || !model) {
  bad('LLM_BASE_URL and LLM_MODEL must both be set.');
  failed = true;
} else {
  const url = `${base.replace(/\/$/, '')}/chat/completions`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: 'You reserve stock for buyers. Always use the tool.' },
          { role: 'user', content: 'Buyer aina says: "nak 3 jar sambal". SKU is SAMBAL-200.' },
        ],
        tools: [{
          type: 'function',
          function: {
            name: 'reserve_stock',
            description: 'Reserve units of a product for a buyer.',
            parameters: { type: 'object', properties: { sku: { type: 'string' }, qty: { type: 'integer' } }, required: ['sku', 'qty'] },
          },
        }],
        tool_choice: 'auto',
      }),
    });
    const ms = Date.now() - started;
    const text = await res.text();
    if (!res.ok) {
      failed = true;
      bad(`The endpoint answered ${res.status}: ${text.slice(0, 300)}`);
      if (res.status === 401) console.log('  → the key is wrong or was revoked.');
      if (res.status === 404 || /model/i.test(text)) {
        const list = await fetch(`${base.replace(/\/$/, '')}/models`, { headers: { Authorization: `Bearer ${key}` } }).then((r) => r.json()).catch(() => null);
        const ids = list?.data?.map((m) => m.id).sort();
        if (ids?.length) console.log(`  → models your key can use:\n    ${ids.join('\n    ')}`);
      }
    } else {
      const call = JSON.parse(text)?.choices?.[0]?.message?.tool_calls?.[0];
      if (call?.function?.name === 'reserve_stock') {
        ok(`Key works, model "${model}" answered in ${ms} ms.`);
        ok(`Tool calling works: reserve_stock(${call.function.arguments})`);
        if (ms > 4000) console.log('  ! Slow for live chat. Consider a faster model.');
      } else {
        failed = true;
        bad(`The model answered in ${ms} ms but did not call the tool. Pick a model that supports tool calling.`);
      }
    }
  } catch (err) {
    failed = true;
    bad(`Could not reach ${url}: ${err.message}`);
  }
}

// --- 2. Video -------------------------------------------------------------
console.log('\nLive video (LiveKit)');
const { LIVEKIT_URL: lk, LIVEKIT_API_KEY: lkKey, LIVEKIT_API_SECRET: lkSecret } = env;
if (!lk && !lkKey && !lkSecret) {
  skip('Not set — the room will run without video.');
} else if (!lk || !lkKey || !lkSecret) {
  failed = true;
  bad('Set all three: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET.');
} else if (!/^wss:\/\/.+/.test(lk)) {
  failed = true;
  bad('LIVEKIT_URL should start with wss:// (copy the "Project URL").');
} else {
  ok('All three values are present and the URL looks right. (Not connected yet — that is tested when video is built.)');
}

// --- 3. Secrets -----------------------------------------------------------
console.log('\nShared secrets');
for (const name of ['MCP_TOKEN', 'INGEST_TOKEN']) {
  if (!env[name]) skip(`${name} is empty — fine locally, set it before the app is public.`);
  else if (env[name].length < 16) { failed = true; bad(`${name} is too short; use at least 16 random characters.`); }
  else ok(`${name} is set.`);
}

console.log('');
process.exit(failed ? 1 : 0);
