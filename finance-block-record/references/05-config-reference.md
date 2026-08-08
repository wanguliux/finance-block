# 05 · finance-config.json 配置参考

插件配置，存于 vault 内（路径在设置页 `configPath`，默认 `finance-config.json`）。首次启用时写入种子态。以下为完整 schema（v5）。

```jsonc
{
  "version": 5,
  "accounts": [ /* AccountDef[] */ ],
  "classes": ["asset","liability","equity","income","expense"],
  "owners": ["自己","家庭"],
  "defaultOwner": "自己",
  "baseCurrency": "CNY",
  "currencies": [ /* CurrencyDef[] */ ],
  "transactionTypes": [ /* TransactionTypeDef[] */ ],
  "budgets": [ /* BudgetDef[] */ ],
  "lifeEvents": [ /* LifeEventDef[] */ ],
  "birthday": "1990-01-01",          // 可选
  "recurringPlans": [ /* RecurringPlanDef[] */ ],
  "recurringSkips": {},               // { planId: ["2026-08-03"] }
  "loanPlans": [ /* LoanDef[] */ ],
  "fiCalc": { "defaultRate": 4 },
  "defaultStaleDays": 30
}
```

## 子结构

### AccountDef — 账户（分类容器，不存金额）
| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 显示名（如 现金 / 投资:股票:腾讯，支持 `:` 层级） |
| `class` | asset\|liability\|equity\|income\|expense | 五大类（结构不变量） |
| `icon` | string? | emoji |
| `owner` | string? | 归属，缺省=defaultOwner |
| `valuation` | book\|market? | 计价方式（缺省 book=流水累加；market=靠估值行覆盖） |
| `staleDays` | number? | 估值过期阈值（天，仅 market） |
| `accrued` | boolean? | 应计标记 |
| `sinkingFund` | string? | 专项储蓄池名 |
| `cashflowRole` | growth\|cash\|fixed\|rental? | 现金流行为（资产分桶用） |

> 子账户（如 `投资:股票:腾讯`）自动继承父账户 `投资:股票` 的 class/valuation/owner，无需逐个声明。

### TransactionTypeDef — 交易类型
`{ name, direction: 'income'|'expense', customFields?: string[] }`

### CurrencyDef — 币种
`{ code, name, symbol, rate }` — `rate` = 1 该币种 = rate 个默认币种；默认币种 rate=1。

### BudgetDef — 预算
`{ name, type, amount(分), period: day|week|month|year|custom, periodDays? }` — `type` 须对应 `transactionTypes` 某项 name。

### LifeEventDef — 人生事件
`{ id, label, type, age, date?, enabled, note?, oneOff?, deltaSpend?, deltaIncome?, deltaFixed?, deltaLiability? }`
- `type: 'retire'` 特殊：age 被忽略、不可删除/改类型，图表位置由 ficalc `retireAge` 驱动。
- 设了 `date` 且用户有 `birthday` → 触发年龄由「日期+生日」推导。
- 金额单位：分；正=流入/增加，负=流出/减少；各影响字段均可选。

### RecurringPlanDef — 日常花费计划（V1）
`{ id, name, amount(分), account, fromAccount, txnType, owner, frequency: daily|weekday|monthly, monthlyDay?, startDate, endDate?, note?, active }`
- 每期 2 腿（account 支出 / fromAccount 出资），金额固定。

### LoanDef — 贷款计划（V2）
`{ id, name, type: annuity|equal-principal|interest-first, principal(分), annualRate, termYears(1–50), frequency: monthly|quarterly, firstPaymentDate, assetAccount, liabilityAccount, interestAccount, txnType, owner, note?, active, remainingPrincipal?(分) }`
- 每期 3 腿由还款引擎生成；`remainingPrincipal` 改小=模拟部分提前还本（续算）。

### RecurringSkips
`{ [planId]: string[] }` — 值=应发生日列表（跳过不入账）。

### fiCalc
`{ defaultRate: number }` — 现金流模拟器默认年利率 %。

## 种子态默认值（首次写入）
- 账户：现金(资产,book,cash) / 股票(资产,market,growth,staleDays30) / 房产(资产,fixed) / 车(资产,fixed) / 房贷(负债) / 工资(收入) / 日常(费用) / 结转(权益)。
- 币种：CNY(1) / USD(7.25) / EUR(7.83) / GBP(9.32) / JPY(0.0485) / HKD(0.93)。
- 交易类型 / 预算 / 日常计划 / 贷款计划：**种子为空**（用户自行添加；曾预置示例，因与账户类别语义重叠、对预算/热力图无意义，已移除）。
- 人生事件：内置 `retire`（age 60，启用）。
- **铁律：defaults 不塞金额示例**（曾把"车"折旧示例当真值导致数据污染）。
