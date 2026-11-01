import { describe, expect, it } from 'vitest';
import {
  dailyDepreciationDisplay,
  monthlyDepreciation,
} from '../../src/domain/assets';
import { accountBalance } from '../../src/domain/ledger';
import { ACCOUNTS, createHarness } from './harness';

const ASSET_INPUT = {
  companyVendorBrand: 'Synthetic Machines Inc.',
  purchaseDate: '2026-11-01',
  description: 'Demo production machine',
  serialNo: 'SN-DEMO-0001',
  assetAccountId: ACCOUNTS.assetCost,
  costCentavos: 12_000_000,
  usefulLifeYears: 5,
  residualValueCentavos: 0,
  depreciationStart: '2026-11-01',
  convention: 'full_month' as const,
  depreciationExpenseAccountId: ACCOUNTS.depreciation,
  accumulatedDepreciationAccountId: ACCOUNTS.accumulated,
  sourceType: 'opening' as const,
  postAcquisition: true,
};

describe('G11 — monthly depreciation convention', () => {
  it('divides 120,000.00 over 60 months into 2,000.00, and displays 66.67 per day', () => {
    const base = { costCentavos: 12_000_000, residualValueCentavos: 0, usefulLifeYears: 5 };
    expect(monthlyDepreciation(base)).toBe(200_000);

    const h = createHarness();
    const created = h.runOk({ type: 'asset.create', input: ASSET_INPUT });
    const asset = h.state.assets.find((candidate) => candidate.id === created.documentId)!;
    expect(asset.assetNo).toBe('FA100');
    expect(created.journalIds).toHaveLength(1);
    expect(dailyDepreciationDisplay(asset, 2026, 11)).toBe(6_667);
    expect(dailyDepreciationDisplay(asset, 2026, 10)).toBe(6_452);
  });

  it('posts exactly 2,000.00 once, requires independent approval, and never repeats the effect', () => {
    const h = createHarness();
    h.runOk({ type: 'asset.create', input: ASSET_INPUT });

    const calculated = h.runOk({ type: 'depreciation.calculate', input: { period: '2026-11' } });
    expect(calculated.warnings).toEqual([]);
    const row = h.state.depreciationPosts.find((candidate) => candidate.period === '2026-11')!;
    expect(row.amountCentavos).toBe(200_000);
    expect(row.status).toBe('calculated');
    expect(row.effectKey).toBe(`depreciation:${row.assetId}:2026-11`);

    const selfApproval = h.run({ type: 'depreciation.approve', input: { period: '2026-11' } });
    expect(selfApproval.ok).toBe(false);
    if (!selfApproval.ok) expect(selfApproval.error.code).toBe('FORBIDDEN');
    expect(h.state.depreciationPosts[0]?.status).toBe('calculated');

    h.runOk({ type: 'depreciation.approve', input: { period: '2026-11' } }, { actorId: 'u-checker' });
    const posted = h.runOk({ type: 'depreciation.post', input: { period: '2026-11' } });
    expect(posted.journalIds).toHaveLength(1);
    const journal = h.state.journals.find((candidate) => candidate.id === posted.journalIds[0])!;
    expect(journal.postingDate).toBe('2026-11-30');
    expect(journal.lines.find((line) => line.accountId === ACCOUNTS.depreciation)?.debitCentavos).toBe(200_000);
    expect(journal.lines.find((line) => line.accountId === ACCOUNTS.accumulated)?.creditCentavos).toBe(200_000);
    expect(accountBalance(h.state, 'ws-a', ACCOUNTS.accumulated, null, null).netDebitCentavos).toBe(-200_000);

    const row_count = h.state.depreciationPosts.length;
    const journals = h.state.journals.length;
    const repeat = h.run({ type: 'depreciation.post', input: { period: '2026-11' } });
    expect(repeat.ok).toBe(false);
    if (!repeat.ok) expect(repeat.error.code).toBe('CONFLICT');
    expect(h.state.depreciationPosts.length).toBe(row_count);
    expect(h.state.journals.length).toBe(journals);
    expect(h.state.depreciationPosts[0]?.status).toBe('posted');
  });

  it('refuses to calculate a period before depreciation starts and refuses a second row', () => {
    const h = createHarness();
    h.runOk({ type: 'asset.create', input: ASSET_INPUT });

    const early = h.runOk({ type: 'depreciation.calculate', input: { period: '2026-10' } });
    expect(early.warnings?.length).toBe(1);
    expect(h.state.depreciationPosts).toHaveLength(0);

    h.runOk({ type: 'depreciation.calculate', input: { period: '2026-11' } });
    const again = h.runOk({ type: 'depreciation.calculate', input: { period: '2026-11' } });
    expect(again.warnings?.length).toBe(1);
    expect(h.state.depreciationPosts).toHaveLength(1);
    expect(h.state.depreciationPosts[0]?.amountCentavos).toBe(200_000);
  });

  it('blocks an incomplete asset policy instead of inventing a useful life or account', () => {
    const h = createHarness();
    const noLife = h.run({ type: 'asset.create', input: { ...ASSET_INPUT, usefulLifeYears: 0 } });
    expect(noLife.ok).toBe(false);
    if (!noLife.ok) expect(noLife.error.code).toBe('VALIDATION');

    const foreignAccount = h.run({
      type: 'asset.create',
      input: { ...ASSET_INPUT, depreciationExpenseAccountId: 'acc-ws-b-6050' },
    });
    expect(foreignAccount.ok).toBe(false);
    if (!foreignAccount.ok) expect(foreignAccount.error.code).toBe('VALIDATION');
    expect(h.state.assets).toHaveLength(0);
  });

  it('clamps the final period to the remaining depreciable value', () => {
    const h = createHarness();
    const created = h.runOk({
      type: 'asset.create',
      input: {
        ...ASSET_INPUT,
        costCentavos: 1_000_000,
        usefulLifeYears: 1,
        depreciationStart: '2026-01-01',
      },
    });
    expect(created.journalIds).toHaveLength(1);
    const periods = [
      ...Array.from({ length: 12 }, (_, index) => `2026-${String(index + 1).padStart(2, '0')}`),
      '2027-01',
    ];
    for (const period of periods) {
      h.runOk({ type: 'depreciation.calculate', input: { period } });
      h.runOk({ type: 'depreciation.approve', input: { period } }, { actorId: 'u-checker' });
      h.runOk({ type: 'depreciation.post', input: { period } });
    }
    expect(h.state.depreciationPosts.at(-1)?.amountCentavos).toBe(4);
    const posts = h.state.depreciationPosts;
    const total = posts.reduce((sum, post) => sum + post.amountCentavos, 0);
    expect(total).toBe(1_000_000);
    const asset = h.state.assets.find((candidate) => candidate.id === created.documentId);
    expect(asset?.status).toBe('fully_depreciated');
  });
});
