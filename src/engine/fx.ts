/**
 * 汇率引擎（FX Conversion）
 *
 * 核心职责（参考《已确定设计点》§1 衍生设计：跨币种换算与汇率管理）：
 * 1. 管理用户自维护的汇率参考表（手动值，非实时行情）
 * 2. 跨币种金额折算：原始币种 → 默认币种
 * 3. 金额统一以"分"存储，汇率折算后取整
 *
 * 设计要点：
 * - 汇率由用户手动维护，改了就按新汇率重算视图
 * - fxRates 格式：{ "USD": 7.2 } 表示 1 USD = 7.2 CNY（默认币种）
 * - 所有折算结果取整（Math.round），避免分以下的精度问题
 */

import type { AmountInCents, CurrencyDef } from '../types';

// ─── 汇率管理 ──────────────────────────────────────────────────

/**
 * 获取指定币种对默认币种的汇率
 * @param fxRates 汇率表 { "USD": 7.2, "EUR": 7.8 }
 * @param currency 币种代码（如 "USD"）
 * @param baseCurrency 默认币种（如 "CNY"）
 * @returns 汇率值，默认币种返回 1，未知币种返回 1（视为等价）
 */
export function getFxRate(
  fxRates: Record<string, number>,
  currency: string,
  baseCurrency: string,
): number {
  if (currency === baseCurrency) return 1;
  return fxRates[currency] ?? 1;
}

/** 常用币种符号表（未知币种回退为代码本身） */
export const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: '¥',
  USD: '$',
  EUR: '€',
  JPY: '¥',
  GBP: '£',
  HKD: 'HK$',
  KRW: '₩',
  TWD: 'NT$',
};

/** 将币种代码转为展示符号（§1：报表按默认币种呈现）
 * @param customSymbols 用户自定义符号表（来自 currencies），优先级高于内置表
 */
export function currencySymbol(currency: string, customSymbols: Record<string, string> = {}): string {
  return customSymbols[currency] ?? CURRENCY_SYMBOLS[currency] ?? currency;
}

/**
 * 从币种列表派生汇率表（供 convertToBase 使用）。
 * @param currencies 币种列表（含默认币种）
 * @param baseCurrency 默认币种代码
 * @returns Record<code, rate>，仅含非默认币种；默认币种本身不入表（convertToBase 直接返回 1）
 */
export function buildFxRates(
  currencies: CurrencyDef[] | undefined,
  baseCurrency: string,
): Record<string, number> {
  const map: Record<string, number> = {};
  if (!currencies) return map;
  for (const c of currencies) {
    if (c.code === baseCurrency) continue;
    map[c.code] = c.rate ?? 1;
  }
  return map;
}

/** 从币种列表派生「代码 → 符号」查表（供 currencySymbol 使用） */
export function buildSymbolMap(currencies: CurrencyDef[] | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (!currencies) return map;
  for (const c of currencies) {
    if (c.symbol) map[c.code] = c.symbol;
  }
  return map;
}

/**
 * 将指定币种的金额折算为默认币种
 * @param amount 原始金额（分）
 * @param currency 原始币种
 * @param fxRates 汇率表
 * @param baseCurrency 默认币种
 * @returns 折算后的金额（分，取整）
 */
export function convertToBase(
  amount: AmountInCents,
  currency: string | undefined,
  fxRates: Record<string, number>,
  baseCurrency: string,
): AmountInCents {
  if (!currency || currency === baseCurrency) return amount;
  const rate = getFxRate(fxRates, currency, baseCurrency);
  return Math.round(amount * rate);
}
