// globals 模式（vitest.config.ts 中 globals:true），describe/it/expect 由 runner 注入。
// 单位与 fiCalc.test.ts 一致：1 万 = 1_000_00（本代码库 AmountInCents 口径）。
import { bucketAssets } from './assetBuckets';
import type { FinanceConfig, AccountDef, AccountClass, Valuation } from '../types';

const W = 1_000_00; // 1 万

function makeConfig(accounts: AccountDef[], valuations: Valuation[]): {
  config: FinanceConfig;
  valuations: Valuation[];
} {
  const config: FinanceConfig = {
    version: 1,
    accounts,
    classes: ['asset', 'liability', 'equity', 'income', 'expense'] as AccountClass[],
    owners: ['自己'],
    defaultOwner: '自己',
    baseCurrency: 'CNY',
    currencies: [{ code: 'CNY', name: '人民币', symbol: '¥', rate: 1 }],
    transactionTypes: [],
    budgets: [],
    lifeEvents: [],
    fiCalc: { defaultRate: 4 },
    defaultStaleDays: 30,
  };
  return { config, valuations };
}

/** 余额 Map<账户名, 分> */
function balances(entries: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(entries));
}

describe('bucketAssets 资产现金流分桶', () => {
  it('growth/cash/fixed/liability 四类正确分桶，净资产 = 生息本金 + 非生息 − 负债', () => {
    const { config, valuations } = makeConfig(
      [
        { name: '资产:股票', class: 'asset', valuation: 'market', cashflowRole: 'growth' },
        { name: '资产:存款', class: 'asset', valuation: 'book', cashflowRole: 'cash' },
        { name: '资产:车', class: 'asset', valuation: 'book', cashflowRole: 'fixed' },
        { name: '负债:房贷', class: 'liability' },
      ],
      [{ date: '2026-07-01', account: '资产:股票', amount: 120 * W, currency: 'CNY' }],
    );
    const r = bucketAssets(
      config,
      balances({ '资产:股票': 100 * W, '资产:存款': 30 * W, '资产:车': 20 * W, '负债:房贷': -50 * W }),
      valuations,
    );
    expect(r.growthValue).toBe(120 * W); // 市值口径（手动估值覆盖账面）
    expect(r.cashValue).toBe(30 * W);
    expect(r.fixedValue).toBe(20 * W);
    expect(r.liabilities).toBe(50 * W);
    expect(r.interestPrincipal).toBe(150 * W); // 120+30（无年支出 → 应急金 0）
    expect(r.cashAboveBuffer).toBe(30 * W);
    expect(r.nonInterestAssets).toBe(20 * W);
    expect(r.netWorth).toBe(120 * W); // 150+20-50
  });

  it('应急金缓冲 = 年支出 × 月数 / 12，并从现金桶扣减后再并入生息本金', () => {
    const { config, valuations } = makeConfig(
      [
        { name: '资产:股票', class: 'asset', valuation: 'market', cashflowRole: 'growth' },
        { name: '资产:存款', class: 'asset', valuation: 'book', cashflowRole: 'cash' },
      ],
      [{ date: '2026-07-01', account: '资产:股票', amount: 120 * W, currency: 'CNY' }],
    );
    const r = bucketAssets(
      config,
      balances({ '资产:股票': 100 * W, '资产:存款': 30 * W }),
      valuations,
      undefined,
      { annualSpend: 4 * W, bufferMonths: 6 },
    );
    expect(r.emergencyBuffer).toBe(2 * W); // 4万 × 6 / 12
    expect(r.cashAboveBuffer).toBe(28 * W); // 30 - 2
    expect(r.interestPrincipal).toBe(148 * W); // 120+30-2
  });

  it('智能推断：market→growth、book→cash、depreciation→fixed（未显式设 cashflowRole）', () => {
    const { config, valuations } = makeConfig(
      [
        { name: 'A', class: 'asset', valuation: 'market' },
        { name: 'B', class: 'asset', valuation: 'depreciation', depreciation: { purchasePrice: 50 * W, purchaseDate: '2020-01-01', usefulLifeYears: 10, method: 'straight-line' } },
        { name: 'C', class: 'asset', valuation: 'book' },
      ],
      [
        { date: '2026-07-01', account: 'A', amount: 100 * W, currency: 'CNY' },
        { date: '2026-07-01', account: 'B', amount: 50 * W, currency: 'CNY' },
      ],
    );
    const r = bucketAssets(config, balances({ A: 100 * W, B: 50 * W, C: 20 * W }), valuations);
    expect(r.growthValue).toBe(100 * W);
    expect(r.fixedValue).toBe(50 * W);
    expect(r.cashValue).toBe(20 * W);
  });

  it('负债恒进负债桶：即使显式设 cashflowRole=growth 也不生效', () => {
    const { config } = makeConfig(
      [{ name: 'L', class: 'liability', cashflowRole: 'growth' }],
      [],
    );
    const r = bucketAssets(config, balances({ L: -10 * W }), []);
    expect(r.liabilities).toBe(10 * W);
    expect(r.growthValue).toBe(0);
  });

  it('无资产账户 → 全部桶为 0，净资产为 0（纯手填退化路径）', () => {
    const { config } = makeConfig([{ name: '负债:卡债', class: 'liability' }], []);
    const r = bucketAssets(config, balances({ '负债:卡债': -5 * W }), []);
    expect(r.interestPrincipal).toBe(0);
    expect(r.growthValue).toBe(0);
    expect(r.cashValue).toBe(0);
    expect(r.fixedValue).toBe(0);
    expect(r.liabilities).toBe(5 * W);
    expect(r.netWorth).toBe(-5 * W); // 无生息本金，仅负债
  });
});
