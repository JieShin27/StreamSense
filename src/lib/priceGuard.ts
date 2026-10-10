export const rm = (n: number) => `RM${n.toFixed(2)}`;

export interface GuardVerdict {
  ok: boolean;
  floor: number;
  /** A rounded price the seller can safely announce instead. */
  safePrice: number;
}

/**
 * The money rule. Pure arithmetic on the seller's own floor price — the model
 * never gets a vote on whether a price is acceptable.
 */
export function checkPrice(price: number, floor: number): GuardVerdict {
  return { ok: price >= floor, floor, safePrice: safeDealPrice(floor) };
}

/** Nearest whole ringgit that leaves at least 50 sen above the floor. */
export function safeDealPrice(floor: number): number {
  return Math.ceil(floor + 0.5);
}
