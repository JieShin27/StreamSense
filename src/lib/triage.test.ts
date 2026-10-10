import { describe, expect, it } from 'vitest';
import { seedProducts } from './seed';
import { rulesTriage } from './triage';

const products = seedProducts();
const t = (text: string) => rulesTriage({ id: 'x', text }, products, 'SAMBAL-200');

describe('rulesTriage', () => {
  it.each([
    ['nak 3 jar sambal!', 3, 'SAMBAL-200', 'ms'],
    ['我要 2 罐 sambal', 2, 'SAMBAL-200', 'zh'],
    ['can I get 4 jar sambal', 4, 'SAMBAL-200', 'en'],
    ['want 1 serunding', 1, 'SERUNDING-150', 'en'],
    ['nak 5 kerepek', 5, 'KEREPEK-250', 'ms'],
    ['nak satu', 1, 'SAMBAL-200', 'ms'],
    ['+2', 2, 'SAMBAL-200', 'en'],
  ])('reads "%s" as an order', (text, qty, sku, lang) => {
    expect(t(text)).toMatchObject({ label: 'order', qty, sku, lang });
  });

  it.each([
    ['sambal 多少钱?', 'price'],
    ['kerepek pisang berapa harga?', 'price'],
    ['ada stok lagi tak sambal?', 'stock'],
    ['tart nenas 还有货吗', 'stock'],
    ['Is the sambal very spicy?', 'spicy'],
    ['sambal tahan berapa lama?', 'expiry'],
    ['postage to Sabah how much?', 'shipping'],
    ['sambal ni halal ke?', 'halal'],
    ['kerepek saiz berapa gram?', 'size'],
  ])('reads "%s" as a question about %s', (text, topic) => {
    expect(t(text)).toMatchObject({ label: 'auto_reply', topic });
  });

  it('sends a price offer to the host with the offered amount', () => {
    expect(t('sambal RM8 boleh?')).toMatchObject({ label: 'escalate', topic: 'discount', offerPrice: 8 });
  });

  it.each(['sambal ni boleh turunkan darah tinggi kan?', 'serunding ni boleh ubat kencing manis ke'])(
    'flags the health claim in "%s"',
    (text) => expect(t(text).label).toBe('warn'),
  );

  it.each(['Hi kak Ina! baru masuk', 'hahaha lawa tudung akak', '😍😍😍', 'akak cantik hari ni', 'nak tanya sikit'])(
    'stays silent on "%s"',
    (text) => expect(t(text).label).toBe('ignore'),
  );

  it('does not substitute the product on camera for something we do not sell', () => {
    expect(t('nak rendang 2 bungkus')).toMatchObject({ label: 'escalate' });
    expect(t('nak 2 jar je kak')).toMatchObject({ label: 'order', sku: 'SAMBAL-200' });
  });

  it('uses the product on camera when none is named', () => {
    expect(rulesTriage({ id: 'x', text: 'nak 2' }, products, 'TART-50').sku).toBe('TART-50');
  });
});
