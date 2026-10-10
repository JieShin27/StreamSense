export type Label = 'auto_reply' | 'order' | 'escalate' | 'warn' | 'ignore';
export type Lang = 'ms' | 'en' | 'zh';
export type Topic =
  | 'price'
  | 'stock'
  | 'halal'
  | 'spicy'
  | 'expiry'
  | 'shipping'
  | 'ingredients'
  | 'size'
  | 'voucher'
  | 'discount'
  | 'other';

export const LABELS: Label[] = ['auto_reply', 'order', 'escalate', 'warn', 'ignore'];
export const TOPICS: Topic[] = [
  'price', 'stock', 'halal', 'spicy', 'expiry', 'shipping', 'ingredients', 'size', 'voucher', 'discount', 'other',
];

export interface Product {
  sku: string;
  name: string;
  aliases: string[];
  price: number;
  /** Lowest price that still covers cost, fees, postage and minimum margin. */
  floor: number;
  stock: number;
  stockStart: number;
  /** Seller-confirmed answers by topic. The only source auto-replies may quote. */
  facts: Partial<Record<Topic, string>>;
}

export interface Comment {
  id: string;
  role: 'buyer' | 'ai' | 'host';
  user: string;
  text: string;
  ts: string;
  label?: Label;
  lang?: Lang;
  sku?: string;
  topic?: Topic;
  handled: boolean;
  /** Set as soon as Triage hands the comment over, before the specialist has acted. */
  routedTo?: AgentName;
  replyTo?: string;
  /** Which agent produced this reply. */
  by?: AgentName;
  /** Reply drafted for the host to read out; not posted to the platform (read-only source). */
  draft?: boolean;
}

export interface Reservation {
  id: string;
  commentId: string;
  buyer: string;
  sku: string;
  qty: number;
  unitPrice: number;
  /** reserved = in the buyer's cart; paid = checked out; released = put back on the shelf. */
  status: 'reserved' | 'paid' | 'released';
  ts: string;
  paidAt?: string;
}

/** One thing the seller said on camera. */
export interface TranscriptLine {
  id: string;
  ts: string;
  text: string;
  /** Set when the agents caught something in it. */
  flag?: 'price' | 'claim';
}

/** Money off a whole cart, for buyers who claim it. Every voucher has passed the Price Guard. */
export interface Voucher {
  id: string;
  code: string;
  amountOff: number;
  minSpend: number;
  /** How many buyers may use it. */
  limit: number;
  claimedBy: string[];
  usedBy: string[];
  active: boolean;
  ts: string;
}

/** One checkout: what the cart came to and what the buyer actually paid. */
export interface Payment {
  id: string;
  buyer: string;
  total: number;
  discount: number;
  voucherId?: string;
  ts: string;
}

/** Private shop-to-buyer chat, separate from the public live comments. */
export interface Message {
  id: string;
  buyer: string;
  from: 'shop' | 'buyer';
  text: string;
  ts: string;
}

export type AgentName = 'Triage' | 'Order & Stock' | 'Support' | 'Price Guard' | 'Coach' | 'Grounding Gate' | 'Host Monitor' | 'WorkBuddy';

export interface AgentStep {
  agent: AgentName;
  summary: string;
  /** false renders as a block/veto, true as a pass, undefined as neutral. */
  ok?: boolean;
}

export interface Activity {
  id: string;
  ts: string;
  /** The buyer comment this was about, if any. */
  commentId?: string;
  user?: string;
  text?: string;
  steps: AgentStep[];
}

export interface CoachAlert {
  id: string;
  ts: string;
  kind: 'low_stock' | 'sold_out' | 'flash_deal' | 'repeat_question' | 'policy' | 'coach' | 'workbuddy' | 'monitor';
  /** Which agent raised it. */
  by?: AgentName;
  text: string;
  sku?: string;
}

export interface Escalation {
  id: string;
  commentId: string;
  user: string;
  text: string;
  sku?: string;
  topic: Topic;
  reason: string;
  hint?: string;
  /** Which agent passed it to the seller. */
  by?: AgentName;
  /** An answer drafted for her to approve or edit. */
  suggestion?: string;
  status: 'open' | 'answered';
  answer?: string;
  ts: string;
}

export interface BlockedDiscount {
  sku: string;
  attempted: number;
  floor: number;
  ts: string;
}

export interface TriageResult {
  id: string;
  label: Label;
  lang: Lang;
  sku?: string;
  qty?: number;
  topic?: Topic;
  offerPrice?: number;
  reason: string;
}

export interface FaqItem {
  question: string;
  asked_count: number;
  suggested_answer: string;
}

/** The seller's desk outside the live. Survives starting a new live. */
export interface Workspace {
  uploads: { id: string; name: string; text: string; ts: string }[];
  /** Answers she has confirmed in past lives, by product. Carried into every new live. */
  knownFacts?: Record<string, Partial<Record<Topic, string>>>;
  /** What the pre-live team handed in. */
  prep?: { script: string; cueCard: string; complianceLog?: string; floorNotes?: string; ts: string };
  /** What the post-live team handed in. */
  wrapup?: {
    summary: string;
    salesSheet: string;
    restockMessage: string;
    followups: { id: string; buyer: string; text: string; sent: boolean }[];
    nextFaq: FaqItem[];
    ts: string;
  };
  /** A WorkBuddy team at work, started from a button in the app. */
  run?: TeamRun;
  /** The last finished run of each kind. */
  lastRuns?: Partial<Record<TeamRun['kind'], TeamRun>>;
}

export interface TeamRun {
  kind: 'prepare' | 'wrapup';
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  endedAt?: string;
  /** What the team is doing, as it happens. */
  steps: { ts: string; who: string; text: string }[];
  /** When each role was working, for the timeline. */
  spans: { role: string; start: string; end?: string }[];
  error?: string;
}

export interface LiveState {
  /** setup: preparing, buyers see "starting soon". live: on air. ended: over, carts and chat stay open. */
  session: { id: string; status: 'setup' | 'live' | 'ended'; startedAt: string; endedAt?: string };
  products: Product[];
  spotlightSku: string;
  /** Active flash-deal price per SKU. Every entry has passed the Price Guard. */
  deals: Record<string, number>;
  comments: Comment[];
  reservations: Reservation[];
  activities: Activity[];
  alerts: CoachAlert[];
  escalations: Escalation[];
  blockedDiscounts: BlockedDiscount[];
  messages: Message[];
  vouchers: Voucher[];
  payments: Payment[];
  transcript: TranscriptLine[];
  workspace: Workspace;
  /** Coach rules that already fired, so each nudge appears once. */
  coachFired: string[];
  replay: { running: boolean; index: number; total: number };
  /** How the last batch was decided: tool-calling agents, or the keyword-rule safety net. */
  triageMode: 'agents' | 'rules';
  /** Set while every model is rate-limited; the rules cover until then. */
  agentsRestingUntil?: string;
  /** Set when comments come from a real platform. Read-only sources get draft replies. */
  source?: { name: string; readOnly: boolean; received: number };
}
