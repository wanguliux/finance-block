/**
 * 贷款还款引擎单元测试（finance-recurring V2）
 * 覆盖三种还款方式：零和 / 本金守恒 / 期号日期序列 / 尾差 / 续算。
 */

import { describe, it, expect } from 'vitest';
import type { LoanDef } from '../types';
import { computeLoanSchedule, loanEntryText } from './loan';

const BASE: LoanDef = {
  id: 'loan-test',
  name: '测试房贷',
  type: 'annuity',
  principal: 1_000_000_00, // 100 万元
  annualRate: 3.5,
  termYears: 30,
  frequency: 'monthly',
  firstPaymentDate: '2026-09-01',
  assetAccount: '银行卡',
  liabilityAccount: '房贷',
  interestAccount: '利息',
  txnType: '房贷',
  owner: '自己',
  active: true,
};

describe('computeLoanSchedule · 等额本息 annuity', () => {
  const s = computeLoanSchedule(BASE);

  it('期数 = 年限 × 12', () => {
    expect(s).toHaveLength(360);
  });

  it('期号 1 基递增，应还日按首期日起逐月步进（本地时区）', () => {
    expect(s[0].period).toBe(1);
    expect(s[0].date).toBe('2026-09-01');
    expect(s[1].period).toBe(2);
    expect(s[1].date).toBe('2026-10-01');
    expect(s[359].date).toBe('2056-08-01');
  });

  it('每期总额恒定（等额本息）', () => {
    const totals = new Set(s.map((p) => p.total));
    expect(totals.size).toBeLessThanOrEqual(2); // 末期尾差可能差几分
  });

  it('本金 + 利息 = 总额', () => {
    for (const p of s) expect(p.principalPart + p.interestPart).toBe(p.total);
  });

  it('本金守恒：全部期本金之和精确等于起算本金', () => {
    const sum = s.reduce((acc, p) => acc + p.principalPart, 0);
    expect(sum).toBe(BASE.principal);
  });

  it('前期利息高、本金低（本息结构逐期翻转）', () => {
    expect(s[0].interestPart).toBeGreaterThan(s[0].principalPart);
    expect(s[300].principalPart).toBeGreaterThan(s[300].interestPart);
  });

  it('末期 remainingBalance 归零（尾差原则）', () => {
    expect(s[s.length - 1].remainingBalance).toBe(0);
  });

  it('剩余本金单调递减', () => {
    for (let i = 1; i < s.length; i++) expect(s[i].remainingBalance).toBeLessThan(s[i - 1].remainingBalance);
  });
});

describe('computeLoanSchedule · 等额本金 equal-principal', () => {
  const def: LoanDef = { ...BASE, type: 'equal-principal', termYears: 3 };
  const s = computeLoanSchedule(def);

  it('期数 = 3×12 = 36', () => {
    expect(s).toHaveLength(36);
  });

  it('每期本金固定（除末期尾差），总额逐期递减', () => {
    const pp = s[0].principalPart;
    for (const p of s) expect(p.principalPart).toBeLessThanOrEqual(pp);
    expect(s[0].total).toBeGreaterThan(s[1].total);
  });

  it('本金守恒', () => {
    const sum = s.reduce((acc, p) => acc + p.principalPart, 0);
    expect(sum).toBe(def.principal);
  });

  it('末期还清', () => {
    expect(s[s.length - 1].remainingBalance).toBe(0);
  });
});

describe('computeLoanSchedule · 先息后本 interest-first', () => {
  const def: LoanDef = { ...BASE, type: 'interest-first', termYears: 2 };
  const s = computeLoanSchedule(def);

  it('期数 = 24', () => {
    expect(s).toHaveLength(24);
  });

  it('前 23 期只还利息、本金为 0', () => {
    for (const p of s.slice(0, -1)) {
      expect(p.principalPart).toBe(0);
      expect(p.interestPart).toBe(p.total);
    }
  });

  it('末期一次还清全部本金 + 当期利息', () => {
    const last = s[s.length - 1];
    expect(last.principalPart).toBe(def.principal);
    expect(last.remainingBalance).toBe(0);
  });

  it('每期利息恒定', () => {
    const interest = new Set(s.map((p) => p.interestPart));
    expect(interest.size).toBe(1);
  });
});

describe('computeLoanSchedule · 季度频率与续算', () => {
  it('quarterly：期数 = 年限×4，日期按季步进', () => {
    const def: LoanDef = { ...BASE, frequency: 'quarterly', termYears: 5 };
    const s = computeLoanSchedule(def);
    expect(s).toHaveLength(20);
    expect(s[0].date).toBe('2026-09-01');
    expect(s[1].date).toBe('2026-12-01');
  });

  it('续算：从 startPeriod 起、以 remainingPrincipal 起算', () => {
    const s = computeLoanSchedule(BASE, { startPeriod: 13, remainingPrincipal: 980_000_00 });
    expect(s[0].period).toBe(13);
    expect(s[0].date).toBe('2027-09-01');
    // 本金守恒：续算段本金之和 = 续算起算本金
    const sum = s.reduce((acc, p) => acc + p.principalPart, 0);
    expect(sum).toBe(980_000_00);
    expect(s[s.length - 1].remainingBalance).toBe(0);
  });

  it('startPeriod 超过期数 → 空 schedule', () => {
    expect(computeLoanSchedule(BASE, { startPeriod: 361 })).toHaveLength(0);
  });
});

describe('loanEntryText · 入账分录生成', () => {
  // 生产路径由 main.ts 注入完整 config；测试用最小 config 让 legSignedCents 正确推导类别
  const config = {
    accounts: [
      { name: '银行卡', class: 'asset' },
      { name: '房贷', class: 'liability' },
      { name: '利息', class: 'expense' },
    ],
  } as unknown as import('../types').FinanceConfig;

  const def: LoanDef = { ...BASE, termYears: 1 };
  const period = computeLoanSchedule(def)[0];
  const text = loanEntryText(period, def, config);

  it('三腿零和：出资 -total / 负债 +本金 / 利息 +利息', () => {
    const legs = text.split('\n').filter((l) => /^\s+\S+/.test(l) && !l.includes(': '));
    expect(legs).toHaveLength(3);
    const nums = legs.map((l) => parseInt(l.trim().split(/\s+/)[1], 10));
    expect(nums.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('写入 loan / loan-period / loan-date 元数据', () => {
    expect(text).toContain(`loan: ${def.id}`);
    expect(text).toContain(`loan-period: ${period.period}`);
    expect(text).toContain(`loan-date: ${period.date}`);
  });

  it('日期行 + 摘要 = 计划名', () => {
    expect(text.split('\n')[0]).toBe(`${period.date} * ${def.name}`);
  });
});
