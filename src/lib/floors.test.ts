import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { floorsFromCostSheet } from './floors';
import { resetLive } from './pipeline';
import { getState } from './store';
import { addUpload, savePrelivePack } from './workspace';

const sheet = readFileSync('data/cost_sheet.csv', 'utf8');

describe('floor prices from the cost sheet', () => {
  it('computes the sample sheet, including notes with commas in quotes', () => {
    const rows = floorsFromCostSheet(sheet)!;
    expect(rows.map((r) => [r.sku, r.floor])).toEqual([
      ['SAMBAL-200', 11.5],
      ['KEREPEK-250', 6.8],
      ['SERUNDING-150', 17.9],
      ['TART-50', 22.4],
    ]);
    expect(rows[0]).toMatchObject({ name: 'Sambal Bilis Kak Ina 200g', price: 15, stock: 120 });
  });

  it('refuses a file that is not a cost sheet', () => {
    expect(floorsFromCostSheet('hello\nworld')).toBeUndefined();
    expect(floorsFromCostSheet('sku,name,unit_cost,list_price,stock\nA,Thing,0,10,5')).toBeUndefined();
  });
});

describe('pre-live pack', () => {
  beforeEach(() => {
    getState().workspace = { uploads: [] };
    resetLive();
  });

  it('ignores floor prices written by an agent when the cost sheet can be computed', () => {
    addUpload('cost_sheet.csv', sheet);
    const res = savePrelivePack({
      // What a model actually handed in during a real run: fee division forgotten.
      products: [{ sku: 'SAMBAL-200', name: 'Sambal Bilis Kak Ina 200g', price: 15, floor: 10.3, stock: 120 }],
      script_markdown: '# Script',
      cue_card_markdown: '# Cue',
    });
    expect(res).toMatchObject({ ok: true, products_loaded: 4, floors_from: 'cost sheet' });
    expect(getState().products.map((p) => p.floor)).toEqual([11.5, 6.8, 17.9, 22.4]);
    expect(getState().workspace.prep?.floorNotes).toContain('RM11.50');
  });

  it("falls back to the agent's products when there is no cost sheet", () => {
    const res = savePrelivePack({
      products: [{ sku: 'X-1', name: 'Thing', price: 10, floor: 7, stock: 5 }],
      script_markdown: '# Script',
      cue_card_markdown: '# Cue',
    });
    expect(res).toMatchObject({ ok: true, products_loaded: 1, floors_from: 'team' });
  });
});
