# StreamSense — Build Guide

How to run the app, how it is put together, how to deploy it, and what is verified.

## 1. Run it

```bash
npm install
cp .env.example .env.local     # fill in keys — see the comments in the file
npm run check:keys             # tests the keys without printing them
npm run dev                    # http://localhost:3000
```

| Page | Who | What |
|---|---|---|
| `/prepare` | Seller | Upload a cost sheet; load products and floor prices; let the team write the script and cue card |
| `/` | Seller | Live studio: camera, what she says, comments with the agents that handled each, what needs her, stock |
| `/wrapup` | Seller | Tonight's numbers, sales sheet, supplier message, follow-ups to approve, next live's FAQ |
| `/buyer` | Buyers | Watch the live, comment, cart and checkout, private chat with the shop |
| `/agents` | Projector | Team map with live status, each comment travelling through agent lanes |

Without keys it still starts: comments are handled by keyword rules and there is no video.

**Keys** (`.env.local`)
- `LLM_*` — any OpenAI-compatible endpoint with tool calling; set up for Groq's free tier. `LLM_MODEL` takes several models, comma-separated; when one hits its limit (about 8,000 tokens a minute, 1,000 requests a day each) the next takes over.
- `LIVEKIT_*` — LiveKit Cloud free plan, for video from seller to buyers.

**A step-by-step test of every function, on a different shop from the sample data:** [`test-kit/TEST_PLAN.md`](test-kit/TEST_PLAN.md).

## 2. What is real and what is simulated

| Part | Status |
|---|---|
| Live agents (Triage, Order & Stock, Support, Coach, Host Monitor) | Real tool-calling agents on a real model |
| Price Guard, Grounding Gate, stock, floor prices, profit | Plain code, deliberately not a model |
| Seller video and voice, buyers on their phones | Real |
| Before/after teams (Finance, Sales, Compliance; Reconciliation, Restock, Follow-up, Planner) | Real agent runs, started from a button on the seller's laptop |
| Payment | Simulated — checkout marks an order paid, no money moves |
| The marketplace | Simulated — our own live room standing in for a marketplace live |
| Sample comments, keyword rules | Fallback only, for rehearsal or when the model limit is hit |

## 3. Architecture

```
 buyer phones ──▶ POST /api/comments ──▶ queue (immediate when quiet, batched in a flood)
                                              │
        ┌──────────────── live agent team (src/lib/agents/team.ts) ────────────────┐
        │ Triage ── assign_comments ─┬─▶ Order & Stock  reserve_stock · cancel_reservation │
        │                            │                  check_buyer_offer · ask_host      │
        │                            └─▶ Support        answer_from_facts · flag_health_claim · ask_host
        │ Coach (background)             nudge_host · suggest_flash_deal                  │
        └───────────────────────────────┬──────────────────────────────────────────┘
 seller's voice ─▶ Host Monitor          │   warn_seller · remember_fact
 (src/lib/agents/monitor.ts)             ▼
        backstage.ts — the only code that changes the room: reserve, cancel,
        Price Guard, Grounding Gate, reply templates, alerts
                                         ▼
        in-memory room ──SSE /api/stream──▶ every open page

 /api/mcp — the same room as tools for an outside agent platform (section 5)
```

- **One live room, in memory, on one server process.** No database. A restart clears it.
- **Models decide meaning and action; code decides money, stock and facts.** Every sentence a buyer reads is a template filled with real numbers or a fact the seller confirmed.
- **Nothing is dropped.** Any comment the agents do not handle (model down, limit hit) goes through the keyword rules in `triage.ts`.

## 4. How the agents work

Each agent is a model call with its own instructions and tools, run by the loop in `agents/runtime.ts`: it gets the situation as data, picks tools, receives what really happened ("reserved 2 of 20 asked; 0 left", "rejected — lowest safe price RM19"), and decides again.

| Agent | Does | Cannot |
|---|---|---|
| Triage | Reads each comment, hands it to a specialist or drops chatter | Act on a comment |
| Order & Stock | Reserves into the buyer's cart, cancels, passes offers to Price Guard | Agree to a price; reserve more than exists; substitute a product |
| Support | Answers from confirmed facts and live numbers, flags health claims | State a fact the seller has not confirmed |
| Coach | Nudges the seller, proposes flash deals | Put a deal live; see her costs |
| Host Monitor | Checks what she says against prices, stock and facts; warns her on her own video; remembers new facts she states | Change anything buyers see |
| Price Guard *(code)* | Blocks any price below the floor, whoever proposes it | — |
| Grounding Gate *(code)* | Lets an answer through only if it is a live number or a confirmed fact | — |

Order & Stock and Support run at the same time; Coach and Host Monitor run in the background. More than 20 units in one comment goes to the seller instead of being reserved.

## 5. Before and after the live

**Without AI:** on `/prepare`, upload a cost sheet and press *Load products and floor prices only*. Floors are calculated in `src/lib/floors.ts`:
`(unit_cost + packaging + seller_paid_shipping) ÷ (1 − platform_fee_pct) + min_margin`, rounded up to 10 sen.

Cost sheet columns — required: `sku, name, unit_cost, list_price, stock`. Optional: `packaging, seller_paid_shipping, platform_fee_pct, min_margin, also_called` (what buyers call it, separated by `;`), and confirmed facts `halal, spicy, expiry, shipping, ingredients, size`.

**With the agent teams:** the *Prepare my live* and *Settle everything* buttons start an agent engine on the seller's laptop (`src/lib/workbuddy.ts`) with a goal, named roles and a connection back to `/api/mcp`. Progress shows on the page. Set it up once with `npm run workbuddy:login`. Floors and sales figures still come from code; the roles read and explain them.

**From WorkBuddy's own window:** add `/api/mcp` as a custom connection (`{ "mcpServers": { "streamsense": { "url": "http://localhost:3000/api/mcp" } } }`) and paste the prompt shown under each button.

| Tool | Effect |
|---|---|
| `get_uploaded_documents` | Her uploads as text, plus the FAQ from her previous live |
| `get_price_floors` | Floor per product, calculated by code |
| `save_prelive_pack` | Loads products; puts script, cue card and review on `/prepare` |
| `get_live_state` | Stock, carts, waiting questions, recent comments |
| `suggest_answer` · `propose_flash_deal` · `send_host_note` | Drafts for the seller; a deal is checked by Price Guard first |
| `get_session` | The whole live, with sales and profit already calculated |
| `save_wrapup` | Puts summary, sales sheet, supplier message, follow-up drafts and FAQ on `/wrapup` |

## 6. Deploy

The app needs **one always-on Node instance** that allows long-lived connections. Serverless hosting (Vercel, Netlify functions) will not work: the room lives in the server's memory.

**Render** (a `render.yaml` is included):
1. Push this repository to GitHub.
2. On render.com: **New → Blueprint**, pick the repository.
3. When asked, paste `LLM_API_KEY` and the three `LIVEKIT_*` values from your `.env.local`.
4. Open the URL it gives you. `/` is the seller, `/buyer` is the buyer.

Notes for a hosted copy:
- The free plan sleeps after about 15 minutes without visitors and takes a minute to wake; waking starts a fresh room.
- The agent-team buttons need the engine on the same machine, so they are for the laptop. *Load products and floor prices only* works anywhere.
- Camera and microphone need HTTPS, which the host provides.

**For a pitch**, running on the laptop with a tunnel to a public HTTPS address keeps everything working, including the team buttons.

## 7. What is verified

- 68 unit tests; production build clean.
- Thirty unscripted comments through the real model: 28 as expected, replies in about 1.6 s.
- The test-kit shop (coffee, honey, cookies, tea) through the real agents: orders, two products in one comment, cancel, lowball offer, bulk order, unknown product, health claim, missing facts, spoken below-floor price, fact learned from speech.
- Video from seller to a late-joining buyer, in a headless browser with a fake camera.
- Both agent-team buttons with real runs (Prepare about 8 minutes, Wrap-up about 2).

**Not verified:** sound and speech with a real voice in a noisy room; phones on another network; the hosted deployment.

## 8. Known limits

- Buyer identity is the name typed in; two buyers with the same name share a cart. Every browser receives the whole room.
- The seller page is not password-protected.
- Agents do not answer in the private chat; the seller is notified.
- Browser speech recognition handles one language at a time; the mixed mode is slower and less accurate.
- A burst of many comments can exhaust the free model limit; keyword rules cover until it recovers.

## 9. Working agreements

- Small commits, present-tense messages. `npm test && npm run build` before pushing.
- Never commit `.env.local`.
- Types change in `src/lib/types.ts` first.
