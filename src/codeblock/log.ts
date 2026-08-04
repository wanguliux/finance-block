/**
 * finance-log 渲染块（v2.5）：流水查询面板。
 *
 * 职责：从索引取数，逐笔展示所有已入账复式交易（不含草稿，除非显式筛选）。
 * 去掉日分组——本就是查询视图，直接按筛选条件铺开全部匹配记录。
 * 每笔一行、净变动由账户类别推导、点击行展开 leg 明细。
 *
 * 代码块语法（所有参数均为选填）：
 *   ```finance-log
 *   date: 2026-07-15
 *   day: 3
 *   amount: >100
 *   account: 现金
 *   type: 餐饮
 *   owner: 自己
 *   ```
 *
 * 参数语义：
 *   date: YYYY-MM-DD — 窗口的**起始日**（即最新的一天），缺省为今天
 *   day: N           — 从起始日往前数 N 天（含起始日，默认 30；1=只看起始日当天；0=不限天数）
 *   amount: 表达式   — 按金额绝对值筛选，单位「元」
 *   account: 现金    — 任一分录账户命中即算（子串匹配，忽略大小写）
 *   type: 餐饮       — 按交易类型筛选
 *   owner: 自己      — 按归属维度筛选
 *   id: ^t-xxx       — 按块引用 ID 精确查询（多个用 ; 分隔），命中后忽略 date/day 窗口
 *
 * 交互：kind 下拉 + 账户下拉 + 搜索框 + 点击行展开 leg 明细。
 */

import type { MarkdownPostProcessorContext, App } from 'obsidian';
import type { Indexer, IndexEntry } from '../ledger/indexer';
import type { FinanceConfig } from '../types';
import { t } from '../i18n';
import { todayLocal, daysBefore, isDateStr } from '../util/date';
import { resolveAccountClass, dirOfPost } from '../util/ledgerView';
import { BLOCK_ICONS, setSvg } from './icons';
import { setHtml } from '../util/dom';

/** 金额区间（闭区间，单位：分）。严格比较在解析阶段已折算成闭区间边界。 */
export interface AmountRange {
  min?: number;
  max?: number;
  raw: string; // 原始表达式，用于回显筛选条件
}

export interface LogParams {
  day: number; // 从起始日往前数 N 天，0=不限天数
  date?: string; // 起始日（窗口最新的一天），缺省为今天
  type?: string; // 按交易类型筛选
  account?: string; // 按账户筛选
  owner?: string; // 按归属维度筛选
  amount?: AmountRange; // 按金额范围筛选
  ids?: string[]; // 按块引用 ID 精确查询
}

function normalizeId(id: string): string {
  return id.trim().replace(/^\^/, '');
}

/** 元 → 分（四舍五入到整数分，避免浮点误差） */
function yuanToCents(yuan: string): number {
  return Math.round(parseFloat(yuan) * 100);
}

const NUM = String.raw`-?\d+(?:\.\d+)?`;

/**
 * 解析金额筛选表达式，统一折算为**闭区间**（单位：分）。
 *
 * 支持：>100 / ≥100 / >=100 / <50 / ≤50 / <=50 / 100-200 / 100~200 / =100 / 100
 * 无法识别时返回 undefined（视为不筛选）。
 */
export function parseAmountRange(raw: string): AmountRange | undefined {
  const s = raw.trim();
  if (!s) return undefined;

  let m: RegExpExecArray | null;

  if ((m = new RegExp(`^(?:>=|=>|≥)\\s*(${NUM})$`).exec(s))) {
    return { min: yuanToCents(m[1]), raw: s };
  }
  if ((m = new RegExp(`^>\\s*(${NUM})$`).exec(s))) {
    return { min: yuanToCents(m[1]) + 1, raw: s };
  }
  if ((m = new RegExp(`^(?:<=|=<|≤)\\s*(${NUM})$`).exec(s))) {
    return { max: yuanToCents(m[1]), raw: s };
  }
  if ((m = new RegExp(`^<\\s*(${NUM})$`).exec(s))) {
    return { max: yuanToCents(m[1]) - 1, raw: s };
  }
  if ((m = new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(?:-|~|\\.\\.)\\s*(\\d+(?:\\.\\d+)?)$`).exec(s))) {
    const a = yuanToCents(m[1]);
    const b = yuanToCents(m[2]);
    return { min: Math.min(a, b), max: Math.max(a, b), raw: s };
  }
  if ((m = new RegExp(`^=?\\s*(${NUM})$`).exec(s))) {
    const v = yuanToCents(m[1]);
    return { min: v, max: v, raw: s };
  }

  return undefined;
}

/** 解析代码块源码为参数对象。未知键忽略，非法值降级为「不筛选」。 */
export function parseParams(source: string): LogParams {
  const params: LogParams = { day: 30 };

  for (const line of source.split(/\r?\n/)) {
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (!value) continue;

    switch (key) {
      case 'day': {
        const n = parseInt(value, 10);
        if (!isNaN(n) && n >= 0) params.day = n;
        break;
      }
      case 'date':
        if (isDateStr(value)) params.date = value;
        break;
      case 'id':
        params.ids = value
          .split(';')
          .map((s) => normalizeId(s))
          .filter((s) => s.length > 0);
        break;
      case 'type':
        params.type = value;
        break;
      case 'account':
        params.account = value;
        break;
      case 'owner':
        params.owner = value;
        break;
      case 'amount':
        params.amount = parseAmountRange(value);
        break;
    }
  }

  return params;
}

function fmtAmount(cents: number): string {
  const yuan = Math.abs(cents) / 100;
  const sign = cents < 0 ? '-' : '+';
  return `${sign}¥${yuan.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** 判断是否为「期初结转 / 余额承接」分录：流水视图默认隐藏 */
function isCarryForwardEntry(entry: IndexEntry): boolean {
  const txn = entry.transaction;
  return txn.narration === '期初结转 · 余额承接' || txn.fields?.period === '期初';
}

/**
 * 取一笔交易的「代表金额」（分，带符号）。
 * 优先支出腿（负），否则收入腿（正）。
 */
export function entryAmount(entry: IndexEntry): number {
  const legs = entry.transaction.legs;
  const outLeg = legs.find((l) => l.amount < 0);
  if (outLeg) return outLeg.amount;
  const inLeg = legs.find((l) => l.amount > 0);
  return inLeg ? inLeg.amount : 0;
}

/**
 * 一笔交易的收入/支出金额（分），严格按账户类别推导：
 * income = Σ|收入类 leg|，expense = Σ|费用类 leg|。
 * 资产转换（买/卖/转账）只动资产账户，income/expense 均为 0。
 */
export function entryFlow(entry: IndexEntry, config?: FinanceConfig): { income: number; expense: number } {
  let income = 0;
  let expense = 0;
  for (const leg of entry.transaction.legs) {
    const c = resolveAccountClass(leg.account, config);
    if (c === 'income') income += Math.abs(leg.amount);
    else if (c === 'expense') expense += Math.abs(leg.amount);
  }
  return { income, expense };
}

/** 一行流水展示用的方向标签（流入/流出/转账），按账户类别 + 净资产变动推导 */
export function entryDir(entry: IndexEntry, config?: FinanceConfig): { label: string; cls: string } {
  const { income, expense } = entryFlow(entry, config);
  if (expense > 0) return { label: t('log.dir.out'), cls: 'out' };
  if (income > 0) return { label: t('log.dir.in'), cls: 'in' };
  const net = entry.transaction.legs.reduce((s, l) => s + l.amount, 0);
  if (net > 0) return { label: t('log.dir.in'), cls: 'in' };
  if (net < 0) return { label: t('log.dir.out'), cls: 'out' };
  return { label: t('log.dir.transfer'), cls: 'flat' };
}

/**
 * 推导一笔交易的语义分类（kind），用于流水行显示与筛选。
 * 基于交易结构（legs 账户类别）推导，不依赖 txnType 标签。
 */
export function entryKind(entry: IndexEntry, config?: FinanceConfig): {
  kind: string;
  label: string;
  cls: string;
} {
  const { income, expense } = entryFlow(entry, config);

  if (expense > 0 && income === 0) {
    return { kind: 'expense', label: t('log.kind.expense'), cls: 'k-out' };
  }
  if (income > 0 && expense === 0) {
    return { kind: 'income', label: t('log.kind.income'), cls: 'k-in' };
  }

  // 纯 balance sheet 变动 → 判断是买/卖/转账
  const allBalanceSheet = entry.transaction.legs.every((l) => {
    const c = resolveAccountClass(l.account, config);
    return c === 'asset' || c === 'liability' || c === 'equity';
  });

  if (allBalanceSheet && entry.transaction.legs.length >= 2) {
    const assetLegs = entry.transaction.legs.filter((l) => resolveAccountClass(l.account, config) === 'asset');
    if (assetLegs.length >= 2) {
      const assetDelta = assetLegs.reduce((s, l) => s + l.amount, 0);
      if (assetDelta > 0) return { kind: 'buy', label: t('log.kind.buy'), cls: 'k-flat' };
      if (assetDelta < 0) return { kind: 'sell', label: t('log.kind.sell'), cls: 'k-flat' };
    }
    return { kind: 'transfer', label: t('log.kind.transfer'), cls: 'k-flat' };
  }

  // 混合（收入+支出同时出现）→ 按净额判定
  if (income > 0 && expense > 0) {
    return income >= expense
      ? { kind: 'income', label: t('log.kind.income'), cls: 'k-in' }
      : { kind: 'expense', label: t('log.kind.expense'), cls: 'k-out' };
  }

  return { kind: 'transfer', label: t('log.kind.transfer'), cls: 'k-flat' };
}

function includesFold(haystack: string | undefined, needle: string): boolean {
  return (haystack || '').toLowerCase().includes(needle.trim().toLowerCase());
}

/**
 * 全部筛选逻辑的唯一入口（纯函数，便于单测）。
 *
 * 顺序：排除期初结转 → ID 精确查询 or 日期窗口 → 属性筛选（金额/账户/类型/归属）。
 */
export function filterEntries(
  entries: IndexEntry[],
  params: LogParams,
  today: string = todayLocal(),
): IndexEntry[] {
  let filtered = entries.filter((e) => !isCarryForwardEntry(e));

  if (params.ids && params.ids.length > 0) {
    const idSet = new Set(params.ids);
    filtered = filtered.filter(
      (e) => e.blockRefId !== undefined && idSet.has(normalizeId(e.blockRefId)),
    );
  } else {
    const anchor = params.date ?? today;
    if (params.day > 0) {
      const start = daysBefore(anchor, params.day - 1);
      filtered = filtered.filter((e) => e.transaction.date >= start && e.transaction.date <= anchor);
    } else if (params.date) {
      filtered = filtered.filter((e) => e.transaction.date <= anchor);
    }
  }

  if (params.type) {
    filtered = filtered.filter((e) => includesFold(e.transaction.txnType, params.type!));
  }
  if (params.owner) {
    filtered = filtered.filter((e) => includesFold(e.transaction.owner, params.owner!));
  }
  if (params.account) {
    filtered = filtered.filter((e) =>
      e.transaction.legs.some((l) => includesFold(l.account, params.account!)),
    );
  }
  if (params.amount) {
    const { min, max } = params.amount;
    filtered = filtered.filter((e) => {
      const abs = Math.abs(entryAmount(e));
      if (min !== undefined && abs < min) return false;
      if (max !== undefined && abs > max) return false;
      return true;
    });
  }

  return filtered;
}

/** 头部 pill 的时间范围文案 */
function buildRangeLabel(params: LogParams): string {
  if (params.ids && params.ids.length > 0) {
    return t('log.dayLabel.byId', { n: String(params.ids.length) });
  }
  const d = params.date;
  if (params.day === 1) {
    return d ? t('log.dayLabel.dateOnly', { d }) : t('log.dayLabel.today');
  }
  if (params.day > 0) {
    return d
      ? t('log.dayLabel.daysUntil', { n: String(params.day), d })
      : t('log.dayLabel.days', { n: String(params.day) });
  }
  return d ? t('log.dayLabel.until', { d }) : t('log.dayLabel.all');
}

/** 收集「日期窗口之外」的筛选条件，供顶部 chip 回显 */
function collectCriteria(params: LogParams): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (params.amount) out.push([t('log.criteria.amount'), params.amount.raw]);
  if (params.account) out.push([t('log.criteria.account'), params.account]);
  if (params.type) out.push([t('log.criteria.type'), params.type]);
  if (params.owner) out.push([t('log.criteria.owner'), params.owner]);
  return out;
}

/**
 * 计算每笔交易的「头条」净变动信息（用于流水行主显示）。
 * 返回：方向标签、金额、方向 CSS class、可选附加信息（如已实现损益）。
 */
function headline(
  entry: IndexEntry,
  config?: FinanceConfig,
): { amount: number; dir: string; cls: string; sub: string } {
  const legs = entry.transaction.legs;
  const assetLegs = legs.filter((l) => resolveAccountClass(l.account, config) === 'asset');
  const assetDelta = assetLegs.reduce((s, l) => s + l.amount, 0);
  const nonCashAsset = assetLegs.filter((l) => !/现金|活期/.test(l.account));
  const cashPost = legs.find((l) => /现金|活期/.test(l.account));
  const gainPost = legs.find((l) => l.account.includes('投资收益'));

  const kind = entryKind(entry, config);
  let amount: number;
  let dir: string;
  let cls: string;
  let sub = '';

  switch (kind.kind) {
    case 'income':
      amount = Math.abs(assetDelta);
      dir = t('log.headline.inflow');
      cls = 'in';
      break;
    case 'expense':
      amount = Math.abs(assetDelta);
      dir = t('log.headline.outflow');
      cls = 'out';
      break;
    case 'buy':
      amount = nonCashAsset.length ? Math.abs(nonCashAsset[0].amount) : Math.abs(assetDelta);
      dir = t('log.headline.buyAsset');
      cls = 'flat';
      break;
    case 'sell': {
      amount = cashPost ? Math.abs(cashPost.amount) : Math.abs(assetDelta);
      dir = t('log.headline.sellAsset');
      cls = 'flat';
      if (gainPost) {
        const gainAmt = Math.abs(gainPost.amount);
        const yuan = gainAmt / 100;
        const sign = gainPost.amount >= 0 ? '+' : '-';
        sub = `${t('log.headline.realized')} ${sign}¥${yuan.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      }
      break;
    }
    default:
      // transfer / mixed
      amount = Math.abs(assetDelta);
      dir = t('log.headline.transfer');
      cls = 'flat';
  }

  return { amount, dir, cls, sub };
}

/** 格式化每条 leg 的展示：金额取正值，方向用标签（流入/流出/来源/去向） */
function postingLine(leg: { account: string; amount: number }, config?: FinanceConfig): {
  account: string;
  dirLabel: string;
  dirCls: string;
  amount: string;
} {
  const d = dirOfPost(leg, config);
  const yuan = Math.abs(leg.amount) / 100;
  const amount = `¥${yuan.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return { account: leg.account, dirLabel: d.label, dirCls: d.cls, amount };
}

// ─── 主渲染函数 ──────────────────────────────────────────────

export function renderLog(
  source: string,
  el: HTMLElement,
  _ctx: MarkdownPostProcessorContext,
  _app: App,
  indexer: Indexer,
  _ledgerPath: string,
  config?: FinanceConfig,
): void {
  const params = parseParams(source);
  el.empty();

  const root = el.createDiv({ cls: 'finance-block finance-log' });

  // ── 头部（图标 + 标题 + 状态 pill） ──
  const head = root.createDiv({ cls: 'fb-head' });
  setSvg(head.createDiv({ cls: 'fb-icon' }), BLOCK_ICONS.log);
  head.createDiv({ cls: 'fb-title', text: t('log.title') });
  const dayLabel = buildRangeLabel(params);
  const rangePill = head.createDiv({ cls: 'fb-pill', text: dayLabel });

  // ── 生效中的筛选条件回显（仅在用了额外筛选时出现） ──
  const criteria = collectCriteria(params);
  if (criteria.length > 0) {
    const bar = root.createDiv({ cls: 'log-criteria' });
    for (const [label, value] of criteria) {
      const chip = bar.createSpan({ cls: 'log-chip' });
      chip.createSpan({ cls: 'log-chip-k', text: label });
      chip.createSpan({ cls: 'log-chip-v', text: value });
    }
  }

  // ── 取数 ──
  const allEntries = [...indexer.getAllTransactions()];
  allEntries.sort((a, b) => b.transaction.date.localeCompare(a.transaction.date));
  const filtered = filterEntries(allEntries, params);

  // ── 筛选工具栏（kind 下拉 + 账户下拉 + 搜索框） ──
  const filterBar = root.createDiv({ cls: 'log-filterbar' });

  // kind 下拉：从筛选结果动态提取可用 kind
  filterBar.createSpan({ cls: 'flabel', text: t('log.filter.kindLabel') });
  const kindSel = filterBar.createEl('select', { cls: 'log-select' });
  kindSel.createEl('option', { text: t('log.filter.all'), value: '' });
  const kindSet = new Map<string, string>();
  for (const e of filtered) {
    const k = entryKind(e, config);
    if (!kindSet.has(k.kind)) kindSet.set(k.kind, k.label);
  }
  for (const [kind, label] of kindSet) {
    kindSel.createEl('option', { text: label, value: kind });
  }

  // 账户下拉：从筛选结果动态提取
  const acctSel = filterBar.createEl('select', { cls: 'log-select' });
  acctSel.createEl('option', { text: t('log.filter.allAccounts'), value: '' });
  const acctSet = new Set<string>();
  for (const e of filtered) {
    for (const leg of e.transaction.legs) acctSet.add(leg.account);
  }
  [...acctSet].sort().forEach((a) => acctSel.createEl('option', { text: a, value: a }));

  // 搜索框
  const searchInput = filterBar.createEl('input', {
    cls: 'log-search',
    type: 'text',
    attr: { placeholder: t('log.filter.searchPlaceholder') },
  });

  // ── 统计摘要 ──
  const summary = root.createDiv({ cls: 'bc-summary' });

  // ── 流水列表 ──
  const regEl = root.createDiv({ cls: 'reg-list' });

  if (filtered.length === 0) {
    const emptyMsg = params.ids && params.ids.length > 0
      ? t('log.idNotFound')
      : criteria.length > 0
        ? t('log.emptyFiltered')
        : t('log.empty');
    regEl.createDiv({ cls: 'bc-empty', text: emptyMsg });
    summary.remove();
    return;
  }

  // ── 渲染与筛选 ──
  interface RowData {
    el: HTMLElement;
    entry: IndexEntry;
    flow: { income: number; expense: number };
  }
  const rows: RowData[] = [];

  function renderRows(): void {
    regEl.empty();
    rows.length = 0;

    const kindFilter = kindSel.value;
    const acctFilter = acctSel.value;
    const search = searchInput.value.toLowerCase().trim();

    const visible = filtered.filter((e) => {
      if (kindFilter) {
        const k = entryKind(e, config);
        if (k.kind !== kindFilter) return false;
      }
      if (acctFilter && !e.transaction.legs.some((l) => l.account === acctFilter)) return false;
      if (search) {
        const hay = (
          e.transaction.narration +
          ' ' +
          e.transaction.legs.map((l) => l.account).join(' ')
        ).toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    if (visible.length === 0) {
      regEl.createDiv({ cls: 'bc-empty', text: t('log.emptyFiltered') });
      updateSummary([]);
      return;
    }

    for (const entry of visible) {
      const rowEl = renderEntry(regEl, entry, config);
      const flow = entryFlow(entry, config);
      rows.push({ el: rowEl, entry, flow });
    }

    updateSummary(visible);
  }

  function updateSummary(visible: IndexEntry[]): void {
    let income = 0;
    let expense = 0;
    let drafts = 0;
    for (const e of visible) {
      if (e.isDraft) {
        drafts++;
        continue;
      }
      const f = entryFlow(e, config);
      income += f.income;
      expense += f.expense;
    }
    const net = income - expense;
    setHtml(
      summary,
      `<span class="s-item">${t('log.summary.count', { n: String(visible.length) })}</span>` +
        `<span class="s-item">${t('log.summary.income')} <b class="pos">${fmtAmount(income)}</b></span>` +
        `<span class="s-item">${t('log.summary.expense')} <b class="neg">${fmtAmount(-expense)}</b></span>` +
        `<span class="s-item">${t('log.summary.net')} <b class="${net >= 0 ? 'pos' : 'neg'}">${fmtAmount(net)}</b></span>` +
        (drafts ? `<span class="s-item" style="color:var(--text-faint)">${t('log.summary.draftNote', { n: String(drafts) })}</span>` : ''),
    );

    rangePill.textContent = `${dayLabel} · ${t('log.summary.count', { n: String(visible.length) })}`;
  }

  // 事件绑定
  kindSel.addEventListener('change', () => renderRows());
  acctSel.addEventListener('change', () => renderRows());
  searchInput.addEventListener('input', () => renderRows());

  renderRows();
}

/** 渲染单笔流水行（点击展开 leg 明细） */
function renderEntry(parent: HTMLElement, entry: IndexEntry, config?: FinanceConfig): HTMLElement {
  const txn = entry.transaction;
  const narration = txn.narration || t('log.noNarration');
  const h = headline(entry, config);
  const kind = entryKind(entry, config);

  const row = parent.createDiv({ cls: `reg-row ${entry.isDraft ? 'is-draft' : ''}`.trim() });

  // 主行：日期 | kind pill | 摘要 | 方向 | 金额 [+已实现]
  const main = row.createDiv({ cls: 'reg-main' });
  main.createSpan({ cls: 'reg-date', text: txn.date.slice(5) }); // MM-DD
  main.createSpan({ cls: `kind-pill ${kind.cls}`, text: kind.label });
  main.createSpan({ cls: 'reg-narr', text: narration });
  main.createSpan({ cls: `reg-dir ${h.cls}`, text: h.dir });

  const sign = h.cls === 'in' ? '+' : h.cls === 'out' ? '-' : '';
  const yuan = h.amount / 100;
  const amtText = `${sign}¥${yuan.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  main.createSpan({ cls: `reg-amt ${h.cls}`, text: amtText });

  if (h.sub) {
    main.createSpan({ cls: 'reg-sub', text: h.sub });
  }

  // 分录明细（默认隐藏，点击行展开）
  const posts = row.createDiv({ cls: 'reg-posts' });
  for (const leg of txn.legs) {
    const p = postingLine(leg, config);
    const postEl = posts.createDiv({ cls: 'reg-post' });
    postEl.createSpan({ cls: 'reg-pacc', text: p.account });
    postEl.createSpan({ cls: `reg-pdir ${p.dirCls}`, text: p.dirLabel });
    postEl.createSpan({ cls: 'reg-pamt', text: p.amount });
  }

  // 点击行切换展开
  row.addEventListener('click', () => row.toggleClass('is-open', !row.hasClass('is-open')));

  return row;
}
