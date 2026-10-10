import { floorsFromUploads } from '@/lib/floors';
import { hostNote, suggestAnswer, suggestDeal } from '@/lib/pipeline';
import { rm } from '@/lib/priceGuard';
import { exportSession } from '@/lib/session';
import { getState } from '@/lib/store';
import { savePrelivePack, saveWrapup } from '@/lib/workspace';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Model Context Protocol endpoint (Streamable HTTP, stateless, JSON responses).
// This is how WorkBuddy's agents operate the live room directly instead of
// passing files: add this URL as a custom MCP server in WorkBuddy.

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => unknown;
}

const noArgs = { type: 'object', properties: {}, additionalProperties: false };

const productRows = {
  type: 'array',
  items: {
    type: 'object',
    required: ['sku', 'name', 'price', 'floor', 'stock'],
    properties: { sku: { type: 'string' }, name: { type: 'string' }, price: { type: 'number' }, floor: { type: 'number' }, stock: { type: 'integer' } },
  },
};

const TOOLS: McpTool[] = [
  {
    name: 'get_uploaded_documents',
    description: "Everything the seller uploaded on her Prepare page (cost sheet, product notes) as text, plus the FAQ carried over from her previous live. Read this first when preparing a live or settling one.",
    inputSchema: noArgs,
    run: () => {
      const w = getState().workspace;
      return {
        documents: w.uploads.map((u) => ({ name: u.name, uploaded_at: u.ts, text: u.text })),
        faq_from_previous_live: w.wrapup?.nextFaq ?? [],
      };
    },
  },
  {
    name: 'get_price_floors',
    description: "The seller's floor price per product, calculated from her cost sheet: (unit cost + packaging + seller-paid shipping) / (1 - platform fee) + minimum margin, rounded up to 10 sen. These are the authoritative numbers. Never calculate or change a floor yourself; quote these.",
    inputSchema: noArgs,
    run: () => {
      const rows = floorsFromUploads(getState().workspace.uploads);
      if (!rows) return { available: false, reason: 'No cost sheet with columns sku, name, unit_cost, list_price and stock has been uploaded.' };
      return {
        available: true,
        products: rows.map((r) => ({
          sku: r.sku, name: r.name, list_price: r.price, floor: r.floor, stock: r.stock,
          room_to_discount: Math.round((r.price - r.floor) * 100) / 100,
          working: `(${r.cost.toFixed(2)}) / (1 - ${r.feePct}%) + ${r.minMargin.toFixed(2)}`,
        })),
      };
    },
  },
  {
    name: 'save_prelive_pack',
    description: 'Hand in the pre-live work. Loads the products into the live room (starting a clean live) and shows the script, cue card and compliance log on the seller\'s Prepare page. Documents are Markdown. Floor prices are taken from her cost sheet by the app; the floors you pass are only used when no cost sheet exists.',
    inputSchema: {
      type: 'object',
      required: ['products', 'script_markdown', 'cue_card_markdown'],
      properties: {
        products: productRows,
        script_markdown: { type: 'string', description: 'Run-of-show for the live.' },
        cue_card_markdown: { type: 'string', description: 'One page she can print: per product, list price and the lowest price she may say.' },
        compliance_log_markdown: { type: 'string', description: 'Each rejected line, why, and its replacement.' },
        floor_notes_markdown: { type: 'string', description: 'How each floor was calculated.' },
      },
    },
    run: (args) => savePrelivePack(args),
  },
  {
    name: 'save_wrapup',
    description: 'Hand in the post-live work for the seller\'s Wrap-up page. Follow-ups are drafts: nothing reaches a buyer until she approves.',
    inputSchema: {
      type: 'object',
      required: ['summary', 'sales_sheet_markdown'],
      properties: {
        summary: { type: 'string', description: 'Short Markdown: what she earned after fees, what to reorder, who to message.' },
        sales_sheet_markdown: { type: 'string', description: 'Markdown table per product: units paid, revenue, fees, profit, stock left, units left unpaid.' },
        restock_message: { type: 'string', description: 'Plain-text message to her supplier.' },
        followups: {
          type: 'array',
          items: { type: 'object', required: ['buyer', 'text'], properties: { buyer: { type: 'string', description: 'Buyer name exactly as in the session.' }, text: { type: 'string' } } },
        },
        next_live_faq: {
          type: 'array',
          items: { type: 'object', required: ['question'], properties: { question: { type: 'string' }, asked_count: { type: 'integer' }, suggested_answer: { type: 'string' } } },
        },
      },
    },
    run: (args) => saveWrapup(args),
  },
  {
    name: 'get_live_state',
    description: 'Current state of the live: products with price, stock and reservations, questions waiting for the host, and recent buyer comments.',
    inputSchema: noArgs,
    run: () => {
      const s = getState();
      return {
        session_id: s.session.id,
        comment_source: s.source?.name ?? 'app',
        on_camera_sku: s.spotlightSku,
        products: s.products.map((p) => ({
          sku: p.sku, name: p.name, list_price: p.price, deal_price: s.deals[p.sku] ?? null,
          stock: p.stock, stock_at_start: p.stockStart,
          reserved_units: s.reservations.filter((r) => r.sku === p.sku && r.status === 'reserved').reduce((n, r) => n + r.qty, 0),
        })),
        waiting_for_host: s.escalations.filter((e) => e.status === 'open').map((e) => ({ user: e.user, text: e.text, sku: e.sku, topic: e.topic })),
        recent_comments: s.comments.filter((c) => c.role === 'buyer').slice(-30).map((c) => ({ user: c.user, text: c.text, label: c.label })),
      };
    },
  },
  {
    name: 'propose_flash_deal',
    description: 'Propose a flash-deal price for a product during the live. The Price Guard checks it: a price below her floor is rejected and you are told the lowest safe price; a safe price is shown to the seller as a suggestion for her to apply.',
    inputSchema: {
      type: 'object',
      required: ['sku', 'price'],
      properties: { sku: { type: 'string' }, price: { type: 'number' }, why: { type: 'string', description: 'One short sentence she can read at a glance.' } },
    },
    run: (args) => {
      const res = suggestDeal(String(args.sku), Number(args.price), String(args.why ?? '').slice(0, 140));
      return 'blocked' in res && res.blocked
        ? { accepted: false, reason: 'Rejected by the Price Guard: below her floor price', lowest_safe_price: res.safePrice }
        : res.ok
          ? { accepted: true, shown_to_seller: true, price: res.price }
          : { accepted: false, reason: res.error };
    },
  },
  {
    name: 'suggest_answer',
    description: 'Draft an answer for a buyer who is waiting on the seller (see waiting_for_host). She sees the draft on her screen and approves or edits it; nothing is sent to the buyer by this tool.',
    inputSchema: {
      type: 'object',
      required: ['buyer', 'answer'],
      properties: { buyer: { type: 'string', description: 'Buyer name exactly as in waiting_for_host.' }, answer: { type: 'string', description: 'One or two sentences in the buyer\'s language.' } },
    },
    run: (args) => suggestAnswer(String(args.buyer ?? ''), String(args.answer ?? '')),
  },
  {
    name: 'send_host_note',
    description: 'Show the seller a short note on her backstage screen during the live.',
    inputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    run: (args) => {
      const text = String(args.text ?? '').trim().slice(0, 240);
      if (!text) return { shown: false, reason: 'empty note' };
      hostNote(text);
      return { shown: true };
    },
  },
  {
    name: 'get_session',
    description: 'Full record of the live for the wrap-up: products, reservations, paid orders, every buyer comment with its label, unanswered questions, blocked discounts and answers the host gave. "sales_summary" holds the revenue, fees, cost and profit already calculated per product; report those figures and never recalculate them.',
    inputSchema: noArgs,
    run: () => exportSession(getState()),
  },
];

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function handle(m: RpcMessage): Record<string, unknown> | null {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: m.id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: m.id ?? null, error: { code, message } });

  // Notifications carry no id and get no response.
  if (m.id === undefined || m.id === null) return null;

  switch (m.method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'streamsense', version: '0.1.0' },
        instructions: 'Tools for a live seller. Before the live: get_uploaded_documents and get_price_floors, then save_prelive_pack. During: get_live_state, suggest_answer, propose_flash_deal, send_host_note. After: get_session, then save_wrapup.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === m.params?.name);
      if (!tool) return fail(-32602, `Unknown tool: ${String(m.params?.name)}`);
      try {
        const out = tool.run((m.params?.arguments as Record<string, unknown>) ?? {});
        return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: false });
      } catch (err) {
        return reply({ content: [{ type: 'text', text: (err as Error).message }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${m.method}`);
  }
}

export async function POST(req: Request) {
  const token = process.env.MCP_TOKEN;
  if (token && req.headers.get('authorization') !== `Bearer ${token}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  const body = await req.json().catch(() => undefined);
  if (body === undefined) {
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400 });
  }
  const out = Array.isArray(body)
    ? (body as RpcMessage[]).map(handle).filter((x) => x !== null)
    : handle(body as RpcMessage);
  if (out === null || (Array.isArray(out) && out.length === 0)) return new Response(null, { status: 202 });
  return Response.json(out);
}

/** No server-initiated stream is offered. */
export function GET() {
  return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
}
