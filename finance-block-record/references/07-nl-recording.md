# 07 · 自然语言记账（本技能核心能力）

目标：用户说一句话 → 解析 → 经打包 CLI 写入今天的账本；或经 CLI 改写 `finance-config.json` 完成任一设置。

> **内核性质**：`scripts/finance-block-cli.js` 是 esbuild 从插件**共享纯核心**（`src/shared/entry.ts`、`src/shared/ledgerWrite.ts`、`src/shared/configOps.ts`、`src/parser/finBeancount.ts`）打包的单文件。它与插件共用同一份分录构建 / 序列化 / 零和校验 / 块插入 / 配置 CRUD 逻辑——插件改 `src` 后重 build 即继承，**不是手写平行实现**，无两份真相。

## 总流程（记账）

1. **解析句子**为结构化交易（见下「句子 → 参数」映射）。
2. **定位账本**：优先用设置页 `ledgerPath`（默认 `账本/账本.md`）。
3. **调用 CLI** `ledger append`（默认 `via=auto`：先试 obsidian-cli，失败/静默降级 fs）。
4. **回执**：把 CLI 输出（成功/落盘路径/`method`）简告用户。

## 句子 → 参数 映射

| 句子 | date | narration | type | legs（账户\|方向\|元） |
|------|------|-----------|------|------------------------|
| 今天午饭35块微信付的 | 今天 | 午餐 | 餐饮 | `微信\|out\|35` + `费用:餐饮\|in\|35` |
| 工资到账1万，打到银行卡 | 今天 | 工资 | 工资 | `银行卡\|in\|10000` + `工资\|in\|10000` |
| 8月1号交房租2000从银行卡 | 2026-08-01 | 房租 | 居住 | `银行卡\|out\|2000` + `费用:居住\|in\|2000` |

- **方向 `in` = 账户余额增加；`out` = 余额减少**。CLI 按账户类别自动推导借贷符号（资产/费用增加记正，收入/负债/权益增加记负），你无需给正负号。
- 金额填**元**（可小数），CLI 转整数分。
- `type` 必须是 `finance-config.json` 里已有的 `transactionTypes` 词；不确定就留空或问用户。
- `owner` 默认"自己"；带"全家/一起"用"家庭"。

## 记账：子命令 `ledger append`

```bash
node scripts/finance-block-cli.js ledger append \
  --ledger "账本/账本.md" \
  --config "finance-config.json" \
  --date 2026-08-07 \
  --narration "午餐" \
  --type 餐饮 --owner 自己 \
  --leg "微信|out|35" --leg "费用:餐饮|in|35"
```

### 参数
| 参数 | 必填 | 说明 |
|------|------|------|
| `--ledger` | 是 | 账本 `.md` 路径（vault 相对或绝对） |
| `--config` | 否 | `finance-config.json` 路径，用于精确按账户类别推导符号；缺则按账户名前缀推断 |
| `--date` | 否 | `YYYY-MM-DD`，默认今天 |
| `--narration` | 否 | 摘要 |
| `--type` | 否 | 分类标签（须存在于 config.transactionTypes） |
| `--owner` | 否 | 归属，默认"自己" |
| `--leg` | 是(≥2) | 重复传，每条 `账户\|in\|out\|金额元` |
| `--via` | 否 | `auto`(默认) / `obsidian`(仅 obsidian-cli) / `fs`(仅直写文件) |
| `--field` | 否 | 可重复，自定义元数据字段，如 `--field period=期初`；会被写入账本并参与视图判定 |
| `--json` | 否 | 替代上式，传完整 JSON：`{"ledger,date,narration,type,owner,legs:[{account,dir,yuan|c,currency}],fields,config,via}` |

### 落盘机制（B 优先 / A 备选，按你定的方案）
- **`obsidian`（优先）**：调 `obsidian eval`，在 Obsidian 运行实例内执行插件真实 `appendToLedger`（走 `src/shared/ledgerWrite.appendEntryToContent` + `indexer.updateFile`），**索引即时刷新**。
- **`fs`（备选）**：Obsidian 没开 / obsidian-cli 不可用 / 静默 no-op，直接读改写账本文件（同插件逻辑：在唯一 `fin-beancount` 块闭合 ``` 前插入，末尾加 `^t-` 块引用）。Obsidian 下次聚焦时经文件监视器重新索引。
- **自动降级 + 二次验证**：`via=auto` 时先试 obsidian；写后**读回账本确认该笔确已落盘**，未含则静默降级 fs，绝不丢数据。输出 `method` 字段标明实际路径。

### 期初建账 / 开账录入

期初建账本质上就是一笔**复式分录**：把所有资产/负债账户的期初余额作为 leg 录入，再用一个 equity 账户（如 `权益:期初` 或 `期初`）作为轧差 leg 使总和为零。为了让 `finance-log` 默认隐藏它（与「汇总结转」一致），需要加上 `--field period=期初`：

```bash
node scripts/finance-block-cli.js ledger append \
  --ledger "账本/账本.md" \
  --config "finance-config.json" \
  --date 2026-08-08 \
  --narration "期初建账" \
  --leg "银行卡活期|in|4800" \
  --leg "股票|in|462650" \
  --leg "无息贷款|out|100000" \
  --leg "期初|out|367867" \
  --field period=期初
```

- `in` / `out` 是**账户余额**的增加/减少（不是借贷方向）；CLI 会自动按账户类别推导符号。
- `--field period=期初` 会被序列化为账本里的 `  period: 期初` 行，触发 `finance-log` 隐藏。
- 若漏加 `--field period=期初`，narration 为「期初建账」的交易仍会被隐藏（向后兼容），但建议显式带字段，避免 narration 改名后暴露。

### 校验与输出
- **零和校验**：所有 leg 推导后的整数分之和必须为零，否则报错退出、绝不写半笔。
- 成功输出（stdout JSON）：
  ```json
  { "ok": true, "path": "账本/账本.md", "method": "fs",
    "entry": "2026-08-07 * 午餐\n  微信 -3500\n  费用:餐饮 3500\n  type: 餐饮\n  owner: 自己\n^t-2026080721004501" }
  ```
- 失败输出：`{ "ok": false, "error": "..." }`（如零和不平衡、账户未在 config 声明、账本不存在）。

## 账本改写：edit / delete / valuation / loan-post

与 `append` 同内核（纯核心 `src/shared/ledgerWrite.ts` / `src/shared/entry.ts` / `src/engine/loan.ts`），落盘机制同样 `via=auto`（obsidian 优先 / fs 降级 + 写后读回验证是否真变化）。

### `ledger edit` —— 按块引用重建某笔（ref 不变，finance-log 链接不失效）
```bash
node scripts/finance-block-cli.js ledger edit \
  --ledger "账本/账本.md" --ref "^t-2026080721004501" \
  --config finance-config.json --date 2026-08-07 \
  --narration "午餐改" --type 餐饮 --owner 自己 \
  --leg "微信|out|50" --leg "费用:餐饮|in|50"
```
- `--ref`：目标分录的块引用（账本里 `^t-...` 行；可用 `ledger list` 查 id）。
- 其余参数同 `append`（重构整笔，零和校验同样拦截）。
- 输出：`{ "ok": true, "path", "method", "ref" }`。

### `ledger delete` —— 软删除墓碑（数据保留、可反注释恢复、不计入索引）
```bash
node scripts/finance-block-cli.js ledger delete \
  --ledger "账本/账本.md" --ref "^t-2026080721004501"
```
- 实现：把该条目每一行前缀 `; `（beancount 注释 = 排除出解析与索引），与插件解析器约定一致。
- 反恢复：把 `; ` 前缀去掉即可。
- 输出：`{ "ok": true, "path", "method", "ref", "tombstoned": true }`。`ledger list` 计数不含墓碑。

### `ledger valuation` —— 追加一条资产估值（custom "fb-valuation"）
```bash
node scripts/finance-block-cli.js ledger valuation \
  --ledger "账本/账本.md" --config finance-config.json \
  --date 2026-08-07 --account 房产 --amount 20000000
```
- `--amount` 为**整数分**（如 20000000 = 200 万）；可选 `--currency USD`（跨币种估值）。
- 追加到 `fin-beancount` 块底部，附 `^v-` 块引用（与交易 `^t-` 对称、视图不混收）。
- 输出：`{ "ok": true, "path", "method", "entry": "<日期> custom \"fb-valuation\" <账户> <分>\n^v-..." }`。

### `ledger loan-post` —— 按账本已入账期号续算并批量入账贷款待还期
```bash
node scripts/finance-block-cli.js ledger loan-post \
  --ledger "账本/账本.md" --config finance-config.json \
  --id loan-home --period 3
```
- 纯引擎 `deriveLoanPostings`：读账本→找该贷款已入账最大期号→从「下一期」以 `principal` 续算→逐期生成 3 腿分录（与 views 续算口径一致）。
- `--period N` 可选，只生成到第 N 期；缺省=全部剩余期。
- 输出：`{ "ok": true, "path", "method", "loanId", "posted": 3 }`。

## 视图块生成：block generate

把任一代码块围栏文本生成出来（复用插件 `codeBlockDefs.buildCodeBlock`，与插入器同源）。agent 拿到文本后粘贴到笔记，或经 `--note` 直接写入某笔记文件。

```bash
# 键值模式视图块
node scripts/finance-block-cli.js block generate --block finance-assets --param owner=自己 --param group=class
# 参数较多时可用 --json 传完整键值
node scripts/finance-block-cli.js block generate --block finance-ficalc --json '{"rate":4,"age":30,"retireAge":60}'
# 复式分录块（fin-beancount）：legs 为 signed-cents JSON 数组
node scripts/finance-block-cli.js block generate --block fin-beancount \
  --json '{"date":"2026-08-07","narration":"测试","legs":"[{\"account\":\"微信\",\"amountCents\":-3500},{\"account\":\"费用:餐饮\",\"amountCents\":3500}]"}'
```

| --block 取值 | 说明 |
|--------------|------|
| `fin-beancount` | 复式记账分录空壳（录入走块内按钮/记一笔命令） |
| `finance-log` | 流水视图 |
| `finance-ficalc` | 财务自由计算器 |
| `finance-budget` | 预算视图 |
| `finance-heatmap` | 收支热力图 |
| `finance-assets` | 资产总览 |
| `finance-recurring` | 日常花费 + 贷款（虚派生，无参数） |

- 参数键名/默认值与 `references/03-view-blocks.md` 完全一致（同一份 `codeBlockDefs` 定义）。
- 可选 `--note <笔记路径>`：把生成的围栏直接追加写入该笔记文件（fs）。

## 配置：子命令 `config <action>`

覆盖插件全部设置写入。**所有 action 均需 `--config <path>`**；对象类用 `--json '<JSON>'`，定位类用 `--name / --code / --id / --date`。

```bash
node scripts/finance-block-cli.js config add-account --config finance-config.json \
  --json '{"name":"银行卡","class":"asset","icon":"💳","owner":"自己"}'
```

| action | 定位参数 | --json 对象类型 |
|--------|----------|----------------|
| `add-account` / `update-account` / `remove-account` | `--name` | `AccountDef` |
| `add-owner` / `remove-owner` / `set-default-owner` | `--name` | — |
| `add-type` / `update-type` / `remove-type` | `--name` | `TransactionTypeDef` |
| `add-currency` / `update-currency` / `remove-currency` / `set-base` | `--code` | `CurrencyDef` |
| `add-budget` / `update-budget` / `remove-budget` | `--name` | `BudgetDef` |
| `add-recurring` / `update-recurring` / `remove-recurring` / `skip-recurring` | `--id`（skip 另需 `--date`） | `RecurringPlanDef` |
| `add-loan` / `update-loan` / `remove-loan` | `--id` | `LoanDef` |
| `add-lifeevent` / `update-lifeevent` / `remove-lifeevent` | `--id` | `LifeEventDef`（retire 不可删） |
| `set-birthday` | `--date` | — |
| `get` | — | 打印完整配置 |

写入语义与插件 `configManager` 完全一致：读出现有配置 → 与 `DEFAULT_CONFIG` 合并归一 → 应用变换 → 写回（2 空格缩进）。未知/多余字段保留。

## 边界与注意

- 账户必须先在 `finance-config.json` 的 `accounts` 里声明（或能被父账户前缀继承），否则符号推导可能不准、且不计入资产总览/预算。
- 账本改写：改某笔用 `ledger edit`（按 `^t-` 引用），删某笔用 `ledger delete`（软删墓碑，`; ` 前缀，可反注释恢复）；二者都走与插件同源的 `src/shared/ledgerWrite`，零漂移。
- 跨币种：leg 可在 `--json` 里带 `currency` 字段（如 `{"account":"现金","dir":"out","yuan":100,"currency":"USD"}`）；CLI 按 config 中 `currencies` 的 `rate` 折算基准币（由插件 `engine/fx` 口径决定，CLI 复用同一定义）。
- CLI 不依赖插件构建产物，独立 `node` ≥ 18 即可运行；它由 `npm run build`（esbuild 第二入口）自动重新生成到本目录。
