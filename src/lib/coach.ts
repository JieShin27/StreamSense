import type { CoachAlert, LiveState } from './types';
import { rm, safeDealPrice } from './priceGuard';
import { TOPIC_LABEL } from './replies';

type Draft = Omit<CoachAlert, 'id' | 'ts'> & { key: string };

const SLOW_AFTER_COMMENTS = 25;

/**
 * Deterministic nudges for the host. Rules, not a model call: cheap,
 * predictable, and each one fires once per live.
 */
export function coachRules(s: LiveState): Draft[] {
  const out: Draft[] = [];
  const buyerComments = s.comments.filter((c) => c.role === 'buyer').length;

  for (const p of s.products) {
    const lowAt = Math.max(5, Math.round(p.stockStart * 0.15));
    if (p.stock === 0) {
      out.push({ key: `sold_out:${p.sku}`, kind: 'sold_out', sku: p.sku, text: `${p.name} is SOLD OUT. Say it on camera and move to the next product.` });
    } else if (p.stock <= lowAt) {
      out.push({ key: `low:${p.sku}`, kind: 'low_stock', sku: p.sku, text: `Only ${p.stock} left of ${p.name} — announce it now!` });
    }

    const open = s.escalations.filter((e) => e.sku === p.sku && e.status === 'open' && e.topic !== 'discount');
    const byTopic = new Map<string, number>();
    for (const e of open) byTopic.set(e.topic, (byTopic.get(e.topic) ?? 0) + 1);
    for (const [topic, n] of byTopic) {
      if (n >= 2) {
        out.push({
          key: `repeat:${p.sku}:${topic}`,
          kind: 'repeat_question',
          sku: p.sku,
          text: `${n} buyers asked about ${TOPIC_LABEL[topic as keyof typeof TOPIC_LABEL]} for ${p.name}. Answer once below and I'll handle the rest.`,
        });
      }
    }
  }

  // At most one flash-deal idea per stretch of comments, for the slowest product.
  const round = Math.floor(buyerComments / SLOW_AFTER_COMMENTS);
  if (round >= 1) {
    const slowest = s.products
      .filter((p) => p.stock > 0 && p.stockStart > 0 && !(p.sku in s.deals))
      .map((p) => ({ p, sold: p.stockStart - p.stock }))
      .filter((x) => x.sold / x.p.stockStart < 0.15)
      .sort((a, b) => a.sold / a.p.stockStart - b.sold / b.p.stockStart)[0];
    if (slowest) {
      out.push({
        key: `slow:${round}`,
        kind: 'flash_deal',
        sku: slowest.p.sku,
        text: `${slowest.p.name} is moving slowly (${slowest.sold} of ${slowest.p.stockStart} reserved). Safe flash deal: ${rm(safeDealPrice(slowest.p.floor))} — still above your floor.`,
      });
    }
  }

  return out.filter((d) => !s.coachFired.includes(d.key));
}
