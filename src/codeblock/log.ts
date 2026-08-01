/**
 * finance-log 渲染块：从索引取数，倒序展示交易流水（时间线式）。
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
 *                      例：date=2026-07-15 且 day=3 → 命中 07-13 / 07-14 / 07-15
 *   amount: 表达式   — 按金额绝对值筛选，单位「元」；支持 >100 / >=100 / <50 / <=50 / 100-200 / 100
 *   account: 现金    — 任一分录账户命中即算（子串匹配，忽略大小写）
 *   type: 餐饮       — 按交易类型筛选
 *   owner: 自己      — 按归属维度筛选
 *   id: ^t-xxx       — 按块引用 ID 精确查询（多个用 ; 分隔），命中后忽略 date/day 窗口
 *
 * 原型交互：顶部筛选（全部/收入/支出/草稿）+ 动态统计（随显示条数实时重算，草稿不计入收支）。
 */

import type { MarkdownPostProcessorContext, App } from 'obsidian';
import type { Indexer, IndexEntry } from '../ledger/indexer';
import { t } from '../i18n';
import { todayLocal, daysBefore, isDateStr } from '../util/date';
import { BLOCK_ICONS, setSvg } from './icons';

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
 * 因为金额内部是整数分，严格比较可以无损转成闭区间：`>100` ≡ `>=100.01` ≡ min=10001。
 * 这样下游只需一套 min/max 比较逻辑，不必再维护 exclusive 标志位。
 *
 * 支持：>100 / ≥100 / >=100 / <50 / ≤50 / <=50 / 100-200 / 100~200 / =100 / 100
 * 无法识别时返回 undefined（视为不筛选，避免把用户的账目全部隐藏）。
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
  // 区间：100-200 / 100~200 / 100..200（负号已被前面的单边表达式排除，此处只认正数区间）
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
 * 与卡片右侧展示的金额保持同一口径：优先支出腿（负），否则收入腿（正）。
 */
export function entryAmount(entry: IndexEntry): number {
  const legs = entry.transaction.legs;
  const outLeg = legs.find((l) => l.amount < 0);
  if (outLeg) return outLeg.amount;
  const inLeg = legs.find((l) => l.amount > 0);
  return inLeg ? inLeg.amount : 0;
}

function includesFold(haystack: string | undefined, needle: string): boolean {
  return (haystack || '').toLowerCase().includes(needle.trim().toLowerCase());
}

/**
 * 全部筛选逻辑的唯一入口（纯函数，便于单测）。
 *
 * 顺序：排除期初结转 → ID 精确查询 or 日期窗口 → 属性筛选（金额/账户/类型/归属）。
 * ID 与日期窗口互斥：给了 ID 就说明用户要看指定的那几笔，不该再被时间窗口裁掉。
 * 属性筛选对两条路径都生效，语义一致。
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
      // day=0 表示不限天数；给了起始日时仍以其为上界（看该日及更早的全部账目）
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

/** 头部 pill 的时间范围文案：把 date + day 的组合翻译成人话 */
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

export function renderLog(
  source: string,
  el: HTMLElement,
  _ctx: MarkdownPostProcessorContext,
  _app: App,
  indexer: Indexer,
  _ledgerPath: string,
): void {
  const params = parseParams(source);
  el.empty();

  const root = el.createDiv({ cls: 'finance-block finance-log' });

  // ── 头部（图标 + 标题 + 状态 pill） ──
  const head = root.createDiv({ cls: 'fb-head' });
  setSvg(head.createDiv({ cls: 'fb-icon' }), BLOCK_ICONS.log);
  head.createDiv({ cls: 'fb-title', text: t('log.title') });

  const dayLabel = buildRangeLabel(params);
  head.createDiv({ cls: 'fb-pill', text: dayLabel });

  const statusEl = root.createDiv({ cls: 'log-status' });

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

  // ── 顶部筛选 + 动态统计 ──
  const toolbar = root.createDiv({ cls: 'log-toolbar' });
  const filter = toolbar.createDiv({
    cls: 'log-filter',
    attr: { role: 'group', 'aria-label': t('log.title') },
  });
  const filters: Array<[string, string]> = [
    ['all', t('log.filter.all')],
    ['in', t('log.filter.in')],
    ['out', t('log.filter.out')],
    ['draft', t('log.filter.draft')],
  ];
  const filterBtns: HTMLElement[] = [];
  for (const [key, label] of filters) {
    const b = filter.createEl('button', {
      cls: `lf-btn${key === 'all' ? ' is-active' : ''}`,
      text: label,
      attr: { 'data-filter': key },
    });
    filterBtns.push(b);
  }
  const countEl = toolbar.createSpan({ cls: 'log-count' });

  const summary = root.createDiv({ cls: 'bc-summary' });

  // ── 取数 ──
  const allEntries = indexer.getAllTransactions();
  allEntries.sort((a, b) => b.transaction.date.localeCompare(a.transaction.date));

  const filtered = filterEntries(allEntries, params);

  // ── 按日期分组渲染 ──
  const rows: { el: HTMLElement; amt: number; draft: boolean }[] = [];
  const listWrap = root.createDiv({ cls: 'log-lists' });

  if (filtered.length === 0) {
    statusEl.textContent =
      params.ids && params.ids.length > 0
        ? t('log.idNotFound')
        : criteria.length > 0
          ? t('log.emptyFiltered')
          : t('log.empty');
    summary.remove();
    return;
  }

  let lastDate = '';
  let currentList: HTMLElement | null = null;
  for (const entry of filtered) {
    if (entry.transaction.date !== lastDate) {
      lastDate = entry.transaction.date;
      listWrap.createDiv({ text: entry.transaction.date, cls: 'log-day' });
      currentList = listWrap.createDiv({ cls: 'log-list' });
    }
    const rowInfo = renderEntry(currentList!, entry);
    rows.push(rowInfo);
  }

  statusEl.textContent = t('log.count', { label: dayLabel, n: String(filtered.length) });

  // ── 动态统计 + 筛选逻辑（随显示条数变化） ──
  function recompute(): void {
    let income = 0;
    let expense = 0;
    let count = 0;
    let drafts = 0;
    for (const r of rows) {
      if (r.el.style.display === 'none') continue;
      count++;
      if (r.draft) {
        drafts++;
        continue;
      }
      if (r.amt > 0) income += r.amt;
      else expense += Math.abs(r.amt);
    }
    const net = income - expense;
    summary.innerHTML =
      `<span class="s-item">${t('log.summary.show', { n: String(count) })}</span>` +
      `<span class="s-item">${t('log.summary.income')} <b class="pos">${fmtAmount(income)}</b></span>` +
      `<span class="s-item">${t('log.summary.expense')} <b class="neg">${fmtAmount(-expense)}</b></span>` +
      `<span class="s-item">${t('log.summary.net')} <b class="${net >= 0 ? 'pos' : 'neg'}">${fmtAmount(net)}</b></span>` +
      (drafts ? `<span class="s-item" style="color:var(--text-faint)">${t('log.summary.draftNote', { n: String(drafts) })}</span>` : '');
    countEl.textContent = t('log.summary.show', { n: String(count) });
  }

  function applyFilter(type: string): void {
    for (const r of rows) {
      let show = true;
      if (type === 'in') show = r.amt > 0 && !r.draft;
      else if (type === 'out') show = r.amt < 0 && !r.draft;
      else if (type === 'draft') show = r.draft;
      r.el.style.display = show ? '' : 'none';
    }
    // 隐藏没有可见行的日期分组
    listWrap.querySelectorAll('.log-day').forEach((dayEl) => {
      const list = dayEl.nextElementSibling;
      if (list && list.classList.contains('log-list')) {
        const anyVisible = Array.from(list.children).some((c) => (c as HTMLElement).style.display !== 'none');
        (dayEl as HTMLElement).style.display = anyVisible ? '' : 'none';
      }
    });
    recompute();
  }

  for (const b of filterBtns) {
    b.addEventListener('click', () => {
      filterBtns.forEach((x) => x.removeClass('is-active'));
      b.addClass('is-active');
      applyFilter(b.getAttribute('data-filter') || 'all');
    });
  }

  recompute();
}

function renderEntry(parent: HTMLElement, entry: IndexEntry): { el: HTMLElement; amt: number; draft: boolean } {
  const txn = entry.transaction;
  const narration = txn.narration || t('log.noNarration');

  // 与 filterEntries 的 amount 筛选共用同一口径，避免「筛出来的金额」与「显示的金额」对不上
  const amt = entryAmount(entry);

  const row = parent.createDiv({ cls: `log-row ${entry.isDraft ? 'is-draft' : ''}` });
  row.createDiv({ cls: 'log-dot' });

  const main = row.createDiv({ cls: 'log-main' });
  main.createDiv({ cls: 'log-narr', text: narration });
  const accounts = txn.legs.map((l) => l.account).join(' → ');
  main.createDiv({ cls: 'log-sub', text: accounts });

  const right = row.createDiv({ cls: 'log-right' });
  if (amt !== 0) {
    right.createDiv({ cls: `log-amt ${amt > 0 ? 'in' : 'out'}`, text: fmtAmount(amt) });
  }
  right.createDiv({
    cls: `log-cat ${entry.isDraft ? 'is-draft' : ''}`,
    text: entry.isDraft ? `草稿 · 待确认` : txn.txnType || '',
  });

  return { el: row, amt, draft: entry.isDraft };
}
