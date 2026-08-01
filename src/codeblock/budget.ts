/**
 * finance-budget 渲染块：预算执行率展示
 *
 * 代码块语法：
 *   ```finance-budget
 *   type: 餐饮
 *   ```
 *
 * 参数：
 *   type: 交易类型（可选，按类型筛选要展示的预算计划）
 *
 * 视觉：统一 fb-head + bd-*（周期 + 计划卡片列表 + 三档进度条）。
 */

import type { MarkdownPostProcessorContext, App } from 'obsidian';
import type { Indexer, IndexEntry } from '../ledger/indexer';
import { convertToBase, currencySymbol, buildFxRates, buildSymbolMap } from '../engine/fx';
import type { FinanceConfig, BudgetPeriod } from '../types';
import { t, formatBudgetPeriod } from '../i18n';
import { localDateString } from '../util/date';
import { BLOCK_ICONS, setSvg } from './icons';

interface BudgetParams {
  type?: string;
}

function parseParams(source: string): BudgetParams {
  const params: BudgetParams = {};
  for (const line of source.split(/\r?\n/)) {
    const typeMatch = /^type:\s*(.+)$/.exec(line.trim());
    if (typeMatch) params.type = typeMatch[1].trim();
  }
  return params;
}

function getDateRangeForPeriod(period: BudgetPeriod, periodDays?: number): { start: string; end: string } {
  const now = new Date();
  let start = new Date();
  let end = new Date();

  switch (period) {
    case 'day':
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      end = start;
      break;
    case 'week':
      start = new Date(now);
      start.setDate(now.getDate() - now.getDay());
      end = new Date(start);
      end.setDate(start.getDate() + 6);
      break;
    case 'year':
      start = new Date(now.getFullYear(), 0, 1);
      end = new Date(now.getFullYear(), 11, 31);
      break;
    case 'custom': {
      const n = Math.max(1, Math.floor(periodDays ?? 1));
      end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      start = new Date(end);
      start.setDate(end.getDate() - (n - 1));
      break;
    }
    case 'month':
    default:
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      break;
  }
  return { start: localDateString(start), end: localDateString(end) };
}

interface BudgetCardItem {
  name: string;
  type: string;
  periodLabel: string;
  actual: number;
  budget: number;
  rate: number;
}

function sumExpenseForType(
  entries: IndexEntry[],
  startDate: string,
  endDate: string,
  type: string,
  config?: FinanceConfig,
): number {
  const fxRates = buildFxRates(config?.currencies, config?.baseCurrency ?? 'CNY');
  const baseCurrency = config?.baseCurrency ?? 'CNY';
  const typeKey = (type || '').toLowerCase();

  let total = 0;
  for (const e of entries) {
    if (e.isDraft) continue;
    if (e.transaction.date < startDate || e.transaction.date > endDate) continue;
    if ((e.transaction.txnType || '').toLowerCase() !== typeKey) continue;
    total += e.transaction.legs
      .filter((l) => l.amount < 0)
      .reduce((sum, l) => sum + Math.abs(convertToBase(l.amount, e.transaction.currency, fxRates, baseCurrency)), 0);
  }
  return total;
}

function fmtAmount(cents: number, symbol: string): string {
  return `${symbol}${(cents / 100).toFixed(2)}`;
}

export function renderBudget(
  source: string,
  el: HTMLElement,
  _ctx: MarkdownPostProcessorContext,
  _app: App,
  indexer: Indexer,
  config?: FinanceConfig,
): void {
  const params = parseParams(source);
  el.empty();

  const root = el.createDiv({ cls: 'finance-block finance-budget' });

  // ── 头部（图标 + 标题；周期信息已并入每张预算卡的左侧 chip，故不再放独立 pill） ──
  const head = root.createDiv({ cls: 'fb-head' });
  setSvg(head.createDiv({ cls: 'fb-icon' }), BLOCK_ICONS.budget);
  head.createDiv({ cls: 'fb-title', text: t('budget.title') });

  const symbol = currencySymbol(config?.baseCurrency ?? 'CNY', buildSymbolMap(config?.currencies));

  const plans = (config?.budgets ?? []).filter((b) => {
    if (!params.type) return true;
    return (b.type || '').toLowerCase().includes(params.type.trim().toLowerCase());
  });

  if (plans.length === 0) {
    root.createDiv({ cls: 'bd-empty', text: t('budget.empty') });
    return;
  }

  const allEntries = indexer.getAllTransactions();
  const cards: BudgetCardItem[] = [];
  for (const plan of plans) {
    const period = plan.period ?? 'month';
    const { start, end } = getDateRangeForPeriod(period, plan.periodDays);
    const actual = sumExpenseForType(allEntries, start, end, plan.type, config);
    const budget = plan.amount ?? 0;
    const rate = budget > 0 ? actual / budget : 0;
    cards.push({
      name: plan.name,
      type: plan.type,
      periodLabel: formatBudgetPeriod(period, plan.periodDays),
      actual,
      budget,
      rate,
    });
  }

  const listEl = root.createDiv({ cls: 'bd-list' });
  for (const item of cards) {
    renderBudgetCard(listEl, item, symbol);
  }
}

function renderBudgetCard(parent: HTMLElement, item: BudgetCardItem, symbol: string): void {
  const card = parent.createDiv({ cls: 'bd-item' });

  const header = card.createDiv({ cls: 'bd-item-head' });
  const left = header.createDiv({ cls: 'bd-left' });
  left.createDiv({ cls: 'bd-cat', text: item.name });
  left.createDiv({ cls: 'bd-period', text: item.periodLabel });

  const right = header.createDiv({ cls: 'bd-right' });
  right.createDiv({ cls: 'bd-amt', text: `${fmtAmount(item.actual, symbol)} / ${fmtAmount(item.budget, symbol)}` });
  const pct = Math.round(item.rate * 1000) / 10;
  const pctEl = right.createDiv({ cls: 'bd-pct' });
  pctEl.textContent = `${pct}%`;
  if (item.rate > 1) pctEl.addClass('over');
  else if (item.rate > 0.8) pctEl.addClass('warn');

  const track = card.createDiv({ cls: 'bd-track' });
  const fill = track.createDiv({ cls: 'bd-fill' });
  if (item.rate > 1) fill.addClass('over');
  else if (item.rate > 0.8) fill.addClass('warn');
  else fill.addClass('ok');
  // 超支时封顶 100% 并转红，避免误读「远超额度」
  fill.style.width = `${Math.min(item.rate * 100, 100)}%`;
}
