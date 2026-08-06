import type { FinanceConfig } from '../types';

/**
 * 默认配置：最简种子态 —— 一个类别只留一个账户，所有字段填好。
 * 首次使用时写入 vault 的 finance-config.json。
 */
export const DEFAULT_CONFIG: FinanceConfig = {
  version: 5,

  // ── 账户：每类一个，owner 默认「自己」，valuation / cashflowRole 按通常语义预填 ──
  accounts: [
    // 流动资产 —— 账面计价，现金类（日常收支）
    { name: '现金',   class: 'asset', icon: '💵', owner: '自己', valuation: 'book',    cashflowRole: 'cash' },
    // 投资 —— 市值计价，生息增长（股票/基金统称，用户可按需改名）
    { name: '股票',   class: 'asset', icon: '📈', owner: '自己', valuation: 'market',  cashflowRole: 'growth', staleDays: 30 },
    // 大件资产 —— 账面计价（2026-08-04 终版：资产价值由记账自动得出，
    // 曾设 market/折旧派生+具体资产面板，用户拍板「能记账就记账驱动」，已废弃）
    { name: '房产',   class: 'asset', icon: '🏠', owner: '自己', cashflowRole: 'fixed' },
    { name: '车',     class: 'asset', icon: '🚗', owner: '自己', cashflowRole: 'fixed' },
    // 负债
    { name: '房贷',   class: 'liability', icon: '🏦', owner: '自己' },
    // 收入（流量账户，记完即归零）
    { name: '工资', class: 'income', icon: '💰', owner: '自己' },
    // 费用（流量账户，记完即归零）
    { name: '日常', class: 'expense', icon: '🍜', owner: '自己' },
    // 权益（结转专用）
    { name: '结转', class: 'equity', icon: '🔄', owner: '自己' },
  ],

  // 五大类
  classes: ['asset', 'liability', 'equity', 'income', 'expense'],

  // owner 维度
  owners: ['自己', '家庭'],
  defaultOwner: '自己',

  // 默认币种
  baseCurrency: 'CNY',

  // 币种 —— 名称用各币种对应官方语言
  currencies: [
    { code: 'CNY', name: '人民币',              symbol: '¥',  rate: 1 },
    { code: 'USD', name: 'US Dollar',           symbol: '$',  rate: 7.25 },
    { code: 'EUR', name: 'Euro',                symbol: '€',  rate: 7.83 },
    { code: 'GBP', name: 'Pound Sterling',      symbol: '£',  rate: 9.32 },
    { code: 'JPY', name: '日本円',              symbol: '円', rate: 0.0485 },
    { code: 'HKD', name: 'Hong Kong Dollar',    symbol: 'HK$', rate: 0.93 },
  ],

  // 交易类型 —— 种子为空，用户在设置页「交易类型管理」按需添加
  //（曾预置「支出/收入」，与账户类别（收入/费用）语义重叠、对预算/热力图无意义，2026-08-06 移除）
  transactionTypes: [],

  // 预算 —— 种子为空（预算按交易类型匹配实绩，交易类型种子为空后原「日常/支出」种子悬空，2026-08-06 移除）
  budgets: [],

  // 人生事件 —— 退休为内置特殊事件（不可删除、类型不可改）
  lifeEvents: [
    { id: 'retire', label: '退休', type: 'retire', age: 60, enabled: true },
  ],

  // 日常花费计划（finance-recurring V1）—— 种子为空，用户在代码块里新建
  recurringPlans: [],
  recurringSkips: {},

  // 贷款计划（finance-recurring V2）—— 种子为空
  loanPlans: [],

  // 现金流模拟器默认参数
  fiCalc: {
    defaultRate: 4,
  },

  // 估值过期全局默认阈值（天）
  defaultStaleDays: 30,
};
