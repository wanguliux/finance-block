/**
 * ledgerView.ts —— 渲染层共用的账目视图工具
 *
 * 职责（仅纯计算，不碰 DOM）：
 *   - classOfAccount：从账户名推断五大类（资产/负债/权益/收入/费用），兼容中英文前缀
 *   - computeLedgerSummary：按账户类别汇总 收入/支出/净额（ cents 计）
 *   - serializeTxnForCopy：把单笔交易序列化为 beancount 文本（供 finance-log 精准查询）
 *   - ledgerDisplayName：账本文件路径 → 友好名（账本/账本-2026.md → 2026 账本）
 *
 * 收入/支出的判定采用「账户类别」而非金额正负：
 *   收入类 leg 的 |amount| 计入收入；费用类 leg 的 |amount| 计入支出。
 *   这样余额结转类（equity:期初、资产:现金）不会污染收支统计。
 */

import type { AccountClass, AccountDef, BeancountLeg, FinanceConfig, Transaction } from '../types';
import { t } from '../i18n';
import {
  classOfAccount,
  findAccountDef,
  resolveAccountClass,
  legSignedCents,
  serializeTxnForCopy,
  type LegDirection,
} from '../shared/entry';

// 以下纯函数已抽到 src/shared/entry.ts（无 i18n / 无 App，供 CLI 共用）；此处 re-export 保持向后兼容。
export {
  classOfAccount,
  findAccountDef,
  resolveAccountClass,
  legSignedCents,
  serializeTxnForCopy,
};
export type { LegDirection };

/**
 * 子账户继承父账户定义：沿用父的 class / valuation / owner 等元数据，但保留自身账户名。
 * 精确命中时原样返回（不复制），供 `===` 身份比较仍然成立。
 */
export function resolveAccountDef(
  name: string,
  accounts: AccountDef[] | undefined,
): AccountDef | undefined {
  const def = findAccountDef(name, accounts);
  if (!def) return undefined;
  if (def.name === name) return def;
  return { ...def, name };
}

/**
 * 单条 leg 的方向标签：替代数字正负，按账户所属维度表达方向。
 * 资产/负债 → 余额增加/减少（legs.dir.in/out，借方为正记增加、贷方为负记增加，
 * 符号反转已在下方分支处理）；收入 → 来源，费用 → 去向，权益/未知 → 权益。
 * 借贷符号本身由账户类别推导，界面不出现 +/-。
 */
export function dirOfPost(leg: BeancountLeg, config?: FinanceConfig): { label: string; cls: string } {
  const c = resolveAccountClass(leg.account, config);
  const inc = leg.amount > 0;
  if (c === 'asset') return inc ? { label: t('legs.dir.in'), cls: 'in' } : { label: t('legs.dir.out'), cls: 'out' };
  if (c === 'liability') {
    // 负债：amount>0 为借方，表示负债余额减少（对净资产有利 → 绿色 in）；
    // amount<0 为贷方，表示负债余额增加（对净资产不利 → 红色 out）。
    return inc
      ? { label: t('legs.dir.out'), cls: 'in' }
      : { label: t('legs.dir.in'), cls: 'out' };
  }
  if (c === 'income') return { label: t('legs.dir.src'), cls: 'src' };
  if (c === 'expense') return { label: t('legs.dir.sink'), cls: 'sink' };
  return { label: t('legs.dir.flat'), cls: 'flat' };
}

export interface LedgerSummary {
  income: number; // 收入合计（cents，正数）
  expense: number; // 支出合计（cents，正数）
  net: number; // 净额 = 收入 - 支出（cents）
}

export function computeLedgerSummary(txs: Transaction[], config?: FinanceConfig): LedgerSummary {
  let income = 0;
  let expense = 0;
  for (const tx of txs) {
    for (const leg of tx.legs) {
      const cls = resolveAccountClass(leg.account, config);
      if (cls === 'income') income += Math.abs(leg.amount);
      else if (cls === 'expense') expense += Math.abs(leg.amount);
    }
  }
  return { income, expense, net: income - expense };
}

/** YYYY-MM-DD → 本地零点 Date */
export function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** 给 Date 加减天数（返回新对象） */
export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(d.getDate() + n);
  return r;
}

/** 以周一为起点的当周起始日 */
export function weekStart(d: Date): Date {
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const r = new Date(d);
  r.setDate(d.getDate() + diff);
  r.setHours(0, 0, 0, 0);
  return r;
}

/** Date → MM-DD */
export function fmtMD(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${m}-${day}`;
}

/** cents → "±¥x,xxx.xx" */
export function fmtCents(cents: number): string {
  const yuan = cents / 100;
  const sign = cents < 0 ? '-' : '+';
  return `${sign}¥${yuan.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** 账本文件路径 → 友好展示名：账本/账本-2026.md → 2026 账本；账本/账本.md → 账本 */
export function ledgerDisplayName(path: string): string {
  const file = path.split('/').pop() ?? path;
  const name = file.replace(/\.md$/i, '');
  const m = name.match(/^(.*?)-(\d{4}(?:-\d{2})?)$/);
  if (m) return `${m[2]} ${m[1]}`;
  return name;
}
