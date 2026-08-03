/**
 * 交易软告警层（《记账问题分析与引擎优化报告》Bug #1）
 *
 * 报告里 #1 的原始诉求是「按 AccountClass 校验借贷方向」，但直接按符号硬校验会炸：
 * 转账交易两条 asset 腿一正一负，本来就对，硬校验会满屏误报（这也是当初暂缓的原因）。
 *
 * 于是这里换成**软告警**：只做低误报的结构性检查，检查结果不拦截入账、不进 errors，
 * 只在 UI 上挂一个黄标签让人自己判断。三条规则都精准命中真实事故场景：
 *
 *   1. signFlipped        —— 收入账户记正数 / 支出账户记负数（符号填反）。
 *                            转账不涉及这两类账户，天然免疫误报。
 *   2. unclassifiedAccount—— 账户在账本里出现但 config 无定义、也无父账户可继承。
 *                            这类账户不会计入资产总览与预算，属于静默失踪，零误报。
 *   3. tagMismatch        —— type 标签方向与分录结构不符（标了「支出」却没有 expense 腿）。
 *                            正是「买股票记成支出」的根因场景（报告 #2/#3）。
 *
 * 引擎只输出结构化结果，文案与本地化交给 UI 层。
 */

import type { AccountDef, AmountInCents, TransactionTypeDef } from '../types';
import { resolveAccountDef } from '../util/ledgerView';

export type TxnWarningCode = 'signFlipped' | 'unclassifiedAccount' | 'tagMismatch';

export interface TxnWarning {
  code: TxnWarningCode;
  /** 涉事账户（tagMismatch 时为空） */
  accounts: string[];
  /** tagMismatch 专用：标签名与它声明的方向 */
  tag?: string;
  tagDirection?: 'income' | 'expense';
}

interface AuditableTxn {
  legs: Array<{ account: string; amount: AmountInCents }>;
  txnType?: string;
}

/**
 * 审计单笔交易，返回软告警列表（无问题则返回空数组）。
 *
 * @param txn              待审计交易
 * @param accountDefs      账户定义（子账户会走前缀继承）
 * @param transactionTypes 受管交易类型词表，缺省则跳过 tagMismatch 检查
 */
export function auditTransaction(
  txn: AuditableTxn,
  accountDefs: AccountDef[] | undefined,
  transactionTypes?: TransactionTypeDef[],
): TxnWarning[] {
  const warnings: TxnWarning[] = [];
  if (!accountDefs || accountDefs.length === 0) return warnings;

  const flipped: string[] = [];
  const unclassified: string[] = [];
  let hasIncomeLeg = false;
  let hasExpenseLeg = false;

  for (const leg of txn.legs) {
    const def = resolveAccountDef(leg.account, accountDefs);
    if (!def) {
      if (!unclassified.includes(leg.account)) unclassified.push(leg.account);
      continue;
    }
    if (def.class === 'income') {
      hasIncomeLeg = true;
      // 贝算约定：收入走贷方=负数。记成正数通常是符号填反（退款冲销例外，故只提示）
      if (leg.amount > 0 && !flipped.includes(leg.account)) flipped.push(leg.account);
    } else if (def.class === 'expense') {
      hasExpenseLeg = true;
      // 支出走借方=正数。记成负数通常是符号填反（退款冲销例外）
      if (leg.amount < 0 && !flipped.includes(leg.account)) flipped.push(leg.account);
    }
  }

  if (flipped.length > 0) warnings.push({ code: 'signFlipped', accounts: flipped });
  if (unclassified.length > 0) warnings.push({ code: 'unclassifiedAccount', accounts: unclassified });

  // 标签方向 vs 分录结构
  if (txn.txnType && transactionTypes && transactionTypes.length > 0) {
    const def = transactionTypes.find((tt) => tt.name === txn.txnType);
    if (def) {
      const missing =
        (def.direction === 'expense' && !hasExpenseLeg) || (def.direction === 'income' && !hasIncomeLeg);
      if (missing) {
        warnings.push({
          code: 'tagMismatch',
          accounts: [],
          tag: txn.txnType,
          tagDirection: def.direction,
        });
      }
    }
  }

  return warnings;
}
