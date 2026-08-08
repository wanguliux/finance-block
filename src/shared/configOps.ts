/**
 * configOps.ts —— finance-config.json 的纯数据变换（无 App、无 i18n 依赖）
 *
 * 所有函数接收 FinanceConfig、返回**新的** FinanceConfig（不修改入参），
 * 供插件（经 configManager）与 CLI 共用，确保配置写操作的「单一真相源」。
 *
 * 约定：
 *   - 数组项以各自唯一键定位（account.name / owner / type.name / currency.code /
 *     budget.name / recurringPlan.id / loanPlan.id / lifeEvent.id）。
 *   - 调用方负责提供合法 id（CLI 由 agent 生成或透传），本模块不做 id 生成。
 */

import type {
  AccountDef,
  BudgetDef,
  CurrencyDef,
  FinanceConfig,
  LifeEventDef,
  LoanDef,
  Owner,
  RecurringPlanDef,
  TransactionTypeDef,
} from '../types';

/** 浅层合并：数组与对象直接覆盖（用户意图明确），标量取用户值。 */
export function mergeConfig(base: FinanceConfig, patch: Partial<FinanceConfig>): FinanceConfig {
  const result = structuredClone(base);
  for (const key of Object.keys(patch) as (keyof FinanceConfig)[]) {
    const val = patch[key];
    if (val !== undefined) {
      (result as unknown as Record<string, unknown>)[key] = structuredClone(val);
    }
  }
  return result;
}

// ─── 账户 ────────────────────────────────────────────────────────

export function addAccount(config: FinanceConfig, account: AccountDef): FinanceConfig {
  if (config.accounts.some((a) => a.name === account.name)) {
    throw new Error(`账户已存在：${account.name}`);
  }
  return { ...config, accounts: [...config.accounts, account] };
}

export function updateAccount(
  config: FinanceConfig,
  name: string,
  patch: Partial<AccountDef>,
): FinanceConfig {
  const accounts = config.accounts.map((a) => (a.name === name ? { ...a, ...patch } : a));
  if (accounts.length === config.accounts.length && !accounts.some((a) => a.name === name)) {
    throw new Error(`账户不存在：${name}`);
  }
  return { ...config, accounts };
}

export function removeAccount(config: FinanceConfig, name: string): FinanceConfig {
  return { ...config, accounts: config.accounts.filter((a) => a.name !== name) };
}

// ─── owner 维度 ──────────────────────────────────────────────────

export function addOwner(config: FinanceConfig, owner: Owner): FinanceConfig {
  if (config.owners.includes(owner)) return config; // 幂等
  return { ...config, owners: [...config.owners, owner] };
}

export function removeOwner(config: FinanceConfig, owner: Owner): FinanceConfig {
  if (owner === config.defaultOwner) {
    throw new Error(`不能删除默认 owner：${owner}`);
  }
  return { ...config, owners: config.owners.filter((o) => o !== owner) };
}

export function setDefaultOwner(config: FinanceConfig, owner: Owner): FinanceConfig {
  if (!config.owners.includes(owner)) {
    throw new Error(`owner 不存在：${owner}`);
  }
  return { ...config, defaultOwner: owner };
}

// ─── 交易类型 ────────────────────────────────────────────────────

export function addTransactionType(
  config: FinanceConfig,
  type: TransactionTypeDef,
): FinanceConfig {
  if (config.transactionTypes.some((t) => t.name === type.name)) {
    throw new Error(`交易类型已存在：${type.name}`);
  }
  return { ...config, transactionTypes: [...config.transactionTypes, type] };
}

export function updateTransactionType(
  config: FinanceConfig,
  name: string,
  patch: Partial<TransactionTypeDef>,
): FinanceConfig {
  const transactionTypes = config.transactionTypes.map((t) =>
    t.name === name ? { ...t, ...patch } : t,
  );
  if (transactionTypes.length === config.transactionTypes.length &&
      !transactionTypes.some((t) => t.name === name)) {
    throw new Error(`交易类型不存在：${name}`);
  }
  return { ...config, transactionTypes };
}

export function removeTransactionType(config: FinanceConfig, name: string): FinanceConfig {
  return { ...config, transactionTypes: config.transactionTypes.filter((t) => t.name !== name) };
}

// ─── 币种 / 汇率 ─────────────────────────────────────────────────

export function addCurrency(config: FinanceConfig, currency: CurrencyDef): FinanceConfig {
  if (config.currencies.some((c) => c.code === currency.code)) {
    throw new Error(`币种已存在：${currency.code}`);
  }
  return { ...config, currencies: [...config.currencies, currency] };
}

export function updateCurrency(
  config: FinanceConfig,
  code: string,
  patch: Partial<CurrencyDef>,
): FinanceConfig {
  const currencies = config.currencies.map((c) => (c.code === code ? { ...c, ...patch } : c));
  if (currencies.length === config.currencies.length &&
      !currencies.some((c) => c.code === code)) {
    throw new Error(`币种不存在：${code}`);
  }
  return { ...config, currencies };
}

export function removeCurrency(config: FinanceConfig, code: string): FinanceConfig {
  if (code === config.baseCurrency) {
    throw new Error(`不能删除基准币种：${code}`);
  }
  return { ...config, currencies: config.currencies.filter((c) => c.code !== code) };
}

export function setBaseCurrency(config: FinanceConfig, code: string): FinanceConfig {
  if (!config.currencies.some((c) => c.code === code)) {
    throw new Error(`币种不存在：${code}`);
  }
  return { ...config, baseCurrency: code };
}

// ─── 预算 ────────────────────────────────────────────────────────

export function addBudget(config: FinanceConfig, budget: BudgetDef): FinanceConfig {
  if (config.budgets.some((b) => b.name === budget.name)) {
    throw new Error(`预算已存在：${budget.name}`);
  }
  return { ...config, budgets: [...config.budgets, budget] };
}

export function updateBudget(
  config: FinanceConfig,
  name: string,
  patch: Partial<BudgetDef>,
): FinanceConfig {
  const budgets = config.budgets.map((b) => (b.name === name ? { ...b, ...patch } : b));
  if (budgets.length === config.budgets.length && !budgets.some((b) => b.name === name)) {
    throw new Error(`预算不存在：${name}`);
  }
  return { ...config, budgets };
}

export function removeBudget(config: FinanceConfig, name: string): FinanceConfig {
  return { ...config, budgets: config.budgets.filter((b) => b.name !== name) };
}

// ─── 日常花费计划 ────────────────────────────────────────────────

export function addRecurringPlan(
  config: FinanceConfig,
  plan: RecurringPlanDef,
): FinanceConfig {
  if (config.recurringPlans.some((p) => p.id === plan.id)) {
    throw new Error(`日常计划 id 已存在：${plan.id}`);
  }
  return { ...config, recurringPlans: [...config.recurringPlans, plan] };
}

export function updateRecurringPlan(
  config: FinanceConfig,
  id: string,
  patch: Partial<RecurringPlanDef>,
): FinanceConfig {
  const recurringPlans = config.recurringPlans.map((p) => (p.id === id ? { ...p, ...patch } : p));
  if (recurringPlans.length === config.recurringPlans.length &&
      !recurringPlans.some((p) => p.id === id)) {
    throw new Error(`日常计划不存在：${id}`);
  }
  return { ...config, recurringPlans };
}

export function removeRecurringPlan(config: FinanceConfig, id: string): FinanceConfig {
  return { ...config, recurringPlans: config.recurringPlans.filter((p) => p.id !== id) };
}

/** 跳过某日常计划在指定应发生日（幂等累加，不去重由调用方保证） */
export function skipRecurring(
  config: FinanceConfig,
  planId: string,
  date: string,
): FinanceConfig {
  const skips = { ...config.recurringSkips };
  const list = skips[planId] ? [...skips[planId]] : [];
  if (!list.includes(date)) list.push(date);
  return { ...config, recurringSkips: { ...skips, [planId]: list } };
}

// ─── 贷款计划 ────────────────────────────────────────────────────

export function addLoanPlan(config: FinanceConfig, plan: LoanDef): FinanceConfig {
  if (config.loanPlans.some((p) => p.id === plan.id)) {
    throw new Error(`贷款计划 id 已存在：${plan.id}`);
  }
  return { ...config, loanPlans: [...config.loanPlans, plan] };
}

export function updateLoanPlan(
  config: FinanceConfig,
  id: string,
  patch: Partial<LoanDef>,
): FinanceConfig {
  const loanPlans = config.loanPlans.map((p) => (p.id === id ? { ...p, ...patch } : p));
  if (loanPlans.length === config.loanPlans.length && !loanPlans.some((p) => p.id === id)) {
    throw new Error(`贷款计划不存在：${id}`);
  }
  return { ...config, loanPlans };
}

export function removeLoanPlan(config: FinanceConfig, id: string): FinanceConfig {
  return { ...config, loanPlans: config.loanPlans.filter((p) => p.id !== id) };
}

// ─── 人生事件 ────────────────────────────────────────────────────

export function addLifeEvent(config: FinanceConfig, event: LifeEventDef): FinanceConfig {
  if (config.lifeEvents.some((e) => e.id === event.id)) {
    throw new Error(`人生事件 id 已存在：${event.id}`);
  }
  return { ...config, lifeEvents: [...config.lifeEvents, event] };
}

export function updateLifeEvent(
  config: FinanceConfig,
  id: string,
  patch: Partial<LifeEventDef>,
): FinanceConfig {
  const lifeEvents = config.lifeEvents.map((e) => (e.id === id ? { ...e, ...patch } : e));
  if (lifeEvents.length === config.lifeEvents.length && !lifeEvents.some((e) => e.id === id)) {
    throw new Error(`人生事件不存在：${id}`);
  }
  return { ...config, lifeEvents };
}

export function removeLifeEvent(config: FinanceConfig, id: string): FinanceConfig {
  const target = config.lifeEvents.find((e) => e.id === id);
  if (target && target.type === 'retire') {
    throw new Error('退休事件不可删除');
  }
  return { ...config, lifeEvents: config.lifeEvents.filter((e) => e.id !== id) };
}

// ─── 生日 ────────────────────────────────────────────────────────

export function setBirthday(config: FinanceConfig, date: string): FinanceConfig {
  return { ...config, birthday: date };
}
