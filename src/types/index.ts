// 领域类型定义
// 重要约定：金额一律以整数"分"存储（AmountInCents），避免浮点误差。

export type AmountInCents = number;

// 五大类（Chart of Accounts）：账户 / 分类强制归属其一，
// 使"净资产 = 资产 - 负债"成为结构不变量（见《已确定设计点》§1 衍生设计 C）。
export type AccountClass = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

// owner 维度：默认"自己"，预设 {自己, 家庭}，可自定义（§1 衍生设计 A）。
export type Owner = string;

// 现金流行为分类：把异构账户映射到现金流引擎的桶（资产分桶用，阶段二）。
// 存于 finance-config.json 的 AccountDef（纯 JSON），不写入 beancount 账本语法。
export type CashflowRole = 'growth' | 'cash' | 'fixed' | 'rental';

// 单条复式分录的一个方向（leg）
export interface BeancountLeg {
  account: string; // 账户名，如 "现金" / "费用:餐饮"
  amount: AmountInCents; // 变动金额（正=增加，负=减少）
}

// 一笔复式交易 = 至少一个来源 + 一个去向，各 leg 之和为零
export interface Transaction {
  id: string; // 块引用 ID，如 ^t-202607291200
  date: string; // YYYY-MM-DD
  legs: BeancountLeg[];
  narration?: string; // 摘要 / 备注
  txnType?: string; // 交易类型（可配置）
  fields?: Record<string, string>; // 自定义字段（须可筛选）
  owner?: Owner; // 归属维度
  currency?: string; // 原始币种（跨币种，默认币种由 settings 决定）
  draft?: boolean; // 是否草稿（未入账，不计入统计）
}

// 估值快照：资产的公允市值标记（人定期手动标注，写在账本内）。
// 来源：beancount `custom "fb-valuation"` 指令行（YYYY-MM-DD custom "fb-valuation" <账户名> <金额> [币种]）。
// 不参与零和校验、不产生分录、不改余额——仅作为视图层覆盖（"这项资产现在值多少钱"）。
export interface Valuation {
  date: string;          // YYYY-MM-DD
  account: string;       // 账户名，如 "投资:股票:腾讯"
  amount: AmountInCents; // 该账户在该日期的公允市值全量（分）
  currency?: string;     // 币种后缀，缺省 = 基准币种
  comment?: string;      // 行内注释（如 "约 350 股，按收盘价"）
  blockRef?: string;     // 入账后附加的块引用行（^v-YYYYMMDDHHmmss）；草稿态无
}

// ─── 配置子结构 ───────────────────────────────────────────────

// 账户定义：用户持有的金融账户（资产 / 负债类）
export interface AccountDef {
  name: string; // 显示名，如 "现金" / "银行卡"
  class: AccountClass; // 五大类归属（M1 仅 asset / liability）
  icon?: string; // 可选 emoji 图标
  // ── 资产管理（§5 归属 + §4 计价方式） ──
  owner?: Owner;                 // 账户归属，缺省 = config.defaultOwner（"自己"）
  valuation?: 'book' | 'market' | 'depreciation';  // 计价方式，缺省 'book'
  staleDays?: number;            // 估值过期阈值（天）；仅 market/depreciation 生效；缺省取 config.defaultStaleDays
  // ── 会计增强（M3，可选字段） ──
  accrued?: boolean; // 应计标记（应计负债 / 待摊资产，纯标记不要求借贷分录）
  sinkingFund?: string; // 专项储蓄池名称（如 "婚礼基金" / "教育金"）
  depreciation?: DepreciationDef; // 折旧定义（大件资产可选，小件不填）
  // ── 现金流行为分类（阶段二：资产分桶用） ──
  cashflowRole?: CashflowRole; // growth=生息增长 / cash=现金类 / fixed=非生息资产 / rental=出租房
}

// 折旧定义（§1 衍生设计 D：大件资产可选折旧）
export interface DepreciationDef {
  purchasePrice: AmountInCents; // 购买价（分）
  purchaseDate: string; // 购买日期 YYYY-MM-DD
  usefulLifeYears: number; // 预计使用年限
  method: 'straight-line'; // 目前仅支持直线法
  salvageValue?: AmountInCents; // 残值（分），缺省 0
}

// 交易类型定义：收入 / 支出的分类，支持自定义字段（须可筛选）
export interface TransactionTypeDef {
  name: string; // 类型名，如 "餐饮" / "工资"
  direction: 'income' | 'expense'; // 收支方向
  customFields?: string[]; // 自定义填写项，如 ["餐厅", "同行人"]
}

// 财务自由计算器默认参数
export interface FICalcConfig {
  defaultRate: number; // 默认年利率 %（如 4 表示 4%）
}

// 币种定义：一个可管理的货币（§1 衍生设计：跨币种换算与汇率管理）
export interface CurrencyDef {
  code: string; // ISO 4217 代码，如 "USD"（唯一键）
  name: string; // 显示名，如 "美元"
  symbol: string; // 符号，如 "$"
  rate: number; // 相对默认币种的汇率：1 该币种 = rate 个默认币种（默认币种恒为 1）
}

// 预算周期：每日 / 每周 / 每月 / 每年 / 自定义 N 日（§预算管理）
export type BudgetPeriod = 'day' | 'week' | 'month' | 'year' | 'custom';

// 预算计划：用户为某个交易类型设定一段时期的支出上限（§预算管理）。
// 金额以「基准币种的分」存储（见 AmountInCents），与预算视图口径一致。
export interface BudgetDef {
  name: string; // 计划名称（唯一键，编辑时只读，避免与预算视图的引用错乱）
  type: string; // 关联交易类型（须与 FinanceConfig.transactionTypes 中某项 name 对应，用于预算视图按分类匹配）
  amount: AmountInCents; // 预算金额（分，基准币种）
  period: BudgetPeriod; // 预算周期（每日/每周/每月/每年/自定义 N 日）
  periodDays?: number; // 仅当 period === 'custom' 时生效：周期天数 N（每 N 日滚动统计）
}

// 人生事件类型：决定图表上的配色与图标（§阶段三 事件模拟器）
// 'retire' 是特殊类型：退休年龄由 ficalc 的「退休年龄」参数驱动，事件本身只携带
// 名称/笔记/启用状态（不填财务影响字段），且不能被删除——它始终是生命周期的边界。
export type LifeEventType = 'retire' | 'house' | 'child' | 'marriage' | 'windfall' | 'career' | 'custom';

/**
 * 人生事件：用户规划的一次性人生节点（买房 / 生娃 / 结婚 / 横财 / 职业变动 / 自定义），
 * 在指定年龄对现金流模拟施加影响，并在生命周期图的「关键事件」层显示为可点竖线。
 *
 * 金额一律以「基准币种的分」存储（见 AmountInCents），正数=流入 / 增加，负数=流出 / 减少。
 * 各影响字段均可选：只填需要的那几项即可（如「结婚」可能只有 oneOff，「生娃」只有 deltaSpend）。
 * 事件是全局唯一真相（一个人只有一套人生规划），存于 finance-config.json，所有 ficalc 块共享。
 */
export interface LifeEventDef {
  id: string; // 唯一标识（创建时生成，编辑时只读）
  label: string; // 事件名称，如「买房」
  type: LifeEventType; // 事件类型（决定配色）
  age: number; // 触发年龄（与 ficalc 的「当前年龄」同一口径）；type==='retire' 时此字段被忽略，图表位置由 ficalc 的「退休年龄」参数决定
  enabled: boolean; // 是否参与计算（关掉后仍在列表里，但不影响曲线——便于做对比）
  note?: string; // 关联笔记（Obsidian 链接路径），图上点击事件即打开
  oneOff?: AmountInCents; // 当年一次性现金流（正=进账，负=支出，如买房首付填负数）
  deltaSpend?: AmountInCents; // 年支出变化（正=每年多花，如养娃）
  deltaIncome?: AmountInCents; // 年净储蓄变化（正=每年多存，如升职加薪）
  deltaFixed?: AmountInCents; // 非生息资产变化（正=增加，如房产入账——计入净资产但不供养退休）
  deltaLiability?: AmountInCents; // 负债变化（正=负债增加，如背上房贷——抵减净资产）
}

// ─── 插件配置（finance-config.json，存于 vault 内） ─────────────

// ── 日常花费计划（finance-recurring，V1） ──────────────────────

export type RecurringFrequency = 'daily' | 'weekday' | 'monthly';

/**
 * 日常花费计划：高频、规律、低变动的固定支出（地铁通勤 / 订阅 / 会员）。
 * 存于 finance-config.json 的 recurringPlans[]；每期金额固定、两腿（支出账户 + 出资账户）。
 */
export interface RecurringPlanDef {
  id: string; // 唯一标识（创建时生成，编辑时只读；入账分录以 plan: <id> 元数据标记）
  name: string; // 计划名（全局唯一）
  amount: AmountInCents; // 每期金额（分）
  account: string; // 支出账户（腿 1，必填）
  fromAccount: string; // 出资账户（腿 2，必填）
  txnType: string; // 分类标签（transactionTypes 词表）
  owner: string; // 归属（缺省 defaultOwner）
  frequency: RecurringFrequency; // daily | weekday | monthly
  monthlyDay?: number; // frequency=monthly 时生效（1–28）
  startDate: string; // 起始日 YYYY-MM-DD
  endDate?: string; // 结束日（可选，留空=长期有效）
  note?: string;
  active: boolean; // 软删/暂停标记（false = 不派生草稿）
}

/** 日常计划跳过记录：{ planId: ['2026-08-03'] }（键=应发生日） */
export type RecurringSkips = Record<string, string[]>;

// ── 贷款计划（finance-recurring，V2） ──────────────────────────

export type LoanType = 'annuity' | 'equal-principal' | 'interest-first';
export type LoanFrequency = 'monthly' | 'quarterly';

/**
 * 贷款计划：房贷/车贷等「先负债、逐期偿还」的分期还款。
 * 存于 finance-config.json 的 loanPlans[]；每期 3 腿（出资资产 / 负债 / 利息费用），
 * 金额与本金利息拆分由还款引擎（engine/loan.ts）按 schedule 生成，非固定金额。
 */
export interface LoanDef {
  id: string; // 唯一标识（入账分录以 loan: <id> 元数据标记）
  name: string;
  type: LoanType; // annuity 等额本息 | equal-principal 等额本金 | interest-first 先息后本
  principal: AmountInCents; // 贷款本金（分）
  annualRate: number; // 年利率 %
  termYears: number; // 年限（1–50）
  frequency: LoanFrequency; // 还款周期
  firstPaymentDate: string; // 首期还款日 YYYY-MM-DD
  assetAccount: string; // 出资账户（asset，每期 -total）
  liabilityAccount: string; // 负债账户（liability，每期 +principalPart）
  interestAccount: string; // 利息费用账户（expense，每期 +interestPart）
  txnType: string; // 分类标签
  owner: string;
  note?: string;
  active: boolean; // 软删/暂停标记
  /**
   * 编辑贷款时显式设定的「当前剩余本金」（= 模拟部分提前还本，已拍板入口）。
   * 缺省 = principal；续算 schedule 与「我的贷款」剩余本金展示均以本字段为基准。
   */
  remainingPrincipal?: AmountInCents;
}

/** 还款计划中的一期（引擎计算产物） */
export interface LoanPeriod {
  period: number; // 1-based 期号（入账分录以 loan-period: <N> 元数据标记）
  date: string; // 应还日 YYYY-MM-DD
  total: AmountInCents; // 本期总额（= 本金 + 利息）
  principalPart: AmountInCents; // 本期本金
  interestPart: AmountInCents; // 本期利息
  remainingBalance: AmountInCents; // 本期还清后的剩余本金
}

export interface FinanceConfig {
  version: number; // schema 版本号，用于未来迁移
  accounts: AccountDef[]; // 账户列表（中文本土预设六类）
  classes: AccountClass[]; // 五大类枚举（结构不变量）
  owners: Owner[]; // owner 维度可选值（预设 {自己, 家庭}，可自定义）
  defaultOwner: Owner; // 缺省归属
  baseCurrency: string; // 默认币种（如 CNY，须是 currencies 中某一项的 code）
  currencies: CurrencyDef[]; // 币种列表（含默认币种；rate 相对默认币种）
  transactionTypes: TransactionTypeDef[]; // 可配置交易类型
  budgets: BudgetDef[]; // 预算计划列表（按交易类型设定支出上限，驱动预算视图）
  lifeEvents: LifeEventDef[]; // 人生事件列表（买房/生娃等，驱动现金流模拟器的事件层与计算）
  recurringPlans: RecurringPlanDef[]; // 日常花费计划（finance-recurring V1）
  recurringSkips: RecurringSkips; // 日常计划跳过记录（按应发生日）
  loanPlans: LoanDef[]; // 贷款计划（finance-recurring V2）
  fiCalc: FICalcConfig; // 财务自由计算器参数
  defaultStaleDays: number; // 估值过期全局默认阈值（天），仅 market/depreciation 账户生效；账户级 staleDays 优先
}
