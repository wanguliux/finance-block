/*
 * assetBuckets.ts —— 资产现金流分桶（阶段二）
 *
 * 把异构账户按现金流行为分类，喂给现金流引擎。纯函数，不依赖 Obsidian API。
 *
 * 桶定义（与方案 §2.2 对齐）：
 *   growth 生息增长：股票/基金/理财 → 按 rate 复利、退休支取
 *   cash   现金类  ：存款/货基/现金 → 留应急金缓冲后，余额按现金收益率（默认 1.5%）并入 P
 *   fixed  非生息  ：车/电子/自住房 → 进净资产曲线、不供养退休
 *   rental 出租房  ：市值进净资产；租金现金流为后续增强（当前未建模，见开放项）
 *   liability 负债：抵减净资产
 *
 * 缺省推断（未显式设 cashflowRole 时）：按 valuation 智能推断——
 *   depreciation → fixed；market → growth；book/未设 → cash（保守低收益）。
 * 负债（class=liability）恒进负债桶。
 *
 * 应急金缓冲 = bufferMonths × 年支出 / 12（不增长）；现金桶超缓冲部分才并入生息本金。
 */

import type {
  AccountDef,
  AmountInCents,
  CashflowRole,
  FinanceConfig,
  Valuation,
} from '../types';
import { computeNetWorth } from './networth';
import { buildFxRates } from './fx';

export interface AssetBuckets {
  /** 生息增长类市值（分） */
  growthValue: AmountInCents;
  /** 现金类市值（分，含应急金缓冲前） */
  cashValue: AmountInCents;
  /** 非生息资产市值（分，车/电子/自住房） */
  fixedValue: AmountInCents;
  /** 出租房市值（分） */
  rentalValue: AmountInCents;
  /** 负债市值绝对值（分） */
  liabilities: AmountInCents;
  /** 应急金缓冲（分）= bufferMonths × 年支出 / 12 */
  emergencyBuffer: AmountInCents;
  /** 生息本金（分）= growth + cash − 应急金缓冲（下限 0） */
  interestPrincipal: AmountInCents;
  /** 现金桶中超应急金的部分（分，按现金收益率增长） */
  cashAboveBuffer: AmountInCents;
  /** 非生息资产（固定+出租，分）—— 进净资产线、不供养退休 */
  nonInterestAssets: AmountInCents;
  /** 净资产（分）= interestPrincipal + 非生息资产 − 负债 */
  netWorth: AmountInCents;
}

export interface BucketOpts {
  /** 年支出（分），用于算应急金缓冲 */
  annualSpend?: AmountInCents;
  /** 应急金月数（默认 6） */
  bufferMonths?: number;
}

type ResolvedRole = CashflowRole | 'liability';

/** 解析账户的最终现金流角色：显式 cashflowRole 优先，否则按 valuation/类别智能推断 */
function resolveRole(def: AccountDef | undefined, cls: string | undefined): ResolvedRole {
  if (cls === 'liability') return 'liability';
  if (def?.cashflowRole) return def.cashflowRole;
  if (def?.valuation === 'depreciation') return 'fixed';
  if (def?.valuation === 'market') return 'growth';
  // book / 未设置：保守视为现金类（低收益）
  return 'cash';
}

/**
 * 将账户按现金流行为分桶。
 *
 * @param config 插件配置（含 accounts / currencies / baseCurrency / defaultStaleDays）
 * @param balances 各账户账面余额 Map<账户名, 分>（基准币种）
 * @param valuations 所有估值行
 * @param ownerFilter 可选归属筛选（省略=合并全部）
 * @param opts 应急金月数 / 年支出
 */
export function bucketAssets(
  config: FinanceConfig,
  balances: Map<string, AmountInCents>,
  valuations: Valuation[],
  ownerFilter?: string,
  opts: BucketOpts = {},
): AssetBuckets {
  const staleDaysDefault = config.defaultStaleDays ?? 30;
  const baseCurrency = config.baseCurrency ?? 'CNY';
  const fxRates = buildFxRates(config.currencies, baseCurrency);
  const result = computeNetWorth(
    config.accounts,
    balances,
    valuations,
    staleDaysDefault,
    new Date(),
    fxRates,
    baseCurrency,
    ownerFilter,
  );

  let growthValue = 0;
  let cashValue = 0;
  let fixedValue = 0;
  let rentalValue = 0;
  let liabilities = 0;

  const defByName = new Map(config.accounts.map((a) => [a.name, a] as const));
  for (const av of result.accounts) {
    const def = defByName.get(av.account);
    const role = resolveRole(def, def?.class);
    const mv = av.marketValue;
    if (role === 'liability') liabilities += Math.abs(mv);
    else if (role === 'growth') growthValue += mv;
    else if (role === 'cash') cashValue += mv;
    else if (role === 'fixed') fixedValue += mv;
    else if (role === 'rental') rentalValue += mv;
  }

  const bufferMonths = opts.bufferMonths ?? 6;
  const annualSpend = opts.annualSpend ?? 0;
  const emergencyBuffer = Math.round((annualSpend * bufferMonths) / 12);
  const cashAboveBuffer = Math.max(0, cashValue - emergencyBuffer);
  const interestPrincipal = Math.max(0, growthValue + cashValue - emergencyBuffer);
  const nonInterestAssets = fixedValue + rentalValue;
  const netWorth = interestPrincipal + nonInterestAssets - liabilities;

  return {
    growthValue,
    cashValue,
    fixedValue,
    rentalValue,
    liabilities,
    emergencyBuffer,
    interestPrincipal,
    cashAboveBuffer,
    nonInterestAssets,
    netWorth,
  };
}
