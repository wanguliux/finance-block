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

/** 账户名的层级分隔符（半角冒号 / 全角斜杠 / 半角斜杠） */
const SEP_RE = /[:／/]/;

/**
 * 账户定义查找：精确名 > 最长前缀父账户 > 无。
 *
 * 为什么要前缀匹配（《报告》#5 持仓级投资表现）：
 * 持仓采用**子账户**表达（`股票:腾讯` / `资产:股票:茅台`），一个标的一个子账户，
 * 成本 = 子账户账面余额、市值 = 子账户估值行、未实现 = 二者之差。子账户不会逐个写进
 * finance-config.json，故必须能从父账户 `股票`（valuation:'market'、cashflowRole:'growth'）
 * 继承计价方式与归属，否则子账户会掉进「未定义账户」兜底、估值行被完全忽略。
 *
 * 取**最长匹配**：同时存在 `股票` 与 `股票:港股` 时，`股票:港股:腾讯` 继承后者。
 */
export function findAccountDef(
  name: string,
  accounts: AccountDef[] | undefined,
): AccountDef | undefined {
  if (!accounts || accounts.length === 0) return undefined;

  const exact = accounts.find((a) => a.name === name);
  if (exact) return exact;

  // 最长前缀父账户：要求命中处正好是层级分隔符，避免「股票」误配「股票基金」
  let best: AccountDef | undefined;
  for (const def of accounts) {
    if (!name.startsWith(def.name)) continue;
    const nextChar = name.charAt(def.name.length);
    if (!SEP_RE.test(nextChar)) continue;
    if (!best || def.name.length > best.name.length) best = def;
  }
  return best;
}

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
 * 账户类别解析（权威来源 = finance-config.json 的 AccountDef.class）。
 *
 * 设计要点（《记账问题分析与引擎优化报告》P0 #3 根因）：
 * 默认账户「现金 / 工资 / 日常」等**没有类名前缀**，纯靠名字前缀推断会误判为 null，
 * 导致收入/支出汇总恒为 0、预算被资产交易污染。故 config 可用时优先用 AccountDef.class
 * （含子账户前缀继承）；config 缺省（单测 / 纯解析场景）才回退到名字前缀推断。
 */
export function resolveAccountClass(name: string, config?: FinanceConfig): AccountClass | null {
  const def = findAccountDef(name, config?.accounts);
  if (def) return def.class;
  return classOfAccount(name);
}

/**
 * 单条 leg 的方向标签：替代数字正负，按账户所属维度表达 流入/流出/来源/去向。
 * 与 fin-beancount.html / finance-log.html 原型保持一致（资产增减 → 流入/流出，
 * 收入 → 来源，费用 → 去向，权益 → 权益）。借贷符号本身由账户类别推导，界面不出现 +/-。
 */
export function dirOfPost(leg: BeancountLeg, config?: FinanceConfig): { label: string; cls: string } {
  const c = resolveAccountClass(leg.account, config);
  const inc = leg.amount > 0;
  if (c === 'asset') return inc ? { label: '流入', cls: 'in' } : { label: '流出', cls: 'out' };
  if (c === 'liability') return inc ? { label: '流出', cls: 'out' } : { label: '流入', cls: 'in' };
  if (c === 'income') return { label: '来源', cls: 'src' };
  if (c === 'expense') return { label: '去向', cls: 'sink' };
  return { label: '权益', cls: 'flat' };
}

/** 录入层：每条腿的方向（流入 in / 流出 out），语义上 = 账户余额增加 / 减少。 */
export type LegDirection = 'in' | 'out';

/**
 * 由「账户类别 + 方向」推导该腿的 signed 整数分。
 *
 * 借贷符号规则（《报告》原则 6 / P0 #2）：资产/费用增加记正（借），负债/权益/收入增加记负（贷）。
 * dir='in' 表示账户余额增加（取 natural-increase 符号），dir='out' 表示减少（反号）。
 * 录入时用户只填正数金额，符号由此函数统一推导，界面不出现 +/- 输入框。
 */
export function legSignedCents(
  account: string,
  amountCents: number,
  dir: LegDirection,
  config?: FinanceConfig,
): number {
  const cls = resolveAccountClass(account, config);
  const incSign = cls === 'income' || cls === 'liability' || cls === 'equity' ? -1 : 1;
  return dir === 'in' ? amountCents * incSign : -amountCents * incSign;
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
