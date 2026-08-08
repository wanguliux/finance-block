/**
 * 贷款还款引擎（engine/loan.ts）—— 纯函数，可单测
 *
 * 三种还款方式（finance-recurring V2）：
 *   - annuity          等额本息：每期总额 A 固定，本金逐期递增、利息逐期递减
 *   - equal-principal  等额本金：每期本金 P/n 固定，总额逐期递减
 *   - interest-first   先息后本：前 n-1 期只还利息，末期一次还本
 *
 * 精度与守恒：
 *   - 所有金额四舍五入到分（AmountInCents 整数）。
 *   - 尾差原则：末期内本金 = 剩余本金，保证本金累计精确等于起算本金。
 *
 * 续算规则（编辑 / 部分提前还款的唯一入口）：
 *   - 编辑贷款后已入账期不动（账本真源），从「下一未入账期」startPeriod 起，
 *     以 remainingPrincipal（缺省 = principal）为起算本金重新生成 schedule。
 *   - 视图「当前剩余本金」= 下一未入账期的「期前剩余」（principalPart + remainingBalance）。
 */

import type { AmountInCents, FinanceConfig, LoanDef, LoanPeriod } from '../types';
import { localDateString } from '../util/date';
import { legSignedCents, parseYmd } from '../util/ledgerView';
import { parseFinBeancount } from '../parser/finBeancount';

/** 续算选项：编辑贷款时从下一未入账期以新剩余本金续算 */
export interface LoanScheduleOptions {
  /** 续算起始期号（1-based；缺省 1 = 从头算）。编辑时传「已入账期数 + 1」 */
  startPeriod?: number;
  /** 续算起算本金（缺省 = def.principal）。编辑时传「用户设定的剩余本金」 */
  remainingPrincipal?: AmountInCents;
}

/** 年周期数：monthly=12，quarterly=4 */
function periodsPerYear(f: LoanDef['frequency']): number {
  return f === 'quarterly' ? 4 : 12;
}

/** 期号 → 应还日（首期日 + 周期步进；本地时区，不走 UTC） */
function dateOfPeriod(def: LoanDef, period: number): string {
  const d = parseYmd(def.firstPaymentDate);
  const steps = period - 1;
  if (def.frequency === 'quarterly') d.setMonth(d.getMonth() + steps * 3);
  else d.setMonth(d.getMonth() + steps);
  return localDateString(d);
}

/**
 * 计算还款计划（从 startPeriod 到期末，以 remainingPrincipal 为起算本金）。
 * 期号 = 绝对期号（1..termYears*periodsPerYear），与入账分录 loan-period 元数据一致。
 */
export function computeLoanSchedule(def: LoanDef, opts: LoanScheduleOptions = {}): LoanPeriod[] {
  const ppy = periodsPerYear(def.frequency);
  const n = def.termYears * ppy;
  const start = Math.max(1, opts.startPeriod ?? 1);
  if (start > n) return [];
  const principal = opts.remainingPrincipal ?? def.principal;
  const r = def.annualRate / 100 / ppy;
  const periods: LoanPeriod[] = [];
  let remaining = principal;

  const push = (period: number, total: AmountInCents, pPart: AmountInCents, interest: AmountInCents): void => {
    remaining -= pPart;
    periods.push({
      period,
      date: dateOfPeriod(def, period),
      total,
      principalPart: pPart,
      interestPart: interest,
      remainingBalance: remaining,
    });
  };

  if (def.type === 'annuity') {
    // 等额本息：A = P·r(1+r)ⁿ / ((1+r)ⁿ − 1)
    const A = Math.round((principal * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1));
    for (let period = start; period <= n; period++) {
      const interest = Math.round(remaining * r);
      const pPart = period === n ? remaining : A - interest; // 尾差：末期内本金 = 剩余
      push(period, pPart + interest, pPart, interest);
    }
    return periods;
  }

  if (def.type === 'equal-principal') {
    const pp = Math.round(principal / n);
    for (let period = start; period <= n; period++) {
      const interest = Math.round(remaining * r);
      const pPart = period === n ? remaining : Math.min(pp, remaining);
      push(period, pPart + interest, pPart, interest);
    }
    return periods;
  }

  // interest-first：前 n-1 期只还利息，末期一次还本
  for (let period = start; period <= n; period++) {
    const interest = Math.round(principal * r);
    const pPart = period === n ? remaining : 0;
    push(period, pPart + interest, pPart, interest);
  }
  return periods;
}

/**
 * 生成单期的 beancount 分录文本（3 腿：出资资产 -total / 负债 +principalPart / 利息 +interestPart）。
 * 符号由 legSignedCents 按账户类别推导（与「记一笔」同规则），零和天然成立：
 *   -total + principalPart + interestPart = 0
 * 不含围栏与 ^t- 块引用（由入账方 appendEntryToLedgerBlock 统一追加）。
 */
export function loanEntryText(period: LoanPeriod, def: LoanDef, config?: FinanceConfig): string {
  const asset = legSignedCents(def.assetAccount, period.total, 'out', config); // 资产减少 → 负
  const liab = legSignedCents(def.liabilityAccount, period.principalPart, 'out', config); // 负债减少 → 正（借方）
  const interest = legSignedCents(def.interestAccount, period.interestPart, 'in', config); // 费用增加 → 正
  const lines = [
    `${period.date} * ${def.name}`,
    `  ${def.assetAccount}  ${asset}`,
    `  ${def.liabilityAccount}  ${liab}`,
    `  ${def.interestAccount}  ${interest}`,
    `  loan: ${def.id}`,
    `  loan-period: ${period.period}`,
    `  loan-date: ${period.date}`,
  ];
  if (def.txnType) lines.push(`  type: ${def.txnType}`);
  if (def.owner) lines.push(`  owner: ${def.owner}`);
  return lines.join('\n');
}

/**
 * 从账本已入账期号续算，生成「待入账」的分录文本列表（供 CLI / 插件批量入账）。
 *
 * 纯函数（不读写文件）：读取账本内文，找出该贷款已入账的最大期号，
 * 从「下一期」起以 def.principal 为起算本金续算（与视图引擎续算规则一致），
 * 逐期调用 loanEntryText 输出 3 腿分录（不含围栏与 ^t- 引用，由入账方追加）。
 *
 * @param ledgerContent  账本文件完整内容（需含唯一 fin-beancount 块）
 * @param config         finance-config（含 loanPlans）
 * @param loanId         贷款计划 id
 * @param upToPeriod     可选：只生成到该期号（缺省 = 全部剩余期）
 * @returns              待入账分录文本数组（按绝对期号升序）
 */
export function deriveLoanPostings(
  ledgerContent: string,
  config: FinanceConfig,
  loanId: string,
  upToPeriod?: number,
): string[] {
  const def = config.loanPlans.find((p) => p.id === loanId);
  if (!def) throw new Error(`贷款计划不存在：${loanId}`);

  const parsed = parseFinBeancount(ledgerContent);
  let maxPosted = 0;
  for (const t of parsed.transactions) {
    if (t.fields?.['loan'] === loanId) {
      const p = Number(t.fields?.['loan-period']);
      if (!Number.isNaN(p) && p > maxPosted) maxPosted = p;
    }
  }

  const ppy = def.frequency === 'quarterly' ? 4 : 12;
  const total = def.termYears * ppy;
  const upTo = upToPeriod ?? total;
  if (maxPosted >= upTo) return [];

  const schedule = computeLoanSchedule(def, { startPeriod: maxPosted + 1 });
  return schedule
    .filter((period) => period.period <= upTo)
    .map((period) => loanEntryText(period, def, config));
}
