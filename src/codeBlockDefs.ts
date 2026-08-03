/*
 * codeBlockDefs.ts —— 代码块插入器的元数据与文本生成
 * 单一数据源：主弹窗（卡片列表）和参数弹窗（表单）都从这里读取定义。
 * 后续新增代码块只需在此追加一条，无需改弹窗逻辑。
 *
 * 两种生成模式：
 *   1. 模板模式（template 存在）：{{key}} 占位替换，适合 fin-beancount 等结构化分录
 *   2. 键值模式（无 template）：生成 `key: value` 行，适合 finance-log 等视图参数
 */

export type ParamType = 'text' | 'number' | 'select' | 'date' | 'amount' | 'legs';

/**
 * 下拉选项的动态数据源。
 *
 * 为什么需要它：账户 / 交易类型 / 归属维度都由用户在 finance-config.json 里自定义，
 * 写死在 options 里必然过期。此前只能靠 EntryFormModal 按 `p.key === 'owner' | 'txnType'`
 * 猜数据源，换个键名（如 finance-log 的 `type`、`account`）就失效。
 * 显式声明数据源后，键名与数据源解耦，新增筛选参数不必再改弹窗逻辑。
 */
export type ParamOptionSource = 'accounts' | 'transactionTypes' | 'owners';

export interface CodeBlockParamDef {
  key: string; // 参数名（对应模板中的 {{key}} 或键值行的 key）
  labelKey: string; // i18n key（标签）
  descKey?: string; // i18n key（说明）
  type: ParamType;
  optional?: boolean; // 是否选填（默认 true，false=必填）
  placeholder?: string;
  options?: string[]; // type=select 时的静态选项值
  optionLabels?: Record<string, string>; // 选项值 → 展示文本
  optionsFrom?: ParamOptionSource; // type=select 时从 vault 配置动态取选项（优先于 options）
  defaultValue?: string; // 默认值
  autoToday?: boolean; // type=date 时是否自动填今天（记账要，筛选不要——留空才是滚动窗口）
}

export interface CodeBlockDef {
  language: string; // fence 语言名
  icon: string; // Obsidian 图标名
  titleKey: string; // i18n key（名称）
  descKey: string; // i18n key（说明）
  template?: string; // 模板（含 {{key}} 占位）——有 template 时用模板替换模式
  multiLeg?: boolean; // 复式分录块：录入为 N 腿动态结构（type:'legs' 参数驱动），文本由 buildCodeBlock 动态生成
  params: CodeBlockParamDef[];
}

/** finance-block 提供的所有可插入代码块定义 */
export const FINANCE_CODE_BLOCK_DEFS: CodeBlockDef[] = [
  // ── 存储层：复式记账分录（multiLeg 动态 N 腿录入） ─────────
  // 不再用固定 2 腿 template（from -amount / to +amount），改为：
  //   - 结构化参数只保留 date / narration / txnType / owner（标签维度）
  //   - 复式分录本身由 type:'legs' 参数驱动的动态编辑器录入（N 腿 + 一键补平）
  //   - 借贷符号由账户类别推导（界面只填正数金额 + 方向标签，不出现 +/-），见《报告》#2/#6
  // 生成文本由 buildCodeBlock 的 multiLeg 分支按 values['legs']（signed cents JSON）逐腿输出。
  {
    language: 'fin-beancount',
    icon: 'file-text',
    titleKey: 'block.fin-beancount',
    descKey: 'block.fin-beancount.desc',
    multiLeg: true,
    params: [
      {
        key: 'date',
        labelKey: 'param.date',
        descKey: 'param.date.desc',
        type: 'date',
        optional: false,
        autoToday: true,
      },
      {
        key: 'txnType',
        labelKey: 'param.txnType',
        descKey: 'param.txnType.desc',
        type: 'select',
        optionsFrom: 'transactionTypes',
        // 兜底静态选项：配置未加载时仍可用（仅作示例词表；真实词表来自
        // finance-config.json 的 transactionTypes，且已不含「转账/投资收益」这类非分类项——
        // type 只是查询标签，不再承担「资产转换 vs 收支」的语义区分，见《报告》P0 #2）。
        options: ['餐饮', '交通', '购物', '居住', '娱乐', '医疗', '教育', '通讯', '其他支出', '工资', '奖金', '副业', '其他收入'],
      },
      {
        key: 'owner',
        labelKey: 'param.owner',
        descKey: 'param.owner.desc',
        type: 'select',
        optionsFrom: 'owners',
        options: ['自己', '家庭'],
        defaultValue: '自己',
      },
      {
        key: 'narration',
        labelKey: 'param.narration',
        descKey: 'param.narration.desc',
        type: 'text',
        placeholder: '午餐 牛肉面',
      },
      {
        key: 'legs',
        labelKey: 'param.legs',
        descKey: 'param.legs.desc',
        type: 'legs',
        optional: false,
      },
    ],
  },

  // ── 视图层：流水（键值模式） ─────────────────────────────
  {
    language: 'finance-log',
    icon: 'list',
    titleKey: 'block.finance-log',
    descKey: 'block.finance-log.desc',
    // 参数顺序即弹窗表单顺序：先定「从哪天起、往前几天」，再叠加属性筛选，最后是 ID 精确查询。
    // 全部选填——留空即用默认（起始日=今天、天数=30、其余不筛）。
    params: [
      {
        key: 'date',
        labelKey: 'param.logDate',
        descKey: 'param.logDate.desc',
        type: 'date',
        // 刻意不 autoToday：留空才是「每天滚动看最近 N 天」，写死日期会让视图停在插入当天
      },
      {
        key: 'day',
        labelKey: 'param.day',
        descKey: 'param.day.desc',
        type: 'number',
        placeholder: '30',
      },
      {
        key: 'amount',
        labelKey: 'param.logAmount',
        descKey: 'param.logAmount.desc',
        type: 'amount',
        placeholder: '100',
      },
      {
        key: 'account',
        labelKey: 'param.logAccount',
        descKey: 'param.logAccount.desc',
        type: 'select',
        optionsFrom: 'accounts',
      },
      {
        key: 'type',
        labelKey: 'param.type',
        descKey: 'param.type.desc',
        type: 'select',
        optionsFrom: 'transactionTypes',
      },
      {
        key: 'owner',
        labelKey: 'param.logOwner',
        descKey: 'param.logOwner.desc',
        type: 'select',
        optionsFrom: 'owners',
      },
      {
        key: 'id',
        labelKey: 'param.id',
        descKey: 'param.id.desc',
        type: 'text',
        placeholder: '^t-20260729120000',
      },
    ],
  },

  // ── 视图层：财务自由计算器（键值模式） ───────────────────
  // 原 finance-fi 已并入本块：src: actual 即等价于旧的「财务自由进度」视图。
  // 参数全部选填——留空就走块内默认（数据源自动选、其余用配置或内置默认值）。
  // 键名已取短（与渲染块 parseParams 保持一致）：src/rate/principal/spend/save/infl/years/vol/mode。
  {
    language: 'finance-ficalc',
    icon: 'calculator',
    titleKey: 'block.finance-ficalc',
    descKey: 'block.finance-ficalc.desc',
    params: [
      {
        key: 'rate',
        labelKey: 'param.rate',
        descKey: 'param.rate.desc',
        type: 'number',
        placeholder: '4',
      },
      {
        key: 'startAge',
        labelKey: 'param.startAge',
        descKey: 'param.startAge.desc',
        type: 'number',
        placeholder: '',
        autoToday: false,
      },
      {
        key: 'age',
        labelKey: 'param.age',
        descKey: 'param.age.desc',
        type: 'number',
        placeholder: '30',
      },
      {
        key: 'retireAge',
        labelKey: 'param.retireAge',
        descKey: 'param.retireAge.desc',
        type: 'number',
        placeholder: '60',
      },
      {
        key: 'principal',
        labelKey: 'param.principal',
        descKey: 'param.principal.desc',
        type: 'number',
        placeholder: '100',
      },
      {
        key: 'spend',
        labelKey: 'param.spend',
        descKey: 'param.spend.desc',
        type: 'number',
        placeholder: '4',
      },
      {
        key: 'save',
        labelKey: 'param.savings',
        descKey: 'param.savings.desc',
        type: 'number',
        placeholder: '10',
      },
      {
        key: 'incomeGrowth',
        labelKey: 'param.incomeGrowth',
        descKey: 'param.incomeGrowth.desc',
        type: 'number',
        placeholder: '3',
      },
      {
        key: 'cashRate',
        labelKey: 'param.cashRate',
        descKey: 'param.cashRate.desc',
        type: 'number',
        placeholder: '1.5',
      },
      {
        key: 'bufferMonths',
        labelKey: 'param.bufferMonths',
        descKey: 'param.bufferMonths.desc',
        type: 'number',
        placeholder: '6',
      },
      {
        key: 'infl',
        labelKey: 'param.inflation',
        descKey: 'param.inflation.desc',
        type: 'number',
        placeholder: '2',
      },
      {
        key: 'years',
        labelKey: 'param.years',
        descKey: 'param.years.desc',
        type: 'number',
        placeholder: '30',
      },
      {
        key: 'vol',
        labelKey: 'param.volatility',
        descKey: 'param.volatility.desc',
        type: 'number',
        placeholder: '12',
      },
      {
        key: 'mode',
        labelKey: 'param.strategy',
        descKey: 'param.strategy.desc',
        type: 'select',
        options: ['fixed', 'percent', 'rule95'],
        optionLabels: { fixed: '恒定金额', percent: '固定比例', rule95: '95% 法则' },
      },
    ],
  },

  // ── 视图层：预算 ─────────────────────────────────────────
  {
    language: 'finance-budget',
    icon: 'pie-chart',
    titleKey: 'block.finance-budget',
    descKey: 'block.finance-budget.desc',
    params: [
      {
        key: 'type',
        labelKey: 'param.budgetType',
        descKey: 'param.budgetType.desc',
        type: 'select',
        optionsFrom: 'transactionTypes',
      },
    ],
  },

  // ── 视图层：热力图（收支双向，v3） ───────────────────────
  {
    language: 'finance-heatmap',
    icon: 'grid',
    titleKey: 'block.finance-heatmap',
    descKey: 'block.finance-heatmap.desc',
    params: [
      {
        key: 'day',
        labelKey: 'param.heatmapDays',
        descKey: 'param.heatmapDays.desc',
        type: 'number',
        placeholder: '182',
      },
      {
        key: 'view',
        labelKey: 'param.heatmapView',
        descKey: 'param.heatmapView.desc',
        type: 'select',
        options: ['calendar', 'matrix'],
        optionLabels: { calendar: '总览日历', matrix: '分类矩阵' },
        defaultValue: 'calendar',
      },
      {
        key: 'gran',
        labelKey: 'param.heatmapGran',
        descKey: 'param.heatmapGran.desc',
        type: 'select',
        options: ['week', 'month'],
        optionLabels: { week: '按周', month: '按月' },
        defaultValue: 'week',
      },
      {
        key: 'category',
        labelKey: 'param.heatmapCategory',
        descKey: 'param.heatmapCategory.desc',
        type: 'select',
        optionsFrom: 'transactionTypes',
      },
    ],
  },

  // ── 视图层：资产总览 ───────────────────────────────────────
  {
    language: 'finance-assets',
    icon: 'bar-chart-2',
    titleKey: 'block.finance-assets',
    descKey: 'block.finance-assets.desc',
    params: [
      {
        key: 'owner',
        labelKey: 'param.assetsOwner',
        descKey: 'param.assetsOwner.desc',
        type: 'select',
        optionsFrom: 'owners',
      },
      {
        key: 'group',
        labelKey: 'param.assetsGroup',
        descKey: 'param.assetsGroup.desc',
        type: 'select',
        options: ['class', 'prefix'],
        optionLabels: { class: '资产/负债', prefix: '账户前缀' },
        defaultValue: 'class',
      },
    ],
  },

  // ── 视图层：日常花费 + 贷款（finance-recurring，V1 + V2） ──
  // 无必填参数：界面（待入账草稿 / 我的计划 / 我的贷款）全部由 config + 账本虚派生。
  {
    language: 'finance-recurring',
    icon: 'repeat',
    titleKey: 'block.finance-recurring',
    descKey: 'block.finance-recurring.desc',
    params: [],
  },

  // 注：原 finance-fi 的能力已并入 finance-ficalc，但本块现为 what-if 沙盒（参数一律手填），
  // 不再有「从账本取数」开关；故 finance-fi 从插入器与 registry 双双移除，存量 ```finance-fi 需改为 ```finance-ficalc。
];

/**
 * 根据定义和用户填写的参数值，生成最终插入的代码块纯文本。
 * 空值参数会被跳过（落到代码块的默认值逻辑上）。
 *
 * 采用结构化入参，使 CodeBlockDef 与 BlockDefinitionWithParams 均可复用同一实现，
 * 避免各录入弹窗（EntryFormModal 等）内再维护一份重复的代码块文本拼接逻辑。
 */
export interface BuildableDef {
  language: string;
  template?: string;
  multiLeg?: boolean;
  params: { key: string }[];
}

export function buildCodeBlock(def: BuildableDef, values: Record<string, string>): string {
  // 复式分录块（fin-beancount）：N 腿动态生成，values['legs'] 为 signed cents 的 JSON 数组
  if (def.multiLeg) {
    const date = (values['date'] ?? '').trim();
    const narr = (values['narration'] ?? '').trim();
    const txnType = (values['txnType'] ?? '').trim();
    const owner = (values['owner'] ?? '').trim();

    const lines: string[] = [`${date} * ${narr}`.trim()];
    let legs: Array<{ account: string; amountCents: number }> = [];
    try {
      const parsed = JSON.parse(values['legs'] ?? '[]');
      if (Array.isArray(parsed)) legs = parsed;
    } catch {
      legs = [];
    }
    for (const l of legs) {
      if (!l.account || !l.account.trim()) continue;
      lines.push(`  ${l.account.trim()}  ${l.amountCents}`);
    }
    if (txnType) lines.push(`  type: ${txnType}`);
    if (owner) lines.push(`  owner: ${owner}`);
    return '```' + def.language + '\n' + lines.join('\n') + '\n```\n';
  }

  if (def.template) {
    let result = '```' + def.language + '\n' + def.template + '\n```' + '\n';
    for (const [key, val] of Object.entries(values)) {
      if (val && val.trim() !== '') {
        result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), () => val.trim());
      }
    }
    result = result.replace(/\{\{[^}]+\}\}/g, '');
    return result;
  }

  const lines = [def.language];
  for (const p of def.params) {
    const v = values[p.key];
    if (v === undefined || v === null) continue;
    const trimmed = v.trim();
    if (trimmed === '') continue;
    lines.push(`${p.key}: ${trimmed}`);
  }
  return '```' + lines.join('\n') + '\n```\n';
}
