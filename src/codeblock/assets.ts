/**
 * finance-assets 渲染块：资产市值总览仪表板
 *
 * 展示内容：
 * 1. 头部横幅：净资产（市值口径，大数字）+ 总资产 / 总负债 / 未实现损益 三项指标卡
 * 2. 资产配置条：按分组堆叠的百分比色条
 * 3. 资产卡片列表：每张卡片显示 icon + 账户名 + 归属徽章 + 计价方式徽章 +
 *    市值 + 账面/未实现损益 + 最近估值日期（过期标黄）+ 更新估值按钮
 * 4. 负债区域：同布局展示负债类账户
 * 5. 脚注：估值来源说明
 *
 * 代码块语法：
 *   ```finance-assets
 *   owner: 自己          ; 可选，为空则合并全部归属
 *   group: class         ; 可选，class（默认，按资产/负债分类）或 prefix（按账户名前缀分组）
 *   ```
 */

import type { App, MarkdownPostProcessorContext } from 'obsidian';
import type { FinanceConfig, AccountDef, AmountInCents } from '../types';
import { computeNetWorth, type AccountValue, type NetWorthResult } from '../engine/networth';
import type { Indexer } from '../ledger/indexer';
import { calculateBalances } from '../ledger/closing';
import {
  buildFxRates,
  buildSymbolMap,
  currencySymbol,
} from '../engine/fx';
import { t } from '../i18n';
import { BLOCK_ICONS, setSvg } from './icons';

// ─── 参数解析 ───────────────────────────────────────────────────

interface AssetParams {
  owner?: string;    // 归属筛选，空 = 合并全部
  group: 'class' | 'prefix'; // 分组方式
}

function parseParams(source: string): AssetParams {
  const params: AssetParams = { group: 'class' };

  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) continue;
    const m = /^(\w+):\s*(.+?)(?:\s*[;#].*)?$/.exec(trimmed);
    if (!m) continue;
    const [, key, rawVal] = m;
    const val = rawVal.trim();
    switch (key) {
      case 'owner':
        params.owner = val || undefined;
        break;
      case 'group':
        if (val === 'class' || val === 'prefix') params.group = val;
        break;
    }
  }
  return params;
}

// ─── 格式化工具 ──────────────────────────────────────────────────

const CENTS_TO_WAN = 1 / 1_000_000;

/**
 * 以 万/亿 格式展示金额（参考 ficalc 的 fmtMoney，但符号与单位分离）。
 * 正数不加符号，负数前缀 '-'。
 */
function fmtAssetMoney(cents: number, symbol: string): string {
  const wan = Math.abs(cents) * CENTS_TO_WAN;
  const sign = cents < 0 ? '-' : '';
  if (wan >= 10000) return `${sign}${symbol}${(wan / 10000).toFixed(2)}亿`;
  if (wan >= 100)   return `${sign}${symbol}${wan.toFixed(0)}万`;
  if (wan >= 1)     return `${sign}${symbol}${wan.toFixed(1)}万`;
  // 不足 1 万时退化为元
  const yuan = Math.abs(cents) / 100;
  if (yuan >= 1) return `${sign}${symbol}${yuan.toFixed(0)}`;
  return `${sign}${symbol}0`;
}

/** 百分比字符串，保留一位小数 */
function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

// ─── 分组逻辑 ────────────────────────────────────────────────────

type GroupKey = string;

interface GroupBucket {
  key: GroupKey;
  label: string;
  accounts: AccountValue[];
  /** 组内市值绝对值合计（用于百分比条） */
  absTotal: AmountInCents;
}

/**
 * 按指定方式将账户分组。
 * class 模式：由于调用方已按 class 预筛选，所有账户归入同一组。
 * prefix 模式：取账户名第一段（`:` 前）作为组键。
 */
function groupAccounts(
  accounts: AccountValue[],
  mode: 'class' | 'prefix',
  sectionLabel?: string,
): GroupBucket[] {
  const buckets = new Map<GroupKey, GroupBucket>();

  for (const av of accounts) {
    let key: GroupKey;
    let label: string;

    if (mode === 'class') {
      // 调用方已按 asset/liability 分好，统一归为一组
      key = sectionLabel ?? 'all';
      label = sectionLabel ?? '';
    } else {
      // prefix：取 `:` 前第一段
      const seg = av.account.split(/[:：／/]/)[0].trim();
      key = seg || av.account;
      label = key;
    }

    if (!buckets.has(key)) {
      buckets.set(key, { key, label, accounts: [], absTotal: 0 });
    }
    const bucket = buckets.get(key)!;
    bucket.accounts.push(av);
    bucket.absTotal += Math.abs(av.marketValue);
  }

  return Array.from(buckets.values());
}

// ─── 分配色板 ────────────────────────────────────────────────────

const BAR_PALETTE = [
  '#6366f1', // indigo
  '#0ea5e9', // sky
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // violet
  '#14b8a6', // teal
  '#f97316', // orange
  '#ec4899', // pink
  '#84cc16', // lime
];

function groupColor(index: number): string {
  return BAR_PALETTE[index % BAR_PALETTE.length];
}

// ─── 估值来源徽章文本 ────────────────────────────────────────────

function valuationSourceLabel(source: AccountValue['source']): string {
  switch (source) {
    case 'valuation':    return t('assets.valuationSource.valuation');
    case 'depreciation': return t('assets.valuationSource.depreciation');
    case 'book':
    default:             return t('assets.valuationSource.book');
  }
}

// ─── DOM 构建工具 ────────────────────────────────────────────────

/** 创建徽章 span */
function badge(parent: HTMLElement, text: string, cls?: string): HTMLSpanElement {
  const span = parent.createSpan({ cls: `fb-badge${cls ? ' ' + cls : ''}`, text });
  return span;
}

// ─── 主渲染函数 ──────────────────────────────────────────────────

export function renderAssets(
  source: string,
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext,
  config: FinanceConfig | undefined,
  indexer: Indexer,
  ledgerPath: string,
  app: App,
  openValuationModal: (account: string) => void,
): void {
  const params = parseParams(source);
  el.empty();

  const root = el.createDiv({ cls: 'finance-block as-assets' });
  const baseCurrency = config?.baseCurrency ?? 'CNY';
  const symbol = currencySymbol(baseCurrency, buildSymbolMap(config?.currencies));

  // ── 头部：图标 + 标题 ──
  const head = root.createDiv({ cls: 'fb-head' });
  setSvg(head.createDiv({ cls: 'fb-icon' }), BLOCK_ICONS.beancount);
  head.createDiv({ cls: 'fb-title', text: t('assets.title') });
  if (params.owner) {
    head.createDiv({ cls: 'fb-pill is-accent', text: params.owner });
  }

  // ── 数据准备 ──
  const entries = indexer.getPostedTransactions();
  const accountBalances = calculateBalances(entries);
  const balancesMap = new Map<string, AmountInCents>();
  for (const ab of accountBalances) {
    balancesMap.set(ab.account, ab.balance);
  }

  const valuations = indexer.getValuations();
  const fxRates = buildFxRates(config?.currencies, baseCurrency);
  const accountDefs: AccountDef[] = config?.accounts ?? [];
  const staleDaysDefault = config?.defaultStaleDays ?? 30;

  // 缓存账户定义，供 renderAccountCard 内查找 icon 等元数据
  setDefCache(accountDefs);

  const result: NetWorthResult = computeNetWorth(
    accountDefs,
    balancesMap,
    valuations,
    staleDaysDefault,
    new Date(),
    fxRates,
    baseCurrency,
    params.owner,
  );

  // ── 空态检查 ──
  if (result.accounts.length === 0) {
    root.createDiv({ cls: 'as-empty', text: t('assets.empty') });
    return;
  }

  // ── 分类账户：只保留 asset / liability 类（排除 income / expense / equity） ──
  // 用 AccountDef.class 判定（配置的五大类归属），而非余额正负号——
  // 余额正负号不可靠：现金账户支出后余额为负、expense 类账户余额为正等场景都会误判。
  const classMap = new Map<string, string>();
  for (const def of accountDefs) classMap.set(def.name, def.class);

  const assetAccounts: AccountValue[] = [];
  const liabilityAccounts: AccountValue[] = [];
  for (const av of result.accounts) {
    const cls = classMap.get(av.account);
    if (cls === 'asset') assetAccounts.push(av);
    else if (cls === 'liability') liabilityAccounts.push(av);
    // income / expense / equity / 未配置类 → 不出现在资产总览
  }

  // ── 从过滤后的账户重新汇总（排除 income/expense 的干扰）──
  let totalAssets = 0, totalLiabilities = 0, totalPnL = 0;
  for (const av of assetAccounts) {
    totalAssets += av.marketValue;
    totalPnL += av.unrealizedPnL;
  }
  for (const av of liabilityAccounts) {
    totalLiabilities += Math.abs(av.marketValue);
  }
  const netWorth = totalAssets - totalLiabilities;

  // ── 横幅：净资产（市值口径）──
  const banner = root.createDiv({ cls: 'fb-banner' });
  banner.createDiv({ cls: 'b-label', text: t('assets.netWorth') });
  banner.createDiv({
    cls: `b-value ${netWorth >= 0 ? 'is-pos' : 'is-neg'}`,
    text: fmtAssetMoney(netWorth, symbol),
  });

  // ── 三指标网格 ──
  const grid = root.createDiv({ cls: 'fb-grid' });
  metricCard(grid, t('assets.totalAssets'),   fmtAssetMoney(totalAssets, symbol));
  metricCard(grid, t('assets.totalLiabilities'), fmtAssetMoney(totalLiabilities, symbol));
  metricCard(
    grid,
    t('assets.unrealizedPnL'),
    fmtAssetMoney(totalPnL, symbol),
    totalPnL >= 0 ? 'is-pos' : 'is-neg',
  );

  // ── 资产配置条（仅资产侧，且多于一个组时才显示——单组 100% 无意义）──
  if (assetAccounts.length > 0) {
    const assetGroups = groupAccounts(assetAccounts, params.group, t('assets.groupAssets'));
    if (assetGroups.length > 1) {
      renderAllocationBar(root, assetGroups);
    }
  }

  // ── 资产卡片列表 ──
  if (assetAccounts.length > 0) {
    const assetSection = root.createDiv({ cls: 'as-section' });
    assetSection.createDiv({ cls: 'as-section-title', text: t('assets.groupAssets') });
    const cards = assetSection.createDiv({ cls: 'as-cards' });
    const assetGroups = groupAccounts(assetAccounts, params.group, t('assets.groupAssets'));
    for (const group of assetGroups) {
      if (params.group === 'prefix' && assetGroups.length > 1) {
        cards.createDiv({ cls: 'as-group-label', text: group.label });
      }
      for (const av of group.accounts) {
        renderAccountCard(cards, av, symbol, openValuationModal);
      }
    }
  }

  // ── 负债卡片列表 ──
  if (liabilityAccounts.length > 0) {
    const liabSection = root.createDiv({ cls: 'as-section as-liabilities' });
    liabSection.createDiv({ cls: 'as-section-title', text: t('assets.groupLiabilities') });
    const cards = liabSection.createDiv({ cls: 'as-cards' });
    const liabGroups = groupAccounts(liabilityAccounts, params.group, t('assets.groupLiabilities'));
    for (const group of liabGroups) {
      if (params.group === 'prefix' && liabGroups.length > 1) {
        cards.createDiv({ cls: 'as-group-label', text: group.label });
      }
      for (const av of group.accounts) {
        renderAccountCard(cards, av, symbol, openValuationModal);
      }
    }
  }

  // ── 脚注 ──
  root.createDiv({ cls: 'as-footnote', text: t('assets.footNote') });
}

// ─── 指标卡片 ─────────────────────────────────────────────────────

function metricCard(
  parent: HTMLElement,
  label: string,
  value: string,
  valueCls?: string,
): void {
  const card = parent.createDiv({ cls: 'fb-metric' });
  card.createDiv({ cls: 'm-label', text: label });
  card.createDiv({ cls: `m-value${valueCls ? ' ' + valueCls : ''}`, text: value });
}

// ─── 配置条 ──────────────────────────────────────────────────────

function renderAllocationBar(
  parent: HTMLElement,
  groups: GroupBucket[],
): void {
  const total = groups.reduce((sum, g) => sum + g.absTotal, 0);
  if (total <= 0) return;

  const wrap = parent.createDiv({ cls: 'as-bar-wrap' });
  const bar = wrap.createDiv({ cls: 'as-bar' });

  const legend = wrap.createDiv({ cls: 'as-bar-legend' });

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const pct = g.absTotal / total;
    const color = groupColor(i);

    // 色条段
    const seg = bar.createDiv({ cls: 'as-bar-seg' });
    seg.style.width = `${(pct * 100).toFixed(2)}%`;
    seg.style.backgroundColor = color;
    seg.setAttribute('title', `${g.label}: ${fmtPct(pct)}`);

    // 图例
    const item = legend.createSpan({ cls: 'as-bar-item' });
    const dot = item.createSpan({ cls: 'as-bar-dot' });
    dot.style.backgroundColor = color;
    item.createSpan({ cls: 'as-bar-name', text: g.label });
    item.createSpan({ cls: 'as-bar-pct', text: fmtPct(pct) });
  }
}

// ─── 账户卡片 ─────────────────────────────────────────────────────

function renderAccountCard(
  parent: HTMLElement,
  av: AccountValue,
  symbol: string,
  openValuationModal: (account: string) => void,
): void {
  const card = parent.createDiv({ cls: 'as-card' });

  // ── 顶部行：[icon] [name] [badges...]          [¥value] ──
  const topRow = card.createDiv({ cls: 'as-card-top' });

  const topLeft = topRow.createDiv({ cls: 'as-card-tl' });
  const def = findAccountDef(av.account);
  const iconEl = topLeft.createSpan({ cls: 'as-icon' });
  iconEl.textContent = def?.icon ?? accountInitial(av.account);
  topLeft.createSpan({ cls: 'as-name', text: av.account });
  if (av.owner) badge(topLeft, av.owner);
  const vtypeLabel = valuationTypeLabel(av.valuationType);
  if (vtypeLabel) badge(topLeft, vtypeLabel, 'is-accent');
  if (av.isStale) badge(topLeft, t('assets.staleBadge'), 'is-stale');

  topRow.createSpan({
    cls: `as-value ${av.marketValue < 0 ? 'is-neg' : ''}`.trim(),
    text: fmtAssetMoney(av.marketValue, symbol),
  });

  // ── 底部行（仅非 book 账户）：[🔄]          [账面 ¥xx] [+¥xxx] ──
  if (av.valuationType !== 'book') {
    const bottomRow = card.createDiv({ cls: 'as-card-bottom' });

    const btn = bottomRow.createEl('button', {
      cls: 'as-icon-btn',
      attr: { title: t('assets.updateValuation'), 'aria-label': t('assets.updateValuation') },
    });
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
    btn.addEventListener('click', () => openValuationModal(av.account));

    const bottomRight = bottomRow.createDiv({ cls: 'as-card-br' });
    bottomRight.createSpan({
      cls: 'as-book-label',
      text: `${t('assets.bookValue')} ${fmtAssetMoney(av.bookValue, symbol)}`,
    });
    if (av.unrealizedPnL !== 0) {
      const pnlSign = av.unrealizedPnL >= 0 ? '+' : '';
      const pnlCls = av.unrealizedPnL >= 0 ? 'is-pos' : 'is-neg';
      bottomRight.createSpan({
        cls: `as-pnl ${pnlCls}`,
        text: `${pnlSign}${fmtAssetMoney(av.unrealizedPnL, symbol)}`,
      });
    }
  }
}

// ─── 辅助函数 ─────────────────────────────────────────────────────

/** 从全局配置中查找账户定义（用于取 icon 等元数据） */
let _cachedDefs: AccountDef[] | null = null;

function findAccountDef(account: string): AccountDef | undefined {
  if (!_cachedDefs) return undefined;
  return _cachedDefs.find((d) => d.name === account);
}

/**
 * 设置缓存的账户定义列表（由 renderAssets 在每次渲染前调用，
 * 使 findAccountDef 在 renderAccountCard 内无需重复传递 config）。
 */
function setDefCache(defs: AccountDef[]): void {
  _cachedDefs = defs;
}

/** 取账户名首段首字符作为 fallback icon */
function accountInitial(name: string): string {
  const seg = name.split(/[:：／/]/)[0].trim();
  return seg.charAt(0) || '?';
}

/** 计价方式的中文标签 */
function valuationTypeLabel(vtype: AccountValue['valuationType']): string {
  switch (vtype) {
    case 'market':      return t('assets.marketValue');
    case 'depreciation': return t('assets.depreciationValue');
    case 'book':
    default:            return '';  // book 是默认，不显示徽章
  }
}
