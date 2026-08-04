/**
 * finance-assets 渲染块：资产市值总览仪表板
 *
 * 展示内容：
 * 1. 头部：图标（青色走势图）+ 标题 + 状态 pill（市值口径 · 含持仓，可选归属筛选）
 * 2. 净资产（市值口径，大数字）
 * 3. 指标网格：总资产 / 总负债 / 未实现损益 / 已实现收益
 * 4. 资产配置条（按分组堆叠的百分比色条 + 图例）
 * 5. 资产卡片列表（投资类按持仓逐只展开，含成本→市值、未实现、已实现、更新估值按钮）
 * 6. 负债区域
 * 7. 对账提示（结构恒等式自检，仅合并全部归属时）
 * 8. 脚注：估值来源说明
 *
 * 视觉对齐 redesign/finance-assets.html 原型 v5 设计系统
 * （.finance-assets / .networth-h / .alloc-* / .asset-* / .lot-* / .liability-* / .fb-footnote）。
 *
 * 代码块语法：
 *   ```finance-assets
 *   owner: 自己          ; 可选，为空则合并全部归属
 *   group: class         ; 可选，class（默认，按资产/负债分类）或 prefix（按账户名前缀分组）
 *   ```
 */

import type { App, MarkdownPostProcessorContext } from 'obsidian';
import type { FinanceConfig, AccountDef, AmountInCents, Valuation } from '../types';
import {
  buildAccountFlows,
  computeNetWorth,
  computeNetWorthSeries,
  computeRealizedPnL,
  type AccountFlow,
  type AccountValue,
  type NetWorthResult,
} from '../engine/networth';
import type { Indexer } from '../ledger/indexer';
import { calculateBalances } from '../ledger/closing';
import {
  buildFxRates,
  buildSymbolMap,
  currencySymbol,
} from '../engine/fx';
import { t } from '../i18n';
import { BLOCK_ICONS, ICON_CARET, setSvg } from './icons';
import { localDateString } from '../util/date';
import { setHtml } from '../util/dom';

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

interface GroupBucket<T> {
  key: GroupKey;
  label: string;
  items: T[];
  /** 组内市值绝对值合计（用于百分比条） */
  absTotal: AmountInCents;
}

/**
 * 按指定方式分组（资产侧传 HoldingGroup，负债侧传 AccountValue）。
 * class 模式：由于调用方已按 class 预筛选，所有条目归入同一组。
 * prefix 模式：取 nameOf 返回字符串的第一段（`:` 前）作为组键。
 */
function groupItems<T>(
  items: T[],
  nameOf: (t: T) => string,
  valueOf: (t: T) => AmountInCents,
  mode: 'class' | 'prefix',
  sectionLabel?: string,
): Array<GroupBucket<T>> {
  const buckets = new Map<GroupKey, GroupBucket<T>>();

  for (const item of items) {
    const name = nameOf(item);
    let key: GroupKey;
    let label: string;

    if (mode === 'class') {
      // 调用方已按 asset/liability 分好，统一归为一组
      key = sectionLabel ?? 'all';
      label = sectionLabel ?? '';
    } else {
      // prefix：取 `:` 前第一段
      const seg = name.split(SEP_RE)[0].trim();
      key = seg || name;
      label = key;
    }

    if (!buckets.has(key)) {
      buckets.set(key, { key, label, items: [], absTotal: 0 });
    }
    const bucket = buckets.get(key)!;
    bucket.items.push(item);
    bucket.absTotal += Math.abs(valueOf(item));
  }

  // 按市值绝对值降序，大类别排在前面
  return Array.from(buckets.values()).sort((a, b) => b.absTotal - a.absTotal);
}

// ─── 持仓分组（#5：投资类按子账户逐只展开） ───────────────────────

const SEP_RE = /[:：／/]/;

/** 一个可展开的资产条目：父账户 + 其持仓子账户 */
interface HoldingGroup {
  parent: AccountValue;
  holdings: AccountValue[];
  /** 合计口径（父账户自身 + 全部持仓） */
  market: AmountInCents;
  book: AmountInCents;
  unrealized: AmountInCents;
  realized: AmountInCents;
  /** 逐只持仓的已实现收益（账户名 → 分） */
  holdingRealized: Map<string, AmountInCents>;
}

/**
 * 把「账本里出现的持仓子账户」挂到「配置里声明的父账户」下。
 *
 * 例：配置声明 `资产:股票`，账本出现 `资产:股票:腾讯` / `资产:股票:茅台`，
 * 则父卡片展示合计，下方逐只列出持仓。未命中父账户的照旧作为独立卡片。
 */
function buildHoldingGroups(
  accounts: AccountValue[],
  declaredNames: Set<string>,
  realized: Map<string, AmountInCents>,
): HoldingGroup[] {
  const byName = new Map(accounts.map((a) => [a.account, a] as const));

  /** 找 av 的最近声明父账户（须落在层级分隔符上，避免「股票基金」误挂「股票」） */
  const parentOf = (name: string): string | undefined => {
    let best: string | undefined;
    for (const d of declaredNames) {
      if (d === name || !name.startsWith(d)) continue;
      if (!SEP_RE.test(name.charAt(d.length))) continue;
      if (!byName.has(d)) continue; // 父账户未出现在当前视图（如被归属筛掉）
      if (!best || d.length > best.length) best = d;
    }
    return best;
  };

  const groups = new Map<string, HoldingGroup>();
  const childOf = new Map<string, string>();

  for (const av of accounts) {
    const p = parentOf(av.account);
    if (p) childOf.set(av.account, p);
  }

  for (const av of accounts) {
    if (childOf.has(av.account)) continue; // 子账户稍后挂到父下
    groups.set(av.account, {
      parent: av,
      holdings: [],
      market: av.marketValue,
      book: av.bookValue,
      unrealized: av.unrealizedPnL,
      realized: realized.get(av.account) ?? 0,
      holdingRealized: new Map(),
    });
  }

  for (const [child, parent] of childOf) {
    const g = groups.get(parent);
    const av = byName.get(child);
    if (!g || !av) continue;
    g.holdings.push(av);
    g.market += av.marketValue;
    g.book += av.bookValue;
    g.unrealized += av.unrealizedPnL;
    const r = realized.get(child) ?? 0;
    g.realized += r;
    if (r !== 0) g.holdingRealized.set(child, r);
  }

  for (const g of groups.values()) {
    // 持仓按市值降序，最大的排前面
    g.holdings.sort((a, b) => b.marketValue - a.marketValue);
  }
  return Array.from(groups.values());
}

/** 取账户名末段作为持仓短名（`资产:股票:腾讯` → `腾讯`） */
function lastSegment(name: string): string {
  const parts = name.split(SEP_RE);
  return parts[parts.length - 1].trim() || name;
}

/** 取账户名首段作为资产配置分类键（`资产:股票:腾讯` → `资产`） */
function categoryKey(name: string): string {
  return name.split(SEP_RE)[0].trim() || name;
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

// ─── DOM 构建工具 ────────────────────────────────────────────────

/** 创建资产卡片标签 span（owner / method / stale 三种变体） */
function tag(parent: HTMLElement, text: string, variant: 'owner' | 'method' | 'stale'): HTMLSpanElement {
  return parent.createSpan({ cls: `asset-tag ${variant}`, text });
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

  const root = el.createDiv({ cls: 'finance-block finance-assets' });
  const baseCurrency = config?.baseCurrency ?? 'CNY';
  const symbol = currencySymbol(baseCurrency, buildSymbolMap(config?.currencies));

  // ── 头部：图标（青色走势图）+ 标题 + 状态 pill ──
  const head = root.createDiv({ cls: 'fb-head' });
  setSvg(head.createDiv({ cls: 'fb-icon is-teal' }), BLOCK_ICONS.valuation);
  head.createDiv({ cls: 'fb-title', text: t('assets.title') });
  head.createDiv({ cls: 'fb-pill is-teal', text: t('assets.marketPill') });
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

  // 缓存账户定义，供 renderAssetCard 内查找 icon 等元数据
  setDefCache(accountDefs);

  // 账户流水：供估值结转推演（#4 幽灵收益根治）——估值日后的买卖会自动折进市值
  const txns = entries.map((e) => e.transaction);
  const flows = buildAccountFlows(txns);
  // 已实现收益（#5/#6）：卖出交易的第三腿按持仓归集
  const realized = computeRealizedPnL(txns, accountDefs);

  const result: NetWorthResult = computeNetWorth(
    accountDefs,
    balancesMap,
    {
      valuations,
      staleDaysDefault,
      today: new Date(),
      fxRates,
      baseCurrency,
    },
    { flows, ownerFilter: params.owner },
  );

  // ── 空态检查 ──
  if (result.accounts.length === 0) {
    root.createDiv({ cls: 'as-empty', text: t('assets.empty') });
    return;
  }

  // ── 分类账户：只保留 asset / liability 类（排除 income / expense / equity） ──
  // 用 AccountValue.accountClass 判定（配置的五大类归属，含持仓子账户从父账户继承），
  // 而非余额正负号——余额正负不可靠：现金透支为负、超额还款的负债为正，都会误判。
  const assetAccounts: AccountValue[] = [];
  const liabilityAccounts: AccountValue[] = [];
  for (const av of result.accounts) {
    if (av.accountClass === 'asset') assetAccounts.push(av);
    else if (av.accountClass === 'liability') liabilityAccounts.push(av);
    // income / expense / equity / 未分类 → 不出现在资产总览
  }

  // ── 持仓分组（#5）：账本里的子账户挂到配置声明的父账户下 ──
  const declaredNames = new Set(accountDefs.map((d) => d.name));
  const assetGroups = buildHoldingGroups(assetAccounts, declaredNames, realized);

  // 容器账户集合：本身是其他账户（持仓 / 子记录）的父节点。
  // 这类账户只作分组容器——过期估值提示必须落在「具体资产记录（子条目）」上，
  // 而非父卡片；当容器下没有任何资产记录时，父卡片不应出现「估值已过期」。
  const containerAccounts = new Set<string>();
  {
    const allNames = new Set<string>([...declaredNames, ...result.accounts.map((a) => a.account)]);
    for (const name of allNames) {
      for (const other of allNames) {
        if (other !== name && other.startsWith(name) && SEP_RE.test(other.charAt(name.length))) {
          containerAccounts.add(name);
          break;
        }
      }
    }
  }

  // 汇总口径直接取引擎按类别算好的结果（负债以贷方负值存储，引擎已转正向）
  const totalAssets = result.marketAssets;
  const totalLiabilities = result.marketLiabilities;
  const totalPnL = result.totalUnrealizedPnL;
  const netWorth = result.marketNetWorth;
  const totalRealized = assetGroups.reduce((s, g) => s + g.realized, 0);

  // ── 净资产（市值口径，大数字）──
  const nw = root.createDiv({ cls: 'networth-h' });
  nw.createDiv({ cls: 'nw-label', text: t('assets.netWorth') });
  nw.createDiv({
    cls: `nw-value ${netWorth >= 0 ? 'is-pos' : 'is-neg'}`.trim(),
    text: fmtAssetMoney(netWorth, symbol),
  });

  // ── 指标网格（有已实现收益时四格，否则三格）──
  const grid = root.createDiv({ cls: 'fb-grid' });
  metricCard(grid, t('assets.totalAssets'),   fmtAssetMoney(totalAssets, symbol));
  metricCard(grid, t('assets.totalLiabilities'), fmtAssetMoney(totalLiabilities, symbol));
  metricCard(
    grid,
    t('assets.unrealizedPnL'),
    fmtAssetMoney(totalPnL, symbol),
    totalPnL >= 0 ? 'is-pos' : 'is-neg',
  );
  if (totalRealized !== 0) {
    metricCard(
      grid,
      t('assets.realizedPnL'),
      fmtAssetMoney(totalRealized, symbol),
      totalRealized >= 0 ? 'is-pos' : 'is-neg',
    );
  }

  // ── 对账提示（#7）：仅在合并全部归属时有意义（单人切片本就不零和）──
  if (!params.owner) {
    renderReconciliation(root, result, symbol);
  }

  // ── 资产走势（2026-08-04 新增）：可展开/收起的净资产波动曲线 ──
  // 数据复用 computeNetWorthSeries（历史切片重算，估值+结转推演+折旧派生全口径），
  // 采样周期支持 月 / 季 / 年；默认折叠。
  if (entries.length > 0) {
    renderTrendSection(root, {
      accountDefs,
      flows,
      valuations,
      staleDaysDefault,
      today: new Date(),
      fxRates,
      baseCurrency,
      ownerFilter: params.owner,
      symbol,
    });
  }

  // ── 资产配置条：按「账户名首段」聚合（现金 / 股票 / 房产 / 车 …）──
  // 用 categoryKey 而非 accountClass：后者五大类太粗（全是 asset），无法形成有意义的分段。
  const allocBuckets = groupItems(
    assetGroups,
    (g) => categoryKey(g.parent.account),
    (g) => g.market,
    'prefix', // 强制按首段分组，不受 code block 的 group 参数影响
    t('assets.groupAssets'),
  );
  if (allocBuckets.length > 0 && allocBuckets.some((b) => b.absTotal > 0)) {
    renderAllocationBar(root, allocBuckets);
  }

  // ── 资产卡片列表（按 code block group 参数分组；默认 class 时平铺）──
  if (assetGroups.length > 0) {
    const assetSection = root.createDiv({ cls: 'as-section' });
    const title = assetSection.createDiv({ cls: 'section-title', text: t('assets.groupAssets') });
    if (assetGroups.some((g) => g.holdings.length > 0)) {
      title.createSpan({ cls: 'hint', text: t('assets.holdingsHint') });
    }
    const assetBuckets = groupItems(
      assetGroups,
      (g) => g.parent.account,
      (g) => g.market,
      params.group,
      t('assets.groupAssets'),
    );
    const cards = assetSection.createDiv({ cls: 'asset-grid' });
    for (const bucket of assetBuckets) {
      if (params.group === 'prefix' && assetBuckets.length > 1) {
        cards.createDiv({ cls: 'as-group-label', text: bucket.label });
      }
      for (const g of bucket.items) {
        renderAssetCard(cards, g, symbol, openValuationModal, containerAccounts);
      }
    }
  }

  // ── 负债卡片列表 ──
  if (liabilityAccounts.length > 0) {
    const liabSection = root.createDiv({ cls: 'as-section as-liabilities' });
    liabSection.createDiv({ cls: 'section-title', text: t('assets.groupLiabilities') });
    const cards = liabSection.createDiv({ cls: 'liability-list' });
    const liabBuckets = groupItems(
      liabilityAccounts,
      (av) => av.account,
      (av) => av.marketValue,
      params.group,
      t('assets.groupLiabilities'),
    );
    for (const bucket of liabBuckets) {
      if (params.group === 'prefix' && liabBuckets.length > 1) {
        cards.createDiv({ cls: 'as-group-label', text: bucket.label });
      }
      for (const av of bucket.items) {
        renderAccountCard(cards, av, symbol, openValuationModal);
      }
    }
  }

  // ── 脚注 ──
  root.createDiv({ cls: 'fb-footnote', text: t('assets.footNote') });
}

// ─── 对账提示（#7） ───────────────────────────────────────────────

/**
 * 结构恒等式自检：资产 − 负债 应恒等于 权益 + 本期留存收益。
 * 差额非 0 通常意味着「账户没在配置里声明类别」或「有交易未配平」，
 * 这里只做**提示**不做拦截——用户随时可以先记账后补配置。
 */
function renderReconciliation(
  parent: HTMLElement,
  result: NetWorthResult,
  symbol: string,
): void {
  const hasDiff = result.reconciliationDiff !== 0;
  const hasUnclassified = result.unclassifiedCount > 0;
  if (!hasDiff && !hasUnclassified) return;

  const bar = parent.createDiv({ cls: 'as-recon' });
  const icon = bar.createSpan({ cls: 'as-recon-icon' });
  setSvg(icon, '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>');

  const body = bar.createDiv({ cls: 'as-recon-body' });
  const msgs: string[] = [];
  if (hasDiff) {
    msgs.push(
      t('assets.reconDiff', { amount: fmtAssetMoney(result.reconciliationDiff, symbol) }),
    );
  }
  if (hasUnclassified) {
    msgs.push(t('assets.reconUnclassified', { n: String(result.unclassifiedCount) }));
  }
  body.createDiv({ cls: 'as-recon-title', text: msgs.join('　') });
  body.createDiv({ cls: 'as-recon-desc', text: t('assets.reconHint') });
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
  groups: Array<{ label: string; absTotal: AmountInCents }>,
): void {
  const total = groups.reduce((sum, g) => sum + g.absTotal, 0);
  if (total <= 0) return;

  parent.createDiv({ cls: 'alloc-title', text: t('assets.allocTitle') });

  const bar = parent.createDiv({ cls: 'alloc-bar' });
  const legend = parent.createDiv({ cls: 'alloc-legend' });

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const pct = g.absTotal / total;
    const color = groupColor(i);

    // 色条段
    const seg = bar.createDiv({ cls: 'alloc-seg' });
    seg.style.width = `${(pct * 100).toFixed(2)}%`;
    seg.style.backgroundColor = color;
    seg.setAttribute('title', `${g.label}: ${fmtPct(pct)}`);

    // 图例
    const item = legend.createSpan({ cls: 'alloc-legend-item' });
    const dot = item.createSpan({ cls: 'alloc-dot' });
    dot.style.backgroundColor = color;
    item.createSpan({ cls: 'alloc-name', text: g.label });
    item.createSpan({ cls: 'alloc-pct', text: fmtPct(pct) });
  }
}

// ─── 资产卡片（含持仓明细，#5） ────────────────────────────────────

/**
 * 渲染一个资产条目：父账户合计 + 可选的持仓子账户明细。
 *
 * 与原型 v5 的差异说明：原型画的是「100 股 @ 100 → 110」这种 lot 级数量/单价，
 * 但录入侧只采集**总金额**（不问股数与单价，见 finance-block 铁律），因此这里
 * 用「成本（账面）→ 市值（估值）」表达同一件事，信息密度一致但零额外录入负担。
 *
 * 更新估值按钮保留：投资类父卡片不显示（避免写出父账户整体估值行），
 * 由每只持仓各自的更新按钮承担；非投资类显示在底部左侧。
 */
function renderAssetCard(
  parent: HTMLElement,
  g: HoldingGroup,
  symbol: string,
  openValuationModal: (account: string) => void,
  containerAccounts: Set<string>,
): void {
  const hasHoldings = g.holdings.length > 0;
  const card = parent.createDiv({ cls: `asset-card${hasHoldings ? ' is-invest' : ''}` });
  const av = g.parent;

  // ── 顶部行：[icon] [name] [tags]          [¥市值合计] ──
  const topRow = card.createDiv({ cls: 'asset-row' });
  const topLeft = topRow.createDiv({ cls: 'asset-main' });
  const def = findAccountDef(av.account);
  topLeft.createDiv({ cls: 'asset-ico' }).textContent = def?.icon ?? accountInitial(av.account);
  topLeft.createDiv({ cls: 'asset-name', text: av.account });
  const tags = topLeft.createDiv({ cls: 'asset-tags' });
  if (av.owner) tag(tags, av.owner, 'owner');
  const vtypeLabel = valuationTypeLabel(av.valuationType);
  if (vtypeLabel) tag(tags, vtypeLabel, 'method');

  // 过期估值提示只落在「具体资产记录（条目）」上：
  // - 有持仓时，提示在各持仓子条目（renderHoldingRow），父卡片不显示；
  // - 无持仓且本身是容器账户（如声明了「资产:股票」但暂无任何持仓记录）时，
  //   没有可估值的具体记录，父卡片也不显示，避免误报「估值已过期」；
  // - 无持仓且为叶子资产（如「资产:房产」本身即一条记录）时，正常显示。
  const isRecord = !containerAccounts.has(av.account);
  if (!hasHoldings && isRecord && av.isStale) tag(tags, staleBadgeText(av), 'stale');

  topRow.createSpan({
    cls: `asset-amt ${g.market < 0 ? 'is-neg' : ''}`.trim(),
    text: fmtAssetMoney(g.market, symbol),
  });

  // ── 底部行：[更新估值]  账面 ¥xx  未实现 ±¥xx  （已实现 ±¥xx） ──
  // book 计价且无持仓、无已实现、无未实现时整行无信息量，直接省略
  if (av.valuationType !== 'book' || hasHoldings || g.unrealized !== 0 || g.realized !== 0) {
    const bottomRow = card.createDiv({ cls: 'asset-book' });
    const left = bottomRow.createDiv({ cls: 'ab-left' });
    // 有持仓时估值按持仓逐只更新，父卡片不再给按钮（否则会写出父账户的整体估值行）
    if (av.valuationType !== 'book' && !hasHoldings) {
      valuationBtn(left, av.account, openValuationModal);
    }
    left.createSpan({ cls: 'ab-book', text: `${t('assets.bookValue')} ${fmtAssetMoney(g.book, symbol)}` });

    const right = bottomRow.createDiv({ cls: 'ab-right' });
    if (g.unrealized !== 0) {
      right.createSpan({
        cls: `delta ${g.unrealized >= 0 ? 'is-pos' : 'is-neg'}`,
        text: `${t('assets.unrealizedShort')} ${signedMoney(g.unrealized, symbol)}`,
      });
    }
    if (g.realized !== 0) {
      right.createSpan({
        cls: `realized-badge ${g.realized >= 0 ? 'is-pos' : 'is-neg'}`.trim(),
        text: `${t('assets.realizedShort')} ${signedMoney(g.realized, symbol)}`,
      });
    }
  }

  // ── 持仓明细 ──
  if (hasHoldings) {
    card.createDiv({
      cls: 'lot-head',
      text: t('assets.holdingsHead', { n: String(g.holdings.length) }),
    });
    const list = card.createDiv({ cls: 'lot-list' });
    for (const h of g.holdings) {
      renderHoldingRow(list, h, g.holdingRealized.get(h.account) ?? 0, symbol, openValuationModal);
    }
  }
}

/** 单只持仓行：名称 + 账面→市值 + 未实现 +（可选）已实现徽章 + 更新估值按钮 */
function renderHoldingRow(
  parent: HTMLElement,
  h: AccountValue,
  realized: AmountInCents,
  symbol: string,
  openValuationModal: (account: string) => void,
): void {
  const row = parent.createDiv({ cls: 'lot-row' });

  const main = row.createDiv({ cls: 'lot-main' });
  const nameLine = main.createDiv({ cls: 'lr-name' });
  nameLine.createSpan({ text: lastSegment(h.account) });
  if (h.isStale) {
    const flag = nameLine.createSpan({ cls: 'asset-tag stale' });
    flag.textContent = staleBadgeText(h);
  }
  main.createDiv({
    cls: 'lr-sub',
    text: `${t('assets.bookValue')} ${fmtAssetMoney(h.bookValue, symbol)} → ${fmtAssetMoney(h.marketValue, symbol)}`,
  });

  const metrics = row.createDiv({ cls: 'lr-metrics' });
  metrics.createSpan({ cls: 'lr-mkt', text: fmtAssetMoney(h.marketValue, symbol) });
  if (h.unrealizedPnL !== 0) {
    metrics.createSpan({
      cls: `lr-gain ${h.unrealizedPnL >= 0 ? 'is-pos' : 'is-neg'}`,
      text: signedMoney(h.unrealizedPnL, symbol),
    });
  }

  if (realized !== 0) {
    row.createSpan({
      cls: `lr-realized ${realized >= 0 ? 'is-pos' : 'is-neg'}`.trim(),
      text: `${t('assets.realizedShort')} ${signedMoney(realized, symbol)}`,
    });
  }

  if (h.valuationType !== 'book') {
    valuationBtn(row, h.account, openValuationModal);
  }
}

/** 「更新估值」圆形图标按钮 */
function valuationBtn(
  parent: HTMLElement,
  account: string,
  openValuationModal: (account: string) => void,
): HTMLButtonElement {
  const btn = parent.createEl('button', {
    cls: 'as-icon-btn',
    attr: { title: t('assets.updateValuation'), 'aria-label': t('assets.updateValuation') },
  });
  setSvg(btn, '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>');
  btn.addEventListener('click', () => openValuationModal(account));
  return btn;
}

/** 带正负号的金额（未实现 / 已实现损益用） */
function signedMoney(cents: AmountInCents, symbol: string): string {
  return `${cents >= 0 ? '+' : ''}${fmtAssetMoney(cents, symbol)}`;
}

/**
 * stale 徽章文案：区分「估值过期」与「估值后又有买卖、当前市值为推算值」。
 * 后者是 #4 结转推演的产物，用户需要知道这个数字不是实价。
 */
function staleBadgeText(av: AccountValue): string {
  return av.carriedFlows > 0 ? t('assets.carriedBadge') : t('assets.staleBadge');
}

// ─── 账户卡片（负债） ─────────────────────────────────────────────

function renderAccountCard(
  parent: HTMLElement,
  av: AccountValue,
  symbol: string,
  openValuationModal: (account: string) => void,
): void {
  const card = parent.createDiv({ cls: 'liability-card' });

  // ── 顶部行：[icon] [name] [tags]          [¥value] ──
  const topRow = card.createDiv({ cls: 'asset-row' });
  const topLeft = topRow.createDiv({ cls: 'asset-main' });
  const def = findAccountDef(av.account);
  topLeft.createDiv({ cls: 'asset-ico' }).textContent = def?.icon ?? accountInitial(av.account);
  topLeft.createDiv({ cls: 'asset-name', text: av.account });
  const tags = topLeft.createDiv({ cls: 'asset-tags' });
  if (av.owner) tag(tags, av.owner, 'owner');
  const vtypeLabel = valuationTypeLabel(av.valuationType);
  if (vtypeLabel) tag(tags, vtypeLabel, 'method');
  // 负债不是资产记录，不存在「估值过期」语义，故不显示 stale 徽标

  topRow.createSpan({
    cls: `asset-amt ${av.marketValue < 0 ? 'is-neg' : ''}`.trim(),
    text: fmtAssetMoney(av.marketValue, symbol),
  });

  // ── 底部行（仅非 book 账户）：[🔄]   账面 ¥xx  [±¥xxx] ──
  if (av.valuationType !== 'book') {
    const bottomRow = card.createDiv({ cls: 'asset-book' });
    const left = bottomRow.createDiv({ cls: 'ab-left' });
    valuationBtn(left, av.account, openValuationModal);
    left.createSpan({ cls: 'ab-book', text: `${t('assets.bookValue')} ${fmtAssetMoney(av.bookValue, symbol)}` });

    const right = bottomRow.createDiv({ cls: 'ab-right' });
    if (av.unrealizedPnL !== 0) {
      right.createSpan({
        cls: `delta ${av.unrealizedPnL >= 0 ? 'is-pos' : 'is-neg'}`,
        text: `${t('assets.unrealizedShort')} ${signedMoney(av.unrealizedPnL, symbol)}`,
      });
    }
  }
}

// ─── 资产走势（2026-08-04 新增） ───────────────────────────────────

type TrendPeriod = 'month' | 'quarter' | 'year';

interface TrendCtx {
  accountDefs: AccountDef[];
  flows: Map<string, AccountFlow[]>;
  valuations: Valuation[];
  staleDaysDefault: number;
  today: Date;
  fxRates: Record<string, number>;
  baseCurrency: string;
  ownerFilter?: string;
  symbol: string;
}

/** 走势采样日期：从首笔交易日到今天的周期边界（月/季/年），末点恒为今天 */
function trendSampleDates(start: string, period: TrendPeriod): string[] {
  const [sy, sm] = start.split('-').map(Number);
  const now = new Date();
  const ty = now.getFullYear();
  const tm = now.getMonth() + 1;
  const pad = (n: number): string => String(n).padStart(2, '0');

  const out: string[] = [start];
  for (let y = sy; y <= ty; y++) {
    const mFrom = y === sy ? Math.max(1, sm) : 1;
    const mTo = y === ty ? tm : 12;
    for (let m = mFrom; m <= mTo; m++) {
      const keep =
        period === 'month' || (period === 'quarter' && m % 3 === 0) || (period === 'year' && m === 12);
      if (!keep) continue;
      const last = new Date(y, m, 0).getDate();
      out.push(`${y}-${pad(m)}-${pad(last)}`);
    }
  }
  const todayStr = localDateString(now);
  if (!out.includes(todayStr)) out.push(todayStr);
  return out;
}

/**
 * 可展开/收起的「资产走势」栏：折线 + 面积填充展示净资产（市值口径）随周期波动。
 * 默认折叠；展开后可按 月 / 季 / 年 切换采样周期，点击即重画。
 */
function renderTrendSection(parent: HTMLElement, ctx: TrendCtx): void {
  const section = parent.createDiv({ cls: 'atrend' });
  const head = section.createDiv({ cls: 'atrend-head' });

  const caret = head.createSpan({ cls: 'atrend-caret' });
  setSvg(caret, ICON_CARET);
  head.createSpan({ cls: 'atrend-title', text: t('assets.trend') });

  // 周期切换（默认折叠时不渲染正文，先记住选择）
  let period: TrendPeriod = 'month';
  const seg = head.createDiv({ cls: 'atrend-seg' });
  const segBtns = new Map<TrendPeriod, HTMLElement>();
  const periods: Array<{ key: TrendPeriod; label: string }> = [
    { key: 'month', label: t('assets.trend.month') },
    { key: 'quarter', label: t('assets.trend.quarter') },
    { key: 'year', label: t('assets.trend.year') },
  ];
  for (const p of periods) {
    const b = seg.createEl('button', { cls: 'atrend-seg-btn', text: p.label });
    b.dataset.period = p.key;
    segBtns.set(p.key, b);
  }
  const syncSeg = (): void => {
    segBtns.forEach((b, k) => b.toggleClass('is-active', k === period));
  };
  for (const [k, b] of segBtns) {
    // stopPropagation 必须：seg 按钮位于 head 内部，click 冒泡会触发 head 的
    // 展开/收起 toggle，造成「点周期按钮 → 栏被收起」的状态错乱（2026-08-04 修）。
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      period = k;
      syncSeg();
      draw();
    });
  }

  // 正文（折叠时由 CSS 借 .atrend.is-open 隐藏）
  const body = section.createDiv({ cls: 'atrend-body' });

  const draw = (): void => {
    body.empty();

    // 最早一笔流水 → 今天
    let first = '';
    for (const arr of ctx.flows.values()) {
      for (const f of arr) {
        if (!first || f.date < first) first = f.date;
      }
    }
    if (!first) return;

    const dates = trendSampleDates(first, period);
    if (dates.length < 2) {
      body.createDiv({ cls: 'atrend-empty', text: t('assets.trend.empty') });
      return;
    }

    const series = computeNetWorthSeries(ctx.accountDefs, ctx.flows, dates, {
      valuations: ctx.valuations,
      staleDaysDefault: ctx.staleDaysDefault,
      today: ctx.today,
      fxRates: ctx.fxRates,
      baseCurrency: ctx.baseCurrency,
    }, ctx.ownerFilter);
    const pts = series.map((p) => ({ date: p.date, v: p.marketNetWorth }));
    if (pts.length < 2) {
      body.createDiv({ cls: 'atrend-empty', text: t('assets.trend.empty') });
      return;
    }

    const firstV = pts[0].v;
    const lastV = pts[pts.length - 1].v;
    const delta = lastV - firstV;
    const deltaPct = firstV !== 0 ? (delta / Math.abs(firstV)) * 100 : 0;
    const up = delta >= 0;

    // 摘要行：起始 → 当前 · 涨跌额 · 涨跌幅
    const meta = body.createDiv({ cls: 'atrend-meta' });
    meta.createSpan({ cls: 'atrend-range', text: `${pts[0].date} → ${pts[pts.length - 1].date}` });
    meta.createSpan({
      cls: `atrend-delta ${up ? 'is-pos' : 'is-neg'}`,
      text: `${up ? '▲' : '▼'} ${signedMoney(delta, ctx.symbol)} (${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}%)`,
    });

    // SVG 折线 + 面积
    const W = 560;
    const H = 160;
    const PAD_L = 8;
    const PAD_R = 8;
    const PAD_T = 10;
    const PAD_B = 22;
    const min = Math.min(...pts.map((p) => p.v));
    const max = Math.max(...pts.map((p) => p.v));
    const span = max - min || 1;
    const x = (i: number): number => PAD_L + (i / (pts.length - 1)) * (W - PAD_L - PAD_R);
    const y = (v: number): number => PAD_T + (1 - (v - min) / span) * (H - PAD_T - PAD_B);

    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
    const area = `${line} L${x(pts.length - 1).toFixed(1)} ${(H - PAD_B).toFixed(1)} L${x(0).toFixed(1)} ${(H - PAD_B).toFixed(1)} Z`;
    const upCls = up ? 'is-pos' : 'is-neg';

    // SVG 折线 + 面积（数据全部为数值，无用户文本注入；字符串拼装与 buildSpark 模式一致）
    const svgWrap = body.createDiv({ cls: 'atrend-chart-wrap' });
    setHtml(
      svgWrap,
      `<svg class="atrend-chart" viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none">` +
        `<path class="atrend-area" d="${area}"/>` +
        `<path class="atrend-line ${upCls}" d="${line}"/>` +
        `<circle class="atrend-dot" cx="${x(0).toFixed(1)}" cy="${y(firstV).toFixed(1)}" r="3"/>` +
        `<circle class="atrend-dot is-end ${upCls}" cx="${x(pts.length - 1).toFixed(1)}" cy="${y(lastV).toFixed(1)}" r="3.5"/>` +
        `</svg>`,
    );

    // 首末日期标注
    const labels = body.createDiv({ cls: 'atrend-labels' });
    labels.createSpan({ text: pts[0].date });
    labels.createSpan({ text: pts[pts.length - 1].date });
  };

  head.addEventListener('click', () => {
    const isOpen = section.hasClass('is-open');
    section.toggleClass('is-open', !isOpen);
    if (!isOpen) draw();
  });

  syncSeg();
  // 默认折叠：由 CSS 隐藏正文，展开时才跑历史切片重算
  section.toggleClass('is-open', false);
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
  const seg = name.split(SEP_RE)[0].trim();
  return seg.charAt(0) || '?';
}

/** 计价方式的中文标签 */
function valuationTypeLabel(vtype: AccountValue['valuationType']): string {
  switch (vtype) {
    case 'market': return t('assets.marketValue');
    case 'book':
    default:       return '';  // book 是默认，不显示徽章
  }
}
