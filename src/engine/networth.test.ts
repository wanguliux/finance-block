// globals 模式（vitest.config.ts 中 globals:true），describe/it/expect 由 runner 注入。
// 覆盖《记账问题分析与引擎优化报告》Bug 清单 #4 / #5 / #7 / #8 的引擎行为。
import {
  buildAccountFlows,
  bookBalanceAt,
  carryForwardValuation,
  computeNetWorth,
  computeNetWorthSeries,
  computeRealizedPnL,
  getValuationSeries,
  resolveAccountValue,
} from './networth';
import type { AccountDef, AmountInCents, Valuation } from '../types';

const Y = 100; // 1 元 = 100 分

/** 余额 Map<账户名, 分> */
function balances(entries: Record<string, number>): Map<string, AmountInCents> {
  return new Map(Object.entries(entries));
}

const CTX = {
  valuations: [] as Valuation[],
  staleDaysDefault: 30,
  today: new Date('2026-08-02T00:00:00'),
  baseCurrency: 'CNY',
};

// ───────────────────────────────────────────────────────────────
describe('#4 carryForwardValuation 估值结转（幽灵收益根治）', () => {
  it('账面清零 → 市值强制归零（卖光后不残留浮盈）', () => {
    const r = carryForwardValuation(13000 * Y, 0, [{ date: '2026-07-20', amount: -10000 * Y }]);
    expect(r.marketValue).toBe(0);
    expect(r.carried).toBe(1);
  });

  it('估值后无流水 → 原样返回估值', () => {
    const r = carryForwardValuation(13000 * Y, 10000 * Y, []);
    expect(r.marketValue).toBe(13000 * Y);
    expect(r.carried).toBe(0);
  });

  it('增持按成本加（不放大旧涨幅）', () => {
    // 估值日账面 10000、估值 13000；之后再买入 5000
    const r = carryForwardValuation(13000 * Y, 15000 * Y, [{ date: '2026-07-20', amount: 5000 * Y }]);
    expect(r.marketValue).toBe(18000 * Y); // 13000 + 5000，而非 13000 × 1.5
    expect(r.carried).toBe(1);
  });

  it('部分减持按比例扣市值', () => {
    // 估值日账面 10000、估值 13000；之后卖掉一半成本 5000 → 市值应减半
    const r = carryForwardValuation(13000 * Y, 5000 * Y, [{ date: '2026-07-20', amount: -5000 * Y }]);
    expect(r.marketValue).toBe(6500 * Y);
  });

  it('多笔混合流水按时间顺序推演', () => {
    // 估值日账面 10000、估值 12000 → 买 10000（账面 20000/市值 22000）
    // → 卖 10000（占账面 50%）→ 市值 11000，账面 10000
    const r = carryForwardValuation(12000 * Y, 10000 * Y, [
      { date: '2026-07-10', amount: 10000 * Y },
      { date: '2026-07-20', amount: -10000 * Y },
    ]);
    expect(r.marketValue).toBe(11000 * Y);
    expect(r.carried).toBe(2);
  });

  it('resolveAccountValue：卖光后 unrealizedPnL 归零且标记需复核', () => {
    const def: AccountDef = { name: '股票', class: 'asset', valuation: 'market' };
    const av = resolveAccountValue(
      def,
      0,
      {
        ...CTX,
        valuations: [{ date: '2026-07-01', account: '股票', amount: 13000 * Y, currency: 'CNY' }],
      },
      [{ date: '2026-07-20', amount: -10000 * Y }],
    );
    expect(av.marketValue).toBe(0);
    expect(av.unrealizedPnL).toBe(0);
    expect(av.carriedFlows).toBe(1);
    expect(av.isStale).toBe(true); // 结转过的值是推算值 → 提示复核
  });
});

// ───────────────────────────────────────────────────────────────
describe('#5 子账户持仓：从父账户继承计价与类别', () => {
  const defs: AccountDef[] = [
    { name: '股票', class: 'asset', valuation: 'market' },
    { name: '活期', class: 'asset', valuation: 'book' },
  ];

  it('账本中的持仓子账户被纳入且继承 market 计价', () => {
    const r = computeNetWorth(
      defs,
      balances({ '股票:腾讯': 10000 * Y, '活期': 5000 * Y }),
      {
        ...CTX,
        valuations: [
          { date: '2026-08-01', account: '股票:腾讯', amount: 13000 * Y, currency: 'CNY' },
        ],
      },
    );
    const tx = r.accounts.find((a) => a.account === '股票:腾讯')!;
    expect(tx.accountClass).toBe('asset');
    expect(tx.valuationType).toBe('market');
    expect(tx.marketValue).toBe(13000 * Y);
    expect(tx.unrealizedPnL).toBe(3000 * Y);
    expect(r.unclassifiedCount).toBe(0);
  });

  it('前缀匹配须落在层级分隔符上（「股票基金」不会误配「股票」）', () => {
    const r = computeNetWorth(defs, balances({ '股票基金': 1000 * Y }), CTX);
    const fund = r.accounts.find((a) => a.account === '股票基金')!;
    expect(fund.accountClass).toBeNull();
    expect(r.unclassifiedCount).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────
describe('#5/#6 computeRealizedPnL 已实现收益归集', () => {
  const defs: AccountDef[] = [
    { name: '股票', class: 'asset', valuation: 'market' },
    { name: '活期', class: 'asset', valuation: 'book' },
    { name: '房贷', class: 'liability' },
    { name: '投资收益', class: 'income' },
    { name: '工资', class: 'income' },
    { name: '投资亏损', class: 'expense' },
    { name: '利息', class: 'expense' },
    { name: '手续费', class: 'expense' },
  ];

  it('卖出获利：第三腿收益归到被减持的持仓子账户', () => {
    const m = computeRealizedPnL(
      [
        {
          date: '2026-07-20',
          legs: [
            { account: '活期', amount: 11000 * Y },
            { account: '股票:腾讯', amount: -10000 * Y },
            { account: '投资收益', amount: -1000 * Y },
          ],
        },
      ],
      defs,
    );
    expect(m.get('股票:腾讯')).toBe(1000 * Y);
    expect(m.has('活期')).toBe(false);
  });

  it('卖出亏损：支出腿转为负的已实现', () => {
    const m = computeRealizedPnL(
      [
        {
          date: '2026-07-20',
          legs: [
            { account: '活期', amount: 9000 * Y },
            { account: '股票:腾讯', amount: -10000 * Y },
            { account: '投资亏损', amount: 1000 * Y },
          ],
        },
      ],
      defs,
    );
    expect(m.get('股票:腾讯')).toBe(-1000 * Y);
  });

  it('卖出带手续费：净额入账', () => {
    const m = computeRealizedPnL(
      [
        {
          date: '2026-07-20',
          legs: [
            { account: '活期', amount: 10900 * Y },
            { account: '股票:腾讯', amount: -10000 * Y },
            { account: '投资收益', amount: -1000 * Y },
            { account: '手续费', amount: 100 * Y },
          ],
        },
      ],
      defs,
    );
    expect(m.get('股票:腾讯')).toBe(900 * Y);
  });

  it('工资入账不产生已实现收益（资产腿为正）', () => {
    const m = computeRealizedPnL(
      [
        {
          date: '2026-07-05',
          legs: [
            { account: '活期', amount: 5000 * Y },
            { account: '工资', amount: -5000 * Y },
          ],
        },
      ],
      defs,
    );
    expect(m.size).toBe(0);
  });

  it('还房贷不会被误算成持仓亏损（现金是 book 计价）', () => {
    const m = computeRealizedPnL(
      [
        {
          date: '2026-07-10',
          legs: [
            { account: '活期', amount: -3000 * Y },
            { account: '房贷', amount: 2500 * Y },
            { account: '利息', amount: 500 * Y },
          ],
        },
      ],
      defs,
    );
    expect(m.size).toBe(0);
  });

  it('同笔多只减持按金额占比分摊，且合计守恒', () => {
    const m = computeRealizedPnL(
      [
        {
          date: '2026-07-20',
          legs: [
            { account: '活期', amount: 3100 * Y },
            { account: '股票:腾讯', amount: -2000 * Y },
            { account: '股票:茅台', amount: -1000 * Y },
            { account: '投资收益', amount: -100 * Y },
          ],
        },
      ],
      defs,
    );
    const a = m.get('股票:腾讯')!;
    const b = m.get('股票:茅台')!;
    expect(a + b).toBe(100 * Y);
    expect(a).toBeGreaterThan(b);
  });
});

// ───────────────────────────────────────────────────────────────
describe('#7 按账户类别归类 + 权益对账', () => {
  const defs: AccountDef[] = [
    { name: '活期', class: 'asset' },
    { name: '信用卡', class: 'liability' },
    { name: '期初', class: 'equity' },
    { name: '工资', class: 'income' },
    { name: '日常', class: 'expense' },
  ];

  it('现金账户透支为负仍算资产，不再被误判成负债', () => {
    const r = computeNetWorth(defs, balances({ '活期': -500 * Y }), CTX);
    expect(r.bookAssets).toBe(-500 * Y);
    expect(r.bookLiabilities).toBe(0);
    expect(r.bookNetWorth).toBe(-500 * Y);
  });

  it('负债账户多还成正余额仍算负债（负数负债 = 抵减）', () => {
    const r = computeNetWorth(defs, balances({ '信用卡': 300 * Y }), CTX);
    expect(r.bookAssets).toBe(0);
    expect(r.bookLiabilities).toBe(-300 * Y);
    expect(r.bookNetWorth).toBe(300 * Y);
  });

  it('全账套零和时对账差额为 0', () => {
    // 期初权益 10000 存入活期；本月工资 3000、支出 1000
    const r = computeNetWorth(
      defs,
      balances({
        '活期': 12000 * Y, // 10000 + 3000 − 1000
        '期初': -10000 * Y,
        '工资': -3000 * Y,
        '日常': 1000 * Y,
      }),
      CTX,
    );
    expect(r.bookNetWorth).toBe(12000 * Y);
    expect(r.retainedEarnings).toBe(2000 * Y);
    expect(r.totalEquity).toBe(12000 * Y);
    expect(r.reconciliationDiff).toBe(0);
  });

  it('账不平时对账差额暴露缺口', () => {
    const r = computeNetWorth(defs, balances({ '活期': 12000 * Y }), CTX);
    expect(r.reconciliationDiff).toBe(12000 * Y);
  });

  it('ownerFilter 下未声明账户不被混入', () => {
    const owned: AccountDef[] = [
      { name: '活期', class: 'asset', owner: '自己' },
      { name: '她的卡', class: 'asset', owner: '配偶' },
    ];
    const r = computeNetWorth(
      owned,
      balances({ '活期': 100 * Y, '她的卡': 900 * Y, '未知账户': 500 * Y }),
      CTX,
      { ownerFilter: '自己' },
    );
    expect(r.accounts.map((a) => a.account)).toEqual(['活期']);
    expect(r.bookAssets).toBe(100 * Y);
  });
});

// ───────────────────────────────────────────────────────────────
describe('#8 估值时间序列与历史净资产曲线', () => {
  const defs: AccountDef[] = [
    { name: '股票', class: 'asset', valuation: 'market' },
    { name: '活期', class: 'asset', valuation: 'book' },
  ];
  const txns = [
    // 期初：活期 20000
    { date: '2026-01-01', legs: [{ account: '活期', amount: 20000 * Y }] },
    // 买股票 10000
    {
      date: '2026-03-01',
      legs: [
        { account: '股票', amount: 10000 * Y },
        { account: '活期', amount: -10000 * Y },
      ],
    },
  ];

  it('getValuationSeries 按日期升序返回该账户全部估值', () => {
    const vals: Valuation[] = [
      { date: '2026-06-01', account: '股票', amount: 12000 * Y, currency: 'CNY' },
      { date: '2026-04-01', account: '股票', amount: 11000 * Y, currency: 'CNY' },
      { date: '2026-05-01', account: '活期', amount: 1 * Y, currency: 'CNY' },
    ];
    expect(getValuationSeries(vals, '股票').map((v) => v.date)).toEqual([
      '2026-04-01',
      '2026-06-01',
    ]);
  });

  it('bookBalanceAt 按基准日切片账面余额', () => {
    const flows = buildAccountFlows(txns);
    expect(bookBalanceAt(flows.get('活期'), '2026-02-01')).toBe(20000 * Y);
    expect(bookBalanceAt(flows.get('活期'), '2026-04-01')).toBe(10000 * Y);
    expect(bookBalanceAt(flows.get('股票'), '2026-02-01')).toBe(0);
  });

  it('历史曲线不会被今天的估值倒灌回买入前', () => {
    const flows = buildAccountFlows(txns);
    const series = computeNetWorthSeries(
      defs,
      flows,
      ['2026-02-01', '2026-04-01', '2026-07-01'],
      {
        ...CTX,
        valuations: [
          { date: '2026-04-01', account: '股票', amount: 11000 * Y, currency: 'CNY' },
          { date: '2026-07-01', account: '股票', amount: 13000 * Y, currency: 'CNY' },
        ],
      },
    );
    expect(series.map((p) => p.date)).toEqual(['2026-02-01', '2026-04-01', '2026-07-01']);
    // 买入前：只有活期 20000，股票估值尚未生效
    expect(series[0].bookNetWorth).toBe(20000 * Y);
    expect(series[0].marketNetWorth).toBe(20000 * Y);
    // 4/1：账面 20000，市值 21000（股票 11000）
    expect(series[1].marketNetWorth).toBe(21000 * Y);
    expect(series[1].totalUnrealizedPnL).toBe(1000 * Y);
    // 7/1：市值 23000
    expect(series[2].marketNetWorth).toBe(23000 * Y);
  });

  it('日期乱序传入自动排序去重', () => {
    const flows = buildAccountFlows(txns);
    const series = computeNetWorthSeries(defs, flows, ['2026-04-01', '2026-02-01', '2026-04-01'], CTX);
    expect(series.map((p) => p.date)).toEqual(['2026-02-01', '2026-04-01']);
  });
});

// ───────────────────────────────────────────────────────────────
describe('#8 历史切片下的折旧口径（asOf 而非 today）', () => {
  const carDefs: AccountDef[] = [
    {
      name: '汽车',
      class: 'asset',
      valuation: 'depreciation',
      depreciation: {
        purchasePrice: 200000 * Y,
        purchaseDate: '2022-01-01',
        usefulLifeYears: 10,
        method: 'straight-line',
        salvageValue: 0,
      },
    },
  ];

  it('切片日的折旧进度按该日算，不被「今天」倒灌', () => {
    // 10 年直线折旧、年折 2 万：2023-01-01 应剩 18 万，2026-01-01 应剩 12 万。
    // 旧实现一律按 today(2026-08-02) 算，两个切片会得到同一个值。
    const y2023 = resolveAccountValue(carDefs[0], 200000 * Y, { ...CTX, asOf: '2023-01-01' });
    const y2026 = resolveAccountValue(carDefs[0], 200000 * Y, { ...CTX, asOf: '2026-01-01' });
    // currentValue 按 365.25 天/年折算，故留 ±50 元容差
    expect(y2023.marketValue).toBeCloseTo(180000 * Y, -4);
    expect(y2026.marketValue).toBeCloseTo(120000 * Y, -4);
    expect(y2023.marketValue).toBeGreaterThan(y2026.marketValue);
  });

  it('净资产序列里的折旧资产逐年递减', () => {
    const flows = buildAccountFlows([
      { date: '2022-01-01', legs: [{ account: '汽车', amount: 200000 * Y }] },
    ]);
    const series = computeNetWorthSeries(
      carDefs,
      flows,
      ['2022-12-31', '2023-12-31', '2024-12-31'],
      CTX,
    );
    expect(series[0].marketNetWorth).toBeGreaterThan(series[1].marketNetWorth);
    expect(series[1].marketNetWorth).toBeGreaterThan(series[2].marketNetWorth);
    // 账面口径不受折旧影响，恒为购入成本
    expect(series.every((p) => p.bookNetWorth === 200000 * Y)).toBe(true);
  });
});
