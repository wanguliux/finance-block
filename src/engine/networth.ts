/**
 * networth.ts —— 净资产计算引擎（双口径 + 估值优先级 + stale 检测）
 *
 * 核心职责（参考《方案 · 资产管理设计》§7）：
 * 1. 账面口径（book）：= Σ 交易流水累加，供结转、对账使用
 * 2. 市值口径（market）：= Σ 按优先级解析后的账户价值，供 finance-assets / finance-fi 使用
 * 3. 未实现损益 = 市值口径 − 账面口径
 * 4. 估值过期（stale）标记：提醒用户更新估值
 *
 * 估值解析优先级（一条规则贯穿全部）：
 *   1. 手动估值行（该账户日期最新的一条）
 *   2. 折旧派生值（仅 valuation: 'depreciation' 且无更晚手动估值时）
 *   3. 账面余额（兜底）
 *
 * 纯函数模块，不依赖 Obsidian API，可直接测试。
 */

import type {
  AccountDef,
  AmountInCents,
  DepreciationDef,
  Valuation,
} from '../types';
import { currentValue } from './fiCalc';
import { convertToBase } from './fx';

// ─── 类型 ──────────────────────────────────────────────────────

/** 单个账户的价值解析结果 */
export interface AccountValue {
  account: string;          // 账户名
  bookValue: AmountInCents; // 账面余额（流水累加）
  marketValue: AmountInCents; // 市值（按优先级解析）
  unrealizedPnL: AmountInCents; // 未实现损益 = marketValue - bookValue
  source: 'valuation' | 'depreciation' | 'book'; // 市值来源
  valuationDate?: string;   // 最新估值日期（YYYY-MM-DD，仅 source=valuation 时有值）
  isStale: boolean;         // 估值是否过期
  currency?: string;        // 估值行的原始币种（仅 source=valuation 时可能有值）
  owner?: string;           // 账户归属
  valuationType: 'book' | 'market' | 'depreciation'; // 账户配置的计价方式
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
}

// ─── 辅助 ──────────────────────────────────────────────────────

/** 取该账户最新的一条估值行（按日期降序取第一条） */
function getLatestValuation(
  valuations: Valuation[],
  account: string,
): Valuation | undefined {
  const matches = valuations.filter((v) => v.account === account);
  if (matches.length === 0) return undefined;
  return matches.reduce((latest, v) => (v.date > latest.date ? v : latest));
}

/** 折旧派生当前值（含残值支持） */
function depreciationValue(def: DepreciationDef, today: Date): AmountInCents {
  const salvage = def.salvageValue ?? 0;
  const depreciable = def.purchasePrice - salvage;
  if (depreciable <= 0) return def.purchasePrice; // 残值 >= 购价，不折旧

  const val = currentValue(def.purchasePrice, def.purchaseDate, def.usefulLifeYears, today);
  // currentValue 最低到 0，但有了残值后最低应为 salvageValue
  return Math.max(salvage, val);
}

/** 计算两个日期之间相差的天数 */
function daysBetween(a: string, b: string): number {
  const da = new Date(a);
  const db = new Date(b);
  return Math.abs(Math.round((db.getTime() - da.getTime()) / 86400000));
}

// ─── 主函数 ────────────────────────────────────────────────────

/**
 * 解析单个账户的当前价值（按优先级：手动估值 > 折旧 > 账面）。
 *
 * @param accountDef 账户配置
 * @param bookBalance 该账户的账面余额（流水累加，分）
 * @param valuations 所有估值行（Indexer.getValuations()）
 * @param staleDaysDefault 全局估值过期阈值（天）
 * @param today 参考日期（默认今天）
 * @param fxRates 汇率表
 * @param baseCurrency 基准币种
 */
export function resolveAccountValue(
  accountDef: AccountDef,
  bookBalance: AmountInCents,
  valuations: Valuation[],
  staleDaysDefault: number,
  today: Date = new Date(),
  fxRates: Record<string, number> = {},
  baseCurrency: string = 'CNY',
): AccountValue {
  const vType = accountDef.valuation ?? 'book';
  const staleDays = accountDef.staleDays ?? staleDaysDefault;
  const todayStr = today.toISOString().slice(0, 10);

  const base: AccountValue = {
    account: accountDef.name,
    bookValue: bookBalance,
    marketValue: bookBalance,
    unrealizedPnL: 0,
    source: 'book',
    isStale: false,
    owner: accountDef.owner,
    valuationType: vType,
  };

  // book 计价：直接用账面余额，永不 stale
  if (vType === 'book') return base;

  // 尝试手动估值行（最高优先级）
  const latestVal = getLatestValuation(valuations, accountDef.name);
  if (latestVal) {
    // 估值行金额折算为基准币种
    const valInBase = convertToBase(latestVal.amount, latestVal.currency, fxRates, baseCurrency);
    const isStale = daysBetween(latestVal.date, todayStr) > staleDays;
    return {
      ...base,
      marketValue: valInBase,
      unrealizedPnL: valInBase - bookBalance,
      source: 'valuation',
      valuationDate: latestVal.date,
      isStale,
      currency: latestVal.currency,
    };
  }

  // 尝试折旧派生值（仅 depreciation 类账户）
  if (vType === 'depreciation' && accountDef.depreciation) {
    const depVal = depreciationValue(accountDef.depreciation, today);
    return {
      ...base,
      marketValue: depVal,
      unrealizedPnL: depVal - bookBalance,
      source: 'depreciation',
      isStale: false, // 折旧自动派生，不存在 stale
    };
  }

  // market 类账户无估值行、非折旧 → 回退账面并标记 stale
  return {
    ...base,
    source: 'book',
    isStale: true, // market 类无估值行 = 需要更新
  };
}

/**
 * 计算净资产（双口径：账面 + 市值）。
 *
 * @param accountDefs 所有账户配置
 * @param balances 各账户账面余额 Map<账户名, 分>
 * @param valuations 所有估值行
 * @param staleDaysDefault 全局估值过期阈值（天）
 * @param today 参考日期
 * @param fxRates 汇率表
 * @param baseCurrency 基准币种
 * @param ownerFilter 可选归属筛选（省略=合并全部）
 */
export function computeNetWorth(
  accountDefs: AccountDef[],
  balances: Map<string, AmountInCents>,
  valuations: Valuation[],
  staleDaysDefault: number,
  today: Date = new Date(),
  fxRates: Record<string, number> = {},
  baseCurrency: string = 'CNY',
  ownerFilter?: string,
): NetWorthResult {
  const accounts: AccountValue[] = [];

  // 按归属筛选账户
  const filtered = ownerFilter
    ? accountDefs.filter((a) => (a.owner ?? '自己') === ownerFilter)
    : accountDefs;

  for (const def of filtered) {
    const bookBalance = balances.get(def.name) ?? 0;
    const resolved = resolveAccountValue(
      def, bookBalance, valuations, staleDaysDefault, today, fxRates, baseCurrency,
    );
    accounts.push(resolved);
  }

  // 也包含未在 accountDefs 中定义但有交易余额的账户（兼容旧数据）
  const knownNames = new Set(filtered.map((a) => a.name));
  for (const [name, balance] of balances) {
    if (knownNames.has(name)) continue;
    accounts.push({
      account: name,
      bookValue: balance,
      marketValue: balance,
      unrealizedPnL: 0,
      source: 'book',
      isStale: false,
      valuationType: 'book',
    });
  }

  // 汇总（负债账户余额通常为负数，取绝对值）
  let bookAssets = 0;
  let bookLiabilities = 0;
  let marketAssets = 0;
  let marketLiabilities = 0;
  let totalUnrealizedPnL = 0;
  let staleCount = 0;

  for (const av of accounts) {
    if (av.bookValue >= 0) {
      bookAssets += av.bookValue;
      marketAssets += av.marketValue;
    } else {
      bookLiabilities += Math.abs(av.bookValue);
      marketLiabilities += Math.abs(av.marketValue);
    }
    totalUnrealizedPnL += av.unrealizedPnL;
    if (av.isStale) staleCount++;
  }

  return {
    bookAssets,
    bookLiabilities,
    bookNetWorth: bookAssets - bookLiabilities,
    marketAssets,
    marketLiabilities,
    marketNetWorth: marketAssets - marketLiabilities,
    totalUnrealizedPnL,
    accounts,
    staleCount,
  };
}
