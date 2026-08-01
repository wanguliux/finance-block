/**
 * 余额计算服务（Balances）
 *
 * 从已入账交易中计算各账户期末余额，供汇总结转（rollover）、
 * 资产总览（assets）、财务自由模拟（ficalc）等视图复用。
 */

import type { IndexEntry } from './indexer';
import type { AmountInCents } from '../types';

export interface AccountBalance {
  account: string;
  balance: AmountInCents; // 期末余额（分）
  currency?: string;
}

/**
 * 从已入账交易中计算各账户余额
 */
export function calculateBalances(
  entries: IndexEntry[],
  startDate?: string,
  endDate?: string,
): AccountBalance[] {
  // 只统计已入账交易
  const posted = entries.filter((e) => !e.isDraft);

  // 可选日期过滤
  const filtered = posted.filter((e) => {
    if (startDate && e.transaction.date < startDate) return false;
    if (endDate && e.transaction.date > endDate) return false;
    return true;
  });

  // 按账户汇总
  const balanceMap = new Map<string, AmountInCents>();

  for (const entry of filtered) {
    for (const leg of entry.transaction.legs) {
      const current = balanceMap.get(leg.account) || 0;
      balanceMap.set(leg.account, current + leg.amount);
    }
  }

  return Array.from(balanceMap.entries())
    .map(([account, balance]) => ({ account, balance }))
    .sort((a, b) => a.account.localeCompare(b.account));
}
