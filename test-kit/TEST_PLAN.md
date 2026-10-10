# StreamSense test kit

A different shop from the built-in sample, to check that nothing depends on the sambal data.
**Shop:** Kedai Kopi Aisyah — coffee, honey, cookies and tea. File: `test-kit/cost_sheet.csv`.

Tick each box as you go. "Expect" is what should happen; if it does not, note what you saw.

**You need:** the app running, two browser windows side by side (seller on `/`, buyer on `/buyer`), and ideally a phone as a second buyer.
The top-right chip tells you what is deciding: `Agents working` = AI model, `Agents resting · rules covering` = the free model limit was hit (wait a minute).

---

## 0. Start clean

- [ ] On the Live page open **Buyer link & tools → Reset live**.
- [ ] Open `/prepare`. Remove any uploaded file.

## 1. Prepare

- [ ] **Upload** `test-kit/cost_sheet.csv`. Expect: listed with 5 lines.
- [ ] Click **Load products and floor prices only**. Expect: "Loaded 4 products…".
- [ ] Go to the Live page, open each product in **Stock**. Expect these floors exactly:

| Product | List price | Floor | Stock |
|---|---|---|---|
| Kopi O Kampung 250g | RM18.00 | **RM13.20** | 60 |
| Madu Kelulut 200ml | RM35.00 | **RM25.60** | 25 |
| Cookies Coklat Chip 300g | RM15.00 | **RM12.00** | 45 |
| Teh Tarik 3-in-1 (20 sachet) | RM13.00 | **RM10.10** | 90 |

- [ ] *(Laptop with the agent engine signed in only.)* Click **Prepare my live**. Expect: a progress box with Finance, Sales and Compliance; after several minutes a script, cue card and review appear. The review should reject the honey and coffee health claims planted in the notes ("boleh ubat batuk", "boleh kurus"). Floors stay as in the table.
- [ ] Open **Cue card → Print cue card**. Expect: a clean printable page.

## 2. Going live

- [ ] Buyer page before going live. Expect: "The live starts soon", comment box disabled.
- [ ] Seller: **Go live**, allow camera and microphone. Expect: LIVE clock, your camera, "1 watching" once the buyer page is open.
- [ ] Buyer page. Expect: your video within a few seconds; tap **Tap for sound** to hear it.
- [ ] Open the buyer page on a phone **after** going live. Expect: video still appears.

## 3. Buyer comments → agents

Type each as a buyer. Use a different name per buyer where shown (the "You" box).

| # | Buyer | Type this | Expect |
|---|---|---|---|
| 3.1 | lina | `nak 2 kopi` | Reserved 2 × Kopi; stock 60 → 58; reply from **Order & Stock**; item in lina's cart |
| 3.2 | wei | `蜂蜜多少钱?` | Reply in Chinese with RM35.00, from **Support** |
| 3.3 | sam | `how long can the cookies keep?` | "1 month" from the confirmed fact |
| 3.4 | sam | `what's in the cookies? any nuts?` | No confirmed fact → **Grounding Gate** blocks → card in **Needs you** |
| 3.5 | nora | `teh tarik ni halal ke?` | Card in **Needs you** (halal column is empty on purpose) |
| 3.6 | amir | `madu ni halal tak` | A second halal card, for honey |
| 3.7 | lina | `tambah 1 madu and 2 teh` | Two reservations from one comment: 1 honey, 2 tea |
| 3.8 | lina | `cancel la teh tu` | Tea removed from lina's cart; tea stock back to 90 |
| 3.9 | boon | `kopi RM10 boleh?` | Declined automatically — **Price Guard** ✕ (below RM13.20); you are not asked |
| 3.10 | boon | `ok kopi RM15 boleh? ambil 3` | Card in **Needs you**: above floor, your call |
| 3.11 | tina | `madu ni boleh ubat batuk kan?` | Nothing sent to the buyer; red warning for you: do not confirm |
| 3.12 | joe | `nak 2 kek batik` | Not something you sell → card in **Needs you**; nothing reserved |
| 3.13 | farah | `nak 40 cookies untuk kenduri` | Bulk order → card in **Needs you**; stock unchanged |
| 3.14 | zul | `wah sedapnyaa 😍` | Tagged ignore; no reply |
| 3.15 | wei | `我要一瓶蜂蜜` | Reserved 1 × Madu, reply in Chinese |
| 3.16 | kumar | `do you ship to Sabah? how long` | Shipping fact for the product on camera, or a card if none |

- [ ] Each comment shows a one-line trail (Triage › specialist › guard) and the reply names the agent.

## 4. The seller answers once

- [ ] In **Needs you**, answer nora's halal question: `Ya, bahan semua halal`. Expect: nora gets the reply.
- [ ] As a new buyer type `teh tarik halal?`. Expect: answered automatically, no new card.
- [ ] Amir's honey halal card should still be open (different product).

## 5. Cart and checkout (buyer page)

- [ ] As lina open **Cart**. Expect: 2 kopi + 1 madu, correct total (RM71.00).
- [ ] **Remove** the madu. Expect: honey stock goes back up by 1 on the seller page.
- [ ] **Checkout**. Expect: "Paid RM36.00", items move to Paid orders; seller header "paid" increases.
- [ ] On **Live** tab tap **Add to cart** on Cookies. Expect: cart badge shows 1; cookie stock drops by 1.
- [ ] Seller: **Carts & orders → Release** an unpaid item. Expect: stock returns; it leaves that buyer's cart.

## 6. Prices and stock (seller)

- [ ] Stock → Kopi → flash deal `12` → **Check price**. Expect: **Blocked. Your floor is RM13.20. Safe deal: RM14.00.**
- [ ] Flash deal `14`. Expect: approved, announced in the feed, buyer page shows RM14.00.
- [ ] Buyer: `nak 1 kopi`. Expect: reserved at RM14.00.
- [ ] Stock → Madu → **Put on camera**. Expect: buyer page shows "Now showing: Madu Kelulut".
- [ ] Buyer: `nak 2`. Expect: 2 honey reserved (the product on camera).
- [ ] Get honey down to 5 or fewer (several buyers ordering). Expect: "Only N left — announce it now!" in Needs you.
- [ ] Take the last honey. Expect: SOLD OUT alert; next buyer is told it is sold out; buyer page shows "sold out".

## 6b. Vouchers

Open **Vouchers** under Stock on the Live page (you must be live).

- [ ] Offer `10` off, min spend `20`, 5 buyers. Expect: **Blocked** — a cart could fall below your floors, with the largest safe amount shown.
- [ ] Offer `3` off, min spend `30`, 2 buyers. Expect: approved; announced in the feed; a voucher bar with **Claim** appears in the buyer room.
- [ ] Buyer asks `ada voucher tak?`. Expect: Support replies with the voucher.
- [ ] Buyer A: tap **Claim**, put RM30 or more in the cart. Expect: Cart shows "Voucher − RM3.00" and the reduced total; checkout says the voucher saved RM3.00.
- [ ] Buyer B: claim, but keep the cart under RM30. Expect: "Add RM… more to use your voucher"; checkout charges full price.
- [ ] After two buyers have used it. Expect: the voucher bar disappears; a third buyer cannot claim.
- [ ] Seller says or types `ada voucher RM10 untuk semua`. Expect: Host Monitor warns that no such voucher exists.
- [ ] Wrap-up → Tonight at a glance. Expect: profit mentions the voucher cost.

## 7. What the seller says

Use the microphone (language set to what you speak), or the **Type what you say** box.

| # | Say or type | Expect |
|---|---|---|
| 7.1 | `ok kopi ni sepuluh ringgit je untuk awak` | Red banner on your video: below floor RM13.20, say RM14.00 — from **Price Guard** |
| 7.2 | `cookies tinggal 2 je, cepat` | Banner from **Host Monitor**: wrong stock |
| 7.3 | `teh tarik hari ni RM11` | Banner: wrong price (listed RM13.00) |
| 7.4 | `kalau tak sedap saya pulangkan duit` | Banner: risky promise |
| 7.5 | `madu ni elok untuk orang kencing manis` | Banner: health claim |
| 7.6 | `cookies ni tak ada kacang, selamat untuk alergi kacang` | Fact remembered for cookies → sam's ingredients card is answered |
| 7.7 | `jom kita tengok teh tarik pulak` | Nothing happens (ordinary talk) |

## 8. Private chat

- [ ] Buyer **Chat** tab: send `boleh hold sampai esok?`. Expect: a note appears for the seller in Needs you.

## 9. Ending and wrap-up

- [ ] Leave at least one buyer with unpaid items in their cart.
- [ ] Seller: **End live** → confirm. Expect: moved to Wrap-up; buyer page says "The live has ended", cart still works.
- [ ] Wrap-up **Tonight at a glance**. Expect: paid total, in-carts total and profit that match what you did.
- [ ] *(Laptop with the agent engine only.)* **Settle everything**. Expect: progress for Reconciliation, then Restock, Follow-up and Planner; then a sales sheet, supplier message, follow-up drafts and next FAQ.
- [ ] **Send N messages to buyers' chat**. Expect: the buyer with unpaid items sees a message in their Chat tab with an unread badge. Nothing was sent before you pressed it.

## 9b. She only answers once, across lives

- [ ] During a live, answer a halal question (step 4) and state a fact out loud (step 7.6).
- [ ] End the live, then on Prepare press **Load products and floor prices only** to start a new live, and go live.
- [ ] As a buyer ask the same halal question and `any nuts in the cookies?`. Expect: both answered automatically, no card for the seller.

## 10. Tools and edge cases

- [ ] **Export session.json**. Expect: a file with `orders`, `reservations`, `unanswered`, `sales_summary`.
- [ ] **Play sample comments** (uses the built-in sambal catalog names — reset to the sample first, or expect "not something you sell" cards).
- [ ] Send 10 comments within a few seconds. Expect: all get handled; the chip may switch to "rules covering" and back.
- [ ] Refresh the seller page mid-live. Expect: everything is still there; press **Start camera** to resume video.
- [ ] Open `/agents`. Expect: the team map with counters, and each comment in lanes.
- [ ] Two buyers using the same name share one cart — known limitation.
- [ ] Restarting the server clears the room — known limitation.
