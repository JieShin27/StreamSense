import type { Product, Topic } from './types';
import floors from '../../data/price_floors.json';
import script from '../../data/comments_script.json';

/** What buyers call each product, and what the seller has confirmed about it. */
const CATALOG: Record<string, Pick<Product, 'aliases' | 'facts'>> = {
  'SAMBAL-200': {
    aliases: ['sambal bilis', 'sambal', 'bilis', '参巴', '叁巴'],
    facts: {
      spicy: 'Pedas sederhana / medium spicy / 中辣',
      expiry: 'Tahan 3 bulan sebelum dibuka / 3 months unopened / 未开封可放3个月',
      shipping: 'Pos seluruh Malaysia; Sabah & Sarawak ikut kadar Shopee semasa checkout.',
      size: '200g satu jar / 200g per jar',
    },
  },
  'KEREPEK-250': {
    aliases: ['kerepek pisang', 'kerepek', 'pisang', 'banana chips', 'chips', '香蕉片', '香蕉'],
    facts: {
      spicy: 'Pedas manis / sweet-spicy / 甜辣',
      expiry: 'Tahan 2 bulan / 2 months / 可放2个月',
      size: '250g satu paket / 250g per pack',
    },
  },
  'SERUNDING-150': {
    aliases: ['serunding daging', 'serunding', 'meat floss', 'floss', '肉松'],
    facts: {
      expiry: 'Tahan 1 bulan, simpan dalam peti sejuk selepas buka / 1 month, refrigerate after opening',
      size: '150g',
    },
  },
  'TART-50': {
    aliases: ['tart nenas', 'tart', 'nenas', 'pineapple tart', '黄梨挞', '黄梨', '凤梨'],
    facts: {
      expiry: 'Tahan 3 minggu / 3 weeks / 可放3个星期',
      size: '50 biji satu balang / 50 pieces per jar',
    },
  },
};

export interface FloorRow {
  sku: string;
  name: string;
  price: number;
  floor: number;
  stock: number;
  /** Other names buyers use for it. */
  aliases?: string[];
  /** Answers the seller has confirmed, by topic. */
  facts?: Partial<Record<Topic, string>>;
}

const SMALL_WORDS = new Set(['dan', 'and', 'the', 'with', 'untuk', 'pack', 'pcs', 'biji', 'gram']);

/** Without a list from the seller, buyers are assumed to use the name or any distinctive word in it. */
function aliasesFromName(name: string): string[] {
  const lower = name.toLowerCase();
  const words = lower.replace(/[^a-z\u4e00-\u9fff\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !SMALL_WORDS.has(w));
  return [...new Set([lower, ...words])];
}

/** Build the live catalog from a price_floors.json payload (the WorkBuddy pre-live output). */
export function productsFromFloors(rows: FloorRow[]): Product[] {
  return rows.map((r) => {
    const known = CATALOG[r.sku];
    return {
      sku: r.sku,
      name: r.name,
      aliases: r.aliases?.length ? [...new Set([r.name.toLowerCase(), ...r.aliases.map((a) => a.toLowerCase())])] : (known?.aliases ?? aliasesFromName(r.name)),
      price: r.price,
      floor: r.floor,
      stock: r.stock,
      stockStart: r.stock,
      facts: { ...(known?.facts ?? {}), ...(r.facts ?? {}) },
    };
  });
}

export function seedProducts(): Product[] {
  return productsFromFloors(floors.products);
}

export const REPLAY_SCRIPT: { user: string; text: string }[] = script;
