/**
 * finance-heatmap 渲染块：收支热力图（v3，2026-08-03 按原型 redesign/finance-heatmap.html 落地）
 *
 * 代码块语法（全部可省略）：
 *   ```finance-heatmap
 *   day: 182            # 显示最近 N 天（默认 182，范围 7–365）
 *   view: calendar      # calendar 总览日历 | matrix 分类矩阵（默认 calendar）
 *   gran: week          # 矩阵粒度 week 按周 | month 按月（默认 week）
 *   category: 餐饮       # 按分类筛选（可选，取 transactionTypes 词表）
 *   ```
 *
 * 数据口径（与 budget.ts 的 sumExpenseForType 对齐）：
 *   - 收入 = Σ|income 类账户 leg|，支出 = Σ|expense 类账户 leg|（resolveAccountClass 推导，
 *     简洁账户名依赖 config.accounts 的 class，config 缺省回退前缀推断）
 *   - 每个格子的值 = 净额（收入 − 支出，分）：正=净收入（绿）、负=净支出（红），深浅按各自标尺归一
 *   - 未分类交易归入「未分类」分类
 *
 * 交互状态持久化（沿用 finance-ficalc 验证过的套路）：
 *   - view / gran / expanded / sort / category 属「查看态」：内存缓存 + localStorage（key=笔记路径::块签名），
 *     重渲染（切语言、编辑↔预览、其他块记账触发重绘）后恢复，不写回源文本
 *   - day 是「配置参数」：输入失焦写回代码块源文本（ctx.getSectionInfo 精确替换），写回前先 persist，
 *     重渲染从新 source 读到新值、查看态从缓存恢复，不丢状态
 */

import { TFile } from 'obsidian';
import type { MarkdownPostProcessorContext, App } from 'obsidian';
import type { Indexer, IndexEntry } from '../ledger/indexer';
import { convertToBase, currencySymbol, buildFxRates, buildSymbolMap } from '../engine/fx';
import type { FinanceConfig } from '../types';
import { resolveAccountClass } from '../util/ledgerView';
import { localDateString } from '../util/date';
import { t } from '../i18n';
import { BLOCK_ICONS, setSvg } from './icons';
import { setHtml, appendHtml } from '../util/dom';

/* ────────────────────────────────────────────────────────────
 *  参数解析
 * ──────────────────────────────────────────────────────────── */
export type HeatmapView = 'calendar' | 'matrix';
export type HeatmapGran = 'week' | 'month';

export interface HeatmapParams {
  day: number;
  view: HeatmapView;
  gran: HeatmapGran;
  category?: string;
}

export function parseHeatmapParams(source: string): HeatmapParams {
  const params: HeatmapParams = { day: 182, view: 'calendar', gran: 'week' };
  for (const line of source.split(/\r?\n/)) {
    const m = /^(\w+)\s*:\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1].toLowerCase();
    const raw = m[2].trim();
    switch (key) {
      case 'day': {
        const v = parseInt(raw, 10);
        if (!Number.isNaN(v)) params.day = Math.max(7, Math.min(365, v));
        break;
      }
      case 'view':
        if (raw === 'calendar' || raw === 'matrix') params.view = raw;
        break;
      case 'gran':
        if (raw === 'week' || raw === 'month') params.gran = raw;
        break;
      case 'category':
      case 'type':
        if (raw) params.category = raw;
        break;
    }
  }
  return params;
}

/* ────────────────────────────────────────────────────────────
 *  数据层（纯函数，可单测）
 * ──────────────────────────────────────────────────────────── */
export interface NetCell {
  net: number; // 净额（分），收入正 / 支出负
  count: number; // 交易笔数
}

/** 分类方向：查 config.transactionTypes 词表；未配置返回 undefined（如「未分类」） */
export function directionOfType(typeName: string, config?: FinanceConfig): 'income' | 'expense' | undefined {
  if (!config) return undefined;
  const found = config.transactionTypes?.find((d) => d.name === typeName);
  return found?.direction;
}

/** 单笔交易的收入/支出额（分）：按账户类别推导，与 budget.ts 口径一致 */
function txnInOut(e: IndexEntry, config: FinanceConfig | undefined, fxRates: Record<string, number>, base: string): { income: number; expense: number } {
  let income = 0;
  let expense = 0;
  for (const leg of e.transaction.legs) {
    const cls = resolveAccountClass(leg.account, config);
    const v = Math.abs(convertToBase(leg.amount, e.transaction.currency, fxRates, base));
    if (cls === 'income') income += v;
    else if (cls === 'expense') expense += v;
  }
  return { income, expense };
}

/**
 * 净额聚合：Map<`${分类}|${YYYY-MM-DD}`> → NetCell。
 * 过滤草稿；只保留 [startDate, endDate] 内的交易。
 */
export function aggregateNetCells(
  entries: IndexEntry[],
  startDate: string,
  endDate: string,
  config?: FinanceConfig,
): Map<string, NetCell> {
  const fxRates = buildFxRates(config?.currencies, config?.baseCurrency ?? 'CNY');
  const base = config?.baseCurrency ?? 'CNY';
  const uncat = t('heatmap.uncategorized');
  const cells = new Map<string, NetCell>();
  for (const e of entries) {
    const date = e.transaction.date;
    if (date < startDate || date > endDate) continue;
    const { income, expense } = txnInOut(e, config, fxRates, base);
    if (income === 0 && expense === 0) continue; // 转账/资产转换：无收支贡献
    const cat = e.transaction.txnType || uncat;
    const key = `${cat}|${date}`;
    const prev = cells.get(key);
    cells.set(key, {
      net: (prev?.net ?? 0) + income - expense,
      count: (prev?.count ?? 0) + 1,
    });
  }
  return cells;
}

export interface DaySeriesPoint {
  date: string; // YYYY-MM-DD
  net: number; // 当日净额（分）
  count: number;
}

/** 近 days 天的每日净额序列（含今天，从旧到新）；可选按分类过滤 */
export function buildDaySeries(
  entries: IndexEntry[],
  days: number,
  config?: FinanceConfig,
  todayStr: string = localDateString(new Date()),
  category?: string,
): DaySeriesPoint[] {
  const first = addDaysStr(todayStr, -(days - 1));
  const cells = aggregateNetCells(entries, first, todayStr, config);
  const uncat = t('heatmap.uncategorized');
  const out: DaySeriesPoint[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDaysStr(first, i);
    let net = 0;
    let count = 0;
    for (const [key, cell] of cells) {
      if (!key.endsWith(`|${date}`)) continue;
      if (category && !key.startsWith(`${category}|`)) continue;
      net += cell.net;
      count += cell.count;
    }
    out.push({ date, net, count });
  }
  return out;
}

export interface MatrixColumn {
  label: string; // 周：M/D；月：N月
  start: string; // YYYY-MM-DD（含）
  end: string; // YYYY-MM-DD（含）
}

/** 矩阵列定义：周粒度 = 覆盖范围的最小周数（从范围首日所在周一开头，首末列截断）；月粒度 = clamp(round(N/30), 2, 12) 个月 */
export function buildMatrixColumns(days: number, gran: HeatmapGran, todayStr: string = localDateString(new Date())): MatrixColumn[] {
  const firstAllowed = addDaysStr(todayStr, -(days - 1));
  const cols: MatrixColumn[] = [];
  if (gran === 'week') {
    const firstMonday = startOfWeekStr(firstAllowed);
    const n = Math.floor(daysBetween(firstMonday, todayStr) / 7) + 1;
    for (let i = 0; i < n; i++) {
      const ws = addDaysStr(firstMonday, i * 7);
      const we = addDaysStr(ws, 6);
      cols.push({
        label: `${parseInt(ws.slice(5, 7), 10)}/${parseInt(ws.slice(8, 10), 10)}`,
        start: ws < firstAllowed ? firstAllowed : ws,
        end: we > todayStr ? todayStr : we,
      });
    }
  } else {
    const months = Math.max(2, Math.min(12, Math.round(days / 30)));
    const cur = todayStr.slice(0, 7); // YYYY-MM
    for (let i = months - 1; i >= 0; i--) {
      const m = monthShift(cur, -i);
      const start = `${m}-01`;
      const end = monthEnd(m);
      cols.push({
        label: `${parseInt(m.slice(5, 7), 10)}月`,
        start: start < firstAllowed ? firstAllowed : start,
        end: end > todayStr ? todayStr : end,
      });
    }
  }
  return cols.filter((c) => c.start <= c.end);
}

/** sparkline 折线点串（归一化到 w×h 视口，y 向下为金额增大方向反转） */
export function buildSparkPoints(values: number[], w: number, h: number): string {
  if (values.length === 0) return '';
  const max = Math.max(...values.map((v) => Math.abs(v)), 1);
  const n = Math.max(values.length - 1, 1);
  const pad = 1.5;
  return values
    .map((v, i) => {
      const x = pad + (i / n) * (w - pad * 2);
      const y = h - pad - (Math.abs(v) / max) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

/* ── 日期工具（字符串级，避免时区偏移，与 util/date 风格一致） ── */
function parseDateStr(s: string): Date {
  return new Date(`${s}T00:00:00`);
}
function addDaysStr(s: string, n: number): string {
  const d = parseDateStr(s);
  d.setDate(d.getDate() + n);
  return localDateString(d);
}
function startOfWeekStr(s: string): string {
  const d = parseDateStr(s);
  const day = (d.getDay() + 6) % 7; // 周一 = 0
  d.setDate(d.getDate() - day);
  return localDateString(d);
}
function monthShift(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function monthEnd(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m, 0); // 下月 0 号 = 本月最后一天
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysBetween(a: string, b: string): number {
  return Math.round((parseDateStr(b).getTime() - parseDateStr(a).getTime()) / 86400000);
}

/* ────────────────────────────────────────────────────────────
 *  渲染层
 * ──────────────────────────────────────────────────────────── */
const DAY_MIN = 7;
const DAY_MAX = 365;
const LS_PREFIX = 'fb-heatmap:';
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

interface PersistedState {
  view: HeatmapView;
  gran: HeatmapGran;
  category?: string;
  expanded: boolean;
  sort: 'desc' | 'asc' | null;
}

const stateCache = new Map<string, PersistedState>();

function stableKey(source: string, ctx?: MarkdownPostProcessorContext): string {
  const path = ctx?.sourcePath ?? '';
  const sig = source
    .split(/\r?\n/)
    .filter((l) => !/^\s*(day|view|gran|category|type)\s*:/.test(l))
    .join('\n');
  return `${path}::${sig}`;
}

function loadPersisted(key: string): PersistedState | undefined {
  const mem = stateCache.get(key);
  if (mem) return mem;
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (raw) return JSON.parse(raw) as PersistedState;
  } catch {
    /* 隐私模式/配额不可用时静默降级 */
  }
  return undefined;
}

function savePersisted(key: string, data: PersistedState): void {
  stateCache.set(key, data);
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(data));
  } catch {
    /* 同上 */
  }
}

/** day 参数写回源文本（仅替换/新增 day 行），写回会触发自动重渲染——调用前必须先 persist */
function writeDayToFile(app: App, ctx: MarkdownPostProcessorContext, el: HTMLElement, day: number): void {
  const file = app.vault.getAbstractFileByPath(ctx.sourcePath);
  if (!(file instanceof TFile)) return;
  const info = ctx.getSectionInfo(el);
  if (!info) return;
  void app.vault.read(file).then((content) => {
    const lines = content.split(/\r?\n/);
    const innerStart = info.lineStart + 1; // 开围栏下一行
    const innerEnd = info.lineEnd; // 闭围栏行（不含）
    const dayIdx = lines.slice(innerStart, innerEnd).findIndex((l) => /^\s*day\s*:/.test(l));
    if (dayIdx >= 0) {
      lines[innerStart + dayIdx] = `day: ${day}`;
    } else {
      lines.splice(innerStart, 0, `day: ${day}`);
    }
    void app.vault.modify(file, lines.join('\n'));
  });
}

function fmtAmount(cents: number, symbol: string): string {
  const yuan = cents / 100;
  if (yuan >= 10000) return `${symbol}${(yuan / 10000).toFixed(1)}万`;
  return `${symbol}${yuan.toFixed(0)}`;
}
function fmtSigned(cents: number, symbol: string): string {
  const sign = cents > 0 ? '+' : '';
  return sign + fmtAmount(Math.abs(cents), symbol);
}
function fmtMD(dateStr: string): string {
  return `${parseInt(dateStr.slice(5, 7), 10)}/${parseInt(dateStr.slice(8, 10), 10)}`;
}
function dowName(dateStr: string): string {
  const d = parseDateStr(dateStr);
  return WEEKDAYS[d.getDay() === 0 ? 6 : d.getDay() - 1];
}

/** 双向热力底色：净收入绿 / 净支出红，各自标尺归一 */
function heatBg(net: number, maxInc: number, maxExp: number): string {
  if (net > 0 && maxInc > 0) {
    return `rgba(52, 168, 83, ${(0.14 + Math.min(net / maxInc, 1) * 0.8).toFixed(2)})`;
  }
  if (net < 0 && maxExp > 0) {
    return `rgba(234, 67, 53, ${(0.14 + Math.min(-net / maxExp, 1) * 0.8).toFixed(2)})`;
  }
  return '';
}

export function renderHeatmap(
  source: string,
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext,
  app: App,
  indexer: Indexer,
  config?: FinanceConfig,
): void {
  const params = parseHeatmapParams(source);
  const cacheKey = stableKey(source, ctx);
  const cached = loadPersisted(cacheKey);
  const state: PersistedState = cached
    ? { ...cached }
    : { view: params.view, gran: params.gran, category: params.category, expanded: false, sort: null };
  let day = params.day;

  const symbol = currencySymbol(config?.baseCurrency ?? 'CNY', buildSymbolMap(config?.currencies));
  const todayStr = localDateString(new Date());
  const allEntries = indexer.getPostedTransactions();
  const base = config?.baseCurrency ?? 'CNY';

  el.empty();
  const root = el.createDiv({ cls: 'finance-block finance-heatmap' });

  // ── 头部 ──
  const head = root.createDiv({ cls: 'fb-head' });
  setSvg(head.createDiv({ cls: 'fb-icon' }), BLOCK_ICONS.heatmap);
  head.createDiv({ cls: 'fb-title', text: t('heatmap.title') });
  const pill = head.createDiv({ cls: 'fb-pill is-accent', text: t('heatmap.dayLabel', { n: String(day) }) });

  // ── 工具条 ──
  const toolbar = root.createDiv({ cls: 'hm-toolbar' });
  const tabs = toolbar.createDiv({ cls: 'hm-tabs' });
  const tabCalendar = tabs.createEl('button', { cls: 'hm-tab', text: t('heatmap.view.calendar'), attr: { type: 'button' } });
  const tabMatrix = tabs.createEl('button', { cls: 'hm-tab', text: t('heatmap.view.matrix'), attr: { type: 'button' } });
  toolbar.createDiv({ cls: 'hm-spacer' });
  const granSeg = toolbar.createDiv({ cls: 'hm-seg' });
  const granWeek = granSeg.createEl('button', { cls: 'hm-seg-btn', text: t('heatmap.gran.week'), attr: { type: 'button' } });
  const granMonth = granSeg.createEl('button', { cls: 'hm-seg-btn', text: t('heatmap.gran.month'), attr: { type: 'button' } });
  const dayLabel = toolbar.createDiv({ cls: 'hm-day-input' });
  dayLabel.createSpan({ text: t('heatmap.dayPrefix') });
  const dayInput = dayLabel.createEl('input', {
    cls: 'hm-day-input-val',
    attr: { type: 'number', min: String(DAY_MIN), max: String(DAY_MAX), value: String(day), title: t('heatmap.dayTitle') },
  });
  dayLabel.createSpan({ text: t('heatmap.daySuffix') });
  const catSel = toolbar.createEl('select', { cls: 'hm-select', attr: { title: t('heatmap.catFilterTitle') } });

  // 分类下拉：全部分类 + transactionTypes 词表（带方向徽标）
  catSel.createEl('option', { value: '', text: t('heatmap.all') });
  const types = config?.transactionTypes ?? [];
  for (const d of types) {
    const prefix = d.direction === 'income' ? t('heatmap.dir.income') : t('heatmap.dir.expense');
    catSel.createEl('option', { value: d.name, text: `${prefix} · ${d.name}` });
  }
  catSel.value = state.category ?? '';

  // ── 统计条 ──
  const metrics = root.createDiv({ cls: 'hm-metrics' });
  const mNet = metrics.createDiv({ cls: 'hm-metric' });
  mNet.createDiv({ cls: 'lbl', text: t('heatmap.metric.net') });
  const mNetVal = mNet.createDiv({ cls: 'num' });
  mNet.createDiv({ cls: 'sub', text: t('heatmap.metric.netSub') });
  const mExp = metrics.createDiv({ cls: 'hm-metric' });
  mExp.createDiv({ cls: 'lbl', text: t('heatmap.metric.expense') });
  const mExpVal = mExp.createDiv({ cls: 'num' });
  const mExpSub = mExp.createDiv({ cls: 'sub' });
  const mInc = metrics.createDiv({ cls: 'hm-metric' });
  mInc.createDiv({ cls: 'lbl', text: t('heatmap.metric.income') });
  const mIncVal = mInc.createDiv({ cls: 'num' });
  const mIncSub = mInc.createDiv({ cls: 'sub' });
  const mMax = metrics.createDiv({ cls: 'hm-metric' });
  mMax.createDiv({ cls: 'lbl', text: t('heatmap.metric.max') });
  const mMaxVal = mMax.createDiv({ cls: 'num' });
  const mMaxSub = mMax.createDiv({ cls: 'sub' });

  // ── 视图容器 ──
  const calWrap = root.createDiv({ cls: 'hm-cal-wrap' });
  const monthsEl = calWrap.createDiv({ cls: 'hm-months' });
  const calBody = calWrap.createDiv({ cls: 'hm-body' });
  const calHint = calWrap.createDiv({ cls: 'hm-hint' });

  const matWrap = root.createDiv({ cls: 'hm-mat-wrap' });
  const matTable = matWrap.createDiv({ cls: 'hm-table-wrap' }).createEl('table', { cls: 'hm-table' });
  const expandBtn = matWrap.createEl('button', { cls: 'hm-expand', attr: { type: 'button' } });
  matWrap.createDiv({ cls: 'hm-hint', text: t('heatmap.matrix.hint') });

  // ── 图例 ──
  const legend = root.createDiv({ cls: 'hm-legend' });
  legend.createSpan({ text: t('heatmap.legend.income') });
  legend.createDiv({ cls: 'bar2 bar-income' });
  legend.createSpan({ text: t('heatmap.legend.expense') });
  legend.createDiv({ cls: 'bar2 bar-expense' });
  legend.createSpan({ cls: 'note', text: t('heatmap.legend.note') });

  // ── 明细面板 ──
  const detail = root.createDiv({ cls: 'hm-detail' });
  const detailHead = detail.createDiv({ cls: 'hd' });
  const detailTitle = detailHead.createSpan();
  const detailClose = detailHead.createEl('button', { cls: 'close', text: '×', attr: { type: 'button', title: t('heatmap.detail.close') } });
  const detailBody = detail.createDiv();

  // tooltip（fixed 定位，挂块内）
  const tipEl = root.createDiv({ cls: 'hm-tip' });

  /* ── 状态同步 ── */
  function persist(): void {
    savePersisted(cacheKey, { ...state });
  }
  function syncControls(): void {
    tabCalendar.toggleClass('active', state.view === 'calendar');
    tabMatrix.toggleClass('active', state.view === 'matrix');
    granWeek.toggleClass('active', state.gran === 'week');
    granMonth.toggleClass('active', state.gran === 'month');
    calWrap.toggleClass('hidden', state.view !== 'calendar');
    matWrap.toggleClass('hidden', state.view !== 'matrix');
    granSeg.toggleClass('hidden', state.view !== 'matrix');
    pill.setText(t('heatmap.dayLabel', { n: String(day) }));
    dayInput.setAttr('value', String(day));
    catSel.setAttr('value', state.category ?? '');
    calHint.setText(t('heatmap.cal.hint', { n: String(day) }));
  }

  /* ── 统计条 ── */
  function renderMetrics(): void {
    const series = buildDaySeries(allEntries, day, config, todayStr, state.category);
    let income = 0;
    let expense = 0;
    let maxNet = 0;
    let maxDate = '';
    for (const p of series) {
      if (p.net > 0) income += p.net;
      else expense += -p.net;
      if (Math.abs(p.net) > Math.abs(maxNet)) {
        maxNet = p.net;
        maxDate = p.date;
      }
    }
    const net = income - expense;
    mNetVal.setText(fmtSigned(net, symbol));
    mNetVal.className = `num ${net >= 0 ? 'pos' : 'neg'}`;
    mExpVal.setText(fmtAmount(expense, symbol));
    mExpSub.setText(t('heatmap.metric.daily', { n: fmtAmount(Math.round(expense / day), symbol) }));
    mIncVal.setText(fmtAmount(income, symbol));
    mIncSub.setText(t('heatmap.metric.daily', { n: fmtAmount(Math.round(income / day), symbol) }));
    mMaxVal.setText(maxDate ? fmtSigned(maxNet, symbol) : '—');
    mMaxVal.className = `num ${maxNet >= 0 ? 'pos' : 'neg'}`;
    mMaxSub.setText(
      maxDate
        ? t('heatmap.metric.maxSub', {
            date: fmtMD(maxDate),
            weekday: dowName(maxDate),
            kind: maxNet >= 0 ? t('heatmap.tip.incomeDay') : t('heatmap.tip.expenseDay'),
          })
        : t('heatmap.empty'),
    );
  }

  /* ── 日历视图 ── */
  function renderCalendar(): void {
    const firstAllowed = addDaysStr(todayStr, -(day - 1));
    const gridFirst = startOfWeekStr(firstAllowed); // 范围首日所在周的周一，保证近 N 天完整呈现
    const cols = Math.floor(daysBetween(gridFirst, todayStr) / 7) + 1;
    const cell = 16;

    // 各自标尺
    let maxInc = 0;
    let maxExp = 0;
    for (let i = 0; i < day; i++) {
      const net = dayNet(addDaysStr(firstAllowed, i));
      if (net > 0) maxInc = Math.max(maxInc, net);
      else maxExp = Math.max(maxExp, -net);
    }

    // 月份标签
    monthsEl.empty();
    let curMonth = -1;
    let monthWeeks = 0;
    for (let i = 0; i < cols; i++) {
      const ws = addDaysStr(gridFirst, i * 7);
      const m = parseInt(ws.slice(5, 7), 10);
      if (m !== curMonth) {
        if (curMonth !== -1) {
          const s = monthsEl.createSpan({ cls: 'hm-month' });
          s.style.width = `${monthWeeks * 18}px`;
          s.setText(`${curMonth}月`);
        }
        curMonth = m;
        monthWeeks = 0;
      }
      monthWeeks++;
    }
    if (curMonth !== -1) {
      const s = monthsEl.createSpan({ cls: 'hm-month' });
      s.style.width = `${monthWeeks * 18}px`;
      s.setText(`${curMonth}月`);
    }

    // 网格
    calBody.style.gridTemplateColumns = `26px repeat(${cols}, ${cell}px)`;
    calBody.empty();
    const dows = ['', '周一', '', '周三', '', '周五', ''];
    for (let r = 0; r < 7; r++) {
      calBody.createDiv({ cls: 'hm-dow', text: dows[r] });
      for (let c = 0; c < cols; c++) {
        const date = addDaysStr(gridFirst, c * 7 + r);
        const cellEl = calBody.createDiv({ cls: 'hm-day' });
        if (date < firstAllowed || date > todayStr) {
          cellEl.addClass('off');
          continue;
        }
        const net = dayNet(date);
        if (net !== 0) cellEl.style.backgroundColor = heatBg(net, maxInc, maxExp);
        if (date === todayStr) cellEl.addClass('today');
        cellEl.dataset.date = date;
      }
    }
  }

  function dayNet(date: string): number {
    let net = 0;
    for (const [key, cell] of dayCache) {
      if (!key.endsWith(`|${date}`)) continue;
      if (state.category && !key.startsWith(`${state.category}|`)) continue;
      net += cell.net;
    }
    return net;
  }
  let dayCache = new Map<string, NetCell>();

  /* ── 分类矩阵 ── */
  interface MatrixRow {
    cat: string;
    nets: number[];
    counts: number[];
    total: number;
  }
  function renderMatrix(): void {
    const columns = buildMatrixColumns(day, state.gran, todayStr);
    const firstAllowed = addDaysStr(todayStr, -(day - 1));
    const cells = aggregateNetCells(allEntries, firstAllowed, todayStr, config);
    const uncat = t('heatmap.uncategorized');

    // 分类清单（词表顺序在前，未出现在词表的分类按出现顺序补尾）
    const catSet = new Set<string>();
    for (const key of cells.keys()) catSet.add(key.slice(0, key.indexOf('|')));
    const ordered: string[] = [];
    for (const d of types) if (catSet.has(d.name)) ordered.push(d.name);
    for (const c of catSet) if (!ordered.includes(c)) ordered.push(c);
    if (state.category) {
      const only = ordered.filter((c) => c === state.category);
      ordered.length = 0;
      ordered.push(...only);
    }

    const rows: MatrixRow[] = ordered.map((cat) => {
      const nets = columns.map((col) => 0);
      const counts = columns.map(() => 0);
      for (const [key, cell] of cells) {
        const pipe = key.indexOf('|');
        const kCat = key.slice(0, pipe);
        const kDate = key.slice(pipe + 1);
        if (kCat !== cat) continue;
        const ci = columns.findIndex((col) => kDate >= col.start && kDate <= col.end);
        if (ci >= 0) {
          nets[ci] += cell.net;
          counts[ci] += cell.count;
        }
      }
      return { cat, nets, counts, total: nets.reduce((s, v) => s + v, 0) };
    });

    // 排序：desc → asc → 默认（收入组在前，其余按合计降序）
    const sorted = [...rows];
    if (state.sort === 'desc') sorted.sort((a, b) => b.total - a.total);
    else if (state.sort === 'asc') sorted.sort((a, b) => a.total - b.total);
    else {
      sorted.sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
      sorted.sort((a, b) => (dirRank(a.cat) - dirRank(b.cat)) || 0);
    }
    function dirRank(cat: string): number {
      return directionOfType(cat, config) === 'income' ? 0 : 1;
    }

    // Top 5 折叠 + 其他
    let shown = sorted;
    let others: MatrixRow | null = null;
    if (!state.expanded && sorted.length > 6) {
      const byAbs = [...sorted].sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
      shown = byAbs.slice(0, 5);
      const rest = byAbs.slice(5);
      const nets = columns.map((_, i) => rest.reduce((s, r) => s + r.nets[i], 0));
      const counts = columns.map((_, i) => rest.reduce((s, r) => s + r.counts[i], 0));
      others = { cat: t('heatmap.others'), nets, counts, total: rest.reduce((s, r) => s + r.total, 0) };
    }
    const lineRows = others ? [...shown, others] : shown;

    // 双向标尺
    let maxInc = 0;
    let maxExp = 0;
    for (const r of lineRows) {
      for (const v of r.nets) {
        if (v > 0) maxInc = Math.max(maxInc, v);
        else maxExp = Math.max(maxExp, -v);
      }
    }

    matTable.empty();
    const thead = matTable.createEl('thead');
    const htr = thead.createEl('tr');
    const corner = htr.createEl('th', { cls: 'hm-sort-hint' });
    corner.setText(state.sort ? t(state.sort === 'desc' ? 'heatmap.sort.desc' : 'heatmap.sort.asc') : t('heatmap.sort.hint'));
    for (const col of columns) htr.createEl('th', { text: col.label });

    const tbody = matTable.createEl('tbody');
    for (const r of lineRows) {
      const tr = tbody.createEl('tr');
      tr.dataset.cat = r.cat;
      const th = tr.createEl('th', { cls: 'hm-cat' });
      const dir = directionOfType(r.cat, config);
      const dirBadge = dir ? `<span class="hm-dir ${dir}">${t(`heatmap.dir.${dir}`)}</span>` : '';
      const totalAbs = lineRows.reduce((s, x) => s + Math.abs(x.total), 0) || 1;
      const share = (Math.abs(r.total) / totalAbs) * 100;
      const sparkColor = r.total >= 0 ? 'rgba(52,168,83,.9)' : 'rgba(234,67,53,.9)';
      const nm = th.createDiv({ cls: 'nm' });
      nm.createSpan({ cls: 'dot' }).style.backgroundColor = catColor(r.cat);
      nm.createSpan({ text: r.cat });
      if (dirBadge) appendHtml(nm, dirBadge);
      const tt = th.createDiv({ cls: 'tt' });
      tt.createSpan({ cls: 'sum', text: fmtSigned(r.total, symbol) });
      const shareEl = tt.createSpan({ cls: 'hm-share' });
      shareEl.createEl('i', { attr: { style: `width:${share.toFixed(1)}%` } });
      tt.createSpan({ text: `${share.toFixed(0)}%` });
      const spark = tt.createSpan({ cls: 'spark' });
      setSvg(spark, sparkSvg(r.nets, sparkColor));
      r.nets.forEach((v, i) => {
        const td = tr.createEl('td');
        if (v !== 0) {
          td.style.backgroundColor = heatBg(v, maxInc, maxExp);
          td.setText(v >= 10000 || v <= -10000 ? `${(Math.abs(v) / 10000).toFixed(1)}万` : String(Math.abs(Math.round(v / 100))));
          td.dataset.cat = r.cat;
          td.dataset.col = String(i);
        }
      });
    }

    // 合计行
    const tfoot = matTable.createEl('tfoot');
    const ftr = tfoot.createEl('tr');
    ftr.createEl('th', { cls: 'hm-cat', text: t('heatmap.matrix.total') });
    columns.forEach((_, i) => {
      const v = lineRows.reduce((s, r) => s + r.nets[i], 0);
      const td = ftr.createEl('td', { cls: 'hm-col-total' });
      if (v > 0) {
        td.setCssStyles({ color: 'var(--fb-green)' });
        td.setText('+' + fmtAmount(v, '').replace('¥', ''));
      } else if (v < 0) {
        td.setCssStyles({ color: 'var(--fb-red)' });
        td.setText(fmtAmount(-v, '').replace('¥', ''));
      }
    });

    // 展开按钮
    if (others) {
      expandBtn.removeClass('hidden');
      expandBtn.setText(state.expanded ? t('heatmap.expand.collapse') : t('heatmap.expand.all', { n: String(sorted.length) }));
    } else {
      expandBtn.addClass('hidden');
    }

    (matTable as unknown as { _columns: MatrixColumn[]; _rows: MatrixRow[] })._columns = columns;
    (matTable as unknown as { _columns: MatrixColumn[]; _rows: MatrixRow[] })._rows = lineRows;
  }

  function catColor(cat: string): string {
    const palette = ['#34a853', '#8a5cf6', '#2f6fed', '#f5a623', '#e0507a', '#14a3a3', '#64748b', '#ea4335'];
    let h = 0;
    for (let i = 0; i < cat.length; i++) h = (h * 31 + cat.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
  }

  function sparkSvg(values: number[], color: string): string {
    const pts = buildSparkPoints(values, 56, 14);
    return `<svg viewBox="0 0 56 14" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }

  /* ── 悬浮提示 ── */
  function showTip(html: string, x: number, y: number): void {
    setHtml(tipEl, html);
    tipEl.removeClass('hidden');
    const r = tipEl.getBoundingClientRect();
    tipEl.style.left = `${Math.min(x + 14, window.innerWidth - r.width - 10)}px`;
    tipEl.style.top = `${y + 14}px`;
  }
  function hideTip(): void {
    tipEl.addClass('hidden');
  }

  function tipForDay(date: string): string {
    const list = [];
    for (const [key, cell] of dayCache) {
      if (!key.endsWith(`|${date}`)) continue;
      if (state.category && !key.startsWith(`${state.category}|`)) continue;
      list.push({ cat: key.slice(0, key.indexOf('|')), ...cell });
    }
    const net = list.reduce((s, e) => s + e.net, 0);
    const cnt = list.reduce((s, e) => s + e.count, 0);
    if (list.length === 0) return `<div class="tp-date">${fmtMD(date)} ${dowName(date)}</div><div class="tp-meta">${t('heatmap.tip.none')}</div>`;
    let html = `<div class="tp-date">${fmtMD(date)} ${dowName(date)}</div>`;
    for (const e of list) {
      const cls = e.net > 0 ? 'in' : 'out';
      const sign = e.net > 0 ? '+' : '';
      html += `<div class="tp-row"><span class="tp-dot" style="background:${catColor(e.cat)}"></span><span>${escapeHtml(e.cat)}</span><span class="tp-amt ${cls}">${sign}${fmtAmount(Math.abs(e.net), symbol)}</span></div>`;
    }
    const netCls = net >= 0 ? 'in' : 'out';
    html += `<div class="tp-meta">${t('heatmap.tip.net')} <span class="tp-amt ${netCls}" style="font-weight:700">${fmtSigned(net, symbol)}</span> · ${t('heatmap.detail.count', { n: String(cnt) })}</div>`;
    return html;
  }

  function tipForMatrixCell(cat: string, colIdx: number): string {
    const cols = (matTable as unknown as { _columns: MatrixColumn[] })._columns;
    const col = cols[colIdx];
    let net = 0;
    let cnt = 0;
    for (const [key, cell] of dayCache) {
      if (!key.startsWith(`${cat}|`)) continue;
      const date = key.slice(cat.length + 1);
      if (date >= col.start && date <= col.end) {
        net += cell.net;
        cnt += cell.count;
      }
    }
    const cls = net >= 0 ? 'in' : 'out';
    let html = `<div class="tp-row"><span class="tp-dot" style="background:${catColor(cat)}"></span><span class="tp-date">${escapeHtml(cat)} · ${col.label}</span></div>`;
    html += `<div class="tp-amt ${cls}" style="font-size:13px">${fmtSigned(net, symbol)}</div>`;
    html += `<div class="tp-meta">${t('heatmap.detail.count', { n: String(cnt) })}`;
    if (colIdx > 0) {
      const prev = cols[colIdx - 1];
      let prevNet = 0;
      for (const [key, cell] of dayCache) {
        if (!key.startsWith(`${cat}|`)) continue;
        const date = key.slice(cat.length + 1);
        if (date >= prev.start && date <= prev.end) prevNet += cell.net;
      }
      if (prevNet !== 0 && net !== 0) {
        const diff = (Math.abs(net) - Math.abs(prevNet)) / Math.abs(prevNet) * 100;
        const up = diff >= 0;
        html += ` · ${t('heatmap.tip.delta')} <span style="color:${up ? 'var(--fb-red)' : 'var(--fb-green)'};font-weight:700">${up ? '↑' : '↓'}${Math.abs(diff).toFixed(0)}%</span>`;
      }
    }
    html += '</div>';
    return html;
  }

  /* ── 明细面板 ── */
  function openDetail(title: string, rows: { cat: string; net: number; count: number }[]): void {
    detailTitle.setText(title);
    detailBody.empty();
    if (rows.length === 0) {
      detailBody.createDiv({ cls: 'hm-detail-empty', text: t('heatmap.detail.noData') });
    } else {
      const table = detailBody.createEl('table');
      const htr = table.createEl('tr');
      htr.createEl('th', { text: t('heatmap.detail.colCat') });
      const thAmt = htr.createEl('th', { text: t('heatmap.detail.colAmount') });
      thAmt.setCssStyles({ textAlign: 'right' });
      const thCnt = htr.createEl('th', { text: t('heatmap.detail.colCount') });
      thCnt.setCssStyles({ textAlign: 'right' });
      let net = 0;
      let cnt = 0;
      for (const r of rows) {
        net += r.net;
        cnt += r.count;
        const tr = table.createEl('tr');
        const tdCat = tr.createEl('td');
        const dot = tdCat.createSpan({ cls: 'd-dot' });
        dot.style.backgroundColor = catColor(r.cat);
        tdCat.createSpan({ text: r.cat });
        const tdAmt = tr.createEl('td', { cls: `amt ${r.net >= 0 ? 'in' : 'out'}` });
        tdAmt.setCssStyles({ textAlign: 'right' });
        tdAmt.setText((r.net > 0 ? '+' : '') + fmtAmount(Math.abs(r.net), symbol));
        const tdCnt = tr.createEl('td');
        tdCnt.setCssStyles({ textAlign: 'right' });
        tdCnt.setCssStyles({ color: 'var(--fb-text-faint)' });
        tdCnt.setText(String(r.count));
      }
      const sum = table.createEl('tr', { cls: 'sum' });
      sum.createEl('td', { text: t('heatmap.detail.sum') });
      const sumAmt = sum.createEl('td', { cls: `amt ${net >= 0 ? 'in' : 'out'}` });
      sumAmt.setCssStyles({ textAlign: 'right' });
      sumAmt.setText(fmtSigned(net, symbol));
      const sumCnt = sum.createEl('td');
      sumCnt.setCssStyles({ textAlign: 'right' });
      sumCnt.setText(t('heatmap.detail.count', { n: String(cnt) }));
    }
    detail.addClass('open');
  }
  function closeDetail(): void {
    detail.removeClass('open');
  }

  function detailForDay(date: string): void {
    const rows: { cat: string; net: number; count: number }[] = [];
    for (const [key, cell] of dayCache) {
      if (!key.endsWith(`|${date}`)) continue;
      if (state.category && !key.startsWith(`${state.category}|`)) continue;
      rows.push({ cat: key.slice(0, key.indexOf('|')), net: cell.net, count: cell.count });
    }
    rows.sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
    openDetail(t('heatmap.detail.dayTitle', { date: fmtMD(date), weekday: dowName(date) }), rows);
  }

  function detailForMatrixCell(cat: string, colIdx: number): void {
    const cols = (matTable as unknown as { _columns: MatrixColumn[] })._columns;
    const col = cols[colIdx];
    const net = (matTable as unknown as { _rows: MatrixRow[] })._rows.find((r) => r.cat === cat)?.nets[colIdx] ?? 0;
    const count = (matTable as unknown as { _rows: MatrixRow[] })._rows.find((r) => r.cat === cat)?.counts[colIdx] ?? 0;
    openDetail(
      t('heatmap.detail.catTitle', { cat, range: `${fmtMD(col.start)} ~ ${fmtMD(col.end)}` }),
      net !== 0 ? [{ cat, net, count }] : [],
    );
  }

  /* ── 渲染入口 ── */
  function renderAll(): void {
    // 重建 day 缓存（按当前 day 范围，全量；分类过滤在读取处按 state.category 进行）
    const firstAllowed = addDaysStr(todayStr, -(day - 1));
    dayCache = aggregateNetCells(allEntries, firstAllowed, todayStr, config);
    syncControls();
    renderMetrics();
    renderCalendar();
    renderMatrix();
    closeDetail();
  }

  /* ── 事件 ── */
  tabCalendar.addEventListener('click', () => {
    state.view = 'calendar';
    persist();
    syncControls();
  });
  tabMatrix.addEventListener('click', () => {
    state.view = 'matrix';
    persist();
    syncControls();
  });
  granWeek.addEventListener('click', () => {
    state.gran = 'week';
    persist();
    syncControls();
    renderMatrix();
  });
  granMonth.addEventListener('click', () => {
    state.gran = 'month';
    persist();
    syncControls();
    renderMatrix();
  });
  dayInput.addEventListener('change', () => {
    let v = parseInt(dayInput.value, 10);
    if (Number.isNaN(v)) v = params.day;
    v = Math.max(DAY_MIN, Math.min(DAY_MAX, v));
    day = v;
    persist();
    renderAll();
    writeDayToFile(app, ctx, el, v); // 写回触发重渲染，但状态已持久化
  });
  dayInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') dayInput.blur();
  });
  catSel.addEventListener('change', () => {
    state.category = catSel.value || undefined;
    persist();
    renderAll();
  });
  expandBtn.addEventListener('click', () => {
    state.expanded = !state.expanded;
    persist();
    renderMatrix();
  });

  // 日历：悬停 + 点击
  calBody.addEventListener('mouseover', (e) => {
    const t = (e.target as HTMLElement).closest('.hm-day:not(.off)') as HTMLElement | null;
    if (!t || !t.dataset.date) return;
    showTip(tipForDay(t.dataset.date), e.clientX, e.clientY);
  });
  calBody.addEventListener('mouseout', hideTip);
  calBody.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('.hm-day:not(.off)') as HTMLElement | null;
    if (!t || !t.dataset.date) return;
    detailForDay(t.dataset.date);
  });

  // 矩阵：悬停 + 点击格子 + 点击行头排序
  matTable.addEventListener('mouseover', (e) => {
    const td = (e.target as HTMLElement).closest('td[data-col]') as HTMLElement | null;
    if (td) {
      showTip(tipForMatrixCell(td.dataset.cat as string, parseInt(td.dataset.col as string, 10)), e.clientX, e.clientY);
      return;
    }
    const th = (e.target as HTMLElement).closest('th.hm-cat') as HTMLElement | null;
    if (th) {
      const tr = th.closest('tr');
      const cat = tr?.dataset.cat ?? '';
      const rows = (matTable as unknown as { _rows: MatrixRow[] })._rows;
      const total = rows.find((r) => r.cat === cat)?.total ?? 0;
      showTip(
        `<div class="tp-row"><span class="tp-dot" style="background:${catColor(cat)}"></span><span class="tp-date">${escapeHtml(cat)}</span><span class="tp-amt" style="margin-left:auto">${fmtSigned(total, symbol)}</span></div><div class="tp-meta">${t('heatmap.sort.tip')}</div>`,
        e.clientX,
        e.clientY,
      );
    }
  });
  matTable.addEventListener('mouseout', hideTip);
  matTable.addEventListener('click', (e) => {
    const td = (e.target as HTMLElement).closest('td[data-col]') as HTMLElement | null;
    if (td) {
      detailForMatrixCell(td.dataset.cat as string, parseInt(td.dataset.col as string, 10));
      return;
    }
    const th = (e.target as HTMLElement).closest('th.hm-cat') as HTMLElement | null;
    if (th) {
      state.sort = state.sort === 'desc' ? 'asc' : state.sort === 'asc' ? null : 'desc';
      persist();
      renderMatrix();
      closeDetail();
    }
  });
  detailClose.addEventListener('click', closeDetail);

  renderAll();
}

/** 用户分类名进入 tooltip/明细前做 HTML 转义（防 `$&`/尖括号类输入破坏文案） */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);
}
