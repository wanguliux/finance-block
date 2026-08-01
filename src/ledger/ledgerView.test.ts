import { describe, it, expect } from 'vitest';
import {
  classOfAccount,
  computeLedgerSummary,
  serializeTxnForCopy,
} from '../util/ledgerView';
import type { Transaction } from '../types';

function txn(partial: Partial<Transaction> & { legs: Transaction['legs'] }): Transaction {
  return {
    id: '^t-20260730213729',
    date: '2026-07-30',
    ...partial,
  } as Transaction;
}

describe('classOfAccount', () => {
  it('中文前缀：费用/收入', () => {
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

  it('无法识别的扁平账户返回 null', () => {
    expect(classOfAccount('现金')).toBeNull();
    expect(classOfAccount('餐饮')).toBeNull();
  });
});

describe('computeLedgerSummary', () => {
  it('中文账户：正确汇总收入/支出/净额', () => {
    const txns = [
      txn({
        legs: [
          { account: '资产:现金', amount: -3500 },
          { account: '费用:餐饮', amount: 3500 },
        ],
      }),
      txn({
        legs: [
          { account: '资产:现金', amount: 800000 },
          { account: '收入:工资', amount: -800000 },
        ],
      }),
    ];
    const s = computeLedgerSummary(txns);
    expect(s.income).toBe(800000);
    expect(s.expense).toBe(3500);
    expect(s.net).toBe(800000 - 3500);
  });

  it('英文复数账户：修复「统计全 0」回归', () => {
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
    const s = computeLedgerSummary(txns);
    expect(s.income).toBe(800000);
    expect(s.expense).toBe(3500);
    expect(s.net).toBe(800000 - 3500);
  });

  it('全角斜杠账户同样可汇总', () => {
    const txns = [
      txn({
        legs: [
          { account: '资产／现金', amount: -3500 },
          { account: '费用／餐饮', amount: 3500 },
        ],
      }),
    ];
    const s = computeLedgerSummary(txns);
    expect(s.expense).toBe(3500);
    expect(s.income).toBe(0);
  });

  it('资产/权益类账户不污染收支', () => {
    const txns = [
      txn({
        legs: [
          { account: '资产:现金', amount: -10000 },
          { account: '权益:期初', amount: 10000 },
        ],
      }),
    ];
    const s = computeLedgerSummary(txns);
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
        { account: '费用:餐饮', amount: 3500 },
      ],
      txnType: '餐饮',
      owner: '自己',
    });
    const out = serializeTxnForCopy(t);
    expect(out).toContain('2026-07-30 * 午餐 牛肉面');
    expect(out).toContain('现金  -3500');
    expect(out).toContain('费用:餐饮  3500');
    expect(out).toContain('type: 餐饮');
    expect(out).toContain('owner: 自己');
    expect(out).toContain('^t-20260730213729');
    // 关键：不能"只有块引用"
    expect(out.trim().split('\n').length).toBeGreaterThan(1);
  });
});
