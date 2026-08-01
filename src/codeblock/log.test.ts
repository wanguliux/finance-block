/**
 * finance-log 筛选逻辑回归测试
 *
 * 只测纯函数（parseParams / parseAmountRange / filterEntries / entryAmount），
 * 不触碰 DOM 渲染——渲染层只是把这三者的结果画出来。
 *
 * 关键约定复核点：
 *   - date 是「起始日」= 窗口里最新的一天，day 从它往前数（含当天）
 *   - 金额筛选按绝对值、单位元，内部折算为闭区间的整数分
 *   - id 命中时忽略日期窗口，但属性筛选仍然生效
 */

import { describe, it, expect } from 'vitest';
import { parseParams, parseAmountRange, filterEntries, entryAmount } from './log';
import type { IndexEntry } from '../ledger/indexer';

// ── 构造工具 ───────────────────────────────────────────────────

interface EntryOpts {
  date: string;
  amount: number; // 元（正=收入，负=支出）
  from?: string;
  to?: string;
  type?: string;
  owner?: string;
  id?: string;
  draft?: boolean;
  narration?: string;
}

function entry(o: EntryOpts): IndexEntry {
  const cents = Math.round(o.amount * 100);
  return {
    transaction: {
      date: o.date,
      narration: o.narration ?? '测试',
      legs: [
        { account: o.from ?? '现金', amount: cents < 0 ? cents : -cents },
        { account: o.to ?? '费用:餐饮', amount: cents < 0 ? -cents : cents },
      ],
      txnType: o.type,
      owner: o.owner,
      fields: {},
    },
    sourceFile: '账本/账本.md',
    blockRefId: o.id,
    isDraft: o.draft ?? false,
  } as IndexEntry;
}

const TODAY = '2026-07-31';

// ── 参数解析 ───────────────────────────────────────────────────

describe('parseParams', () => {
  it('无参数时给出默认值：近 30 天、无其他筛选', () => {
    const p = parseParams('');
    expect(p).toEqual({ day: 30 });
  });

  it('解析全部新参数', () => {
    const p = parseParams(
      ['date: 2026-07-15', 'day: 3', 'amount: >100', 'account: 现金', 'type: 餐饮', 'owner: 自己'].join('\n'),
    );
    expect(p.date).toBe('2026-07-15');
    expect(p.day).toBe(3);
    expect(p.account).toBe('现金');
    expect(p.type).toBe('餐饮');
    expect(p.owner).toBe('自己');
    expect(p.amount).toEqual({ min: 10001, raw: '>100' });
  });

  it('非法日期被忽略（降级为默认起始日=今天），不会把视图打空', () => {
    expect(parseParams('date: 2026/07/15').date).toBeUndefined();
    expect(parseParams('date: 今天').date).toBeUndefined();
  });

  it('id 支持 ; 分隔并剥离前导 ^', () => {
    expect(parseParams('id: ^t-1; t-2').ids).toEqual(['t-1', 't-2']);
  });

  it('未知键与注释行被忽略', () => {
    const p = parseParams('foo: bar\n随便写一行\nday: 7');
    expect(p.day).toBe(7);
  });
});

// ── 金额表达式 ─────────────────────────────────────────────────

describe('parseAmountRange', () => {
  it('严格大于折算为闭区间下界 +1 分', () => {
    expect(parseAmountRange('>100')).toMatchObject({ min: 10001 });
    expect(parseAmountRange('>=100')).toMatchObject({ min: 10000 });
  });

  it('严格小于折算为闭区间上界 -1 分', () => {
    expect(parseAmountRange('<50')).toMatchObject({ max: 4999 });
    expect(parseAmountRange('<=50')).toMatchObject({ max: 5000 });
  });

  it('区间写法支持 - / ~ / ..，且自动纠正大小顺序', () => {
    expect(parseAmountRange('100-200')).toMatchObject({ min: 10000, max: 20000 });
    expect(parseAmountRange('200~100')).toMatchObject({ min: 10000, max: 20000 });
    expect(parseAmountRange('1.5..2.5')).toMatchObject({ min: 150, max: 250 });
  });

  it('单个数字视为精确匹配', () => {
    expect(parseAmountRange('35.5')).toMatchObject({ min: 3550, max: 3550 });
    expect(parseAmountRange('=35.5')).toMatchObject({ min: 3550, max: 3550 });
  });

  it('无法识别时返回 undefined（不筛选，而非全部隐藏）', () => {
    expect(parseAmountRange('大于一百')).toBeUndefined();
    expect(parseAmountRange('')).toBeUndefined();
  });
});

// ── 日期窗口 ───────────────────────────────────────────────────

describe('filterEntries · 日期窗口', () => {
  const data = [
    entry({ date: '2026-07-16', amount: -10 }),
    entry({ date: '2026-07-15', amount: -20 }),
    entry({ date: '2026-07-14', amount: -30 }),
    entry({ date: '2026-07-13', amount: -40 }),
    entry({ date: '2026-07-12', amount: -50 }),
  ];

  it('date + day=3 命中起始日及其前两天（15/14/13）', () => {
    const got = filterEntries(data, { day: 3, date: '2026-07-15' }, TODAY);
    expect(got.map((e) => e.transaction.date)).toEqual(['2026-07-15', '2026-07-14', '2026-07-13']);
  });

  it('date + day=1 只看起始日当天', () => {
    const got = filterEntries(data, { day: 1, date: '2026-07-14' }, TODAY);
    expect(got.map((e) => e.transaction.date)).toEqual(['2026-07-14']);
  });

  it('date 缺省时以今天为起始日', () => {
    const withToday = [...data, entry({ date: TODAY, amount: -1 })];
    const got = filterEntries(withToday, { day: 1 }, TODAY);
    expect(got.map((e) => e.transaction.date)).toEqual([TODAY]);
  });

  it('起始日之后的账目被排除（未来账不混进历史窗口）', () => {
    const got = filterEntries(data, { day: 30, date: '2026-07-14' }, TODAY);
    expect(got.map((e) => e.transaction.date)).not.toContain('2026-07-15');
    expect(got.map((e) => e.transaction.date)).not.toContain('2026-07-16');
  });

  it('day=0 且给了 date：看该日及更早的全部', () => {
    const got = filterEntries(data, { day: 0, date: '2026-07-14' }, TODAY);
    expect(got).toHaveLength(3);
  });

  it('day=0 且无 date：完全不限时间', () => {
    expect(filterEntries(data, { day: 0 }, TODAY)).toHaveLength(5);
  });

  it('跨月边界正确回退（3-01 往前 3 天到 2-27）', () => {
    const cross = [
      entry({ date: '2026-03-01', amount: -1 }),
      entry({ date: '2026-02-27', amount: -1 }),
      entry({ date: '2026-02-26', amount: -1 }),
    ];
    const got = filterEntries(cross, { day: 3, date: '2026-03-01' }, TODAY);
    expect(got.map((e) => e.transaction.date)).toEqual(['2026-03-01', '2026-02-27']);
  });
});

// ── 属性筛选 ───────────────────────────────────────────────────

describe('filterEntries · 属性筛选', () => {
  const data = [
    entry({ date: TODAY, amount: -35, from: '现金', type: '餐饮', owner: '自己' }),
    entry({ date: TODAY, amount: -150, from: '银行卡', type: '购物', owner: '家庭' }),
    entry({ date: TODAY, amount: 8000, from: '收入:工资', to: '银行卡', type: '工资', owner: '自己' }),
  ];

  it('amount 按绝对值筛选，收入支出一视同仁', () => {
    const got = filterEntries(data, { day: 1, amount: parseAmountRange('>100') }, TODAY);
    expect(got).toHaveLength(2);
    expect(got.map((e) => Math.abs(entryAmount(e)))).toEqual([15000, 800000]);
  });

  it('amount 区间可夹出中间档', () => {
    const got = filterEntries(data, { day: 1, amount: parseAmountRange('100-200') }, TODAY);
    expect(got).toHaveLength(1);
    expect(got[0].transaction.txnType).toBe('购物');
  });

  it('account 命中任一分录即算（含去向腿）', () => {
    expect(filterEntries(data, { day: 1, account: '银行卡' }, TODAY)).toHaveLength(2);
    expect(filterEntries(data, { day: 1, account: '现金' }, TODAY)).toHaveLength(1);
  });

  it('owner 筛选生效', () => {
    expect(filterEntries(data, { day: 1, owner: '家庭' }, TODAY)).toHaveLength(1);
  });

  it('多个筛选条件是「与」关系', () => {
    const got = filterEntries(
      data,
      { day: 1, owner: '自己', amount: parseAmountRange('<100') },
      TODAY,
    );
    expect(got).toHaveLength(1);
    expect(got[0].transaction.txnType).toBe('餐饮');
  });

  it('期初结转分录始终被排除', () => {
    const withCarry = [
      ...data,
      entry({ date: TODAY, amount: 99999, narration: '期初结转 · 余额承接' }),
    ];
    expect(filterEntries(withCarry, { day: 1 }, TODAY)).toHaveLength(3);
  });
});

// ── ID 查询 ────────────────────────────────────────────────────

describe('filterEntries · ID 查询', () => {
  const data = [
    entry({ date: '2020-01-01', amount: -35, id: 't-a', type: '餐饮' }),
    entry({ date: '2020-01-02', amount: -60, id: 't-b', type: '购物' }),
  ];

  it('给了 id 就忽略日期窗口（哪怕早已超出 30 天）', () => {
    const got = filterEntries(data, { day: 30, ids: ['t-a'] }, TODAY);
    expect(got).toHaveLength(1);
    expect(got[0].blockRefId).toBe('t-a');
  });

  it('id 路径上属性筛选依然生效', () => {
    const got = filterEntries(data, { day: 30, ids: ['t-a', 't-b'], type: '购物' }, TODAY);
    expect(got).toHaveLength(1);
    expect(got[0].blockRefId).toBe('t-b');
  });
});
