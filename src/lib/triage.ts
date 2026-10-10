import type { Comment, Lang, Product, Topic, TriageResult } from './types';

type Input = Pick<Comment, 'id' | 'text'>;

// ---------------------------------------------------------------------------
// Keyword rules. The safety net: used when no model is configured, when the
// model is slow or down, and for any comment the agents left untouched.
// ---------------------------------------------------------------------------

const NUM_WORDS: Record<string, number> = {
  satu: 1, one: 1, sebiji: 1, sebotol: 1, 一: 1,
  dua: 2, two: 2, 两: 2, 二: 2,
  tiga: 3, three: 3, 三: 3,
  empat: 4, four: 4, 四: 4,
  lima: 5, five: 5, 五: 5,
};

const MALAY_HINT = /\b(nak|mahu|ada|tak|ke|berapa|harga|boleh|stok|lagi|akak|kak|ni|saya|beli|untuk|tahan|lama|pedas|hantar|apa|buat|dah)\b/i;
const CJK = /[一-鿿]/;

export const RISK = /(darah tinggi|kencing manis|diabetes|\bcure\b|sembuh|\bubat|\bkurus|slimming|kanser|cancer|降血压|治病|治疗|减肥|糖尿)/i;
const INTENT = /(\bnak\b|\bmahu\b|\bmau\b|\bwant\b|\bwan\b|\border\b|\bbeli\b|\bbuy\b|\bbook\b|\bambil\b|\bamik\b|\btake\b|\bget\b|我要|要|买|來|来)/i;
const UNIT = /(jar|botol|bottle|pcs|pc|helai|unit|pack|paket|bungkus|balang|biji|罐|瓶|个|個|包|件)/i;
const THIS_ONE = /(\bni\b|\bthis\b|这个|這個)/i;
const OFFER = /rm\s*(\d+(?:\.\d{1,2})?)/i;
const HAGGLE = /(\bkurang\b|diskaun|discount|murah sikit|cheaper|便宜|\bless\b|\bnego)/i;

// Order matters: "tahan berapa lama" is expiry, not price.
const TOPIC_RULES: [Topic, RegExp][] = [
  ['expiry', /(\btahan\b|expire|expiry|luput|shelf life|berapa lama|保质|过期|放多久)/i],
  ['shipping', /(\bpos\b|postage|\bship|\bcod\b|delivery|\bhantar\b|运费|邮费|寄)/i],
  ['halal', /(halal|清真)/i],
  ['spicy', /(pedas|spicy|辣)/i],
  ['ingredients', /(\bbahan\b|ingredient|contain|kandungan|成分|材料)/i],
  ['size', /(\bsaiz\b|\bsize\b|\bgram\b|\bberat\b|尺寸|多大|几克)/i],
  ['voucher', /(voucher|baucar|kupon|coupon|promo code|优惠券|折扣券)/i],
  ['stock', /(\bstok\b|\bstock\b|ada lagi|still have|available|\bhabis\b|还有|有货|有吗)/i],
  ['price', /(\bberapa\b|\bharga\b|how much|\bprice\b|多少钱|几钱|幾錢|价钱|价格)/i],
];

export function detectLang(text: string): Lang {
  if (CJK.test(text)) return 'zh';
  if (MALAY_HINT.test(text)) return 'ms';
  return 'en';
}

export function matchProduct(text: string, products: Product[]): Product | undefined {
  const t = text.toLowerCase();
  let best: { p: Product; len: number } | undefined;
  for (const p of products) {
    for (const a of p.aliases) {
      if (t.includes(a.toLowerCase()) && (!best || a.length > best.len)) best = { p, len: a.length };
    }
  }
  return best?.p;
}

function extractQty(text: string): number | undefined {
  const digits = text.match(/(\d{1,3})/);
  if (digits) return Number(digits[1]);
  const lower = text.toLowerCase();
  for (const [word, n] of Object.entries(NUM_WORDS)) {
    if (CJK.test(word) ? lower.includes(word) : new RegExp(`\\b${word}\\b`).test(lower)) return n;
  }
  return undefined;
}

// Words that say nothing about which product is meant.
const FILLER = new Set(`nak nk mahu mau want wan order beli buy book ambil ambik amik take get can tambah add more
satu dua tiga empat lima one two three four five a an the i me my saya sy aku kak akak sis bro bos boss bang abang kakak
ye ya la lah je saja aje pls please tolong boleh ok okay eh untuk for this that ni tu itu ini dulu lagi juga jugak also too
jar botol bottle pcs pc helai unit pack paket bungkus balang biji tq thanks terima kasih hi hello last call ke`.split(/\s+/));

/** True when the buyer names something specific that matches nothing we sell. */
function namesUnknownProduct(text: string): boolean {
  const words = text.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !FILLER.has(w));
  return words.length > 0;
}

export function rulesTriage(c: Input, products: Product[], spotlightSku: string): TriageResult {
  const text = c.text.trim();
  const lang = detectLang(text);
  const named = matchProduct(text, products);
  const sku = named?.sku ?? spotlightSku;
  const base = { id: c.id, lang, sku };

  if (RISK.test(text)) {
    return { ...base, label: 'warn', reason: 'health claim — do not confirm on camera' };
  }

  const offer = text.match(OFFER);
  if (offer) {
    return { ...base, label: 'escalate', topic: 'discount', offerPrice: Number(offer[1]), reason: `buyer offers RM${offer[1]}` };
  }
  if (HAGGLE.test(text)) {
    return { ...base, label: 'escalate', topic: 'discount', reason: 'asks for a discount' };
  }

  const isQuestion = /[?？]|\b(ke|tak|kah)\b\s*$|吗|嗎/i.test(text);
  const qty = extractQty(text);
  const wantsToBuy =
    /^\s*\+\s*\d+/.test(text) ||
    (INTENT.test(text) && (qty !== undefined || THIS_ONE.test(text))) ||
    (qty !== undefined && UNIT.test(text) && !isQuestion);
  // "saiz berapa gram?" has a unit word but is a question, not an order.
  if (wantsToBuy && !/(\bsaiz\b|\bsize\b|\bgram\b)/i.test(text)) {
    if (!named && namesUnknownProduct(text)) {
      return { id: c.id, lang, label: 'escalate', topic: 'other', reason: 'asks for something not in tonight’s products' };
    }
    return { ...base, label: 'order', qty: Math.max(1, Math.min(qty ?? 1, 99)), reason: 'buying intent' };
  }

  for (const [topic, re] of TOPIC_RULES) {
    if (re.test(text)) return { ...base, label: 'auto_reply', topic, reason: `asks about ${topic}` };
  }

  if (isQuestion && named) {
    return { ...base, label: 'escalate', topic: 'other', reason: 'product question with no known answer' };
  }
  return { id: c.id, lang, label: 'ignore', reason: 'chatter' };
}
