import type { FloorRow } from './seed';
import type { Topic } from './types';
import type { Workspace } from './types';

// Floor prices are arithmetic on the seller's own cost sheet, so they are
// computed here and never by a model. Agents read these numbers and explain
// them; whatever number an agent writes down is not used.

export interface FloorWorking extends FloorRow {
  cost: number;
  feePct: number;
  minMargin: number;
}

/** Split one CSV line, respecting "quoted, fields". */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

const REQUIRED = ['sku', 'name', 'unit_cost', 'list_price', 'stock'];
/** Optional columns: what she has confirmed about each product. Buyers' questions on these are answered for her. */
const FACT_COLUMNS: Topic[] = ['halal', 'spicy', 'expiry', 'shipping', 'ingredients', 'size'];

/**
 * floor = (unit cost + packaging + seller-paid shipping) ÷ (1 − platform fee %) + minimum margin,
 * rounded up to the next 10 sen.
 */
export function floorsFromCostSheet(csv: string): FloorWorking[] | undefined {
  const lines = csv.replace(/\r/g, '').split('\n').filter((l) => l.trim());
  if (lines.length < 2) return undefined;
  const head = cells(lines[0]).map((h) => h.toLowerCase());
  if (!REQUIRED.every((h) => head.includes(h))) return undefined;

  const rows: FloorWorking[] = [];
  for (const line of lines.slice(1)) {
    const row = cells(line);
    const get = (name: string) => row[head.indexOf(name)] ?? '';
    const num = (name: string) => Number(get(name)) || 0;
    const feePct = num('platform_fee_pct');
    const cost = num('unit_cost') + num('packaging') + num('seller_paid_shipping');
    const price = num('list_price');
    if (!get('sku') || !(cost > 0) || !(price > 0) || feePct >= 100) return undefined;
    const raw = cost / (1 - feePct / 100) + num('min_margin');
    rows.push({
      sku: get('sku'),
      name: get('name'),
      price,
      floor: Math.ceil(raw * 10 - 1e-9) / 10,
      stock: Math.max(0, Math.floor(num('stock'))),
      // Optional column: what buyers call it, separated by semicolons.
      facts: Object.fromEntries(FACT_COLUMNS.filter((t) => get(t)).map((t) => [t, get(t)])),
      aliases: get('also_called') ? get('also_called').split(/[;|]/).map((a) => a.trim()).filter(Boolean) : undefined,
      cost,
      feePct,
      minMargin: num('min_margin'),
    });
  }
  return rows.length ? rows : undefined;
}

/** The first uploaded document that is a usable cost sheet. */
export function floorsFromUploads(uploads: Workspace['uploads']): FloorWorking[] | undefined {
  for (const u of uploads) {
    const rows = floorsFromCostSheet(u.text);
    if (rows) return rows;
  }
  return undefined;
}

const rm = (n: number) => `RM${n.toFixed(2)}`;

export function floorNotes(rows: FloorWorking[]): string {
  return [
    'Floor = (cost + packaging + your shipping share) ÷ (1 − platform fee) + your minimum margin, rounded up to 10 sen. Calculated by StreamSense from your cost sheet.',
    '',
    '| Product | Costs | Platform fee | Minimum margin | Floor | List price |',
    '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.name} | ${rm(r.cost)} | ${r.feePct}% | ${rm(r.minMargin)} | **${rm(r.floor)}** | ${rm(r.price)} |`),
  ].join('\n');
}
