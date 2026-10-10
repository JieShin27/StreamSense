import { beforeEach, describe, expect, it } from 'vitest';
import { addToCart, buyerMessage, checkout, removeFromCart, shopMessage } from './buyer';
import { resetLive } from './pipeline';
import { exportSession } from './session';
import { hostSpeech, spokenPrices } from './speech';
import { getState } from './store';

beforeEach(() => {
  // Each test starts as a first-ever live: nothing uploaded, nothing remembered.
  getState().workspace = { uploads: [] };
  resetLive();
});
const sambal = () => getState().products.find((p) => p.sku === 'SAMBAL-200')!;

describe('spokenPrices', () => {
  it.each([
    ['ok la RM8 untuk awak', [8]],
    ['harga 8 ringgit je', [8]],
    ['lapan ringgit je hari ni', [8]],
    ['ringgit dua belas boleh', [12]],
    ['tiga puluh lima ringgit', [35]],
    ['twenty five ringgit only', [25]],
    ['RM 12.50 sahaja', [12.5]],
    ['saya ada dua anak', []],
    ['tinggal 5 jar lagi', []],
  ])('hears "%s"', (text, expected) => {
    expect(spokenPrices(text)).toEqual(expected);
  });
});

describe('host microphone', () => {
  it('warns when she says a price below her floor', () => {
    const res = hostSpeech('ok la sambal lapan ringgit untuk awak');
    expect(res.flagged).toBe(true);
    expect(getState().alerts.at(-1)!.text).toContain('RM8.00');
    expect(getState().alerts.at(-1)!.text).toContain('RM12.00');
    expect(getState().blockedDiscounts).toHaveLength(1);
    expect(getState().transcript.at(-1)).toMatchObject({ flag: 'price' });
  });

  it('stays quiet for a safe price and for ordinary talk', () => {
    expect(hostSpeech('sambal RM13 je hari ni').flagged).toBe(false);
    expect(hostSpeech('jom tengok kerepek pisang pulak').flagged).toBe(false);
    expect(getState().alerts).toHaveLength(0);
    expect(getState().transcript).toHaveLength(2);
  });

  it('uses the product on camera when she names none', () => {
    getState().spotlightSku = 'TART-50';
    hostSpeech('lima belas ringgit je');
    expect(getState().blockedDiscounts[0]).toMatchObject({ sku: 'TART-50', attempted: 15 });
  });

  it('warns when she makes a health claim herself', () => {
    expect(hostSpeech('sambal ni boleh turunkan darah tinggi tau').flagged).toBe(true);
    expect(getState().alerts.at(-1)!.kind).toBe('policy');
  });
});

describe('buyer cart and chat', () => {
  it('adds to cart, checks out, and reports paid versus unpaid', () => {
    expect(addToCart('aina', 'SAMBAL-200', 2)).toMatchObject({ ok: true, qty: 2 });
    addToCart('wei', 'SAMBAL-200', 1);
    expect(sambal().stock).toBe(117);

    expect(checkout('aina')).toMatchObject({ ok: true, total: 30 });
    expect(checkout('aina').ok).toBe(false);

    const out = exportSession(getState());
    expect(out.orders).toEqual([expect.objectContaining({ buyer: 'aina', qty: 2, paid_amount: 30 })]);
    expect(out.reservations.filter((r) => r.status === 'reserved').map((r) => r.buyer)).toEqual(['wei']);
  });

  it('never sells more than is left, and returns stock on remove', () => {
    sambal().stock = 1;
    expect(addToCart('aina', 'SAMBAL-200', 5)).toMatchObject({ ok: true, qty: 1 });
    expect(addToCart('wei', 'SAMBAL-200', 1)).toMatchObject({ ok: false });
    expect(removeFromCart('wei', getState().reservations[0].id).ok).toBe(false);
    expect(removeFromCart('aina', getState().reservations[0].id).ok).toBe(true);
    expect(sambal().stock).toBe(1);
  });

  it('keeps private chat per buyer', () => {
    shopMessage('aina', 'Stok dah masuk!');
    buyerMessage('aina', 'ok terima kasih');
    shopMessage('wei', 'hello');
    expect(getState().messages.filter((m) => m.buyer === 'aina').map((m) => m.from)).toEqual(['shop', 'buyer']);
  });
});
