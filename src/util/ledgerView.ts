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

import type { AccountClass, Transaction } from '../types';

// 账户名各段 → 五大类（中英文都支持，含常见别名与单复数）
// 账户名按 : ／ / 切分取各段匹配，故「费用:餐饮」「Expenses:Food」「资产／现金」都能命中。
const CLASS_MAP: Record<string, AccountClass> = {
  // 中文（含常见别名）
  '资产': 'asset',
  '负债': 'liability',
  '权益': 'equity',
  '收入': 'income',
  '收益': 'income',
  '营收': 'income',
  '费用': 'expense',
  '支出': 'expense',
  '花费': 'expense',
  // 英文（大小写不敏感，兼容单复数）
  'asset': 'asset',
  'assets': 'asset',
  'liability': 'liability',
  'liabilities': 'liability',
  'equity': 'equity',
  'equities': 'equity',
  'income': 'income',
  'incomes': 'income',
  'expense': 'expense',
  'expenses': 'expense',
};

export function classOfAccount(name: string): AccountClass | null {
  // 按冒号 / 全角斜杠 / 半角斜杠切分；资产类账户（资产/负债/权益）不参与收支统计，
  // 这里只需命中「收入/费用」段即可正确汇总。
  const segs = name.split(/[:／/]/).map((s) => s.trim().toLowerCase());
  for (const seg of segs) {
    const cls = CLASS_MAP[seg];
    if (cls) return cls;
  }
  return null;
}

export interface LedgerSummary {
  income: number; // 收入合计（cents，正数）
  expense: number; // 支出合计（cents，正数）
  net: number; // 净额 = 收入 - 支出（cents）
}

export function computeLedgerSummary(txs: Transaction[]): LedgerSummary {
  let income = 0;
  let expense = 0;
  for (const tx of txs) {
    for (const leg of tx.legs) {
      const cls = classOfAccount(leg.account);
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

/** 把单笔交易序列化为 beancount 纯文本（带 ^t- 块引用，便于 finance-log 按 id 精准查询） */
export function serializeTxnForCopy(txn: Transaction): string {
  const lines: string[] = [];
  const flag = txn.draft ? '!' : '*';
  const narr = txn.narration ?? '';
  lines.push(`${txn.date} ${flag} ${narr}`.trimEnd());

  for (const leg of txn.legs) {
    const amt = txn.currency ? `${leg.amount} ${txn.currency}` : `${leg.amount}`;
    lines.push(`  ${leg.account}  ${amt}`);
  }

  if (txn.txnType) lines.push(`  type: ${txn.txnType}`);
  if (txn.owner) lines.push(`  owner: ${txn.owner}`);
  if (txn.fields) {
    for (const [k, v] of Object.entries(txn.fields)) lines.push(`  ${k}: ${v}`);
  }
  if (txn.id && txn.id.startsWith('^t-')) lines.push(txn.id);

  return lines.join('\n');
}

/** 账本文件路径 → 友好展示名：账本/账本-2026.md → 2026 账本；账本/账本.md → 账本 */
export function ledgerDisplayName(path: string): string {
  const file = path.split('/').pop() ?? path;
  const name = file.replace(/\.md$/i, '');
  const m = name.match(/^(.*?)-(\d{4}(?:-\d{2})?)$/);
  if (m) return `${m[2]} ${m[1]}`;
  return name;
}
