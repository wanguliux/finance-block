/**
 * finance-heatmap 渲染块：分类 × 时间支出热力图
 *
 * 代码块语法：
 *   ```finance-heatmap
 *   weeks: 12
 *   ```
 *
 * 参数：weeks: 显示最近 N 周（默认 12，最多 52）
 * 视觉：统一 fb-head + hm-table（行=分类，列=周，绿色单色梯度）+ hm-legend。
 */

import type { MarkdownPostProcessorContext, App } from 'obsidian';
import type { Indexer, IndexEntry } from '../ledger/indexer';
import { convertToBase, currencySymbol, buildFxRates, buildSymbolMap } from '../engine/fx';
import type { FinanceConfig } from '../types';
import { t } from '../i18n';
import { localDateString } from '../util/date';
import { BLOCK_ICONS, setSvg } from './icons';

interface HeatmapParams {
  weeks: number;
}

function parseParams(source: string): HeatmapParams {
  const params: HeatmapParams = { weeks: 12 };
  for (const line of source.split(/\r?\n/)) {
    const m = /^weeks:\s*(\d+)$/.exec(line.trim());
    if (m) {
      params.weeks = Math.min(parseInt(m[1], 10), 52);
      break;
    }
  }
  return params;
}

interface HeatmapData {
  categories: string[];
  weekStarts: string[];
  cells: Map<string, number>;
}

function aggregateHeatmap(entries: IndexEntry[], weeks: number, config?: FinanceConfig): HeatmapData {
  const fxRates = buildFxRates(config?.currencies, config?.baseCurrency ?? 'CNY');
  const baseCurrency = config?.baseCurrency ?? 'CNY';

  const now = new Date();
  const weekStarts: string[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - date.getDay() - i * 7);
    weekStarts.push(localDateString(date));
  }

  const startDate = weekStarts[0];
  const filtered = entries.filter((e) => {
    if (e.transaction.date < startDate) return false;
    if (e.isDraft) return false;
    return e.transaction.legs.some((l) => l.amount < 0);
  });

  const cells = new Map<string, number>();
  const categorySet = new Set<string>();
  for (const entry of filtered) {
    const category = entry.transaction.txnType || t('heatmap.uncategorized');
    categorySet.add(category);
    const txDate = new Date(entry.transaction.date);
    const txWeekStart = new Date(txDate);
    txWeekStart.setDate(txDate.getDate() - txDate.getDay());
    const weekKey = localDateString(txWeekStart);
    const expense = entry.transaction.legs
      .filter((l) => l.amount < 0)
      .reduce((sum, l) => sum + Math.abs(convertToBase(l.amount, entry.transaction.currency, fxRates, baseCurrency)), 0);
    const cellKey = `${category}|${weekKey}`;
    cells.set(cellKey, (cells.get(cellKey) || 0) + expense);
  }

  return { categories: Array.from(categorySet).sort(), weekStarts, cells };
}

function getHeatColor(amount: number, maxAmount: number): string {
  if (amount === 0) return 'transparent';
  const intensity = Math.min(amount / maxAmount, 1);
  const alpha = 0.1 + intensity * 0.8;
  return `rgba(47, 168, 106, ${alpha.toFixed(2)})`;
}

function fmtAmount(cents: number, symbol: string): string {
  const yuan = cents / 100;
  if (yuan >= 10000) return `${symbol}${(yuan / 10000).toFixed(1)}万`;
  return `${symbol}${yuan.toFixed(0)}`;
}

function fmtWeek(weekStart: string): string {
  const date = new Date(weekStart);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function renderHeatmap(
  source: string,
  el: HTMLElement,
  _ctx: MarkdownPostProcessorContext,
  _app: App,
  indexer: Indexer,
  config?: FinanceConfig,
): void {
  const params = parseParams(source);
  el.empty();

  const root = el.createDiv({ cls: 'finance-block finance-heatmap' });

  // ── 头部（图标 + 标题 + 状态 pill） ──
  const head = root.createDiv({ cls: 'fb-head' });
  setSvg(head.createDiv({ cls: 'fb-icon' }), BLOCK_ICONS.heatmap);
  head.createDiv({ cls: 'fb-title', text: t('heatmap.title') });
  head.createDiv({ cls: 'fb-pill', text: t('log.dayLabel.days', { n: String(params.weeks) }) });

  const symbol = currencySymbol(config?.baseCurrency ?? 'CNY', buildSymbolMap(config?.currencies));
  const allEntries = indexer.getAllTransactions();
  const { categories, weekStarts, cells } = aggregateHeatmap(allEntries, params.weeks, config);

  if (categories.length === 0 || weekStarts.length === 0) {
    root.createDiv({ cls: 'hm-empty', text: t('heatmap.empty') });
    return;
  }

  let maxAmount = 0;
  for (const amount of cells.values()) if (amount > maxAmount) maxAmount = amount;

  const table = root.createEl('table', { cls: 'hm-table' });
  const thead = table.createEl('thead');
  const headerRow = thead.createEl('tr');
  headerRow.createEl('th', { text: '', cls: 'hm-corner' });
  for (const w of weekStarts) headerRow.createEl('th', { text: fmtWeek(w), cls: 'hm-week' });

  const tbody = table.createEl('tbody');
  for (const category of categories) {
    const row = tbody.createEl('tr');
    row.createEl('th', { text: category, cls: 'hm-cat' });
    for (const w of weekStarts) {
      const amount = cells.get(`${category}|${w}`) || 0;
      const cell = row.createEl('td', { cls: 'hm-cell' });
      cell.style.backgroundColor = getHeatColor(amount, maxAmount);
      if (amount > 0) {
        cell.setText(fmtAmount(amount, symbol));
        cell.setAttribute('title', `${category}: ${fmtAmount(amount, symbol)}`);
        cell.addClass('has-data');
      }
    }
  }

  const legend = root.createDiv({ cls: 'hm-legend' });
  legend.createSpan({ cls: 'hm-legend-label', text: t('heatmap.legend.low') });
  const bar = legend.createDiv({ cls: 'hm-legend-bar' });
  bar.style.background = 'linear-gradient(to right, rgba(47, 168, 106, 0.1), rgba(47, 168, 106, 0.95))';
  legend.createSpan({ cls: 'hm-legend-label', text: t('heatmap.legend.high') });
  legend.createSpan({ cls: 'hm-legend-unit', text: `单位：元 · 悬停查看明细` });
}
