import type { FinanceConfig } from '../types';

/**
 * 默认配置：最简种子态 —— 一个类别只留一个账户，所有字段填好。
 * 首次使用时写入 vault 的 finance-config.json。
 */
export const DEFAULT_CONFIG: FinanceConfig = {
  version: 4,

  // ── 账户：每类一个，owner 默认「自己」，valuation / cashflowRole 按通常语义预填 ──
  accounts: [
    // 流动资产 —— 账面计价，现金类（日常收支）
    { name: '现金',   class: 'asset', icon: '💵', owner: '自己', valuation: 'book',    cashflowRole: 'cash' },
    // 投资 —— 市值计价，生息增长（股票/基金统称，用户可按需改名）
    { name: '股票',   class: 'asset', icon: '📈', owner: '自己', valuation: 'market',  cashflowRole: 'growth', staleDays: 30 },
    // 大件资产 —— 市值计价，非生息（自住房/收藏品统称）
    { name: '房产',   class: 'asset', icon: '🏠', owner: '自己', valuation: 'market',  cashflowRole: 'fixed',  staleDays: 180 },
    // 折旧资产 —— 直线折旧，非生息
    { name: '车',     class: 'asset', icon: '🚗', owner: '自己', valuation: 'depreciation', cashflowRole: 'fixed',
      depreciation: { purchasePrice: 200000_00, purchaseDate: '2024-01-01', usefulLifeYears: 10, method: 'straight-line', salvageValue: 20000_00 } },
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

  // 交易类型 —— 仅「支出」「收入」两个，可于设置页扩充
  transactionTypes: [
    { name: '支出', direction: 'expense' },
    { name: '收入', direction: 'income' },
  ],

  // 预算 —— 一条日常支出预算
  budgets: [
    { name: '日常', type: '支出', amount: 5000_00, period: 'month' }, // 每月 5000 元
  ],

  // 人生事件 —— 退休为内置特殊事件（不可删除、类型不可改）
  lifeEvents: [
    { id: 'retire', label: '退休', type: 'retire', age: 60, enabled: true },
  ],

  // 现金流模拟器默认参数
  fiCalc: {
    defaultRate: 4,
  },

  // 估值过期全局默认阈值（天）
  defaultStaleDays: 30,
};
