// globals 模式（vitest.config.ts 中 globals:true），describe/it/expect 由 runner 注入，
// 避免 CJS 项目下 `import {describe,it,expect} from 'vitest'` 解析到不同实例导致 "No test suite found"。
import {
  isFinanciallyFree,
  requiredPrincipal,
  principalGap,
  yearsToDeplete,
  maxAnnualSpend,
  realRate,
  projectPortfolio,
  annuitySpend,
  simulateRetirement,
  projectLifeCashflow,
  type PlanInput,
} from './fiCalc';

// 单位：分。P=100万=100_000_00 分；r=4%=0.04；S=4万=4_000_00 分
const P = 100_000_00;
const r = 0.04;
const S = 4_000_00;

describe('fiCalc 财务自由引擎', () => {
  it('maxAnnualSpend = P·r', () => {
    expect(maxAnnualSpend(P, r)).toBe(4_000_00);
  });

  it('isFinanciallyFree: S <= P·r 时自由', () => {
    expect(isFinanciallyFree(P, r, S)).toBe(true);
    expect(isFinanciallyFree(P, r, S + 1)).toBe(false);
  });

  it('requiredPrincipal = S/r', () => {
    expect(requiredPrincipal(S, r)).toBe(100_000_00);
  });

  it('principalGap 已自由时为负', () => {
    // P=200万, r=4% → 被动收益 8万 > S=4万，已自由，缺口 = 所需本金(100万) - 现有(200万) = -100万 < 0
    expect(principalGap(200_000_00, r, S)).toBeLessThan(0);
  });

  it('yearsToDeplete 已自由时 Infinity', () => {
    expect(yearsToDeplete(P, r, S)).toBe(Infinity);
  });

  it('yearsToDeplete 未达标时有限正值', () => {
    // P=50万, r=4% → 被动收益 2万 < S=4万，未自由
    const n = yearsToDeplete(50_000_00, r, S);
    expect(n).toBeGreaterThan(0);
    expect(Number.isFinite(n)).toBe(true);
  });
});

// ─── 退休推演（重设计：finance-fi 并入 finance-ficalc 后新增能力） ──
// 单位：分。P=100万=100_000_00；S=4万=4_000_00；r=4%=0.04

function plan(over: Partial<PlanInput> = {}): PlanInput {
  return {
    principal: 100_000_00,
    annualSpend: 4_000_00,
    nominalRate: 0.04,
    inflation: 0,
    years: 30,
    strategy: 'fixed',
    ...over,
  };
}

describe('fiCalc 退休推演（重设计新增）', () => {
  it('realRate: 通胀调整后 = (1+nom)/(1+infl)-1', () => {
    expect(realRate(0.05, 0.02)).toBeCloseTo(0.02941, 4);
    expect(realRate(0.04, 0)).toBeCloseTo(0.04, 6);
    expect(realRate(0, 0)).toBe(0);
  });

  it('projectPortfolio: 固定金额策略返回 years 行，首行起点=本金，逐年提满 S', () => {
    const res = projectPortfolio(plan());
    expect(res.rows).toHaveLength(30);
    expect(res.rows[0].start).toBe(100_000_00);
    // 本金充裕（200万 → 被动收益 8万 > 4万花费），全程不熬断供
    expect(res.success).toBe(true);
    expect(res.depletedYear).toBeNull();
    // 每年固定提取 S，30 年共提 30·S（边界年本金仍充足）
    expect(res.totalWithdrawn).toBeCloseTo(4_000_00 * 30, 0);
  });

  it('projectPortfolio: 充裕组合不熬断供', () => {
    const res = projectPortfolio(plan({ principal: 200_000_00 }));
    expect(res.success).toBe(true);
    expect(res.depletedYear).toBeNull();
  });

  it('projectPortfolio: 花费远超被动收益 → 断供', () => {
    const res = projectPortfolio(plan({ principal: 10_000_00, annualSpend: 4_000_00 }));
    expect(res.success).toBe(false);
    expect(res.depletedYear).not.toBeNull();
  });

  it('projectPortfolio: 固定比例策略永不因取不满断供（pct<1）', () => {
    const res = projectPortfolio(plan({ strategy: 'percent' }));
    expect(res.success).toBe(true);
    expect(res.depletedYear).toBeNull();
  });

  it('projectPortfolio: 95% 法则同样不触发取不满断供', () => {
    const res = projectPortfolio(plan({ strategy: 'rule95' }));
    expect(res.success).toBe(true);
    expect(res.depletedYear).toBeNull();
  });

  it('annuitySpend: r≈0 退化为 P/n', () => {
    expect(annuitySpend(100_000_00, 0, 30)).toBeCloseTo(100_000_00 / 30, 0);
  });

  it('annuitySpend: 耗尽式年提取 > 永续年花费（会动用本金）', () => {
    const dieWithZero = annuitySpend(100_000_00, 0.04, 30);
    expect(dieWithZero).toBeGreaterThan(4_000_00); // 永续 S* = P·r = 4万
  });

  it('simulateRetirement: 无波动且明显充裕时确定性成功，成功率=1', () => {
    const sim = simulateRetirement(plan({ principal: 200_000_00 }), 0);
    expect(sim.runs).toBe(1);
    expect(sim.successRate).toBe(1);
  });

  it('simulateRetirement: 有波动时成功率∈[0,1]，分位路径长度=years+1，起点三档相等', () => {
    const sim = simulateRetirement(plan(), 0.12);
    expect(sim.runs).toBe(400);
    expect(sim.successRate).toBeGreaterThanOrEqual(0);
    expect(sim.successRate).toBeLessThanOrEqual(1);
    expect(sim.p50).toHaveLength(31);
    expect(sim.p10[0]).toBe(100_000_00);
    expect(sim.p50[0]).toBe(100_000_00);
    expect(sim.p90[0]).toBe(100_000_00);
  });

  it('simulateRetirement: 同参数同种子 → 结果可复现', () => {
    const a = simulateRetirement(plan(), 0.12, 200, 12345);
    const b = simulateRetirement(plan(), 0.12, 200, 12345);
    expect(a.successRate).toBe(b.successRate);
    expect(a.p50[a.p50.length - 1]).toBe(b.p50[b.p50.length - 1]);
    expect(a.endMedian).toBe(b.endMedian);
  });

  it('simulateRetirement: 每一年满足 P10 ≤ P50 ≤ P90', () => {
    const sim = simulateRetirement(plan(), 0.12);
    for (let y = 0; y < sim.p50.length; y++) {
      expect(sim.p10[y]).toBeLessThanOrEqual(sim.p50[y]);
      expect(sim.p50[y]).toBeLessThanOrEqual(sim.p90[y]);
    }
  });
});

// ─── 生命周期现金流投影（阶段一：积累期 + 支取期完整曲线） ──
// 单位：分。principal=100万=100_000_00；savings=10万=10_000_00；spend=4万=4_000_00

describe('projectLifeCashflow 生命周期投影', () => {
  const base = {
    currentAge: 30,
    retireAge: 60,
    endAge: 90,
    principal: 0,
    annualSavings: 10_000_00,
    incomeGrowth: 0,
    nominalRate: 0.04,
    inflation: 0.02,
    retireSpend: 4_000_00,
    strategy: 'fixed' as const,
  };

  it('points 数量 = endAge-currentAge+1，且积累期净资产逐年增长', () => {
    const proj = projectLifeCashflow(base);
    expect(proj.points).toHaveLength(61);
    for (let i = 1; i <= 30; i++) {
      expect(proj.points[i].netWorth).toBeGreaterThan(proj.points[i - 1].netWorth);
    }
    expect(proj.points[30].netWorth).toBeGreaterThan(0); // 退休时（age 60）已有积累
  });

  it('退休期高提取 → 净资产递减（提取远超被动收益）', () => {
    const proj = projectLifeCashflow({ ...base, retireSpend: 200_000_00 });
    // 退休期末（age 90）净资产低于退休初（age 60）
    expect(proj.points[60].netWorth).toBeLessThan(proj.points[30].netWorth);
  });

  it('收入增长使积累期末净资产更高', () => {
    const base0 = projectLifeCashflow(base);
    const grown = projectLifeCashflow({ ...base, incomeGrowth: 0.03 });
    expect(grown.points[30].netWorth).toBeGreaterThan(base0.points[30].netWorth);
  });

  it('储蓄充足 → 达成自由里程碑，且里程碑处余量持续 ≥ 0', () => {
    const proj = projectLifeCashflow({
      ...base,
      principal: 100_000_00,
      annualSavings: 10_000_00,
    });
    expect(proj.fiAge).not.toBeNull();
    const idx = proj.fiAge! - base.currentAge;
    expect(proj.points[idx].safeCashflow).toBeGreaterThanOrEqual(0);
    // 里程碑之后余量不再转负
    for (let j = idx; j < proj.points.length; j++) {
      expect(proj.points[j].safeCashflow).toBeGreaterThanOrEqual(0);
    }
  });

  it('rate=0 不崩溃，积累期仅靠储蓄线性累积', () => {
    const proj = projectLifeCashflow({
      ...base,
      nominalRate: 0,
      inflation: 0,
      retireSpend: 0,
      annualSavings: 10_000_00,
    });
    expect(proj.points).toHaveLength(61);
    expect(proj.points[30].netWorth).toBe(10_000_00 * 30);
  });

  it('当前已自由 → fiAge = currentAge', () => {
    const proj = projectLifeCashflow({
      ...base,
      principal: 1000_000_00,
      annualSavings: 0,
      retireSpend: 1_000_00,
    });
    expect(proj.fiAge).toBe(30);
  });

  it('fiYear 与 fiAge 一致（当前年 + 偏移）', () => {
    const proj = projectLifeCashflow({
      ...base,
      principal: 100_000_00,
      annualSavings: 10_000_00,
    });
    expect(proj.fiAge).not.toBeNull();
    expect(proj.fiYear).toBe(new Date().getFullYear() + (proj.fiAge! - base.currentAge));
  });
});

// ─── 人生事件叠加（阶段三）：oneOff / deltaSpend / deltaIncome / deltaFixed / deltaLiability ──
// 事件在「触发年龄那一年的循环开头」生效，因此该年的 point 已反映影响。
// 全部用 inflation: 0 让 rr = nominalRate，结果可手算校验。

describe('projectLifeCashflow 人生事件叠加（阶段三）', () => {
  const base = {
    currentAge: 30,
    retireAge: 60,
    endAge: 90,
    principal: 100_000_00, // 100 万
    annualSavings: 10_000_00, // 年存 10 万
    incomeGrowth: 0,
    nominalRate: 0.04,
    inflation: 0,
    retireSpend: 4_000_00,
    strategy: 'fixed' as const,
  };
  const idxOf = (age: number): number => age - base.currentAge;

  it('空事件数组 == 不传 events（回归保证：老配置行为不变）', () => {
    const plain = projectLifeCashflow(base);
    const empty = projectLifeCashflow({ ...base, events: [] });
    expect(empty.points.map((p) => p.netWorth)).toEqual(plain.points.map((p) => p.netWorth));
    expect(empty.fiAge).toBe(plain.fiAge);
  });

  it('oneOff 一次性支出：触发年净资产恰好低出该金额', () => {
    const plain = projectLifeCashflow(base);
    const withEv = projectLifeCashflow({
      ...base,
      events: [{ atAge: 35, oneOff: -50_000_00 }], // 35 岁掏 50 万首付
    });
    const i = idxOf(35);
    expect(withEv.points[i].netWorth).toBeCloseTo(plain.points[i].netWorth - 50_000_00, 0);
    // 触发前一年不受影响
    expect(withEv.points[i - 1].netWorth).toBeCloseTo(plain.points[i - 1].netWorth, 0);
  });

  it('触发年龄之前事件完全不生效', () => {
    const plain = projectLifeCashflow(base);
    const withEv = projectLifeCashflow({
      ...base,
      events: [{ atAge: 50, oneOff: -80_000_00, deltaSpend: 3_000_00 }],
    });
    for (let i = 0; i < idxOf(50); i++) {
      expect(withEv.points[i].netWorth).toBeCloseTo(plain.points[i].netWorth, 0);
    }
  });

  it('deltaFixed 非生息资产：抬高净资产但不产生被动收入', () => {
    const plain = projectLifeCashflow(base);
    const withEv = projectLifeCashflow({
      ...base,
      events: [{ atAge: 35, deltaFixed: 240_000_00 }], // 房产入账 240 万
    });
    const i = idxOf(35);
    expect(withEv.points[i].netWorth).toBeCloseTo(plain.points[i].netWorth + 240_000_00, 0);
    expect(withEv.points[i].passiveIncome).toBeCloseTo(plain.points[i].passiveIncome, 0); // 不供养退休
  });

  it('deltaLiability 负债：抵减净资产但不影响被动收入', () => {
    const plain = projectLifeCashflow(base);
    const withEv = projectLifeCashflow({
      ...base,
      events: [{ atAge: 35, deltaLiability: 160_000_00 }], // 背上 160 万房贷
    });
    const i = idxOf(35);
    expect(withEv.points[i].netWorth).toBeCloseTo(plain.points[i].netWorth - 160_000_00, 0);
    expect(withEv.points[i].passiveIncome).toBeCloseTo(plain.points[i].passiveIncome, 0);
  });

  it('deltaSpend 年支出上升：拉低积累速度且推迟自由里程碑', () => {
    const plain = projectLifeCashflow(base);
    const withEv = projectLifeCashflow({
      ...base,
      events: [{ atAge: 35, deltaSpend: 3_000_00 }], // 35 岁起每年多花 3 万（养娃）
    });
    // 触发年之后积累变慢
    expect(withEv.points[idxOf(40)].netWorth).toBeLessThan(plain.points[idxOf(40)].netWorth);
    // 支出变高 → 现金流余量下降
    expect(withEv.points[idxOf(40)].safeCashflow).toBeLessThan(plain.points[idxOf(40)].safeCashflow);
    // 自由里程碑推迟（或从达成变为不达成）
    if (plain.fiAge != null && withEv.fiAge != null) {
      expect(withEv.fiAge).toBeGreaterThanOrEqual(plain.fiAge);
    }
  });

  it('deltaIncome 年储蓄上升：加速积累并提前自由里程碑', () => {
    const plain = projectLifeCashflow(base);
    const withEv = projectLifeCashflow({
      ...base,
      events: [{ atAge: 35, deltaIncome: 5_000_00 }], // 35 岁升职，每年多存 5 万
    });
    expect(withEv.points[idxOf(45)].netWorth).toBeGreaterThan(plain.points[idxOf(45)].netWorth);
    if (plain.fiAge != null && withEv.fiAge != null) {
      expect(withEv.fiAge).toBeLessThanOrEqual(plain.fiAge);
    }
  });

  it('买房组合场景：首付 + 房产 + 房贷 三项净效果可叠加', () => {
    const plain = projectLifeCashflow(base);
    const withEv = projectLifeCashflow({
      ...base,
      events: [{
        atAge: 35,
        oneOff: -80_000_00, // 首付 80 万
        deltaFixed: 240_000_00, // 房产 240 万
        deltaLiability: 160_000_00, // 房贷 160 万
      }],
    });
    const i = idxOf(35);
    // 净效果 = -80 + 240 - 160 = 0 万，净资产应基本持平
    expect(withEv.points[i].netWorth).toBeCloseTo(plain.points[i].netWorth, 0);
    // 但生息本金被首付削掉 80 万 → 被动收入下降
    expect(withEv.points[i].passiveIncome).toBeLessThan(plain.points[i].passiveIncome);
  });

  it('多个事件在不同年龄各自生效，互不干扰', () => {
    const plain = projectLifeCashflow(base);
    const withEv = projectLifeCashflow({
      ...base,
      events: [
        { atAge: 35, oneOff: -20_000_00 },
        { atAge: 45, oneOff: -30_000_00 },
      ],
    });
    // 35 岁：只减 20 万
    expect(withEv.points[idxOf(35)].netWorth).toBeCloseTo(plain.points[idxOf(35)].netWorth - 20_000_00, 0);
    // 45 岁：两笔都已生效，差额 > 50 万（含期间复利损失）
    const gap45 = plain.points[idxOf(45)].netWorth - withEv.points[idxOf(45)].netWorth;
    expect(gap45).toBeGreaterThan(50_000_00);
  });

  it('同一年龄多个事件全部叠加', () => {
    const plain = projectLifeCashflow(base);
    const withEv = projectLifeCashflow({
      ...base,
      events: [
        { atAge: 40, oneOff: -10_000_00 },
        { atAge: 40, oneOff: -15_000_00 },
      ],
    });
    const i = idxOf(40);
    expect(withEv.points[i].netWorth).toBeCloseTo(plain.points[i].netWorth - 25_000_00, 0);
  });
});

// ─── 资产分桶细化（阶段二）：cashRate / cashPrincipal / nonInterestAssets / liabilities ──
// 这些字段均可选；缺省下行为须与阶段一完全一致（不传 = 现金桶 0、净资产=本金）。

describe('projectLifeCashflow 资产分桶细化（阶段二）', () => {
  const base = {
    currentAge: 30,
    retireAge: 60,
    endAge: 90,
    principal: 150_000_00, // 150 万（生息本金全额）
    annualSavings: 10_000_00,
    incomeGrowth: 0,
    nominalRate: 0.04,
    inflation: 0,
    retireSpend: 4_000_00,
    strategy: 'fixed' as const,
  };

  it('缺省（无资产字段）→ 等价阶段一：净资产=本金、被动收入=本金×名义利率', () => {
    const proj = projectLifeCashflow(base);
    expect(proj.points[0].netWorth).toBe(150_000_00);
    expect(proj.points[0].passiveIncome).toBeCloseTo(150_000_00 * 0.04, 0);
  });

  it('cashPrincipal 把本金拆 growth/cash 两段，分别按 rr / cashRate 计息', () => {
    const proj = projectLifeCashflow({ ...base, cashPrincipal: 30_000_00, cashRate: 0.015 });
    expect(proj.points[0].netWorth).toBe(150_000_00); // 净资产不变
    const growthP = 150_000_00 - 30_000_00;
    const cashP = 30_000_00;
    const expectedPassive = growthP * 0.04 + cashP * 0.015; // 4.8万 + 0.45万 = 5.25万
    expect(proj.points[0].passiveIncome).toBeCloseTo(expectedPassive, 0);
  });

  it('nonInterestAssets 进净资产线但不供养退休（被动收入不变）', () => {
    const plain = projectLifeCashflow(base);
    const withFixed = projectLifeCashflow({ ...base, nonInterestAssets: 20_000_00 });
    expect(withFixed.points[0].netWorth).toBe(plain.points[0].netWorth + 20_000_00);
    expect(withFixed.points[0].passiveIncome).toBeCloseTo(plain.points[0].passiveIncome, 0);
  });

  it('liabilities 抵减净资产线', () => {
    const plain = projectLifeCashflow(base);
    const withLiab = projectLifeCashflow({ ...base, liabilities: 50_000_00 });
    expect(withLiab.points[0].netWorth).toBe(plain.points[0].netWorth - 50_000_00);
  });

  it('cashPrincipal 超过本金 → 钳为全部计入现金桶（按比例 rr→cashRate）', () => {
    const proj = projectLifeCashflow({ ...base, cashPrincipal: 200_000_00, cashRate: 0.015 });
    expect(proj.points[0].netWorth).toBe(150_000_00); // 净资产不变
    expect(proj.points[0].passiveIncome).toBeCloseTo(150_000_00 * 0.015, 0);
  });
});
