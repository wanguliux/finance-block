/**
 * networth.ts —— 净资产计算引擎（双口径 + 估值结转 + 类别汇总 + 历史序列）
 *
 * 核心职责（参考《方案 · 资产管理设计》§7 与《记账问题分析与引擎优化报告》五·附）：
 * 1. 账面口径（book）：= Σ 交易流水累加，供结转、对账使用
 * 2. 市值口径（market）：= Σ 按优先级解析后的账户价值，供 finance-assets / ficalc 使用
 * 3. 未实现损益 = 市值口径 − 账面口径
 * 4. 估值过期（stale）标记：提醒用户更新估值
 * 5. 权益对账（#7）：校验「资产−负债 == 权益 + 本期留存收益」这一结构恒等式
 * 6. 历史序列（#8）：按任意日期切片重算净资产，驱动净资产 / 组合曲线
 *
 * 估值解析优先级（一条规则贯穿全部）：
 *   1. 手动估值行（该账户 asOf 之前日期最新的一条）→ 再按其后的交易做**结转推演**
 *   2. 账面余额（兜底）
 *
 * 注（2026-08-04 终版）：折旧派生（valuation: 'depreciation'）已废弃——
 * 资产价值由账本流水驱动（book），用户拍板「能记账就记账」，不再有折旧派生分支。
 *
 * 纯函数模块，不依赖 Obsidian API，可直接测试。
 */

import type {
  AccountClass,
  AccountDef,
  AmountInCents,
  Valuation,
} from '../types';
import { convertToBase } from './fx';
import { resolveAccountDef } from '../util/ledgerView';

// ─── 类型 ──────────────────────────────────────────────────────

/** 账户上的一笔资金流动（带符号：正=增加，负=减少），供估值结转推演使用 */
export interface AccountFlow {
  date: string; // YYYY-MM-DD
  amount: AmountInCents;
}

/** 单个账户的价值解析结果 */
export interface AccountValue {
  account: string;          // 账户名
  accountClass: AccountClass | null; // 五大类归属（含子账户前缀继承）；null = 未分类
  bookValue: AmountInCents; // 账面余额（流水累加）
  marketValue: AmountInCents; // 市值（按优先级解析 + 结转推演）
  unrealizedPnL: AmountInCents; // 未实现损益 = marketValue - bookValue
  source: 'valuation' | 'book'; // 市值来源（depreciation 派生已废弃，见文件头注）
  valuationDate?: string;   // 最新估值日期（YYYY-MM-DD，仅 source=valuation 时有值）
  isStale: boolean;         // 估值是否过期
  currency?: string;        // 估值行的原始币种（仅 source=valuation 时可能有值）
  owner?: string;           // 账户归属
  valuationType: 'book' | 'market'; // 账户配置的计价方式
  /** 估值日之后被结转推演的交易笔数（>0 表示市值已按后续买卖自动调整，见 #4） */
  carriedFlows: number;
}

/** 净资产汇总结果 */
export interface NetWorthResult {
  /** 账面口径 */
  bookAssets: AmountInCents;
  bookLiabilities: AmountInCents;
  bookNetWorth: AmountInCents;
  /** 市值口径 */
  marketAssets: AmountInCents;
  marketLiabilities: AmountInCents;
  marketNetWorth: AmountInCents;
  /** 未实现损益合计 */
  totalUnrealizedPnL: AmountInCents;
  /** 逐账户明细 */
  accounts: AccountValue[];
  /** 过期估值账户数 */
  staleCount: number;

  // ── 权益 / 结转建模（#7） ──
  /** 权益类账户余额合计（贷方为负，原始符号） */
  equityBalance: AmountInCents;
  /** 收入类账户余额合计（贷方为负，原始符号） */
  incomeBalance: AmountInCents;
  /** 费用类账户余额合计（借方为正，原始符号） */
  expenseBalance: AmountInCents;
  /** 本期留存收益 = −(收入余额 + 费用余额)，即「收入 − 支出」的正向表达 */
  retainedEarnings: AmountInCents;
  /** 权益合计（含留存收益）= −权益余额 + 留存收益 */
  totalEquity: AmountInCents;
  /** 对账差额 = 账面净资产 − 权益合计；结构恒等式成立时应为 0 */
  reconciliationDiff: AmountInCents;
  /** 未能归类（既不在 config 也无法从名字推断）的账户数 */
  unclassifiedCount: number;
}

/** 净资产历史曲线上的一个点（#8） */
export interface NetWorthPoint {
  date: string;
  bookNetWorth: AmountInCents;
  marketNetWorth: AmountInCents;
  totalUnrealizedPnL: AmountInCents;
}

/** 单账户价值解析的上下文参数 */
export interface ResolveContext {
  /** 全部估值行（内部会按账户 + asOf 过滤） */
  valuations: Valuation[];
  /** 全局估值过期阈值（天） */
  staleDaysDefault: number;
  /** 参考日期（用于 stale 判定），默认今天 */
  today?: Date;
  fxRates?: Record<string, number>;
  baseCurrency?: string;
  /** 计算基准日 YYYY-MM-DD：晚于该日的估值与流水一律忽略（历史切片用），缺省=不限制 */
  asOf?: string;
}

// ─── 辅助 ──────────────────────────────────────────────────────

/** YYYY-MM-DD */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 取该账户在 asOf 之前（含当日）日期最新的一条估值行。
 * 同日多条时取靠后出现的一条（账本里后写的覆盖先写的）。
 */
function getLatestValuation(
  valuations: Valuation[],
  account: string,
  asOf?: string,
): Valuation | undefined {
  let best: Valuation | undefined;
  for (const v of valuations) {
    if (v.account !== account) continue;
    if (asOf && v.date > asOf) continue;
    if (!best || v.date >= best.date) best = v;
  }
  return best;
}

/** 该账户全部估值行，按日期升序（#8 时间序列） */
export function getValuationSeries(valuations: Valuation[], account: string): Valuation[] {
  return valuations
    .filter((v) => v.account === account)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** 计算两个日期之间相差的天数 */
function daysBetween(a: string, b: string): number {
  const da = new Date(a);
  const db = new Date(b);
  return Math.abs(Math.round((db.getTime() - da.getTime()) / 86400000));
}

/**
 * 估值结转推演（《报告》#4 幽灵收益根治）。
 *
 * 问题：买腾讯 10000 → 估值 13000 → 卖出后账面归零，但估值行仍写着 13000，
 * 引擎照旧显示「市值 13000 / 账面 0 / 未实现 +13000」，净资产凭空虚高。
 *
 * 解法：把估值日之后发生在该账户上的交易按时间顺序推演到估值上——
 *   - **增持（正流水）按成本加**：新投入的钱以成本计价，不该让它按旧涨幅放大；
 *   - **减持（负流水）按比例扣**：卖掉持仓的 x%，成本与市值同比例离场。
 * 于是「全部卖出 → 账面 0 → 市值自动归零」，无需用户手工删估值行；
 * 部分卖出也按比例缩减，不再残留幽灵浮盈。
 *
 * @param valuationAmount 估值行金额（已折算基准币种）
 * @param bookNow         当前（asOf）账面余额
 * @param flowsAfter      估值日之后、asOf 之前的该账户流水，按日期升序
 */
export function carryForwardValuation(
  valuationAmount: AmountInCents,
  bookNow: AmountInCents,
  flowsAfter: AccountFlow[],
): { marketValue: AmountInCents; carried: number } {
  // 账面已清空 → 持仓已全部离场，市值必然为 0（硬地板，兜住舍入残差）
  if (bookNow === 0) {
    return { marketValue: 0, carried: flowsAfter.length };
  }
  if (flowsAfter.length === 0) {
    return { marketValue: valuationAmount, carried: 0 };
  }

  // 反推估值日当天的账面余额，再顺序推演
  const delta = flowsAfter.reduce((s, f) => s + f.amount, 0);
  let book = bookNow - delta;
  let mv = valuationAmount;

  for (const f of flowsAfter) {
    if (f.amount >= 0) {
      // 增持：按成本加入
      mv += f.amount;
      book += f.amount;
    } else {
      // 减持：按持仓占比同比例扣减市值
      if (book > 0) {
        const frac = Math.min(1, -f.amount / book);
        mv -= Math.round(mv * frac);
      }
      book += f.amount;
    }
  }

  return { marketValue: mv, carried: flowsAfter.length };
}

/** 从交易列表构建「账户 → 按日期升序的流水」映射（供结转推演与历史切片使用） */
export function buildAccountFlows(
  txns: Array<{ date: string; legs: Array<{ account: string; amount: AmountInCents }> }>,
): Map<string, AccountFlow[]> {
  const map = new Map<string, AccountFlow[]>();
  for (const txn of txns) {
    for (const leg of txn.legs) {
      let arr = map.get(leg.account);
      if (!arr) {
        arr = [];
        map.set(leg.account, arr);
      }
      arr.push({ date: txn.date, amount: leg.amount });
    }
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
  return map;
}

/**
 * 已实现收益归集（《报告》#5 / #6 —— 投资表现的另一半）。
 *
 * 复式记账里「卖出获利」的第三腿会落到 `收入:投资收益`（亏损落 `支出:投资亏损`），
 * 但这笔钱是**哪只持仓赚的**只能靠同一笔交易内的对手腿反推：
 *   同一交易中若存在「减持的非 book 计价资产腿」，则该交易的净损益归属于它；
 *   多只同时减持时按减持金额占比分摊。
 *
 * 之所以限定「非 book 计价」，是为了避开还贷这类干扰——
 * `资产:活期 -3000 / 负债:房贷 +2500 / 支出:利息 +500` 里活期也是负腿，
 * 但它是 book 计价的现金账户，不该被算成「亏了 500 的持仓」。
 *
 * @param txns        已入账交易
 * @param accountDefs 账户配置（子账户走前缀继承）
 * @returns Map<资产账户名, 已实现收益（分，正=盈利）>
 */
export function computeRealizedPnL(
  txns: Array<{ date: string; legs: Array<{ account: string; amount: AmountInCents }> }>,
  accountDefs: AccountDef[],
): Map<string, AmountInCents> {
  const out = new Map<string, AmountInCents>();
  const defCache = new Map<string, AccountDef | undefined>();
  const defOf = (name: string): AccountDef | undefined => {
    if (!defCache.has(name)) defCache.set(name, resolveAccountDef(name, accountDefs));
    return defCache.get(name);
  };

  for (const txn of txns) {
    let pnl = 0;                       // 本笔交易的净损益（正=赚）
    const sold: Array<{ account: string; weight: number }> = [];
    let weightSum = 0;

    for (const leg of txn.legs) {
      const def = defOf(leg.account);
      const cls = def?.class;
      if (cls === 'income') pnl -= leg.amount;   // 收入贷方为负 → 取负转正
      else if (cls === 'expense') pnl -= leg.amount; // 费用借方为正 → 取负转亏
      else if (cls === 'asset' && leg.amount < 0 && (def?.valuation ?? 'book') !== 'book') {
        const w = -leg.amount;
        sold.push({ account: leg.account, weight: w });
        weightSum += w;
      }
    }

    if (pnl === 0 || sold.length === 0 || weightSum <= 0) continue;

    // 按减持金额占比分摊，最后一只兜掉舍入残差，保证合计守恒
    let allocated = 0;
    sold.forEach((s, i) => {
      const share =
        i === sold.length - 1 ? pnl - allocated : Math.round((pnl * s.weight) / weightSum);
      allocated += share;
      out.set(s.account, (out.get(s.account) ?? 0) + share);
    });
  }

  return out;
}

/** 账面余额切片：Σ 该账户在 asOf（含当日）之前的流水 */
export function bookBalanceAt(flows: AccountFlow[] | undefined, asOf?: string): AmountInCents {
  if (!flows) return 0;
  let sum = 0;
  for (const f of flows) {
    if (asOf && f.date > asOf) continue;
    sum += f.amount;
  }
  return sum;
}

// ─── 主函数 ────────────────────────────────────────────────────

/**
 * 解析单个账户的当前价值（按优先级：手动估值 + 结转推演 > 折旧 > 账面）。
 *
 * @param accountDef  账户配置（子账户可由 resolveAccountDef 从父账户继承而来）
 * @param bookBalance 该账户的账面余额（流水累加，分）
 * @param ctx         解析上下文
 * @param flows       该账户的流水（升序），用于估值结转推演；缺省则不结转
 */
export function resolveAccountValue(
  accountDef: AccountDef,
  bookBalance: AmountInCents,
  ctx: ResolveContext,
  flows?: AccountFlow[],
): AccountValue {
  const vType = accountDef.valuation ?? 'book';
  const staleDays = accountDef.staleDays ?? ctx.staleDaysDefault;
  const today = ctx.today ?? new Date();
  const refDate = ctx.asOf ?? ymd(today);
  const fxRates = ctx.fxRates ?? {};
  const baseCurrency = ctx.baseCurrency ?? 'CNY';

  const base: AccountValue = {
    account: accountDef.name,
    accountClass: accountDef.class,
    bookValue: bookBalance,
    marketValue: bookBalance,
    unrealizedPnL: 0,
    source: 'book',
    isStale: false,
    owner: accountDef.owner,
    valuationType: vType,
    carriedFlows: 0,
  };

  // book 计价：直接用账面余额，永不 stale
  if (vType === 'book') return base;

  // 尝试手动估值行（最高优先级）
  const latestVal = getLatestValuation(ctx.valuations, accountDef.name, ctx.asOf);
  if (latestVal) {
    // 估值行金额折算为基准币种
    const valInBase = convertToBase(latestVal.amount, latestVal.currency, fxRates, baseCurrency);

    // 估值日之后（且不晚于基准日）的流水 → 结转推演，根治幽灵收益（#4）
    const flowsAfter = (flows ?? []).filter(
      (f) => f.date > latestVal.date && (!ctx.asOf || f.date <= ctx.asOf),
    );
    const { marketValue, carried } = carryForwardValuation(valInBase, bookBalance, flowsAfter);

    const isStale = daysBetween(latestVal.date, refDate) > staleDays;
    return {
      ...base,
      marketValue,
      unrealizedPnL: marketValue - bookBalance,
      source: 'valuation',
      valuationDate: latestVal.date,
      // 估值后又发生了交易 → 即便未超期也提示需要复核（结转值是推算而非实价）
      isStale: isStale || carried > 0,
      currency: latestVal.currency,
      carriedFlows: carried,
    };
  }

  // market 类账户无估值行：「估值已过期」只在「账户里确实持有资产」时才成立。
  // 规则（修复：空账户 / 未入账资产 不应误报过期）：
  //   ① 空账户（账面为 0 / 从未入账任何资产）→ 尚未开始使用，不提示过期；
  //   ② 已入账资产，但距「首笔入账日」未超过 staleDays → 仍在宽限期内，不提示；
  //   ③ 已入账资产且超过 staleDays 仍未估值 → 该去更新估值了。
  // 即过期时钟从「第一笔资产入账」那一刻起算，而非从「当前没有估值行」起算。
  if (bookBalance === 0) {
    return { ...base, source: 'book', isStale: false };
  }
  const flowsUpToRef = (flows ?? []).filter((f) => !ctx.asOf || f.date <= ctx.asOf);
  const sinceFirst = flowsUpToRef.length > 0 ? daysBetween(flowsUpToRef[0].date, refDate) : 0;
  return {
    ...base,
    source: 'book',
    isStale: sinceFirst > staleDays,
  };
}

/**
 * 计算净资产（双口径：账面 + 市值），并按**账户类别**汇总。
 *
 * #7 关键修正：旧实现用 `bookValue >= 0` 判定资产 / 负债——现金账户透支为负会被
 * 算成负债、超额还款的负债账户会被算成资产，净资产双向失真。现改为一律按
 * `AccountDef.class` 归类（子账户从父账户继承），并顺带算出权益对账差额。
 *
 * @param accountDefs 所有账户配置
 * @param balances    各账户账面余额 Map<账户名, 分>
 * @param ctx         解析上下文
 * @param opts        flows（估值结转用）/ ownerFilter（归属筛选）
 */
export function computeNetWorth(
  accountDefs: AccountDef[],
  balances: Map<string, AmountInCents>,
  ctx: ResolveContext,
  opts: { flows?: Map<string, AccountFlow[]>; ownerFilter?: string } = {},
): NetWorthResult {
  const { flows, ownerFilter } = opts;
  const accounts: AccountValue[] = [];

  // 按归属筛选账户
  const filtered = ownerFilter
    ? accountDefs.filter((a) => (a.owner ?? '自己') === ownerFilter)
    : accountDefs;

  for (const def of filtered) {
    const bookBalance = balances.get(def.name) ?? 0;
    accounts.push(resolveAccountValue(def, bookBalance, ctx, flows?.get(def.name)));
  }

  // 账本里出现、但未在 accountDefs 中显式声明的账户：
  // 优先从父账户继承（持仓子账户 `股票:腾讯` 走这条，见 #5），否则记为未分类。
  const knownNames = new Set(filtered.map((a) => a.name));
  for (const [name, balance] of balances) {
    if (knownNames.has(name)) continue;

    const inherited = resolveAccountDef(name, filtered);
    if (inherited) {
      accounts.push(resolveAccountValue(inherited, balance, ctx, flows?.get(name)));
      continue;
    }
    // 归属筛选开启时，未声明账户无法判断归属 → 不纳入（避免把他人账户混进来）
    if (ownerFilter) continue;

    accounts.push({
      account: name,
      accountClass: null,
      bookValue: balance,
      marketValue: balance,
      unrealizedPnL: 0,
      source: 'book',
      isStale: false,
      valuationType: 'book',
      carriedFlows: 0,
    });
  }

  // ── 按类别汇总（负债 / 权益 / 收入以贷方为负存储，取负号转正向口径）──
  let bookAssets = 0;
  let bookLiabilities = 0;
  let marketAssets = 0;
  let marketLiabilities = 0;
  let totalUnrealizedPnL = 0;
  let staleCount = 0;
  let equityBalance = 0;
  let incomeBalance = 0;
  let expenseBalance = 0;
  let unclassifiedCount = 0;

  for (const av of accounts) {
    switch (av.accountClass) {
      case 'asset':
        bookAssets += av.bookValue;
        marketAssets += av.marketValue;
        totalUnrealizedPnL += av.unrealizedPnL;
        break;
      case 'liability':
        bookLiabilities += -av.bookValue;
        marketLiabilities += -av.marketValue;
        totalUnrealizedPnL += av.unrealizedPnL;
        break;
      case 'equity':
        equityBalance += av.bookValue;
        break;
      case 'income':
        incomeBalance += av.bookValue;
        break;
      case 'expense':
        expenseBalance += av.bookValue;
        break;
      default:
        // 未分类账户：退回余额正负兜底，同时计数供 UI 提示补配置
        unclassifiedCount++;
        if (av.bookValue >= 0) {
          bookAssets += av.bookValue;
          marketAssets += av.marketValue;
        } else {
          bookLiabilities += -av.bookValue;
          marketLiabilities += -av.marketValue;
        }
        totalUnrealizedPnL += av.unrealizedPnL;
    }
    if (av.isStale) staleCount++;
  }

  const bookNetWorth = bookAssets - bookLiabilities;
  // 结构恒等式：Σ全部账户余额 = 0 ⇒ 资产 + 负债 + 权益 + 收入 + 费用 = 0（含符号）
  // ⇒ 账面净资产 = −(权益余额 + 收入余额 + 费用余额)
  const retainedEarnings = -(incomeBalance + expenseBalance);
  const totalEquity = -equityBalance + retainedEarnings;

  return {
    bookAssets,
    bookLiabilities,
    bookNetWorth,
    marketAssets,
    marketLiabilities,
    marketNetWorth: marketAssets - marketLiabilities,
    totalUnrealizedPnL,
    accounts,
    staleCount,
    equityBalance,
    incomeBalance,
    expenseBalance,
    retainedEarnings,
    totalEquity,
    reconciliationDiff: bookNetWorth - totalEquity,
    unclassifiedCount,
  };
}

/**
 * 净资产历史序列（#8）：按给定日期逐点重算净资产。
 *
 * 每个切片都用「该日之前的流水累加」作账面、「该日之前最新估值 + 结转推演」作市值，
 * 因此曲线上的每一点都与当时的真实账目一致，不会被今天的估值行倒灌回历史。
 *
 * @param accountDefs 所有账户配置
 * @param flows       账户流水映射（buildAccountFlows 产出）
 * @param dates       采样日期（YYYY-MM-DD），内部会排序去重
 */
export function computeNetWorthSeries(
  accountDefs: AccountDef[],
  flows: Map<string, AccountFlow[]>,
  dates: string[],
  ctx: Omit<ResolveContext, 'asOf'>,
  ownerFilter?: string,
): NetWorthPoint[] {
  const sorted = Array.from(new Set(dates)).sort();
  const allNames = new Set<string>([...accountDefs.map((a) => a.name), ...flows.keys()]);

  return sorted.map((date) => {
    const balances = new Map<string, AmountInCents>();
    for (const name of allNames) {
      balances.set(name, bookBalanceAt(flows.get(name), date));
    }
    const snap = computeNetWorth(accountDefs, balances, { ...ctx, asOf: date }, { flows, ownerFilter });
    return {
      date,
      bookNetWorth: snap.bookNetWorth,
      marketNetWorth: snap.marketNetWorth,
      totalUnrealizedPnL: snap.totalUnrealizedPnL,
    };
  });
}
