/*
 * fiCalc.ts —— 财务自由目标计算引擎（纯函数，不依赖 vault / 账本数据）
 * 单位约定：本金 P、年花费 S 均以整数"分"传入；利率 r 为小数（如 0.04 表示 4%）。
 * 公式来源：《已确定设计点》§3 finance-ficalc。
 *
 * 衍生设计 useActualSpend（M3+）：当勾选时 S 由记账流水派生的"近 12 个月实际年花费"代入，
 * 本引擎只负责计算，数据来源由调用方决定。
 */

// 是否已财务自由：当年花费不超过被动收益（S <= P·r）时，钱永远花不完
export function isFinanciallyFree(principal: number, rate: number, spend: number): boolean {
  return spend <= principal * rate;
}

// 所需本金：P* = S / r（r<=0 时无意义，返回 Infinity）
export function requiredPrincipal(spend: number, rate: number): number {
  if (rate <= 0) return Infinity;
  return spend / rate;
}

// 本金缺口：所需本金 - 现有本金（已自由则为负）
export function principalGap(principal: number, rate: number, spend: number): number {
  return requiredPrincipal(spend, rate) - principal;
}

// 当前本金能撑多少年：未达标时 n = ln(S/(S-P·r)) / ln(1+r)；已自由返回 Infinity
export function yearsToDeplete(principal: number, rate: number, spend: number): number {
  if (rate <= 0) return Infinity;
  if (isFinanciallyFree(principal, rate, spend)) return Infinity;
  const denom = spend - principal * rate;
  return Math.log(spend / denom) / Math.log(1 + rate);
}

// 当前可持续年花费上限：S* = P · r
export function maxAnnualSpend(principal: number, rate: number): number {
  return principal * rate;
}

// ─── useActualSpend（M3：近 12 个月实际年花费） ────────────────

/**
 * 从交易流水中计算近 N 个月的实际年化花费。
 *
 * @param monthlyExpenses 各月支出总额 Map<YYYY-MM, cents>
 * @param months 回溯月数（默认 12）
 * @returns { annualized, monthsAvailable, sufficient } 年化花费 + 可用月数 + 数据是否充足
 */
export function calculateActualSpend(
  monthlyExpenses: Map<string, number>,
  months: number = 12,
): { annualized: number; monthsAvailable: number; sufficient: boolean } {
  // 按日期倒序取最近 N 个月
  const sorted = Array.from(monthlyExpenses.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, months);

  const monthsAvailable = sorted.length;
  const totalExpense = sorted.reduce((sum, [, amount]) => sum + amount, 0);

  // 数据不足 12 个月时按比例年化
  if (monthsAvailable === 0) {
    return { annualized: 0, monthsAvailable: 0, sufficient: false };
  }

  const monthlyAvg = totalExpense / monthsAvailable;
  const annualized = Math.round(monthlyAvg * 12);

  return {
    annualized,
    monthsAvailable,
    sufficient: monthsAvailable >= 12,
  };
}

// ─── yearsToFI（M3：按当前储蓄速度预计几年达成 FI） ────────────

/**
 * 计算按当前净储蓄速度，需要多少年达到财务自由目标本金。
 *
 * @param currentPrincipal 当前本金（分）
 * @param targetPrincipal 目标本金（分）= S/r
 * @param annualSavings 年净储蓄额（分）= 年收入 - 年花费
 * @param rate 年利率（小数）
 * @returns 预计达成年数（已达成返回 0，无法达成返回 Infinity）
 */
export function yearsToFI(
  currentPrincipal: number,
  targetPrincipal: number,
  annualSavings: number,
  rate: number,
): number {
  if (currentPrincipal >= targetPrincipal) return 0;
  if (annualSavings <= 0 && rate <= 0) return Infinity;

  // 简化模型：每年末本金 = 上年 × (1+r) + savings
  // 求解 n 使得 P₀(1+r)^n + S·((1+r)^n - 1)/r >= target
  // → (P₀ + S/r)(1+r)^n >= target + S/r
  // → n >= ln((target + S/r) / (P₀ + S/r)) / ln(1+r)
  if (rate > 0) {
    const sr = annualSavings / rate;
    const numerator = targetPrincipal + sr;
    const denominator = currentPrincipal + sr;
    if (denominator <= 0) return Infinity;
    return Math.log(numerator / denominator) / Math.log(1 + rate);
  }

  // rate = 0 时退化为简单除法
  return (targetPrincipal - currentPrincipal) / annualSavings;
}

// ─── 退休推演（ficalc.app 口径：全部按「实际购买力」计价） ──────
//
// 与上面那组"永续"公式的区别：永续公式只回答"钱够不够永远花"，
// 退休推演回答"在给定年限内，钱撑不撑得住、期末剩多少"。前者是极限，
// 后者才是 ficalc.app 真正在算的东西（有限年限 + 提取策略 + 波动）。
//
// 计价口径：所有金额都是"今天的购买力"。名义收益率经 realRate 折成实际收益率后，
// 年花费就不必逐年乘通胀系数——这与 ficalc.app 的 "all values are inflation adjusted" 一致。

/** 提取策略：恒定金额 / 固定比例 / 95% 法则 */
export type WithdrawalStrategy = 'fixed' | 'percent' | 'rule95';

export interface PlanInput {
  principal: number; // 起始本金（分）
  annualSpend: number; // 首年花费（分，实际购买力）
  nominalRate: number; // 名义年化收益率（小数）
  inflation: number; // 年通胀率（小数）
  years: number; // 推演年限
  strategy: WithdrawalStrategy;
}

export interface YearRow {
  year: number; // 第几年（1 起）
  start: number; // 年初本金
  withdrawal: number; // 当年实际支取
  growth: number; // 支取后本金的当年收益
  end: number; // 年末本金
}

export interface ProjectionResult {
  rows: YearRow[];
  success: boolean; // 全程未断供且期末为正
  depletedYear: number | null; // 首次断供/归零的年份
  smallSpend: boolean; // 是否出现过支取额低于首年目标 50%（ficalc 的 Small Spending）
  totalWithdrawn: number;
}

/** 实际收益率：(1+名义)/(1+通胀) - 1 */
export function realRate(nominal: number, inflation: number): number {
  return (1 + nominal) / (1 + inflation) - 1;
}

/**
 * 逐年推演投资组合。
 *
 * 顺序：年初支取 → 剩余部分产生当年收益 → 得到年末余额（与 ficalc.app 一致）。
 * @param returns 可选的逐年实际收益率序列（蒙特卡洛用）；缺省时全程使用 realRate。
 */
export function projectPortfolio(plan: PlanInput, returns?: number[]): ProjectionResult {
  const years = Math.max(1, Math.floor(plan.years));
  const fallbackRate = realRate(plan.nominalRate, plan.inflation);
  // 固定比例/95% 法则的基准提取率，取首年 花费/本金
  const pct = plan.principal > 0 ? plan.annualSpend / plan.principal : 0;
  const smallThreshold = plan.annualSpend * 0.5;

  const rows: YearRow[] = [];
  let portfolio = plan.principal;
  let lastWithdrawal = plan.annualSpend;
  let depletedYear: number | null = null;
  let smallSpend = false;
  let totalWithdrawn = 0;

  for (let y = 1; y <= years; y++) {
    const start = portfolio;

    let want: number;
    if (plan.strategy === 'percent') want = start * pct;
    else if (plan.strategy === 'rule95') want = Math.max(start * pct, lastWithdrawal * 0.95);
    else want = plan.annualSpend;
    if (want < 0 || !Number.isFinite(want)) want = 0;

    // 取不满即视为断供（恒定金额策略下才可能发生）
    const withdrawal = Math.min(want, Math.max(0, start));
    if (depletedYear === null && withdrawal < want - 1) depletedYear = y;
    if (withdrawal < smallThreshold) smallSpend = true;

    const afterWithdraw = start - withdrawal;
    const r = returns?.[y - 1] ?? fallbackRate;
    const growth = afterWithdraw * r;
    const end = Math.max(0, afterWithdraw + growth);

    rows.push({ year: y, start, withdrawal, growth, end });
    totalWithdrawn += withdrawal;
    if (withdrawal > 0) lastWithdrawal = withdrawal;
    portfolio = end;
    if (depletedYear === null && portfolio <= 0) depletedYear = y;
  }

  return { rows, success: depletedYear === null, depletedYear, smallSpend, totalWithdrawn };
}

/**
 * 定期年金支取额：本金在 years 年内恰好花完（die-with-zero）时的年支取上限。
 * S = P·r / (1 - (1+r)^-n)；r≈0 时退化为 P/n。
 */
export function annuitySpend(principal: number, rate: number, years: number): number {
  if (years <= 0) return 0;
  if (Math.abs(rate) < 1e-9) return principal / years;
  if (rate <= -1) return 0;
  return (principal * rate) / (1 - Math.pow(1 + rate, -years));
}

// ─── 蒙特卡洛：给"成功率"一个可复现的数 ────────────────────────

/** mulberry32：32 位种子 PRNG。种子化是刻意的——同样的参数必须给出同样的成功率，否则每次重渲染数字都在跳，看起来像 bug。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller：均匀分布 → 标准正态 */
function gaussian(rnd: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface SimulationResult {
  runs: number;
  successRate: number; // 0~1，全程未断供的比例
  smallSpendRate: number; // 0~1，出现过支取腰斩的比例
  /** 分位路径，长度 years+1，下标 0 为起点 */
  p10: number[];
  p50: number[];
  p90: number[];
  endMedian: number;
  endBest: number;
  endWorst: number;
  zeroCount: number;
}

/**
 * 蒙特卡洛退休模拟：实际收益率按 N(realRate, volatility) 抽样。
 *
 * @param volatility 年化波动率（小数，如 0.12）。为 0 时退化为确定性推演，成功率非 0 即 1。
 * @param runs 模拟次数（默认 400，量级足够且单帧内可算完）
 * @param seed 随机种子（默认固定值，保证结果可复现）
 */
export function simulateRetirement(
  plan: PlanInput,
  volatility: number,
  runs = 400,
  seed = 20260731,
): SimulationResult {
  const years = Math.max(1, Math.floor(plan.years));
  const baseRate = realRate(plan.nominalRate, plan.inflation);
  const vol = Math.max(0, volatility);
  const effectiveRuns = vol === 0 ? 1 : Math.max(1, runs);

  const rnd = mulberry32(seed);
  // paths[y] = 各次模拟在第 y 年末的余额（y=0 为起点）
  const paths: number[][] = Array.from({ length: years + 1 }, () => [] as number[]);
  let successes = 0;
  let smallSpends = 0;
  let zeroCount = 0;
  const endValues: number[] = [];

  for (let i = 0; i < effectiveRuns; i++) {
    let returns: number[] | undefined;
    if (vol > 0) {
      returns = new Array(years);
      for (let y = 0; y < years; y++) {
        // 收益率下限 -95%：允许极端熊市，但不允许"资产变负"这种非物理结果
        returns[y] = Math.max(-0.95, baseRate + vol * gaussian(rnd));
      }
    }
    const res = projectPortfolio({ ...plan, years }, returns);
    if (res.success) successes++;
    if (res.smallSpend) smallSpends++;

    paths[0].push(plan.principal);
    for (let y = 1; y <= years; y++) paths[y].push(res.rows[y - 1].end);

    const endValue = res.rows[years - 1].end;
    endValues.push(endValue);
    if (endValue <= 0) zeroCount++;
  }

  // 每年只排一次序，再取三个分位——否则每年 3 次排序，拖满滑动条会掉帧
  const quantile = (sorted: number[], q: number): number => {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
    return sorted[idx];
  };

  const p10: number[] = [];
  const p50: number[] = [];
  const p90: number[] = [];
  for (const yearValues of paths) {
    yearValues.sort((a, b) => a - b);
    p10.push(quantile(yearValues, 0.1));
    p50.push(quantile(yearValues, 0.5));
    p90.push(quantile(yearValues, 0.9));
  }

  endValues.sort((a, b) => a - b);

  return {
    runs: effectiveRuns,
    successRate: successes / effectiveRuns,
    smallSpendRate: smallSpends / effectiveRuns,
    p10,
    p50,
    p90,
    endMedian: quantile(endValues, 0.5),
    endBest: endValues[endValues.length - 1] ?? 0,
    endWorst: endValues[0] ?? 0,
    zeroCount,
  };
}

// ─── 折旧计算（M3：直线法） ────────────────────────────────────

/**
 * 直线法折旧：计算当前公允值
 *
 * @param purchasePrice 购买价（分）
 * @param purchaseDate 购买日期 YYYY-MM-DD
 * @param usefulLifeYears 预计使用年限
 * @param referenceDate 参考日期（默认今天）
 * @param salvageValue 残值（分），缺省 0；折旧后最低不低于此值
 * @returns 当前公允值（分），最低为残值
 */
export function currentValue(
  purchasePrice: number,
  purchaseDate: string,
  usefulLifeYears: number,
  referenceDate?: Date,
  salvageValue?: number,
): number {
  const salvage = salvageValue ?? 0;
  const depreciable = purchasePrice - salvage;
  if (depreciable <= 0) return purchasePrice; // 残值 >= 购价，不折旧

  const ref = referenceDate ?? new Date();
  const purchase = new Date(purchaseDate);
  const yearsHeld = (ref.getTime() - purchase.getTime()) / (365.25 * 24 * 3600 * 1000);

  if (yearsHeld <= 0) return purchasePrice;
  if (yearsHeld >= usefulLifeYears) return salvage;

  const annualDepreciation = depreciable / usefulLifeYears;
  return Math.max(salvage, Math.round(purchasePrice - annualDepreciation * yearsHeld));
}

// ─── 生命周期现金流投影（阶段一：积累期 + 支取期完整曲线） ──────
//
// 与 projectPortfolio 的区别：projectPortfolio 只算「退休后」一段；
// projectLifeCashflow 把「积累期（工作→退休）」与「支取期（退休→终）」合成一条
// 完整生命周期曲线，并输出两条线：
//   - netWorth：净资产水位（全程实际购买力计价，与 projectPortfolio 口径一致）
//   - safeCashflow：可持续现金流余量 = 当年被动收入 − 当年生活支出
//     自由里程碑 = 余量首次持续 ≥ 0 的年龄（被动收入覆盖支出，钱永远花不完）。
//
// 计价口径：与 ficalc.app 一致，全部按「实际购买力」（realRate 折后），不逐年乘通胀。

/** 人生事件（阶段三接入；阶段一 events 可省略，模型已预留） */
export interface LifeEvent {
  atAge: number; // 触发年龄
  oneOff?: number; // 当年一次性现金流（分，正=入账）
  deltaIncome?: number; // 年收支变化（分，影响积累期储蓄）
  deltaSpend?: number; // 年支出变化（分，实际购买力）
  deltaPrincipal?: number; // 一次性改变生息本金（分）
  deltaFixed?: number; // 改变非生息资产（分）
  deltaLiability?: number; // 改变负债（分）
  rateShift?: number; // 从该年起切换名义收益率（小数）
}

export interface LifePlanInput {
  currentAge: number; // 当前年龄
  retireAge: number; // 退休年龄
  endAge: number; // 模拟终止年龄（含）
  principal: number; // 起始本金（分，生息本金总额 = growth + cash）
  annualSavings: number; // 首年净储蓄（分，实际购买力）
  incomeGrowth: number; // 储蓄年增长率（小数，积累期）
  nominalRate: number; // 名义年化收益率（小数）
  inflation: number; // 年通胀率（小数）
  retireSpend: number; // 退休首年生活支出（分，实际购买力）
  strategy: WithdrawalStrategy;
  events?: LifeEvent[]; // 人生事件（阶段三）
  // ── 阶段二：资产分桶细化（均可选，缺省下行为与阶段一完全一致） ──
  cashRate?: number; // 现金类资产年化收益率（小数），缺省 = nominalRate
  cashPrincipal?: number; // 现金桶本金（分，按 cashRate 增长），缺省 0
  nonInterestAssets?: number; // 非生息资产市值（分，进净资产线、不供养退休），缺省 0
  liabilities?: number; // 负债市值（分，抵减净资产），缺省 0
}

export interface LifeYearPoint {
  age: number;
  year: number; // 绝对年
  netWorth: number; // 净资产水位（分，实际购买力）
  passiveIncome: number; // 当年被动收入（分，实际购买力）
  safeCashflow: number; // 可持续现金流余量（分）= 被动收入 − 支出
  free: boolean; // 余量持续 ≥ 0 之后为 true
}

export interface LifeProjection {
  points: LifeYearPoint[];
  fiAge: number | null; // 财务自由里程碑年龄
  fiYear: number | null; // 对应绝对年
  retireIndex: number; // 退休在 points 中的下标
}

/**
 * 投影完整生命周期的净资产水位线与现金流余量线。
 *
 * 积累期（currentAge ≤ age < retireAge）：nw 按实际收益率复利 + 年净储蓄（随 incomeGrowth 增长）。
 * 支取期（age ≥ retireAge）：沿用 projectPortfolio 的单年确定性逻辑（按 strategy 支取）。
 * 事件在对应年龄生效（阶段三；阶段一无事件）。
 */
export function projectLifeCashflow(input: LifePlanInput): LifeProjection {
  const rr = realRate(input.nominalRate, input.inflation);
  const currentYear = new Date().getFullYear();
  const totalYears = Math.max(0, input.endAge - input.currentAge);

  const eventsByAge = new Map<number, LifeEvent[]>();
  for (const ev of input.events ?? []) {
    const arr = eventsByAge.get(ev.atAge) ?? [];
    arr.push(ev);
    eventsByAge.set(ev.atAge, arr);
  }

  const points: LifeYearPoint[] = [];
  const cashRate = input.cashRate ?? input.nominalRate;
  // 生息本金拆成 growth / cash 两段，分别按 rr / cashRate 复利
  let growthP = input.principal - (input.cashPrincipal ?? 0);
  let cashP = input.cashPrincipal ?? 0;
  if (growthP < 0) { cashP += growthP; growthP = 0; } // 安全：cashPrincipal 不得超过本金
  let nonInterest = input.nonInterestAssets ?? 0; // 非生息资产（进净资产线、不供养退休）
  let liabilities = input.liabilities ?? 0; // 负债（抵减净资产）
  let nw = growthP + cashP;
  let curSavings = input.annualSavings;
  let curSpend = input.retireSpend; // 实际购买力，退休期恒定（rr 计价）
  const pct = nw > 0 ? input.retireSpend / nw : 0;

  for (let i = 0; i <= totalYears; i++) {
    const age = input.currentAge + i;
    const year = currentYear + i;

    // 应用当年事件（阶段三；阶段一无）
    const evs = eventsByAge.get(age) ?? [];
    for (const ev of evs) {
      if (ev.deltaPrincipal) growthP += ev.deltaPrincipal; // 改生息本金（默认进 growth 桶）
      if (ev.deltaFixed) nonInterest += ev.deltaFixed;
      if (ev.deltaLiability) liabilities += ev.deltaLiability; // 负债增加
      if (ev.oneOff) growthP += ev.oneOff;
      if (ev.deltaSpend) curSpend += ev.deltaSpend;
      if (ev.deltaIncome) curSavings += ev.deltaIncome;
      if (ev.deltaSpend) curSavings -= ev.deltaSpend; // 支出增加 → 储蓄减少
    }
    nw = growthP + cashP;

    // 净资产水位 = 生息本金 + 非生息资产 − 负债；被动收入两段分别计息
    const passiveIncome = growthP * rr + cashP * cashRate;
    const safeCashflow = passiveIncome - curSpend;
    const netWorth = nw + nonInterest - liabilities;

    points.push({ age, year, netWorth, passiveIncome, safeCashflow, free: false });

    // 推进到下一年
    if (age < input.retireAge) {
      growthP = growthP * (1 + rr) + curSavings;
      cashP = cashP * (1 + cashRate);
      nw = growthP + cashP;
      curSavings = curSavings * (1 + input.incomeGrowth);
    } else {
      // 支取期：取 strategy 对应金额（实际购买力），按两桶比例分摊支取后各自计息
      let want: number;
      if (input.strategy === 'percent') want = nw * pct;
      else if (input.strategy === 'rule95') want = Math.max(nw * pct, curSpend * 0.95);
      else want = curSpend;
      if (want < 0 || !Number.isFinite(want)) want = 0;
      const withdrawal = Math.min(want, Math.max(0, nw));
      const wg = nw > 0 ? withdrawal * (growthP / nw) : 0;
      const wc = nw > 0 ? withdrawal * (cashP / nw) : 0;
      const ag = Math.max(0, growthP - wg);
      const ac = Math.max(0, cashP - wc);
      growthP = ag * (1 + rr);
      cashP = ac * (1 + cashRate);
      nw = growthP + cashP;
    }
  }

  // 自由里程碑：首个年龄起 safeCashflow 持续 ≥ 0
  let fiAge: number | null = null;
  for (let i = 0; i < points.length; i++) {
    if (points[i].safeCashflow >= 0) {
      let allFree = true;
      for (let j = i; j < points.length; j++) {
        if (points[j].safeCashflow < 0) { allFree = false; break; }
      }
      if (allFree) { fiAge = points[i].age; break; }
    }
  }

  return {
    points,
    fiAge,
    fiYear: fiAge !== null ? currentYear + (fiAge - input.currentAge) : null,
    retireIndex: Math.max(0, input.retireAge - input.currentAge),
  };
}
