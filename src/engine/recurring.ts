/**
 * 日常花费 / 贷款待入账派生（engine/recurring.ts）—— 纯函数，可单测
 *
 * 核心原则（已拍板）：虚派生 —— 草稿不落盘，渲染时实时计算：
 *   应发生期 × 未入账 × 未跳过 → 待入账草稿
 * 已入账识别靠入账分录写入的元数据（解析器自动落入 Transaction.fields）：
 *   - 日常计划：plan: <planId> + plan-date: <YYYY-MM-DD>
 *   - 贷款：loan: <loanId> + loan-period: <N>
 * 无需后台定时任务；打开笔记任意一天自动补齐（含逾期）。
 */

import type { AmountInCents, LoanDef, LoanPeriod, RecurringPlanDef, Transaction } from '../types';
import { addDays, parseYmd } from '../util/ledgerView';
import { localDateString } from '../util/date';
import { computeLoanSchedule } from './loan';

// ─── 日常计划 ────────────────────────────────────────────────────

/** 按频率判断某天是否应发生 */
export function matchesFrequency(plan: RecurringPlanDef, dateStr: string): boolean {
  const d = parseYmd(dateStr);
  if (plan.frequency === 'daily') return true;
  if (plan.frequency === 'weekday') {
    const day = d.getDay();
    return day >= 1 && day <= 5; // 周一=1 … 周五=5；不含法定节假日（已知限制）
  }
  return d.getDate() === (plan.monthlyDay ?? 1);
}

/**
 * 计算一个计划的「应发生日期集合」：startDate ~ min(today, endDate) 之间命中频率的日期。
 * 含起始日当天；逾期（startDate 早于 today）一并补齐。
 */
export function computeOccurrenceDates(plan: RecurringPlanDef, today: string): string[] {
  const end = plan.endDate && plan.endDate < today ? plan.endDate : today;
  const dates: string[] = [];
  const start = parseYmd(plan.startDate);
  const last = parseYmd(end);
  if (start > last) return dates;
  let d = start;
  while (d <= last) {
    const ds = localDateString(d);
    if (matchesFrequency(plan, ds)) dates.push(ds);
    d = addDays(d, 1);
  }
  return dates;
}

/** 日常计划待入账草稿 */
export interface RecurringDraft {
  plan: RecurringPlanDef;
  date: string; // 应发生日（入账时账本记此日期，已拍板）
  amount: AmountInCents;
}

/**
 * 派生全部日常计划的待入账草稿（active 计划 × 应发生 × 未入账 × 未跳过）。
 * 非法条件一律降级为「不筛选」而非全部隐藏（筛选纯函数约定）。
 */
export function deriveRecurringDrafts(
  plans: RecurringPlanDef[],
  posted: Transaction[],
  skips: Record<string, string[]>,
  today: string,
): RecurringDraft[] {
  const result: RecurringDraft[] = [];
  for (const plan of plans) {
    if (!plan.active) continue;
    const skipSet = new Set(skips?.[plan.id] ?? []);
    const postedSet = new Set(
      posted
        .filter((tx) => tx.fields?.plan === plan.id)
        .map((tx) => tx.fields?.['plan-date'])
        .filter((v): v is string => !!v),
    );
    for (const date of computeOccurrenceDates(plan, today)) {
      if (skipSet.has(date) || postedSet.has(date)) continue;
      result.push({ plan, date, amount: plan.amount });
    }
  }
  return result.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ─── 贷款 ────────────────────────────────────────────────────────

/** 贷款待入账草稿（一期） */
export interface LoanDraft {
  loan: LoanDef;
  period: LoanPeriod;
}

/**
 * 续算起算本金（贷款剩余本金，账本派生优先）：
 *   - 用户显式设定过 remainingPrincipal（部分提前还本）→ 以它为绝对剩余基准；
 *   - 否则 = principal − 已入账本金累计（账本 liabilityAccount leg 之和）。
 * 两种口径下 schedule 从「已入账期数 + 1」起算，期前剩余都自动扣减后续入账。
 */
export function loanStartPrincipal(loan: LoanDef, posted: Transaction[]): AmountInCents {
  if (loan.remainingPrincipal !== undefined) return loan.remainingPrincipal;
  const paid = posted
    .filter((tx) => tx.fields?.loan === loan.id)
    .reduce((s, tx) => s + (tx.legs.find((l) => l.account === loan.liabilityAccount)?.amount ?? 0), 0);
  return loan.principal - paid;
}

/**
 * 派生全部贷款的待入账草稿。
 * 贷款入账按「期号连续」设计（无跳过/改金额，特殊操作走编辑贷款续算），
 * 因此 schedule 从「已入账期数 + 1」起算，天然只有未入账期，无需再过滤。
 */
export function deriveLoanDrafts(
  loans: LoanDef[],
  posted: Transaction[],
  today: string,
): LoanDraft[] {
  const result: LoanDraft[] = [];
  for (const loan of loans) {
    if (!loan.active) continue;
    const postedPeriods = new Set(
      posted
        .filter((tx) => tx.fields?.loan === loan.id)
        .map((tx) => Number(tx.fields?.['loan-period']))
        .filter((v) => !isNaN(v)),
    );
    const start = postedPeriods.size > 0 ? Math.max(...postedPeriods) + 1 : 1;
    for (const p of computeLoanSchedule(loan, { startPeriod: start, remainingPrincipal: loanStartPrincipal(loan, posted) })) {
      if (p.date > today) break; // schedule 按日期递增
      result.push({ loan, period: p });
    }
  }
  return result.sort((a, b) => (a.period.date < b.period.date ? -1 : a.period.date > b.period.date ? 1 : 0));
}

/**
 * 「我的贷款」展示用：当前剩余本金（下一未入账期开始前）与还款进度。
 * 已全部入账 → 剩余 0、下一期 undefined。
 */
export function loanProgress(
  loan: LoanDef,
  posted: Transaction[],
  today: string,
): { remaining: AmountInCents; paidPeriods: number; totalPeriods: number; next?: LoanPeriod } {
  const postedPeriods = posted
    .filter((tx) => tx.fields?.loan === loan.id)
    .map((tx) => Number(tx.fields?.['loan-period']))
    .filter((v) => !isNaN(v));
  const totalPeriods = loan.termYears * (loan.frequency === 'quarterly' ? 4 : 12);
  const paidPeriods = postedPeriods.length;
  const start = paidPeriods > 0 ? Math.max(...postedPeriods) + 1 : 1;
  const schedule = computeLoanSchedule(loan, { startPeriod: start, remainingPrincipal: loanStartPrincipal(loan, posted) });
  const next = schedule.find((p) => p.date <= today) ?? schedule[0];
  if (!next) return { remaining: 0, paidPeriods, totalPeriods };
  return {
    remaining: next.principalPart + next.remainingBalance,
    paidPeriods,
    totalPeriods,
    next,
  };
}
