/**
 * entry.ts —— 复式分录「构建 / 序列化」纯核心（无 App、无 i18n 依赖）
 *
 * 这是插件与 CLI 共用的唯一真相源：
 *   - 插件侧：util/ledgerView.ts 的 t-free 函数改从此处 re-export，录入弹窗 / 还款引擎复用。
 *   - CLI 侧：src/cli/index.ts 直接 import，bundle 时不带入 i18n / obsidian。
 *
 * 借贷符号规则（《记账问题分析与引擎优化报告》原则 6 / P0 #2）：
 *   资产/费用增加记正（借），负债/权益/收入增加记负（贷）。
 *   dir='in' = 账户余额增加（取 natural-increase 符号），dir='out' = 余额减少（反号）。
 */

import type { AccountClass, AccountDef, BeancountLeg, FinanceConfig, Transaction } from '../types';

// ─── 账户类别推断（与插件 util/ledgerView 完全一致） ──────────────

/** 账户名各段 → 五大类（中英文都支持，含常见别名与单复数） */
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
 * 子账户（股票:腾讯）从父账户继承 class / valuation / owner，故需前缀匹配。
 */
export function findAccountDef(
  name: string,
  accounts: AccountDef[] | undefined,
): AccountDef | undefined {
  if (!accounts || accounts.length === 0) return undefined;

  const exact = accounts.find((a) => a.name === name);
  if (exact) return exact;

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
 * 账户类别解析（权威来源 = finance-config.json 的 AccountDef.class）。
 * config 可用时优先 AccountDef.class（含子账户前缀继承）；缺省才回退名字前缀推断。
 */
export function resolveAccountClass(name: string, config?: FinanceConfig): AccountClass | null {
  const def = findAccountDef(name, config?.accounts);
  if (def) return def.class;
  return classOfAccount(name);
}

/** 录入层：每条腿的方向（增加 in / 减少 out），语义上 = 账户余额增加 / 减少。 */
export type LegDirection = 'in' | 'out';

/**
 * 由「账户类别 + 方向」推导该腿的 signed 整数分。
 * 录入时用户只填正数金额，符号由此函数统一推导，界面/CLI 不出现 +/-。
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

// ─── 块引用 ID（与插件 poster.generateBlockRefId 一致） ──────────
// 格式：^t-YYYYMMDDHHmmssNN（精确到秒 + 两位递增序号，确保批量时同秒内唯一）

let blockRefSeq = 0;
export function generateBlockRefId(date?: string): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const seq = String(blockRefSeq++ % 100).padStart(2, '0');

  const datePrefix = date ? date.replace(/-/g, '') : `${year}${month}${day}`;
  return `^t-${datePrefix}${hours}${minutes}${seconds}${seq}`;
}

// ─── 构建交易（自然语言 / CLI / 录入弹窗共用） ───────────────────

/** 单腿规格：用户只需给「账户 + in/out + 元」 */
export interface BuildLegSpec {
  account: string;
  dir: LegDirection;
  /** 金额（元，可小数）；与 cents 二选一，优先 cents */
  yuan?: number;
  cents?: number;
  /** 该腿原始币种后缀（可选，跨币种） */
  currency?: string;
}

export interface BuildTxnSpec {
  date: string; // YYYY-MM-DD
  narration?: string;
  type?: string; // 交易类型（transactionTypes 词表）
  owner?: string;
  legs: BuildLegSpec[];
  /** 整笔统一币种（可选）；若腿已带 currency 则腿优先 */
  currency?: string;
  /** 自定义元数据字段（如 period:期初 / opening:true），会序列化到账本 */
  fields?: Record<string, string>;
}

/**
 * 由结构化规格构建一笔 Transaction（含按账户类别推导的 signed 整数分）。
 * 不写入账本、不生成块引用——纯数据变换，供 serializeTxnForCopy 序列化或校验零和。
 * @throws 当腿不足 2 条、方向非法、金额非法时抛错。
 */
export function buildTxn(spec: BuildTxnSpec, config?: FinanceConfig): Transaction {
  if (!spec.legs || spec.legs.length < 2) {
    throw new Error('复式记账至少需要 2 条分录（leg）');
  }
  const legs: BeancountLeg[] = spec.legs.map((l) => {
    if (!l.account) throw new Error('leg 缺少账户');
    const dir = l.dir;
    if (dir !== 'in' && dir !== 'out') throw new Error(`leg 方向必须是 in/out：收到 ${String(dir)}`);
    let cents: number;
    if (typeof l.cents === 'number') cents = l.cents;
    else if (typeof l.yuan === 'number') cents = Math.round(l.yuan * 100);
    else throw new Error(`leg 金额非法（需 yuan 或 cents）：账户 ${l.account}`);
    const signed = legSignedCents(l.account, cents, dir as LegDirection, config);
    const legCurrency = l.currency ?? spec.currency;
    return {
      account: l.account,
      amount: signed,
      ...(legCurrency ? { currency: legCurrency } : {}),
    } as BeancountLeg;
  });

  return {
    id: '', // 块引用由调用方在序列化后附加（^t-...）
    date: spec.date,
    legs,
    ...(spec.narration ? { narration: spec.narration } : {}),
    ...(spec.type ? { txnType: spec.type } : {}),
    ...(spec.owner ? { owner: spec.owner } : {}),
    ...(spec.fields ? { fields: spec.fields } : {}),
  };
}

/**
 * 零和校验：所有 leg 推导后的整数分之和必须为零，否则报差额（分）。
 * 返回 0 表示平衡；非 0 表示不平衡的差额。
 */
export function zeroSumDiff(txn: Transaction): number {
  return txn.legs.reduce((sum, l) => sum + l.amount, 0);
}

/**
 * 把单笔交易序列化为 beancount 纯文本（带元数据行，便于 finance-log 按 id 精准查询）。
 * 不含 ^t- 块引用行——块引用由调用方在末尾附加。
 * 与插件 util/ledgerView.serializeTxnForCopy 同源（此处为无 i18n 副本入口，委托逻辑一致）。
 */
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
  // 末尾附块引用行（^t-...）：finance-log 按 id 精准定位这笔账
  if (txn.id && txn.id.startsWith('^t-')) lines.push(txn.id);
  return lines.join('\n');
}

/**
 * 构造一条资产估值指令行（与插件 UpdateValuationModal 同格式，单一真相源）：
 *   YYYY-MM-DD custom "fb-valuation" <账户名> <金额(分)> [币种]
 * 不含围栏与 ^v- 块引用（由入账方 appendEntryToContent 统一追加 ^v- 引用）。
 */
export function buildValuationText(
  date: string,
  account: string,
  amountCents: number,
  currency?: string,
): string {
  const suffix = currency ? ` ${currency}` : '';
  return `${date} custom "fb-valuation" ${account} ${amountCents}${suffix}`;
}
