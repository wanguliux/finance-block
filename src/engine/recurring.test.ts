/**
 * recurring 派生纯函数单元测试（finance-recurring V1 日常计划 + V2 贷款）
 * 覆盖：应发生日期集合（daily/weekday/monthly + 起止截断）、
 * 已入账识别（plan+plan-date / loan+loan-period 幂等）、跳过过滤、逾期补齐、贷款续算进度。
 */

import { describe, it, expect } from 'vitest';
import type { LoanDef, RecurringPlanDef, Transaction } from '../types';
import { computeOccurrenceDates, deriveLoanDrafts, deriveRecurringDrafts, loanProgress, matchesFrequency } from './recurring';

// ─── 日常计划 ────────────────────────────────────────────────────

const WEEKDAY_PLAN: RecurringPlanDef = {
  id: 'p-subway',
  name: '地铁通勤',
  amount: 600,
  account: '交通',
  fromAccount: '现金',
  txnType: '交通',
  owner: '自己',
  frequency: 'weekday',
  startDate: '2026-08-03', // 周一
  active: true,
};

const MONTHLY_PLAN: RecurringPlanDef = {
  id: 'p-vip',
  name: '视频会员',
  amount: 2500,
  account: '日常',
  fromAccount: '银行卡',
  txnType: '订阅',
  owner: '自己',
  frequency: 'monthly',
  monthlyDay: 1,
  startDate: '2026-08-01',
  active: true,
};

function txn(fields: Record<string, string>): Transaction {
  return { id: '^t-x', date: '2026-08-03', legs: [{ account: '现金', amount: -600 }], fields };
}

describe('matchesFrequency', () => {
  it('weekday：周一到周五命中，周末排除', () => {
    expect(matchesFrequency(WEEKDAY_PLAN, '2026-08-03')).toBe(true); // 周一
    expect(matchesFrequency(WEEKDAY_PLAN, '2026-08-07')).toBe(true); // 周五
    expect(matchesFrequency(WEEKDAY_PLAN, '2026-08-08')).toBe(false); // 周六
  });

  it('monthly：按 monthlyDay 命中', () => {
    expect(matchesFrequency(MONTHLY_PLAN, '2026-08-01')).toBe(true);
    expect(matchesFrequency(MONTHLY_PLAN, '2026-08-02')).toBe(false);
  });

  it('daily：恒命中', () => {
    const d: RecurringPlanDef = { ...WEEKDAY_PLAN, frequency: 'daily' };
    expect(matchesFrequency(d, '2026-08-08')).toBe(true);
  });
});

describe('computeOccurrenceDates', () => {
  it('weekday 计划：一周内产出周一至周五（5 天）', () => {
    const dates = computeOccurrenceDates(WEEKDAY_PLAN, '2026-08-09'); // 周日
    expect(dates).toEqual(['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07']);
  });

  it('monthly 计划：跨月每个 1 号', () => {
    const dates = computeOccurrenceDates(MONTHLY_PLAN, '2026-10-01');
    expect(dates).toEqual(['2026-08-01', '2026-09-01', '2026-10-01']);
  });

  it('endDate 截断', () => {
    const p: RecurringPlanDef = { ...MONTHLY_PLAN, endDate: '2026-09-30' };
    expect(computeOccurrenceDates(p, '2026-12-01')).toEqual(['2026-08-01', '2026-09-01']);
  });

  it('startDate 晚于 today → 空', () => {
    const p: RecurringPlanDef = { ...WEEKDAY_PLAN, startDate: '2026-09-01' };
    expect(computeOccurrenceDates(p, '2026-08-09')).toEqual([]);
  });
});

describe('deriveRecurringDrafts', () => {
  const today = '2026-08-09';

  it('逾期补齐：未入账的工作日全部出草稿', () => {
    const drafts = deriveRecurringDrafts([WEEKDAY_PLAN], [], {}, today);
    expect(drafts).toHaveLength(5);
    expect(drafts[0].date).toBe('2026-08-03');
  });

  it('已入账（plan + plan-date）不再出草稿', () => {
    const posted = [txn({ plan: 'p-subway', 'plan-date': '2026-08-03' })];
    const drafts = deriveRecurringDrafts([WEEKDAY_PLAN], posted, {}, today);
    expect(drafts.map((d) => d.date)).not.toContain('2026-08-03');
    expect(drafts).toHaveLength(4);
  });

  it('跳过（recurringSkips）不再出草稿', () => {
    const drafts = deriveRecurringDrafts([WEEKDAY_PLAN], [], { 'p-subway': ['2026-08-04'] }, today);
    expect(drafts.map((d) => d.date)).not.toContain('2026-08-04');
    expect(drafts).toHaveLength(4);
  });

  it('inactive 计划不派生', () => {
    const p: RecurringPlanDef = { ...WEEKDAY_PLAN, active: false };
    expect(deriveRecurringDrafts([p], [], {}, today)).toHaveLength(0);
  });
});

// ─── 贷款 ────────────────────────────────────────────────────────

const LOAN: LoanDef = {
  id: 'l-mortgage',
  name: '房贷',
  type: 'annuity',
  principal: 1_000_000_00,
  annualRate: 3.5,
  termYears: 1, // 12 期，便于测试
  frequency: 'monthly',
  firstPaymentDate: '2026-08-01',
  assetAccount: '银行卡',
  liabilityAccount: '房贷',
  interestAccount: '利息',
  txnType: '房贷',
  owner: '自己',
  active: true,
};

function loanTxn(period: number): Transaction {
  return {
    id: `^t-l${period}`,
    date: '2026-08-01',
    legs: [{ account: '房贷', amount: 1000 }],
    fields: { loan: 'l-mortgage', 'loan-period': String(period) },
  };
}

describe('deriveLoanDrafts', () => {
  it('未入账：today 之前的所有期都是草稿（含逾期）', () => {
    const drafts = deriveLoanDrafts([LOAN], [], '2026-10-15');
    expect(drafts).toHaveLength(3); // 8 月、9 月、10 月 3 期
    expect(drafts[0].period.period).toBe(1);
    expect(drafts[2].period.period).toBe(3);
  });

  it('期号连续入账后：从下一期开始派生（跳过已入账）', () => {
    const posted = [loanTxn(1), loanTxn(2)];
    const drafts = deriveLoanDrafts([LOAN], posted, '2026-10-15');
    expect(drafts).toHaveLength(1);
    expect(drafts[0].period.period).toBe(3);
  });

  it('inactive 贷款不派生', () => {
    const l: LoanDef = { ...LOAN, active: false };
    expect(deriveLoanDrafts([l], [], '2026-10-15')).toHaveLength(0);
  });
});

describe('loanProgress', () => {
  it('未入账：剩余 = 起算本金，进度 0/12', () => {
    const p = loanProgress(LOAN, [], '2026-08-01');
    expect(p.remaining).toBe(LOAN.principal);
    expect(p.paidPeriods).toBe(0);
    expect(p.totalPeriods).toBe(12);
  });

  it('入账 3 期：剩余递减、进度 3/12、next 为第 4 期', () => {
    const posted = [loanTxn(1), loanTxn(2), loanTxn(3)];
    const p = loanProgress(LOAN, posted, '2026-11-15');
    expect(p.paidPeriods).toBe(3);
    expect(p.next?.period).toBe(4);
    expect(p.remaining).toBeGreaterThan(0);
    expect(p.remaining).toBeLessThan(LOAN.principal);
  });

  it('全部入账：剩余 0', () => {
    const posted = Array.from({ length: 12 }, (_, i) => loanTxn(i + 1));
    const p = loanProgress(LOAN, posted, '2027-08-15');
    expect(p.remaining).toBe(0);
    expect(p.next).toBeUndefined();
  });

  it('remainingPrincipal 覆盖（部分提前还本）后从新剩余续算', () => {
    const l: LoanDef = { ...LOAN, remainingPrincipal: 800_000_00 };
    const p = loanProgress(l, [], '2026-08-01');
    expect(p.remaining).toBe(800_000_00);
    const drafts = deriveLoanDrafts([l], [], '2026-08-15');
    const sum = drafts[0].period.principalPart + drafts[0].period.remainingBalance;
    expect(sum).toBe(800_000_00);
  });
});
