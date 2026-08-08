"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/cli/index.ts
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
var import_child_process = require("child_process");

// src/config/defaults.ts
var DEFAULT_CONFIG = {
  version: 5,
  // ── 账户：每类一个，owner 默认「自己」，valuation / cashflowRole 按通常语义预填 ──
  accounts: [
    // 流动资产 —— 账面计价，现金类（日常收支）
    { name: "\u73B0\u91D1", class: "asset", icon: "\u{1F4B5}", owner: "\u81EA\u5DF1", valuation: "book", cashflowRole: "cash" },
    // 投资 —— 市值计价，生息增长（股票/基金统称，用户可按需改名）
    { name: "\u80A1\u7968", class: "asset", icon: "\u{1F4C8}", owner: "\u81EA\u5DF1", valuation: "market", cashflowRole: "growth", staleDays: 30 },
    // 大件资产 —— 账面计价（2026-08-04 终版：资产价值由记账自动得出，
    // 曾设 market/折旧派生+具体资产面板，用户拍板「能记账就记账驱动」，已废弃）
    { name: "\u623F\u4EA7", class: "asset", icon: "\u{1F3E0}", owner: "\u81EA\u5DF1", cashflowRole: "fixed" },
    { name: "\u8F66", class: "asset", icon: "\u{1F697}", owner: "\u81EA\u5DF1", cashflowRole: "fixed" },
    // 负债
    { name: "\u623F\u8D37", class: "liability", icon: "\u{1F3E6}", owner: "\u81EA\u5DF1" },
    // 收入（流量账户，记完即归零）
    { name: "\u5DE5\u8D44", class: "income", icon: "\u{1F4B0}", owner: "\u81EA\u5DF1" },
    // 费用（流量账户，记完即归零）
    { name: "\u65E5\u5E38", class: "expense", icon: "\u{1F35C}", owner: "\u81EA\u5DF1" },
    // 权益（结转专用）
    { name: "\u7ED3\u8F6C", class: "equity", icon: "\u{1F504}", owner: "\u81EA\u5DF1" }
  ],
  // 五大类
  classes: ["asset", "liability", "equity", "income", "expense"],
  // owner 维度
  owners: ["\u81EA\u5DF1", "\u5BB6\u5EAD"],
  defaultOwner: "\u81EA\u5DF1",
  // 默认币种
  baseCurrency: "CNY",
  // 币种 —— 名称用各币种对应官方语言
  currencies: [
    { code: "CNY", name: "\u4EBA\u6C11\u5E01", symbol: "\xA5", rate: 1 },
    { code: "USD", name: "US Dollar", symbol: "$", rate: 7.25 },
    { code: "EUR", name: "Euro", symbol: "\u20AC", rate: 7.83 },
    { code: "GBP", name: "Pound Sterling", symbol: "\xA3", rate: 9.32 },
    { code: "JPY", name: "\u65E5\u672C\u5186", symbol: "\u5186", rate: 0.0485 },
    { code: "HKD", name: "Hong Kong Dollar", symbol: "HK$", rate: 0.93 }
  ],
  // 交易类型 —— 种子为空，用户在设置页「交易类型管理」按需添加
  //（曾预置「支出/收入」，与账户类别（收入/费用）语义重叠、对预算/热力图无意义，2026-08-06 移除）
  transactionTypes: [],
  // 预算 —— 种子为空（预算按交易类型匹配实绩，交易类型种子为空后原「日常/支出」种子悬空，2026-08-06 移除）
  budgets: [],
  // 人生事件 —— 退休为内置特殊事件（不可删除、类型不可改）
  lifeEvents: [
    { id: "retire", label: "\u9000\u4F11", type: "retire", age: 60, enabled: true }
  ],
  // 日常花费计划（finance-recurring V1）—— 种子为空，用户在代码块里新建
  recurringPlans: [],
  recurringSkips: {},
  // 贷款计划（finance-recurring V2）—— 种子为空
  loanPlans: [],
  // 现金流模拟器默认参数
  fiCalc: {
    defaultRate: 4
  },
  // 估值过期全局默认阈值（天）
  defaultStaleDays: 30
};

// src/shared/configOps.ts
function mergeConfig(base, patch) {
  const result = structuredClone(base);
  for (const key of Object.keys(patch)) {
    const val = patch[key];
    if (val !== void 0) {
      result[key] = structuredClone(val);
    }
  }
  return result;
}
function addAccount(config, account) {
  if (config.accounts.some((a) => a.name === account.name)) {
    throw new Error(`\u8D26\u6237\u5DF2\u5B58\u5728\uFF1A${account.name}`);
  }
  return { ...config, accounts: [...config.accounts, account] };
}
function updateAccount(config, name, patch) {
  const accounts = config.accounts.map((a) => a.name === name ? { ...a, ...patch } : a);
  if (accounts.length === config.accounts.length && !accounts.some((a) => a.name === name)) {
    throw new Error(`\u8D26\u6237\u4E0D\u5B58\u5728\uFF1A${name}`);
  }
  return { ...config, accounts };
}
function removeAccount(config, name) {
  return { ...config, accounts: config.accounts.filter((a) => a.name !== name) };
}
function addOwner(config, owner) {
  if (config.owners.includes(owner))
    return config;
  return { ...config, owners: [...config.owners, owner] };
}
function removeOwner(config, owner) {
  if (owner === config.defaultOwner) {
    throw new Error(`\u4E0D\u80FD\u5220\u9664\u9ED8\u8BA4 owner\uFF1A${owner}`);
  }
  return { ...config, owners: config.owners.filter((o) => o !== owner) };
}
function setDefaultOwner(config, owner) {
  if (!config.owners.includes(owner)) {
    throw new Error(`owner \u4E0D\u5B58\u5728\uFF1A${owner}`);
  }
  return { ...config, defaultOwner: owner };
}
function addTransactionType(config, type) {
  if (config.transactionTypes.some((t2) => t2.name === type.name)) {
    throw new Error(`\u4EA4\u6613\u7C7B\u578B\u5DF2\u5B58\u5728\uFF1A${type.name}`);
  }
  return { ...config, transactionTypes: [...config.transactionTypes, type] };
}
function updateTransactionType(config, name, patch) {
  const transactionTypes = config.transactionTypes.map(
    (t2) => t2.name === name ? { ...t2, ...patch } : t2
  );
  if (transactionTypes.length === config.transactionTypes.length && !transactionTypes.some((t2) => t2.name === name)) {
    throw new Error(`\u4EA4\u6613\u7C7B\u578B\u4E0D\u5B58\u5728\uFF1A${name}`);
  }
  return { ...config, transactionTypes };
}
function removeTransactionType(config, name) {
  return { ...config, transactionTypes: config.transactionTypes.filter((t2) => t2.name !== name) };
}
function addCurrency(config, currency) {
  if (config.currencies.some((c) => c.code === currency.code)) {
    throw new Error(`\u5E01\u79CD\u5DF2\u5B58\u5728\uFF1A${currency.code}`);
  }
  return { ...config, currencies: [...config.currencies, currency] };
}
function updateCurrency(config, code, patch) {
  const currencies = config.currencies.map((c) => c.code === code ? { ...c, ...patch } : c);
  if (currencies.length === config.currencies.length && !currencies.some((c) => c.code === code)) {
    throw new Error(`\u5E01\u79CD\u4E0D\u5B58\u5728\uFF1A${code}`);
  }
  return { ...config, currencies };
}
function removeCurrency(config, code) {
  if (code === config.baseCurrency) {
    throw new Error(`\u4E0D\u80FD\u5220\u9664\u57FA\u51C6\u5E01\u79CD\uFF1A${code}`);
  }
  return { ...config, currencies: config.currencies.filter((c) => c.code !== code) };
}
function setBaseCurrency(config, code) {
  if (!config.currencies.some((c) => c.code === code)) {
    throw new Error(`\u5E01\u79CD\u4E0D\u5B58\u5728\uFF1A${code}`);
  }
  return { ...config, baseCurrency: code };
}
function addBudget(config, budget) {
  if (config.budgets.some((b) => b.name === budget.name)) {
    throw new Error(`\u9884\u7B97\u5DF2\u5B58\u5728\uFF1A${budget.name}`);
  }
  return { ...config, budgets: [...config.budgets, budget] };
}
function updateBudget(config, name, patch) {
  const budgets = config.budgets.map((b) => b.name === name ? { ...b, ...patch } : b);
  if (budgets.length === config.budgets.length && !budgets.some((b) => b.name === name)) {
    throw new Error(`\u9884\u7B97\u4E0D\u5B58\u5728\uFF1A${name}`);
  }
  return { ...config, budgets };
}
function removeBudget(config, name) {
  return { ...config, budgets: config.budgets.filter((b) => b.name !== name) };
}
function addRecurringPlan(config, plan) {
  if (config.recurringPlans.some((p) => p.id === plan.id)) {
    throw new Error(`\u65E5\u5E38\u8BA1\u5212 id \u5DF2\u5B58\u5728\uFF1A${plan.id}`);
  }
  return { ...config, recurringPlans: [...config.recurringPlans, plan] };
}
function updateRecurringPlan(config, id, patch) {
  const recurringPlans = config.recurringPlans.map((p) => p.id === id ? { ...p, ...patch } : p);
  if (recurringPlans.length === config.recurringPlans.length && !recurringPlans.some((p) => p.id === id)) {
    throw new Error(`\u65E5\u5E38\u8BA1\u5212\u4E0D\u5B58\u5728\uFF1A${id}`);
  }
  return { ...config, recurringPlans };
}
function removeRecurringPlan(config, id) {
  return { ...config, recurringPlans: config.recurringPlans.filter((p) => p.id !== id) };
}
function skipRecurring(config, planId, date) {
  const skips = { ...config.recurringSkips };
  const list = skips[planId] ? [...skips[planId]] : [];
  if (!list.includes(date))
    list.push(date);
  return { ...config, recurringSkips: { ...skips, [planId]: list } };
}
function addLoanPlan(config, plan) {
  if (config.loanPlans.some((p) => p.id === plan.id)) {
    throw new Error(`\u8D37\u6B3E\u8BA1\u5212 id \u5DF2\u5B58\u5728\uFF1A${plan.id}`);
  }
  return { ...config, loanPlans: [...config.loanPlans, plan] };
}
function updateLoanPlan(config, id, patch) {
  const loanPlans = config.loanPlans.map((p) => p.id === id ? { ...p, ...patch } : p);
  if (loanPlans.length === config.loanPlans.length && !loanPlans.some((p) => p.id === id)) {
    throw new Error(`\u8D37\u6B3E\u8BA1\u5212\u4E0D\u5B58\u5728\uFF1A${id}`);
  }
  return { ...config, loanPlans };
}
function removeLoanPlan(config, id) {
  return { ...config, loanPlans: config.loanPlans.filter((p) => p.id !== id) };
}
function addLifeEvent(config, event) {
  if (config.lifeEvents.some((e) => e.id === event.id)) {
    throw new Error(`\u4EBA\u751F\u4E8B\u4EF6 id \u5DF2\u5B58\u5728\uFF1A${event.id}`);
  }
  return { ...config, lifeEvents: [...config.lifeEvents, event] };
}
function updateLifeEvent(config, id, patch) {
  const lifeEvents = config.lifeEvents.map((e) => e.id === id ? { ...e, ...patch } : e);
  if (lifeEvents.length === config.lifeEvents.length && !lifeEvents.some((e) => e.id === id)) {
    throw new Error(`\u4EBA\u751F\u4E8B\u4EF6\u4E0D\u5B58\u5728\uFF1A${id}`);
  }
  return { ...config, lifeEvents };
}
function removeLifeEvent(config, id) {
  const target = config.lifeEvents.find((e) => e.id === id);
  if (target && target.type === "retire") {
    throw new Error("\u9000\u4F11\u4E8B\u4EF6\u4E0D\u53EF\u5220\u9664");
  }
  return { ...config, lifeEvents: config.lifeEvents.filter((e) => e.id !== id) };
}
function setBirthday(config, date) {
  return { ...config, birthday: date };
}

// src/shared/entry.ts
var CLASS_MAP = {
  // 中文（含常见别名）
  "\u8D44\u4EA7": "asset",
  "\u8D1F\u503A": "liability",
  "\u6743\u76CA": "equity",
  "\u6536\u5165": "income",
  "\u6536\u76CA": "income",
  "\u8425\u6536": "income",
  "\u8D39\u7528": "expense",
  "\u652F\u51FA": "expense",
  "\u82B1\u8D39": "expense",
  // 英文（大小写不敏感，兼容单复数）
  "asset": "asset",
  "assets": "asset",
  "liability": "liability",
  "liabilities": "liability",
  "equity": "equity",
  "equities": "equity",
  "income": "income",
  "incomes": "income",
  "expense": "expense",
  "expenses": "expense"
};
function classOfAccount(name) {
  const segs = name.split(/[:／/]/).map((s) => s.trim().toLowerCase());
  for (const seg of segs) {
    const cls = CLASS_MAP[seg];
    if (cls)
      return cls;
  }
  return null;
}
var SEP_RE = /[:／/]/;
function findAccountDef(name, accounts) {
  if (!accounts || accounts.length === 0)
    return void 0;
  const exact = accounts.find((a) => a.name === name);
  if (exact)
    return exact;
  let best;
  for (const def of accounts) {
    if (!name.startsWith(def.name))
      continue;
    const nextChar = name.charAt(def.name.length);
    if (!SEP_RE.test(nextChar))
      continue;
    if (!best || def.name.length > best.name.length)
      best = def;
  }
  return best;
}
function resolveAccountClass(name, config) {
  const def = findAccountDef(name, config?.accounts);
  if (def)
    return def.class;
  return classOfAccount(name);
}
function legSignedCents(account, amountCents, dir, config) {
  const cls = resolveAccountClass(account, config);
  const incSign = cls === "income" || cls === "liability" || cls === "equity" ? -1 : 1;
  return dir === "in" ? amountCents * incSign : -amountCents * incSign;
}
var blockRefSeq = 0;
function generateBlockRefId(date) {
  const now = /* @__PURE__ */ new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  const seq = String(blockRefSeq++ % 100).padStart(2, "0");
  const datePrefix = date ? date.replace(/-/g, "") : `${year}${month}${day}`;
  return `^t-${datePrefix}${hours}${minutes}${seconds}${seq}`;
}
function buildTxn(spec, config) {
  if (!spec.legs || spec.legs.length < 2) {
    throw new Error("\u590D\u5F0F\u8BB0\u8D26\u81F3\u5C11\u9700\u8981 2 \u6761\u5206\u5F55\uFF08leg\uFF09");
  }
  const legs = spec.legs.map((l) => {
    if (!l.account)
      throw new Error("leg \u7F3A\u5C11\u8D26\u6237");
    const dir = l.dir;
    if (dir !== "in" && dir !== "out")
      throw new Error(`leg \u65B9\u5411\u5FC5\u987B\u662F in/out\uFF1A\u6536\u5230 ${String(dir)}`);
    let cents;
    if (typeof l.cents === "number")
      cents = l.cents;
    else if (typeof l.yuan === "number")
      cents = Math.round(l.yuan * 100);
    else
      throw new Error(`leg \u91D1\u989D\u975E\u6CD5\uFF08\u9700 yuan \u6216 cents\uFF09\uFF1A\u8D26\u6237 ${l.account}`);
    const signed = legSignedCents(l.account, cents, dir, config);
    const legCurrency = l.currency ?? spec.currency;
    return {
      account: l.account,
      amount: signed,
      ...legCurrency ? { currency: legCurrency } : {}
    };
  });
  return {
    id: "",
    // 块引用由调用方在序列化后附加（^t-...）
    date: spec.date,
    legs,
    ...spec.narration ? { narration: spec.narration } : {},
    ...spec.type ? { txnType: spec.type } : {},
    ...spec.owner ? { owner: spec.owner } : {},
    ...spec.fields ? { fields: spec.fields } : {}
  };
}
function zeroSumDiff(txn) {
  return txn.legs.reduce((sum, l) => sum + l.amount, 0);
}
function serializeTxnForCopy(txn) {
  const lines = [];
  const flag = txn.draft ? "!" : "*";
  const narr = txn.narration ?? "";
  lines.push(`${txn.date} ${flag} ${narr}`.trimEnd());
  for (const leg of txn.legs) {
    const amt = txn.currency ? `${leg.amount} ${txn.currency}` : `${leg.amount}`;
    lines.push(`  ${leg.account}  ${amt}`);
  }
  if (txn.txnType)
    lines.push(`  type: ${txn.txnType}`);
  if (txn.owner)
    lines.push(`  owner: ${txn.owner}`);
  if (txn.fields) {
    for (const [k, v] of Object.entries(txn.fields))
      lines.push(`  ${k}: ${v}`);
  }
  if (txn.id && txn.id.startsWith("^t-"))
    lines.push(txn.id);
  return lines.join("\n");
}
function buildValuationText(date, account, amountCents, currency) {
  const suffix = currency ? ` ${currency}` : "";
  return `${date} custom "fb-valuation" ${account} ${amountCents}${suffix}`;
}

// src/shared/ledgerWrite.ts
function normalizeBlockRefId(blockRefId) {
  const kindMatch = /^\^?([tv])-/.exec(blockRefId);
  const kind = kindMatch ? kindMatch[1] : "t";
  return `^${kind}-${blockRefId.replace(/^\^?[tv]-/, "")}`;
}
function appendEntryToContent(existing, entryBody, blockRefId, ledgerPath) {
  const refId = normalizeBlockRefId(blockRefId);
  const entryText = `${entryBody}
${refId}`;
  if (existing === null) {
    const title = ledgerPath.split("/").pop()?.replace(".md", "") || "\u8D26\u672C";
    return `# ${title}

\`\`\`fin-beancount
${entryText}
\`\`\`
`;
  }
  const blockMatch = /```fin-beancount\r?\n([\s\S]*?)```/.exec(existing);
  if (blockMatch) {
    const blockEnd = blockMatch.index + blockMatch[0].length;
    const closeFenceStart = blockEnd - 3;
    const before = existing.slice(0, closeFenceStart);
    const after = existing.slice(closeFenceStart);
    return `${before}

${entryText}
${after}`;
  }
  return `${existing}

\`\`\`fin-beancount
${entryText}
\`\`\`
`;
}
function splitLedgerEntries(body) {
  const lines = body.split(/\r?\n/);
  const spans = [];
  let curStart = -1;
  const findRefIdx = (s, e) => {
    for (let i = s; i <= e; i++) {
      if (/^\^[tv]-/.test(lines[i].trim()))
        return i;
    }
    return -1;
  };
  const closeAt = (boundaryExclusive) => {
    if (curStart < 0)
      return;
    let end = boundaryExclusive - 1;
    while (end >= curStart && lines[end].trim() === "")
      end--;
    if (end < curStart) {
      curStart = -1;
      return;
    }
    const refIdx = findRefIdx(curStart, end);
    spans.push({
      ref: refIdx >= 0 ? lines[refIdx].trim() : null,
      start: curStart,
      end: refIdx >= 0 ? refIdx : end
    });
    curStart = -1;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith(";")) {
      closeAt(i);
      continue;
    }
    if (/^\^[tv]-/.test(trimmed)) {
      closeAt(i + 1);
      continue;
    }
    const isDate = /^\d{4}-\d{2}-\d{2}\s/.test(line) && !line.startsWith(" ");
    if (isDate) {
      closeAt(i);
      curStart = i;
    } else if (curStart < 0) {
      curStart = i;
    }
  }
  closeAt(lines.length);
  return spans;
}
function replaceEntryByRef(content, refId, newBody) {
  const m = /```fin-beancount\r?\n([\s\S]*?)```/.exec(content);
  if (!m)
    throw new Error("\u8D26\u672C\u4E2D\u627E\u4E0D\u5230 fin-beancount \u5757");
  const body = m[1];
  const target = splitLedgerEntries(body).find((e) => e.ref === refId);
  if (!target)
    throw new Error(`\u672A\u627E\u5230\u5757\u5F15\u7528 ${refId} \u5BF9\u5E94\u7684\u5206\u5F55`);
  const lines = body.split(/\r?\n/);
  const newLines = [
    ...lines.slice(0, target.start),
    ...newBody.split(/\r?\n/),
    ...lines.slice(target.end + 1)
  ];
  const newBodyText = newLines.join("\n");
  const bodyStart = m.index + m[0].indexOf(body);
  const bodyEnd = bodyStart + body.length;
  return content.slice(0, bodyStart) + newBodyText + content.slice(bodyEnd);
}
function tombstoneEntryByRef(content, refId) {
  const m = /```fin-beancount\r?\n([\s\S]*?)```/.exec(content);
  if (!m)
    throw new Error("\u8D26\u672C\u4E2D\u627E\u4E0D\u5230 fin-beancount \u5757");
  const body = m[1];
  const target = splitLedgerEntries(body).find((e) => e.ref === refId);
  if (!target)
    throw new Error(`\u672A\u627E\u5230\u5757\u5F15\u7528 ${refId} \u5BF9\u5E94\u7684\u5206\u5F55`);
  const lines = body.split(/\r?\n/);
  const tombstoned = lines.slice(target.start, target.end + 1).map((l) => l.trim() === "" ? l : "; " + l);
  const newLines = [...lines.slice(0, target.start), ...tombstoned, ...lines.slice(target.end + 1)];
  const newBodyText = newLines.join("\n");
  const bodyStart = m.index + m[0].indexOf(body);
  const bodyEnd = bodyStart + body.length;
  return content.slice(0, bodyStart) + newBodyText + content.slice(bodyEnd);
}

// src/util/date.ts
function localDateString(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// src/i18n/zh.ts
var zh = {
  // ─── 设置页 ─────────────────────────────────────────────
  "settings.ledgerPath": "\u8D26\u672C\u6587\u4EF6\u8DEF\u5F84",
  "settings.ledgerPath.desc": "\u5355\u4E00\u8D26\u672C\u6587\u4EF6\u7684\u5B8C\u6574\u8DEF\u5F84\uFF08\u5982 \u8D26\u672C/\u8D26\u672C.md\uFF09\uFF1B\u6C47\u603B\u7ED3\u8F6C\u540E\u4F1A\u6307\u5411\u65B0\u8D26\u672C",
  "settings.ledgerPath.browse": "\u6D4F\u89C8",
  "settings.ledgerPath.placeholder": "\u5982 \u8D26\u672C/\u8D26\u672C.md",
  "settings.configPath": "\u914D\u7F6E\u6587\u4EF6\u8DEF\u5F84",
  "settings.configPath.desc": "finance-config.json \u7684\u5B8C\u6574\u8DEF\u5F84\uFF08\u8D26\u6237/\u5E01\u79CD/\u7C7B\u578B\u7B49\u914D\u7F6E\u5B58\u4E8E\u6B64\uFF09",
  "settings.configPath.browse": "\u6D4F\u89C8",
  "settings.configPath.placeholder": "\u5982 finance-config.json",
  "settings.configReloadError": "\u914D\u7F6E\u91CD\u8F7D\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5 finance-config.json",
  "settings.language": "\u8BED\u8A00",
  "settings.language.desc": "\u63D2\u4EF6\u754C\u9762\u8BED\u8A00",
  "settings.selectFolder": "\u9009\u62E9\u6587\u4EF6\u5939",
  "settings.currencyManager": "\u5E01\u79CD\u4E0E\u6C47\u7387",
  "settings.currencyManager.desc": "\u7BA1\u7406\u4F60\u7684\u8D27\u5E01\u4E0E\u6C47\u7387",
  "settings.openManager": "\u6253\u5F00\u7BA1\u7406",
  // 设置页分组标题
  "settings.dataSection": "\u6570\u636E\u6587\u4EF6",
  "settings.managers": "\u7BA1\u7406",
  "settings.generalSection": "\u901A\u7528",
  "settings.moveUp": "\u4E0A\u79FB",
  "settings.moveDown": "\u4E0B\u79FB",
  // ─── 通用 ───────────────────────────────────────────────
  "common.add": "\u65B0\u589E",
  "common.edit": "\u7F16\u8F91",
  "common.delete": "\u5220\u9664",
  "common.save": "\u4FDD\u5B58",
  "common.cancel": "\u53D6\u6D88",
  "common.confirm": "\u786E\u5B9A",
  "common.close": "\u5173\u95ED",
  "common.noMatch": "\u65E0\u5339\u914D\u9879",
  "common.default": "\u9ED8\u8BA4",
  "common.saveFailed": "\u4FDD\u5B58\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5",
  // ─── 币种与汇率管理 ─────────────────────────────────────
  "modal.currency.title": "\u5E01\u79CD\u4E0E\u6C47\u7387",
  "modal.currency.search": "\u641C\u7D22\u5E01\u79CD\u2026",
  "modal.currency.add": "\u65B0\u589E\u5E01\u79CD",
  "modal.currency.noData": '\u6682\u65E0\u5E01\u79CD\uFF0C\u70B9\u51FB"\u65B0\u589E\u5E01\u79CD"\u6DFB\u52A0',
  "modal.currency.setDefault": "\u8BBE\u4E3A\u9ED8\u8BA4",
  "modal.currency.confirmDelete": "\u786E\u5B9A\u5220\u9664\u5E01\u79CD {name}\uFF08{code}\uFF09\uFF1F",
  "modal.currency.cannotDeleteDefault": "\u9ED8\u8BA4\u5E01\u79CD\u4E0D\u80FD\u5220\u9664",
  "modal.currency.editTitle": "\u7F16\u8F91\u5E01\u79CD",
  "modal.currency.newTitle": "\u65B0\u589E\u5E01\u79CD",
  "modal.currency.code": "\u5E01\u79CD\u4EE3\u7801",
  "modal.currency.codePlaceholder": "\u5982 USD",
  "modal.currency.name": "\u540D\u79F0",
  "modal.currency.namePlaceholder": "\u5982 \u7F8E\u5143",
  "modal.currency.symbol": "\u7B26\u53F7",
  "modal.currency.symbolPlaceholder": "\u5982 $",
  "modal.currency.rate": "\u6C47\u7387",
  "modal.currency.ratePlaceholder": "1 \u8BE5\u5E01\u79CD = ? \u9ED8\u8BA4\u5E01\u79CD",
  "modal.currency.rateHint": "\u76F8\u5BF9\u9ED8\u8BA4\u5E01\u79CD {base}\uFF1A1 {code} = {rate} {base}",
  "modal.currency.baseRateFixed": "\u9ED8\u8BA4\u5E01\u79CD\u6C47\u7387\u56FA\u5B9A\u4E3A 1",
  "modal.currency.codeRequired": "\u8BF7\u586B\u5199\u5E01\u79CD\u4EE3\u7801",
  "modal.currency.nameRequired": "\u8BF7\u586B\u5199\u5E01\u79CD\u540D\u79F0",
  "modal.currency.codeDuplicate": "\u5E01\u79CD\u4EE3\u7801\u5DF2\u5B58\u5728",
  "modal.currency.saved": "\u5DF2\u4FDD\u5B58",
  "modal.currency.deleted": "\u5DF2\u5220\u9664",
  "modal.currency.rebased": "\u5DF2\u5207\u6362\u9ED8\u8BA4\u5E01\u79CD\uFF0C\u6C47\u7387\u5DF2\u6309\u65B0\u57FA\u51C6\u91CD\u65B0\u6298\u7B97",
  // ─── 账户管理 ───────────────────────────────────────────
  "settings.accounts": "\u8D26\u6237",
  "settings.accounts.desc": "\u7BA1\u7406\u4F60\u7684\u91D1\u878D\u8D26\u6237\uFF08\u8D44\u4EA7 / \u8D1F\u503A\uFF09",
  "modal.accounts.title": "\u8D26\u6237\u7BA1\u7406",
  "modal.accounts.search": "\u641C\u7D22\u8D26\u6237\u2026",
  "modal.accounts.add": "\u65B0\u589E\u8D26\u6237",
  "modal.accounts.noData": '\u6682\u65E0\u8D26\u6237\uFF0C\u70B9\u51FB"\u65B0\u589E\u8D26\u6237"\u6DFB\u52A0',
  "modal.accounts.editTitle": "\u7F16\u8F91\u8D26\u6237",
  "modal.accounts.newTitle": "\u65B0\u589E\u8D26\u6237",
  "modal.accounts.name": "\u540D\u79F0",
  "modal.accounts.namePlaceholder": "\u5982 \u73B0\u91D1",
  "modal.accounts.class": "\u7C7B\u522B",
  "modal.accounts.classPlaceholder": "\u9009\u62E9\u4E94\u5927\u7C7B",
  "class.asset": "\u8D44\u4EA7",
  "class.liability": "\u8D1F\u503A",
  "class.equity": "\u6743\u76CA",
  "class.income": "\u6536\u5165",
  "class.expense": "\u8D39\u7528",
  "modal.accounts.icon": "\u56FE\u6807",
  "modal.accounts.iconPlaceholder": "\u53EF\u9009 emoji\uFF0C\u5982 \u{1F4B5}",
  "modal.accounts.nameRequired": "\u8BF7\u586B\u5199\u8D26\u6237\u540D\u79F0",
  "modal.accounts.nameDuplicate": "\u8D26\u6237\u540D\u79F0\u5DF2\u5B58\u5728",
  "modal.accounts.confirmDelete": "\u786E\u5B9A\u5220\u9664\u8D26\u6237\u300C{name}\u300D\uFF1F",
  "modal.accounts.deleted": "\u5DF2\u5220\u9664",
  "modal.accounts.saved": "\u5DF2\u4FDD\u5B58",
  // ─── 交易类型管理 ───────────────────────────────────────
  "settings.transactionTypes": "\u4EA4\u6613\u7C7B\u578B",
  "settings.transactionTypes.desc": "\u7BA1\u7406\u6536\u652F\u5206\u7C7B\u4E0E\u81EA\u5B9A\u4E49\u5B57\u6BB5",
  "modal.transactionTypes.title": "\u4EA4\u6613\u7C7B\u578B\u7BA1\u7406",
  "modal.transactionTypes.search": "\u641C\u7D22\u7C7B\u578B\u2026",
  "modal.transactionTypes.add": "\u65B0\u589E\u7C7B\u578B",
  "modal.transactionTypes.noData": '\u6682\u65E0\u4EA4\u6613\u7C7B\u578B\uFF0C\u70B9\u51FB"\u65B0\u589E\u7C7B\u578B"\u6DFB\u52A0',
  "modal.transactionTypes.editTitle": "\u7F16\u8F91\u4EA4\u6613\u7C7B\u578B",
  "modal.transactionTypes.newTitle": "\u65B0\u589E\u4EA4\u6613\u7C7B\u578B",
  "modal.transactionTypes.name": "\u540D\u79F0",
  "modal.transactionTypes.namePlaceholder": "\u5982 \u9910\u996E",
  "modal.transactionTypes.direction": "\u65B9\u5411",
  "modal.transactionTypes.direction.income": "\u6536\u5165",
  "modal.transactionTypes.direction.expense": "\u652F\u51FA",
  "modal.transactionTypes.fields": "{n} \u4E2A\u81EA\u5B9A\u4E49\u5B57\u6BB5",
  "modal.transactionTypes.noFields": "\u65E0\u81EA\u5B9A\u4E49\u5B57\u6BB5",
  "modal.transactionTypes.customFields": "\u81EA\u5B9A\u4E49\u5B57\u6BB5",
  "modal.transactionTypes.customFieldsPlaceholder": "\u9017\u53F7\u5206\u9694\uFF0C\u5982 \u9910\u5385, \u540C\u884C\u4EBA",
  "modal.transactionTypes.nameRequired": "\u8BF7\u586B\u5199\u7C7B\u578B\u540D\u79F0",
  "modal.transactionTypes.nameDuplicate": "\u7C7B\u578B\u540D\u79F0\u5DF2\u5B58\u5728",
  "modal.transactionTypes.confirmDelete": "\u786E\u5B9A\u5220\u9664\u4EA4\u6613\u7C7B\u578B\u300C{name}\u300D\uFF1F",
  "modal.transactionTypes.deleted": "\u5DF2\u5220\u9664",
  "modal.transactionTypes.saved": "\u5DF2\u4FDD\u5B58",
  // ─── 归属维度管理 ───────────────────────────────────────
  "settings.owners": "\u5F52\u5C5E\u7EF4\u5EA6",
  "settings.owners.desc": "\u7BA1\u7406\u4EA4\u6613\u7684\u5F52\u5C5E\u7EF4\u5EA6\uFF08\u81EA\u5DF1 / \u5BB6\u5EAD / \u81EA\u5B9A\u4E49\uFF09",
  "modal.owners.title": "\u5F52\u5C5E\u7EF4\u5EA6\u7BA1\u7406",
  "modal.owners.search": "\u641C\u7D22\u5F52\u5C5E\u2026",
  "modal.owners.add": "\u65B0\u589E\u5F52\u5C5E",
  "modal.owners.noData": '\u6682\u65E0\u5F52\u5C5E\u7EF4\u5EA6\uFF0C\u70B9\u51FB"\u65B0\u589E\u5F52\u5C5E"\u6DFB\u52A0',
  "modal.owners.editTitle": "\u7F16\u8F91\u5F52\u5C5E",
  "modal.owners.newTitle": "\u65B0\u589E\u5F52\u5C5E",
  "modal.owners.name": "\u540D\u79F0",
  "modal.owners.namePlaceholder": "\u5982 \u81EA\u5DF1",
  "modal.owners.nameRequired": "\u8BF7\u586B\u5199\u5F52\u5C5E\u540D\u79F0",
  "modal.owners.nameDuplicate": "\u5F52\u5C5E\u540D\u79F0\u5DF2\u5B58\u5728",
  "modal.owners.setDefault": "\u8BBE\u4E3A\u9ED8\u8BA4",
  "modal.owners.cannotDeleteDefault": "\u9ED8\u8BA4\u5F52\u5C5E\u4E0D\u80FD\u5220\u9664",
  "modal.owners.confirmDelete": "\u786E\u5B9A\u5220\u9664\u5F52\u5C5E\u300C{name}\u300D\uFF1F",
  "modal.owners.deleted": "\u5DF2\u5220\u9664",
  "modal.owners.saved": "\u5DF2\u4FDD\u5B58",
  // ─── 预算管理 ───────────────────────────────────────────
  "settings.budgetManager": "\u9884\u7B97\u7BA1\u7406",
  "settings.budgetManager.desc": "\u4E3A\u4EA4\u6613\u7C7B\u578B\u8BBE\u5B9A\u652F\u51FA\u4E0A\u9650\uFF0C\u9A71\u52A8\u9884\u7B97\u6267\u884C\u89C6\u56FE",
  "settings.lifeEventManager": "\u4EBA\u751F\u4E8B\u4EF6",
  "settings.lifeEventManager.desc": "\u89C4\u5212\u4E70\u623F\u3001\u751F\u5A03\u7B49\u4EBA\u751F\u8282\u70B9\uFF0C\u6A21\u62DF\u5176\u5BF9\u73B0\u91D1\u6D41\u4E0E\u51C0\u8D44\u4EA7\u7684\u957F\u671F\u51B2\u51FB",
  "modal.budget.title": "\u9884\u7B97\u7BA1\u7406",
  "modal.budget.search": "\u641C\u7D22\u9884\u7B97\u8BA1\u5212\u2026",
  "modal.budget.add": "\u65B0\u589E\u9884\u7B97",
  "modal.budget.noData": '\u6682\u65E0\u9884\u7B97\u8BA1\u5212\uFF0C\u70B9\u51FB"\u65B0\u589E\u9884\u7B97"\u6DFB\u52A0',
  "modal.budget.editTitle": "\u7F16\u8F91\u9884\u7B97",
  "modal.budget.newTitle": "\u65B0\u589E\u9884\u7B97",
  "modal.budget.name": "\u8BA1\u5212\u540D\u79F0",
  "modal.budget.namePlaceholder": "\u5982 7\u6708\u9910\u996E\u9884\u7B97",
  "modal.budget.type": "\u4EA4\u6613\u7C7B\u578B",
  "modal.budget.typePlaceholder": "\u9009\u62E9\u5173\u8054\u7684\u4EA4\u6613\u7C7B\u578B",
  "modal.budget.amount": "\u9884\u7B97\u91D1\u989D\uFF08\u5143\uFF09",
  "modal.budget.amountPlaceholder": "\u5982 3000",
  "modal.budget.nameRequired": "\u8BF7\u586B\u5199\u8BA1\u5212\u540D\u79F0",
  "modal.budget.nameDuplicate": "\u8BA1\u5212\u540D\u79F0\u5DF2\u5B58\u5728",
  "modal.budget.typeRequired": "\u8BF7\u9009\u62E9\u4EA4\u6613\u7C7B\u578B",
  "modal.budget.amountRequired": "\u8BF7\u586B\u5199\u9884\u7B97\u91D1\u989D",
  "modal.budget.confirmDelete": "\u786E\u5B9A\u5220\u9664\u9884\u7B97\u8BA1\u5212\u300C{name}\u300D\uFF1F",
  "modal.budget.deleted": "\u5DF2\u5220\u9664",
  "modal.budget.saved": "\u5DF2\u4FDD\u5B58",
  "modal.budget.period": "\u9884\u7B97\u5468\u671F",
  "modal.budget.periodCustom": "\u81EA\u5B9A\u4E49\uFF08\u6309\u5929\u6570\uFF09",
  "modal.budget.periodDays": "\u5468\u671F\u5929\u6570\uFF08\u5929\uFF09",
  "modal.budget.periodDaysPlaceholder": "\u5982 30",
  "modal.budget.periodDaysRequired": "\u8BF7\u586B\u5199\u6709\u6548\u7684\u5468\u671F\u5929\u6570",
  // ─── 人生事件（阶段三 事件模拟器） ──────────────────────
  "modal.event.title": "\u4EBA\u751F\u4E8B\u4EF6",
  "modal.event.intro": "\u89C4\u5212\u4E70\u623F\u3001\u751F\u5A03\u7B49\u4EBA\u751F\u8282\u70B9\uFF0C\u6A21\u62DF\u5B83\u4EEC\u5BF9\u73B0\u91D1\u6D41\u4E0E\u51C0\u8D44\u4EA7\u7684\u957F\u671F\u5F71\u54CD\u3002\u4E8B\u4EF6\u5728\u6240\u6709\u73B0\u91D1\u6D41\u6A21\u62DF\u5668\u4E2D\u5171\u4EAB\u3002",
  "modal.event.add": "\u65B0\u589E\u4E8B\u4EF6",
  "modal.event.noData": "\u6682\u65E0\u4EBA\u751F\u4E8B\u4EF6\uFF0C\u70B9\u51FB\u300C\u65B0\u589E\u4E8B\u4EF6\u300D\u89C4\u5212\u7B2C\u4E00\u4E2A\u8282\u70B9",
  "modal.event.editTitle": "\u7F16\u8F91\u4E8B\u4EF6",
  "modal.event.newTitle": "\u65B0\u589E\u4E8B\u4EF6",
  "modal.event.label": "\u4E8B\u4EF6\u540D\u79F0",
  "modal.event.labelPlaceholder": "\u5982 \u4E70\u623F / \u751F\u5A03 / \u6362\u57CE\u5E02",
  "modal.event.type": "\u4E8B\u4EF6\u7C7B\u578B",
  "modal.event.age": "\u89E6\u53D1\u5E74\u9F84",
  "modal.event.agePlaceholder": "\u5982 35",
  "modal.event.retireAgeHint": "\u6B64\u5904\u5E74\u9F84\u4F5C\u4E3A\u73B0\u91D1\u6D41\u6A21\u62DF\u5668\u7684\u300C\u9000\u4F11\u5E74\u9F84\u300D\u9ED8\u8BA4\u503C\uFF1B\u6A21\u62DF\u5668\u5185\u53EF\u5355\u72EC\u8C03\u6574\uFF0C\u4E0D\u5F71\u54CD\u672C\u4E8B\u4EF6\u3002\u6B64\u4E8B\u4EF6\u4E0D\u53EF\u5220\u9664\u3001\u7C7B\u578B\u4E0D\u53EF\u6539\u3002",
  "modal.event.atAge": "{n} \u5C81",
  "modal.event.hasNote": "\u7B14\u8BB0",
  "modal.event.enabled": "\u5DF2\u542F\u7528",
  "modal.event.disabled": "\u5DF2\u505C\u7528",
  "modal.event.enabledLabel": "\u53C2\u4E0E\u8BA1\u7B97\uFF08\u5173\u6389\u540E\u4FDD\u7559\u5728\u5217\u8868\u4E2D\uFF0C\u4F46\u4E0D\u5F71\u54CD\u66F2\u7EBF\uFF0C\u4FBF\u4E8E\u505A\u5BF9\u6BD4\uFF09",
  "modal.event.impactSection": "\u8D22\u52A1\u5F71\u54CD",
  "modal.event.impactHint": "\u4EE5\u4E0B\u4E94\u9879\u5747\u53EF\u7559\u7A7A\uFF0C\u53EA\u586B\u8FD9\u4E2A\u4E8B\u4EF6\u771F\u6B63\u6D89\u53CA\u7684\u3002\u91D1\u989D\u5355\u4F4D\u300C\u5143\u300D\uFF0C\u6B63\u6570=\u6D41\u5165 / \u589E\u52A0\uFF0C\u8D1F\u6570=\u6D41\u51FA / \u51CF\u5C11\u3002",
  "modal.event.oneOff": "\u4E00\u6B21\u6027\u73B0\u91D1\u6D41",
  "modal.event.oneOff.desc": "\u5F53\u5E74\u4E00\u6B21\u6027\u6536\u652F\uFF0C\u5982\u9996\u4ED8\u586B -800000",
  "modal.event.deltaSpend": "\u5E74\u652F\u51FA\u53D8\u5316",
  "modal.event.deltaSpend.desc": "\u6B64\u540E\u6BCF\u5E74\u591A\u82B1\uFF0C\u5982\u517B\u5A03\u586B 30000",
  "modal.event.deltaIncome": "\u5E74\u50A8\u84C4\u53D8\u5316",
  "modal.event.deltaIncome.desc": "\u6B64\u540E\u6BCF\u5E74\u591A\u5B58\uFF0C\u5982\u5347\u804C\u586B 50000",
  "modal.event.deltaFixed": "\u975E\u751F\u606F\u8D44\u4EA7\u53D8\u5316",
  "modal.event.deltaFixed.desc": "\u8BA1\u5165\u51C0\u8D44\u4EA7\u4F46\u4E0D\u4F9B\u517B\u9000\u4F11\uFF0C\u5982\u623F\u4EA7\u586B 2400000",
  "modal.event.deltaLiability": "\u8D1F\u503A\u53D8\u5316",
  "modal.event.deltaLiability.desc": "\u62B5\u51CF\u51C0\u8D44\u4EA7\uFF0C\u5982\u623F\u8D37\u586B 1600000",
  "modal.event.note": "\u5173\u8054\u7B14\u8BB0\uFF08\u53EF\u9009\uFF09",
  "modal.event.notePlaceholder": "\u8F93\u5165\u5E93\u5185\u7B14\u8BB0\u8DEF\u5F84\uFF0C\u56FE\u4E0A\u70B9\u51FB\u4E8B\u4EF6\u5373\u53EF\u8DF3\u8F6C",
  "modal.event.labelRequired": "\u8BF7\u586B\u5199\u4E8B\u4EF6\u540D\u79F0",
  "modal.event.ageRequired": "\u8BF7\u586B\u5199\u6709\u6548\u7684\u89E6\u53D1\u5E74\u9F84\uFF080\u2013120\uFF09",
  "modal.event.impactInvalid": "\u8D22\u52A1\u5F71\u54CD\u91D1\u989D\u586B\u5199\u6709\u8BEF\uFF0C\u8BF7\u68C0\u67E5",
  "modal.event.confirmDelete": "\u786E\u5B9A\u5220\u9664\u4EBA\u751F\u4E8B\u4EF6\u300C{name}\u300D\uFF1F",
  "modal.event.deleted": "\u5DF2\u5220\u9664",
  "modal.event.saved": "\u5DF2\u4FDD\u5B58",
  "modal.event.birthday": "\u751F\u65E5",
  "modal.event.birthdayDerivedAge": "\u5F53\u524D\u5E74\u9F84 {n} \u5C81",
  "modal.event.birthdayHint": "\u586B\u4E86\u751F\u65E5\u540E\uFF0C\u300C\u5F53\u524D\u5E74\u9F84\u300D\u4E0E\u8BBE\u7F6E\u4E86\u89E6\u53D1\u65E5\u671F\u7684\u4E8B\u4EF6\u5C81\u6570\u90FD\u80FD\u81EA\u52A8\u63A8\u5BFC\uFF0C\u65E0\u9700\u624B\u586B\u5E74\u9F84\u3002",
  "modal.event.birthdaySave": "\u4FDD\u5B58\u751F\u65E5",
  "modal.event.birthdaySaved": "\u751F\u65E5\u5DF2\u4FDD\u5B58",
  "modal.event.date": "\u89E6\u53D1\u65E5\u671F\uFF08\u53EF\u9009\uFF09",
  "modal.event.dateHint": "\u586B\u4E86\u5177\u4F53\u65E5\u671F\u540E\uFF0C\u53EF\u7531\u300C\u751F\u65E5\u300D\u81EA\u52A8\u63A8\u5BFC\u89E6\u53D1\u5C81\u6570\uFF1B\u7559\u7A7A = \u6309\u5E74\u9F84\u89E6\u53D1\u3002",
  "modal.event.dateDerivedAge": "\u7531\u751F\u65E5\u63A8\u5BFC\uFF1A{n} \u5C81",
  "event.type.retire": "\u9000\u4F11",
  "event.type.house": "\u4E70\u623F",
  "event.type.child": "\u751F\u5A03",
  "event.type.marriage": "\u7ED3\u5A5A",
  "event.type.windfall": "\u6A2A\u8D22",
  "event.type.career": "\u804C\u4E1A",
  "event.type.custom": "\u81EA\u5B9A\u4E49",
  // ─── 命令 ───────────────────────────────────────────────
  "command.record": "\u8BB0\u4E00\u7B14",
  "command.insertBlock": "\u63D2\u5165\u4EE3\u7801\u5757",
  // ─── 插入弹窗 ───────────────────────────────────────────
  "modal.insert.title": "\u63D2\u5165\u4EE3\u7801\u5757",
  "modal.insert.searchPlaceholder": "\u641C\u7D22\u4EE3\u7801\u5757\u2026",
  "modal.insert.noMatch": "\u65E0\u5339\u914D\u9879",
  "modal.insert.paramsCount": "{n} \u4E2A\u53C2\u6570",
  "modal.insert.param.title": "\u53C2\u6570\u914D\u7F6E",
  "modal.insert.param.optional": "\u53EF\u9009",
  "modal.insert.param.requiredHint": "\u4E3A\u5FC5\u586B\u9879",
  "modal.insert.param.skip": "\u8DF3\u8FC7\u53C2\u6570",
  "modal.insert.param.insert": "\u63D2\u5165\u5230\u5149\u6807\u5904",
  "modal.combobox.noMatch": "\u65E0\u5339\u914D\u9879",
  "modal.insert.noEditor": "\u8BF7\u5148\u6253\u5F00\u4E00\u4E2A\u7B14\u8BB0\u7F16\u8F91\u5668",
  "modal.insert.inserted": "\u4EE3\u7801\u5757\u5DF2\u63D2\u5165",
  // ─── 记一笔（直接入账） ───────────────────────────────
  "modal.record.submit": "\u8BB0\u4E00\u7B14",
  "modal.record.success": "\u5DF2\u5165\u8D26\uFF0C\u5199\u5165 {ledgerPath}",
  "modal.record.error": "\u5165\u8D26\u5931\u8D25\uFF1A{error}",
  "modal.record.noDef": "\u672A\u627E\u5230\u590D\u5F0F\u8BB0\u8D26\u5206\u5F55\u5B9A\u4E49",
  // ─── 加入草稿（fin-beancount 草稿态「添加记录」按钮） ─────────
  "modal.draft.title": "\u6DFB\u52A0\u8BB0\u5F55",
  "modal.draft.submit": "\u52A0\u5165\u8349\u7A3F",
  "modal.draft.success": "\u5DF2\u52A0\u5165\u5F53\u524D\u4EE3\u7801\u5757\u8349\u7A3F",
  "modal.draft.empty": "\u5206\u5F55\u4E3A\u7A7A\uFF0C\u5DF2\u53D6\u6D88",
  "modal.draft.error": "\u52A0\u5165\u8349\u7A3F\u5931\u8D25\uFF1A{error}",
  // ─── 汇总结转（余额承接进新账本，旧账本归档） ───────────────
  "modal.rollover.title": "\u6C47\u603B\u7ED3\u8F6C",
  "modal.rollover.newPath": "\u65B0\u8D26\u672C\u8DEF\u5F84",
  "modal.rollover.newPath.desc": "\u7ED3\u8F6C\u540E\u8D26\u672C\u5C06\u6307\u5411\u6B64\u65B0\u6587\u4EF6\uFF08\u65E7\u8D26\u672C\u4FDD\u7559\u4F5C\u5F52\u6863\uFF09",
  "modal.rollover.cutoff": "\u7ED3\u8F6C\u622A\u6B62\u65E5",
  "modal.rollover.cutoff.desc": "\u4EC5\u628A\u622A\u81F3\u8BE5\u65E5\u7684\u300C\u5DF2\u5165\u8D26\u300D\u4F59\u989D\u627F\u63A5\u8FDB\u65B0\u8D26\u672C\uFF1B\u672A\u5165\u8D26\u8349\u7A3F\u4E0D\u53D7\u5F71\u54CD",
  "modal.rollover.cutoff.today": "\u622A\u81F3\u4ECA\u5929",
  "modal.rollover.cutoff.monthEnd": "\u622A\u81F3\u672C\u6708\u672B",
  "modal.rollover.submit": "\u6267\u884C\u7ED3\u8F6C",
  "modal.rollover.success": "\u5DF2\u7ED3\u8F6C\uFF1A\u65E7\u8D26\u672C {oldLedgerPath} \u5F52\u6863\uFF0C\u65B0\u8D26\u672C {newLedgerPath}",
  "modal.rollover.error": "\u7ED3\u8F6C\u5931\u8D25\uFF1A{error}",
  // ─── 存档管理（archiveLedgers 可视化 / 清理） ─────────────
  "settings.archiveManager": "\u5B58\u6863\u7BA1\u7406",
  "modal.archive.title": "\u5B58\u6863\u7BA1\u7406",
  "modal.archive.desc": "\u6C47\u603B\u7ED3\u8F6C\u4EA7\u751F\u7684\u65E7\u8D26\u672C\u4F1A\u5F52\u6863\u4E8E\u6B64\u3002\u53EF\u5728\u6B64\u67E5\u770B\u6216\u79FB\u51FA\u5F52\u6863\uFF08\u79FB\u51FA\u4EC5\u4ECE\u7D22\u5F15\u79FB\u9664\uFF0C\u4E0D\u4F1A\u5220\u9664\u78C1\u76D8\u6587\u4EF6\uFF09",
  "modal.archive.empty": "\u6682\u65E0\u5F52\u6863\u8D26\u672C",
  "modal.archive.count": "\u5171 {n} \u4E2A\u5F52\u6863\u8D26\u672C",
  "modal.archive.status.exists": "\u6587\u4EF6\u5B58\u5728",
  "modal.archive.status.missing": "\u6587\u4EF6\u5DF2\u5220\u9664\uFF08\u4ECD\u53EF\u79FB\u51FA\u5F52\u6863\uFF09",
  "modal.archive.open": "\u6253\u5F00",
  "modal.archive.remove": "\u79FB\u51FA\u5F52\u6863",
  "modal.archive.confirmRemove": '\u786E\u5B9A\u5C06\u300C{path}\u300D\u79FB\u51FA\u5F52\u6863\uFF1F\u79FB\u51FA\u540E\u4EC5\u4ECE\u7D22\u5F15\u79FB\u9664\u3001\u4E0D\u5220\u9664\u6587\u4EF6\uFF1B\u8BE5\u8D26\u672C\u7684\u5386\u53F2\u4EA4\u6613\u5C06\u4E0D\u518D\u88AB\u7D22\u5F15\uFF08finance-log \u6309 id \u5F15\u7528\u53EF\u80FD\u53D8\u4E3A"\u672A\u627E\u5230"\uFF09',
  "modal.archive.removed": "\u5DF2\u79FB\u51FA\u5F52\u6863\uFF1A{path}",
  // ─── 代码块名称 ─────────────────────────────────────────
  "block.fin-beancount": "\u590D\u5F0F\u8BB0\u8D26\u5206\u5F55",
  "block.fin-beancount.desc": "\u8BB0\u5F55\u4E00\u7B14\u590D\u5F0F\u6536\u652F\uFF08\u6765\u6E90 + \u53BB\u5411\uFF0C\u96F6\u548C\u6821\u9A8C\uFF09",
  "block.finance-log": "\u6D41\u6C34\u89C6\u56FE",
  "block.finance-log.desc": "\u4ECE\u8D26\u672C\u53D6\u6570\uFF0C\u5012\u5E8F\u5C55\u793A\u4EA4\u6613\u6D41\u6C34\uFF1B\u53EF\u6309\u8D77\u59CB\u65E5\u671F / \u5929\u6570 / \u91D1\u989D\u8303\u56F4 / \u8D26\u6237 / \u7C7B\u578B / \u5F52\u5C5E\u7B5B\u9009",
  "block.finance-budget": "\u9884\u7B97\u6267\u884C",
  "block.finance-budget.desc": "\u6309\u5206\u7C7B\u5C55\u793A\u9884\u7B97\u6267\u884C\u7387\uFF0C\u542B\u5468\u671F\u8FDB\u5EA6\u6761\u4E0E\u4E09\u6863\u8FBE\u6210\u72B6\u6001",
  "block.finance-heatmap": "\u6536\u652F\u70ED\u529B\u56FE",
  "block.finance-heatmap.desc": "\u6309\u51C0\u989D\u7740\u8272\u7684\u6536\u652F\u70ED\u529B\u56FE\uFF08\u7EFF=\u6536\u5165\u3001\u7EA2=\u652F\u51FA\uFF09\uFF1A\u603B\u89C8\u65E5\u5386 + \u5206\u7C7B\u77E9\u9635\u53CC\u89C6\u89D2\uFF0C\u8FD1 N \u5929\uFF08\u9ED8\u8BA4 182\uFF09\uFF0C\u53EF\u7B5B\u9009\u5206\u7C7B",
  "block.finance-ficalc": "\u73B0\u91D1\u6D41\u6A21\u62DF\u5668",
  "block.finance-ficalc.desc": "\u6295\u5F71\u957F\u671F\u8D44\u4EA7\u4E0E\u73B0\u91D1\u6D41\uFF0C\u6A21\u62DF\u4EBA\u751F\u4E8B\u4EF6\u51B2\u51FB",
  // ─── 代码块参数标签 ─────────────────────────────────────
  "param.day": "\u5929\u6570",
  "param.day.desc": "\u4ECE\u8D77\u59CB\u65E5\u5F80\u524D\u6570 N \u5929\uFF08\u542B\u8D77\u59CB\u65E5\uFF0C\u9ED8\u8BA4 30\uFF1B1=\u53EA\u770B\u8D77\u59CB\u65E5\u5F53\u5929\uFF1B0=\u4E0D\u9650\u5929\u6570\uFF09",
  "param.id": "\u8D26\u76EE ID",
  "param.id.desc": "\u6309\u5757\u5F15\u7528 ID \u7CBE\u786E\u67E5\u8BE2\u5355\u7B14\u8D26\uFF08\u53EF\u9009\uFF09\uFF1B\u591A\u4E2A\u7528 ; \u5206\u9694\uFF0C\u586B\u4E86\u5C31\u5FFD\u7565\u65E5\u671F\u8303\u56F4",
  "param.type": "\u4EA4\u6613\u7C7B\u578B",
  "param.type.desc": "\u6309\u4EA4\u6613\u7C7B\u578B\u7B5B\u9009\uFF08\u53EF\u9009\uFF0C\u7559\u7A7A=\u5168\u90E8\uFF09",
  "param.logDate": "\u8D77\u59CB\u65E5\u671F",
  "param.logDate.desc": "\u4ECE\u54EA\u5929\u5F00\u59CB\u5F80\u524D\u67E5\uFF08\u53EF\u9009\uFF0C\u9ED8\u8BA4\u4ECA\u5929\uFF09\u3002\u5982\u586B 2026-07-15\u3001\u5929\u6570\u586B 3\uFF0C\u5219\u67E5 07-13 ~ 07-15",
  "param.logAmount": "\u91D1\u989D\u8303\u56F4",
  "param.logAmount.desc": "\u6309\u91D1\u989D\u7EDD\u5BF9\u503C\u7B5B\u9009\uFF0C\u5355\u4F4D\u5143\uFF08\u53EF\u9009\uFF09\u3002\u5148\u9009\u8FD0\u7B97\u7B26\u518D\u586B\u6570\uFF1A\u5927\u4E8E/\u5927\u4E8E\u7B49\u4E8E/\u5C0F\u4E8E/\u5C0F\u4E8E\u7B49\u4E8E/\u4E4B\u95F4/\u7B49\u4E8E",
  "param.amount.op.gt": "\u5927\u4E8E",
  "param.amount.op.gte": "\u5927\u4E8E\u7B49\u4E8E",
  "param.amount.op.lt": "\u5C0F\u4E8E",
  "param.amount.op.lte": "\u5C0F\u4E8E\u7B49\u4E8E",
  "param.amount.op.between": "\u4E4B\u95F4",
  "param.amount.op.eq": "\u7B49\u4E8E",
  "param.logAccount": "\u8D26\u6237",
  "param.logAccount.desc": "\u6309\u8D26\u6237\u7B5B\u9009\uFF0C\u4EFB\u4E00\u5206\u5F55\u547D\u4E2D\u5373\u7B97\uFF08\u53EF\u9009\uFF0C\u7559\u7A7A=\u5168\u90E8\uFF09",
  "param.logOwner": "\u5F52\u5C5E\u7EF4\u5EA6",
  "param.logOwner.desc": "\u6309\u5F52\u5C5E\u7EF4\u5EA6\u7B5B\u9009\uFF08\u53EF\u9009\uFF0C\u7559\u7A7A=\u5168\u90E8\uFF09",
  "param.rate": "\u5E74\u5229\u7387",
  "param.rate.desc": "\u5E74\u5316\u6536\u76CA\u7387 %\uFF08\u9ED8\u8BA4 4\uFF09",
  "param.principal": "\u751F\u606F\u672C\u91D1",
  "param.principal.desc": "\u53EF\u7528\u4E8E\u9000\u4F11\u652F\u53D6\u7684\u751F\u606F\u7C7B\u8D44\u4EA7\u672C\u91D1\uFF08\u4E07\uFF09",
  "param.spend": "\u5E74\u82B1\u8D39",
  "param.spend.desc": "\u6BCF\u5E74\u82B1\u8D39\uFF08\u4E07\uFF09",
  "param.date": "\u65E5\u671F",
  "param.date.desc": "\u4EA4\u6613\u65E5\u671F\uFF08\u9ED8\u8BA4\u4ECA\u5929\uFF09",
  "param.narration": "\u6458\u8981",
  "param.narration.desc": "\u4EA4\u6613\u6458\u8981 / \u5907\u6CE8",
  "param.amount": "\u91D1\u989D\uFF08\u5143\uFF09",
  "param.amount.desc": "\u4EA4\u6613\u91D1\u989D\uFF0C\u5355\u4F4D\u5143\uFF0C\u6700\u591A\u4E24\u4F4D\u5C0F\u6570\uFF08\u5982 35.00\uFF09",
  "param.fromAccount": "\u6765\u6E90\u8D26\u6237",
  "param.fromAccount.desc": "\u94B1\u4ECE\u54EA\u4E2A\u8D26\u6237\u51FA\uFF08\u9ED8\u8BA4\u4E0A\u6B21\u4F7F\u7528\u7684\u652F\u51FA\u8D26\u6237\uFF09",
  "param.toAccount": "\u53BB\u5411",
  "param.toAccount.desc": "\u82B1\u5728\u4EC0\u4E48\u4E0A / \u8F6C\u5230\u54EA\u4E2A\u8D26\u6237",
  "param.txnType": "\u4EA4\u6613\u7C7B\u578B",
  "param.txnType.desc": "\u6536\u652F\u5206\u7C7B",
  "param.owner": "\u5F52\u5C5E",
  "param.owner.desc": "\u5F52\u5C5E\u7EF4\u5EA6\uFF08\u81EA\u5DF1 / \u5BB6\u5EAD\uFF09",
  "param.legs": "\u590D\u5F0F\u5206\u5F55",
  "param.legs.desc": "\u6BCF\u6761\u5206\u5F55\uFF1A\u9009\u8D26\u6237 + \u586B\u6B63\u6570\u91D1\u989D\uFF1B\u501F\u8D37\u7B26\u53F7\u7531\u8D26\u6237\u7C7B\u522B\u81EA\u52A8\u63A8\u5BFC\u3002\u70B9\u300C\u62C6\u5206\u5206\u5F55\u300D\u53EF\u52A0\u591A\u6761\uFF0C\u70B9\u300C\u4E00\u952E\u8865\u5E73\u300D\u81EA\u52A8\u8865\u9F50\u5DEE\u989D\u3002",
  // ─── 多腿录入编辑器（fin-beancount） ─────────────────────
  "legs.account": "\u8D26\u6237",
  "legs.amount": "\u91D1\u989D\uFF08\u5143\uFF09",
  "legs.amountHint": "\u53EA\u586B\u6B63\u6570 \xB7 \u4E24\u6761\u5206\u5F55\u81EA\u52A8\u76F8\u7B49",
  "legs.mirrorNote": "\u4E24\u6761\u5206\u5F55\u91D1\u989D\u81EA\u52A8\u76F8\u7B49",
  "legs.add": "+ \u62C6\u5206\u5206\u5F55\uFF08\u4E00\u7B14\u62C6\u591A\u7C7B\uFF09",
  "legs.balance": "\u4E00\u952E\u8865\u5E73",
  "legs.balanced": "\u5DF2\u5E73\u8861",
  "legs.flip": "\u53CD\u8F6C\u65B9\u5411",
  "legs.remove": "\u5220\u9664",
  "legs.needTwo": "\u81F3\u5C11\u9700\u8981 2 \u6761\u5206\u5F55",
  "legs.needAccount": "\u6BCF\u6761\u5206\u5F55\u90FD\u8981\u586B\u5199\u8D26\u6237",
  "legs.needAmount": "\u6BCF\u6761\u5206\u5F55\u90FD\u8981\u586B\u5199\u6B63\u6570\u91D1\u989D",
  "legs.unbalanced": "\u5206\u5F55\u672A\u5E73\u8861\uFF08\u5DEE\u989D \xA5{diff}\uFF09\uFF0C\u8BF7\u70B9\u300C\u4E00\u952E\u8865\u5E73\u300D\u6216\u8C03\u6574\u91D1\u989D",
  "legs.dir.in": "\u589E\u52A0",
  "legs.dir.out": "\u51CF\u5C11",
  "legs.dir.src": "\u6765\u6E90",
  "legs.dir.sink": "\u53BB\u5411",
  "legs.dir.flat": "\u6743\u76CA",
  "legs.class.asset": "\u8D44\u4EA7\u8D26\u6237",
  "legs.class.liability": "\u8D1F\u503A\u8D26\u6237",
  "legs.class.equity": "\u6743\u76CA\u8D26\u6237",
  "legs.class.income": "\u6536\u5165\u8D26\u6237",
  "legs.class.expense": "\u8D39\u7528\u8D26\u6237",
  "legs.class.account": "\u8D26\u6237",
  "param.budgetType": "\u4EA4\u6613\u7C7B\u578B",
  "param.budgetType.desc": "\u6309\u4EA4\u6613\u7C7B\u578B\u7B5B\u9009\u9884\u7B97\u8BA1\u5212\uFF08\u53EF\u9009\uFF0C\u7559\u7A7A\u663E\u793A\u5168\u90E8\uFF09",
  "param.heatmapDays": "\u5929\u6570",
  "param.heatmapDays.desc": "\u6536\u652F\u70ED\u529B\u56FE\u663E\u793A\u6700\u8FD1 N \u5929\uFF08\u9ED8\u8BA4 182\uFF0C\u8303\u56F4 7\u2013365\uFF1B\u586B\u51E0\u5929\u5C31\u663E\u793A\u6700\u8FD1\u51E0\u5929\u7684\u70B9\uFF09",
  "param.heatmapView": "\u9ED8\u8BA4\u89C6\u56FE",
  "param.heatmapView.desc": "\u603B\u89C8\u65E5\u5386\uFF08\u65E5\u7C92\u5EA6\uFF0C\u4E00\u773C\u770B\u6536\u652F\u8282\u594F\uFF09\u6216\u5206\u7C7B\u77E9\u9635\uFF08\u5206\u7C7B \xD7 \u65F6\u95F4\uFF09",
  "param.heatmapGran": "\u77E9\u9635\u7C92\u5EA6",
  "param.heatmapGran.desc": "\u5206\u7C7B\u77E9\u9635\u7684\u5217\u7C92\u5EA6\uFF1A\u6309\u5468\u6216\u6309\u6708\uFF08\u4EC5\u77E9\u9635\u89C6\u56FE\u751F\u6548\uFF09",
  "param.heatmapCategory": "\u5206\u7C7B\u7B5B\u9009",
  "param.heatmapCategory.desc": "\u53EA\u770B\u67D0\u5206\u7C7B\u7684\u6536\u652F\uFF08\u53EF\u9009\uFF0C\u7559\u7A7A\u663E\u793A\u5168\u90E8\u5206\u7C7B\uFF09",
  // ─── ficalc / fi 合并后新增参数 ─────────────────────────
  "param.source": "\u6570\u636E\u6E90",
  "param.source.desc": "actual=\u4ECE\u8D26\u672C\u53D6\u51C0\u503C/\u82B1\u8D39/\u50A8\u84C4\uFF0Cmanual=\u7528\u4E0B\u65B9\u624B\u586B\u5047\u8BBE",
  "param.savings": "\u5E74\u51C0\u50A8\u84C4",
  "param.savings.desc": "\u6BCF\u5E74\u51C0\u7ED3\u4F59\uFF08\u4E07\uFF09",
  "param.inflation": "\u901A\u80C0\u7387",
  "param.inflation.desc": "\u5E74\u901A\u80C0\u7387 %\uFF08\u9ED8\u8BA4 2\uFF09",
  "param.years": "\u9884\u6D4B\u5E74\u9650",
  "param.years.desc": "\u9000\u4F11\u540E\u9884\u6D4B\u591A\u5C11\u5E74\uFF08\u9ED8\u8BA4\u81EA\u52A8\u6309\u81F3 95 \u5C81\u8BA1\u7B97\uFF09",
  "param.volatility": "\u6CE2\u52A8\u7387",
  "param.volatility.desc": "\u5E74\u5316\u6536\u76CA\u6CE2\u52A8 %\uFF08\u9ED8\u8BA4 12\uFF1B0=\u65E0\u6CE2\u52A8\u786E\u5B9A\u6027\u6A21\u62DF\uFF09",
  "param.strategy": "\u63D0\u53D6\u7B56\u7565",
  "param.strategy.desc": "\u672C\u91D1\u8017\u5C3D\u524D\u7684\u5E74\u5EA6\u63D0\u53D6\u65B9\u5F0F",
  // ─── 渲染块 UI ──────────────────────────────────────────
  "param.age": "\u5F53\u524D\u5E74\u9F84",
  "param.age.desc": "\u5F00\u59CB\u6A21\u62DF\u7684\u5E74\u9F84",
  "param.startAge": "\u8D77\u59CB\u5E74\u9F84",
  "param.startAge.desc": "\u56FE\u8868 x \u8F74\u8D77\u70B9\uFF08\u65E9\u4E8E\u5F53\u524D\u5E74\u9F84\u65F6\u4ECE\u8BB0\u8D26\u6570\u636E\u63D0\u53D6\u5386\u53F2\u51C0\u8D44\u4EA7\uFF09",
  "param.retireAge": "\u9000\u4F11\u5E74\u9F84",
  "param.retireAge.desc": "\u505C\u6B62\u79EF\u7D2F\u3001\u5F00\u59CB\u652F\u53D6\u7684\u5E74\u7EAA",
  "param.incomeGrowth": "\u50A8\u84C4\u589E\u957F",
  "param.incomeGrowth.desc": "\u79EF\u7D2F\u671F\u5E74\u51C0\u50A8\u84C4\u7684\u5E74\u589E\u901F %",
  "param.cashRate": "\u73B0\u91D1\u6536\u76CA\u7387",
  "param.cashRate.desc": "\u73B0\u91D1\u7C7B\u8D44\u4EA7\u7684\u5E74\u5316\u6536\u76CA\u7387 %\uFF08\u9ED8\u8BA4 1.5\uFF09",
  "param.bufferMonths": "\u5E94\u6025\u91D1\u6708\u6570",
  "param.bufferMonths.desc": "\u9884\u7559 N \u4E2A\u6708\u652F\u51FA\u4F5C\u5E94\u6025\u91D1\uFF08\u4E0D\u589E\u957F\uFF09\uFF0C\u9ED8\u8BA4 6\uFF1B\u4EC5\u8D44\u4EA7\u6A21\u5F0F\u751F\u6548",
  "ficalc.title": "\u73B0\u91D1\u6D41\u6A21\u62DF\u5668",
  "ficalc.basic": "\u57FA\u672C\u53C2\u6570",
  "ficalc.banner.free": "\u5DF2\u5B9E\u73B0\u8D22\u52A1\u81EA\u7531",
  "ficalc.banner.free.desc": "\u88AB\u52A8\u6536\u5165\u8986\u76D6\u5E74\u82B1\u8D39\uFF0C\u94B1\u6C38\u8FDC\u82B1\u4E0D\u5B8C",
  "ficalc.banner.notFree": "\u5C1A\u672A\u8D22\u52A1\u81EA\u7531",
  "ficalc.banner.notFree.desc": "\u8FD8\u5DEE {gap} \u672C\u91D1",
  "ficalc.metric.requiredPrincipal": "\u6240\u9700\u672C\u91D1",
  "ficalc.metric.requiredPrincipal.desc": "\u8FBE\u5230\u81EA\u7531\u9700\u8981\u7684\u603B\u672C\u91D1",
  "ficalc.metric.gap": "\u672C\u91D1\u7F3A\u53E3",
  "ficalc.metric.gap.desc": "\u8DDD\u81EA\u7531\u8FD8\u5DEE\u591A\u5C11",
  "ficalc.metric.gap.done": "\u5DF2\u8FBE\u6210",
  "ficalc.metric.years": "\u53EF\u6491\u5E74\u6570",
  "ficalc.metric.years.desc": "\u5F53\u524D\u672C\u91D1+\u82B1\u8D39\u80FD\u7EF4\u6301\u591A\u4E45",
  "ficalc.metric.maxSpend": "\u53EF\u6301\u7EED\u5E74\u82B1\u8D39",
  "ficalc.metric.maxSpend.desc": "\u4E0D\u5403\u8001\u672C\u7684\u5E74\u82B1\u8D39\u4E0A\u9650",
  "log.title": "\u6D41\u6C34\u9762\u677F",
  "log.loading": "\u52A0\u8F7D\u4E2D\u2026",
  "log.empty": "\u6682\u65E0\u4EA4\u6613\u8BB0\u5F55",
  "log.emptyFiltered": "\u6CA1\u6709\u7B26\u5408\u7B5B\u9009\u6761\u4EF6\u7684\u8D26\u76EE\uFF08\u8BD5\u8BD5\u653E\u5BBD\u91D1\u989D / \u8D26\u6237 / \u7C7B\u578B / \u5F52\u5C5E\u6761\u4EF6\uFF09",
  "log.readError": "\u8BFB\u53D6\u5931\u8D25",
  "log.dayLabel.today": "\u4ECA\u65E5",
  "log.dayLabel.days": "\u8FD1 {n} \u5929",
  "log.dayLabel.dateOnly": "{d} \u5F53\u65E5",
  "log.dayLabel.daysUntil": "{d} \u8D77\u8FD1 {n} \u5929",
  "log.dayLabel.until": "{d} \u53CA\u4EE5\u524D",
  "log.dayLabel.byId": "\u6309 ID \u67E5\u8BE2",
  "log.idNotFound": "\u672A\u627E\u5230\u5BF9\u5E94 ID \u7684\u8D26\u76EE\uFF08\u8BF7\u68C0\u67E5 ID \u662F\u5426\u6B63\u786E\uFF0C\u6216\u5148\u5B8C\u6210\u5165\u8D26\uFF09",
  "log.dayLabel.all": "\u5168\u90E8",
  "log.criteria.amount": "\u91D1\u989D",
  "log.criteria.account": "\u8D26\u6237",
  "log.criteria.type": "\u7C7B\u578B",
  "log.criteria.owner": "\u5F52\u5C5E",
  "log.count": "{label} \xB7 \u5171 {n} \u7B14",
  "log.noNarration": "\uFF08\u65E0\u6458\u8981\uFF09",
  "log.filter.all": "\u5168\u90E8",
  "log.filter.in": "\u6536\u5165",
  "log.filter.out": "\u652F\u51FA",
  "log.summary.show": "\u663E\u793A {n} \u7B14",
  "log.summary.income": "\u6536\u5165",
  "log.summary.expense": "\u652F\u51FA",
  "log.summary.net": "\u51C0\u989D",
  "log.summary.count": "\u5171 {n} \u7B14",
  // ─── 流水面板 v2.5（kind 分类 · 方向 · 头条 · 筛选） ────────
  "log.filter.kindLabel": "\u4EA4\u6613\u7C7B\u578B",
  "log.filter.allAccounts": "\u5168\u90E8\u8D26\u6237",
  "log.filter.searchPlaceholder": "\u641C\u7D22\u6458\u8981 / \u8D26\u6237\u2026",
  "log.kind.transfer": "\u8F6C\u8D26",
  "log.kind.buy": "\u4E70\u8D44\u4EA7",
  "log.kind.sell": "\u5356\u8D44\u4EA7",
  "log.kind.income": "\u6536\u5165",
  "log.kind.expense": "\u652F\u51FA",
  "log.kind.opening": "\u671F\u521D\u5EFA\u8D26",
  "log.kind.equity": "\u6743\u76CA\u53D8\u52A8",
  "log.dir.in": "\u6D41\u5165",
  "log.dir.out": "\u6D41\u51FA",
  "log.dir.transfer": "\u8F6C\u8D26",
  "log.headline.inflow": "\u6D41\u5165",
  "log.headline.outflow": "\u6D41\u51FA",
  "log.headline.buyAsset": "\u4E70\u5165\u8D44\u4EA7",
  "log.headline.sellAsset": "\u5356\u51FA\u8D44\u4EA7",
  "log.headline.transfer": "\u8F6C\u8D26",
  "log.headline.opening": "\u6743\u76CA",
  "log.headline.equity": "\u6743\u76CA\u53D8\u52A8",
  "log.headline.realized": "\u5DF2\u5B9E\u73B0",
  "beancount.ok": "\u2713 {n} \u7B14\u4EA4\u6613\uFF0C\u96F6\u548C\u6821\u9A8C\u901A\u8FC7",
  "beancount.post": "\u5165\u8D26",
  "beancount.posted": "\u2713 \u5DF2\u5165\u8D26",
  "beancount.batchPost": "\u6279\u91CF\u5165\u8D26\uFF08{n} \u7B14\uFF09",
  "beancount.batchPostSuccess": "\u6279\u91CF\u5165\u8D26\u6210\u529F\uFF1A{success}/{total} \u7B14",
  "beancount.postedEditWarning": "\u26A0 \u5DF2\u5165\u8D26\u7684\u4EA4\u6613\u96F6\u548C\u4E0D\u5E73\u8861\uFF0C\u8BF7\u5230\u8D26\u672C\u4E2D\u4FEE\u6B63",
  "beancount.rollover": "\u6C47\u603B\u7ED3\u8F6C",
  "beancount.postSuccess": "\u5165\u8D26\u6210\u529F\uFF0C\u5DF2\u5199\u5165 {ledgerPath}",
  "beancount.postError.noFile": "\u65E0\u6CD5\u627E\u5230\u6E90\u6587\u4EF6",
  "beancount.postError.notFound": "\u65E0\u6CD5\u5B9A\u4F4D\u4EE3\u7801\u5757\u4F4D\u7F6E",
  "beancount.postError.generic": "\u5165\u8D26\u5931\u8D25\uFF1A{error}",
  // ─── 入账服务（poster）错误文案 ───────────────────────────
  "poster.err.notFound": "\u627E\u4E0D\u5230\u7B2C {n} \u6761\u8BB0\u5F55",
  "poster.err.postedTxn": "\u8BE5\u4EA4\u6613\u5DF2\u5165\u8D26\uFF0C\u4E0D\u80FD\u91CD\u590D\u5165\u8D26",
  "poster.err.postedVal": "\u8BE5\u4F30\u503C\u5DF2\u5165\u8D26\uFF0C\u4E0D\u80FD\u91CD\u590D\u5165\u8D26",
  "poster.err.noValuation": "\u672A\u627E\u5230\u4F30\u503C\u8BB0\u5F55",
  "poster.err.noTxn": "\u672A\u627E\u5230\u4EA4\u6613\u8BB0\u5F55",
  "poster.err.writeFailed": "\u5199\u5165\u8D26\u672C\u5931\u8D25\uFF1A{error}",
  "poster.err.unknown": "\u672A\u77E5\u9519\u8BEF",
  "poster.err.blockMoved": "\u4EE3\u7801\u5757\u4F4D\u7F6E\u5DF2\u53D8\u5316\uFF0C\u65E0\u6CD5\u539F\u4F4D\u66FF\u6362\uFF08\u5DF2\u5165\u8D26\u6210\u529F\uFF0C\u8349\u7A3F\u4FDD\u7559\u5728\u539F\u7B14\u8BB0\uFF09",
  // ─── 解析器（fin-beancount）错误文案 ──────────────────────
  "parser.err.noPostings": "\u4EA4\u6613\u65E0\u5206\u5F55\u884C\uFF1A{date} {narration}",
  "parser.err.zeroSum": "\u96F6\u548C\u4E0D\u5E73\u8861\uFF08\u5DEE\u989D {diff} \u5206\uFF09\uFF1A{date} {narration}",
  "parser.err.noDateCtx": "\u65E0\u6CD5\u8BC6\u522B\u7684\u884C\uFF08\u7F3A\u5C11\u65E5\u671F\u884C\u4E0A\u4E0B\u6587\uFF09\uFF1A{line}",
  "parser.err.unparsable": "\u65E0\u6CD5\u89E3\u6790\u7684\u884C\uFF1A{line}",
  // ─── 复式分录重写（视觉重设计） ────────────────────────────
  "beancount.title": "\u590D\u5F0F\u5206\u5F55",
  "beancount.draftPill": "\u8349\u7A3F",
  "beancount.currentPill": "\u5F53\u524D\u8D26\u76EE",
  "beancount.addRecord": "\u6DFB\u52A0\u8BB0\u5F55",
  "beancount.draftCount": "{n} \u7B14\u5F85\u5165\u8D26",
  "beancount.count": "\u5171 {n} \u7B14",
  "beancount.zeroSum": "\u6821\u9A8C\u901A\u8FC7",
  "beancount.pending": "\u5F85\u5165\u8D26",
  "beancount.rolledTo": "\u5DF2\u7ED3\u8F6C\u81F3",
  "beancount.rolled": "\u5DF2\u7ED3\u8F6C",
  "beancount.fromRollover": "\u627F\u63A5\u81EA",
  "beancount.chainCap": "\u8D26\u672C\u94FE",
  "beancount.summary.income": "\u6536\u5165",
  "beancount.summary.expense": "\u652F\u51FA",
  "beancount.summary.net": "\u51C0\u989D",
  "beancount.copyTitle": "\u590D\u5236\u8BE5\u8BB0\u5F55\u4EE3\u7801\u5757\uFF0C\u7528\u4E8E finance-log \u7CBE\u51C6\u67E5\u8BE2",
  "beancount.copyFullTitle": "\u590D\u5236\u8BE5\u8BB0\u5F55\u4EE3\u7801\u5757",
  "beancount.copyLabel": "\u590D\u5236",
  "beancount.copyDone": "\u5DF2\u590D\u5236",
  // 软告警层（报告 #1）：只提示、不拦截入账
  "beancount.warn.signFlipped": "\u7B26\u53F7\u53EF\u80FD\u53CD\u4E86",
  "beancount.warn.signFlippedTip": "{accounts} \u662F\u6536\u5165/\u652F\u51FA\u7C7B\u8D26\u6237\uFF0C\u4F46\u7B26\u53F7\u4E0E\u5E38\u89C4\u76F8\u53CD\uFF08\u6536\u5165\u8BB0\u8D1F\u3001\u652F\u51FA\u8BB0\u6B63\uFF09\u3002\u82E5\u8FD9\u7B14\u662F\u9000\u6B3E\u51B2\u9500\uFF0C\u53EF\u5FFD\u7565\u672C\u63D0\u793A\u3002",
  "beancount.warn.unclassified": "\u8D26\u6237\u672A\u58F0\u660E",
  "beancount.warn.unclassifiedTip": "{accounts} \u672A\u5728\u8D26\u6237\u7BA1\u7406\u4E2D\u58F0\u660E\u7C7B\u522B\uFF0C\u4E5F\u6CA1\u6709\u7236\u8D26\u6237\u53EF\u7EE7\u627F\u2014\u2014\u8FD9\u4E9B\u8D26\u6237\u4E0D\u4F1A\u8BA1\u5165\u8D44\u4EA7\u603B\u89C8\u4E0E\u9884\u7B97\u3002",
  "beancount.warn.tagMismatch": "\u6807\u7B7E\u4E0E\u7ED3\u6784\u4E0D\u7B26",
  "beancount.warn.tagMismatchTip": "\u6807\u7B7E\u300C{tag}\u300D\u58F0\u660E\u4E3A{direction}\u7C7B\uFF0C\u4F46\u8FD9\u7B14\u4EA4\u6613\u91CC\u6CA1\u6709{direction}\u8D26\u6237\u5206\u5F55\u3002\u82E5\u5B83\u5176\u5B9E\u53EA\u662F\u8D44\u4EA7\u8F6C\u6362\uFF08\u4E70\u80A1\u7968\u3001\u8FD8\u8D37\uFF09\uFF0C\u8BE5\u6807\u7B7E\u4F1A\u6C61\u67D3\u7B5B\u9009\u4E0E\u9884\u7B97\u7EDF\u8BA1\u3002",
  "beancount.warn.foot": "{n} \u7B14\u6709\u5F85\u786E\u8BA4\u63D0\u793A",
  "beancount.warn.dirIncome": "\u6536\u5165",
  "beancount.warn.dirExpense": "\u652F\u51FA",
  "beancount.addRecordFailed": "\u65E0\u6CD5\u5728\u8BE5\u7B14\u8BB0\u4E2D\u63D2\u5165\u8BB0\u5F55",
  "beancount.group.flat": "\u6BCF\u7B14",
  "beancount.group.day": "\u6309\u5929",
  "beancount.group.week": "\u6309\u5468",
  "beancount.group.month": "\u6309\u6708",
  "beancount.group.custom": "\u81EA\u5B9A\u4E49",
  "beancount.group.start": "\u8D77\u59CB",
  "beancount.group.every": "\u6BCF",
  "beancount.group.unit": "\u5929\u4E00\u7EC4",
  "beancount.group.expandAll": "\u5C55\u5F00",
  "beancount.group.collapseAll": "\u6536\u8D77",
  "beancount.group.count": "{n} \u7B14",
  "beancount.group.all": "\u5168\u90E8",
  "beancount.group.weekday0": "\u5468\u65E5",
  "beancount.group.weekday1": "\u5468\u4E00",
  "beancount.group.weekday2": "\u5468\u4E8C",
  "beancount.group.weekday3": "\u5468\u4E09",
  "beancount.group.weekday4": "\u5468\u56DB",
  "beancount.group.weekday5": "\u5468\u4E94",
  "beancount.group.weekday6": "\u5468\u516D",
  "beancount.group.monthLabel": "{year}\u5E74{month}\u6708",
  // ─── 资产估值（fb-valuation，在 fin-beancount 块内渲染） ───
  "valuation.title": "\u8D44\u4EA7\u4F30\u503C",
  "valuation.sectionTxn": "\u4EA4\u6613",
  "valuation.sectionVal": "\u4F30\u503C\u5FEB\u7167",
  "valuation.containsPill": "\u542B {n} \u6761\u4F30\u503C",
  "valuation.addValuation": "\u6DFB\u52A0\u4F30\u503C",
  "valuation.draftCount": "{n} \u6761\u5F85\u5165\u8D26",
  "valuation.count": "\u5171 {n} \u6761\u4F30\u503C \xB7 {a} \u4E2A\u8D26\u6237",
  "valuation.batchPost": "\u6279\u91CF\u5165\u8D26\uFF08{n} \u6761\uFF09",
  "valuation.noHistory": "\u65E0\u5386\u53F2",
  "valuation.vs": "vs {date}",
  "valuation.sameDaySuffix": "\uFF08\u540C\u65E5\uFF09",
  "valuation.bookLabel": "\u8D26\u9762 {amount}",
  "valuation.unrealized": "\u672A\u5B9E\u73B0 {amount}",
  "valuation.kind.market": "\u5E02\u503C\u8BA1\u4EF7",
  "valuation.kind.book": "\u8D26\u9762\u8BA1\u4EF7",
  "valuation.kind.unknown": "\u672A\u914D\u7F6E",
  "valuation.meta.kind": "\u8BA1\u4EF7: {kind}",
  "valuation.meta.owner": "owner: {owner}",
  "valuation.meta.gap": "\u8DDD\u4E0A\u6B21 {n} \u5929",
  "valuation.meta.stale": "\u26A0 \u4F30\u503C\u8FC7\u671F\uFF08\u9608\u503C {n} \u5929\uFF09",
  "valuation.meta.unknownAccount": "\u26A0 \u8D26\u6237\u672A\u5728 finance-config \u4E2D\u5B9A\u4E49",
  "valuation.meta.bookWarn": "\u8BE5\u8D26\u6237 valuation: book\uFF0C\u4F30\u503C\u4E0D\u53C2\u4E0E\u5E02\u503C\u53E3\u5F84",
  "valuation.meta.bookSuggest": "\u5EFA\u8BAE\u6539\u4E3A market",
  "valuation.meta.sameDay": "\u540C\u65E5\u5DF2\u6709\u4F30\u503C\uFF0C\u5165\u8D26\u540E\u4EE5\u672C\u6761\u4E3A\u51C6",
  "valuation.zeroSumNote": "\u4F30\u503C\u884C\u4E0D\u53C2\u4E0E\u96F6\u548C\u6821\u9A8C \xB7 {n} \u6761",
  "valuation.banner.stale": "{n} \u4E2A\u8D26\u6237\u4F30\u503C\u5DF2\u8FC7\u671F\uFF1A{list}",
  "valuation.banner.staleItem": "{account}\uFF08\u8DDD\u4E0A\u6B21 {n} \u5929\uFF0C\u9608\u503C {threshold} \u5929\uFF09",
  "valuation.banner.unknown": "\u8D26\u6237\u300C{list}\u300D\u4E0D\u5728\u914D\u7F6E\u4E2D \u2014\u2014 \u4F30\u503C\u4F1A\u88AB\u89E3\u6790\u4F46\u65E0\u6CD5\u53C2\u4E0E\u51C0\u8D44\u4EA7\u8BA1\u7B97",
  "valuation.banner.update": "\u53BB\u66F4\u65B0",
  "valuation.group.flat": "\u6BCF\u6761",
  "valuation.group.account": "\u6309\u8D26\u6237",
  "valuation.group.month": "\u6309\u6708",
  "valuation.group.latest": "\u6700\u65B0",
  "valuation.group.times": "{n} \u6B21",
  "valuation.group.daysAgo": "{n} \u5929\u524D",
  "valuation.group.stale": "\u26A0 \u8FC7\u671F",
  "valuation.group.first": "\u9996\u6B21",
  "valuation.group.month.label": "{k} \u6708",
  "valuation.group.month.sum": "{n} \u6761\u4F30\u503C \xB7 {accounts}",
  "valuation.copyTitle": "\u590D\u5236 ^v- \u5757\u5F15\u7528\uFF0C\u7528\u4E8E\u5F15\u7528\u8BE5\u6761\u4F30\u503C",
  "valuation.empty": "\u8FD8\u6CA1\u6709\u4F30\u503C\u8BB0\u5F55 \u2014\u2014 \u70B9\u300C\u6DFB\u52A0\u4F30\u503C\u300D\u4E3A\u6309\u5E02\u503C\u8BA1\u4EF7\u7684\u8D44\u4EA7\u6253\u7B2C\u4E00\u4E2A\u5FEB\u7167",
  // ─── 预算视图 ───────────────────────────────────────────
  "budget.title": "\u9884\u7B97\u6267\u884C",
  "budget.empty": "\u6682\u65E0\u9884\u7B97\u8BA1\u5212",
  "budget.uncategorized": "\u672A\u5206\u7C7B",
  "budget.period.day": "\u6BCF\u65E5",
  "budget.period.week": "\u6BCF\u5468",
  "budget.period.month": "\u6BCF\u6708",
  "budget.period.year": "\u6BCF\u5E74",
  "budget.period.custom": "\u6BCF {n} \u65E5",
  // ─── 热力图（收支双向，v3） ──────────────────────────────
  "heatmap.title": "\u6536\u652F\u70ED\u529B\u56FE",
  "heatmap.empty": "\u6682\u65E0\u6536\u652F\u8BB0\u5F55",
  "heatmap.uncategorized": "\u672A\u5206\u7C7B",
  "heatmap.others": "\u5176\u4ED6",
  "heatmap.dayLabel": "\u8FD1 {n} \u5929",
  "heatmap.dayPrefix": "\u8FD1",
  "heatmap.daySuffix": "\u5929",
  "heatmap.dayTitle": "\u663E\u793A\u6700\u8FD1 N \u5929\uFF08\u4EE3\u7801\u5757\u53C2\u6570 day\uFF0C\u9ED8\u8BA4 182\uFF09",
  "heatmap.catFilterTitle": "\u6309\u5206\u7C7B\u7B5B\u9009",
  "heatmap.all": "\u5168\u90E8\u5206\u7C7B",
  "heatmap.dir.income": "\u6536",
  "heatmap.dir.expense": "\u652F",
  "heatmap.view.calendar": "\u603B\u89C8\u65E5\u5386",
  "heatmap.view.matrix": "\u5206\u7C7B\u77E9\u9635",
  "heatmap.gran.week": "\u6309\u5468",
  "heatmap.gran.month": "\u6309\u6708",
  "heatmap.metric.net": "\u533A\u95F4\u51C0\u989D",
  "heatmap.metric.netSub": "\u6536\u5165 \u2212 \u652F\u51FA",
  "heatmap.metric.expense": "\u603B\u652F\u51FA",
  "heatmap.metric.income": "\u603B\u6536\u5165",
  "heatmap.metric.max": "\u6700\u9AD8\u5355\u65E5",
  "heatmap.metric.daily": "\u65E5\u5747 {n}",
  "heatmap.metric.maxSub": "{date} {weekday} \xB7 {kind}",
  "heatmap.cal.hint": "\u60AC\u505C\u67E5\u770B\u5F53\u65E5\u6536\u652F \xB7 \u70B9\u51FB\u683C\u5B50\u5C55\u5F00\u5F53\u65E5\u660E\u7EC6 \xB7 \u5916\u6846\u9AD8\u4EAE\u4E3A\u4ECA\u5929 \xB7 \u865A\u6846 = \u8D85\u51FA\u8FD1 {n} \u5929\u8303\u56F4",
  "heatmap.matrix.hint": "\u70B9\u51FB\u884C\u5934\u6309\u5408\u8BA1\u6392\u5E8F \xB7 \u70B9\u51FB\u683C\u5B50\u67E5\u770B\u8BE5\u5206\u7C7B\u8BE5\u65F6\u6BB5\u660E\u7EC6 \xB7 \u60AC\u505C\u770B\u91D1\u989D / \u7B14\u6570 / \u73AF\u6BD4 \xB7 \u884C\u5C3E\u66F2\u7EBF\u4E3A\u8BE5\u5206\u7C7B\u8D70\u52BF",
  "heatmap.matrix.total": "\u5408\u8BA1",
  "heatmap.legend.income": "\u6536\u5165",
  "heatmap.legend.expense": "\u652F\u51FA",
  "heatmap.legend.note": "\u7EFF = \u51C0\u6536\u5165 \xB7 \u7EA2 = \u51C0\u652F\u51FA \xB7 \u7A7A = \u65E0\u6536\u652F",
  "heatmap.sort.hint": "\u70B9\u51FB\u884C\u5934\u6392\u5E8F \u2193\u2191",
  "heatmap.sort.desc": "\u6309\u5408\u8BA1 \u2193\uFF08\u518D\u70B9\u8FD8\u539F\uFF09",
  "heatmap.sort.asc": "\u6309\u5408\u8BA1 \u2191\uFF08\u518D\u70B9\u8FD8\u539F\uFF09",
  "heatmap.sort.tip": "\u533A\u95F4\u5408\u8BA1 \xB7 \u70B9\u51FB\u884C\u5934\u6392\u5E8F",
  "heatmap.expand.all": "\u5C55\u5F00\u5168\u90E8\u5206\u7C7B\uFF08\u5171 {n} \u4E2A\uFF09",
  "heatmap.expand.collapse": "\u6536\u8D77",
  "heatmap.tip.none": "\u65E0\u6536\u652F",
  "heatmap.tip.net": "\u51C0\u989D",
  "heatmap.tip.delta": "\u73AF\u6BD4",
  "heatmap.tip.incomeDay": "\u6536\u5165\u65E5",
  "heatmap.tip.expenseDay": "\u652F\u51FA\u65E5",
  "heatmap.detail.close": "\u5173\u95ED",
  "heatmap.detail.colCat": "\u5206\u7C7B",
  "heatmap.detail.colAmount": "\u91D1\u989D",
  "heatmap.detail.colCount": "\u7B14\u6570",
  "heatmap.detail.sum": "\u51C0\u989D",
  "heatmap.detail.count": "{n} \u7B14",
  "heatmap.detail.noData": "\u8BE5\u65F6\u6BB5\u65E0\u6536\u652F\u8BB0\u5F55",
  "heatmap.detail.dayTitle": "{date} {weekday} \xB7 \u6536\u652F\u660E\u7EC6",
  "heatmap.detail.catTitle": "{cat} \xB7 {range}",
  // ─── 财务自由计算器（重设计：finance-fi 并入 finance-ficalc） ──
  "ficalc.unit.wan": "\u4E07",
  "ficalc.unit.yi": "\u4EBF",
  "ficalc.unit.year": "\u5E74",
  "ficalc.forever": "\u6C38\u4E0D\u5230\u671F",
  "ficalc.withinYear": "\u22641\u5E74",
  "ficalc.yearsValue": "{n} \u5E74",
  "ficalc.source.actual": "\u5B9E\u9645\uFF08\u8D26\u672C\uFF09",
  "ficalc.source.manual": "\u6A21\u62DF",
  "ficalc.source.assets": "\u8D44\u4EA7\u8D26\u6237",
  "ficalc.source.noData": "\u6682\u65E0\u8D26\u672C\u6570\u636E\uFF0C\u5DF2\u5207\u6362\u4E3A\u624B\u586B",
  "ficalc.source.manual.hint": "\u6A21\u62DF\u6A21\u5F0F\uFF1A\u5F53\u524D\u6570\u5B57\u7531\u4F60\u76F4\u63A5\u8F93\u5165\uFF0C\u662F\u4E00\u4E2A\u300C\u5982\u679C\u2026\u4F1A\u600E\u6837\u300D\u7684\u63A8\u6F14\u6C99\u76D2\u3002\u5728\u300C\u8BBE\u7F6E \u203A \u8D26\u6237\u7BA1\u7406\u300D\u91CC\u914D\u7F6E\u8D44\u4EA7\u8D26\u6237\u540E\uFF0C\u672C\u5757\u4F1A\u81EA\u52A8\u5207\u6362\u4E3A\u300C\u8D44\u4EA7\u8D26\u6237\u300D\u6A21\u5F0F\u5E76\u9884\u586B\u672C\u91D1 / \u5E74\u82B1\u8D39 / \u5E74\u50A8\u84C4\u3002",
  "ficalc.source.assets.hint": "\u5DF2\u4ECE finance-config.json \u7684\u8D44\u4EA7\u8D26\u6237\u81EA\u52A8\u5206\u6876\u9884\u586B\u672C\u91D1 / \u5E74\u82B1\u8D39 / \u5E74\u50A8\u84C4\uFF1B\u62D6\u52A8\u4EFB\u610F\u6ED1\u6761\u5373\u53EF\u8986\u76D6\u81EA\u52A8\u503C\u3002",
  "ficalc.source.manual.cta": "\u914D\u7F6E\u8D44\u4EA7\u8D26\u6237 \u2192 \u81EA\u52A8\u542F\u7528",
  "ficalc.assetParams.hint": "\u73B0\u91D1\u6536\u76CA\u7387 / \u5E94\u6025\u91D1\u6708\u6570\uFF1A\u6709\u8D44\u4EA7\u8D26\u6237\u65F6\u53C2\u4E0E\u5206\u6876\u8BA1\u7B97\uFF08\u5E94\u6025\u91D1\u540E\u4F59\u989D\u6309\u73B0\u91D1\u6536\u76CA\u7387\u589E\u957F\uFF09\uFF1B\u65E0\u8D44\u4EA7\u8D26\u6237\u65F6\u4EC5\u4F5C\u9884\u8BBE\u3002",
  "ficalc.snapshot.netWorth": "\u51C0\u503C {v}",
  "ficalc.snapshot.spend": "\u5E74\u82B1 {v}",
  "ficalc.snapshot.savings": "\u5E74\u50A8 {v}",
  "ficalc.snapshot.partial": "\u4EC5 {months} \u4E2A\u6708\u6570\u636E",
  "ficalc.more": "\u66F4\u591A\u5047\u8BBE",
  "ficalc.pill.success": "\u6210\u529F\u7387 {v}",
  "ficalc.progress": "\u8FDB\u5EA6 {v}%",
  "ficalc.metric.swr": "\u5B89\u5168\u63D0\u53D6\u7387",
  "ficalc.metric.swr.desc": "\u5E74\u82B1\u8D39 / \u672C\u91D1\uFF08\u8D8A\u9AD8\u8D8A\u6FC0\u8FDB\uFF09",
  "ficalc.metric.reach": "\u9884\u8BA1\u8FBE\u6210\u5E74\u4EFD",
  "ficalc.metric.reach.desc": "\u6309\u5F53\u524D\u50A8\u84C4\u901F\u5EA6\uFF0C\u8DDD\u81EA\u7531\u8FD8\u9700\u591A\u4E45",
  "ficalc.metric.savings": "\u5E74\u51C0\u50A8\u84C4",
  "ficalc.metric.savings.desc": "\u53EF\u7528\u4E8E\u52A0\u901F\u79EF\u7D2F\u7684\u5E74\u5EA6\u7ED3\u4F59",
  "ficalc.metric.fiAge": "\u81EA\u7531\u91CC\u7A0B\u7891",
  "ficalc.metric.fiAge.desc": "\u88AB\u52A8\u6536\u5165\u6301\u7EED\u8986\u76D6\u652F\u51FA\u7684\u5E74\u9F84",
  "ficalc.banner.notFree.pace": "\u8FD8\u5DEE {gap}\uFF0C\u6309\u5F53\u524D\u901F\u5EA6\u7EA6 {years} \u5E74\u8FBE\u6210\uFF08{targetYear} \u5E74\uFF09",
  "ficalc.strategy.fixed": "\u6052\u5B9A\u91D1\u989D",
  "ficalc.strategy.fixed.desc": "\u6BCF\u5E74\u63D0\u53D6\u56FA\u5B9A\u91D1\u989D\uFF0C\u76F4\u5230\u672C\u91D1\u89C1\u5E95",
  "ficalc.strategy.percent": "\u56FA\u5B9A\u6BD4\u4F8B",
  "ficalc.strategy.percent.desc": "\u6BCF\u5E74\u63D0\u53D6\u5F53\u524D\u672C\u91D1\u7684\u56FA\u5B9A\u6BD4\u4F8B\uFF0C\u81EA\u7136\u968F\u5E02\u573A\u6D6E\u52A8",
  "ficalc.strategy.rule95": "95% \u6CD5\u5219",
  "ficalc.strategy.rule95.desc": "\u5728\u5F53\u524D\u672C\u91D1\u6BD4\u4F8B\u4E0E\u53BB\u5E74\u63D0\u53D6\u989D\u7684 95% \u4E2D\u53D6\u8F83\u5927\u503C",
  "ficalc.sim.title": "\u8499\u7279\u5361\u6D1B\u6A21\u62DF",
  "ficalc.sim.toggle": "\u8499\u7279\u5361\u6D1B\u6A21\u62DF",
  "ficalc.sim.toggleHint": "\u70B9\u51FB\u5C55\u5F00\u6210\u529F\u7387\u4E0E\u5206\u4F4D\u8D70\u52BF\uFF08\u5C55\u5F00\u540E\u624D\u8BA1\u7B97\uFF09",
  // ─── 保存按钮（仅此一处写回源文本） ────────────────────────
  "ficalc.save": "\u4FDD\u5B58\u53C2\u6570",
  "ficalc.save.hint": "\u628A\u5F53\u524D\u6ED1\u5757/\u9009\u9879\u5199\u5165\u4EE3\u7801\u5757\uFF0C\u4E0B\u6B21\u6253\u5F00\u76F4\u63A5\u6CBF\u7528",
  "ficalc.events": "\u4E8B\u4EF6",
  "ficalc.events.hint": "\u89C4\u5212\u4E70\u623F\u3001\u751F\u5A03\u7B49\u4EBA\u751F\u8282\u70B9\uFF0C\u6A21\u62DF\u5B83\u4EEC\u5BF9\u73B0\u91D1\u6D41\u4E0E\u51C0\u8D44\u4EA7\u7684\u957F\u671F\u5F71\u54CD",
  "ficalc.lifecycle.eventTipNote": "\u70B9\u51FB\u6253\u5F00\u5173\u8054\u7B14\u8BB0",
  "ficalc.lifecycle.eventTipEdit": "\u70B9\u51FB\u7BA1\u7406\u4E8B\u4EF6",
  "ficalc.saved": "\u5DF2\u4FDD\u5B58 \u2713",
  "ficalc.save.noFile": "\u4EC5\u5728\u7B14\u8BB0\u6587\u4EF6\u4E2D\u53EF\u4FDD\u5B58",
  "ficalc.sim.note": "{runs} \u6B21\u6A21\u62DF \xB7 {years} \u5E74",
  "ficalc.sim.successRate": "\u6210\u529F\u7387",
  "ficalc.sim.endMedian": "\u4E2D\u4F4D\u671F\u672B",
  "ficalc.sim.endWorst": "\u6700\u5DEE\u671F\u672B",
  "ficalc.sim.endBest": "\u6700\u4F73\u671F\u672B",
  "ficalc.sim.zeroCount": "\u8017\u5C3D\u6B21\u6570",
  "ficalc.sim.smallSpend": "\u7F29\u51CF\u82B1\u8D39\u7387",
  "ficalc.sim.zeroCountValue": "{n}/{total} \u6B21\u672C\u91D1\u89C1\u5E95",
  "ficalc.chart.hint": "\u60AC\u505C\u67E5\u770B\u5404\u5E74\u4EFD\u5206\u4F4D\u7EC4\u5408",
  "ficalc.lifecycle.fi": "\u8D22\u52A1\u81EA\u7531\u91CC\u7A0B\u7891\uFF1A{age} \u5C81",
  "ficalc.lifecycle.noFi": "\u5F53\u524D\u53C2\u6570\u4E0B\u672A\u8FBE\u8D22\u52A1\u81EA\u7531",
  "ficalc.lifecycle.aria": "\u4E09\u5C42\u751F\u547D\u5468\u671F\u56FE\uFF1A\u51C0\u8D44\u4EA7\u66F2\u7EBF / \u73B0\u91D1\u6D41\u67F1\u72B6\uFF08\u6B63\u7EFF\u8D1F\u7EA2\uFF09/ \u5173\u952E\u4E8B\u4EF6",
  "ficalc.lifecycle.start": "\u73B0\u5728",
  "ficalc.lifecycle.retire": "\u9000\u4F11",
  "ficalc.lifecycle.readout": "{age}\u5C81\uFF1A\u51C0\u8D44\u4EA7 {net}\uFF0C\u73B0\u91D1\u6D41\u4F59\u91CF {flow}",
  "ficalc.lifecycle.layerNet": "\u51C0\u8D44\u4EA7\u66F2\u7EBF",
  "ficalc.lifecycle.layerFlow": "\u73B0\u91D1\u6D41",
  "ficalc.lifecycle.layerEvent": "\u5173\u952E\u4E8B\u4EF6",
  "ficalc.lifecycle.zeroLine": "\u96F6\u5206\u4F4D",
  "ficalc.lifecycle.retireEvent": "\u9000\u4F11",
  "ficalc.lifecycle.eventNote": "\u{1F4DD}",
  "ficalc.lifecycle.legendNet": "\u51C0\u8D44\u4EA7",
  "ficalc.lifecycle.legendFlow": "\u73B0\u91D1\u6D41\u4E3A\u6B63",
  "ficalc.lifecycle.legendNeg": "\u73B0\u91D1\u6D41\u4E3A\u8D1F",
  "ficalc.lifecycle.legendHist": "\u5386\u53F2",
  "ficalc.lifecycle.legendEvent": "\u5173\u952E\u4E8B\u4EF6\uFF08\u94FE\u63A5\u7B14\u8BB0\uFF09",
  "ficalc.lifecycle.now": "\u5F53\u524D",
  "ficalc.lifecycle.nowShort": "\u4ECA",
  "ficalc.lifecycle.readoutHist": "{age}\u5C81\uFF1A\u57FA\u4E8E\u8BB0\u8D26\u7684\u51C0\u8D44\u4EA7 {net}\uFF08\u5386\u53F2\u6BB5\uFF09",
  "ficalc.chart.aria": "\u9000\u4F11\u7EC4\u5408\u5728\u4E0D\u540C\u5E74\u4EFD\u7684 P10 / P50 / P90 \u5206\u4F4D\u8D70\u52BF",
  "ficalc.chart.start": "\u8D77\u70B9",
  "ficalc.chart.readout": "{year}\uFF1A\u4E2D\u4F4D {p50}\uFF08P10 {p10} ~ P90 {p90}\uFF09",
  "ficalc.table.year": "\u5E74\u4EFD",
  "ficalc.table.p10": "P10",
  "ficalc.table.p50": "P50",
  "ficalc.table.p90": "P90",
  // ─── finance-fi 进度仪表（M3） ──────────────────────────
  "fi.title": "\u8D22\u52A1\u81EA\u7531\u8FDB\u5EA6",
  "fi.noData": "\u6682\u65E0\u8DB3\u591F\u7684\u8BB0\u8D26\u6570\u636E\uFF0C\u8BF7\u5148\u8BB0\u5F55\u6536\u652F",
  "fi.alreadyFree": "\u5DF2\u8FBE\u6210",
  "fi.withinYear": "\u22641\u5E74",
  "fi.yearUnit": "\u5E74",
  "fi.banner.free": "\u5DF2\u5B9E\u73B0\u8D22\u52A1\u81EA\u7531",
  "fi.banner.freeDesc": "\u88AB\u52A8\u6536\u5165\u8986\u76D6\u5E74\u82B1\u8D39\uFF0C\u94B1\u6C38\u8FDC\u82B1\u4E0D\u5B8C",
  "fi.banner.notFree": "\u5C1A\u672A\u8D22\u52A1\u81EA\u7531",
  "fi.banner.yearsToGoal": "\u6309\u5F53\u524D\u901F\u5EA6\u7EA6 {years} \u5E74\u8FBE\u6210\uFF08{targetYear}\u5E74\uFF09",
  "fi.banner.cannotReach": "\u5F53\u524D\u50A8\u84C4\u901F\u5EA6\u65E0\u6CD5\u8FBE\u6210\u76EE\u6807",
  "fi.metric.netWorth": "\u5F53\u524D\u51C0\u503C",
  "fi.metric.netWorthDesc": "\u603B\u8D44\u4EA7 - \u603B\u8D1F\u503A",
  "fi.metric.target": "\u76EE\u6807\u672C\u91D1",
  "fi.metric.targetDesc": "\u8FBE\u5230\u81EA\u7531\u9700\u8981\u7684\u603B\u672C\u91D1",
  "fi.metric.gap": "\u672C\u91D1\u7F3A\u53E3",
  "fi.metric.gapDone": "\u5DF2\u8FBE\u6210",
  "fi.metric.gapDesc": "\u8DDD\u81EA\u7531\u8FD8\u5DEE\u591A\u5C11",
  "fi.metric.annualSpend": "\u5E74\u82B1\u8D39",
  "fi.metric.actualSpend": "\u8FD112\u6708\u5B9E\u9645\u82B1\u8D39",
  "fi.metric.insufficientMonths": "\u4EC5{n}\u4E2A\u6708\u6570\u636E",
  "fi.metric.annualSavings": "\u5E74\u51C0\u50A8\u84C4",
  "fi.metric.savingsDesc": "\u5E74\u6536\u5165 - \u5E74\u82B1\u8D39",
  "fi.metric.maxSpend": "\u53EF\u6301\u7EED\u82B1\u8D39",
  "fi.metric.maxSpendDesc": "\u4E0D\u5403\u8001\u672C\u7684\u5E74\u82B1\u8D39\u4E0A\u9650",
  "fi.dataHint": "\uFF08\u57FA\u4E8E\u8FD1 {months} \u4E2A\u6708\u6570\u636E\uFF0C\u6309\u6BD4\u4F8B\u5E74\u5316\uFF09",
  // ─── 资产管理 ─────────────────────────────────────────────
  "block.finance-assets": "\u8D44\u4EA7\u603B\u89C8",
  "block.finance-assets.desc": "\u8D44\u4EA7\u5E02\u503C\u603B\u89C8\uFF1A\u51C0\u8D44\u4EA7\uFF08\u5E02\u503C\u53E3\u5F84\uFF09+ \u8D44\u4EA7\u7ED3\u6784 + \u9010\u5361\u4F30\u503C + \u8D1F\u503A",
  "param.assetsOwner": "\u5F52\u5C5E",
  "param.assetsOwner.desc": "\u6309\u5F52\u5C5E\u7B5B\u9009\u8D26\u6237\uFF08\u53EF\u9009\uFF0C\u7559\u7A7A=\u5408\u5E76\u5168\u90E8\uFF09",
  "param.assetsGroup": "\u5206\u7EC4\u65B9\u5F0F",
  "param.assetsGroup.desc": "class=\u6309\u8D44\u4EA7/\u8D1F\u503A\u5206\u7EC4\uFF08\u9ED8\u8BA4\uFF09\uFF0Cprefix=\u6309\u8D26\u6237\u540D\u524D\u7F00\u5206\u7EC4",
  // ── 账户编辑（资产管理扩展） ──
  "modal.accounts.owner": "\u5F52\u5C5E",
  "modal.accounts.ownerPlaceholder": "\u5F52\u5C5E\u7EF4\u5EA6\uFF08\u7F3A\u7701=\u9ED8\u8BA4\u5F52\u5C5E\uFF09",
  "modal.accounts.valuation": "\u8BA1\u4EF7\u65B9\u5F0F",
  "modal.accounts.valuation.book": "\u8D26\u9762\uFF08\u6D41\u6C34\u7D2F\u52A0\uFF09",
  "modal.accounts.valuation.market": "\u5E02\u503C\uFF08\u624B\u52A8\u4F30\u503C\uFF09",
  "modal.accounts.valuationPlaceholder": "\u9009\u62E9\u8BA1\u4EF7\u65B9\u5F0F",
  "modal.accounts.staleDays": "\u4F30\u503C\u8FC7\u671F\u5929\u6570",
  "modal.accounts.staleDaysPlaceholder": "\u7F3A\u7701\u53D6\u5168\u5C40\u9ED8\u8BA4\uFF0830 \u5929\uFF09",
  "modal.accounts.staleDaysHint": "\u4EC5\u5BF9\u5E02\u503C/\u6298\u65E7\u8D26\u6237\u751F\u6548\uFF0Cbook \u8D26\u6237\u65E0\u9700\u4F30\u503C",
  "modal.accounts.cashflowRole": "\u73B0\u91D1\u6D41\u89D2\u8272",
  "modal.accounts.cashflowRolePlaceholder": "\u9009\u62E9\u73B0\u91D1\u6D41\u884C\u4E3A\uFF08\u7F3A\u7701\u6309\u8BA1\u4EF7\u65B9\u5F0F\u667A\u80FD\u63A8\u65AD\uFF09",
  "modal.accounts.cashflowRole.growth": "\u751F\u606F\u589E\u957F",
  "modal.accounts.cashflowRole.cash": "\u73B0\u91D1\u7C7B",
  "modal.accounts.cashflowRole.fixed": "\u975E\u751F\u606F\u8D44\u4EA7",
  "modal.accounts.cashflowRole.rental": "\u51FA\u79DF\u623F",
  // ── 具体资产管理（2026-08-04 分层重构：金额只属于具体资产，不属于账户） ──
  // ── 资产总览视图 ──
  "assets.title": "\u8D44\u4EA7\u603B\u89C8",
  "assets.marketPill": "\u5E02\u503C\u53E3\u5F84 \xB7 \u542B\u6301\u4ED3",
  "assets.netWorth": "\u51C0\u8D44\u4EA7\uFF08\u5E02\u503C\uFF09",
  "assets.totalAssets": "\u603B\u8D44\u4EA7",
  "assets.totalLiabilities": "\u603B\u8D1F\u503A",
  "assets.unrealizedPnL": "\u672A\u5B9E\u73B0\u635F\u76CA",
  "assets.realizedPnL": "\u5DF2\u5B9E\u73B0\u6536\u76CA",
  "assets.realizedShort": "\u5DF2\u5B9E\u73B0",
  "assets.unrealizedShort": "\u672A\u5B9E\u73B0",
  "assets.staleBadge": "\u4F30\u503C\u5DF2\u8FC7\u671F",
  "assets.carriedBadge": "\u4F30\u503C\u540E\u6709\u4E70\u5356",
  "assets.holdingsHint": "\uFF08\u6295\u8D44\u7C7B\u6309\u6301\u4ED3\u5C55\u5F00\uFF09",
  "assets.holdingsHead": "\u6301\u4ED3\u660E\u7EC6\uFF08{n} \u53EA\uFF09",
  "assets.reconDiff": "\u5BF9\u8D26\u5DEE\u989D {amount}",
  "assets.reconUnclassified": "{n} \u4E2A\u8D26\u6237\u672A\u58F0\u660E\u7C7B\u522B",
  "assets.reconHint": "\u300C\u8D44\u4EA7 \u2212 \u8D1F\u503A\u300D\u5E94\u6052\u7B49\u4E8E\u300C\u6743\u76CA + \u672C\u671F\u7559\u5B58\u300D\u3002\u5DEE\u989D\u901A\u5E38\u6765\u81EA\u8D26\u6237\u672A\u5728\u8BBE\u7F6E\u91CC\u58F0\u660E\u4E94\u5927\u7C7B\uFF0C\u6216\u6709\u4EA4\u6613\u672A\u914D\u5E73\u3002",
  "assets.unvalued": "\u672A\u4F30\u503C",
  "assets.updateValuation": "\u66F4\u65B0\u4F30\u503C",
  "assets.bookValue": "\u8D26\u9762",
  "assets.marketValue": "\u5E02\u503C",
  "assets.valuationSource.valuation": "\u624B\u52A8\u4F30\u503C",
  "assets.valuationSource.book": "\u8D26\u9762\u515C\u5E95",
  "assets.lastValuation": "\u6700\u8FD1\u4F30\u503C\uFF1A{date}",
  "assets.noValuation": "\u6682\u65E0\u4F30\u503C",
  "assets.groupAssets": "\u8D44\u4EA7",
  "assets.groupLiabilities": "\u8D1F\u503A",
  "assets.allocTitle": "\u8D44\u4EA7\u914D\u7F6E\uFF08\u6309\u7C7B\u522B\uFF09",
  "assets.empty": "\u6682\u65E0\u8D44\u4EA7\u8D26\u6237\uFF0C\u8BF7\u5148\u5728\u8D26\u6237\u7BA1\u7406\u4E2D\u6DFB\u52A0",
  "assets.footNote": '\u4F30\u503C\u6765\u81EA\u8D26\u672C\u5185 custom "fb-valuation" \u6307\u4EE4\u884C\uFF1B\u8349\u7A3F\u5757\u4E2D\u7684\u4F30\u503C\u4E0D\u8BA1\u5165',
  "assets.trend": "\u8D44\u4EA7\u8D70\u52BF",
  "assets.trend.month": "\u6708",
  "assets.trend.quarter": "\u5B63",
  "assets.trend.year": "\u5E74",
  "assets.trend.empty": "\u6682\u65E0\u8DB3\u591F\u6570\u636E\u7ED8\u5236\u8D70\u52BF\uFF08\u81F3\u5C11\u9700\u8981\u4E24\u4E2A\u91C7\u6837\u70B9\uFF09",
  // ── 更新估值弹窗 ──
  "modal.valuation.title": "\u66F4\u65B0\u4F30\u503C",
  "modal.valuation.account": "\u8D26\u6237",
  "modal.valuation.amount": "\u5E02\u503C\uFF08\u5143\uFF09",
  "modal.valuation.amountPlaceholder": "\u5982 1250000\uFF08125 \u4E07\uFF09",
  "modal.valuation.currency": "\u5E01\u79CD",
  "modal.valuation.date": "\u4F30\u503C\u65E5\u671F",
  "modal.valuation.comment": "\u5907\u6CE8",
  "modal.valuation.commentPlaceholder": "\u5982 \u7EA6 350 \u80A1\uFF0C\u6309\u6536\u76D8\u4EF7",
  "modal.valuation.success": "\u4F30\u503C\u5DF2\u5199\u5165 {ledgerPath}",
  "modal.valuation.error": "\u4F30\u503C\u5199\u5165\u5931\u8D25\uFF1A{error}",
  "modal.valuation.amountRequired": "\u8BF7\u586B\u5199\u5E02\u503C\u91D1\u989D",
  "modal.valuation.subtitle": "\u4E3A\u300C\u6309\u5E02\u503C\u8BA1\u4EF7\u300D\u7684\u8D44\u4EA7\u6253\u4E00\u4E2A\u5F53\u524D\u516C\u5141\u4EF7\u503C\u5FEB\u7167\u3002\u4E0D\u4EA7\u751F\u5206\u5F55\uFF0C\u4E0D\u6539\u8D26\u9762\u4F59\u989D\u3002",
  "modal.valuation.hint.book": "\u26A0 \u8BE5\u8D26\u6237\u6309\u8D26\u9762\u8BA1\u4EF7\uFF08valuation: book\uFF09\uFF0C\u4F30\u503C\u4E0D\u4F1A\u53C2\u4E0E\u5E02\u503C\u53E3\u5F84 \u2014\u2014 \u5EFA\u8BAE\u5148\u5728\u8D26\u6237\u7BA1\u7406\u91CC\u6539\u4E3A market\u3002",
  "modal.valuation.hint.market": "\u6309\u5E02\u503C\u8BA1\u4EF7 \xB7 \u8FC7\u671F\u9608\u503C {n} \u5929",
  "modal.valuation.hint.lastAt": " \xB7 \u4E0A\u6B21\u4F30\u503C {date}",
  "modal.valuation.noAssetAccount": "\u5C1A\u672A\u914D\u7F6E\u8D44\u4EA7\u8D26\u6237\uFF0C\u8BF7\u5148\u5230\u8BBE\u7F6E\u91CC\u6DFB\u52A0",
  "modal.valuation.preview": "\u5B9E\u65F6\u9884\u89C8",
  "modal.valuation.pv.last": "\u4E0A\u6B21\u4F30\u503C",
  "modal.valuation.pv.delta": "\u672C\u6B21\u53D8\u5316",
  "modal.valuation.pv.book": "\u8D26\u9762\u4F59\u989D",
  "modal.valuation.pv.pnl": "\u672A\u5B9E\u73B0\u635F\u76CA",
  "modal.valuation.pv.willWrite": "\u5C06\u5199\u5165\uFF1A",
  "modal.valuation.quick.same": "\u6CBF\u7528\u4E0A\u6B21",
  "modal.valuation.lockedHint": "\u5DF2\u9501\u5B9A\u5230\u8BE5\u8BB0\u8D26\u8D44\u4EA7\uFF0C\u4EC5\u66F4\u65B0\u6B64\u6761\u76EE\uFF08\u975E\u6574\u4E2A\u8D26\u6237\uFF09",
  // ─── finance-recurring（日常花费 + 贷款） ─────────────────
  "block.finance-recurring": "\u65E5\u5E38\u82B1\u8D39",
  "block.finance-recurring.desc": "\u8BBE\u4E00\u6B21\u8BA1\u5212\uFF0C\u6BCF\u5929\u81EA\u52A8\u51FA\u5F85\u5165\u8D26\u8349\u7A3F\uFF0C\u4E00\u952E\u5165\u8D26\uFF1B\u8D37\u6B3E\u6309\u8FD8\u6B3E\u8BA1\u5212\u751F\u6210 3 \u817F\u5206\u5F55",
  "recurring.title": "\u65E5\u5E38\u82B1\u8D39",
  "recurring.pill.due": "\u4ECA\u65E5 {n} \u6761\u5F85\u5165\u8D26",
  "recurring.pill.done": "\u5DF2\u5168\u90E8\u5165\u8D26 \u2713",
  "recurring.due.title": "\u4ECA\u65E5\u5F85\u5165\u8D26",
  "recurring.due.all": "\u5168\u90E8\u5165\u8D26",
  "recurring.due.empty": "\u4ECA\u5929\u6CA1\u6709\u5F85\u5165\u8D26\u7684\u82B1\u8D39 \u{1F389}",
  "recurring.tab.plans": "\u6211\u7684\u8BA1\u5212",
  "recurring.tab.loans": "\u6211\u7684\u8D37\u6B3E",
  "recurring.new.plan": "\uFF0B \u65B0\u5EFA\u8BA1\u5212",
  "recurring.new.loan": "\uFF0B \u65B0\u5EFA\u8D37\u6B3E",
  "recurring.badge.loan": "\u8D37\u6B3E",
  "recurring.post": "\u5165\u8D26",
  "recurring.skip": "\u8DF3\u8FC7",
  "recurring.editAmount": "\u6539\u91D1\u989D",
  "recurring.posted": "\u5DF2\u5165\u8D26\uFF1A{name}",
  "recurring.postError": "\u5165\u8D26\u5931\u8D25\uFF1A{error}",
  "recurring.skipped": "\u5DF2\u8DF3\u8FC7\uFF1A{name}",
  "recurring.confirmAll": "\u5168\u90E8\u5165\u8D26 {n} \u6761\uFF1F\uFF08\u8D26\u672C\u53EA\u6709\u8FFD\u52A0\uFF0C\u8BEF\u5165\u8D26\u9700\u624B\u6539\u8D26\u672C\u6587\u4EF6\uFF09",
  "recurring.confirmAllTitle": "\u5168\u90E8\u5165\u8D26\u786E\u8BA4",
  "recurring.batchPartial": "\u90E8\u5206\u5165\u8D26\u5931\u8D25\uFF08{fail} \u6761\uFF09",
  "recurring.batchDone": "\u5DF2\u5165\u8D26 {n} \u6761 \u2713",
  "recurring.editAmountTitle": "\u4FEE\u6539\u91D1\u989D\uFF08\u4EC5\u672C\u6B21\uFF09\uFF1A{name} \xB7 {date}",
  "recurring.modal.cancel": "\u53D6\u6D88",
  "recurring.modal.save": "\u4FDD\u5B58",
  "recurring.modal.planTitle": "\u65E5\u5E38\u82B1\u8D39\u8BA1\u5212",
  "recurring.modal.loanTitle": "\u8D37\u6B3E\u8BA1\u5212",
  "recurring.modal.err.name": "\u8BF7\u8F93\u5165\u540D\u79F0",
  "recurring.modal.err.amount": "\u91D1\u989D\u9700\u5927\u4E8E 0",
  "recurring.modal.err.account": "\u8BF7\u9009\u62E9\u652F\u51FA\u8D26\u6237",
  "recurring.modal.err.fromAccount": "\u8BF7\u9009\u62E9\u51FA\u8D44\u8D26\u6237",
  "recurring.modal.err.txnType": "\u8BF7\u9009\u62E9\u5206\u7C7B",
  "recurring.modal.err.startDate": "\u8BF7\u9009\u62E9\u65E5\u671F",
  "recurring.modal.err.monthlyDay": "\u6BCF\u6708\u51E0\u53F7\u9700\u5728 1\u201328 \u4E4B\u95F4",
  "recurring.modal.err.nameDup": "\u8BA1\u5212\u540D\u5DF2\u5B58\u5728",
  "recurring.modal.err.loanPrincipal": "\u672C\u91D1\u9700\u5927\u4E8E 0",
  "recurring.modal.err.loanRate": "\u5E74\u5229\u7387\u9700\u5927\u4E8E 0",
  "recurring.modal.err.loanYears": "\u5E74\u9650\u9700\u5728 1\u201350 \u4E4B\u95F4",
  "recurring.modal.err.loanAccounts": "\u51FA\u8D44 / \u8D1F\u503A / \u5229\u606F\u8D26\u6237\u5747\u9700\u9009\u62E9",
  "recurring.plan.name": "\u540D\u79F0",
  "recurring.plan.amount": "\u91D1\u989D\uFF08\u5143\uFF09",
  "recurring.plan.frequency": "\u9891\u7387",
  "recurring.plan.account": "\u652F\u51FA\u8D26\u6237",
  "recurring.plan.fromAccount": "\u51FA\u8D44\u8D26\u6237",
  "recurring.plan.txnType": "\u5206\u7C7B",
  "recurring.plan.owner": "\u5F52\u5C5E",
  "recurring.plan.monthlyDay": "\u6BCF\u6708\u51E0\u53F7\uFF081\u201328\uFF09",
  "recurring.plan.startDate": "\u8D77\u59CB\u65E5",
  "recurring.plan.endDate": "\u7ED3\u675F\u65E5\uFF08\u53EF\u9009\uFF09",
  "recurring.plan.note": "\u5907\u6CE8",
  "recurring.freq.daily": "\u6BCF\u5929",
  "recurring.freq.weekday": "\u6BCF\u5DE5\u4F5C\u65E5\uFF08\u5468\u4E00\u81F3\u5468\u4E94\uFF09",
  "recurring.freq.monthly": "\u6BCF\u6708\u7B2C N \u65E5",
  "recurring.freq.monthlyShort": "\u6BCF\u6708 {d} \u53F7",
  "recurring.loan.name": "\u540D\u79F0",
  "recurring.loan.principal": "\u8D37\u6B3E\u672C\u91D1\uFF08\u5143\uFF09",
  "recurring.loan.annualRate": "\u5E74\u5229\u7387\uFF08%\uFF09",
  "recurring.loan.termYears": "\u5E74\u9650",
  "recurring.loan.type": "\u8FD8\u6B3E\u65B9\u5F0F",
  "recurring.loan.type.annuity": "\u7B49\u989D\u672C\u606F",
  "recurring.loan.type.equalPrincipal": "\u7B49\u989D\u672C\u91D1",
  "recurring.loan.type.interestFirst": "\u5148\u606F\u540E\u672C",
  "recurring.loan.frequency": "\u8FD8\u6B3E\u5468\u671F",
  "recurring.loan.freq.monthly": "\u6BCF\u6708",
  "recurring.loan.freq.quarterly": "\u6BCF\u5B63\u5EA6",
  "recurring.loan.firstPaymentDate": "\u9996\u671F\u8FD8\u6B3E\u65E5",
  "recurring.loan.remaining": "\u5269\u4F59\u672C\u91D1\uFF08\u5143\uFF09",
  "recurring.loan.remainingHint": "\u7F16\u8F91\u65F6\u6539\u5C0F\u6B64\u9879 = \u6A21\u62DF\u90E8\u5206\u63D0\u524D\u8FD8\u672C\uFF0C\u8FD8\u6B3E\u8BA1\u5212\u4ECE\u4E0B\u4E00\u672A\u5165\u8D26\u671F\u6309\u65B0\u5269\u4F59\u672C\u91D1\u7EED\u7B97",
  "recurring.loan.assetAccount": "\u51FA\u8D44\u8D26\u6237",
  "recurring.loan.liabilityAccount": "\u8D1F\u503A\u8D26\u6237",
  "recurring.loan.interestAccount": "\u5229\u606F\u8D26\u6237",
  "recurring.loan.txnType": "\u5206\u7C7B",
  "recurring.loan.owner": "\u5F52\u5C5E",
  "recurring.loan.note": "\u5907\u6CE8",
  "recurring.loan.preview": "\u8FD8\u6B3E\u9884\u89C8",
  "recurring.loan.previewEmpty": "\u586B\u5199\u672C\u91D1 / \u5229\u7387 / \u5E74\u9650\u540E\u9884\u89C8",
  "recurring.loan.pvSplit": "\u9996\u671F\u672C\u91D1 / \u5229\u606F",
  "recurring.loan.pvPeriods": "\u603B\u671F\u6570",
  "recurring.loan.pvInterest": "\u603B\u5229\u606F\uFF08\u4F30\u7B97\uFF09",
  "recurring.loan.pvDesc": "\u5171 {n} \u671F",
  "recurring.loan.defaultName": "\u8D37\u6B3E",
  "recurring.loan.perPeriod": " / \u671F",
  "recurring.loan.splitFmt": "\u672C\u91D1 {principal} \xB7 \u5229\u606F {interest}",
  "recurring.loan.periods": "{n} \u671F",
  "recurring.loan.periodLabel": "\u7B2C {n} \u671F",
  "recurring.loan.principalPart": "\u672C\u91D1",
  "recurring.loan.interest": "\u5229\u606F",
  "recurring.loan.years": "\u5E74",
  "recurring.loan.next": "\u4E0B\u671F",
  "recurring.loan.paid": "\u5DF2\u8FD8 {n}/{m} \u671F",
  "recurring.plans.empty": "\u8FD8\u6CA1\u6709\u8BA1\u5212\uFF0C\u70B9\u300C\u65B0\u5EFA\u8BA1\u5212\u300D\u521B\u5EFA",
  "recurring.loans.empty": "\u8FD8\u6CA1\u6709\u8D37\u6B3E\uFF0C\u70B9\u300C\u65B0\u5EFA\u8D37\u6B3E\u300D\u521B\u5EFA",
  "recurring.status.running": "\u8FD0\u884C\u4E2D",
  "recurring.status.paused": "\u5DF2\u6682\u505C",
  "recurring.edit": "\u7F16\u8F91",
  "recurring.pause": "\u6682\u505C",
  "recurring.resume": "\u542F\u7528",
  "recurring.del": "\u5220\u9664",
  "recurring.confirmDelPlan": "\u5220\u9664\u8BA1\u5212\u300C{name}\u300D\uFF1F\u5DF2\u5165\u8D26\u7684\u8BB0\u5F55\u4E0D\u53D7\u5F71\u54CD",
  "recurring.confirmDelLoan": "\u5220\u9664\u8D37\u6B3E\u300C{name}\u300D\uFF1F\u5DF2\u5165\u8D26\u7684\u8BB0\u5F55\u4E0D\u53D7\u5F71\u54CD"
};

// src/i18n/en.ts
var en = {
  // ─── Settings ───────────────────────────────────────────
  "settings.ledgerPath": "Ledger file path",
  "settings.ledgerPath.desc": "Full path of the single ledger file (e.g. \u8D26\u672C/\u8D26\u672C.md); points to the new ledger after rollover",
  "settings.ledgerPath.browse": "Browse",
  "settings.ledgerPath.placeholder": "e.g. \u8D26\u672C/\u8D26\u672C.md",
  "settings.configPath": "Config file path",
  "settings.configPath.desc": "Full path of finance-config.json (accounts/currencies/types config)",
  "settings.configPath.browse": "Browse",
  "settings.configPath.placeholder": "e.g. finance-config.json",
  "settings.configReloadError": "Config reload failed \u2014 please check finance-config.json",
  "settings.language": "Language",
  "settings.language.desc": "Plugin UI language",
  "settings.selectFolder": "Select folder",
  "settings.currencyManager": "Currency & exchange rates",
  "settings.currencyManager.desc": "Manage your currencies and exchange rates",
  "settings.openManager": "Open manager",
  // Settings section headings
  "settings.dataSection": "Data files",
  "settings.managers": "Management",
  "settings.generalSection": "General",
  "settings.moveUp": "Move up",
  "settings.moveDown": "Move down",
  // ─── Common ─────────────────────────────────────────────
  "common.add": "Add",
  "common.edit": "Edit",
  "common.delete": "Delete",
  "common.save": "Save",
  "common.cancel": "Cancel",
  "common.confirm": "Confirm",
  "common.close": "Close",
  "common.noMatch": "No matches",
  "common.default": "Default",
  "common.saveFailed": "Save failed, please retry",
  // ─── Currency & exchange rate manager ──────────────────
  "modal.currency.title": "Currency & exchange rates",
  "modal.currency.search": "Search currencies\u2026",
  "modal.currency.add": "Add currency",
  "modal.currency.noData": 'No currencies yet. Click "Add currency" to create one.',
  "modal.currency.setDefault": "Set as default",
  "modal.currency.confirmDelete": "Delete currency {name} ({code})?",
  "modal.currency.cannotDeleteDefault": "The default currency cannot be deleted",
  "modal.currency.editTitle": "Edit currency",
  "modal.currency.newTitle": "Add currency",
  "modal.currency.code": "Code",
  "modal.currency.codePlaceholder": "e.g. USD",
  "modal.currency.name": "Name",
  "modal.currency.namePlaceholder": "e.g. US Dollar",
  "modal.currency.symbol": "Symbol",
  "modal.currency.symbolPlaceholder": "e.g. $",
  "modal.currency.rate": "Exchange rate",
  "modal.currency.ratePlaceholder": "1 unit = ? base currency",
  "modal.currency.rateHint": "Relative to base {base}: 1 {code} = {rate} {base}",
  "modal.currency.baseRateFixed": "Base currency rate is fixed to 1",
  "modal.currency.codeRequired": "Currency code is required",
  "modal.currency.nameRequired": "Currency name is required",
  "modal.currency.codeDuplicate": "Currency code already exists",
  "modal.currency.saved": "Saved",
  "modal.currency.deleted": "Deleted",
  "modal.currency.rebased": "Default currency changed \u2014 rates re-based to the new base",
  // ─── Account manager ───────────────────────────────────
  "settings.accounts": "Accounts",
  "settings.accounts.desc": "Manage your financial accounts (asset / liability)",
  "modal.accounts.title": "Account manager",
  "modal.accounts.search": "Search accounts\u2026",
  "modal.accounts.add": "Add account",
  "modal.accounts.noData": 'No accounts yet. Click "Add account" to create one.',
  "modal.accounts.editTitle": "Edit account",
  "modal.accounts.newTitle": "Add account",
  "modal.accounts.name": "Name",
  "modal.accounts.namePlaceholder": "e.g. Cash",
  "modal.accounts.class": "Class",
  "modal.accounts.classPlaceholder": "Select a class",
  "class.asset": "Asset",
  "class.liability": "Liability",
  "class.equity": "Equity",
  "class.income": "Income",
  "class.expense": "Expense",
  "modal.accounts.icon": "Icon",
  "modal.accounts.iconPlaceholder": "optional emoji, e.g. \u{1F4B5}",
  "modal.accounts.nameRequired": "Account name is required",
  "modal.accounts.nameDuplicate": "Account name already exists",
  "modal.accounts.confirmDelete": 'Delete account "{name}"?',
  "modal.accounts.deleted": "Deleted",
  "modal.accounts.saved": "Saved",
  // ─── Transaction type manager ──────────────────────────
  "settings.transactionTypes": "Transaction types",
  "settings.transactionTypes.desc": "Manage income/expense categories and custom fields",
  "modal.transactionTypes.title": "Transaction type manager",
  "modal.transactionTypes.search": "Search types\u2026",
  "modal.transactionTypes.add": "Add type",
  "modal.transactionTypes.noData": 'No transaction types yet. Click "Add type" to create one.',
  "modal.transactionTypes.editTitle": "Edit transaction type",
  "modal.transactionTypes.newTitle": "Add transaction type",
  "modal.transactionTypes.name": "Name",
  "modal.transactionTypes.namePlaceholder": "e.g. Dining",
  "modal.transactionTypes.direction": "Direction",
  "modal.transactionTypes.direction.income": "Income",
  "modal.transactionTypes.direction.expense": "Expense",
  "modal.transactionTypes.fields": "{n} custom field(s)",
  "modal.transactionTypes.noFields": "No custom fields",
  "modal.transactionTypes.customFields": "Custom fields",
  "modal.transactionTypes.customFieldsPlaceholder": "comma-separated, e.g. Restaurant, Companions",
  "modal.transactionTypes.nameRequired": "Type name is required",
  "modal.transactionTypes.nameDuplicate": "Type name already exists",
  "modal.transactionTypes.confirmDelete": 'Delete transaction type "{name}"?',
  "modal.transactionTypes.deleted": "Deleted",
  "modal.transactionTypes.saved": "Saved",
  // ─── Owner dimension manager ───────────────────────────
  "settings.owners": "Ownership",
  "settings.owners.desc": "Manage the ownership dimension (self / family / custom)",
  "modal.owners.title": "Ownership manager",
  "modal.owners.search": "Search ownership\u2026",
  "modal.owners.add": "Add ownership",
  "modal.owners.noData": 'No ownership entries yet. Click "Add ownership" to create one.',
  "modal.owners.editTitle": "Edit ownership",
  "modal.owners.newTitle": "Add ownership",
  "modal.owners.name": "Name",
  "modal.owners.namePlaceholder": "e.g. Self",
  "modal.owners.nameRequired": "Ownership name is required",
  "modal.owners.nameDuplicate": "Ownership name already exists",
  "modal.owners.setDefault": "Set as default",
  "modal.owners.cannotDeleteDefault": "The default ownership cannot be deleted",
  "modal.owners.confirmDelete": 'Delete ownership "{name}"?',
  "modal.owners.deleted": "Deleted",
  "modal.owners.saved": "Saved",
  // ─── Budget manager ────────────────────────────────────
  "settings.budgetManager": "Budget manager",
  "settings.budgetManager.desc": "Set spending caps per transaction type to drive the budget execution view",
  "settings.lifeEventManager": "Life events",
  "settings.lifeEventManager.desc": "Plan milestones like buying a home or having a child, and simulate their long-term impact on cash flow and net worth",
  "modal.budget.title": "Budget manager",
  "modal.budget.search": "Search budgets\u2026",
  "modal.budget.add": "Add budget",
  "modal.budget.noData": 'No budgets yet. Click "Add budget" to create one.',
  "modal.budget.editTitle": "Edit budget",
  "modal.budget.newTitle": "Add budget",
  "modal.budget.name": "Plan name",
  "modal.budget.namePlaceholder": "e.g. July dining budget",
  "modal.budget.type": "Transaction type",
  "modal.budget.typePlaceholder": "Select a transaction type",
  "modal.budget.amount": "Budget amount (yuan)",
  "modal.budget.amountPlaceholder": "e.g. 3000",
  "modal.budget.nameRequired": "Plan name is required",
  "modal.budget.nameDuplicate": "Plan name already exists",
  "modal.budget.typeRequired": "Please select a transaction type",
  "modal.budget.amountRequired": "Budget amount is required",
  "modal.budget.confirmDelete": 'Delete budget plan "{name}"?',
  "modal.budget.deleted": "Deleted",
  "modal.budget.saved": "Saved",
  "modal.budget.period": "Budget period",
  "modal.budget.periodCustom": "Custom (by days)",
  "modal.budget.periodDays": "Period length (days)",
  "modal.budget.periodDaysPlaceholder": "e.g. 30",
  "modal.budget.periodDaysRequired": "Please enter a valid period length",
  // ─── Life events (stage 3: event simulator) ─────────────
  "modal.event.title": "Life events",
  "modal.event.intro": "Plan milestones like buying a home or having a child, and simulate their long-term impact on cash flow and net worth. Events are shared across all cash-flow simulators.",
  "modal.event.add": "New event",
  "modal.event.noData": 'No life events yet \u2014 click "New event" to plan your first milestone',
  "modal.event.editTitle": "Edit event",
  "modal.event.newTitle": "New event",
  "modal.event.label": "Event name",
  "modal.event.labelPlaceholder": "e.g. Buy a home / Have a child",
  "modal.event.type": "Event type",
  "modal.event.age": "Trigger age",
  "modal.event.agePlaceholder": "e.g. 35",
  "modal.event.retireAgeHint": 'This age becomes the default for the "Retirement age" parameter of the cash-flow simulator; the simulator can override it independently. This event cannot be deleted and its type is locked.',
  "modal.event.atAge": "Age {n}",
  "modal.event.hasNote": "Note",
  "modal.event.enabled": "Enabled",
  "modal.event.disabled": "Disabled",
  "modal.event.enabledLabel": "Include in calculation (turn off to keep it listed without affecting the curve)",
  "modal.event.impactSection": "Financial impact",
  "modal.event.impactHint": "All five fields are optional \u2014 fill only what applies. Amounts are in base currency units; positive = inflow / increase, negative = outflow / decrease.",
  "modal.event.oneOff": "One-off cash flow",
  "modal.event.oneOff.desc": "One-time amount that year, e.g. -800000 for a down payment",
  "modal.event.deltaSpend": "Annual spending change",
  "modal.event.deltaSpend.desc": "Extra yearly cost from then on, e.g. 30000 for a child",
  "modal.event.deltaIncome": "Annual savings change",
  "modal.event.deltaIncome.desc": "Extra yearly savings from then on, e.g. 50000 for a raise",
  "modal.event.deltaFixed": "Non-interest asset change",
  "modal.event.deltaFixed.desc": "Counts toward net worth but does not fund retirement, e.g. 2400000 for a property",
  "modal.event.deltaLiability": "Liability change",
  "modal.event.deltaLiability.desc": "Deducted from net worth, e.g. 1600000 for a mortgage",
  "modal.event.note": "Linked note (optional)",
  "modal.event.notePlaceholder": "Enter a vault note path \u2014 click the event on the chart to open it",
  "modal.event.labelRequired": "Please enter an event name",
  "modal.event.ageRequired": "Please enter a valid trigger age (0\u2013120)",
  "modal.event.impactInvalid": "Invalid financial impact amount, please check",
  "modal.event.confirmDelete": 'Delete life event "{name}"?',
  "modal.event.deleted": "Deleted",
  "modal.event.saved": "Saved",
  "modal.event.birthday": "Birthday",
  "modal.event.birthdayDerivedAge": "Current age {n}",
  "modal.event.birthdayHint": "With a birthday set, the current age and the age of date-based events are derived automatically \u2014 no need to fill them in.",
  "modal.event.birthdaySave": "Save birthday",
  "modal.event.birthdaySaved": "Birthday saved",
  "modal.event.date": "Trigger date (optional)",
  "modal.event.dateHint": "Set a concrete date and the trigger age is derived from your birthday; leave empty to trigger by age.",
  "modal.event.dateDerivedAge": "Derived from birthday: age {n}",
  "event.type.retire": "Retirement",
  "event.type.house": "Home",
  "event.type.child": "Child",
  "event.type.marriage": "Marriage",
  "event.type.windfall": "Windfall",
  "event.type.career": "Career",
  "event.type.custom": "Custom",
  // ─── Commands ───────────────────────────────────────────
  "command.record": "Record transaction",
  "command.insertBlock": "Insert code block",
  // ─── Insert modal ───────────────────────────────────────
  "modal.insert.title": "Insert code block",
  "modal.insert.searchPlaceholder": "Search blocks\u2026",
  "modal.insert.noMatch": "No matches",
  "modal.insert.paramsCount": "{n} params",
  "modal.insert.param.title": "Parameters",
  "modal.insert.param.optional": "optional",
  "modal.insert.param.requiredHint": " is required",
  "modal.insert.param.skip": "Skip params",
  "modal.insert.param.insert": "Insert at cursor",
  "modal.combobox.noMatch": "No matches",
  "modal.insert.noEditor": "Please open a note editor first",
  "modal.insert.inserted": "Code block inserted",
  // ─── Record transaction (direct post) ──────────────────
  "modal.record.submit": "Record",
  "modal.record.success": "Recorded to {ledgerPath}",
  "modal.record.error": "Recording failed: {error}",
  "modal.record.noDef": "Double-entry entry definition not found",
  // ─── Append-to-draft modal（add a posting into the current code block draft） ──
  "modal.draft.title": "Add record",
  "modal.draft.submit": "Add to draft",
  "modal.draft.success": "Added to the current code block draft",
  "modal.draft.empty": "Posting is empty \u2014 cancelled",
  "modal.draft.error": "Failed to add to draft: {error}",
  // ─── Ledger rollover（carry balances to a new ledger, archive the old） ──
  "modal.rollover.title": "Ledger rollover",
  "modal.rollover.newPath": "New ledger path",
  "modal.rollover.newPath.desc": "After rollover the ledger will point to this new file (old ledger kept as archive)",
  "modal.rollover.cutoff": "Cutoff date",
  "modal.rollover.cutoff.desc": "Only posted balances up to this date are carried over; unposted drafts are unaffected",
  "modal.rollover.cutoff.today": "Up to today",
  "modal.rollover.cutoff.monthEnd": "Up to month end",
  "modal.rollover.submit": "Execute rollover",
  "modal.rollover.success": "Rolled over: {oldLedgerPath} archived, new ledger {newLedgerPath}",
  "modal.rollover.error": "Rollover failed: {error}",
  // ─── Archive management (visualize / clean archiveLedgers) ──
  "settings.archiveManager": "Archive management",
  "modal.archive.title": "Archive management",
  "modal.archive.desc": "Old ledgers from rollover are archived here automatically. You can view or remove them (removing only drops them from the index; the file on disk is not deleted).",
  "modal.archive.empty": "No archived ledgers",
  "modal.archive.count": "{n} archived ledger(s)",
  "modal.archive.status.exists": "File exists",
  "modal.archive.status.missing": "File deleted (still removable)",
  "modal.archive.open": "Open",
  "modal.archive.remove": "Remove from archive",
  "modal.archive.confirmRemove": 'Remove "{path}" from archives? This only drops it from the index (file not deleted); its historical transactions will no longer be indexed (finance-log by id may show "not found").',
  "modal.archive.removed": "Removed from archive: {path}",
  // ─── Block names ────────────────────────────────────────
  "block.fin-beancount": "Double-entry entry",
  "block.fin-beancount.desc": "Record a double-entry transaction (source + destination, zero-sum check)",
  "block.finance-log": "Transaction log",
  "block.finance-log.desc": "Transaction history in reverse chronological order; filter by start date / days / amount range / account / type / owner",
  "block.finance-budget": "Budget execution",
  "block.finance-budget.desc": "Budget execution rate by category with period progress bars and status",
  "block.finance-heatmap": "Income-Expense Heatmap",
  "block.finance-heatmap.desc": "Net-amount heatmap (green = income, red = expense): calendar + category matrix views, last N days (default 182), category filter",
  "block.finance-ficalc": "Cash Flow Simulator",
  "block.finance-ficalc.desc": "Project long-term assets & cash flow, simulate life events",
  // ─── Block param labels ─────────────────────────────────
  "param.day": "Days",
  "param.day.desc": "Count back N days from the start date, inclusive (default 30; 1=start date only; 0=no day limit)",
  "param.id": "Entry ID",
  "param.id.desc": "Look up a specific entry by block-ref ID (optional); separate multiple IDs with ; \u2014 when set, the date range is ignored",
  "param.type": "Transaction type",
  "param.type.desc": "Filter by transaction type (optional, empty = all)",
  "param.logDate": "Start date",
  "param.logDate.desc": "Which day to count back from (optional, defaults to today). E.g. 2026-07-15 with days=3 covers 07-13 \u2013 07-15",
  "param.logAmount": "Amount range",
  "param.logAmount.desc": "Filter by absolute amount in yuan (optional). Pick an operator then enter a number: greater / at least / less / at most / between / equal",
  "param.amount.op.gt": "Greater than",
  "param.amount.op.gte": "At least",
  "param.amount.op.lt": "Less than",
  "param.amount.op.lte": "At most",
  "param.amount.op.between": "Between",
  "param.amount.op.eq": "Equal to",
  "param.logAccount": "Account",
  "param.logAccount.desc": "Filter by account \u2014 matches if any leg hits (optional, empty = all)",
  "param.logOwner": "Owner",
  "param.logOwner.desc": "Filter by ownership dimension (optional, empty = all)",
  "param.rate": "Annual rate",
  "param.rate.desc": "Annual return rate % (default 4)",
  "param.principal": "Interest-bearing principal",
  "param.principal.desc": "Interest-bearing principal available for retirement withdrawals (in 10k units)",
  "param.spend": "Annual spend",
  "param.spend.desc": "Annual spending (in 10k units)",
  "param.date": "Date",
  "param.date.desc": "Transaction date (defaults to today)",
  "param.narration": "Narration",
  "param.narration.desc": "Transaction narration / memo",
  "param.amount": "Amount (yuan)",
  "param.amount.desc": "Transaction amount in yuan, up to 2 decimal places (e.g. 35.00)",
  "param.fromAccount": "Source account",
  "param.fromAccount.desc": "Which account pays (defaults to last used expense account)",
  "param.toAccount": "Destination",
  "param.toAccount.desc": "What it is spent on / which account receives",
  "param.txnType": "Transaction type",
  "param.txnType.desc": "Category classification",
  "param.owner": "Owner",
  "param.owner.desc": "Ownership dimension (self / family)",
  "param.legs": "Postings",
  "param.legs.desc": "Each posting: pick an account and enter a positive amount; the debit/credit sign is derived from the account class. Use \u201CSplit posting\u201D to add more, \u201CAuto-balance\u201D to fill the gap.",
  // ─── Multi-leg entry editor (fin-beancount) ───────────────
  "legs.account": "Account",
  "legs.amount": "Amount (\xA5)",
  "legs.amountHint": "positive only \xB7 both postings equal",
  "legs.mirrorNote": "both postings equal",
  "legs.add": "+ Split posting",
  "legs.balance": "Auto-balance",
  "legs.balanced": "Balanced",
  "legs.flip": "Flip direction",
  "legs.remove": "Delete",
  "legs.needTwo": "At least 2 postings required",
  "legs.needAccount": "Every posting needs an account",
  "legs.needAmount": "Every posting needs a positive amount",
  "legs.unbalanced": "Postings do not balance (gap \xA5{diff}). Use \u201CAuto-balance\u201D or adjust amounts.",
  "legs.dir.in": "Increase",
  "legs.dir.out": "Decrease",
  "legs.dir.src": "From",
  "legs.dir.sink": "To",
  "legs.dir.flat": "Equity",
  "legs.class.asset": "Asset account",
  "legs.class.liability": "Liability account",
  "legs.class.equity": "Equity account",
  "legs.class.income": "Income account",
  "legs.class.expense": "Expense account",
  "legs.class.account": "Account",
  "param.budgetType": "Transaction type",
  "param.budgetType.desc": "Filter budgets by transaction type (optional, leave empty for all)",
  "param.heatmapDays": "Days",
  "param.heatmapDays.desc": "Show the last N days in the heatmap (default 182, range 7\u2013365)",
  "param.heatmapView": "Default view",
  "param.heatmapView.desc": "Calendar (daily granularity) or category matrix (category \xD7 time)",
  "param.heatmapGran": "Matrix granularity",
  "param.heatmapGran.desc": "Column granularity of the category matrix: by week or by month (matrix view only)",
  "param.heatmapCategory": "Category filter",
  "param.heatmapCategory.desc": "Show only one category (optional, empty = all)",
  // ─── New params after ficalc/fi merge ───────────────────
  "param.source": "Data source",
  "param.source.desc": "actual=pull net worth/spend/savings from ledger, manual=use the assumptions below",
  "param.savings": "Annual savings",
  "param.savings.desc": "Net saved each year (10k units)",
  "param.inflation": "Inflation",
  "param.inflation.desc": "Annual inflation % (default 2)",
  "param.years": "Projection years",
  "param.years.desc": "Years after retirement to project (default: auto until age 95)",
  "param.volatility": "Volatility",
  "param.volatility.desc": "Annual return volatility % (default 12; 0=deterministic)",
  "param.strategy": "Withdrawal strategy",
  "param.strategy.desc": "How much to withdraw each year before principal depletes",
  // ─── Render block UI ────────────────────────────────────
  "param.age": "Current age",
  "param.age.desc": "Age when the projection starts",
  "param.startAge": "Start age",
  "param.startAge.desc": "Chart x-axis start (if earlier than current age, fills historical net worth from ledger)",
  "param.retireAge": "Retirement age",
  "param.retireAge.desc": "Age to stop accumulating and start withdrawing",
  "param.incomeGrowth": "Savings growth",
  "param.incomeGrowth.desc": "Annual growth of net savings during accumulation (%)",
  "param.cashRate": "Cash yield",
  "param.cashRate.desc": "Annual yield of cash-like assets % (default 1.5)",
  "param.bufferMonths": "Emergency buffer (months)",
  "param.bufferMonths.desc": "Reserve N months of spending as emergency cash (no growth), default 6; asset mode only",
  "ficalc.title": "Cash Flow Simulator",
  "ficalc.basic": "Basic",
  "ficalc.banner.free": "Financially independent",
  "ficalc.banner.free.desc": "Passive income covers annual spending \u2014 money never runs out",
  "ficalc.banner.notFree": "Not yet financially independent",
  "ficalc.banner.notFree.desc": "Still need {gap} more principal",
  "ficalc.metric.requiredPrincipal": "Required principal",
  "ficalc.metric.requiredPrincipal.desc": "Total principal needed for FI",
  "ficalc.metric.gap": "Principal gap",
  "ficalc.metric.gap.desc": "How much more to reach FI",
  "ficalc.metric.gap.done": "Achieved",
  "ficalc.metric.years": "Years sustainable",
  "ficalc.metric.years.desc": "How long current principal + spend can last",
  "ficalc.metric.maxSpend": "Max annual spend",
  "ficalc.metric.maxSpend.desc": "Annual spending limit without depleting principal",
  "log.title": "Transaction register",
  "log.loading": "Loading\u2026",
  "log.empty": "No transactions found",
  "log.emptyFiltered": "No entries match the filters (try relaxing amount / account / type / owner)",
  "log.readError": "Read failed",
  "log.dayLabel.today": "Today",
  "log.dayLabel.days": "Last {n} days",
  "log.dayLabel.dateOnly": "{d} only",
  "log.dayLabel.daysUntil": "{n} days up to {d}",
  "log.dayLabel.until": "{d} and earlier",
  "log.dayLabel.byId": "By ID",
  "log.idNotFound": "No entries found for the given ID(s) (check the ID or post the entry first)",
  "log.dayLabel.all": "All",
  "log.criteria.amount": "Amount",
  "log.criteria.account": "Account",
  "log.criteria.type": "Type",
  "log.criteria.owner": "Owner",
  "log.count": "{label} \xB7 {n} entries",
  "log.noNarration": "(no narration)",
  "log.filter.all": "All",
  "log.filter.in": "Income",
  "log.filter.out": "Expense",
  "log.summary.show": "{n} shown",
  "log.summary.income": "Income",
  "log.summary.expense": "Expense",
  "log.summary.net": "Net",
  "log.summary.count": "{n} entries",
  // ─── Log v2.5 (kind classification · direction · headline · filter) ──
  "log.filter.kindLabel": "Type",
  "log.filter.allAccounts": "All accounts",
  "log.filter.searchPlaceholder": "Search narration / account\u2026",
  "log.kind.transfer": "Transfer",
  "log.kind.buy": "Buy asset",
  "log.kind.sell": "Sell asset",
  "log.kind.income": "Income",
  "log.kind.expense": "Expense",
  "log.kind.opening": "Opening",
  "log.kind.equity": "Equity Change",
  "log.dir.in": "Inflow",
  "log.dir.out": "Outflow",
  "log.dir.transfer": "Transfer",
  "log.headline.inflow": "Inflow",
  "log.headline.outflow": "Outflow",
  "log.headline.buyAsset": "Buy asset",
  "log.headline.sellAsset": "Sell asset",
  "log.headline.transfer": "Transfer",
  "log.headline.opening": "Equity",
  "log.headline.equity": "Equity Change",
  "log.headline.realized": "Realized",
  "beancount.ok": "\u2713 {n} transaction(s), zero-sum validated",
  "beancount.post": "Post",
  "beancount.posted": "\u2713 Posted",
  "beancount.batchPost": "Batch post ({n} entries)",
  "beancount.batchPostSuccess": "Batch post success: {success}/{total} entries",
  "beancount.postedEditWarning": "\u26A0 Posted transaction is unbalanced \u2014 please fix in the ledger",
  "beancount.rollover": "Roll over",
  "beancount.postSuccess": "Posted successfully, written to {ledgerPath}",
  "beancount.postError.noFile": "Cannot find source file",
  "beancount.postError.notFound": "Cannot locate code block position",
  "beancount.postError.generic": "Post failed: {error}",
  // ─── Poster error messages ──────────────────────────────
  "poster.err.notFound": "Record #{n} not found",
  "poster.err.postedTxn": "Transaction already posted, cannot post again",
  "poster.err.postedVal": "Valuation already posted, cannot post again",
  "poster.err.noValuation": "No valuation found",
  "poster.err.noTxn": "No transaction found",
  "poster.err.writeFailed": "Failed to write to ledger: {error}",
  "poster.err.unknown": "unknown error",
  "poster.err.blockMoved": "The code block has moved and cannot be replaced in place (entry was posted; draft kept in the source note)",
  // ─── Parser (fin-beancount) error messages ───────────────
  "parser.err.noPostings": "Transaction has no posting lines: {date} {narration}",
  "parser.err.zeroSum": "Zero-sum unbalanced (diff {diff} cents): {date} {narration}",
  "parser.err.noDateCtx": "Unrecognized line (no date context): {line}",
  "parser.err.unparsable": "Unparsable line: {line}",
  // ─── Double-entry rewrite (visual redesign) ─────────────────
  "beancount.title": "Double-entry ledger",
  "beancount.draftPill": "Draft",
  "beancount.currentPill": "Current ledger",
  "beancount.addRecord": "Add record",
  "beancount.draftCount": "{n} entries pending post",
  "beancount.count": "Total {n} entries",
  "beancount.zeroSum": "Validated",
  "beancount.pending": "Pending",
  "beancount.rolledTo": "Rolled over to",
  "beancount.rolled": "Rolled over",
  "beancount.fromRollover": "Carried from",
  "beancount.chainCap": "Ledger chain",
  "beancount.summary.income": "Income",
  "beancount.summary.expense": "Expense",
  "beancount.summary.net": "Net",
  "beancount.copyTitle": "Copy this record block, for finance-log precise lookup",
  "beancount.copyFullTitle": "Copy this record block",
  "beancount.copyLabel": "Copy",
  "beancount.copyDone": "Copied",
  // Soft warnings (report #1): advisory only, never blocks posting
  "beancount.warn.signFlipped": "Sign may be flipped",
  "beancount.warn.signFlippedTip": "{accounts} are income/expense accounts but the sign is inverted (income should be negative, expense positive). Safe to ignore for refunds.",
  "beancount.warn.unclassified": "Account undeclared",
  "beancount.warn.unclassifiedTip": "{accounts} have no class declared in Account Manager and no parent to inherit from \u2014 they are excluded from net worth and budgets.",
  "beancount.warn.tagMismatch": "Tag / structure mismatch",
  "beancount.warn.tagMismatchTip": 'Tag "{tag}" is declared as {direction}, but this entry has no {direction} posting. If it is merely an asset transfer (buying stock, repaying a loan), the tag will pollute filters and budgets.',
  "beancount.warn.foot": "{n} entries need review",
  "beancount.warn.dirIncome": "income",
  "beancount.warn.dirExpense": "expense",
  "beancount.addRecordFailed": "Cannot insert record into this note",
  "beancount.group.flat": "Each",
  "beancount.group.day": "Day",
  "beancount.group.week": "Week",
  "beancount.group.month": "Month",
  "beancount.group.custom": "Custom",
  "beancount.group.start": "Start",
  "beancount.group.every": "Every",
  "beancount.group.unit": "days per group",
  "beancount.group.expandAll": "Expand",
  "beancount.group.collapseAll": "Collapse",
  "beancount.group.count": "{n} entries",
  "beancount.group.all": "All",
  "beancount.group.weekday0": "Sun",
  "beancount.group.weekday1": "Mon",
  "beancount.group.weekday2": "Tue",
  "beancount.group.weekday3": "Wed",
  "beancount.group.weekday4": "Thu",
  "beancount.group.weekday5": "Fri",
  "beancount.group.weekday6": "Sat",
  "beancount.group.monthLabel": "{year}/{month}",
  // ─── Asset valuation (fb-valuation, rendered inside fin-beancount) ───
  "valuation.title": "Asset Valuation",
  "valuation.sectionTxn": "Transactions",
  "valuation.sectionVal": "Valuation snapshots",
  "valuation.containsPill": "{n} valuations",
  "valuation.addValuation": "Add valuation",
  "valuation.draftCount": "{n} pending",
  "valuation.count": "{n} valuations \xB7 {a} accounts",
  "valuation.batchPost": "Post all ({n})",
  "valuation.noHistory": "No history",
  "valuation.vs": "vs {date}",
  "valuation.sameDaySuffix": " (same day)",
  "valuation.bookLabel": "Book {amount}",
  "valuation.unrealized": "Unrealized {amount}",
  "valuation.kind.market": "Market",
  "valuation.kind.book": "Book",
  "valuation.kind.unknown": "Unconfigured",
  "valuation.meta.kind": "valuation: {kind}",
  "valuation.meta.owner": "owner: {owner}",
  "valuation.meta.gap": "{n} days since last",
  "valuation.meta.stale": "\u26A0 Stale (threshold {n} days)",
  "valuation.meta.unknownAccount": "\u26A0 Account not defined in finance-config",
  "valuation.meta.bookWarn": "This account is valuation: book \u2014 valuations are ignored",
  "valuation.meta.bookSuggest": "Consider switching to market",
  "valuation.meta.sameDay": "A valuation already exists for this date; this one wins",
  "valuation.zeroSumNote": "Valuations skip the zero-sum check \xB7 {n}",
  "valuation.banner.stale": "{n} account(s) with stale valuations: {list}",
  "valuation.banner.staleItem": "{account} ({n} days since last, threshold {threshold})",
  "valuation.banner.unknown": 'Account "{list}" is not configured \u2014 parsed but excluded from net worth',
  "valuation.banner.update": "Update",
  "valuation.group.flat": "Each",
  "valuation.group.account": "By account",
  "valuation.group.month": "By month",
  "valuation.group.latest": "Latest",
  "valuation.group.times": "{n} times",
  "valuation.group.daysAgo": "{n} days ago",
  "valuation.group.stale": "\u26A0 Stale",
  "valuation.group.first": "First",
  "valuation.group.month.label": "{k}",
  "valuation.group.month.sum": "{n} valuations \xB7 {accounts}",
  "valuation.copyTitle": "Copy the ^v- block reference",
  "valuation.empty": 'No valuations yet \u2014 click "Add valuation" to snapshot a market-priced asset',
  // ─── Budget view ────────────────────────────────────────
  "budget.title": "Budget Execution",
  "budget.empty": "No budget plans",
  "budget.uncategorized": "Uncategorized",
  "budget.period.day": "Daily",
  "budget.period.week": "Weekly",
  "budget.period.month": "Monthly",
  "budget.period.year": "Yearly",
  "budget.period.custom": "Every {n} days",
  // ─── Heatmap (net income/expense, v3) ────────────────────
  "heatmap.title": "Income-Expense Heatmap",
  "heatmap.empty": "No records",
  "heatmap.uncategorized": "Uncategorized",
  "heatmap.others": "Others",
  "heatmap.dayLabel": "Last {n} days",
  "heatmap.dayPrefix": "Last",
  "heatmap.daySuffix": "days",
  "heatmap.dayTitle": "Show the last N days (code-block param day, default 182)",
  "heatmap.catFilterTitle": "Filter by category",
  "heatmap.all": "All categories",
  "heatmap.dir.income": "IN",
  "heatmap.dir.expense": "OUT",
  "heatmap.view.calendar": "Calendar",
  "heatmap.view.matrix": "Category Matrix",
  "heatmap.gran.week": "Weekly",
  "heatmap.gran.month": "Monthly",
  "heatmap.metric.net": "Net amount",
  "heatmap.metric.netSub": "income \u2212 expense",
  "heatmap.metric.expense": "Total expense",
  "heatmap.metric.income": "Total income",
  "heatmap.metric.max": "Peak day",
  "heatmap.metric.daily": "{n} / day",
  "heatmap.metric.maxSub": "{date} {weekday} \xB7 {kind}",
  "heatmap.cal.hint": "Hover for daily detail \xB7 click a cell for the day \xB7 outline = today \xB7 dashed = outside the last {n} days",
  "heatmap.matrix.hint": "Click a row header to sort by total \xB7 click a cell for that category \xB7 hover for amount / count / delta \xB7 tail curve = trend",
  "heatmap.matrix.total": "Total",
  "heatmap.legend.income": "Income",
  "heatmap.legend.expense": "Expense",
  "heatmap.legend.note": "green = net income \xB7 red = net expense \xB7 blank = none",
  "heatmap.sort.hint": "Click a row header to sort \u2193\u2191",
  "heatmap.sort.desc": "by total \u2193 (click again to reset)",
  "heatmap.sort.asc": "by total \u2191 (click again to reset)",
  "heatmap.sort.tip": "Range total \xB7 click header to sort",
  "heatmap.expand.all": "Show all categories ({n})",
  "heatmap.expand.collapse": "Collapse",
  "heatmap.tip.none": "No activity",
  "heatmap.tip.net": "Net",
  "heatmap.tip.delta": "vs prev.",
  "heatmap.tip.incomeDay": "income day",
  "heatmap.tip.expenseDay": "expense day",
  "heatmap.detail.close": "Close",
  "heatmap.detail.colCat": "Category",
  "heatmap.detail.colAmount": "Amount",
  "heatmap.detail.colCount": "Count",
  "heatmap.detail.sum": "Net",
  "heatmap.detail.count": "{n} txns",
  "heatmap.detail.noData": "No records in this period",
  "heatmap.detail.dayTitle": "{date} {weekday} \xB7 detail",
  "heatmap.detail.catTitle": "{cat} \xB7 {range}",
  // ─── Financial independence calculator (redesign: finance-fi merged) ──
  "ficalc.unit.wan": "10k",
  "ficalc.unit.yi": "100M",
  "ficalc.unit.year": "yr",
  "ficalc.forever": "Never depletes",
  "ficalc.withinYear": "\u22641 yr",
  "ficalc.yearsValue": "{n} yr",
  "ficalc.source.actual": "Actual (ledger)",
  "ficalc.source.manual": "Simulate",
  "ficalc.source.assets": "Asset accounts",
  "ficalc.source.noData": "No ledger data \u2014 switched to manual",
  "ficalc.source.manual.hint": 'Simulation mode: numbers are entered directly \u2014 a "what-if" sandbox. Once you configure asset accounts in Settings \u203A Account manager, this block auto-switches to "Asset accounts" mode and pre-fills principal / annual spend / annual savings.',
  "ficalc.source.assets.hint": "Auto bucketed from asset accounts in finance-config.json; drag any slider to override.",
  "ficalc.source.manual.cta": "Configure asset accounts \u2192 auto-enable",
  "ficalc.assetParams.hint": "Cash yield / emergency buffer: used in asset-bucket calculation when asset accounts exist (cash above buffer grows at cash yield); saved as presets otherwise.",
  "ficalc.snapshot.netWorth": "Net {v}",
  "ficalc.snapshot.spend": "Spend {v}",
  "ficalc.snapshot.savings": "Save {v}",
  "ficalc.snapshot.partial": "Only {months} months of data",
  "ficalc.more": "More assumptions",
  "ficalc.pill.success": "Success {v}",
  "ficalc.progress": "Progress {v}%",
  "ficalc.metric.swr": "Safe withdrawal rate",
  "ficalc.metric.swr.desc": "Annual spend / principal (higher = more aggressive)",
  "ficalc.metric.reach": "Years to FI",
  "ficalc.metric.reach.desc": "At the current savings pace, how long until FI",
  "ficalc.metric.savings": "Annual savings",
  "ficalc.metric.savings.desc": "Yearly surplus that accelerates accumulation",
  "ficalc.metric.fiAge": "FI milestone",
  "ficalc.metric.fiAge.desc": "Age when passive income sustainably covers spending",
  "ficalc.banner.notFree.pace": "Still need {gap}; at current pace ~{years} yr to FI ({targetYear})",
  "ficalc.strategy.fixed": "Fixed amount",
  "ficalc.strategy.fixed.desc": "Withdraw a fixed amount each year until principal runs out",
  "ficalc.strategy.percent": "Fixed percent",
  "ficalc.strategy.percent.desc": "Withdraw a fixed percent of current principal \u2014 floats with the market",
  "ficalc.strategy.rule95": "95% rule",
  "ficalc.strategy.rule95.desc": "Take the larger of current-principal percent and 95% of last year's withdrawal",
  "ficalc.sim.title": "Monte Carlo simulation",
  "ficalc.sim.toggle": "Monte Carlo simulation",
  "ficalc.sim.toggleHint": "Click to expand success rate and percentile bands (computed only when opened)",
  // ─── Save button (the only place that writes back to source) ──
  "ficalc.save": "Save params",
  "ficalc.save.hint": "Write current sliders/options into the code block so they persist next open",
  "ficalc.events": "Events",
  "ficalc.events.hint": "Plan milestones like buying a home or having a child, and simulate their long-term impact",
  "ficalc.lifecycle.eventTipNote": "Click to open the linked note",
  "ficalc.lifecycle.eventTipEdit": "Click to manage events",
  "ficalc.saved": "Saved \u2713",
  "ficalc.save.noFile": "Save only works inside a note file",
  "ficalc.sim.note": "{runs} runs \xB7 {years} yr",
  "ficalc.sim.successRate": "Success rate",
  "ficalc.sim.endMedian": "Median end",
  "ficalc.sim.endWorst": "Worst end",
  "ficalc.sim.endBest": "Best end",
  "ficalc.sim.zeroCount": "Depleted runs",
  "ficalc.sim.smallSpend": "Cut-spend rate",
  "ficalc.sim.zeroCountValue": "{n}/{total} runs hit zero",
  "ficalc.chart.hint": "Hover to inspect each year's percentiles",
  "ficalc.lifecycle.fi": "FI milestone: age {age}",
  "ficalc.lifecycle.noFi": "Not FI under current assumptions",
  "ficalc.lifecycle.aria": "Three-layer life chart: net-worth curve / cash-flow bars (green positive, red negative) / key events",
  "ficalc.lifecycle.start": "Now",
  "ficalc.lifecycle.retire": "Retire",
  "ficalc.lifecycle.readout": "Age {age}: net {net}, surplus {flow}",
  "ficalc.lifecycle.layerNet": "Net worth curve",
  "ficalc.lifecycle.layerFlow": "Cash flow",
  "ficalc.lifecycle.layerEvent": "Key events",
  "ficalc.lifecycle.zeroLine": "Zero line",
  "ficalc.lifecycle.retireEvent": "Retire",
  "ficalc.lifecycle.eventNote": "\u{1F4DD}",
  "ficalc.lifecycle.legendNet": "Net worth",
  "ficalc.lifecycle.legendFlow": "Cash flow positive",
  "ficalc.lifecycle.legendNeg": "Cash flow negative",
  "ficalc.lifecycle.legendHist": "History",
  "ficalc.lifecycle.legendEvent": "Key events (note link)",
  "ficalc.lifecycle.now": "Now",
  "ficalc.lifecycle.nowShort": "Now",
  "ficalc.lifecycle.readoutHist": "Age {age}: ledger net worth {net} (historical)",
  "ficalc.chart.aria": "Portfolio P10 / P50 / P90 trajectory across retirement years",
  "ficalc.chart.start": "Start",
  "ficalc.chart.readout": "{year}: median {p50} (P10 {p10} ~ P90 {p90})",
  "ficalc.table.year": "Year",
  "ficalc.table.p10": "P10",
  "ficalc.table.p50": "P50",
  "ficalc.table.p90": "P90",
  // ─── finance-fi progress dashboard (M3) ─────────────────
  "fi.title": "FI Progress",
  "fi.noData": "Not enough bookkeeping data yet. Start recording transactions.",
  "fi.alreadyFree": "Achieved",
  "fi.withinYear": "\u22641 year",
  "fi.yearUnit": "years",
  "fi.banner.free": "Financially independent",
  "fi.banner.freeDesc": "Passive income covers annual spending \u2014 money never runs out",
  "fi.banner.notFree": "Not yet financially independent",
  "fi.banner.yearsToGoal": "At current pace ~{years} years to FI ({targetYear})",
  "fi.banner.cannotReach": "Current savings rate cannot reach FI target",
  "fi.metric.netWorth": "Net worth",
  "fi.metric.netWorthDesc": "Total assets - total liabilities",
  "fi.metric.target": "Target principal",
  "fi.metric.targetDesc": "Total principal needed for FI",
  "fi.metric.gap": "Principal gap",
  "fi.metric.gapDone": "Achieved",
  "fi.metric.gapDesc": "How much more to reach FI",
  "fi.metric.annualSpend": "Annual spend",
  "fi.metric.actualSpend": "Last 12 months actual",
  "fi.metric.insufficientMonths": "{n} months only",
  "fi.metric.annualSavings": "Annual savings",
  "fi.metric.savingsDesc": "Income - spending",
  "fi.metric.maxSpend": "Sustainable spend",
  "fi.metric.maxSpendDesc": "Max annual spend without depleting principal",
  "fi.dataHint": "(Based on {months} months of data, proportionally annualized)",
  // ─── Asset management ───────────────────────────────────────
  "block.finance-assets": "Asset overview",
  "block.finance-assets.desc": "Asset market-value overview: net worth (market) + allocation + per-card valuation + liabilities",
  "param.assetsOwner": "Owner",
  "param.assetsOwner.desc": "Filter accounts by ownership (optional, empty = all combined)",
  "param.assetsGroup": "Group by",
  "param.assetsGroup.desc": "class=by asset/liability (default), prefix=by account name prefix",
  // ── Account editor (asset management extensions) ──
  "modal.accounts.owner": "Owner",
  "modal.accounts.ownerPlaceholder": "Ownership (defaults to global default)",
  "modal.accounts.valuation": "Valuation method",
  "modal.accounts.valuation.book": "Book (transaction balance)",
  "modal.accounts.valuation.market": "Market (manual valuation)",
  "modal.accounts.valuationPlaceholder": "Select valuation method",
  "modal.accounts.staleDays": "Valuation stale days",
  "modal.accounts.staleDaysPlaceholder": "Defaults to global (30 days)",
  "modal.accounts.staleDaysHint": "Only for market/depreciation accounts; book accounts need no valuation",
  "modal.accounts.cashflowRole": "Cash-flow role",
  "modal.accounts.cashflowRolePlaceholder": "Select cash-flow behavior (inferred from valuation if empty)",
  "modal.accounts.cashflowRole.growth": "Growth (interest-earning)",
  "modal.accounts.cashflowRole.cash": "Cash-like",
  "modal.accounts.cashflowRole.fixed": "Non-interest asset",
  "modal.accounts.cashflowRole.rental": "Rental property",
  // ── Specific assets manager (2026-08-04: amounts live on assets, not accounts) ──
  // ── Asset overview view ──
  "assets.title": "Asset overview",
  "assets.marketPill": "Market basis \xB7 with holdings",
  "assets.netWorth": "Net worth (market)",
  "assets.totalAssets": "Total assets",
  "assets.totalLiabilities": "Total liabilities",
  "assets.unrealizedPnL": "Unrealized P&L",
  "assets.realizedPnL": "Realized P&L",
  "assets.realizedShort": "Realized",
  "assets.unrealizedShort": "Unrealized",
  "assets.staleBadge": "Valuation stale",
  "assets.carriedBadge": "Traded after valuation",
  "assets.holdingsHint": "(investments expanded by holding)",
  "assets.holdingsHead": "Holdings ({n})",
  "assets.reconDiff": "Reconciliation gap {amount}",
  "assets.reconUnclassified": "{n} account(s) without a class",
  "assets.reconHint": "Assets \u2212 Liabilities should equal Equity + Retained earnings. A gap usually means an account has no class declared in settings, or a transaction does not balance.",
  "assets.unvalued": "Unvalued",
  "assets.updateValuation": "Update valuation",
  "assets.bookValue": "Book",
  "assets.marketValue": "Market",
  "assets.valuationSource.valuation": "Manual valuation",
  "assets.valuationSource.book": "Book fallback",
  "assets.lastValuation": "Last valuation: {date}",
  "assets.noValuation": "No valuation yet",
  "assets.groupAssets": "Assets",
  "assets.groupLiabilities": "Liabilities",
  "assets.allocTitle": "Allocation (by category)",
  "assets.empty": "No asset accounts yet \u2014 add them in Account manager",
  "assets.footNote": 'Valuations come from custom "fb-valuation" directives in the ledger; draft blocks are excluded',
  "assets.trend": "Asset trend",
  "assets.trend.month": "Month",
  "assets.trend.quarter": "Quarter",
  "assets.trend.year": "Year",
  "assets.trend.empty": "Not enough data to draw a trend (need at least two sample points)",
  // ── Update valuation modal ──
  "modal.valuation.title": "Update valuation",
  "modal.valuation.account": "Account",
  "modal.valuation.amount": "Market value (yuan)",
  "modal.valuation.amountPlaceholder": "e.g. 1250000 (1.25M)",
  "modal.valuation.currency": "Currency",
  "modal.valuation.date": "Valuation date",
  "modal.valuation.comment": "Comment",
  "modal.valuation.commentPlaceholder": "e.g. ~350 shares at close",
  "modal.valuation.success": "Valuation written to {ledgerPath}",
  "modal.valuation.error": "Valuation failed: {error}",
  "modal.valuation.amountRequired": "Please enter the market value",
  "modal.valuation.subtitle": "Take a fair-value snapshot for assets priced at market value. No entries are created; book balance is unchanged.",
  "modal.valuation.hint.book": "\u26A0 This account uses book-value pricing (valuation: book). Valuations will not affect the market-value view \u2014 consider switching to market in Account manager.",
  "modal.valuation.hint.market": "Market-value pricing \xB7 stale threshold {n} days",
  "modal.valuation.hint.lastAt": " \xB7 last valued {date}",
  "modal.valuation.noAssetAccount": "No asset accounts configured yet \u2014 add them in Settings first",
  "modal.valuation.preview": "Live preview",
  "modal.valuation.pv.last": "Last valuation",
  "modal.valuation.pv.delta": "Change",
  "modal.valuation.pv.book": "Book balance",
  "modal.valuation.pv.pnl": "Unrealized P&L",
  "modal.valuation.pv.willWrite": "Will write:",
  "modal.valuation.quick.same": "Same as last",
  "modal.valuation.lockedHint": "Locked to this asset \u2014 only this entry is updated (not the whole account)",
  // ─── finance-recurring (daily plans + loans) ────────────────
  "block.finance-recurring": "Recurring",
  "block.finance-recurring.desc": "Set a plan once, get daily due drafts, post with one click; loans generate 3-leg entries from the repayment schedule",
  "recurring.title": "Recurring",
  "recurring.pill.due": "{n} due today",
  "recurring.pill.done": "All posted \u2713",
  "recurring.due.title": "Due today",
  "recurring.due.all": "Post all",
  "recurring.due.empty": "Nothing due today \u{1F389}",
  "recurring.tab.plans": "My plans",
  "recurring.tab.loans": "My loans",
  "recurring.new.plan": "+ New plan",
  "recurring.new.loan": "+ New loan",
  "recurring.badge.loan": "LOAN",
  "recurring.post": "Post",
  "recurring.skip": "Skip",
  "recurring.editAmount": "Edit amount",
  "recurring.posted": "Posted: {name}",
  "recurring.postError": "Post failed: {error}",
  "recurring.skipped": "Skipped: {name}",
  "recurring.confirmAll": "Post all {n} entries? (Ledger is append-only; a mistaken batch must be fixed by hand)",
  "recurring.confirmAllTitle": "Post all",
  "recurring.batchPartial": "Some failed ({fail})",
  "recurring.batchDone": "Posted {n} \u2713",
  "recurring.editAmountTitle": "Edit amount (this time only): {name} \xB7 {date}",
  "recurring.modal.cancel": "Cancel",
  "recurring.modal.save": "Save",
  "recurring.modal.planTitle": "Recurring plan",
  "recurring.modal.loanTitle": "Loan",
  "recurring.modal.err.name": "Name is required",
  "recurring.modal.err.amount": "Amount must be > 0",
  "recurring.modal.err.account": "Pick an expense account",
  "recurring.modal.err.fromAccount": "Pick a funding account",
  "recurring.modal.err.txnType": "Pick a category",
  "recurring.modal.err.startDate": "Pick a date",
  "recurring.modal.err.monthlyDay": "Day of month must be 1\u201328",
  "recurring.modal.err.nameDup": "Plan name already exists",
  "recurring.modal.err.loanPrincipal": "Principal must be > 0",
  "recurring.modal.err.loanRate": "Rate must be > 0",
  "recurring.modal.err.loanYears": "Term must be 1\u201350 years",
  "recurring.modal.err.loanAccounts": "Funding / liability / interest accounts are required",
  "recurring.plan.name": "Name",
  "recurring.plan.amount": "Amount (CNY)",
  "recurring.plan.frequency": "Frequency",
  "recurring.plan.account": "Expense account",
  "recurring.plan.fromAccount": "Funding account",
  "recurring.plan.txnType": "Category",
  "recurring.plan.owner": "Owner",
  "recurring.plan.monthlyDay": "Day of month (1\u201328)",
  "recurring.plan.startDate": "Start date",
  "recurring.plan.endDate": "End date (optional)",
  "recurring.plan.note": "Note",
  "recurring.freq.daily": "Daily",
  "recurring.freq.weekday": "Weekdays (Mon\u2013Fri)",
  "recurring.freq.monthly": "Monthly on day N",
  "recurring.freq.monthlyShort": "Monthly on {d}",
  "recurring.loan.name": "Name",
  "recurring.loan.principal": "Principal (CNY)",
  "recurring.loan.annualRate": "Annual rate (%)",
  "recurring.loan.termYears": "Term (years)",
  "recurring.loan.type": "Repayment",
  "recurring.loan.type.annuity": "Equal payment",
  "recurring.loan.type.equalPrincipal": "Equal principal",
  "recurring.loan.type.interestFirst": "Interest first",
  "recurring.loan.frequency": "Period",
  "recurring.loan.freq.monthly": "Monthly",
  "recurring.loan.freq.quarterly": "Quarterly",
  "recurring.loan.firstPaymentDate": "First payment date",
  "recurring.loan.remaining": "Remaining principal (CNY)",
  "recurring.loan.remainingHint": "Lowering this = simulated partial prepayment; the schedule continues from the next unpaid period at the new remaining principal",
  "recurring.loan.assetAccount": "Funding account",
  "recurring.loan.liabilityAccount": "Liability account",
  "recurring.loan.interestAccount": "Interest account",
  "recurring.loan.txnType": "Category",
  "recurring.loan.owner": "Owner",
  "recurring.loan.note": "Note",
  "recurring.loan.preview": "Payment preview",
  "recurring.loan.previewEmpty": "Enter principal / rate / term to preview",
  "recurring.loan.pvSplit": "First principal / interest",
  "recurring.loan.pvPeriods": "Total periods",
  "recurring.loan.pvInterest": "Total interest (est.)",
  "recurring.loan.pvDesc": "{n} periods",
  "recurring.loan.defaultName": "Loan",
  "recurring.loan.perPeriod": " / period",
  "recurring.loan.splitFmt": "Principal {principal} \xB7 Interest {interest}",
  "recurring.loan.periods": "{n} period(s)",
  "recurring.loan.periodLabel": "Period {n}",
  "recurring.loan.principalPart": "Principal",
  "recurring.loan.interest": "Interest",
  "recurring.loan.years": "y",
  "recurring.loan.next": "Next",
  "recurring.loan.paid": "{n}/{m} paid",
  "recurring.plans.empty": "No plans yet \u2014 click New plan",
  "recurring.loans.empty": "No loans yet \u2014 click New loan",
  "recurring.status.running": "Active",
  "recurring.status.paused": "Paused",
  "recurring.edit": "Edit",
  "recurring.pause": "Pause",
  "recurring.resume": "Resume",
  "recurring.del": "Delete",
  "recurring.confirmDelPlan": 'Delete plan "{name}"? Posted entries are unaffected',
  "recurring.confirmDelLoan": 'Delete loan "{name}"? Posted entries are unaffected'
};

// src/i18n/index.ts
var locales = { zh, en };
var current = "zh";
function t(key, vars) {
  let text = locales[current]?.[key] ?? locales.zh[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, "g"), () => v);
    }
  }
  return text;
}

// src/util/ledgerView.ts
function parseYmd(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// src/parser/finBeancount.ts
var DATE_RE = /^(\d{4}-\d{2}-\d{2})\s+([*!])?\s*(.*)$/;
var LEG_RE = /^\s+([\p{L}\p{N}_:／/-]+)\s+(-?\d+)\s*([A-Z]{3})?\s*$/u;
var META_RE = /^\s+([\p{L}\p{N}_][\p{L}\p{N}_-]*):\s+(.+)$/u;
var VALUATION_RE = /^(\d{4}-\d{2}-\d{2})\s+custom\s+"fb-valuation"\s+([\p{L}\p{N}_:／/-]+)\s+(-?\d+)\s*([A-Z]{3})?\s*$/u;
function parseFinBeancount(source, opts) {
  const transactions = [];
  const valuations = [];
  const errors = [];
  const lines = source.split(/\r?\n/);
  let current2 = null;
  let lastValuation = null;
  let txnIndex = 0;
  const flush = () => {
    if (!current2)
      return;
    const sum = current2.legs.reduce((acc, l) => acc + l.amount, 0);
    if (current2.legs.length === 0) {
      errors.push({
        line: current2.startLine,
        message: t("parser.err.noPostings", { date: current2.date, narration: current2.narration })
      });
    } else if (sum !== 0) {
      errors.push({
        line: current2.startLine,
        message: t("parser.err.zeroSum", {
          diff: `${sum > 0 ? "+" : ""}${sum}`,
          date: current2.date,
          narration: current2.narration
        })
      });
    }
    const id = current2.blockRefId ?? `^t-${current2.date.replace(/-/g, "")}${String(txnIndex).padStart(4, "0")}`;
    const txn = {
      id,
      date: current2.date,
      legs: current2.legs,
      draft: opts?.draft ?? false
    };
    if (current2.narration)
      txn.narration = current2.narration;
    if (current2.currency)
      txn.currency = current2.currency;
    if (current2.meta["type"])
      txn.txnType = current2.meta["type"];
    if (current2.meta["owner"])
      txn.owner = current2.meta["owner"];
    const reservedKeys = /* @__PURE__ */ new Set(["type", "owner"]);
    const fields = {};
    for (const [k, v] of Object.entries(current2.meta)) {
      if (!reservedKeys.has(k))
        fields[k] = v;
    }
    if (Object.keys(fields).length > 0)
      txn.fields = fields;
    transactions.push(txn);
    current2 = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    let line = lines[i];
    const commentIdx = line.indexOf(";");
    let inlineComment;
    if (commentIdx === 0)
      continue;
    if (commentIdx > 0) {
      inlineComment = line.slice(commentIdx + 1).trim();
      line = line.slice(0, commentIdx);
    }
    if (line.trim() === "") {
      flush();
      lastValuation = null;
      continue;
    }
    if (/^\^[tv]-/.test(line.trim())) {
      const ref = line.trim();
      if (ref.startsWith("^v-")) {
        if (lastValuation)
          lastValuation.blockRef = ref;
      } else if (current2) {
        current2.blockRefId = ref;
      }
      continue;
    }
    const valMatch = VALUATION_RE.exec(line);
    if (valMatch) {
      flush();
      const val = {
        date: valMatch[1],
        account: valMatch[2],
        amount: parseInt(valMatch[3], 10),
        currency: valMatch[4] || void 0,
        comment: inlineComment || void 0
      };
      valuations.push(val);
      lastValuation = val;
      continue;
    }
    const dateMatch = DATE_RE.exec(line);
    if (dateMatch) {
      flush();
      lastValuation = null;
      txnIndex++;
      current2 = {
        date: dateMatch[1],
        flag: dateMatch[2] || void 0,
        narration: dateMatch[3].trim(),
        legs: [],
        meta: {},
        currency: void 0,
        startLine: lineNo
      };
      continue;
    }
    if (!current2) {
      if (line.trim() !== "") {
        errors.push({
          line: lineNo,
          message: t("parser.err.noDateCtx", { line: line.trim() })
        });
      }
      continue;
    }
    const legMatch = LEG_RE.exec(line);
    if (legMatch) {
      const amount = parseInt(legMatch[2], 10);
      const currency = legMatch[3] || void 0;
      current2.legs.push({ account: legMatch[1], amount });
      if (currency)
        current2.currency = currency;
      continue;
    }
    const metaMatch = META_RE.exec(line);
    if (metaMatch) {
      current2.meta[metaMatch[1]] = metaMatch[2].trim();
      continue;
    }
    errors.push({ line: lineNo, message: t("parser.err.unparsable", { line: line.trim() }) });
  }
  flush();
  return { transactions, valuations, errors };
}

// src/engine/loan.ts
function periodsPerYear(f) {
  return f === "quarterly" ? 4 : 12;
}
function dateOfPeriod(def, period) {
  const d = parseYmd(def.firstPaymentDate);
  const steps = period - 1;
  if (def.frequency === "quarterly")
    d.setMonth(d.getMonth() + steps * 3);
  else
    d.setMonth(d.getMonth() + steps);
  return localDateString(d);
}
function computeLoanSchedule(def, opts = {}) {
  const ppy = periodsPerYear(def.frequency);
  const n = def.termYears * ppy;
  const start = Math.max(1, opts.startPeriod ?? 1);
  if (start > n)
    return [];
  const principal = opts.remainingPrincipal ?? def.principal;
  const r = def.annualRate / 100 / ppy;
  const periods = [];
  let remaining = principal;
  const push = (period, total, pPart, interest) => {
    remaining -= pPart;
    periods.push({
      period,
      date: dateOfPeriod(def, period),
      total,
      principalPart: pPart,
      interestPart: interest,
      remainingBalance: remaining
    });
  };
  if (def.type === "annuity") {
    const A = Math.round(principal * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1));
    for (let period = start; period <= n; period++) {
      const interest = Math.round(remaining * r);
      const pPart = period === n ? remaining : A - interest;
      push(period, pPart + interest, pPart, interest);
    }
    return periods;
  }
  if (def.type === "equal-principal") {
    const pp = Math.round(principal / n);
    for (let period = start; period <= n; period++) {
      const interest = Math.round(remaining * r);
      const pPart = period === n ? remaining : Math.min(pp, remaining);
      push(period, pPart + interest, pPart, interest);
    }
    return periods;
  }
  for (let period = start; period <= n; period++) {
    const interest = Math.round(principal * r);
    const pPart = period === n ? remaining : 0;
    push(period, pPart + interest, pPart, interest);
  }
  return periods;
}
function loanEntryText(period, def, config) {
  const asset = legSignedCents(def.assetAccount, period.total, "out", config);
  const liab = legSignedCents(def.liabilityAccount, period.principalPart, "out", config);
  const interest = legSignedCents(def.interestAccount, period.interestPart, "in", config);
  const lines = [
    `${period.date} * ${def.name}`,
    `  ${def.assetAccount}  ${asset}`,
    `  ${def.liabilityAccount}  ${liab}`,
    `  ${def.interestAccount}  ${interest}`,
    `  loan: ${def.id}`,
    `  loan-period: ${period.period}`,
    `  loan-date: ${period.date}`
  ];
  if (def.txnType)
    lines.push(`  type: ${def.txnType}`);
  if (def.owner)
    lines.push(`  owner: ${def.owner}`);
  return lines.join("\n");
}
function deriveLoanPostings(ledgerContent, config, loanId, upToPeriod) {
  const def = config.loanPlans.find((p) => p.id === loanId);
  if (!def)
    throw new Error(`\u8D37\u6B3E\u8BA1\u5212\u4E0D\u5B58\u5728\uFF1A${loanId}`);
  const parsed = parseFinBeancount(ledgerContent);
  let maxPosted = 0;
  for (const t2 of parsed.transactions) {
    if (t2.fields?.["loan"] === loanId) {
      const p = Number(t2.fields?.["loan-period"]);
      if (!Number.isNaN(p) && p > maxPosted)
        maxPosted = p;
    }
  }
  const ppy = def.frequency === "quarterly" ? 4 : 12;
  const total = def.termYears * ppy;
  const upTo = upToPeriod ?? total;
  if (maxPosted >= upTo)
    return [];
  const schedule = computeLoanSchedule(def, { startPeriod: maxPosted + 1 });
  return schedule.filter((period) => period.period <= upTo).map((period) => loanEntryText(period, def, config));
}

// src/codeBlockDefs.ts
var FINANCE_CODE_BLOCK_DEFS = [
  // ── 存储层：复式记账分录（multiLeg 动态 N 腿录入） ─────────
  // 不再用固定 2 腿 template（from -amount / to +amount），改为：
  //   - 结构化参数只保留 date / narration / txnType / owner（标签维度）
  //   - 复式分录本身由 type:'legs' 参数驱动的动态编辑器录入（N 腿 + 一键补平）
  //   - 借贷符号由账户类别推导（界面只填正数金额 + 方向标签，不出现 +/-），见《报告》#2/#6
  // 生成文本由 buildCodeBlock 的 multiLeg 分支按 values['legs']（signed cents JSON）逐腿输出。
  {
    language: "fin-beancount",
    icon: "file-text",
    titleKey: "block.fin-beancount",
    descKey: "block.fin-beancount.desc",
    multiLeg: true,
    params: [
      {
        key: "date",
        labelKey: "param.date",
        descKey: "param.date.desc",
        type: "date",
        optional: false,
        autoToday: true
      },
      {
        key: "txnType",
        labelKey: "param.txnType",
        descKey: "param.txnType.desc",
        type: "select",
        optionsFrom: "transactionTypes",
        // 兜底静态选项：配置未加载时仍可用（仅作示例词表；真实词表来自
        // finance-config.json 的 transactionTypes，且已不含「转账/投资收益」这类非分类项——
        // type 只是查询标签，不再承担「资产转换 vs 收支」的语义区分，见《报告》P0 #2）。
        options: ["\u9910\u996E", "\u4EA4\u901A", "\u8D2D\u7269", "\u5C45\u4F4F", "\u5A31\u4E50", "\u533B\u7597", "\u6559\u80B2", "\u901A\u8BAF", "\u5176\u4ED6\u652F\u51FA", "\u5DE5\u8D44", "\u5956\u91D1", "\u526F\u4E1A", "\u5176\u4ED6\u6536\u5165"]
      },
      {
        key: "owner",
        labelKey: "param.owner",
        descKey: "param.owner.desc",
        type: "select",
        optionsFrom: "owners",
        options: ["\u81EA\u5DF1", "\u5BB6\u5EAD"],
        defaultValue: "\u81EA\u5DF1"
      },
      {
        key: "narration",
        labelKey: "param.narration",
        descKey: "param.narration.desc",
        type: "text",
        placeholder: "\u5982 \u5348\u9910\u3001\u5DE5\u8D44\u5165\u8D26\u7B49"
      },
      {
        key: "legs",
        labelKey: "param.legs",
        descKey: "param.legs.desc",
        type: "legs",
        optional: false
      }
    ]
  },
  // ── 视图层：流水（键值模式） ─────────────────────────────
  {
    language: "finance-log",
    icon: "list",
    titleKey: "block.finance-log",
    descKey: "block.finance-log.desc",
    // 参数顺序即弹窗表单顺序：先定「从哪天起、往前几天」，再叠加属性筛选，最后是 ID 精确查询。
    // 全部选填——留空即用默认（起始日=今天、天数=30、其余不筛）。
    params: [
      {
        key: "date",
        labelKey: "param.logDate",
        descKey: "param.logDate.desc",
        type: "date"
        // 刻意不 autoToday：留空才是「每天滚动看最近 N 天」，写死日期会让视图停在插入当天
      },
      {
        key: "day",
        labelKey: "param.day",
        descKey: "param.day.desc",
        type: "number",
        placeholder: "30"
      },
      {
        key: "amount",
        labelKey: "param.logAmount",
        descKey: "param.logAmount.desc",
        type: "amount",
        placeholder: "100"
      },
      {
        key: "account",
        labelKey: "param.logAccount",
        descKey: "param.logAccount.desc",
        type: "select",
        optionsFrom: "accounts"
      },
      {
        key: "type",
        labelKey: "param.type",
        descKey: "param.type.desc",
        type: "select",
        optionsFrom: "transactionTypes"
      },
      {
        key: "owner",
        labelKey: "param.logOwner",
        descKey: "param.logOwner.desc",
        type: "select",
        optionsFrom: "owners"
      },
      {
        key: "id",
        labelKey: "param.id",
        descKey: "param.id.desc",
        type: "text",
        placeholder: "^t-20260729120000"
      }
    ]
  },
  // ── 视图层：财务自由计算器（键值模式） ───────────────────
  // 原 finance-fi 已并入本块：src: actual 即等价于旧的「财务自由进度」视图。
  // 参数全部选填——留空就走块内默认（数据源自动选、其余用配置或内置默认值）。
  // 键名已取短（与渲染块 parseParams 保持一致）：src/rate/principal/spend/save/infl/years/vol/mode。
  {
    language: "finance-ficalc",
    icon: "calculator",
    titleKey: "block.finance-ficalc",
    descKey: "block.finance-ficalc.desc",
    params: [
      {
        key: "rate",
        labelKey: "param.rate",
        descKey: "param.rate.desc",
        type: "number",
        placeholder: "4"
      },
      {
        key: "startAge",
        labelKey: "param.startAge",
        descKey: "param.startAge.desc",
        type: "number",
        placeholder: "",
        autoToday: false
      },
      {
        key: "age",
        labelKey: "param.age",
        descKey: "param.age.desc",
        type: "number",
        placeholder: "30"
      },
      {
        key: "retireAge",
        labelKey: "param.retireAge",
        descKey: "param.retireAge.desc",
        type: "number",
        placeholder: "60"
      },
      {
        key: "principal",
        labelKey: "param.principal",
        descKey: "param.principal.desc",
        type: "number",
        placeholder: "100"
      },
      {
        key: "spend",
        labelKey: "param.spend",
        descKey: "param.spend.desc",
        type: "number",
        placeholder: "4"
      },
      {
        key: "save",
        labelKey: "param.savings",
        descKey: "param.savings.desc",
        type: "number",
        placeholder: "10"
      },
      {
        key: "incomeGrowth",
        labelKey: "param.incomeGrowth",
        descKey: "param.incomeGrowth.desc",
        type: "number",
        placeholder: "3"
      },
      {
        key: "cashRate",
        labelKey: "param.cashRate",
        descKey: "param.cashRate.desc",
        type: "number",
        placeholder: "1.5"
      },
      {
        key: "bufferMonths",
        labelKey: "param.bufferMonths",
        descKey: "param.bufferMonths.desc",
        type: "number",
        placeholder: "6"
      },
      {
        key: "infl",
        labelKey: "param.inflation",
        descKey: "param.inflation.desc",
        type: "number",
        placeholder: "2"
      },
      {
        key: "years",
        labelKey: "param.years",
        descKey: "param.years.desc",
        type: "number",
        placeholder: "30"
      },
      {
        key: "vol",
        labelKey: "param.volatility",
        descKey: "param.volatility.desc",
        type: "number",
        placeholder: "12"
      },
      {
        key: "mode",
        labelKey: "param.strategy",
        descKey: "param.strategy.desc",
        type: "select",
        options: ["fixed", "percent", "rule95"],
        optionLabels: { fixed: "\u6052\u5B9A\u91D1\u989D", percent: "\u56FA\u5B9A\u6BD4\u4F8B", rule95: "95% \u6CD5\u5219" }
      }
    ]
  },
  // ── 视图层：预算 ─────────────────────────────────────────
  {
    language: "finance-budget",
    icon: "pie-chart",
    titleKey: "block.finance-budget",
    descKey: "block.finance-budget.desc",
    params: [
      {
        key: "type",
        labelKey: "param.budgetType",
        descKey: "param.budgetType.desc",
        type: "select",
        optionsFrom: "transactionTypes"
      }
    ]
  },
  // ── 视图层：热力图（收支双向，v3） ───────────────────────
  {
    language: "finance-heatmap",
    icon: "grid",
    titleKey: "block.finance-heatmap",
    descKey: "block.finance-heatmap.desc",
    params: [
      {
        key: "day",
        labelKey: "param.heatmapDays",
        descKey: "param.heatmapDays.desc",
        type: "number",
        placeholder: "182"
      },
      {
        key: "view",
        labelKey: "param.heatmapView",
        descKey: "param.heatmapView.desc",
        type: "select",
        options: ["calendar", "matrix"],
        optionLabels: { calendar: "\u603B\u89C8\u65E5\u5386", matrix: "\u5206\u7C7B\u77E9\u9635" },
        defaultValue: "calendar"
      },
      {
        key: "gran",
        labelKey: "param.heatmapGran",
        descKey: "param.heatmapGran.desc",
        type: "select",
        options: ["week", "month"],
        optionLabels: { week: "\u6309\u5468", month: "\u6309\u6708" },
        defaultValue: "week"
      },
      {
        key: "category",
        labelKey: "param.heatmapCategory",
        descKey: "param.heatmapCategory.desc",
        type: "select",
        optionsFrom: "transactionTypes"
      }
    ]
  },
  // ── 视图层：资产总览 ───────────────────────────────────────
  {
    language: "finance-assets",
    icon: "bar-chart-2",
    titleKey: "block.finance-assets",
    descKey: "block.finance-assets.desc",
    params: [
      {
        key: "owner",
        labelKey: "param.assetsOwner",
        descKey: "param.assetsOwner.desc",
        type: "select",
        optionsFrom: "owners"
      },
      {
        key: "group",
        labelKey: "param.assetsGroup",
        descKey: "param.assetsGroup.desc",
        type: "select",
        options: ["class", "prefix"],
        optionLabels: { class: "\u8D44\u4EA7/\u8D1F\u503A", prefix: "\u8D26\u6237\u524D\u7F00" },
        defaultValue: "class"
      }
    ]
  },
  // ── 视图层：日常花费 + 贷款（finance-recurring，V1 + V2） ──
  // 无必填参数：界面（待入账草稿 / 我的计划 / 我的贷款）全部由 config + 账本虚派生。
  {
    language: "finance-recurring",
    icon: "repeat",
    titleKey: "block.finance-recurring",
    descKey: "block.finance-recurring.desc",
    params: []
  }
  // 注：原 finance-fi 的能力已并入 finance-ficalc，但本块现为 what-if 沙盒（参数一律手填），
  // 不再有「从账本取数」开关；故 finance-fi 从插入器与 registry 双双移除，存量 ```finance-fi 需改为 ```finance-ficalc。
];
function buildCodeBlock(def, values) {
  if (def.multiLeg) {
    const date = (values["date"] ?? "").trim();
    const narr = (values["narration"] ?? "").trim();
    const txnType = (values["txnType"] ?? "").trim();
    const owner = (values["owner"] ?? "").trim();
    const lines2 = [`${date} * ${narr}`.trim()];
    let legs = [];
    try {
      const parsed = JSON.parse(values["legs"] ?? "[]");
      if (Array.isArray(parsed))
        legs = parsed;
    } catch {
      legs = [];
    }
    for (const l of legs) {
      if (!l.account || !l.account.trim())
        continue;
      lines2.push(`  ${l.account.trim()}  ${l.amountCents}`);
    }
    if (txnType)
      lines2.push(`  type: ${txnType}`);
    if (owner)
      lines2.push(`  owner: ${owner}`);
    return "```" + def.language + "\n" + lines2.join("\n") + "\n```\n";
  }
  if (def.template) {
    let result = "```" + def.language + "\n" + def.template + "\n```\n";
    for (const [key, val] of Object.entries(values)) {
      if (val && val.trim() !== "") {
        result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), () => val.trim());
      }
    }
    result = result.replace(/\{\{[^}]+\}\}/g, "");
    return result;
  }
  const lines = [def.language];
  for (const p of def.params) {
    const v = values[p.key];
    if (v === void 0 || v === null)
      continue;
    const trimmed = v.trim();
    if (trimmed === "")
      continue;
    lines.push(`${p.key}: ${trimmed}`);
  }
  return "```" + lines.join("\n") + "\n```\n";
}

// src/cli/index.ts
function fail(msg) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
  process.exit(1);
}
function today() {
  const d = /* @__PURE__ */ new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--"))
      continue;
    const key = a.slice(2);
    const val = args[i + 1];
    if (val === void 0 || val.startsWith("--")) {
      out[key] = true;
      continue;
    }
    i++;
    if (out[key] !== void 0) {
      out[key] = [].concat(out[key], val);
    } else {
      out[key] = val;
    }
  }
  return out;
}
function str(f, key) {
  const v = f[key];
  return typeof v === "string" ? v : void 0;
}
function arr(f, key) {
  const v = f[key];
  return Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
}
var _cachedVaultBase;
function getVaultBasePath() {
  if (_cachedVaultBase !== void 0)
    return _cachedVaultBase;
  try {
    const r = (0, import_child_process.spawnSync)("obsidian", ["eval", "code=app.vault.adapter.basePath"], { encoding: "utf8" });
    if (!r.error && r.status === 0) {
      const cleaned = (r.stdout || "").trim().replace(/^=>\s*/, "");
      if (cleaned)
        _cachedVaultBase = cleaned;
    }
  } catch {
  }
  return _cachedVaultBase;
}
var _globalVaultOverride;
function resolveConfig(p, opts = {}) {
  if (path.isAbsolute(p))
    return p;
  const cwdResolved = path.resolve(process.cwd(), p);
  if (fs.existsSync(cwdResolved))
    return cwdResolved;
  const vault = _globalVaultOverride || getVaultBasePath();
  if (vault) {
    const vaultResolved = path.resolve(vault, p);
    if (fs.existsSync(vaultResolved))
      return vaultResolved;
    if (_globalVaultOverride || opts.mustExist)
      return vaultResolved;
  }
  return cwdResolved;
}
function loadConfig(p, strict = false) {
  const abs = resolveConfig(p);
  if (!fs.existsSync(abs)) {
    if (strict) {
      fail(`\u914D\u7F6E\u6587\u4EF6\u4E0D\u5B58\u5728\uFF1A${p}\uFF08\u89E3\u6790\u4E3A ${abs}\uFF09\u3002\u8BF7\u4F20\u5165\u7EDD\u5BF9\u8DEF\u5F84\uFF0C\u6216\u7528 --vault \u6307\u5B9A vault \u6839\u3002`);
    }
    process.stderr.write(`[warn] \u914D\u7F6E\u6587\u4EF6\u4E0D\u5B58\u5728\uFF0C\u56DE\u9000\u9ED8\u8BA4\u914D\u7F6E\uFF1A${p}\uFF08\u89E3\u6790\u4E3A ${abs}\uFF09
`);
    return structuredClone(DEFAULT_CONFIG);
  }
  const user = JSON.parse(fs.readFileSync(abs, "utf8"));
  return mergeConfig(DEFAULT_CONFIG, user);
}
function saveConfig(p, config) {
  const abs = resolveConfig(p);
  const dir = path.dirname(abs);
  if (dir && dir !== "." && !fs.existsSync(dir))
    fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(config, null, 2), "utf8");
}
function writeLedgerFs(ledger, entryBody, ref) {
  const abs = resolveConfig(ledger);
  const existing = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
  const next = appendEntryToContent(existing, entryBody, ref, ledger);
  const dir = path.dirname(abs);
  if (dir && dir !== "." && !fs.existsSync(dir))
    fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(abs, next, "utf8");
}
function writeLedgerAbs(ledger, content) {
  const abs = resolveConfig(ledger);
  const dir = path.dirname(abs);
  if (dir && dir !== "." && !fs.existsSync(dir))
    fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}
function safeRead(ledger) {
  const abs = resolveConfig(ledger);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
}
function countLoanLines(content, loanId) {
  return content.split(/\r?\n/).filter((l) => l.trim() === `loan: ${loanId}`).length;
}
function writeLedgerFsEdit(ledger, ref, newBody) {
  writeLedgerAbs(ledger, replaceEntryByRef(safeRead(ledger), ref, newBody));
}
function writeLedgerFsDelete(ledger, ref) {
  writeLedgerAbs(ledger, tombstoneEntryByRef(safeRead(ledger), ref));
}
function callObsidianApi(method, args) {
  const argStr = args.map((a) => JSON.stringify(a)).join(",");
  const code = `(async()=>{const api=window.financeBlock;if(!api||typeof api.${method}!=='function')throw new Error('method missing');const r=await api.${method}(${argStr});return JSON.stringify({r:r===undefined?null:r});})()`;
  const r = (0, import_child_process.spawnSync)("obsidian", ["eval", "code=" + code], { encoding: "utf8" });
  if (r.error || r.status !== 0)
    return { ok: false };
  try {
    return { ok: true, result: JSON.parse((r.stdout || "").trim()).r };
  } catch {
    return { ok: true };
  }
}
function obsidianWriteOk(method, args, ledger) {
  const before = safeRead(ledger);
  const r = callObsidianApi(method, args);
  if (!r.ok)
    return false;
  return safeRead(ledger) !== before;
}
function writeLedgerObsidian(ledger, entryBody, date) {
  const code = '(async()=>{const api=window.financeBlock;if(!api||!api.appendToLedger)throw new Error("finance-block plugin api not exposed");const ref=await api.appendToLedger(' + JSON.stringify(entryBody) + "," + JSON.stringify(date) + ");return JSON.stringify({ref:ref});})()";
  const r = (0, import_child_process.spawnSync)("obsidian", ["eval", "code=" + code], { encoding: "utf8" });
  if (r.error || r.status !== 0) {
    return { ok: false };
  }
  try {
    const parsed = JSON.parse((r.stdout || "").trim());
    return { ok: true, ref: parsed.ref };
  } catch {
    return { ok: true };
  }
}
function ledgerContains(ledger, marker) {
  const abs = resolveConfig(ledger);
  if (!fs.existsSync(abs))
    return false;
  try {
    return fs.readFileSync(abs, "utf8").includes(marker);
  } catch {
    return false;
  }
}
function gatherTxnSpec(f) {
  let ledger = str(f, "ledger");
  let date = str(f, "date") ?? today();
  let narration = str(f, "narration");
  let type = str(f, "type");
  let owner = str(f, "owner");
  let configPath = str(f, "config");
  let legs = [];
  const fields = {};
  const rawFields = arr(f, "field");
  for (const raw of rawFields) {
    const idx = raw.indexOf("=");
    if (idx <= 0)
      fail(`--field \u683C\u5F0F\u5E94\u4E3A key=value\uFF1A\u6536\u5230 ${raw}`);
    fields[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
  }
  const jsonSpec = str(f, "json");
  if (jsonSpec) {
    const spec = JSON.parse(jsonSpec);
    ledger = spec.ledger ?? ledger;
    date = spec.date ?? date;
    narration = spec.narration ?? narration;
    type = spec.type ?? type;
    owner = spec.owner ?? owner;
    configPath = spec.config ?? configPath;
    legs = spec.legs ?? legs;
    const specFields = spec.fields;
    if (specFields) {
      for (const [k, v] of Object.entries(specFields))
        fields[k] = String(v);
    }
  } else {
    legs = arr(f, "leg").map((s) => {
      const parts = s.split("|").map((x) => x.trim());
      if (parts.length < 3)
        fail(`leg \u683C\u5F0F\u5E94\u4E3A "\u8D26\u6237|in|\u5143"\uFF1A\u6536\u5230 ${s}`);
      const [account, dir, yuan] = parts;
      if (dir !== "in" && dir !== "out")
        fail(`leg \u65B9\u5411\u5FC5\u987B\u662F in/out\uFF1A\u6536\u5230 ${dir}`);
      if (!/^\d+(\.\d+)?$/.test(yuan))
        fail(`leg \u91D1\u989D\u975E\u6CD5\uFF1A\u6536\u5230 ${yuan}`);
      return { account, dir, yuan: Number(yuan) };
    });
  }
  if (legs.length < 2)
    fail("\u590D\u5F0F\u8BB0\u8D26\u81F3\u5C11\u9700\u8981 2 \u6761\u5206\u5F55\uFF08--leg\uFF09");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    fail("date \u683C\u5F0F\u5E94\u4E3A YYYY-MM-DD");
  return { ledger, date, narration, type, owner, configPath, legs, fields };
}
async function cmdLedgerAppend(f) {
  const spec = gatherTxnSpec(f);
  const ledger = spec.ledger;
  if (!ledger)
    fail("\u7F3A\u5C11 --ledger\uFF08\u6216 --json \u4E2D ledger\uFF09");
  const config = spec.configPath ? loadConfig(spec.configPath) : void 0;
  const txn = buildTxn(
    { date: spec.date, narration: spec.narration, type: spec.type, owner: spec.owner, legs: spec.legs, fields: spec.fields },
    config
  );
  const diff = zeroSumDiff(txn);
  if (diff !== 0)
    fail(`\u96F6\u548C\u4E0D\u5E73\u8861\uFF08\u5DEE\u989D ${diff} \u5206\uFF09\uFF0C\u672A\u5199\u5165\u3002\u8BF7\u68C0\u67E5 in/out \u4E0E\u91D1\u989D`);
  try {
    const parsed = parseFinBeancount(serializeTxnForCopy(txn));
    if (parsed.errors.length > 0) {
      process.stderr.write(`[warn] parser: ${parsed.errors[0].message}
`);
    }
  } catch (e) {
    process.stderr.write(`[warn] parser validation skipped: ${e instanceof Error ? e.message : String(e)}
`);
  }
  const entryBody = serializeTxnForCopy(txn);
  const via = str(f, "via") ?? "auto";
  let method = "fs";
  let ref = generateBlockRefId(spec.date);
  if (via === "fs") {
    writeLedgerFs(ledger, entryBody, ref);
  } else {
    const r = writeLedgerObsidian(ledger, entryBody, spec.date);
    if (r.ok) {
      if (ledgerContains(ledger, entryBody)) {
        method = "obsidian";
        ref = r.ref ?? ref;
      } else if (via === "obsidian") {
        fail("obsidian-cli \u672A\u786E\u8BA4\u5199\u5165\uFF08Obsidian \u672A\u8FD0\u884C\u6216 finance-block \u63D2\u4EF6\u672A\u52A0\u8F7D\uFF09");
      } else {
        writeLedgerFs(ledger, entryBody, ref);
        method = "fs";
      }
    } else if (via === "obsidian") {
      fail("obsidian-cli \u843D\u76D8\u5931\u8D25\uFF08Obsidian \u672A\u8FD0\u884C\u6216 finance-block \u63D2\u4EF6\u672A\u52A0\u8F7D\uFF09");
    } else {
      writeLedgerFs(ledger, entryBody, ref);
      method = "fs";
    }
  }
  return { ok: true, path: ledger, method, entry: `${entryBody}
${ref}` };
}
function cmdLedgerList(f) {
  const ledger = str(f, "ledger");
  if (!ledger)
    fail("\u7F3A\u5C11 --ledger");
  const abs = resolveConfig(ledger);
  if (!fs.existsSync(abs))
    fail(`\u8D26\u672C\u4E0D\u5B58\u5728\uFF1A${ledger}`);
  const content = fs.readFileSync(abs, "utf8");
  const blockMatch = /```fin-beancount\r?\n([\s\S]*?)```/.exec(content);
  if (!blockMatch)
    return { ok: true, path: ledger, count: 0, transactions: [] };
  const parsed = parseFinBeancount(blockMatch[1]);
  const transactions = parsed.transactions.map((t2) => ({
    date: t2.date,
    narration: t2.narration,
    type: t2.txnType,
    owner: t2.owner,
    legs: t2.legs.map((l) => ({ account: l.account, amount: l.amount }))
  }));
  return { ok: true, path: ledger, count: transactions.length, transactions };
}
async function cmdLedgerEdit(f) {
  const spec = gatherTxnSpec(f);
  const ledger = spec.ledger;
  const ref = str(f, "ref");
  if (!ledger)
    fail("\u7F3A\u5C11 --ledger");
  if (!ref)
    fail("\u7F3A\u5C11 --ref\uFF08\u8981\u7F16\u8F91\u7684\u5206\u5F55\u5757\u5F15\u7528\uFF0C\u5982 ^t-20260807120000\uFF09");
  if (Object.keys(spec.fields ?? {}).length > 0)
    fail("ledger edit \u6682\u4E0D\u652F\u6301 --field \u4FEE\u6539\u5B57\u6BB5");
  const config = spec.configPath ? loadConfig(spec.configPath) : void 0;
  const txn = buildTxn(
    { date: spec.date, narration: spec.narration, type: spec.type, owner: spec.owner, legs: spec.legs },
    config
  );
  if (zeroSumDiff(txn) !== 0)
    fail("\u96F6\u548C\u4E0D\u5E73\u8861\uFF0C\u672A\u5199\u5165");
  const newBody = serializeTxnForCopy({ ...txn, id: ref });
  const via = str(f, "via") ?? "auto";
  let method = "fs";
  if (via === "fs") {
    writeLedgerFsEdit(ledger, ref, newBody);
  } else {
    if (obsidianWriteOk("editLedgerEntry", [ledger, ref, newBody], ledger)) {
      method = "obsidian";
    } else if (via === "obsidian") {
      fail("obsidian-cli \u7F16\u8F91\u5931\u8D25");
    } else {
      writeLedgerFsEdit(ledger, ref, newBody);
      method = "fs";
    }
  }
  return { ok: true, path: ledger, method, ref };
}
async function cmdLedgerDelete(f) {
  const ledger = str(f, "ledger");
  const ref = str(f, "ref");
  if (!ledger)
    fail("\u7F3A\u5C11 --ledger");
  if (!ref)
    fail("\u7F3A\u5C11 --ref\uFF08\u8981\u5220\u9664\u7684\u5206\u5F55\u5757\u5F15\u7528\uFF0C\u5982 ^t-20260807120000\uFF09");
  const via = str(f, "via") ?? "auto";
  let method = "fs";
  if (via === "fs") {
    writeLedgerFsDelete(ledger, ref);
  } else {
    if (obsidianWriteOk("deleteLedgerEntry", [ledger, ref], ledger)) {
      method = "obsidian";
    } else if (via === "obsidian") {
      fail("obsidian-cli \u5220\u9664\u5931\u8D25");
    } else {
      writeLedgerFsDelete(ledger, ref);
      method = "fs";
    }
  }
  return { ok: true, path: ledger, method, ref, tombstoned: true };
}
async function cmdLedgerValuation(f) {
  const ledger = str(f, "ledger");
  const date = str(f, "date") ?? today();
  const account = str(f, "account");
  const amount = str(f, "amount");
  const currency = str(f, "currency");
  if (!ledger)
    fail("\u7F3A\u5C11 --ledger");
  if (!account)
    fail("\u7F3A\u5C11 --account");
  if (!amount || !/^-?\d+$/.test(amount))
    fail("--amount \u5E94\u4E3A\u6574\u6570\u5206\uFF08\u5982 5300000 = 53 \u4E07\uFF09");
  const cents = Number(amount);
  const body = buildValuationText(date, account, cents, currency);
  const vRef = "^v-" + generateBlockRefId(date).slice(3);
  const via = str(f, "via") ?? "auto";
  let method = "fs";
  if (via === "fs") {
    writeLedgerFs(ledger, body, vRef);
  } else {
    if (obsidianWriteOk("appendValuation", [ledger, date, account, cents, currency ?? null], ledger)) {
      method = "obsidian";
    } else if (via === "obsidian") {
      fail("obsidian-cli \u4F30\u503C\u5931\u8D25");
    } else {
      writeLedgerFs(ledger, body, vRef);
      method = "fs";
    }
  }
  return { ok: true, path: ledger, method, entry: `${body}
${vRef}` };
}
async function cmdLedgerLoanPost(f) {
  const ledger = str(f, "ledger");
  const configPath = str(f, "config");
  const id = str(f, "id");
  const upTo = str(f, "period");
  if (!ledger)
    fail("\u7F3A\u5C11 --ledger");
  if (!configPath)
    fail("\u7F3A\u5C11 --config");
  if (!id)
    fail("\u7F3A\u5C11 --id\uFF08\u8D37\u6B3E\u8BA1\u5212 id\uFF09");
  const config = loadConfig(configPath);
  const before = countLoanLines(safeRead(ledger), id);
  const post = () => {
    const postings = deriveLoanPostings(safeRead(ledger), config, id, upTo ? Number(upTo) : void 0);
    let cur = safeRead(ledger);
    for (const b of postings)
      cur = appendEntryToContent(cur, b, generateBlockRefId(), ledger);
    writeLedgerAbs(ledger, cur);
    return postings.length;
  };
  const via = str(f, "via") ?? "auto";
  let method = "fs";
  let posted = 0;
  if (via === "fs") {
    posted = post();
  } else {
    if (obsidianWriteOk("postLoanPeriods", [ledger, id, upTo ? Number(upTo) : null], ledger)) {
      method = "obsidian";
      posted = countLoanLines(safeRead(ledger), id) - before;
    } else if (via === "obsidian") {
      fail("obsidian-cli \u8D37\u6B3E\u5165\u8D26\u5931\u8D25");
    } else {
      posted = post();
      method = "fs";
    }
  }
  return { ok: true, path: ledger, method, loanId: id, posted };
}
function cmdBlockGenerate(f) {
  const block = str(f, "block");
  if (!block)
    fail("\u7F3A\u5C11 --block\uFF08\u5982 finance-log / finance-assets / finance-budget / finance-heatmap / finance-ficalc / finance-recurring / fin-beancount\uFF09");
  const def = FINANCE_CODE_BLOCK_DEFS.find((d) => d.language === block);
  if (!def)
    fail(`\u672A\u77E5\u4EE3\u7801\u5757\u8BED\u8A00\uFF1A${block}`);
  const values = {};
  const json = str(f, "json");
  if (json)
    Object.assign(values, JSON.parse(json));
  for (const p of arr(f, "param")) {
    const eq = p.indexOf("=");
    if (eq < 0)
      fail(`--param \u5E94\u4E3A key=val\uFF1A\u6536\u5230 ${p}`);
    values[p.slice(0, eq)] = p.slice(eq + 1);
  }
  const text = buildCodeBlock(def, values);
  const note = str(f, "note");
  if (note) {
    const abs = resolveConfig(note);
    const existing = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
    const sep = existing && !existing.endsWith("\n") ? "\n" : "";
    writeLedgerAbs(note, existing + sep + text);
    return { ok: true, note, block, text };
  }
  return { ok: true, block, text };
}
var CONFIG_OPS = {
  "add-account": (c, f) => addAccount(c, JSON.parse(need(f, "json"))),
  "update-account": (c, f) => updateAccount(c, need(f, "name"), JSON.parse(need(f, "json"))),
  "remove-account": (c, f) => removeAccount(c, need(f, "name")),
  "add-owner": (c, f) => addOwner(c, need(f, "name")),
  "remove-owner": (c, f) => removeOwner(c, need(f, "name")),
  "set-default-owner": (c, f) => setDefaultOwner(c, need(f, "name")),
  "add-type": (c, f) => addTransactionType(c, JSON.parse(need(f, "json"))),
  "update-type": (c, f) => updateTransactionType(c, need(f, "name"), JSON.parse(need(f, "json"))),
  "remove-type": (c, f) => removeTransactionType(c, need(f, "name")),
  "add-currency": (c, f) => addCurrency(c, JSON.parse(need(f, "json"))),
  "update-currency": (c, f) => updateCurrency(c, need(f, "code"), JSON.parse(need(f, "json"))),
  "remove-currency": (c, f) => removeCurrency(c, need(f, "code")),
  "set-base": (c, f) => setBaseCurrency(c, need(f, "code")),
  "add-budget": (c, f) => addBudget(c, JSON.parse(need(f, "json"))),
  "update-budget": (c, f) => updateBudget(c, need(f, "name"), JSON.parse(need(f, "json"))),
  "remove-budget": (c, f) => removeBudget(c, need(f, "name")),
  "add-recurring": (c, f) => addRecurringPlan(c, JSON.parse(need(f, "json"))),
  "update-recurring": (c, f) => updateRecurringPlan(c, need(f, "id"), JSON.parse(need(f, "json"))),
  "remove-recurring": (c, f) => removeRecurringPlan(c, need(f, "id")),
  "skip-recurring": (c, f) => skipRecurring(c, need(f, "id"), need(f, "date")),
  "add-loan": (c, f) => addLoanPlan(c, JSON.parse(need(f, "json"))),
  "update-loan": (c, f) => updateLoanPlan(c, need(f, "id"), JSON.parse(need(f, "json"))),
  "remove-loan": (c, f) => removeLoanPlan(c, need(f, "id")),
  "add-lifeevent": (c, f) => addLifeEvent(c, JSON.parse(need(f, "json"))),
  "update-lifeevent": (c, f) => updateLifeEvent(c, need(f, "id"), JSON.parse(need(f, "json"))),
  "remove-lifeevent": (c, f) => removeLifeEvent(c, need(f, "id")),
  "set-birthday": (c, f) => setBirthday(c, need(f, "date"))
};
function need(f, key) {
  const v = str(f, key);
  if (!v)
    fail(`\u7F3A\u5C11 --${key}`);
  return v;
}
function cmdConfig(action, f) {
  const configPath = str(f, "config");
  if (!configPath)
    fail("\u7F3A\u5C11 --config");
  const abs = resolveConfig(configPath);
  if (action === "get") {
    const abs2 = resolveConfig(configPath, { mustExist: true });
    return { ok: true, path: configPath, resolvedPath: abs2, config: loadConfig(abs2, true) };
  }
  const op = CONFIG_OPS[action];
  if (!op)
    fail(`\u672A\u77E5 config \u5B50\u547D\u4EE4\uFF1A${action}`);
  const config = loadConfig(configPath);
  const next = op(config, f);
  saveConfig(configPath, next);
  return { ok: true, path: configPath, action, config: next };
}
async function main() {
  const argv = process.argv.slice(2);
  const [group, action, ...rest] = argv;
  const f = parseFlags(rest);
  const vaultFlag = str(f, "vault");
  if (vaultFlag)
    _globalVaultOverride = vaultFlag;
  if (group === "ledger" && action === "append") {
    const r = await cmdLedgerAppend(f);
    process.stdout.write(JSON.stringify(r) + "\n");
    return;
  }
  if (group === "ledger" && action === "list") {
    const r = cmdLedgerList(f);
    process.stdout.write(JSON.stringify(r) + "\n");
    return;
  }
  if (group === "ledger" && action === "edit") {
    const r = await cmdLedgerEdit(f);
    process.stdout.write(JSON.stringify(r) + "\n");
    return;
  }
  if (group === "ledger" && action === "delete") {
    const r = await cmdLedgerDelete(f);
    process.stdout.write(JSON.stringify(r) + "\n");
    return;
  }
  if (group === "ledger" && action === "valuation") {
    const r = await cmdLedgerValuation(f);
    process.stdout.write(JSON.stringify(r) + "\n");
    return;
  }
  if (group === "ledger" && action === "loan-post") {
    const r = await cmdLedgerLoanPost(f);
    process.stdout.write(JSON.stringify(r) + "\n");
    return;
  }
  if (group === "block" && action === "generate") {
    const r = cmdBlockGenerate(f);
    process.stdout.write(JSON.stringify(r) + "\n");
    return;
  }
  if (group === "config" && action) {
    const r = cmdConfig(action, f);
    process.stdout.write(JSON.stringify(r) + "\n");
    return;
  }
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: `\u7528\u6CD5: finance-block-cli.js <ledger|block|config> <action> [flags]
  ledger append  --ledger <path> [--config <cfg>] [--date YYYY-MM-DD] [--narration \u6458\u8981]
                  [--type \u5206\u7C7B] [--owner \u5F52\u5C5E] [--via auto|obsidian|fs]
                  --leg "\u8D26\u6237|in|\u5143" (\u53EF\u91CD\u590D) | --json '{...}'
  ledger list    --ledger <path>
  ledger edit    --ledger <path> --ref ^t-XXX [\u540C append \u7684\u53C2\u6570]
  ledger delete  --ledger <path> --ref ^t-XXX
  ledger valuation --ledger <path> --date <d> --account <\u8D26\u6237> --amount <\u6574\u6570\u5206> [--currency USD] [--config <cfg>]
  ledger loan-post --ledger <path> --config <cfg> --id <\u8D37\u6B3Eid> [--period N]
  block generate --block <finance-log|finance-assets|finance-budget|finance-heatmap|finance-ficalc|finance-recurring|fin-beancount>
                  [--param key=val ...] [--json '{...}'] [--note <\u7B14\u8BB0\u8DEF\u5F84 \u53EF\u9009\uFF0C\u5199\u5165\u8BE5\u6587\u4EF6>]
  config <add-account|update-account|remove-account|add-owner|remove-owner|set-default-owner|
         add-type|update-type|remove-type|add-currency|update-currency|remove-currency|set-base|
         add-budget|update-budget|remove-budget|add-recurring|update-recurring|remove-recurring|skip-recurring|
         add-loan|update-loan|remove-loan|add-lifeevent|update-lifeevent|remove-lifeevent|set-birthday|get>
         --config <cfg> [--json '{...}' | --name X | --code X | --id X | --date X]\u8DEF\u5F84\u8BF4\u660E\uFF1A  \xB7 \u5EFA\u8BAE\u4F20\u5165\u7EDD\u5BF9\u8DEF\u5F84\uFF08\u6700\u7A33\uFF09\u3002\u76F8\u5BF9\u8DEF\u5F84\u4F1A\u4F9D\u6B21\u5C1D\u8BD5\uFF1A\u5F53\u524D\u76EE\u5F55 \u2192 Obsidian vault \u6839    \uFF08\u81EA\u52A8\u63A2\u6D4B\uFF0C\u6216\u663E\u5F0F --vault <vault\u6839>\uFF09\u3002config get \u5BF9\u4E0D\u5B58\u5728\u6587\u4EF6\u76F4\u63A5\u62A5\u9519\uFF0C    \u4E0D\u518D\u9759\u9ED8\u56DE\u9000\u9ED8\u8BA4\u914D\u7F6E\u3002`
    }) + "\n"
  );
  process.exit(1);
}
main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
