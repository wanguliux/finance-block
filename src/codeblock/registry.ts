/**
 * 代码块处理器注册表：将所有 finance 系列代码块统一注册。
 * 存储层（真源）：fin-beancount —— 数据真源，渲染为交易卡片 + 零和校验 + 入账/批量入账/汇总结转/复制。
 * 渲染层（视图）：finance-log / finance-ficalc / finance-budget / finance-heatmap。
 * 注：原 finance-fi（财务自由进度仪表）的能力已并入 finance-ficalc；现本块定位为 what-if 沙盒，
 * 参数一律手填（不再有「从账本取数」开关）。不再保留兼容别名——存量笔记里老的 ```finance-fi 代码块需手动改为 ```finance-ficalc。
 */

import { App, MarkdownPostProcessorContext, Notice, TFile, normalizePath } from 'obsidian';
import { parseFinBeancount } from '../parser/finBeancount';
import { renderFICalc } from './ficalc';
import { renderLog } from './log';
import { renderBudget } from './budget';
import { renderHeatmap } from './heatmap';
import { renderAssets } from './assets';
import { renderRecurring } from './recurring';
import { postTransactionsInBlock, splitEntries } from '../ledger/poster';
import { calculateBalances } from '../ledger/closing';
import { localDateString } from '../util/date';
import { Indexer } from '../ledger/indexer';
import { t } from '../i18n';
import {
  addDays,
  computeLedgerSummary,
  dirOfPost,
  fmtCents,
  fmtMD,
  ledgerDisplayName,
  parseYmd,
  weekStart,
} from '../util/ledgerView';
import { copyText } from '../util/clipboard';
import { auditTransaction, type TxnWarning } from '../engine/audit';
import { BLOCK_ICONS, ICON_COPY, ICON_CHECK, ICON_ARROW, ICON_CARET, setSvg } from './icons';
import type { FinanceConfig, Transaction, Valuation, AccountDef, AmountInCents, LoanDef, LoanPeriod, RecurringPlanDef } from '../types';
import { AppendDraftToBlockModal } from '../ui/AppendDraftToBlockModal';
import type { BlockDefinitionWithParams } from '../blockProvider';

export interface CodeBlockProcessor {
  language: string;
  render: (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => void;
}

/** 处理器依赖：由 main.ts 注入 */
export interface ProcessorDeps {
  app: App;
  indexer: Indexer;
  getLedgerPath: () => string;
  getArchiveLedgers: () => string[]; // 已结转归档的账本路径列表（用于账本流转链）
  getFinanceConfig: () => FinanceConfig | undefined;
  getBlockDefinitions: () => BlockDefinitionWithParams[]; // 供「加入草稿」弹窗构造表单字段
  openRolloverModal: () => void; // 打开汇总结转弹窗（由 main.ts 注入，携带 settings/saveSettings）
  openRecordModal: () => void; // 打开「记一笔」弹窗（侧栏 ribbon / 命令面板入口使用）
  openValuationModal: (account?: string) => void; // 打开「更新估值」弹窗（资产总览卡片按钮触发）
  openLifeEventModal: (onChanged?: () => void) => void; // 打开「人生事件」弹窗（现金流模拟器事件层入口）；onChanged 在事件变更后回调，用于重算刷新
  // ── finance-recurring（日常花费 + 贷款） ──
  postRecurringEntry: (plan: RecurringPlanDef, date: string, amountCents: AmountInCents) => Promise<void>; // 日常草稿入账（写账本 + 刷新索引）
  skipRecurringEntry: (planId: string, date: string) => Promise<void>; // 日常草稿跳过（写 recurringSkips）
  postLoanEntry: (loan: LoanDef, period: LoanPeriod) => Promise<void>; // 贷款期入账（3 腿写账本 + 刷新索引）
  saveRecurringPlan: (plan: RecurringPlanDef) => Promise<void>; // 新建/更新日常计划（含暂停/启用）
  removeRecurringPlan: (planId: string) => Promise<void>; // 删除日常计划
  saveLoan: (loan: LoanDef) => Promise<void>; // 新建/更新贷款（含暂停/启用）
  removeLoan: (loanId: string) => Promise<void>; // 删除贷款
  openRecurringPlanModal: (plan?: RecurringPlanDef, onChanged?: () => void) => void; // 打开日常计划弹窗
  openLoanModal: (loan?: LoanDef, onChanged?: () => void) => void; // 打开贷款弹窗
}

// ─── 已渲染代码块登记表（切语言时整体重渲染） ─────────────
interface ActiveBlock {
  el: HTMLElement;
  source: string;
  ctx: MarkdownPostProcessorContext;
  language: string;
}

// 当前工作区里所有已挂载的 finance 代码块 DOM。
// 切语言时遍历它们整体重渲染（Reading 与 Live Preview 两种模式通用）。
const activeBlocks = new Map<HTMLElement, ActiveBlock>();
const processorsByLang = new Map<string, CodeBlockProcessor>();
let pruneRegistered = false;

function registerActiveBlock(el: HTMLElement, source: string, ctx: MarkdownPostProcessorContext, language: string): void {
  activeBlocks.set(el, { el, source, ctx, language });
}

/** 切换语言后调用：重渲染工作区里所有已挂载的 finance 代码块 */
export function rerenderAllBlocks(): void {
  const records = Array.from(activeBlocks.entries());
  for (const [el, rec] of records) {
    if (!el.isConnected) {
      activeBlocks.delete(el);
      continue;
    }
    el.empty();
    processorsByLang.get(rec.language)?.render(rec.source, rec.el, rec.ctx);
  }
}

/**
 * 创建所有代码块处理器（依赖注入 app 与配置获取器）。
 */
export function createProcessors(deps: ProcessorDeps): CodeBlockProcessor[] {
  const base: CodeBlockProcessor[] = [
    // ── 存储层：fin-beancount 真源渲染
    {
      language: 'fin-beancount',
      render: (source, el, ctx) =>
        renderBeancountSource(
          source,
          el,
          ctx,
          deps.app,
          deps.getLedgerPath(),
          deps.getArchiveLedgers(),
          deps.indexer,
          deps.openRolloverModal,
          deps.getBlockDefinitions,
          deps.getFinanceConfig,
          deps.openValuationModal,
        ),
    },

    // ── 视图层：finance-log 流水
    {
      language: 'finance-log',
      render: (source, el, ctx) => renderLog(source, el, ctx, deps.app, deps.indexer, deps.getLedgerPath(), deps.getFinanceConfig()),
    },

    // ── 视图层：finance-ficalc 现金流模拟器（已并入原 finance-fi 的账本派生能力 + 阶段三人生事件）
    {
      language: 'finance-ficalc',
      render: (source, el, ctx) => renderFICalc(
        source, el, ctx,
        deps.getFinanceConfig(), deps.app, deps.indexer, deps.getLedgerPath(),
        deps.openLifeEventModal,
      ),
    },

    // ── 视图层：finance-budget 预算执行率
    {
      language: 'finance-budget',
      render: (source, el, ctx) => renderBudget(source, el, ctx, deps.app, deps.indexer, deps.getFinanceConfig()),
    },

    // ── 视图层：finance-heatmap 支出热力图
    {
      language: 'finance-heatmap',
      render: (source, el, ctx) => renderHeatmap(source, el, ctx, deps.app, deps.indexer, deps.getFinanceConfig()),
    },

    // ── 视图层：finance-assets 资产总览
    {
      language: 'finance-assets',
      render: (source, el, ctx) => renderAssets(
        source, el, ctx, deps.getFinanceConfig(), deps.indexer,
        deps.getLedgerPath(), deps.app, deps.openValuationModal,
      ),
    },

    // ── 视图层：finance-recurring 日常花费 + 贷款（V1 + V2）
    {
      language: 'finance-recurring',
      render: (source, el, ctx) => renderRecurring(source, el, ctx, {
        app: deps.app,
        getFinanceConfig: deps.getFinanceConfig,
        indexer: deps.indexer,
        postRecurringEntry: deps.postRecurringEntry,
        skipRecurringEntry: deps.skipRecurringEntry,
        postLoanEntry: deps.postLoanEntry,
        saveRecurringPlan: deps.saveRecurringPlan,
        removeRecurringPlan: deps.removeRecurringPlan,
        saveLoan: deps.saveLoan,
        removeLoan: deps.removeLoan,
        openRecurringPlanModal: deps.openRecurringPlanModal,
        openLoanModal: deps.openLoanModal,
      }),
    },
  ];

  processorsByLang.clear();
  for (const p of base) processorsByLang.set(p.language, p);

  // 关闭的笔记其代码块 DOM 会断开，注册一次性钩子清理登记，避免内存泄漏
  if (!pruneRegistered && deps.app?.workspace) {
    deps.app.workspace.on('layout-change', () => {
      for (const [el] of activeBlocks) {
        if (!el.isConnected) activeBlocks.delete(el);
      }
    });
    pruneRegistered = true;
  }

  // 包裹 render：每次渲染都登记当前块，供切语言时整体重渲染
  return base.map((p) => ({
    language: p.language,
    render: (source, el, ctx) => {
      registerActiveBlock(el, source, ctx, p.language);
      p.render(source, el, ctx);
    },
  }));
}

// ─── fin-beancount 源码渲染 ────────────────────────────────────

type ValGroupMode = 'flat' | 'account' | 'month';

interface ValRenderCtx {
  config: FinanceConfig | undefined;
  todayStr: string;
  allVals: Valuation[];
  balances: Map<string, AmountInCents>;
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a + 'T00:00:00');
  const db = new Date(b + 'T00:00:00');
  return Math.round((db.getTime() - da.getTime()) / 86400000);
}

function fmtYuan(cents: number): string {
  return '¥' + (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function accountDefOf(config: FinanceConfig | undefined, name: string): AccountDef | undefined {
  return config?.accounts.find((a) => a.name === name);
}

function valSeries(account: string, allVals: Valuation[], extra?: Valuation): Valuation[] {
  const arr = allVals.filter((v) => v.account === account);
  if (extra) arr.push(extra);
  return arr.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function buildSpark(account: string, allVals: Valuation[], extra?: Valuation): string {
  const pts = valSeries(account, allVals, extra).map((v) => v.amount);
  if (pts.length < 2) return '';
  const w = 64;
  const h = 20;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const d = pts
    .map((p, i) => {
      const x = (i / (pts.length - 1)) * w;
      const y = h - ((p - min) / span) * (h - 4) - 2;
      return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    })
    .join(' ');
  const dir = pts[pts.length - 1] >= pts[0] ? 'up' : 'down';
  return `<svg class="bc-val-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path class="spark-line ${dir}" d="${d}"/></svg>`;
}

function appendSectionLabel(parent: HTMLElement, label: string, isVal: boolean): void {
  const el = parent.createDiv({ cls: `bc-section-label ${isVal ? 'is-val' : ''}`.trim() });
  el.createSpan({ cls: 'dot' });
  el.createSpan({ text: label });
}

/** 计算所有「过期」账户（基于账本内最新一条估值的日期，相对今天） */
function computeStaleAccounts(ctx: ValRenderCtx): { account: string; gap: number; threshold: number }[] {
  const byAccount = new Map<string, Valuation[]>();
  for (const v of ctx.allVals) {
    if (!byAccount.has(v.account)) byAccount.set(v.account, []);
    byAccount.get(v.account)!.push(v);
  }
  const res: { account: string; gap: number; threshold: number }[] = [];
  for (const [account, arr] of byAccount) {
    const latest = arr.reduce((m, v) => (v.date > m.date ? v : m), arr[0]);
    const accDef = accountDefOf(ctx.config, account);
    if (!accDef) continue;
    const vType = accDef.valuation ?? 'book';
    if (vType === 'book') continue;
    const staleDays = accDef.staleDays ?? ctx.config?.defaultStaleDays ?? 0;
    if (staleDays <= 0) continue;
    const gap = daysBetween(latest.date, ctx.todayStr);
    if (gap > staleDays) res.push({ account, gap, threshold: staleDays });
  }
  return res;
}

/** 单张估值卡片（草案 / 已入账复用同一结构） */
function renderValCard(parent: HTMLElement, val: Valuation, ctx: ValRenderCtx, opts: { isPosted: boolean; onPost?: () => void }): void {
  const accDef = accountDefOf(ctx.config, val.account);
  const isKnown = !!accDef;
  const vType = accDef?.valuation ?? 'book';
  const staleDays = accDef ? (accDef.staleDays ?? ctx.config?.defaultStaleDays ?? 0) : 0;
  const icon = accDef?.icon ?? '❓';

  const postedOfAccount = ctx.allVals.filter((v) => v.account === val.account);
  const prev = postedOfAccount
    .filter((v) => v.date < val.date)
    .reduce<Valuation | undefined>((m, v) => (!m || v.date > m.date ? v : m), undefined);
  const latestPosted = postedOfAccount.reduce<Valuation | undefined>(
    (m, v) => (!m || v.date > m.date ? v : m),
    undefined,
  );
  const isLatest = val.blockRef ? !latestPosted || val.date >= latestPosted.date : val.date >= (latestPosted?.date ?? val.date);
  const staleRef = val.blockRef ? val.date : prev?.date ?? val.date;
  const gap = daysBetween(staleRef, ctx.todayStr);
  const isStale = isKnown && vType !== 'book' && staleDays > 0 && gap > staleDays;
  const sameDayExists = postedOfAccount.some((v) => v.date === val.date && v.blockRef !== val.blockRef);

  const kindLabel = !isKnown
    ? t('valuation.kind.unknown')
    : vType === 'market'
      ? t('valuation.kind.market')
      : vType === 'depreciation'
        ? t('valuation.kind.depreciation')
        : t('valuation.kind.book');
  const kindCls = !isKnown || vType === 'book' ? 'book' : vType === 'depreciation' ? 'dep' : '';

  // 变化（vs 上一条估值）
  let deltaHtml = `<span class="bc-val-delta flat">${t('valuation.noHistory')}</span>`;
  let vsHtml = '';
  if (prev) {
    const d = val.amount - prev.amount;
    const pct = prev.amount ? (d / prev.amount) * 100 : 0;
    const cls = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
    const arrow = d > 0 ? '▲' : d < 0 ? '▼' : '—';
    deltaHtml = `<span class="bc-val-delta ${cls}">${arrow} ${fmtCents(Math.abs(d))} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span>`;
    vsHtml = `<span class="bc-val-vs">${t('valuation.vs', { date: prev.date })}${val.date === prev.date ? t('valuation.sameDaySuffix') : ''}</span>`;
  }

  // 账面对照条（市值 vs 账面余额）
  const bookValue = ctx.balances.get(val.account) ?? 0;
  let bookHtml = '';
  if (bookValue !== 0) {
    const pnl = val.amount - bookValue;
    const maxV = Math.max(val.amount, Math.abs(bookValue)) || 1;
    const wMarket = ((val.amount / maxV) * 100).toFixed(1);
    const wBook = ((Math.abs(bookValue) / maxV) * 100).toFixed(1);
    bookHtml = `<div class="bc-val-book">
      <span>${t('valuation.bookLabel', { amount: fmtYuan(Math.abs(bookValue)) })}</span>
      <span class="bar"><i style="width:${wMarket}%"></i><u style="left:${wBook}%"></u></span>
      <span>${t('valuation.unrealized', { amount: fmtCents(pnl) })}</span>
    </div>`;
  }

  // 元信息标签
  const tags: string[] = [];
  tags.push(`<span class="bc-meta-tag">${t('valuation.meta.kind', { kind: kindLabel })}</span>`);
  if (accDef?.owner) tags.push(`<span class="bc-meta-tag">${t('valuation.meta.owner', { owner: accDef.owner })}</span>`);
  if (val.blockRef || prev) tags.push(`<span class="bc-meta-tag">${t('valuation.meta.gap', { n: String(gap) })}</span>`);
  if (isStale) tags.push(`<span class="bc-meta-tag warn">${t('valuation.meta.stale', { n: String(staleDays) })}</span>`);
  if (sameDayExists) tags.push(`<span class="bc-meta-tag warn">${t('valuation.meta.sameDay')}</span>`);
  if (opts.isPosted && val.blockRef) tags.push(`<span class="bc-meta-tag">${val.blockRef}</span>`);
  if (!isKnown) tags.push(`<span class="bc-meta-tag err">${t('valuation.meta.unknownAccount')}</span>`);
  if (isKnown && vType === 'book') {
    tags.push(`<span class="bc-meta-tag warn">${t('valuation.meta.bookWarn')}</span>`);
    tags.push(`<span class="bc-meta-tag">${t('valuation.meta.bookSuggest')}</span>`);
  }

  const card = parent.createDiv({ cls: `bc-val ${isStale ? 'is-stale' : ''}`.trim() });

  const headEl = card.createDiv({ cls: 'bc-val-head' });
  headEl.createDiv({ cls: 'bc-date-chip', text: val.date });
  const acc = headEl.createDiv({ cls: 'bc-val-acc' });
  acc.createSpan({ cls: 'ico', text: icon });
  acc.createSpan({ cls: 'nm', text: val.account });
  headEl.createDiv({ cls: `bc-val-kind ${kindCls}`.trim(), text: kindLabel });

  if (opts.isPosted) {
    const copy = headEl.createEl('button', {
      cls: 'bc-copy',
      attr: { title: t('valuation.copyTitle'), 'aria-label': t('valuation.copyTitle') },
    });
    setSvg(copy, ICON_COPY);
    const ref = val.blockRef ?? '';
    copy.addEventListener('click', async () => {
      const ok = await copyText(ref);
      if (ok) {
        setSvg(copy, ICON_CHECK);
        copy.addClass('copied');
        setTimeout(() => {
          setSvg(copy, ICON_COPY);
          copy.removeClass('copied');
        }, 1200);
      }
    });
  } else {
    headEl.createDiv({ cls: 'bc-flag pending', text: t('beancount.pending') });
    if (opts.onPost) {
      const postBtn = headEl.createEl('button', {
        cls: 'bc-post-one is-val',
        text: t('beancount.post'),
        attr: { title: t('beancount.post'), 'aria-label': t('beancount.post') },
      });
      postBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void opts.onPost!();
      });
    }
  }

  const body = card.createDiv({ cls: 'bc-val-body' });
  const amt = body.createDiv({ cls: 'bc-val-amt' });
  amt.textContent = fmtYuan(val.amount);
  if (val.currency) amt.createSpan({ cls: 'cur', text: val.currency });
  body.insertAdjacentHTML('beforeend', deltaHtml);
  if (vsHtml) body.insertAdjacentHTML('beforeend', vsHtml);
  const spark = buildSpark(val.account, ctx.allVals, opts.isPosted ? undefined : val);
  if (spark) body.insertAdjacentHTML('beforeend', spark);

  if (bookHtml) card.insertAdjacentHTML('beforeend', bookHtml);

  const meta = card.createDiv({ cls: 'bc-val-meta' });
  meta.innerHTML = tags.join('');
  if (val.comment) meta.createDiv({ cls: 'bc-val-note', text: `; ${val.comment}` });
}

/** 已入账态：估值按「每条 / 按账户 / 按月」聚合；默认按账户（资产天然维度） */
function renderValuationsPosted(
  box: HTMLElement,
  toolbar: HTMLElement,
  entriesEl: HTMLElement,
  valuations: Valuation[],
  ctx: ValRenderCtx,
  openValuationModal: (account?: string) => void,
): void {
  const stale = computeStaleAccounts(ctx);
  if (stale.length > 0) {
    const banner = box.createDiv({ cls: 'bc-banner warn' });
    banner.createSpan({ text: '⚠' });
    const list = stale
      .map((s) => t('valuation.banner.staleItem', { account: s.account, n: String(s.gap), threshold: String(s.threshold) }))
      .join('；');
    banner.createSpan({ text: t('valuation.banner.stale', { n: String(stale.length), list }) });
    banner.createDiv({ cls: 'spacer' });
    const upd = banner.createEl('button', { cls: 'fb-btn', text: t('valuation.banner.update') });
    upd.addEventListener('click', () => openValuationModal(stale[0].account));
  }

  const seg = toolbar.createDiv({ cls: 'bc-seg' });
  const modes: { mode: ValGroupMode; label: string }[] = [
    { mode: 'flat', label: t('valuation.group.flat') },
    { mode: 'account', label: t('valuation.group.account') },
    { mode: 'month', label: t('valuation.group.month') },
  ];
  let mode: ValGroupMode = 'account';
  const segButtons = new Map<ValGroupMode, HTMLElement>();
  for (const m of modes) {
    const b = seg.createEl('button', { cls: 'bc-seg-btn', text: m.label });
    b.dataset.mode = m.mode;
    segButtons.set(m.mode, b);
  }
  const spacer = toolbar.querySelector('.spacer');
  if (spacer) toolbar.insertBefore(seg, spacer);
  else toolbar.appendChild(seg);

  function sync(): void {
    segButtons.forEach((b, m) => b.toggleClass('is-active', m === mode));
  }
  function render(): void {
    entriesEl.empty();
    if (mode === 'flat') {
      for (const v of valuations) renderValCard(entriesEl, v, ctx, { isPosted: true });
      return;
    }
    if (mode === 'month') {
      const map = new Map<string, Valuation[]>();
      for (const v of valuations) {
        const k = v.date.slice(0, 7);
        if (!map.has(k)) map.set(k, []);
        map.get(k)!.push(v);
      }
      [...map.keys()].sort().reverse().forEach((k) => {
        const arr = map.get(k)!;
        const g = entriesEl.createDiv({ cls: 'bc-group' });
        const gh = g.createDiv({ cls: 'bc-group-head' });
        gh.createSpan({ cls: 'bc-group-label', text: t('valuation.group.month.label', { k }) });
        gh.createSpan({
          cls: 'bc-group-sum',
          text: t('valuation.group.month.sum', { n: String(arr.length), accounts: [...new Set(arr.map((a) => a.account))].join(' / ') }),
        });
        const caret = gh.createSpan({ cls: 'bc-group-caret' });
        setSvg(caret, ICON_CARET);
        const gb = g.createDiv({ cls: 'bc-group-body' });
        for (const v of arr) renderValCard(gb, v, ctx, { isPosted: true });
        gh.addEventListener('click', () => g.toggleClass('is-open', !g.hasClass('is-open')));
      });
      return;
    }
    // 按账户
    const accounts = [...new Set(valuations.map((v) => v.account))];
    for (const a of accounts) {
      const arr = valuations.filter((v) => v.account === a).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
      const latest = arr[arr.length - 1];
      const accDef = accountDefOf(ctx.config, a);
      const icon = accDef?.icon ?? '❓';
      const bookValue = ctx.balances.get(a) ?? 0;
      const pnl = latest.amount - bookValue;
      const vType = accDef?.valuation ?? 'book';
      const staleDays = accDef ? (accDef.staleDays ?? ctx.config?.defaultStaleDays ?? 0) : 0;
      const gap = daysBetween(latest.date, ctx.todayStr);
      const isStale = !!accDef && vType !== 'book' && staleDays > 0 && gap > staleDays;
      const first = arr[0].amount;
      const total = latest.amount - first;
      const totalPct = first ? (total / first) * 100 : 0;
      const cls = total > 0 ? 'up' : total < 0 ? 'down' : 'flat';
      const g = entriesEl.createDiv({ cls: 'bc-group' });
      const gh = g.createDiv({ cls: 'bc-group-head' });
      gh.createSpan({ cls: 'bc-group-label', text: `${icon} ${a}` });
      const sum = gh.createSpan({ cls: 'bc-group-sum' });
      sum.innerHTML =
        `<span class="gc">${t('valuation.group.latest')} <b>${fmtYuan(latest.amount)}</b></span>` +
        `<span class="bc-val-delta ${cls}" style="font-size:.92em">${total > 0 ? '▲' : '▼'} ${totalPct >= 0 ? '+' : ''}${totalPct.toFixed(1)}%</span>` +
        `<span class="gc">${t('valuation.unrealized', { amount: fmtCents(pnl) })}</span>` +
        `<span class="gc">· ${t('valuation.group.times', { n: String(arr.length) })} · ${t('valuation.group.daysAgo', { n: String(gap) })}</span>` +
        (isStale ? `<span class="bc-meta-tag warn">${t('valuation.group.stale')}</span>` : '');
      const caret = gh.createSpan({ cls: 'bc-group-caret' });
      setSvg(caret, ICON_CARET);
      const gb = g.createDiv({ cls: 'bc-group-body' });
      const tl = gb.createDiv({ cls: 'val-timeline' });
      arr.forEach((v, i) => {
        const isLatestRow = i === arr.length - 1;
        const pv = i > 0 ? arr[i - 1] : undefined;
        let dl = `<span class="v" style="color:var(--fb-text-faint)">${t('valuation.group.first')}</span>`;
        if (pv) {
          const d = v.amount - pv.amount;
          const pct = pv.amount ? (d / pv.amount) * 100 : 0;
          const c = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
          dl = `<span class="bc-val-delta ${c}" style="font-size:.86em">${d > 0 ? '▲' : d < 0 ? '▼' : '—'} ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</span>`;
        }
        const row = tl.createDiv({ cls: `val-tl-row ${isLatestRow ? 'is-latest' : ''}`.trim() });
        row.createSpan({ cls: 'dot' });
        row.createSpan({ cls: 'd', text: v.date });
        row.createSpan({ cls: 'v', text: fmtYuan(v.amount) });
        row.insertAdjacentHTML('beforeend', dl);
        row.createSpan({ cls: 'g' });
        if (v.comment) row.createSpan({ cls: 'cmt', text: v.comment });
        if (v.blockRef) row.createSpan({ cls: 'ref', text: v.blockRef });
      });
      gh.addEventListener('click', () => g.toggleClass('is-open', !g.hasClass('is-open')));
    }
  }
  for (const [m, b] of segButtons) b.addEventListener('click', () => { mode = m; sync(); render(); });
  sync();
  render();
}

function renderBeancountSource(
  source: string,
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext,
  app: App,
  ledgerPath: string,
  archiveLedgers: string[],
  indexer: Indexer,
  openRolloverModal: () => void,
  getBlockDefinitions: () => BlockDefinitionWithParams[],
  getFinanceConfig: () => FinanceConfig | undefined,
  openValuationModal: (account?: string) => void,
): void {
  const npLedger = normalizePath(ledgerPath);
  const npArchives = (archiveLedgers ?? []).map(normalizePath);
  const thisPath = normalizePath(ctx.sourcePath);
  const isCurrent = thisPath === npLedger;

  const { transactions, valuations, errors } = parseFinBeancount(source);
  const isPosted = /\^[tv]-/.test(source);
  const onlyVal = valuations.length > 0 && transactions.length === 0;
  const mixed = valuations.length > 0 && transactions.length > 0;

  const config = getFinanceConfig();
  const todayStr = localDateString(new Date());
  const allVals = indexer.getValuations();
  const balances = new Map(
    calculateBalances(indexer.getPostedTransactions()).map((b) => [b.account, b.balance] as [string, number]),
  );
  const valCtx: ValRenderCtx = { config, todayStr, allVals, balances };

  const box = el.createDiv({ cls: 'finance-block fin-beancount' });

  // ── 头部（图标 + 标题 + 状态 pill） ──
  const head = box.createDiv({ cls: 'fb-head' });
  setSvg(head.createDiv({ cls: onlyVal ? 'fb-icon is-val' : 'fb-icon' }), onlyVal ? BLOCK_ICONS.valuation : BLOCK_ICONS.beancount);
  head.createDiv({ cls: 'fb-title', text: onlyVal ? t('valuation.title') : t('beancount.title') });

  if (isPosted && isCurrent) {
    head.createDiv({ cls: 'fb-pill is-accent', text: t('beancount.currentPill') });
  } else if (!isPosted) {
    head.createDiv({ cls: 'fb-pill is-amber', text: t('beancount.draftPill') });
  }
  if (mixed) head.createDiv({ cls: 'fb-pill is-teal', text: t('valuation.containsPill', { n: String(valuations.length) }) });

  // ── 校验错误优先 ──
  if (errors.length > 0) {
    const warn = box.createDiv({ cls: isPosted ? 'bc-error bc-posted-error' : 'bc-error' });
    for (const err of errors) {
      warn.createDiv({ text: `⚠ ${err.message}`, cls: 'bc-error-line' });
    }
    if (isPosted) {
      warn.createDiv({ text: t('beancount.postedEditWarning'), cls: 'bc-warning' });
    }
    return;
  }

  if (transactions.length === 0 && valuations.length === 0) {
    if (isPosted) {
      box.createDiv({ cls: 'bc-empty', text: t('log.empty') });
      return;
    }
    // 草稿态空块不 return：继续渲染工具栏（含「添加记录」按钮），让用户可以直接开始记账
  }

  // ── 顶部操作栏 ──
  const toolbar = box.createDiv({ cls: 'bc-toolbar' });
  const entries = splitEntries(source);
  const draftEntryIdx = entries
    .map((e, i) => (/^\^[tv]-\d+/m.test(e.text) ? -1 : i))
    .filter((i) => i >= 0);

  if (!isPosted) {
    const addBtn = toolbar.createEl('button', { cls: 'fb-btn', text: t('beancount.addRecord') });
    addBtn.addEventListener('click', () => openAppendDraftModal(app, ctx, source, getBlockDefinitions, getFinanceConfig, indexer));

    const total = transactions.length + valuations.length;
    toolbar.createDiv({ cls: 'bc-count', text: t('valuation.draftCount', { n: String(total) }) });
    toolbar.createDiv({ cls: 'spacer' });

    if (draftEntryIdx.length > 1) {
      const batchBtn = toolbar.createEl('button', {
        text: t('valuation.batchPost', { n: String(draftEntryIdx.length) }),
        cls: 'fb-btn is-val',
      });
      batchBtn.addEventListener('click', async () => {
        await handleBatchPostEntry(app, ctx, source, ledgerPath, indexer, draftEntryIdx);
      });
    }
  } else {
    if (onlyVal) {
      toolbar.createDiv({
        cls: 'bc-count',
        text: t('valuation.count', { n: String(valuations.length), a: String(new Set(valuations.map((v) => v.account)).size) }),
      });
    } else {
      toolbar.createDiv({ cls: 'bc-count', text: t('beancount.count', { n: String(transactions.length) }) });
    }
    toolbar.createDiv({ cls: 'spacer' });
    if (isCurrent && transactions.length > 0) {
      const rolloverBtn = toolbar.createEl('button', {
        text: t('beancount.rollover'),
        cls: 'fb-btn is-cta',
      });
      rolloverBtn.addEventListener('click', () => openRolloverModal());
    }
  }

  // ── 正文 ──
  const entriesEl = box.createDiv({ cls: 'bc-entries' });

  if (!isPosted) {
    let ti = 0;
    let vi = 0;
    if (mixed) appendSectionLabel(entriesEl, t('valuation.sectionTxn'), false);
    for (const e of entries) {
      if (e.kind === 'txn') {
        const txn = transactions[ti++];
        renderTxnCard(entriesEl, txn, false, config, () => handlePostEntry(app, ctx, source, ledgerPath, indexer, entries.indexOf(e)), e.text);
      }
    }
    if (mixed) appendSectionLabel(entriesEl, t('valuation.sectionVal'), true);
    for (const e of entries) {
      if (e.kind === 'valuation') {
        const val = valuations[vi++];
        renderValCard(entriesEl, val, valCtx, {
          isPosted: false,
          onPost: () => handlePostEntry(app, ctx, source, ledgerPath, indexer, entries.indexOf(e)),
        });
      }
    }
  } else if (mixed) {
    appendSectionLabel(entriesEl, t('valuation.sectionTxn'), false);
    renderPostedWithGrouping(box, toolbar, entriesEl, transactions, config);
    appendSectionLabel(entriesEl, t('valuation.sectionVal'), true);
    for (const v of valuations) renderValCard(entriesEl, v, valCtx, { isPosted: true });
  } else if (onlyVal) {
    renderValuationsPosted(box, toolbar, entriesEl, valuations, valCtx, openValuationModal);
  } else {
    renderPostedWithGrouping(box, toolbar, entriesEl, transactions, config);
  }

  // ── 脚注：零和 + 估值 + 软告警汇总 ──
  // 告警汇总在已入账态也要出现——分组折叠时卡片上的标签看不见，靠这条兜住感知。
  const warnCount = config
    ? transactions.filter((tx) => auditTransaction(tx, config.accounts, config.transactionTypes).length > 0).length
    : 0;
  if (!isPosted || warnCount > 0) {
    const foot = box.createDiv({ cls: 'bc-foot' });
    if (!isPosted && transactions.length > 0) {
      foot.createDiv({ cls: 'bc-check', text: `✓ ${t('beancount.zeroSum')} · ${transactions.length}` });
    }
    if (!isPosted && valuations.length > 0) {
      foot.createDiv({ cls: 'bc-check is-val', text: `✓ ${t('valuation.zeroSumNote', { n: String(valuations.length) })}` });
    }
    if (warnCount > 0) {
      foot.createDiv({ cls: 'bc-check is-warn', text: `⚠ ${t('beancount.warn.foot', { n: String(warnCount) })}` });
    }
  }

  // ── 已入账态：账本流转链（仅当存在承接/转结关系时） ──
  if (isPosted) {
    renderLedgerChain(box, thisPath, npLedger, npArchives);
  }
}

/** 渲染单笔交易卡片（草案态/已入账态复用同一结构） */
function renderTxnCard(parent: HTMLElement, txn: Transaction, isPosted: boolean, config?: FinanceConfig, onPost?: () => void, entryText?: string): void {
  const card = parent.createDiv({ cls: `bc-txn ${isPosted ? '' : 'is-draft'}`.trim() });

  const txnHead = card.createDiv({ cls: 'bc-txn-head' });
  txnHead.createDiv({ cls: 'bc-date-chip', text: txn.date });
  txnHead.createDiv({ cls: 'bc-narr', text: txn.narration ?? '' });

  if (isPosted) {
    const copy = txnHead.createEl('button', {
      cls: 'bc-copy',
      attr: { title: t('beancount.copyTitle'), 'aria-label': t('beancount.copyTitle') },
    });
    setSvg(copy, ICON_COPY);
    // 仅图标，无文字
    copy.addEventListener('click', async () => {
      // 复制块引用（^t-xxxx），供 finance-log 的 id: 参数精准查询单笔账。
      const text = txn.id ?? '';
      if (!text) return;
      const ok = await copyText(text);
      if (ok) {
        setSvg(copy, ICON_CHECK);
        // 仅图标变化，无文字
        copy.addClass('copied');
        setTimeout(() => {
          setSvg(copy, ICON_COPY);
          // 清空文本节点、保留 SVG
          copy.findAll('span').forEach((s) => s.remove());
          // 仅图标，无文字
          copy.removeClass('copied');
        }, 1200);
      }
    });
  } else {
    // 草稿态：只有入账按钮（复制按钮仅在已入账态出现）
    if (onPost) {
      const postBtn = txnHead.createEl('button', {
        cls: 'bc-post-one',
        text: t('beancount.post'),
        attr: { title: t('beancount.post'), 'aria-label': t('beancount.post') },
      });
      postBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void onPost();
      });
    }
  }

  // 分录行：账户（紫·等宽） … 方向标签（流入/流出/来源/去向）… 金额（借贷红绿·tabular）
  const postings = card.createDiv({ cls: 'bc-postings' });
  for (const leg of txn.legs) {
    const row = postings.createDiv({ cls: 'bc-posting' });
    row.createDiv({ cls: 'acc', text: leg.account });
    const d = dirOfPost(leg, config);
    row.createSpan({ cls: `pdir pdir-${d.cls}`, text: d.label });
    const amt = row.createDiv({ cls: `amt ${leg.amount < 0 ? 'neg' : 'pos'}` });
    const yuan = Math.abs(leg.amount) / 100;
    amt.textContent = `¥${yuan.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  // 元数据标签：交易类型用中性 pill 展示（受管词表，仅作查询/筛选标签，不再判定收支）
  const meta = card.createDiv({ cls: 'bc-meta-line' });
  if (txn.txnType) meta.createEl('span', { cls: 'type-pill', text: txn.txnType });
  if (txn.owner) meta.createEl('span', { cls: 'bc-meta-tag', text: `owner: ${txn.owner}` });
  if (txn.fields) {
    for (const [k, v] of Object.entries(txn.fields)) {
      meta.createEl('span', { cls: 'bc-meta-tag', text: `${k}: ${v}` });
    }
  }

  // 软告警（报告 #1）：只挂标签、不拦截入账，鼠标悬停给出完整解释
  for (const w of auditTransaction(txn, config?.accounts, config?.transactionTypes)) {
    meta.createEl('span', {
      cls: 'bc-meta-tag warn',
      text: warnLabel(w),
      attr: { title: warnTip(w), 'aria-label': warnTip(w) },
    });
  }

  // 草稿态：在 meta 行尾部显示"待入账"标记
  if (!isPosted) {
    meta.createEl('span', { cls: 'bc-flag pending', text: t('beancount.pending') });
  }
}

/** 软告警短标签（挂在交易卡片 meta 行） */
function warnLabel(w: TxnWarning): string {
  return t(`beancount.warn.${w.code === 'unclassifiedAccount' ? 'unclassified' : w.code}`);
}

/** 软告警完整解释（tooltip） */
function warnTip(w: TxnWarning): string {
  if (w.code === 'signFlipped') {
    return t('beancount.warn.signFlippedTip', { accounts: w.accounts.join('、') });
  }
  if (w.code === 'unclassifiedAccount') {
    return t('beancount.warn.unclassifiedTip', { accounts: w.accounts.join('、') });
  }
  const direction = t(w.tagDirection === 'income' ? 'beancount.warn.dirIncome' : 'beancount.warn.dirExpense');
  return t('beancount.warn.tagMismatchTip', { tag: w.tag ?? '', direction });
}

type GroupMode = 'flat' | 'day' | 'week' | 'month' | 'custom';

/**
 * 已入账态：按时间聚合分组展示。
 * 支持 每笔 / 按天 / 按周 / 按月 / 自定义（起始日 + 每 N 天一组）。
 * 分组默认折叠，组头显示该时段收支净额与笔数；顶部不再重复整体合计。
 */
function renderPostedWithGrouping(
  box: HTMLElement,
  toolbar: HTMLElement,
  entries: HTMLElement,
  transactions: Transaction[],
  config?: FinanceConfig,
): void {
  const modes: { mode: GroupMode; label: string }[] = [
    { mode: 'flat', label: t('beancount.group.flat') },
    { mode: 'day', label: t('beancount.group.day') },
    { mode: 'week', label: t('beancount.group.week') },
    { mode: 'month', label: t('beancount.group.month') },
    { mode: 'custom', label: t('beancount.group.custom') },
  ];

  const spacer = toolbar.querySelector('.spacer');
  const seg = toolbar.createDiv({ cls: 'bc-seg' });
  if (spacer) toolbar.insertBefore(seg, spacer);
  else toolbar.appendChild(seg);

  const segButtons = new Map<GroupMode, HTMLElement>();
  for (const m of modes) {
    const btn = seg.createEl('button', { cls: 'bc-seg-btn', text: m.label });
    btn.dataset.mode = m.mode;
    segButtons.set(m.mode, btn);
  }

  const minDate = transactions.map((tx) => tx.date).sort()[0];
  let mode: GroupMode = 'flat';
  let customN = 10;
  let customStart = minDate;

  const customRange = box.createDiv({ cls: 'bc-customrange' });
  customRange.createSpan({ text: t('beancount.group.start') });
  const startInput = customRange.createEl('input', { type: 'date', cls: 'start-input' });
  startInput.value = minDate;
  customRange.createSpan({ text: ` ${t('beancount.group.every')} ` });
  const nInput = customRange.createEl('input', {
    type: 'number',
    cls: 'n-input',
    attr: { min: '1', max: '365', value: '10' },
  });
  customRange.createSpan({ text: ` ${t('beancount.group.unit')} ` });
  const chipValues = [7, 10, 15, 30, 90];
  const chipEls: HTMLElement[] = [];
  for (const n of chipValues) {
    chipEls.push(customRange.createEl('span', { cls: 'chip', text: String(n) }));
  }
  box.insertBefore(customRange, entries);

  const ctrlBar = box.createDiv({ cls: 'bc-toolbar' });
  const collapseBtn = ctrlBar.createEl('button', {
    cls: 'bc-collapseall',
    text: t('beancount.group.expandAll'),
  });
  box.insertBefore(ctrlBar, entries);

  const WK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function groupKey(txn: Transaction): string {
    if (mode === 'day') return txn.date;
    if (mode === 'week') return weekStart(parseYmd(txn.date)).toISOString().slice(0, 10);
    if (mode === 'month') return txn.date.slice(0, 7);
    if (mode === 'custom') {
      const s = parseYmd(customStart);
      const t = parseYmd(txn.date);
      const diff = Math.round((t.getTime() - s.getTime()) / 86400000);
      const i = Math.floor(diff / customN);
      return addDays(s, i * customN).toISOString().slice(0, 10);
    }
    return 'all';
  }

  function weekLabel(key: string): string {
    const d = parseYmd(key);
    const ws = weekStart(d);
    const we = addDays(ws, 6);
    const jan1 = new Date(d.getFullYear(), 0, 1);
    const w0 = weekStart(jan1);
    const wk = Math.floor((ws.getTime() - w0.getTime()) / (7 * 86400000)) + 1;
    return `${d.getFullYear()} 第${wk}周 (${fmtMD(ws)}~${fmtMD(we)})`;
  }

  function groupLabel(key: string): string {
    if (mode === 'day') {
      const d = parseYmd(key);
      return `${key} ${WK[d.getDay()]}`;
    }
    if (mode === 'week') return weekLabel(key);
    if (mode === 'month') return `${key.replace('-', '年')}月`;
    if (mode === 'custom') {
      const s = parseYmd(key);
      const e = addDays(s, customN - 1);
      return `${fmtMD(s)} ~ ${fmtMD(e)}`;
    }
    return '全部';
  }

  function syncButtons(): void {
    segButtons.forEach((btn, m) => btn.toggleClass('is-active', m === mode));
    customRange.toggleClass('is-on', mode === 'custom');
    ctrlBar.toggleClass('is-hidden', mode === 'flat');
  }

  function syncChips(): void {
    chipEls.forEach((chip, i) => chip.toggleClass('is-active', chipValues[i] === customN));
  }

  function renderGroups(): void {
    entries.empty();
    if (mode === 'flat') {
      for (const txn of transactions) renderTxnCard(entries, txn, true, config);
      return;
    }

    const map = new Map<string, Transaction[]>();
    for (const txn of transactions) {
      const k = groupKey(txn);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(txn);
    }
    const keys = [...map.keys()].sort();
    if (keys.length === 0) {
      entries.createDiv({ cls: 'bc-empty', text: t('log.empty') });
      return;
    }

    for (const k of keys) {
      const arr = map.get(k)!;
      const s = computeLedgerSummary(arr, config);
      const group = entries.createDiv({ cls: 'bc-group' });
      const head = group.createDiv({ cls: 'bc-group-head' });
      head.createSpan({ cls: 'bc-group-label', text: groupLabel(k) });
      const sum = head.createSpan({ cls: 'bc-group-sum' });
      sum.innerHTML =
        `<span class="gc">${t('beancount.summary.income')} <b class="pos">${fmtCents(s.income)}</b></span>` +
        `<span class="gc">${t('beancount.summary.expense')} <b class="neg">${fmtCents(-s.expense)}</b></span>` +
        `<span class="gc">${t('beancount.summary.net')} <b class="${s.net >= 0 ? 'pos' : 'neg'}">${fmtCents(s.net)}</b></span>` +
        `<span class="gc">· ${t('beancount.group.count', { n: String(arr.length) })}</span>`;
      const caret = head.createSpan({ cls: 'bc-group-caret' });
      setSvg(caret, ICON_CARET);
      const body = group.createDiv({ cls: 'bc-group-body' });
      for (const txn of arr) renderTxnCard(body, txn, true, config);
      head.addEventListener('click', () => group.toggleClass('is-open', !group.hasClass('is-open')));
    }
  }

  for (const [m, btn] of segButtons) {
    btn.addEventListener('click', () => {
      mode = m;
      syncButtons();
      renderGroups();
    });
  }

  startInput.addEventListener('change', () => {
    customStart = startInput.value || minDate;
    if (mode === 'custom') renderGroups();
  });

  nInput.addEventListener('input', () => {
    customN = Math.max(1, Math.min(365, parseInt(nInput.value, 10) || 1));
    syncChips();
    if (mode === 'custom') renderGroups();
  });

  for (let i = 0; i < chipValues.length; i++) {
    const n = chipValues[i];
    chipEls[i].addEventListener('click', () => {
      customN = n;
      nInput.value = String(n);
      syncChips();
      if (mode === 'custom') renderGroups();
    });
  }

  collapseBtn.addEventListener('click', () => {
    const groups = Array.from(entries.querySelectorAll('.bc-group'));
    const anyClosed = groups.some((g) => !(g as HTMLElement).hasClass('is-open'));
    groups.forEach((g) => (g as HTMLElement).toggleClass('is-open', anyClosed));
    collapseBtn.textContent = anyClosed
      ? t('beancount.group.collapseAll')
      : t('beancount.group.expandAll');
  });

  syncButtons();
  syncChips();
  renderGroups();
}

/**
 * 账本流转链：把扁平的「承接/转结」关系呈现为空间链路。
 * all = 归档账本（旧→新） + 当前账本；高亮当前卡片所属账本（thisPath）。
 * 当前账本且无任何承接时（状态1）不渲染链。
 */
function renderLedgerChain(
  box: HTMLElement,
  thisPath: string,
  ledgerPath: string,
  archives: string[],
): void {
  const all = [...archives, ledgerPath];
  const idx = all.indexOf(thisPath);
  if (idx === -1) return;

  const prev = idx > 0 ? all[idx - 1] : null;
  const next = idx < all.length - 1 ? all[idx + 1] : null;
  if (!prev && !next) return; // 状态1：无承接、无转结

  const chain = box.createDiv({ cls: 'bc-chain' });
  chain.createSpan({ cls: 'chain-cap', text: t('beancount.chainCap') });

  if (prev) {
    chain.createSpan({ cls: 'chain-node', text: ledgerDisplayName(prev) });
    setSvg(chain.createSpan({ cls: 'chain-arrow' }), ICON_ARROW);
  }
  chain.createSpan({ cls: 'chain-node is-this', text: ledgerDisplayName(thisPath) });
  if (next) {
    setSvg(chain.createSpan({ cls: 'chain-arrow' }), ICON_ARROW);
    chain.createSpan({ cls: 'chain-node', text: ledgerDisplayName(next) });
  }
}

/**
 * 处理入账操作（草案 → 账本）：入账区块内指定下标的单条分录（交易 ^t- 或估值 ^v-）。
 * entryIndex 来自 splitEntries(source) 的扁平下标，与 postTransactionsInBlock 的 indices 对齐。
 */
async function handlePostEntry(
  app: App,
  ctx: MarkdownPostProcessorContext,
  source: string,
  ledgerPath: string,
  indexer: Indexer,
  entryIndex: number,
): Promise<void> {
  const sourcePath = ctx.sourcePath;
  const sourceFile = app.vault.getAbstractFileByPath(sourcePath);

  if (!(sourceFile instanceof TFile)) {
    new Notice(t('beancount.postError.noFile'));
    return;
  }

  const content = await app.vault.read(sourceFile);
  const codeBlockPattern = /```fin-beancount\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let startPos = -1;
  let endPos = -1;

  while ((match = codeBlockPattern.exec(content)) !== null) {
    if (match[1].trim() === source.trim()) {
      startPos = match.index;
      endPos = match.index + match[0].length;
      break;
    }
  }

  if (startPos === -1) {
    new Notice(t('beancount.postError.notFound'));
    return;
  }

  const { results, ledgerPath: lp } = await postTransactionsInBlock(
    app,
    sourceFile,
    source,
    startPos,
    endPos,
    ledgerPath,
    [entryIndex],
  );

  const ok = results.filter((r) => r.success);
  if (ok.length > 0) {
    new Notice(t('beancount.postSuccess', { ledgerPath: lp || ledgerPath }));
    if (lp) await indexer.updateFile(lp);
    await indexer.updateFile(sourcePath);
  }
  const failed = results.find((r) => !r.success);
  if (failed) {
    new Notice(t('beancount.postError.generic', { error: failed.error || '' }));
  }
}

/**
 * 处理批量入账操作（一个代码块里多笔草案分录一键各自独立入账，交易与估值混合也支持）。
 * indices 来自 splitEntries(source) 的扁平下标数组。
 */
async function handleBatchPostEntry(
  app: App,
  ctx: MarkdownPostProcessorContext,
  source: string,
  ledgerPath: string,
  indexer: Indexer,
  indices: number[],
): Promise<void> {
  const sourcePath = ctx.sourcePath;
  const sourceFile = app.vault.getAbstractFileByPath(sourcePath);

  if (!(sourceFile instanceof TFile)) {
    new Notice(t('beancount.postError.noFile'));
    return;
  }

  const content = await app.vault.read(sourceFile);
  const codeBlockPattern = /```fin-beancount\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let startPos = -1;
  let endPos = -1;

  while ((match = codeBlockPattern.exec(content)) !== null) {
    if (match[1].trim() === source.trim()) {
      startPos = match.index;
      endPos = match.index + match[0].length;
      break;
    }
  }

  if (startPos === -1) {
    new Notice(t('beancount.postError.notFound'));
    return;
  }

  const { results, ledgerPath: lp } = await postTransactionsInBlock(
    app,
    sourceFile,
    source,
    startPos,
    endPos,
    ledgerPath,
    indices,
  );

  const success = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  if (success > 0) {
    new Notice(t('beancount.batchPostSuccess', {
      success: String(success),
      total: String(results.length),
    }));
    if (lp) await indexer.updateFile(lp);
    await indexer.updateFile(sourcePath);
  }
  if (failed > 0) {
    const firstError = results.find((r) => !r.success);
    new Notice(t('beancount.postError.generic', { error: firstError?.error || '' }));
  }
}

/**
 * 打开「加入草稿」弹窗：把用户填好的分录追加到当前 fin-beancount 代码块的草稿区。
 * 之所以不复用 openRecordModal：record 是写账本（带 ^t-），与本场景语义冲突。
 */
async function openAppendDraftModal(
  app: App,
  ctx: MarkdownPostProcessorContext,
  source: string,
  getBlockDefinitions: () => BlockDefinitionWithParams[],
  getFinanceConfig: () => FinanceConfig | undefined,
  indexer: Indexer,
): Promise<void> {
  const sourcePath = ctx.sourcePath;
  const sourceFile = app.vault.getAbstractFileByPath(sourcePath);
  if (!(sourceFile instanceof TFile)) {
    new Notice(t('beancount.addRecordFailed'));
    return;
  }

  // 在文件中定位当前 fin-beancount 代码块的位置（点击时再读一次文件，防止渲染后被外部修改）
  const content = await app.vault.read(sourceFile);
  const codeBlockPattern = /```fin-beancount\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let startPos = -1;
  let endPos = -1;
  while ((match = codeBlockPattern.exec(content)) !== null) {
    if (match[1].trim() === source.trim()) {
      startPos = match.index;
      endPos = match.index + match[0].length;
      break;
    }
  }

  if (startPos === -1) {
    new Notice(t('beancount.addRecordFailed'));
    return;
  }

  const defs = getBlockDefinitions();
  const beancount = defs.find((d) => d.language === 'fin-beancount');
  if (!beancount) {
    new Notice(t('modal.record.noDef'));
    return;
  }

  new AppendDraftToBlockModal(
    app,
    beancount,
    getFinanceConfig(),
    sourceFile,
    startPos,
    endPos,
    indexer,
  ).open();
}
