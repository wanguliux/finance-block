import { describe, it, expect } from 'vitest';
import {
  classOfAccount,
  computeLedgerSummary,
  serializeTxnForCopy,
  legSignedCents,
} from '../util/ledgerView';
import type { FinanceConfig, Transaction } from '../types';

function txn(partial: Partial<Transaction> & { legs: Transaction['legs'] }): Transaction {
  return {
    id: '^t-20260730213729',
    date: '2026-07-30',
    ...partial,
  } as Transaction;
}

/**
 * 简洁名账户 + 显式 class —— 生产路径（见 EntryFormModal / log / budget）：
 * 分类一律走 config 的 AccountDef.class（resolveAccountClass 优先查 config），不靠前缀推断。
 */
const CFG: FinanceConfig = {
  version: 4,
  baseCurrency: 'CNY',
  accounts: [
    { name: '现金', class: 'asset', owner: '自己' },
    { name: '股票', class: 'asset', owner: '自己' },
    { name: '日常', class: 'expense', owner: '自己' },
    { name: '工资', class: 'income', owner: '自己' },
    { name: '信用卡', class: 'liability', owner: '自己' },
    { name: '期初', class: 'equity', owner: '自己' },
  ],
  classes: ['asset', 'liability', 'equity', 'income', 'expense'],
  owners: ['自己'],
  defaultOwner: '自己',
  currencies: [],
  transactionTypes: [],
  budgets: [],
  lifeEvents: [],
  recurringPlans: [],
  recurringSkips: {},
  loanPlans: [],
  fiCalc: { defaultRate: 4 },
  defaultStaleDays: 30,
};

// classOfAccount 是「config 外 / 旧式带前缀账户名」的兜底推断（resolveAccountClass 查不到 config 才用它）。
// 本组固件故意用带前缀名（正是它的输入域）验证兜底行为；canonical 简洁名见下方 legSignedCents/computeLedgerSummary。
describe('classOfAccount（兜底：config 外 / 旧式前缀名）', () => {
  it('中文前缀：费用/收入/资产', () => {
    expect(classOfAccount('费用:餐饮')).toBe('expense');
    expect(classOfAccount('收入:工资')).toBe('income');
    expect(classOfAccount('资产:现金')).toBe('asset');
  });

  it('英文复数（beancount 惯例 Assets/Expenses/Income）', () => {
    expect(classOfAccount('Expenses:Food')).toBe('expense');
    expect(classOfAccount('Income:Salary')).toBe('income');
    expect(classOfAccount('Assets:Cash')).toBe('asset');
  });

  it('全角斜杠 ／ 分隔也命中', () => {
    expect(classOfAccount('费用／餐饮')).toBe('expense');
    expect(classOfAccount('资产／现金')).toBe('asset');
  });

  it('别名：支出/收益/营收 也识别为费用/收入', () => {
    expect(classOfAccount('支出:购物')).toBe('expense');
    expect(classOfAccount('收益:利息')).toBe('income');
    expect(classOfAccount('营收:服务费')).toBe('income');
  });

  it('无法识别的扁平（简洁名）账户返回 null', () => {
    expect(classOfAccount('现金')).toBeNull();
    expect(classOfAccount('餐饮')).toBeNull();
  });
});

describe('legSignedCents · 借贷符号由账户类别 + 方向推导（config 显式 class）', () => {
  it('资产账户：in=正（借），out=负（贷）', () => {
    expect(legSignedCents('现金', 3500, 'in', CFG)).toBe(3500);
    expect(legSignedCents('现金', 3500, 'out', CFG)).toBe(-3500);
  });

  it('费用账户：in=正（借），out=负', () => {
    expect(legSignedCents('日常', 3500, 'in', CFG)).toBe(3500);
    expect(legSignedCents('日常', 3500, 'out', CFG)).toBe(-3500);
  });

  it('收入账户：in=负（贷），out=正', () => {
    expect(legSignedCents('工资', 12000, 'in', CFG)).toBe(-12000);
    expect(legSignedCents('工资', 12000, 'out', CFG)).toBe(12000);
  });

  it('负债/权益账户：in=负（贷），out=正', () => {
    expect(legSignedCents('信用卡', 5000, 'in', CFG)).toBe(-5000);
    expect(legSignedCents('期初', 90000, 'out', CFG)).toBe(90000);
  });

  it('子账户继承父账户类别（股票:腾讯 视为资产）', () => {
    expect(legSignedCents('股票:腾讯', 1000000, 'in', CFG)).toBe(1000000);
    expect(legSignedCents('股票:腾讯', 1000000, 'out', CFG)).toBe(-1000000);
  });

  it('config 外且无前缀的账户类别无法识别 → 默认 incSign=+1', () => {
    expect(legSignedCents('某未知账户', 100, 'in', CFG)).toBe(100);
    expect(legSignedCents('某未知账户', 100, 'out', CFG)).toBe(-100);
  });

  it('买卖股票双分录零和（现金 out + 股票 in）', () => {
    const buy = legSignedCents('现金', 10000 * 100, 'out', CFG) + legSignedCents('股票:腾讯', 10000 * 100, 'in', CFG);
    expect(buy).toBe(0);
  });
});

describe('computeLedgerSummary', () => {
  it('简洁名账户（config 显式 class）：正确汇总收入/支出/净额', () => {
    const txns = [
      txn({
        legs: [
          { account: '现金', amount: -3500 },
          { account: '日常', amount: 3500 },
        ],
      }),
      txn({
        legs: [
          { account: '现金', amount: 800000 },
          { account: '工资', amount: -800000 },
        ],
      }),
    ];
    const s = computeLedgerSummary(txns, CFG);
    expect(s.income).toBe(800000);
    expect(s.expense).toBe(3500);
    expect(s.net).toBe(800000 - 3500);
  });

  it('config 外旧式前缀名仍走 classOfAccount 兜底（英文复数，防「统计全 0」回归）', () => {
    const txns = [
      txn({
        legs: [
          { account: 'Assets:Cash', amount: -3500 },
          { account: 'Expenses:Food', amount: 3500 },
        ],
      }),
      txn({
        legs: [
          { account: 'Assets:Cash', amount: 800000 },
          { account: 'Income:Salary', amount: -800000 },
        ],
      }),
    ];
    const s = computeLedgerSummary(txns, CFG); // 这些账户不在 CFG → resolveAccountClass 兜底 classOfAccount
    expect(s.income).toBe(800000);
    expect(s.expense).toBe(3500);
    expect(s.net).toBe(800000 - 3500);
  });

  it('资产/权益类账户不污染收支', () => {
    const txns = [
      txn({
        legs: [
          { account: '现金', amount: -10000 },
          { account: '期初', amount: 10000 },
        ],
      }),
    ];
    const s = computeLedgerSummary(txns, CFG);
    expect(s.income).toBe(0);
    expect(s.expense).toBe(0);
    expect(s.net).toBe(0);
  });
});

describe('serializeTxnForCopy', () => {
  it('复制完整记账信息（含日期/摘要/分录/块引用），而非仅有 ^t- 块引用', () => {
    const t = txn({
      narration: '午餐 牛肉面',
      legs: [
        { account: '现金', amount: -3500 },
        { account: '日常', amount: 3500 },
      ],
      txnType: '餐饮',
      owner: '自己',
    });
    const out = serializeTxnForCopy(t);
    expect(out).toContain('2026-07-30 * 午餐 牛肉面');
    expect(out).toContain('现金  -3500');
    expect(out).toContain('日常  3500');
    expect(out).toContain('type: 餐饮');
    expect(out).toContain('owner: 自己');
    expect(out).toContain('^t-20260730213729');
    // 关键：不能"只有块引用"
    expect(out.trim().split('\n').length).toBeGreaterThan(1);
  });
});
