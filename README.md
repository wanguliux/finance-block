# 财务块 Finance Block

Obsidian 个人财务 OS 插件。以 ` ```fin-beancount``` ` 代码块为**唯一真源**的复式记账，配套渲染视图
（`finance-log` / `finance-budget` / `finance-heatmap` / `finance-ficalc`）与财务自由目标计算。
KOS 原生、极致可配置，数据纯文本存 vault、可双链、可进 Git。

## 设计依据
- 决策唯一可信名单：`已确定设计点.md`（在项目文档库中）
- 调研 / 产品设计方案 / 技术架构见项目文档库「前期规划」
- 复用已上架的 workout-block 骨架经验

## 开发环境

```bash
npm install      # 安装依赖（obsidian / esbuild / typescript / vitest ...）
npm run dev      # 监听模式热重载打包，输出 main.js
npm run build    # 生产模式压缩打包
npm test         # 运行单元测试（vitest + jsdom）
```

### 本地调试（BRAT 内测）
1. 用 `npm run build` 生成 `main.js` + `manifest.json`。
2. 通过 BRAT 添加本地插件目录，或把本目录软链到 vault 的 `.obsidian/plugins/finance-block`。
3. 在 Obsidian 设置 → 社区插件中启用。

## 目录结构

```
finance-block/
├── manifest.json          # 插件元信息（id=finance-block）
├── package.json
├── esbuild.config.mjs      # 打包脚本（CJS / external:obsidian）
├── tsconfig.json
├── vitest.config.ts
├── styles.css             # 全局样式（.finance-block 命名空间）
├── src/
│   ├── main.ts            # FinancePlugin 主类（onload/onunload + 命令 + Ribbon + 代码块处理器）
│   ├── types/             # 领域类型（Transaction / AccountClass / Owner / FinanceConfig）
│   ├── settings/          # 插件设置（data.json）+ 设置页
│   ├── parser/            # fin-beancount 轻量复式解析器（自研，零和校验）
│   ├── engine/            # fiCalc 纯函数引擎（财务自由计算）+ 单测
│   ├── codeblock/         # 代码块处理器注册表（fin-beancount + finance-*）
│   ├── blockProvider.ts   # 跨插件通用 block 插入器契约（BlockProvider + first-claim wins）
│   └── test/              # obsidian 测试桩
└── versions.json
```

## 已开发功能

见根目录 [`开发日志.md`](./开发日志.md)——按数据模型 / 账本链路 / 代码块体系 / 计算引擎 /
配置体系 / UI / 跨插件契约 / 测试构建分节，逐条对应到源码文件。

## 数据文件

插件在 vault 内只生成 **一个** 文件：`finance-config.json`（路径可在设置页改）。
交易索引为纯内存，启动时全量扫描重建，不落盘。
