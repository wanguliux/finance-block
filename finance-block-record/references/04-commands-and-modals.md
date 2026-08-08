# 04 · 命令、Ribbon 与各弹窗

## 命令面板 / Ribbon

| 入口 | 名称 | 作用 |
|------|------|------|
| 命令面板 / Ribbon(硬币) | **记一笔** | 打开录入弹窗，提交即入账到账本 |
| 命令面板 / Ribbon(代码) | **插入代码块** | 打开块卡片列表（7 个），选块→填参→插入到光标处（仅当本插件是通用插入命令宿主时显示 Ribbon） |

## 记一笔（RecordTransactionModal）

- 复用 `fin-beancount` 录入表单：选日期（默认今天）、分类（`txnType`）、归属、摘要，动态 N 腿（选账户+填正数金额，符号自动推导，可「拆分分录」「一键补平」）。
- 提交后直接写入 `账本.md`（走 `appendEntryToLedgerBlock`），成功提示「已入账，写入 {ledgerPath}」。
- 这是普通用户最常用入口；自然语言记账走本技能的 `scripts/append_entry.js`（等价结果，见 `07-nl-recording.md`）。

## 插入代码块（InsertCodeBlockModal + 参数弹窗）

1. 卡片列表选 7 个块之一。
2. 参数弹窗按 `codeBlockDefs` 渲染表单（下拉选项从 `finance-config.json` 动态物化：账户/类型/归属）。
3. 「插入到光标处」生成代码块文本（视图块为 `key: value` 行；fin-beancount 为结构化录入）。

## 汇总结转（RolloverModal）

- **怎么打开**：`fin-beancount` 块内的「汇总结转」按钮。
- **填什么**：
  - 结转截止日：截至今天 / 截至本月末（仅把**已入账**余额承接进新账本；草稿不受影响）。
  - 新账本路径：结转后账本指向此新文件，旧账本保留作归档（`archiveLedgers`）。
- **结果**：旧账本归档，新账本承接余额，设置页 `ledgerPath` 自动更新。

## 更新估值（UpdateValuationModal）

- **怎么打开**：`finance-assets` 块的「更新估值」按钮。
- **填什么**：账户（仅 `valuation: market` 有意义，book 账户会提示改 market）、市值（元）、估值日期、备注。
- **结果**：在账本内写一行 `custom "fb-valuation"`，**不产生分录、不改账面余额**，仅视图层覆盖。
- 会用上次估值做实时预览（变化/账面/未实现损益）。

## 人生事件（LifeEventManagerModal）

- **怎么打开**：`finance-ficalc` 块的「事件」按钮，或设置页「人生事件」。
- **填什么**：
  - 名称、类型（retire 退休 / house 买房 / child 生娃 / marriage 结婚 / windfall 横财 / career 职业 / custom 自定义）。
  - 触发年龄，或触发日期（设了生日则由「日期+生日」推导年龄）。
  - 启用开关、关联笔记（库内路径，图上点击事件跳转）。
  - 财务影响（均可留空，只填涉及的）：一次性现金流 `oneOff`、年支出变化 `deltaSpend`、年储蓄变化 `deltaIncome`、非生息资产变化 `deltaFixed`、负债变化 `deltaLiability`（单位：元，正=流入/增加，负=流出/减少）。
  - **生日**：在此保存用户生日 → ficalc 当前年龄与带日期事件的岁数自动推导。
- **注意**：`retire` 是内置特殊事件，**不可删除、类型不可改**；其图表位置由 ficalc 的「退休年龄」参数驱动，本事件 age 被忽略。

## 日常花费计划（RecurringPlanModal，V1）

- **怎么打开**：`finance-recurring` 块「新建计划」。
- **填什么**：名称、金额（元，每期固定）、频率（每天 / 每工作日 / 每月第 N 日 1–28）、支出账户、出资账户、分类、归属、每月几号（monthly 时）、起始日、结束日（可选）、备注、启用。
- **行为**：每天自动出 2 腿草稿（支出账户 + 出资账户）；「入账」写账本并标 `plan: <id>`；「跳过」写 `recurringSkips`（按应发生日）。已入账记录不受影响。

## 贷款计划（LoanModal，V2）

- **怎么打开**：`finance-recurring` 块「新建贷款」。
- **填什么**：名称、贷款本金（元）、年利率 %、年限（1–50）、还款方式（annuity 等额本息 / equal-principal 等额本金 / interest-first 先息后本）、还款周期（每月 / 每季度）、首期还款日、出资账户 / 负债账户 / 利息费用账户、分类、归属、剩余本金（可选，改小=模拟部分提前还本，从下一未入账期续算）、备注、启用。
- **行为**：每期由还款引擎生成 3 腿（出资资产 / 负债 / 利息费用），标 `loan: <id>` 与 `loan-period: <N>`。
- **注意**：贷款**不支持跳过/改金额**（会破坏 schedule 期号连续链）；特殊操作走「编辑贷款续算」（改 `remainingPrincipal`）。

## 设置页里的管理弹窗

| 管理项 | 关键字段 | 说明 |
|--------|----------|------|
| 账户 | name / class(五大类) / icon(emoji) / owner / valuation(book\|market) / staleDays(仅market) / cashflowRole(growth\|cash\|fixed\|rental) | 账户是分类容器，**不存金额** |
| 币种与汇率 | code / name / symbol / rate(1 该币种=rate 默认币种) | 默认币种 rate=1，不可删 |
| 交易类型 | name / direction(收入\|支出) / customFields(逗号分隔) | 筛选/预算/热力图维度 |
| 归属维度 | name | 预设{自己,家庭}，默认不可删 |
| 预算管理 | name / type(交易类型) / amount(元) / period(day\|week\|month\|year\|custom) / periodDays | 驱动预算执行视图 |
| 人生事件 | 见上 | 全局唯一，所有 ficalc 块共享 |
| 存档管理 | — | 汇总结转产生的旧账本可视化/移出归档（移出仅从索引移除、不删文件） |
