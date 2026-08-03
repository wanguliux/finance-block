/**
 * finance-ficalc 渲染块：财务自由计算器（what-if 沙盒）
 *
 * 参考 ficalc.app 的「假设式」体验：所有参数（收益率 / 本金 / 年花费 / 储蓄 / 通胀 /
 * 波动率 / 提取策略）都由滑动条或数字框直接输入，做一个退休计划的「如果…会怎样」推演。
 * 模拟结果默认折叠在一个按钮后面，点击才展开并计算（不展开就不跑 300 次随机模拟）。
 *
 * 本地没有美股历史序列，故用种子化蒙特卡洛（simulateRetirement）替代 ficalc.app 的历史回测：
 * 同参数必然给出同结果，避免每次重渲染数字乱跳。
 *
 * 参数持久化：拖动/改值后写入内存缓存 + localStorage（key = 笔记路径::块签名），
 * 切语言、编辑↔预览切换、甚至重开 vault 都不丢；只有点击「保存」按钮才把当前值写回代码块
 * 源文本（落盘），其余时候不碰文件，避免拖动时触发 Obsidian 自动重渲染导致界面回缩。
 *
 * 代码块语法（全部可省略，键名已取短）：
 *   ```finance-ficalc
 *   rate: 4               # 名义年化收益率 %
 *   principal: 300        # 本金 万
 *   spend: 12             # 年花费 万
 *   save: 20              # 年净储蓄 万
 *   infl: 2               # 年通胀率 %
 *   years: 30             # 退休年限
 *   vol: 12               # 年化波动率 %
 *   mode: fixed           # fixed | percent | rule95
 *   ```
 *
 * 单位约定：录入/显示用「万」，引擎内部一律用「分」。
 * 视觉：fb-head（图标+标题）+ fc-* 控件 + fi-track 进度 + fb-banner + fb-grid
 *      + fc-sim（默认折叠，展开后显示成功率 pill / 分位走势 / 逐年表）。
 */

import { TFile } from 'obsidian';
import type { App, MarkdownPostProcessorContext } from 'obsidian';
import {
  isFinanciallyFree,
  requiredPrincipal,
  principalGap,
  yearsToDeplete,
  maxAnnualSpend,
  yearsToFI,
  realRate,
  simulateRetirement,
  projectLifeCashflow,
  type WithdrawalStrategy,
  type PlanInput,
  type SimulationResult,
  type LifeProjection,
  // 引擎事件（只含财务影响字段）——与本文件的 ChartEvent（只含渲染字段）区分开
  type LifeEvent as EngineLifeEvent,
} from '../engine/fiCalc';
import { currencySymbol, buildSymbolMap, buildFxRates } from '../engine/fx';
import { bucketAssets, type AssetBuckets } from '../engine/assetBuckets';
import { buildAccountFlows, computeNetWorthSeries } from '../engine/networth';
import type { FinanceConfig, AccountDef, AmountInCents, LifeEventType, Valuation } from '../types';
import { calculateBalances } from '../ledger/closing';
import type { Indexer, IndexEntry } from '../ledger/indexer';
import { resolveAccountClass } from '../util/ledgerView';
import { t } from '../i18n';
import { BLOCK_ICONS, setSvg } from './icons';

const WAN_TO_CENTS = 1_000_000;
const CENTS_TO_WAN = 1 / WAN_TO_CENTS;
const MC_RUNS = 300;
const CASH_RATE_DEFAULT = 1.5; // 现金类资产默认年化收益率 %
const BUFFER_MONTHS_DEFAULT = 6; // 应急金默认月数

/** 受控参数行：写回逻辑会改写这些行，缓存签名与写回时都要剥离它们 */
const MANAGED_PARAM = /^\s*(src|source|rate|principal|spend|save|savings|infl|inflation|years|vol|volatility|mode|strategy|age|startAge|retireAge|incomeGrowth|cashRate|bufferMonths)\s*:/;

type SourceMode = 'actual' | 'manual';

// ─── 跨重渲染的状态保留 ──────────────────────────────────────
// 语言切换 / 编辑↔预览切换都会触发代码块重渲染；把滑块值缓存在内存里，
// 并在用户改动后写回代码块源文本，保证重渲染甚至重开 vault 都不丢。
interface PersistedParams {
  rate: number;
  principal?: number;
  spend?: number;
  savings?: number;
  startAge?: number;
  age: number;
  retireAge: number;
  incomeGrowth: number;
  inflation: number;
  years: number;
  volatility: number;
  strategy: WithdrawalStrategy;
  source?: SourceMode;
  simOpen?: boolean;
  cashRate?: number; // 现金类资产收益率 %（仅资产模式）
  bufferMonths?: number; // 应急金月数（仅资产模式）
}
const paramCache = new Map<string, PersistedParams>();
/**
 * 稳定的块标识：去掉所有受管参数行（这些行会被写回逻辑改写），
 * 只对「注释 / 自定义行」取签名。这样写回源文本触发的自动重渲染不会改变缓存键，
 * 从而保留 simOpen 等 UI 状态，避免面板在拖动后回缩。
 */
function stableKey(source: string, ctx?: MarkdownPostProcessorContext): string {
  const path = ctx?.sourcePath ?? '';
  const sig = source
    .split(/\r?\n/)
    .filter((l) => !MANAGED_PARAM.test(l))
    .join('\n');
  return `${path}::${sig}`;
}

const LS_PREFIX = 'fb-ficalc:';

/** 读取持久化状态：优先内存缓存（重渲染即时命中），否则落盘的 localStorage（重开 vault 后仍有） */
function loadPersisted(key: string): PersistedParams | undefined {
  const mem = paramCache.get(key);
  if (mem) return mem;
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (raw) return JSON.parse(raw) as PersistedParams;
  } catch {
    /* localStorage 不可用（隐私模式 / 配额）时静默降级为无持久化 */
  }
  return undefined;
}

/** 写入持久化状态：内存缓存 + localStorage 双写 */
function savePersisted(key: string, data: PersistedParams): void {
  paramCache.set(key, data);
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(data));
  } catch {
    /* 同上，静默降级 */
  }
}

interface FICalcParams {
  rate: number; // 名义年化收益率 %
  principal?: number; // 本金 万（未写=交给数据源决定）
  spend?: number; // 年花费 万
  savings?: number; // 年净储蓄 万
  startAge?: number; // 图表起始年龄（未写=当前年龄，仅模拟无历史段）
  age: number; // 当前年龄
  retireAge: number; // 退休年龄
  incomeGrowth: number; // 储蓄年增速 %
  inflation: number; // 通胀率 %
  years: number; // 退休后年限
  volatility: number; // 年化波动率 %
  strategy: WithdrawalStrategy;
  source?: SourceMode;
  cashRate?: number; // 现金类资产收益率 %（仅资产模式生效）
  bufferMonths?: number; // 应急金月数（仅资产模式生效）
}

function parseParams(source: string, config?: FinanceConfig): FICalcParams {
  const params: FICalcParams = {
    rate: config?.fiCalc.defaultRate ?? 4,
    age: 30,
    retireAge: 60,
    incomeGrowth: 0,
    inflation: 2,
    years: 30,
    volatility: 12,
    strategy: 'fixed',
  };

  const num = (raw: string, fallback: number): number => {
    const v = parseFloat(raw);
    return Number.isFinite(v) ? v : fallback;
  };

  for (const line of source.split(/\r?\n/)) {
    const m = /^(\w+):\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const [, key, rawVal] = m;
    const raw = rawVal.trim();
    switch (key) {
      case 'rate': params.rate = num(raw, params.rate); break;
      case 'principal': params.principal = num(raw, 0); break;
      case 'spend': params.spend = num(raw, 0); break;
      case 'save':
      case 'savings': params.savings = num(raw, 0); break;
      case 'infl':
      case 'inflation': params.inflation = num(raw, params.inflation); break;
      case 'years': params.years = Math.max(1, Math.round(num(raw, params.years))); break;
    case 'age': params.age = Math.max(0, Math.round(num(raw, params.age))); break;
    case 'startAge': params.startAge = Math.max(0, Math.round(num(raw, 0))); break;
    case 'retireAge': params.retireAge = Math.max(0, Math.round(num(raw, params.retireAge))); break;
    case 'incomeGrowth': params.incomeGrowth = num(raw, params.incomeGrowth); break;
      case 'vol':
      case 'volatility': params.volatility = num(raw, params.volatility); break;
      case 'mode':
      case 'strategy':
        if (raw === 'fixed' || raw === 'percent' || raw === 'rule95') params.strategy = raw;
        break;
      case 'cashRate': params.cashRate = num(raw, params.cashRate ?? CASH_RATE_DEFAULT); break;
      case 'bufferMonths': params.bufferMonths = Math.max(0, Math.round(num(raw, params.bufferMonths ?? BUFFER_MONTHS_DEFAULT))); break;
      case 'src':
      case 'source':
        if (raw === 'actual' || raw === 'manual') params.source = raw;
        break;
      // 兼容旧写法：useActualSpend: true 等价于 source: actual
      case 'useActualSpend':
        if (raw === 'true') params.source = 'actual';
        break;
    }
  }
  return params;
}

// ─── 账本派生（阶段二）：自动检测资产账户 → 分桶预填本金/花费/储蓄 ──
// 设计（见 现金流计算器升级方案.md 阶段二）：不恢复显式「实际账本/手填」开关，
// 改为「自动检测 + 滑条覆盖」——有资产账户就自动分桶派生本金/花费/储蓄预填，
// 用户拖动即覆盖；无资产账户退化为纯手填。块头显示数据源徽章。

/** 把 Indexer 的已入账余额列表转成 bucketAssets 需要的 Map<账户名, 分> */
function buildBalanceMap(posted: IndexEntry[]): Map<string, AmountInCents> {
  const balances = calculateBalances(posted);
  const m = new Map<string, AmountInCents>();
  for (const b of balances) m.set(b.account, b.balance);
  return m;
}

/** 近 12 个月实际年花费 + 年净储蓄（按「今天购买力」年化），用于预填滑条。
 * 净储蓄 = -Σ(收入类+费用类分录的金额)：beancount 借贷方向下收入为负、支出为正，
 * 故 -leg.amount 即把「收入 − 支出」折算成正的年净储蓄。 */
function deriveLedgerCashflow(posted: IndexEntry[], config?: FinanceConfig): { annualSpend: number; annualSavings: number } {
  const expenseByMonth = new Map<string, number>(); // 月 → 支出净额（正=支出）
  const netByMonth = new Map<string, number>(); // 月 → 净储蓄（正=储蓄）
  for (const e of posted) {
    const ym = e.transaction.date.slice(0, 7);
    for (const leg of e.transaction.legs) {
      const cls = resolveAccountClass(leg.account, config);
      if (cls !== 'income' && cls !== 'expense') continue;
      expenseByMonth.set(ym, (expenseByMonth.get(ym) ?? 0) + leg.amount);
      netByMonth.set(ym, (netByMonth.get(ym) ?? 0) - leg.amount);
    }
  }
  return { annualSpend: annualize(expenseByMonth), annualSavings: annualize(netByMonth) };
}

/** 按月聚合后年化（取最近 12 个月，不足则按比例） */
function annualize(monthly: Map<string, number>): number {
  const sorted = Array.from(monthly.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 12);
  if (sorted.length === 0) return 0;
  const total = sorted.reduce((s, [, v]) => s + v, 0);
  return Math.round((total / sorted.length) * 12);
}

// ─── 格式化 ───────────────────────────────────────────────────

function fmtMoney(cents: number, symbol: string): string {
  const wan = Math.abs(cents) * CENTS_TO_WAN;
  const sign = cents < 0 ? '-' : '';
  if (wan >= 10000) return `${sign}${symbol}${(wan / 10000).toFixed(2)}${t('ficalc.unit.yi')}`;
  if (wan >= 100) return `${sign}${symbol}${wan.toFixed(0)}${t('ficalc.unit.wan')}`;
  return `${sign}${symbol}${wan.toFixed(1)}${t('ficalc.unit.wan')}`;
}

function fmtYears(n: number): string {
  if (!Number.isFinite(n)) return t('ficalc.forever');
  if (n <= 0) return t('ficalc.metric.gap.done');
  if (n <= 1) return t('ficalc.withinYear');
  return t('ficalc.yearsValue', { n: n.toFixed(1) });
}

function fmtPct(v: number, digits = 1): string {
  return `${(v * 100).toFixed(digits)}%`;
}

function fmtParam(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/** 仅由「保存」按钮触发：把当前参数写回代码块源文本（落盘）。
 * 用 getSectionInfo 取代码块行号替换内层，比精确文本匹配更稳——连续多次保存也能命中。
 * 只在有对应笔记文件时生效（画布/纯预览无文件则跳过）。 */
function writeParamsToFile(
  app: App,
  ctx: MarkdownPostProcessorContext,
  el: HTMLElement,
  originalSource: string,
  p: PersistedParams,
): void {
  const file = app.vault.getAbstractFileByPath(ctx.sourcePath);
  if (!(file instanceof TFile)) return;
  const info = ctx.getSectionInfo(el);
  if (!info) return; // 不在笔记文件内（如画布），无法定位代码块

  app.vault.read(file).then((content) => {
    const lines = content.split(/\r?\n/);
    // info.lineStart/lineEnd 是 ``` 围栏的起止行（含围栏本身）
    const head = lines.slice(0, info.lineStart + 1); // 含开围栏
    const tail = lines.slice(info.lineEnd); // 含闭围栏

    // 保留原块中的注释 / 自定义行，剥离我们托管的参数行
    const kept = originalSource
      .split(/\r?\n/)
      .filter((ln) => !MANAGED_PARAM.test(ln.trim()));

    const paramLines: string[] = [];
    paramLines.push(`rate: ${fmtParam(p.rate)}`);
    if (p.principal !== undefined) paramLines.push(`principal: ${fmtParam(p.principal)}`);
    paramLines.push(`age: ${p.age}`);
    if (p.startAge !== undefined && p.startAge !== p.age) paramLines.push(`startAge: ${p.startAge}`);
    paramLines.push(`retireAge: ${p.retireAge}`);
    if (p.spend !== undefined) paramLines.push(`spend: ${fmtParam(p.spend)}`);
    if (p.savings !== undefined) paramLines.push(`save: ${fmtParam(p.savings)}`);
    paramLines.push(`incomeGrowth: ${fmtParam(p.incomeGrowth)}`);
    paramLines.push(`infl: ${fmtParam(p.inflation)}`);
    paramLines.push(`years: ${p.years}`);
    paramLines.push(`vol: ${fmtParam(p.volatility)}`);
    paramLines.push(`mode: ${p.strategy}`);
    if (p.cashRate !== undefined) paramLines.push(`cashRate: ${fmtParam(p.cashRate)}`);
    if (p.bufferMonths !== undefined) paramLines.push(`bufferMonths: ${fmtParam(p.bufferMonths)}`);

    // head 已含开围栏、tail 已含闭围栏，中间只替换内层 body（保留注释/自定义行）
    const newContent = [...head, ...kept, ...paramLines, ...tail].join('\n');
    if (newContent !== content) app.vault.modify(file, newContent);
  });
}

// ─── 历史净资产（记账数据） ──────────────────────────────────

interface HistoricalPoint {
  age: number;
  year: number;
  netWorth: number; // 分，基准币种
}

/** YYYY-MM-DD */
function ymdOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 历史净资产曲线（《报告》#8）——按日期切片重算**真实净资产**。
 *
 * 旧实现的坑：只累加 Income − Expense，从 0 起跑。
 * 于是 ① 起点强制为 0，忽略了记账开始前就已有的存量资产；
 *      ② 全程只看现金流，市值涨跌（股票 / 房产估值）完全缺席；
 *      ③ 末点 ≠ 今日净资产，历史段和模拟段在「当前年龄」处必然断层——
 *         图上看就是历史柱子和曲线对不上，用户一眼就发现数字打架。
 *
 * 现改为对每个年龄边界做一次 `computeNetWorthSeries` 切片：
 * 账面余额取该日之前的流水累加，市值取该日之前最新的估值行并做结转推演（#4），
 * 折旧账户按该日的折旧进度派生。末点用**今天**而非 12-31，
 * 于是历史段末点 ≡ 模拟段起点（今日净资产），断层消失。
 *
 * 返回按 age 升序的点数组，从 startAge（含）到 currentAge（含）。
 */
function computeHistoricalNetWorth(
  posted: IndexEntry[],
  config: FinanceConfig,
  baseCurrency: string,
  startAge: number,
  currentAge: number,
  valuations: Valuation[] = [],
): HistoricalPoint[] {
  const fxRates = buildFxRates(config.currencies, baseCurrency);
  const today = new Date();
  const currentYear = today.getFullYear();
  const startYear = currentYear - (currentAge - startAge);

  const flows = buildAccountFlows(posted.map((e) => e.transaction));

  // 空窗裁剪：账本开始之前的年份没有任何数据，画出来是一排 0 柱，反而误导。
  // 故历史段从「首笔记账所在年」起步（若它晚于 startAge 对应的年份）。
  let firstDate = posted[0]?.transaction.date ?? '';
  for (const e of posted) {
    if (e.transaction.date && e.transaction.date < firstDate) firstDate = e.transaction.date;
  }
  const firstYear = firstDate ? parseInt(firstDate.slice(0, 4), 10) : startYear;
  const fromYear = Math.max(startYear, Number.isFinite(firstYear) ? firstYear : startYear);
  const fromAge = startAge + (fromYear - startYear);
  if (fromAge > currentAge) return [];

  // 每个年龄边界一个切片日：过往年份取年末，当年取今天（保证末点=今日净资产）
  const todayStr = ymdOf(today);
  const dates: string[] = [];
  for (let age = fromAge; age <= currentAge; age++) {
    const year = fromYear + (age - fromAge);
    dates.push(year >= currentYear ? todayStr : `${year}-12-31`);
  }

  const series = computeNetWorthSeries(config.accounts, flows, dates, {
    valuations,
    staleDaysDefault: config.defaultStaleDays ?? 30,
    today,
    fxRates,
    baseCurrency,
  });
  const byDate = new Map(series.map((p) => [p.date, p.marketNetWorth]));

  return dates.map((date, i) => ({
    age: fromAge + i,
    year: fromYear + i,
    netWorth: byDate.get(date) ?? 0,
  }));
}

// ─── 主渲染 ───────────────────────────────────────────────────

export function renderFICalc(
  source: string,
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext,
  config?: FinanceConfig,
  app?: App,
  indexer?: Indexer,
  ledgerPath?: string,
  openLifeEventModal?: (onChanged?: () => void) => void,
): void {
  const params = parseParams(source, config);
  const cacheKey = stableKey(source, ctx);
  const cached = loadPersisted(cacheKey);
  if (cached) {
    params.rate = cached.rate;
    if (cached.principal !== undefined) params.principal = cached.principal;
    if (cached.spend !== undefined) params.spend = cached.spend;
    if (cached.savings !== undefined) params.savings = cached.savings;
    params.inflation = cached.inflation;
    params.years = cached.years;
    params.volatility = cached.volatility;
    params.strategy = cached.strategy;
    if (cached.age !== undefined) params.age = cached.age;
    if (cached.retireAge !== undefined) params.retireAge = cached.retireAge;
    if (cached.incomeGrowth !== undefined) params.incomeGrowth = cached.incomeGrowth;
    if (cached.startAge !== undefined) params.startAge = cached.startAge;
    if (cached.cashRate !== undefined) params.cashRate = cached.cashRate;
    if (cached.bufferMonths !== undefined) params.bufferMonths = cached.bufferMonths;
  }

  // ── 资产派生（阶段二）：有资产账户就自动分桶预填，用户拖动即覆盖 ──
  const hasAssetAccounts = !!(config?.accounts.some((a) => a.class === 'asset'));
  let assetMode = hasAssetAccounts && params.source !== 'manual' && indexer != null && config != null;
  let derived: AssetBuckets | null = null;
  let deriveSpendCents = 0;
  let deriveSavingsCents = 0;
  if (assetMode) {
    const posted = indexer!.getPostedTransactions();
    if (posted.length === 0) {
      assetMode = false; // 无账本数据 → 退化为手填
    } else {
      const flow = deriveLedgerCashflow(posted, config);
      deriveSpendCents = flow.annualSpend;
      deriveSavingsCents = flow.annualSavings;
      const bufferMonths = cached?.bufferMonths ?? params.bufferMonths ?? BUFFER_MONTHS_DEFAULT;
      derived = bucketAssets(
        config!,
        buildBalanceMap(posted),
        indexer!.getValuations(),
        undefined,
        { annualSpend: deriveSpendCents, bufferMonths, flows: buildAccountFlows(posted.map((e) => e.transaction)) },
      );
      if (!derived) assetMode = false;
    }
  }
  el.empty();

  const root = el.createDiv({ cls: 'finance-block ficalc' });
  const symbol = currencySymbol(config?.baseCurrency ?? 'CNY', buildSymbolMap(config?.currencies));

  // ── 头部：图标 + 标题 + 保存按钮 ──
  const head = root.createDiv({ cls: 'fb-head' });
  setSvg(head.createDiv({ cls: 'fb-icon' }), BLOCK_ICONS.ficalc);
  head.createDiv({ cls: 'fb-title', text: t('ficalc.title') });
  const actions = head.createDiv({ cls: 'fb-actions' });
  // 「事件」按钮：打开人生事件管理弹窗；关闭后回调重算，让曲线立刻反映事件增删改
  if (openLifeEventModal) {
    const eventBtn = actions.createEl('button', {
      cls: 'fb-save-btn fc-event-btn',
      text: t('ficalc.events'),
      attr: { title: t('ficalc.events.hint'), 'aria-label': t('ficalc.events') },
    });
    eventBtn.addEventListener('click', () => openLifeEventModal(() => recalc()));
  }
  const saveBtn = actions.createEl('button', {
    cls: 'fb-save-btn',
    text: t('ficalc.save'),
    attr: { title: t('ficalc.save.hint'), 'aria-label': t('ficalc.save') },
  });
  if (!app) {
    saveBtn.disabled = true;
    saveBtn.setAttribute('title', t('ficalc.save.noFile'));
  }
  // 成功率 pill 收进「蒙特卡洛模拟」面板（展开才计算）

  // ── 初始值：资产模式自动分桶预填本金/花费/储蓄；否则 what-if 手填默认值 ──
  const autoYears = Math.max(30, 95 - params.retireAge); // 预测年限默认值：至少 30 年或至 95 岁
  const initial = {
    principal: cached?.principal ?? (assetMode && derived ? derived.interestPrincipal * CENTS_TO_WAN : params.principal ?? 100),
    spend: cached?.spend ?? (assetMode && deriveSpendCents > 0 ? deriveSpendCents * CENTS_TO_WAN : params.spend ?? 4),
    savings: cached?.savings ?? (assetMode && deriveSavingsCents > 0 ? deriveSavingsCents * CENTS_TO_WAN : params.savings ?? 10),
    startAge: cached?.startAge ?? params.startAge ?? params.age,
    age: params.age,
    retireAge: params.retireAge,
    incomeGrowth: params.incomeGrowth,
    years: cached?.years ?? params.years ?? autoYears,
  };

  // ── 基本参数（可折叠）：当前年龄 / 起始年龄 / 退休年龄 / 年利率 / 生息本金 / 年花费 ──
  const basic = root.createEl('details', { cls: 'fc-basic' });
  basic.createEl('summary', { cls: 'fc-basic-head', text: t('ficalc.basic') });
  basic.open = true; // 默认展开
  const basicBody = basic.createDiv({ cls: 'fc-basic-body' });
  const ageSlider = createSlider(basicBody, {
    label: t('param.age'),
    unit: t('ficalc.unit.year'),
    min: 18,
    max: 80,
    power: 1,
    step: 1,
    value: initial.age,
  });
  const startAgeSlider = createSlider(basicBody, {
    label: t('param.startAge'),
    unit: t('ficalc.unit.year'),
    min: 14,
    max: 80,
    power: 1,
    step: 1,
    value: initial.startAge,
  });
  const retireAgeSlider = createSlider(basicBody, {
    label: t('param.retireAge'),
    unit: t('ficalc.unit.year'),
    min: 30,
    max: 90,
    power: 1,
    step: 1,
    value: initial.retireAge,
  });
  const rateSlider = createSlider(basicBody, {
    label: t('param.rate'),
    unit: '%',
    min: 0,
    max: 200,
    power: 1,
    step: 0.1,
    value: params.rate,
  });

  // ── 派生值（有资产账户时自动预填；无账户则显示默认值供手填；均可滑条覆盖） ──
  // 与核心参数同框、各占一行，紧随年利率之后
  const derivedRow = basicBody.createDiv({ cls: 'fc-derived' });
  const principalSlider = createSlider(derivedRow, {
    label: t('param.principal'),
    unit: t('ficalc.unit.wan'),
    min: 0,
    max: 100000,
    power: 3,
    step: 0.1,
    value: initial.principal,
  });
  const spendSlider = createSlider(derivedRow, {
    label: t('param.spend'),
    unit: t('ficalc.unit.wan'),
    min: 0,
    max: 10000,
    power: 3,
    step: 0.1,
    value: initial.spend,
  });

  // ── 更多假设（折叠）：通胀 / 年限 / 储蓄 / 波动率 / 提取策略 ──
  const more = root.createEl('details', { cls: 'fc-more' });
  more.createEl('summary', { cls: 'fc-more-head', text: t('ficalc.more') });
  const moreBody = more.createDiv({ cls: 'fc-more-body' });
  const advGrid = moreBody.createDiv({ cls: 'fc-adv' });

  const inflationSlider = createSlider(advGrid, {
    label: t('param.inflation'),
    unit: '%',
    min: 0,
    max: 20,
    power: 1,
    step: 0.1,
    value: params.inflation,
  }, true);
  const yearsSlider = createSlider(advGrid, {
    label: t('param.years'),
    unit: t('ficalc.unit.year'),
    min: 1,
    max: 80,
    power: 1,
    step: 1,
    value: initial.years,
  }, true);
  const savingsSlider = createSlider(advGrid, {
    label: t('param.savings'),
    unit: t('ficalc.unit.wan'),
    min: 0,
    max: 5000,
    power: 3,
    step: 0.1,
    value: initial.savings,
  }, true);
  const volSlider = createSlider(advGrid, {
    label: t('param.volatility'),
    unit: '%',
    min: 0,
    max: 60,
    power: 1,
    step: 0.5,
    value: params.volatility,
  }, true);
  const incomeGrowthSlider = createSlider(advGrid, {
    label: t('param.incomeGrowth'),
    unit: '%',
    min: 0,
    max: 20,
    power: 1,
    step: 0.1,
    value: initial.incomeGrowth,
  }, true);

  // 现金收益率 / 应急金月数：资产账户模式参与计算；手填模式同样显示，便于编辑与预设
  const assetGrid = moreBody.createDiv({ cls: 'fc-adv fc-asset-params' });
  const cashRateSlider = createSlider(assetGrid, {
    label: t('param.cashRate'),
    unit: '%',
    min: 0,
    max: 10,
    power: 1,
    step: 0.1,
    value: cached?.cashRate ?? (params.cashRate ?? CASH_RATE_DEFAULT),
  }, true);
  const bufferMonthsSlider = createSlider(assetGrid, {
    label: t('param.bufferMonths'),
    unit: t('ficalc.unit.year') === '年' ? '月' : 'mo',
    min: 0,
    max: 36,
    power: 1,
    step: 1,
    value: cached?.bufferMonths ?? (params.bufferMonths ?? BUFFER_MONTHS_DEFAULT),
  }, true);
  const assetHint = assetGrid.createDiv({ cls: 'fc-asset-hint' });
  assetHint.textContent = t('ficalc.assetParams.hint');

  const stratRow = moreBody.createDiv({ cls: 'fc-strategy' });
  stratRow.createDiv({ cls: 'fc-label', text: t('param.strategy') });
  const stratSeg = stratRow.createDiv({ cls: 'fc-seg' });
  const strategies: WithdrawalStrategy[] = ['fixed', 'percent', 'rule95'];
  let strategy: WithdrawalStrategy = params.strategy;
  const stratBtns = new Map<WithdrawalStrategy, HTMLButtonElement>();
  for (const s of strategies) {
    const btn = stratSeg.createEl('button', { cls: 'fc-seg-btn', text: t(`ficalc.strategy.${s}`) });
    btn.setAttribute('title', t(`ficalc.strategy.${s}.desc`));
    stratBtns.set(s, btn);
    btn.addEventListener('click', () => {
      strategy = s;
      syncStrategy();
      schedule();
    });
  }
  const stratDesc = moreBody.createDiv({ cls: 'fc-hint' });

  // ── 输出区（确定性结论始终可见；蒙特卡洛模拟默认折叠、展开才计算） ──
  const progressEl = root.createDiv({ cls: 'fc-progress' });
  const lifeCycleEl = root.createDiv({ cls: 'fc-lifecycle' });
  const resultEl = root.createDiv({ cls: 'fc-result' });

  // 蒙特卡洛模拟：收束成一个按钮，点击展开才跑计算（用户不展开就不算）
  // 重渲染（写回源文本触发）后从缓存恢复展开状态，避免面板回缩
  let simOpen = cached?.simOpen ?? false;
  const simWrap = root.createDiv({ cls: 'fc-sim-wrap' });
  const simToggle = simWrap.createEl('button', {
    cls: 'fc-sim-toggle',
    attr: { 'aria-expanded': 'false' },
  });
  const simCaret = simToggle.createSpan({ cls: 'fc-sim-caret', text: '▸' });
  simToggle.createSpan({ cls: 'fc-sim-toggle-label', text: t('ficalc.sim.toggle') });
  simToggle.createSpan({ cls: 'fc-sim-toggle-hint', text: t('ficalc.sim.toggleHint') });
  const simEl = simWrap.createDiv({ cls: 'fc-sim is-collapsed' });

  // ── 状态同步 ──
  function syncStrategy(): void {
    stratBtns.forEach((btn, s) => btn.toggleClass('is-active', s === strategy));
    stratDesc.textContent = t(`ficalc.strategy.${strategy}.desc`);
  }

  // ── 保存按钮：仅此一处把当前值写回代码块源文本（落盘） ──
  // 写回会触发 Obsidian 自动重渲染，但 stateKey 稳定 + localStorage 已先写入，
  // 重渲染后滑块值与「模拟面板是否展开」都会从缓存恢复，不会回缩。
  saveBtn.addEventListener('click', () => {
    if (!app) return;
    persist(); // 先落内存 + localStorage，确保重渲染即使先于写回也保留状态
    writeParamsToFile(
      app,
      ctx,
      el,
      source,
      {
        rate: rateSlider.value,
        principal: principalSlider.value,
        age: Math.round(ageSlider.value),
        retireAge: Math.round(retireAgeSlider.value),
        spend: spendSlider.value,
        savings: savingsSlider.value,
        incomeGrowth: incomeGrowthSlider.value,
        inflation: inflationSlider.value,
        years: Math.round(yearsSlider.value),
        volatility: volSlider.value,
        strategy,
        cashRate: cashRateSlider.value,
        bufferMonths: Math.round(bufferMonthsSlider.value),
        simOpen,
      },
    );
    const original = t('ficalc.save');
    saveBtn.textContent = t('ficalc.saved');
    window.setTimeout(() => { saveBtn.textContent = original; }, 1500);
  });

  // ── 蒙特卡洛面板展开 / 收起（展开才计算，收起即清空） ──
  simToggle.addEventListener('click', () => {
    simOpen = !simOpen;
    simWrap.toggleClass('is-open', simOpen);
    simEl.toggleClass('is-collapsed', !simOpen); // 关键修复：移掉隐藏类才显示
    simToggle.setAttribute('aria-expanded', String(simOpen));
    simCaret.textContent = simOpen ? '▾' : '▸';
    persist(); // 记录展开/收起，重渲染（写回触发）后保持面板状态
    if (simOpen) {
      recalc(); // 展开即计算（不触发写回，避免无谓改动源文本）
    } else {
      simEl.empty();
    }
  });

  // 重渲染后恢复展开状态：写回源文本会触发 Obsidian 自动重渲染本块，
  // 若缓存里 simOpen=true 则重新展开并填充，避免拖动一秒后面板回缩。
  if (simOpen) {
    simWrap.toggleClass('is-open', true);
    simEl.toggleClass('is-collapsed', false);
    simToggle.setAttribute('aria-expanded', 'true');
    simCaret.textContent = '▾';
  }

  // ── 重算（rAF 节流：拖动滑条时每帧最多算一次，保证 60fps） ──
  let frame = 0;
  function schedule(): void {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      recalc();
    });
  }

  // 把当前滑块值写入内存缓存 + localStorage（重渲染/重开 vault 立即可见）
  function persist(): void {
    savePersisted(cacheKey, {
      rate: rateSlider.value,
      principal: principalSlider.value,
      spend: spendSlider.value,
      savings: savingsSlider.value,
      startAge: startAgeSlider ? Math.round(startAgeSlider.value) : undefined,
      age: Math.round(ageSlider.value),
      retireAge: Math.round(retireAgeSlider.value),
      incomeGrowth: incomeGrowthSlider.value,
      inflation: inflationSlider.value,
      years: Math.round(yearsSlider.value),
      volatility: volSlider.value,
      strategy,
      cashRate: cashRateSlider.value,
      bufferMonths: Math.round(bufferMonthsSlider.value),
      simOpen,
    });
  }

  function recalc(): void {
    persist(); // 先更新内存缓存，重渲染不丢
    const nominalRate = rateSlider.value / 100;
    const inflation = inflationSlider.value / 100;
    const rr = realRate(nominalRate, inflation);
    const principal = principalSlider.value * WAN_TO_CENTS;
    const spend = spendSlider.value * WAN_TO_CENTS;
    const savings = savingsSlider.value * WAN_TO_CENTS;
    const years = Math.round(yearsSlider.value);
    const volatility = volSlider.value / 100;

    const age = Math.round(ageSlider.value);
    const retireAge = Math.round(retireAgeSlider.value);
    const endAge = Math.max(retireAge + 1, retireAge + years);

    // 资产模式：把分桶结果喂给引擎（现金桶超应急金部分按现金收益率增长；
    // 非生息资产进净资产线、负债抵减净资产）。手动模式不传 → 引擎退化到阶段一行为。
    let cashPrincipal = 0;
    let nonInterestAssets = 0;
    let liabilities = 0;
    let cashRateVal = nominalRate;
    if (assetMode && derived) {
      const buffer = Math.round(bufferMonthsSlider.value);
      const spendCents = spendSlider.value * WAN_TO_CENTS;
      const emergencyBuffer = Math.round((spendCents * buffer) / 12);
      cashPrincipal = Math.max(0, derived.cashValue - emergencyBuffer);
      nonInterestAssets = derived.nonInterestAssets;
      liabilities = derived.liabilities;
      cashRateVal = cashRateSlider.value / 100;
    }

    // ── 人生事件（阶段三）：一份配置，两种用途 ──
    // 已启用且落在模拟区间内的事件才参与；同一份数据分别转成
    //   ① 引擎事件（EngineLifeEvent）→ 叠加进曲线计算
    //   ② 图表标记（ChartEvent）→ 画在「关键事件」层上，可点开笔记
    const currentYear = new Date().getFullYear();
    const userEvents = (config?.lifeEvents ?? []).filter(
      (e) => e.type !== 'retire' && e.enabled && e.age >= age && e.age <= endAge,
    );
    const engineEvents: EngineLifeEvent[] = userEvents.map((e) => ({
      atAge: e.age,
      oneOff: e.oneOff,
      deltaSpend: e.deltaSpend,
      deltaIncome: e.deltaIncome,
      deltaFixed: e.deltaFixed,
      deltaLiability: e.deltaLiability,
    }));

    // 完整生命周期双线投影（积累期 + 支取期 + 人生事件叠加）
    const projection = projectLifeCashflow({
      currentAge: age,
      retireAge,
      endAge,
      principal,
      annualSavings: savings,
      incomeGrowth: incomeGrowthSlider.value / 100,
      nominalRate,
      inflation,
      retireSpend: spend,
      strategy,
      events: engineEvents,
      cashRate: assetMode ? cashRateVal : undefined,
      cashPrincipal: assetMode ? cashPrincipal : undefined,
      nonInterestAssets: assetMode ? nonInterestAssets : undefined,
      liabilities: assetMode ? liabilities : undefined,
    });

    // 退休事件来自配置（用户可改名/绑笔记/停用，但类型锁定、不可删）；
    // 图表永远画在「退休年龄」参数处。无 retire 配置时兜底仍显示默认退休标记。
    const retireDef = (config?.lifeEvents ?? []).find((e) => e.type === 'retire');
    const retireEvent: ChartEvent | null = retireDef
      ? retireDef.enabled
        ? {
            id: 'retire',
            type: 'retire',
            label: retireDef.label || t('ficalc.lifecycle.retireEvent'),
            age: retireAge,
            year: currentYear + Math.max(0, retireAge - age),
            note: retireDef.note,
          }
        : null
      : {
          id: 'retire',
          type: 'retire',
          label: t('ficalc.lifecycle.retireEvent'),
          age: retireAge,
          year: currentYear + Math.max(0, retireAge - age),
        };

    // 图表事件层：配置里的退休标记 + 用户事件，按年龄排序
    const events: ChartEvent[] = [
      ...(retireEvent ? [retireEvent] : []),
      ...userEvents.map((e) => ({
        id: e.id,
        type: e.type,
        label: e.label,
        age: e.age,
        year: currentYear + Math.max(0, e.age - age),
        note: e.note,
      })),
    ].sort((a, b) => a.age - b.age);

    // 点击事件：有关联笔记就跳转，否则打开事件管理弹窗直接编辑（退休标记同样可点开编辑）
    const onEventClick = (ev: ChartEvent): void => {
      if (ev.note && app) {
        app.workspace.openLinkText(ev.note, ctx.sourcePath, false);
      } else if (openLifeEventModal) {
        openLifeEventModal(() => recalc());
      }
    };

    // 历史净资产：startAge < age 时从记账数据提取确定段
    const startAge = Math.round(startAgeSlider.value);
    let historical: HistoricalPoint[] | null = null;
    if (startAge < age && assetMode && indexer && config) {
      const posted = indexer.getPostedTransactions();
      if (posted.length > 0) {
        historical = computeHistoricalNetWorth(
          posted, config, config.baseCurrency ?? 'CNY',
          startAge, age, indexer.getValuations(),
        );
      }
    }

    renderLifeCycle(lifeCycleEl, projection, symbol, events, onEventClick, historical, startAge);

    const plan: PlanInput = {
      principal,
      annualSpend: spend,
      nominalRate,
      inflation,
      years,
      strategy,
    };

    const free = isFinanciallyFree(principal, rr, spend);
    const target = requiredPrincipal(spend, rr);
    const gap = principalGap(principal, rr, spend);

    renderProgress(progressEl, principal, target, free);
    renderConclusion(resultEl, {
      free, gap, target, principal, spend, savings, rr, years, symbol, fiAge: projection.fiAge,
    });
    // 蒙特卡洛模拟仅在展开时计算（避免每次拖动都跑 300 次随机模拟）
    if (simOpen) {
      const sim = simulateRetirement(plan, volatility, MC_RUNS);
      renderSimulation(simEl, sim, plan, strategy, symbol, {
        target, gap, rr, fiAge: projection.fiAge, fiYear: projection.fiYear,
        principal, savings, age, spend,
      });
    }
  }

  rateSlider.onChange(schedule);
  principalSlider.onChange(schedule);
  ageSlider.onChange(schedule);
  startAgeSlider.onChange(schedule);
  retireAgeSlider.onChange(schedule);
  spendSlider.onChange(schedule);
  inflationSlider.onChange(schedule);
  yearsSlider.onChange(schedule);
  savingsSlider.onChange(schedule);
  incomeGrowthSlider.onChange(schedule);
  volSlider.onChange(schedule);
  cashRateSlider.onChange(schedule);
  bufferMonthsSlider.onChange(schedule);

  syncStrategy();
  recalc();
}

function successTone(rate: number): string {
  if (rate >= 0.9) return 'is-green';
  if (rate >= 0.75) return 'is-amber';
  return 'is-red';
}

// ─── 进度条（并自 finance-fi 的 fi-track） ────────────────────

function renderProgress(el: HTMLElement, principal: number, target: number, free: boolean): void {
  el.empty();
  if (!Number.isFinite(target) || target <= 0) return;
  const pct = Math.max(0, Math.min(principal / target, 1));
  const track = el.createDiv({ cls: 'fi-track' });
  const fill = track.createDiv({ cls: `fi-fill ${free ? 'is-free' : 'is-active'}` });
  fill.style.width = `${pct * 100}%`;
  el.createDiv({ cls: 'fi-label', text: t('ficalc.progress', { v: (pct * 100).toFixed(1) }) });
}

// ─── 结论横幅 + 指标网格 ──────────────────────────────────────

interface ConclusionInput {
  free: boolean;
  gap: number;
  target: number;
  principal: number;
  spend: number;
  savings: number;
  rr: number;
  years: number;
  symbol: string;
  fiAge?: number | null;
}

function renderConclusion(el: HTMLElement, c: ConclusionInput): void {
  el.empty();

  const banner = el.createDiv({ cls: `fb-banner ${c.free ? 'is-free' : 'not-free'}` });
  banner.createSpan({ cls: 'b-label', text: c.free ? t('ficalc.banner.free') : t('ficalc.banner.notFree') });

  if (c.free) {
    banner.createSpan({ cls: 'b-desc', text: t('ficalc.banner.free.desc') });
  } else {
    const toGoal = yearsToFI(c.principal, c.target, c.savings, c.rr);
    const desc = Number.isFinite(toGoal) && toGoal > 0
      ? t('ficalc.banner.notFree.pace', {
          gap: fmtMoney(c.gap, c.symbol),
          years: toGoal.toFixed(1),
          targetYear: String(new Date().getFullYear() + Math.ceil(toGoal)),
        })
      : t('ficalc.banner.notFree.desc', { gap: fmtMoney(c.gap, c.symbol) });
    banner.createSpan({ cls: 'b-desc', text: desc });
  }

  const swr = c.principal > 0 ? c.spend / c.principal : 0;
  const toGoal = yearsToFI(c.principal, c.target, c.savings, c.rr);

  const grid = el.createDiv({ cls: 'fb-grid' });
  metric(grid, t('ficalc.metric.requiredPrincipal'), fmtMoney(c.target, c.symbol), t('ficalc.metric.requiredPrincipal.desc'));
  metric(grid, t('ficalc.metric.gap'), c.free ? t('ficalc.metric.gap.done') : fmtMoney(c.gap, c.symbol), t('ficalc.metric.gap.desc'));
  metric(grid, t('ficalc.metric.maxSpend'), fmtMoney(maxAnnualSpend(c.principal, c.rr), c.symbol), t('ficalc.metric.maxSpend.desc'));
  metric(grid, t('ficalc.metric.swr'), c.principal > 0 ? fmtPct(swr, 2) : '—', t('ficalc.metric.swr.desc'));
  metric(grid, t('ficalc.metric.years'), fmtYears(yearsToDeplete(c.principal, c.rr, c.spend)), t('ficalc.metric.years.desc'));
  metric(
    grid,
    t('ficalc.metric.reach'),
    c.free ? t('ficalc.metric.gap.done') : fmtYears(toGoal),
    t('ficalc.metric.reach.desc'),
  );
  metric(grid, t('ficalc.metric.savings'), fmtMoney(c.savings, c.symbol), t('ficalc.metric.savings.desc'));
  if (c.fiAge != null) {
    metric(grid, t('ficalc.metric.fiAge'), `${c.fiAge} 岁`, t('ficalc.metric.fiAge.desc'));
  }
}

function metric(parent: HTMLElement, label: string, value: string, desc: string): void {
  const card = parent.createDiv({ cls: 'fb-metric' });
  card.createDiv({ cls: 'm-label', text: label });
  card.createDiv({ cls: 'm-value', text: value });
  if (desc) card.createDiv({ cls: 'm-desc', text: desc });
}

// ─── 模拟结果区（ficalc.app 风格） ────────────────────────────

function renderSimulation(
  el: HTMLElement,
  sim: SimulationResult,
  plan: PlanInput,
  strategy: WithdrawalStrategy,
  symbol: string,
  extra: {
    target: number;
    gap: number;
    rr: number;
    fiAge: number | null;
    fiYear: number | null;
    principal: number;
    savings: number;
    age: number;
    spend: number;
  },
): void {
  el.empty();

  const head = el.createDiv({ cls: 'fc-sim-head' });
  const titleWrap = head.createDiv({ cls: 'fc-sim-titlewrap' });
  titleWrap.createSpan({ cls: 'fc-sim-title', text: t('ficalc.sim.title') });
  // 成功率 pill：这是 ficalc.app 的核心指标，比"自由/不自由"更有信息量
  titleWrap.createDiv({
    cls: `fb-pill ${successTone(sim.successRate)}`,
    text: t('ficalc.pill.success', { v: fmtPct(sim.successRate, 1) }),
  });
  head.createSpan({ cls: 'fc-sim-note', text: t('ficalc.sim.note', { runs: String(sim.runs), years: String(plan.years) }) });

  // 成功率仪表
  const gauge = el.createDiv({ cls: 'fc-gauge' });
  const gTop = gauge.createDiv({ cls: 'fc-gauge-top' });
  gTop.createSpan({ cls: 'fc-gauge-label', text: t('ficalc.sim.successRate') });
  gTop.createSpan({ cls: `fc-gauge-value ${successTone(sim.successRate)}`, text: fmtPct(sim.successRate, 1) });
  const gTrack = gauge.createDiv({ cls: 'fc-gauge-track' });
  const gFill = gTrack.createDiv({ cls: `fc-gauge-fill ${successTone(sim.successRate)}` });
  gFill.style.width = `${Math.max(0, Math.min(1, sim.successRate)) * 100}%`;

  // 8 张分析卡片（与用户截图一致）：所需本金 / 本金缺口 / 可持续年花费 / 安全提取率 /
  // 可撑年数 / 预计达成年份 / 年净储蓄 / 自由里程碑
  const metricsGrid = el.createDiv({ cls: 'fc-sim-metrics' });
  const mCard = (label: string, value: string): void => {
    const card = metricsGrid.createDiv({ cls: 'fc-stat' });
    card.createSpan({ cls: 'fc-stat-label', text: label });
    card.createSpan({ cls: 'fc-stat-value', text: value });
  };
  mCard(t('ficalc.metric.requiredPrincipal'), fmtMoney(extra.target, symbol));
  mCard(t('ficalc.metric.gap'), extra.gap <= 0 ? t('ficalc.metric.gap.done') : fmtMoney(extra.gap, symbol));
  mCard(t('ficalc.metric.maxSpend'), fmtMoney(maxAnnualSpend(extra.principal, extra.rr), symbol));
  mCard(t('ficalc.metric.swr'), extra.principal > 0 ? fmtPct(extra.spend / extra.principal, 2) : '—');
  mCard(t('ficalc.metric.years'), fmtYears(yearsToDeplete(extra.principal, extra.rr, extra.spend)));
  mCard(t('ficalc.metric.reach'), extra.fiYear != null ? String(extra.fiYear) : '—');
  mCard(t('ficalc.metric.savings'), fmtMoney(extra.savings, symbol));
  mCard(t('ficalc.metric.fiAge'), extra.fiAge != null ? `${extra.fiAge} 岁` : '—');

  renderChart(el, sim, plan, symbol);
  renderYearTable(el, sim, plan, symbol);
}

// ─── SVG 分位走势图 ───────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(
  parent: Element,
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent.appendChild(node);
  return node;
}

function renderChart(parent: HTMLElement, sim: SimulationResult, plan: PlanInput, symbol: string): void {
  const W = 600;
  const H = 176;
  const PAD_L = 6;
  const PAD_R = 6;
  const PAD_T = 10;
  const PAD_B = 24;

  const n = sim.p50.length;
  if (n < 2) return;

  const wrap = parent.createDiv({ cls: 'fc-chart' });
  const readout = wrap.createDiv({ cls: 'fc-chart-readout' });
  readout.textContent = t('ficalc.chart.hint');

  const svg = svgEl(wrap, 'svg', {
    viewBox: `0 0 ${W} ${H}`,
    width: '100%',
    role: 'img',
    'aria-label': t('ficalc.chart.aria'),
    class: 'fc-chart-svg',
  });

  const maxV = Math.max(...sim.p90, plan.principal, 1) * 1.08;
  const px = (i: number): number => PAD_L + ((W - PAD_L - PAD_R) * i) / (n - 1);
  const py = (v: number): number => PAD_T + (H - PAD_T - PAD_B) * (1 - Math.max(0, v) / maxV);

  // 基线 + 起始本金参考线（判断"期末比起点多还是少"，对应 ficalc 的 End Portfolio Value）
  svgEl(svg, 'line', {
    x1: PAD_L, y1: py(0), x2: W - PAD_R, y2: py(0),
    class: 'fc-axis',
  });
  svgEl(svg, 'line', {
    x1: PAD_L, y1: py(plan.principal), x2: W - PAD_R, y2: py(plan.principal),
    class: 'fc-refline',
  });

  // P10~P90 区间带
  const bandPoints: string[] = [];
  for (let i = 0; i < n; i++) bandPoints.push(`${px(i).toFixed(1)},${py(sim.p90[i]).toFixed(1)}`);
  for (let i = n - 1; i >= 0; i--) bandPoints.push(`${px(i).toFixed(1)},${py(sim.p10[i]).toFixed(1)}`);
  svgEl(svg, 'polygon', { points: bandPoints.join(' '), class: 'fc-band' });

  // 中位线
  const median = sim.p50.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
  svgEl(svg, 'polyline', { points: median, fill: 'none', class: 'fc-median' });

  // x 轴刻度
  const ticks = [0, Math.round((n - 1) / 2), n - 1];
  for (const i of ticks) {
    svgEl(svg, 'text', {
      x: i === 0 ? PAD_L : i === n - 1 ? W - PAD_R : px(i),
      y: H - 8,
      'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle',
      class: 'fc-tick',
    }).textContent = i === 0 ? t('ficalc.chart.start') : t('ficalc.yearsValue', { n: String(i) });
  }
  svgEl(svg, 'text', { x: PAD_L, y: PAD_T + 4, class: 'fc-tick' }).textContent = fmtMoney(maxV, symbol);

  // 悬停：竖向游标 + 顶部读数
  const guide = svgEl(svg, 'line', {
    x1: 0, y1: PAD_T, x2: 0, y2: H - PAD_B, class: 'fc-guide', opacity: 0,
  });
  const dot = svgEl(svg, 'circle', { cx: 0, cy: 0, r: 3.5, class: 'fc-dot', opacity: 0 });
  const hit = svgEl(svg, 'rect', {
    x: 0, y: 0, width: W, height: H, fill: 'transparent', class: 'fc-hit',
  });

  hit.addEventListener('mousemove', (ev: MouseEvent) => {
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return;
    // 屏幕像素 → viewBox 坐标 → 年份下标
    const vbX = ((ev.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((vbX - PAD_L) / (W - PAD_L - PAD_R)) * (n - 1))));
    guide.setAttribute('x1', String(px(i)));
    guide.setAttribute('x2', String(px(i)));
    guide.setAttribute('opacity', '1');
    dot.setAttribute('cx', String(px(i)));
    dot.setAttribute('cy', String(py(sim.p50[i])));
    dot.setAttribute('opacity', '1');
    readout.textContent = t('ficalc.chart.readout', {
      year: i === 0 ? t('ficalc.chart.start') : t('ficalc.yearsValue', { n: String(i) }),
      p50: fmtMoney(sim.p50[i], symbol),
      p10: fmtMoney(sim.p10[i], symbol),
      p90: fmtMoney(sim.p90[i], symbol),
    });
  });
  hit.addEventListener('mouseleave', () => {
    guide.setAttribute('opacity', '0');
    dot.setAttribute('opacity', '0');
    readout.textContent = t('ficalc.chart.hint');
  });
}

// ─── 关键年份表 ───────────────────────────────────────────────

function renderYearTable(parent: HTMLElement, sim: SimulationResult, plan: PlanInput, symbol: string): void {
  const years = plan.years;
  const step = Math.max(1, Math.ceil(years / 5));
  const marks: number[] = [1];
  for (let y = step; y < years; y += step) if (y > 1) marks.push(y);
  if (marks[marks.length - 1] !== years) marks.push(years);

  const table = parent.createDiv({ cls: 'fc-table' });
  const header = table.createDiv({ cls: 'fc-tr is-head' });
  header.createSpan({ text: t('ficalc.table.year') });
  header.createSpan({ text: t('ficalc.table.p10') });
  header.createSpan({ text: t('ficalc.table.p50') });
  header.createSpan({ text: t('ficalc.table.p90') });

  for (const y of marks) {
    if (y >= sim.p50.length) continue;
    const row = table.createDiv({ cls: 'fc-tr' });
    row.createSpan({ text: t('ficalc.yearsValue', { n: String(y) }) });
    row.createSpan({ cls: 'num is-low', text: fmtMoney(sim.p10[y], symbol) });
    row.createSpan({ cls: 'num', text: fmtMoney(sim.p50[y], symbol) });
    row.createSpan({ cls: 'num is-high', text: fmtMoney(sim.p90[y], symbol) });
  }
}

// ─── 滑动条 ───────────────────────────────────────────────────

interface SliderSpec {
  label: string;
  unit: string;
  min: number;
  max: number;
  /** 幂次曲线：1=线性；>1 时低值区更精细，用来在不牺牲手感的前提下把量程拉大 */
  power: number;
  step: number;
  value: number;
}

interface SliderHandle {
  readonly value: number;
  setValue: (val: number, silent?: boolean) => void;
  onChange: (cb: () => void) => void;
}

const CURVE_RESOLUTION = 1000;

/** 按量级取合适的舍入精度：小值保留 0.1，中值取整，大值取 10 的倍数 */
function snapValue(v: number, step: number): number {
  const abs = Math.abs(v);
  let unit = step;
  if (abs >= 1000) unit = Math.max(step, 10);
  else if (abs >= 100) unit = Math.max(step, 1);
  return Math.round(v / unit) * unit;
}

function createSlider(parent: HTMLElement, spec: SliderSpec, compact = false): SliderHandle {
  const linear = spec.power === 1;
  const span = spec.max - spec.min;

  const toValue = (pos: number): number => {
    if (linear) return pos;
    const tRaw = pos / CURVE_RESOLUTION;
    return snapValue(spec.min + span * Math.pow(tRaw, spec.power), spec.step);
  };
  const toPos = (val: number): number => {
    if (linear) return clamp(val, spec.min, spec.max);
    const ratio = span === 0 ? 0 : clamp((val - spec.min) / span, 0, 1);
    return Math.round(Math.pow(ratio, 1 / spec.power) * CURVE_RESOLUTION);
  };

  const row = parent.createDiv({ cls: `fc-slider${compact ? ' is-compact' : ''}` });
  row.createEl('label', { text: spec.label, cls: 'fc-label' });

  const wrap = row.createDiv({ cls: 'fc-range-wrap' });
  const range = wrap.createEl('input', {
    type: 'range',
    attr: linear
      ? { min: String(spec.min), max: String(spec.max), step: String(spec.step) }
      : { min: '0', max: String(CURVE_RESOLUTION), step: '1' },
  });
  range.addClass('fc-range');
  const num = wrap.createEl('input', {
    type: 'number',
    cls: 'fc-num',
    attr: { min: String(spec.min), max: String(spec.max), step: String(spec.step) },
  });
  wrap.createSpan({ cls: 'fc-unit', text: spec.unit });

  const listeners: (() => void)[] = [];
  let current = clamp(spec.value, spec.min, spec.max);

  const paint = (): void => {
    const pos = toPos(current);
    const pct = linear
      ? span === 0 ? 0 : ((pos - spec.min) / span) * 100
      : (pos / CURVE_RESOLUTION) * 100;
    range.style.setProperty('--fc-pos', `${pct.toFixed(2)}%`);
  };

  const sync = (val: number, silent = false): void => {
    current = clamp(val, spec.min, spec.max);
    range.value = String(toPos(current));
    // 只有在输入框不处于编辑焦点时才回写，避免打断手动输入
    if (document.activeElement !== num) num.value = String(round2(current));
    paint();
    if (!silent) listeners.forEach((cb) => cb());
  };

  range.addEventListener('input', () => sync(toValue(parseFloat(range.value))));
  num.addEventListener('change', () => {
    const v = parseFloat(num.value);
    sync(Number.isFinite(v) ? v : spec.value);
    num.value = String(round2(current));
  });

  sync(current, true);

  return {
    get value() { return current; },
    setValue: (val: number, silent = false) => sync(val, silent),
    onChange: (cb: () => void) => { listeners.push(cb); },
  };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ─── 生命周期双线图（净资产水位 + 现金流余量 + 自由里程碑） ──────

/** 图表事件标记：生命周期图「关键事件」层的渲染载体。
 *
 * 与引擎的 LifeEvent（fiCalc.ts，只关心财务影响 atAge/delta*）职责分离——
 * 本类型只关心「画在哪、显示什么、点了去哪」。用户配置的 LifeEventDef 会同时
 * 转成这两者：一份喂给引擎算曲线，一份喂给本层画标记。
 *
 * type 决定配色；'retire' 为内建退休标记（非用户事件，不可编辑）。
 * note 为 Obsidian 笔记路径，点击即打开。 */
export interface ChartEvent {
  id: string;
  type: 'retire' | LifeEventType;
  label: string;
  age: number;
  year?: number;
  note?: string;
}

// ─── 三层生命周期图（净资产曲线 / 现金流柱状 / 关键事件） ──────
// 三层共用同一 x 轴（年龄）；事件竖线贯穿三层；现金流层以零分位线分正负（绿/红）。

function renderLifeCycle(
  parent: HTMLElement,
  proj: LifeProjection,
  symbol: string,
  events: ChartEvent[] = [],
  onEventClick?: (ev: ChartEvent) => void,
  historical: HistoricalPoint[] | null = null,
  chartStartAge?: number,
): void {
  parent.empty();
  const pts = proj.points;
  if (pts.length < 2) return;
  const simStartAge = pts[0].age; // 当前年龄（模拟起点）
  const simEndAge = pts[pts.length - 1].age;

  // 合并数据集：历史段 + 模拟段
  interface MergedPoint { age: number; netWorth: number; safeCashflow: number | null; isHistorical: boolean; }
  const merged: MergedPoint[] = [];
  if (historical && historical.length > 0) {
    for (const h of historical) {
      merged.push({ age: h.age, netWorth: h.netWorth, safeCashflow: null, isHistorical: true });
    }
  }
  for (const p of pts) {
    merged.push({ age: p.age, netWorth: p.netWorth, safeCashflow: p.safeCashflow, isHistorical: false });
  }

  const startAge = merged[0].age;
  const endAge = merged[merged.length - 1].age;
  const nTotal = merged.length;
  const hasHistory = historical && historical.length > 0;

  const W = 680;
  const PAD_L = 14;
  const PAD_R = 14;
  const innerW = W - PAD_L - PAD_R;
  const netTop = 16, netBottom = 120;
  const cfTop = 140, cfBottom = 252, zeroY = 196, half = 56;
  const evTop = 266, evBottom = 300, axisY = 299, diamondY = 283;
  const H = 344;

  const allNet = merged.map((p) => p.netWorth);
  // 净资产可以为负（房贷期「资不抵债」是常态），故 y 轴下界随数据走：
  // 有负值时给下方留 8% 余量并画零基线；全为正时下界=0，零线即底边（与旧版视觉一致）。
  const rawMinNet = Math.min(...allNet, 0);
  const maxNet = Math.max(Math.max(...allNet, 0) * 1.08, 1);
  const minNet = rawMinNet < 0 ? rawMinNet * 1.08 : 0;
  const netSpan = maxNet - minNet;
  const allFlow = merged.filter((p) => p.safeCashflow != null).map((p) => Math.abs(p.safeCashflow!));
  const maxFlow = Math.max(...allFlow, 1) * 1.15;
  const px = (i: number): number => PAD_L + (innerW * i) / (nTotal - 1);
  const pyNet = (v: number): number =>
    netTop + ((netBottom - netTop) * (maxNet - Math.min(Math.max(v, minNet), maxNet))) / netSpan;
  const netZeroY = pyNet(0);
  const pyFlow = (v: number): number => zeroY - (v / maxFlow) * half;

  const wrap = parent.createDiv({ cls: 'fc-lc3' });
  const labels = wrap.createDiv({ cls: 'fc-layer-labels' });
  labels.createSpan({ cls: 'fc-layer-label', text: t('ficalc.lifecycle.layerNet') });
  labels.createSpan({ cls: 'fc-layer-label', text: t('ficalc.lifecycle.layerFlow') });
  labels.createSpan({ cls: 'fc-layer-label', text: t('ficalc.lifecycle.layerEvent') });
  const chartArea = wrap.createDiv({ cls: 'fc-lc-chart' });

  const readout = chartArea.createDiv({ cls: 'fc-chart-readout' });
  readout.textContent = proj.fiAge != null
    ? t('ficalc.lifecycle.fi', { age: String(proj.fiAge) })
    : t('ficalc.lifecycle.noFi');

  const legend = chartArea.createDiv({ cls: 'fc-legend' });
  const mkItem = (dotCls: string, txt: string): void => {
    const item = legend.createDiv({ cls: 'fc-legend-item' });
    item.createSpan({ cls: `fc-legend-dot ${dotCls}` });
    item.createSpan({ text: txt });
  };
  if (hasHistory) mkItem('hist', t('ficalc.lifecycle.legendHist'));
  mkItem('net', t('ficalc.lifecycle.legendNet'));
  mkItem('pos', t('ficalc.lifecycle.legendFlow'));
  mkItem('neg', t('ficalc.lifecycle.legendNeg'));
  mkItem('event', t('ficalc.lifecycle.legendEvent'));

  const svg = svgEl(chartArea, 'svg', {
    viewBox: `0 0 ${W} ${H}`,
    width: '100%',
    role: 'img',
    'aria-label': t('ficalc.lifecycle.aria'),
    class: 'fc-lifecycle-svg',
  });

  // 现金流正负底色（仅模拟段有现金流数据，故底色也仅在模拟区）
  const simStartIdx = hasHistory ? historical!.length : 0;
  const simEndIdx = nTotal - 1;
  const simLeft = px(simStartIdx), simRight = px(simEndIdx);
  svgEl(svg, 'rect', { x: simLeft, y: cfTop, width: simRight - simLeft, height: zeroY - cfTop, class: 'fc-cf-pos-zone' });
  svgEl(svg, 'rect', { x: simLeft, y: zeroY, width: simRight - simLeft, height: cfBottom - zeroY, class: 'fc-cf-neg-zone' });

  // 净资产：历史段用实色柱，模拟段用面积+曲线
  const barW = Math.max(2.5, (innerW / nTotal) * 0.55);
  for (let i = 0; i < nTotal; i++) {
    const m = merged[i];
    if (!m.isHistorical) continue;
    const x = (px(i) - barW / 2).toFixed(1);
    const y = pyNet(m.netWorth);
    // 负净资产从零基线向下长（红柱），正的向上长
    const top = Math.min(y, netZeroY);
    const h = Math.max(Math.abs(netZeroY - y), 0.8);
    svgEl(svg, 'rect', {
      x,
      y: top.toFixed(1),
      width: barW.toFixed(1),
      height: h.toFixed(1),
      class: m.netWorth < 0 ? 'fc-hist-bar is-neg' : 'fc-hist-bar',
    });
  }
  // 净资产零基线（仅在存在负净资产时才画，否则零线与底边重合、画了是噪声）
  if (rawMinNet < 0) {
    svgEl(svg, 'line', { x1: PAD_L, y1: netZeroY, x2: W - PAD_R, y2: netZeroY, class: 'fc-net-zero-line' });
    svgEl(svg, 'text', { x: W - PAD_R, y: netZeroY - 3, 'text-anchor': 'end', class: 'fc-tick' }).textContent = '0';
  }
  // 模拟段净资产面积+曲线（从 simStartAge 到 endAge）
  const simPts = merged.slice(simStartIdx);
  const netLine = simPts.map((p, i) => `${px(simStartIdx + i).toFixed(1)},${pyNet(p.netWorth).toFixed(1)}`).join(' ');
  svgEl(svg, 'polygon', {
    points: `${netLine} ${px(simEndIdx).toFixed(1)},${netZeroY.toFixed(1)} ${px(simStartIdx).toFixed(1)},${netZeroY.toFixed(1)}`,
    class: 'fc-net-area',
  });
  svgEl(svg, 'polyline', { points: netLine, fill: 'none', class: 'fc-net' });

  // 现金流柱状（仅模拟段）
  for (let i = simStartIdx; i < nTotal; i++) {
    const v = merged[i].safeCashflow;
    if (v == null) continue;
    const x = (px(i) - barW / 2).toFixed(1);
    if (v >= 0) {
      const y = pyFlow(v);
      svgEl(svg, 'rect', { x, y: y.toFixed(1), width: barW.toFixed(1), height: (zeroY - y).toFixed(1), class: 'fc-bar-pos' });
    } else {
      const y = pyFlow(v);
      svgEl(svg, 'rect', { x, y: zeroY, width: barW.toFixed(1), height: (y - zeroY).toFixed(1), class: 'fc-bar-neg' });
    }
  }
  // 零分位线
  svgEl(svg, 'line', { x1: simLeft, y1: zeroY, x2: simRight, y2: zeroY, class: 'fc-zero-line' });
  svgEl(svg, 'text', { x: W - PAD_R, y: zeroY - 4, 'text-anchor': 'end', class: 'fc-tick' }).textContent = t('ficalc.lifecycle.zeroLine');

  // 退休竖线（模拟段里的退休年龄下标）
  const retireAgeAbs = proj.points[proj.retireIndex]?.age ?? proj.points[0].age;
  const retireIdx = merged.findIndex((p) => !p.isHistorical && p.age >= retireAgeAbs);
  if (retireIdx >= 0) {
    const rx2 = px(retireIdx);
    svgEl(svg, 'line', { x1: rx2, y1: netTop, x2: rx2, y2: evBottom, class: 'fc-retire-line' });
  }
  // 自由里程碑竖线
  if (proj.fiAge != null) {
    const fiIdx = merged.findIndex((p) => !p.isHistorical && p.age >= proj.fiAge!);
    if (fiIdx >= 0) {
      const fi = px(fiIdx);
      svgEl(svg, 'line', { x1: fi, y1: netTop, x2: fi, y2: evBottom, class: 'fc-fi-line' });
      svgEl(svg, 'text', { x: fi, y: netTop - 2, 'text-anchor': 'middle', class: 'fc-tick' }).textContent =
        t('ficalc.lifecycle.fi', { age: String(proj.fiAge) });
    }
  }

  // 「当前」竖线：标记模拟起点（历史与模拟的分界线）
  if (hasHistory) {
    const curX = px(simStartIdx);
    svgEl(svg, 'line', { x1: curX, y1: netTop, x2: curX, y2: evBottom, class: 'fc-now-line' });
    svgEl(svg, 'text', { x: curX, y: netTop - 2, 'text-anchor': 'middle', class: 'fc-tick', fill: 'var(--text-muted)' })
      .textContent = t('ficalc.lifecycle.now');
  }

  // 关键事件层
  svgEl(svg, 'line', { x1: PAD_L, y1: axisY, x2: W - PAD_R, y2: axisY, class: 'fc-event-axis' });
  let lastUpX = -Infinity, lastDownX = -Infinity;
  let upTier = 0, downTier = 0;
  const MIN_GAP = 46;
  for (const e of events) {
    const aIdx = merged.findIndex((p) => p.age >= e.age);
    if (aIdx < 0) continue;
    const ex = px(aIdx);
    const upDist = lastUpX === -Infinity ? Infinity : ex - lastUpX;
    const downDist = lastDownX === -Infinity ? Infinity : ex - lastDownX;
    const side: 'up' | 'down' = upDist >= downDist ? 'up' : 'down';
    let tier = 0;
    if (side === 'up') {
      if (upTier < 1 && ex - lastUpX < MIN_GAP) { upTier++; tier = upTier; } else { upTier = 0; tier = 0; }
      lastUpX = ex;
    } else {
      if (downTier < 3 && ex - lastDownX < MIN_GAP) { downTier++; tier = downTier; } else { downTier = 0; tier = 0; }
      lastDownX = ex;
    }
    const labelY = side === 'up' ? evTop - 3 - tier * 12 : evBottom + 13 + tier * 12;
    const g = svgEl(svg, 'g', {
      class: 'fc-event',
      'data-event-id': e.id,
      'data-event-type': e.type,
      'data-event-year': e.year ?? '',
      'data-event-note': e.note ?? '',
    });
    svgEl(g, 'rect', { x: ex - 7, y: netTop, width: 14, height: evBottom - netTop + 16, class: 'fc-event-hit' });
    svgEl(g, 'line', { x1: ex, y1: netTop, x2: ex, y2: evBottom, class: 'fc-event-line' });
    svgEl(g, 'rect', { x: ex - 4, y: diamondY - 4, width: 8, height: 8, transform: `rotate(45 ${ex} ${diamondY})`, class: 'fc-diamond' });
    svgEl(g, 'line', { x1: ex, y1: diamondY, x2: ex, y2: labelY, class: 'fc-event-leader' });
    const txt = svgEl(g, 'text', { x: ex, y: labelY, 'text-anchor': 'middle', class: 'fc-event-label' });
    txt.textContent = `${e.label}${e.year != null ? ' ' + e.year : ''}${e.note ? ' ' + t('ficalc.lifecycle.eventNote') : ''}`;
    const tip = e.note ? t('ficalc.lifecycle.eventTipNote') : t('ficalc.lifecycle.eventTipEdit');
    svgEl(g, 'title', {}).textContent = `${e.label} · ${e.age}${t('ficalc.unit.year')}\n${tip}`;
    if (onEventClick) g.addEventListener('click', () => onEventClick(e));
    g.style.cursor = 'pointer';
  }

  // x 轴刻度
  const xTicks: { idx: number; label: string }[] = [];
  xTicks.push({ idx: 0, label: hasHistory ? String(startAge) : t('ficalc.lifecycle.start') });
  if (hasHistory) {
    xTicks.push({ idx: simStartIdx, label: t('ficalc.lifecycle.nowShort') });
  }
  // 退休下标
  const retLabelIdx = merged.findIndex((p) => !p.isHistorical && p.age >= retireAgeAbs);
  if (retLabelIdx >= 0 && retLabelIdx !== 0 && retLabelIdx !== simStartIdx) {
    xTicks.push({ idx: retLabelIdx, label: t('ficalc.lifecycle.retire') });
  }
  xTicks.push({ idx: nTotal - 1, label: String(endAge) });

  // 去重（同一下标只画一次）
  const seenIdx = new Set<number>();
  for (const t of xTicks) {
    if (seenIdx.has(t.idx)) continue;
    seenIdx.add(t.idx);
    const anchor = t.idx === 0 ? 'start' : t.idx === nTotal - 1 ? 'end' : 'middle';
    const x = t.idx === 0 ? PAD_L : t.idx === nTotal - 1 ? W - PAD_R : px(t.idx);
    svgEl(svg, 'text', { x, y: H - 6, 'text-anchor': anchor, class: 'fc-tick' }).textContent = t.label;
  }
  svgEl(svg, 'text', { x: PAD_L, y: netTop + 4, class: 'fc-tick' }).textContent = fmtMoney(maxNet, symbol);

  // 悬停游标（跨全 x 轴）
  const guide = svgEl(svg, 'line', { x1: 0, y1: netTop, x2: 0, y2: evBottom, class: 'fc-guide', opacity: 0 });
  const dotNet = svgEl(svg, 'circle', { cx: 0, cy: 0, r: 3, class: 'fc-dot-net', opacity: 0 });
  const dotFlow = svgEl(svg, 'circle', { cx: 0, cy: 0, r: 3, class: 'fc-dot-flow', opacity: 0 });
  svgEl(svg, 'rect', { x: 0, y: 0, width: W, height: H, fill: 'transparent', class: 'fc-hit' });
  svg.addEventListener('mousemove', (ev: MouseEvent) => {
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return;
    const vbX = ((ev.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(nTotal - 1, Math.round(((vbX - PAD_L) / innerW) * (nTotal - 1))));
    const pt = merged[i];
    guide.setAttribute('x1', String(px(i)));
    guide.setAttribute('x2', String(px(i)));
    guide.setAttribute('opacity', '1');
    dotNet.setAttribute('cx', String(px(i)));
    dotNet.setAttribute('cy', String(pyNet(pt.netWorth)));
    dotNet.setAttribute('opacity', '1');
    if (pt.safeCashflow != null) {
      dotFlow.setAttribute('cx', String(px(i)));
      dotFlow.setAttribute('cy', String(pyFlow(pt.safeCashflow)));
      dotFlow.setAttribute('opacity', '1');
    } else {
      dotFlow.setAttribute('opacity', '0');
    }
    readout.textContent = pt.safeCashflow != null
      ? t('ficalc.lifecycle.readout', {
          age: String(pt.age),
          net: fmtMoney(pt.netWorth, symbol),
          flow: fmtMoney(pt.safeCashflow, symbol),
        })
      : t('ficalc.lifecycle.readoutHist', {
          age: String(pt.age),
          net: fmtMoney(pt.netWorth, symbol),
        });
  });
  svg.addEventListener('mouseleave', () => {
    guide.setAttribute('opacity', '0');
    dotNet.setAttribute('opacity', '0');
    dotFlow.setAttribute('opacity', '0');
    readout.textContent = proj.fiAge != null
      ? t('ficalc.lifecycle.fi', { age: String(proj.fiAge) })
      : t('ficalc.lifecycle.noFi');
  });
}
