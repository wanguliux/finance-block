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
import { postTransaction, batchPostTransactions } from '../ledger/poster';
import { Indexer } from '../ledger/indexer';
import { t } from '../i18n';
import {
  addDays,
  computeLedgerSummary,
  fmtCents,
  fmtMD,
  ledgerDisplayName,
  parseYmd,
  weekStart,
} from '../util/ledgerView';
import { copyText } from '../util/clipboard';
import { BLOCK_ICONS, ICON_COPY, ICON_CHECK, ICON_ARROW, ICON_CARET, setSvg } from './icons';
import type { FinanceConfig, Transaction } from '../types';
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
        ),
    },

    // ── 视图层：finance-log 流水
    {
      language: 'finance-log',
      render: (source, el, ctx) => renderLog(source, el, ctx, deps.app, deps.indexer, deps.getLedgerPath()),
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
): void {
  const npLedger = normalizePath(ledgerPath);
  const npArchives = (archiveLedgers ?? []).map(normalizePath);
  const thisPath = normalizePath(ctx.sourcePath);
  const isCurrent = thisPath === npLedger;

  const { transactions, errors } = parseFinBeancount(source);
  const isPosted = source.includes('^t-');

  const box = el.createDiv({ cls: 'finance-block fin-beancount' });

  // ── 头部（图标 + 标题 + 状态 pill） ──
  const head = box.createDiv({ cls: 'fb-head' });
  setSvg(head.createDiv({ cls: 'fb-icon' }), BLOCK_ICONS.beancount);
  head.createDiv({ cls: 'fb-title', text: t('beancount.title') });

  if (isPosted && isCurrent) {
    head.createDiv({ cls: 'fb-pill is-accent', text: t('beancount.currentPill') });
  } else if (!isPosted) {
    head.createDiv({ cls: 'fb-pill is-amber', text: t('beancount.draftPill') });
  }

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

  if (transactions.length === 0) {
    box.createDiv({ cls: 'bc-empty', text: t('log.empty') });
    return;
  }

  // ── 顶部操作栏 ──
  const toolbar = box.createDiv({ cls: 'bc-toolbar' });
  if (!isPosted) {
    // 草案态：添加记录 + 入账 + 批量入账
    // 关键修正：「添加记录」必须把新分录追加到当前代码块草稿区，而不是写账本；
    // 写账本会导致 finance-log 把原草稿和已入账两笔都索引出来（已确认 bug）。
    const addBtn = toolbar.createEl('button', { cls: 'fb-btn', text: t('beancount.addRecord') });
    addBtn.addEventListener('click', () => openAppendDraftModal(app, ctx, source, getBlockDefinitions, getFinanceConfig, indexer));

    toolbar.createDiv({ cls: 'bc-count', text: t('beancount.draftCount', { n: String(transactions.length) }) });
    toolbar.createDiv({ cls: 'spacer' });

    const postBtn = toolbar.createEl('button', {
      text: t('beancount.post'),
      cls: 'fb-btn is-cta',
    });
    postBtn.addEventListener('click', async () => {
      await handlePostTransaction(app, ctx, source, el, ledgerPath, indexer);
    });

    if (transactions.length > 1) {
      const batchBtn = toolbar.createEl('button', {
        text: t('beancount.batchPost', { n: String(transactions.length) }),
        cls: 'fb-btn is-cta',
      });
      batchBtn.addEventListener('click', async () => {
        await handleBatchPostTransaction(app, ctx, source, el, ledgerPath, transactions.length, indexer);
      });
    }
  } else {
    // 已入账态：笔数 + （当前账本）汇总结转
    toolbar.createDiv({ cls: 'bc-count', text: t('beancount.count', { n: String(transactions.length) }) });
    toolbar.createDiv({ cls: 'spacer' });
    if (isCurrent) {
      const rolloverBtn = toolbar.createEl('button', {
        text: t('beancount.rollover'),
        cls: 'fb-btn is-cta',
      });
      rolloverBtn.addEventListener('click', () => openRolloverModal());
    }
  }

  // ── 交易卡片列表 ──
  const entries = box.createDiv({ cls: 'bc-entries' });
  if (isPosted) {
    renderPostedWithGrouping(box, toolbar, entries, transactions);
  } else {
    for (const txn of transactions) {
      renderTxnCard(entries, txn, false);
    }
  }

  // ── 草案态：零和校验脚注 ──
  if (!isPosted) {
    const foot = box.createDiv({ cls: 'bc-foot' });
    foot.createDiv({ cls: 'bc-check', text: `✓ ${t('beancount.zeroSum')} · ${transactions.length}` });
  }

  // ── 已入账态：账本流转链（仅当存在承接/转结关系时） ──
  if (isPosted) {
    renderLedgerChain(box, thisPath, npLedger, npArchives);
  }
}

/** 渲染单笔交易卡片（草案态/已入账态复用同一结构） */
function renderTxnCard(parent: HTMLElement, txn: Transaction, isPosted: boolean): void {
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
    copy.addEventListener('click', async () => {
      // 复制块引用（^t-xxxx），供 finance-log 的 id: 参数精准查询单笔账。
      // 不复制完整交易信息——用户只想要块引用这一行。
      const text = txn.id ?? '';
      if (!text) return;
      const ok = await copyText(text);
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
    txnHead.createDiv({ cls: 'bc-flag pending', text: t('beancount.pending') });
  }

  // 分录行：账户（紫·等宽） … 金额（借贷红绿·tabular）
  const postings = card.createDiv({ cls: 'bc-postings' });
  for (const leg of txn.legs) {
    const row = postings.createDiv({ cls: 'bc-posting' });
    row.createDiv({ cls: 'acc', text: leg.account });
    const amt = row.createDiv({ cls: `amt ${leg.amount < 0 ? 'neg' : 'pos'}` });
    const yuan = Math.abs(leg.amount) / 100;
    amt.textContent = `${leg.amount < 0 ? '-' : '+'}${yuan.toFixed(2)}`;
  }

  // 元数据标签
  const meta = card.createDiv({ cls: 'bc-meta-line' });
  if (txn.txnType) meta.createEl('span', { cls: 'bc-meta-tag', text: `type: ${txn.txnType}` });
  if (txn.owner) meta.createEl('span', { cls: 'bc-meta-tag', text: `owner: ${txn.owner}` });
  if (txn.fields) {
    for (const [k, v] of Object.entries(txn.fields)) {
      meta.createEl('span', { cls: 'bc-meta-tag', text: `${k}: ${v}` });
    }
  }
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
      for (const txn of transactions) renderTxnCard(entries, txn, true);
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
      const s = computeLedgerSummary(arr);
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
      for (const txn of arr) renderTxnCard(body, txn, true);
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
 * 处理入账操作（草案 → 账本）
 */
async function handlePostTransaction(
  app: App,
  ctx: MarkdownPostProcessorContext,
  source: string,
  _el: HTMLElement,
  ledgerPath: string,
  indexer: Indexer,
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

  const result = await postTransaction(app, sourceFile, source, startPos, endPos, ledgerPath);

  if (result.success) {
    new Notice(t('beancount.postSuccess', { ledgerPath: result.ledgerPath || '' }));
    if (result.ledgerPath) await indexer.updateFile(result.ledgerPath);
    await indexer.updateFile(sourcePath);
  } else {
    new Notice(t('beancount.postError.generic', { error: result.error || '' }));
  }
}

/**
 * 处理批量入账操作（一个代码块里多笔交易一键各自独立入账）
 */
async function handleBatchPostTransaction(
  app: App,
  ctx: MarkdownPostProcessorContext,
  source: string,
  _el: HTMLElement,
  ledgerPath: string,
  _txnCount: number,
  indexer: Indexer,
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

  const result = await batchPostTransactions(app, sourceFile, [{
    source,
    startPos,
    endPos,
  }], ledgerPath);

  if (result.success > 0) {
    new Notice(t('beancount.batchPostSuccess', {
      success: String(result.success),
      total: String(result.total),
    }));
    if (result.results[0]?.ledgerPath) await indexer.updateFile(result.results[0].ledgerPath);
    await indexer.updateFile(sourcePath);
  } else {
    const firstError = result.results.find((r) => !r.success);
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
