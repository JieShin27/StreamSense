import { monitorHeard } from './agents/monitor';
import { alertHost, log } from './backstage';
import { checkPrice, rm } from './priceGuard';
import { nextId, now, update } from './store';
import { matchProduct, RISK } from './triage';

// The agents also listen to the seller. Whatever she says on camera arrives
// here as text (browser speech recognition, or typed). Two things are caught
// the moment she says them: a price below her floor, and a health claim.

const UNITS: Record<string, number> = {
  satu: 1, dua: 2, tiga: 3, empat: 4, lima: 5, enam: 6, tujuh: 7, lapan: 8, sembilan: 9,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};
const TEENS: Record<string, number> = {
  sepuluh: 10, sebelas: 11, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const CURRENCY = /^(rm|ringgit|myr|令吉|块)$/;

/** "lapan" → 8, "dua belas" → 12, "tiga puluh lima" → 35, "twenty five" → 25. Returns value and words used. */
function wordsToNumber(words: string[], i: number): { value: number; used: number } | undefined {
  const w = words[i];
  const next = words[i + 1];
  if (w in UNITS && next === 'belas') return { value: 10 + UNITS[w], used: 2 };
  if (w in UNITS && next === 'puluh') {
    const unit = words[i + 2] in UNITS ? UNITS[words[i + 2]] : 0;
    return { value: UNITS[w] * 10 + unit, used: unit ? 3 : 2 };
  }
  if (w in TENS) {
    const unit = next in UNITS ? UNITS[next] : 0;
    return { value: TENS[w] + unit, used: unit ? 2 : 1 };
  }
  if (w in TEENS) return { value: TEENS[w], used: 1 };
  if (w in UNITS) return { value: UNITS[w], used: 1 };
  return undefined;
}

/** Every amount of money mentioned: "RM8", "8 ringgit", "lapan ringgit", "ringgit dua belas", "RM 12.50". */
export function spokenPrices(text: string): number[] {
  const out: number[] = [];
  const t = text.toLowerCase();
  for (const m of t.matchAll(/(?:rm|ringgit|myr)\s*(\d+(?:\.\d{1,2})?)/g)) out.push(Number(m[1]));
  for (const m of t.matchAll(/(\d+(?:\.\d{1,2})?)\s*(?:ringgit|令吉|块)/g)) out.push(Number(m[1]));

  const words = t.replace(/[^a-z一-鿿\s]/g, ' ').split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const n = wordsToNumber(words, i);
    if (!n) continue;
    const before = words[i - 1] ?? '';
    const after = words[i + n.used] ?? '';
    if (CURRENCY.test(before) || CURRENCY.test(after)) out.push(n.value);
    i += n.used - 1;
  }
  return [...new Set(out)].filter((n) => n > 0);
}

const COOLDOWN_MS = 15000;
const recent = new Map<string, number>();
function once(key: string): boolean {
  const t = Date.now();
  if ((recent.get(key) ?? 0) > t - COOLDOWN_MS) return false;
  recent.set(key, t);
  return true;
}

export function hostSpeech(raw: string): { flagged: boolean } {
  const text = raw.trim().slice(0, 400);
  if (!text) return { flagged: false };

  return update((s) => {
    let flag: 'price' | 'claim' | undefined;
    const p = matchProduct(text, s.products) ?? s.products.find((x) => x.sku === s.spotlightSku);

    if (RISK.test(text)) {
      flag = 'claim';
      if (once(`claim:${text.slice(0, 40)}`)) {
        alertHost(s, { kind: 'policy', by: 'Host Monitor', sku: p?.sku, text: `You just said: "${text}". That is a health claim — correct it now: "it's food, not medicine."` });
        log(s, [{ agent: 'Coach', summary: 'heard a health claim on air — warned the host', ok: false }], { user: 'Host (mic)', text });
      }
    }

    if (p) {
      for (const price of spokenPrices(text)) {
        const verdict = checkPrice(price, p.floor);
        if (verdict.ok || !once(`price:${p.sku}:${price}`)) continue;
        flag = 'price';
        s.blockedDiscounts.push({ sku: p.sku, attempted: price, floor: p.floor, ts: now() });
        alertHost(s, {
          kind: 'policy', by: 'Price Guard', sku: p.sku,
          text: `You just said ${rm(price)} for ${p.name} — that is below your floor of ${rm(p.floor)}. Correct it now: say ${rm(verdict.safePrice)}.`,
        });
        log(s, [{ agent: 'Price Guard', summary: `heard ${rm(price)} for ${p.name} on air — below floor ${rm(p.floor)}. Safe price: ${rm(verdict.safePrice)}`, ok: false }], { user: 'Host (mic)', text });
      }
    }

    const line = { id: nextId('t'), ts: now(), text, flag };
    s.transcript.push(line);
    // The Host Monitor agent checks everything else: wrong prices, stock, facts and promises.
    monitorHeard(line.id, text, flag);
    if (s.transcript.length > 40) s.transcript.splice(0, s.transcript.length - 40);
    return { flagged: !!flag };
  });
}
