---
name: finance-block-record
description: 用户向技能：指导用自然语言把一笔账录入 finance-block（Obsidian 个人财务插件）的账本，并覆盖该插件所有细节功能的使用方法——fin-beancount 复式记账语法、finance-log / finance-budget / finance-heatmap / finance-ficalc / finance-assets / finance-recurring 七个视图块的全部参数、记一笔/插入代码块/汇总结转/更新估值/人生事件/日常计划/贷款等命令与弹窗、finance-config.json 配置 schema、设置页，以及 fiCalc/loan/fx/networth 引擎口径。当用户说"记一笔/记录/记账/今天花了X/工资到账"，或询问 finance-block 任一功能怎么用时触发。
agent_created: true
---

# finance-block-record

本技能服务于 **finance-block**（Obsidian 个人财务 OS 插件）的**最终用户**，做两件事：

1. **自然语言记账**：用户说一句话（"今天午饭 35 块，微信付的" / "工资到账 1 万"），
   把它解析成合法的 `fin-beancount` 分录，追加进今天的账本文件。
2. **全功能使用手册**：覆盖插件每一个细节功能的用法（块参数、命令、弹窗、配置、设置、引擎口径）。

插件核心约定（务必先读 `references/01-getting-started.md`）：
- **唯一真源 = `fin-beancount` 代码块**（复式记账，零和校验），其余块都是只读派生视图。
- 金额一律以**整数「分」**存储；录入界面只填正数金额，借贷符号由**账户类别**推导。
- 数据纯文本存于 vault，`finance-config.json` 存配置，`账本/账本.md`（默认路径，见设置页）存账本。

## 何时使用

- 触发词：「记一笔 / 记录 / 记账 / 今天花了 X / 工资到账 / 这笔怎么记 / 期初建账 / 开账」。
- 或用户问：「finance-block 的 XX 块怎么用？」「怎么设预算？」「怎么加贷款？」「配置里 accounts 是什么？」

## 如何使用（自然语言记账主流程）

1. **解析句子**为结构化交易（不要让用户手填 beancount 语法）：
   - `date`：默认今天；句子里带"昨天/上周三/8月1号"则换算。
   - `narration`：摘要，如"午餐"。
   - `owner`：归属，默认"自己"；带"全家/我们一起"则用"家庭"。
   - `txnType`：分类标签（须是 `finance-config.json` 里 `transactionTypes` 的词，不确定就保留或问用户）。
   - `legs`：每条「账户 + 方向(in/out) + 金额(元)」。规则见下。
2. **借贷符号规则**（录入层，界面不出现 +/-，本技能脚本自动推导）：
   - `in` = 该账户余额**增加**，`out` = 余额**减少**。
   - 资产 / 费用账户：增加记正、减少记负；收入 / 负债 / 权益账户：增加记负、减少记正。
   - 例：花 35 午餐、微信付 → `现金 out 35` + `费用:餐饮 in 35`（脚本算出 `现金 -3500` / `费用:餐饮 3500`）。
   - 例：工资 1 万到账 → `银行卡 in 10000` + `工资 in 10000`（脚本算出 `银行卡 +1000000` / `工资 -1000000`）。
   - 期初建账：所有资产/负债按**余额增加**方向填 `in`，再用一个 equity 账户（如 `期初` 或 `权益:期初`）按**余额增加**方向填 `out` 作为轧差，使总增加=总减少。调用 CLI 时追加 `--field period=期初`，该笔会被 `finance-log` 默认隐藏。
3. **定位账本**：优先读设置页 `ledgerPath`（默认 `账本/账本.md`）。若不确定，问用户或扫 vault 找含 `fin-beancount` 块的 `.md`。
4. **调用打包 CLI** `scripts/finance-block-cli.js`（详见 `references/07-nl-recording.md`）：
   - 该 CLI 是**从插件共享源码（src/shared + src/parser）esbuild 打包的单文件内核**，不是手写平行实现——插件改源码、重 build 即继承，零漂移。
   - 记账写入：`ledger append`（参数 `--ledger / --config / --date / --narration / --type / --owner / --leg "账户|in|元"` 可重复 / `--field key=value` 可重复 / `--via auto|obsidian|fs` / `--json`）。期初建账需带 `--field period=期初` 以在 `finance-log` 中隐藏。
   - 账本改写：`ledger edit --ref ^t-XXX`（按块引用重建，ref 不变）/ `ledger delete --ref ^t-XXX`（软删墓碑，`; ` 前缀、可恢复）/ `ledger valuation --account 房产 --amount <分>`（追加 `fb-valuation` 估值）/ `ledger loan-post --id <贷款id> [--period N]`（按已入账期号续算并批量入账）。
   - 视图块生成：`block generate --block <finance-log|finance-ficalc|finance-budget|finance-heatmap|finance-assets|finance-recurring|fin-beancount> [--param key=val ... | --json] [--note <笔记路径>]`。
   - 配置写入：子命令 `config <add-account|add-owner|add-type|add-currency|set-base|add-budget|add-recurring|add-loan|add-lifeevent|set-birthday|...|get> --config <path> --json '<对象>'`，覆盖插件全部设置写入。
   - 落盘：默认走 **obsidian-cli**（`obsidian eval` 调插件实例内真实函数，索引即时刷新）；Obsidian 没开 / obsidian-cli 静默 no-op 则**自动降级直接写文件（fs）**，并写后读回账本验证是否真变化、绝不丢数据。
   - 脚本会做**零和校验**，不平衡直接报错、绝不写半笔。
5. **回执**：把 CLI 输出（成功/落盘路径/用了哪条路径 `method`）简洁地告诉用户。

> 脚本需要 `finance-config.json` 才能精确按账户类别推导符号；若拿不到，按账户名前缀（资产/负债/权益/收入/费用/费用别名）推断。

## 如何使用（查功能用法）

按主题读 `references/`：

- `01-getting-started.md` — 是什么、数据模型、文件布局、首次配置。
- `02-fin-beancount-syntax.md` — 记账语法全文（日期行 / leg / 元数据 / 估值行 / 零和 / 注释）。
- `03-view-blocks.md` — 七个视图块的全部参数与示例。
- `04-commands-and-modals.md` — 命令面板、Ribbon、各弹窗的用法。
- `05-config-reference.md` — `finance-config.json` 每个字段的含义与示例。
- `06-settings.md` — 设置页各项。
- `07-nl-recording.md` — 自然语言记账的脚本调用细节与边界。
- `08-engine-reference.md` — fiCalc / 贷款 / 汇率 / 净资 引擎口径（看懂视图数字从哪来）。

## 重要边界（不要误导用户）

- **资产价值由记账驱动**：账户本身不存金额，价值 = 账本流水累加（账面）或账本内 `custom "fb-valuation"` 估值行（市值）。不要教用户在配置里填金额。
- **finance-fi 已并入 finance-ficalc**：存量 ` ```finance-fi ` 需改为 ` ```finance-ficalc `。
- **日常计划无"改金额/跳过"破坏 schedule**：贷款跳过会破坏期号连续链，故贷款不支持跳过/改金额，特殊操作走"编辑贷款续算"（CLI 用 `ledger loan-post` 续算入账）。
- **账本可改写但需按引用**：改某笔用 `ledger edit --ref ^t-XXX`、删某笔用 `ledger delete --ref ^t-XXX`（软删墓碑，数据保留、可反注释恢复）；二者都经插件同源纯核心，无漂移。不要用文本编辑器随便改 `fin-beancount` 块内文。
