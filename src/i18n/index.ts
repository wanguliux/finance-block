/*
 * i18n 国际化模块 —— 轻量级多语言支持
 * 用法：import { t, setLocale } from '../i18n';
 *       t('settings.ledgerPath') → '账本路径' 或 'Ledger path'
 *
 * 设计原则：
 *   - 零依赖：不引入 i18next 等库，纯对象查找 + 简单插值
 *   - 扁平 key：用 'section.key' 点分命名，便于搜索和 grep
 *   - 缺省回退：找不到当前语言的翻译时回退到 zh（中文优先，因本插件面向中文用户）
 */

import { zh } from './zh';
import { en } from './en';
import type { BudgetPeriod } from '../types';

export type Locale = 'zh' | 'en';

const locales: Record<Locale, Record<string, string>> = { zh, en };
let current: Locale = 'zh';

/** 切换当前语言 */
export function setLocale(locale: Locale): void {
  current = locale in locales ? locale : 'zh';
}

/** 获取当前语言 */
export function getLocale(): Locale {
  return current;
}

/**
 * 翻译函数。
 * @param key 点分路径，如 'modal.insert.title'
 * @param vars 插值变量，如 { n: '3' } 会替换文本中的 {n}
 */
export function t(key: string, vars?: Record<string, string>): string {
  let text = locales[current]?.[key] ?? locales.zh[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      // 必须用函数形式：v 可能来自用户输入（账户名/分类名/备注等），
      // 若含 $& / $' / $` / $n，字符串形式的 replace 替换值会被解释为特殊模式导致文案错乱。
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), () => v);
    }
  }
  return text;
}

/**
 * 把预算周期（BudgetPeriod）格式化为可读标签（每日/每周/每月/每年/每 N 日）。
 * 用于预算管理列表与预算代码块卡片内部展示。
 */
export function formatBudgetPeriod(period: BudgetPeriod, periodDays?: number): string {
  if (period === 'custom') {
    return t('budget.period.custom', { n: String(periodDays ?? 1) });
  }
  return t(`budget.period.${period}`);
}

/**
 * 翻译账户五大类（asset/liability/equity/income/expense）。
 * 若某类别在翻译表中缺失（如用户自定义的类别），则回退为原始值，避免显示 "class.xxx" 这样的 key。
 */
export function tClass(cls: string): string {
  const key = 'class.' + cls;
  const translated = t(key);
  return translated === key ? cls : translated;
}
