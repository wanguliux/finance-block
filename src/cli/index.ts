/**
 * finance-block CLI —— 从插件共享源码打包的单文件内核
 *
 * 设计（见 vault skill「AI 适配实现方法论」）：
 *   - 本 CLI 不是手写平行实现，而是 esbuild 把插件的**纯核心**打包成单文件。
 *   - 所有领域逻辑（分录构建 / 序列化 / 零和校验 / 块插入 / 配置 CRUD）
 *     全部 import 自 src/shared 与 src/parser，插件改动经构建自动继承，零漂移。
 *   - 文件 IO 由本文件负责（fs 直写，或经 obsidian-cli 调插件实例内真实函数）。
 *
 * 用法：
 *   node finance-block-cli.js ledger append --ledger "账本/账本.md" \
 *        --config finance-config.json --date 2026-08-07 --narration 午餐 \
 *        --type 餐饮 --owner 自己 --leg "微信|out|35" --leg "费用:餐饮|in|35"
 *   node finance-block-cli.js config add-account --config finance-config.json \
 *        --json '{"name":"银行卡","class":"asset","icon":"💳","owner":"自己"}'
 *   node finance-block-cli.js config get --config finance-config.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import type { FinanceConfig } from '../types';
import { DEFAULT_CONFIG } from '../config/defaults';
import {
  mergeConfig,
  addAccount,
  updateAccount,
  removeAccount,
  addOwner,
  removeOwner,
  setDefaultOwner,
  addTransactionType,
  updateTransactionType,
  removeTransactionType,
  addCurrency,
  updateCurrency,
  removeCurrency,
  setBaseCurrency,
  addBudget,
  updateBudget,
  removeBudget,
  addRecurringPlan,
  updateRecurringPlan,
  removeRecurringPlan,
  skipRecurring,
  addLoanPlan,
  updateLoanPlan,
  removeLoanPlan,
  addLifeEvent,
  updateLifeEvent,
  removeLifeEvent,
  setBirthday,
} from '../shared/configOps';
import {
  buildTxn,
  zeroSumDiff,
  serializeTxnForCopy,
  generateBlockRefId,
  buildValuationText,
  type BuildLegSpec,
} from '../shared/entry';
import {
  appendEntryToContent,
  replaceEntryByRef,
  tombstoneEntryByRef,
} from '../shared/ledgerWrite';
import { deriveLoanPostings } from '../engine/loan';
import { FINANCE_CODE_BLOCK_DEFS, buildCodeBlock } from '../codeBlockDefs';
import { parseFinBeancount } from '../parser/finBeancount';

// ─── 通用工具 ────────────────────────────────────────────────────

function fail(msg: string): never {
  process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
  process.exit(1);
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 解析 `--key value` 形式的参数；可重复键存为数组。 */
function parseFlags(args: string[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const val = args[i + 1];
    if (val === undefined || val.startsWith('--')) {
      out[key] = true as unknown as string; // 布尔旗标
      continue;
    }
    i++;
    if (out[key] !== undefined) {
      out[key] = ([] as string[]).concat(out[key] as string | string[], val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

function str(f: Record<string, string | string[]>, key: string): string | undefined {
  const v = f[key];
  return typeof v === 'string' ? v : undefined;
}
function arr(f: Record<string, string | string[]>, key: string): string[] {
  const v = f[key];
  return Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
}

// ─── 配置读写（复用插件 merge 语义） ─────────────────────────────

/** 探测 Obsidian vault 根目录（带缓存）。经 obsidian-cli 读 app.vault.adapter.basePath，输出带 `=> ` 前缀须剥除。 */
let _cachedVaultBase: string | undefined;
function getVaultBasePath(): string | undefined {
  if (_cachedVaultBase !== undefined) return _cachedVaultBase;
  try {
    const r = spawnSync('obsidian', ['eval', 'code=app.vault.adapter.basePath'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) {
      const cleaned = (r.stdout || '').trim().replace(/^=>\s*/, '');
      if (cleaned) _cachedVaultBase = cleaned;
    }
  } catch {
    /* obsidian 不可用时退回 undefined */
  }
  return _cachedVaultBase;
}

/** 全局 --vault 覆盖（显式指定 vault 根，新建文件也落此处）。 */
let _globalVaultOverride: string | undefined;

interface ResolveOpts {
  mustExist?: boolean;
}

/**
 * 解析配置/账本路径。
 * 优先级：绝对路径 → 相对 cwd 命中 → 相对 vault 根命中（自动探测 app.vault 或 --vault 显式）。
 * 旧版只用 process.cwd() 解析相对路径，从脚本目录运行时落错位置，且文件不存在时静默回退种子默认
 * （伪装成「插件内存配置过期」）。现 vault 相对路径可自动命中，读不存在文件严格报错。
 */
function resolveConfig(p: string, opts: ResolveOpts = {}): string {
  if (path.isAbsolute(p)) return p;
  const cwdResolved = path.resolve(process.cwd(), p);
  if (fs.existsSync(cwdResolved)) return cwdResolved;
  const vault = _globalVaultOverride || getVaultBasePath();
  if (vault) {
    const vaultResolved = path.resolve(vault, p);
    if (fs.existsSync(vaultResolved)) return vaultResolved;
    if (_globalVaultOverride || opts.mustExist) return vaultResolved;
  }
  return cwdResolved;
}

function loadConfig(p: string, strict = false): FinanceConfig {
  const abs = resolveConfig(p);
  if (!fs.existsSync(abs)) {
    if (strict) {
      fail(`配置文件不存在：${p}（解析为 ${abs}）。请传入绝对路径，或用 --vault 指定 vault 根。`);
    }
    process.stderr.write(`[warn] 配置文件不存在，回退默认配置：${p}（解析为 ${abs}）\n`);
    return structuredClone(DEFAULT_CONFIG);
  }
  const user = JSON.parse(fs.readFileSync(abs, 'utf8')) as Partial<FinanceConfig>;
  return mergeConfig(DEFAULT_CONFIG, user);
}

function saveConfig(p: string, config: FinanceConfig): void {
  const abs = resolveConfig(p);
  const dir = path.dirname(abs);
  if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(config, null, 2), 'utf8');
}

// ─── 账本落盘 ───────────────────────────────────────────────────

function writeLedgerFs(ledger: string, entryBody: string, ref: string): void {
  const abs = resolveConfig(ledger);
  const existing = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  const next = appendEntryToContent(existing, entryBody, ref, ledger);
  const dir = path.dirname(abs);
  if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(abs, next, 'utf8');
}

/** 直接写完整账本内容（mkdir 防丢失） */
function writeLedgerAbs(ledger: string, content: string): void {
  const abs = resolveConfig(ledger);
  const dir = path.dirname(abs);
  if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

function safeRead(ledger: string): string {
  const abs = resolveConfig(ledger);
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
}

/** 账本内某贷款已入账期数（按 `loan: <id>` 元数据行计数） */
function countLoanLines(content: string, loanId: string): number {
  return content.split(/\r?\n/).filter((l) => l.trim() === `loan: ${loanId}`).length;
}

function writeLedgerFsEdit(ledger: string, ref: string, newBody: string): void {
  writeLedgerAbs(ledger, replaceEntryByRef(safeRead(ledger), ref, newBody));
}

/** 软删除：把该条目整体注释（; 前缀），数据保留可恢复 */
function writeLedgerFsDelete(ledger: string, ref: string): void {
  writeLedgerAbs(ledger, tombstoneEntryByRef(safeRead(ledger), ref));
}

/** 经 obsidian-cli 调插件实例内真实方法（单一真相源 + 索引即时刷新）。返回 ok 与解析结果。 */
function callObsidianApi(method: string, args: unknown[]): { ok: boolean; result?: unknown } {
  const argStr = args.map((a) => JSON.stringify(a)).join(',');
  const code =
    '(async()=>{const api=window.financeBlock;' +
    `if(!api||typeof api.${method}!=='function')throw new Error('method missing');` +
    `const r=await api.${method}(${argStr});return JSON.stringify({r:r===undefined?null:r});})()`;
  const r = spawnSync('obsidian', ['eval', 'code=' + code], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return { ok: false };
  try {
    return { ok: true, result: JSON.parse((r.stdout || '').trim()).r };
  } catch {
    return { ok: true }; // obsidian-cli 可能吞返回值；交由调用方读账本验证
  }
}

/** 账本中是否恰好存在某行（用于软删后确认 ref 已变注释行） */
function containsExactLine(content: string, line: string): boolean {
  return content.split(/\r?\n/).some((l) => l.trim() === line.trim());
}

/**
 * 调 obsidian 实例内方法后，以「账本内容是否真的发生变化」判定是否写入成功。
 * 因 obsidian-cli 可能静默 no-op（返回 0 但未写），不能只信返回值；
 * 对 edit/delete/valuation/loan-post 这类「ref 不变」的操作，ref 也无法作为变化标记，
 * 故统一用前后内容比对，变了才算成功，否则降级 fs。
 */
function obsidianWriteOk(method: string, args: unknown[], ledger: string): boolean {
  const before = safeRead(ledger);
  const r = callObsidianApi(method, args);
  if (!r.ok) return false;
  return safeRead(ledger) !== before;
}

/** 经 obsidian-cli 调插件实例内真实 appendToLedger（触发 indexer 实时刷新）。 */
function writeLedgerObsidian(ledger: string, entryBody: string, date: string): { ok: boolean; ref?: string } {
  const code =
    '(async()=>{const api=window.financeBlock;' +
    'if(!api||!api.appendToLedger)throw new Error("finance-block plugin api not exposed");' +
    'const ref=await api.appendToLedger(' +
    JSON.stringify(entryBody) + ',' + JSON.stringify(date) +
    ');return JSON.stringify({ref:ref});})()';
  const r = spawnSync('obsidian', ['eval', 'code=' + code], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    return { ok: false };
  }
  try {
    const parsed = JSON.parse((r.stdout || '').trim());
    return { ok: true, ref: parsed.ref };
  } catch {
    // obsidian-cli 可能吞掉返回值（返回 0 但无有效 JSON）；交由调用方读取账本二次验证
    return { ok: true };
  }
}

/** 读取账本，确认刚写入的分录确实已落盘（防 obsidian-cli 静默 no-op 丢数据）。 */
function ledgerContains(ledger: string, marker: string): boolean {
  const abs = resolveConfig(ledger);
  if (!fs.existsSync(abs)) return false;
  try {
    return fs.readFileSync(abs, 'utf8').includes(marker);
  } catch {
    return false;
  }
}

// ─── ledger append ──────────────────────────────────────────────

interface TxnSpec {
  ledger?: string;
  date: string;
  narration?: string;
  type?: string;
  owner?: string;
  configPath?: string;
  legs: BuildLegSpec[];
  fields?: Record<string, string>;
}

/** 从 --json 或 --leg/--narration/... 收集一笔交易的结构化规格（append 与 edit 共用） */
function gatherTxnSpec(f: Record<string, string | string[]>): TxnSpec {
  let ledger = str(f, 'ledger');
  let date = str(f, 'date') ?? today();
  let narration = str(f, 'narration');
  let type = str(f, 'type');
  let owner = str(f, 'owner');
  let configPath = str(f, 'config');
  let legs: BuildLegSpec[] = [];

  const fields: Record<string, string> = {};
  const rawFields = arr(f, 'field');
  for (const raw of rawFields) {
    const idx = raw.indexOf('=');
    if (idx <= 0) fail(`--field 格式应为 key=value：收到 ${raw}`);
    fields[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
  }

  const jsonSpec = str(f, 'json');
  if (jsonSpec) {
    const spec = JSON.parse(jsonSpec) as Record<string, unknown>;
    ledger = (spec.ledger as string) ?? ledger;
    date = (spec.date as string) ?? date;
    narration = (spec.narration as string) ?? narration;
    type = (spec.type as string) ?? type;
    owner = (spec.owner as string) ?? owner;
    configPath = (spec.config as string) ?? configPath;
    legs = (spec.legs as BuildLegSpec[]) ?? legs;
    const specFields = spec.fields as Record<string, string> | undefined;
    if (specFields) {
      for (const [k, v] of Object.entries(specFields)) fields[k] = String(v);
    }
  } else {
    legs = arr(f, 'leg').map((s) => {
      const parts = s.split('|').map((x) => x.trim());
      if (parts.length < 3) fail(`leg 格式应为 "账户|in|元"：收到 ${s}`);
      const [account, dir, yuan] = parts;
      if (dir !== 'in' && dir !== 'out') fail(`leg 方向必须是 in/out：收到 ${dir}`);
      if (!/^\d+(\.\d+)?$/.test(yuan)) fail(`leg 金额非法：收到 ${yuan}`);
      return { account, dir: dir as 'in' | 'out', yuan: Number(yuan) };
    });
  }

  if (legs.length < 2) fail('复式记账至少需要 2 条分录（--leg）');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('date 格式应为 YYYY-MM-DD');
  return { ledger, date, narration, type, owner, configPath, legs, fields };
}

async function cmdLedgerAppend(f: Record<string, string | string[]>): Promise<unknown> {
  const spec = gatherTxnSpec(f);
  const ledger = spec.ledger;
  if (!ledger) fail('缺少 --ledger（或 --json 中 ledger）');

  const config = spec.configPath ? loadConfig(spec.configPath) : undefined;
  const txn = buildTxn(
    { date: spec.date, narration: spec.narration, type: spec.type, owner: spec.owner, legs: spec.legs, fields: spec.fields },
    config,
  );

  const diff = zeroSumDiff(txn);
  if (diff !== 0) fail(`零和不平衡（差额 ${diff} 分），未写入。请检查 in/out 与金额`);

  // 跨插件解析器交叉校验（插件真实 parser；失败仅警告，不阻断）
  try {
    const parsed = parseFinBeancount(serializeTxnForCopy(txn));
    if (parsed.errors.length > 0) {
      process.stderr.write(`[warn] parser: ${parsed.errors[0].message}\n`);
    }
  } catch (e) {
    process.stderr.write(`[warn] parser validation skipped: ${e instanceof Error ? e.message : String(e)}\n`);
  }

  // 序列化（不含 ^t- 行；块引用由落盘侧附加）
  const entryBody = serializeTxnForCopy(txn);

  const via = str(f, 'via') ?? 'auto';
  let method = 'fs';
  let ref = generateBlockRefId(spec.date);

  if (via === 'fs') {
    writeLedgerFs(ledger, entryBody, ref);
  } else {
    const r = writeLedgerObsidian(ledger, entryBody, spec.date);
    if (r.ok) {
      // obsidian-cli 可能静默 no-op（返回成功但未写）。二次验证账本是否真含此笔，
      // 未含则降级 fs，绝不丢数据。
      if (ledgerContains(ledger, entryBody)) {
        method = 'obsidian';
        ref = r.ref ?? ref;
      } else if (via === 'obsidian') {
        fail('obsidian-cli 未确认写入（Obsidian 未运行或 finance-block 插件未加载）');
      } else {
        writeLedgerFs(ledger, entryBody, ref);
        method = 'fs';
      }
    } else if (via === 'obsidian') {
      fail('obsidian-cli 落盘失败（Obsidian 未运行或 finance-block 插件未加载）');
    } else {
      writeLedgerFs(ledger, entryBody, ref);
      method = 'fs';
    }
  }

  return { ok: true, path: ledger, method, entry: `${entryBody}\n${ref}` };
}

// ─── ledger list ────────────────────────────────────────────────

function cmdLedgerList(f: Record<string, string | string[]>): unknown {
  const ledger = str(f, 'ledger');
  if (!ledger) fail('缺少 --ledger');
  const abs = resolveConfig(ledger);
  if (!fs.existsSync(abs)) fail(`账本不存在：${ledger}`);
  const content = fs.readFileSync(abs, 'utf8');
  const blockMatch = /```fin-beancount\r?\n([\s\S]*?)```/.exec(content);
  if (!blockMatch) return { ok: true, path: ledger, count: 0, transactions: [] };
  const parsed = parseFinBeancount(blockMatch[1]);
  const transactions = parsed.transactions.map((t) => ({
    date: t.date,
    narration: t.narration,
    type: t.txnType,
    owner: t.owner,
    legs: t.legs.map((l) => ({ account: l.account, amount: l.amount })),
  }));
  return { ok: true, path: ledger, count: transactions.length, transactions };
}

// ─── ledger edit（按块引用重建，ref 不变） ──────────────────────

async function cmdLedgerEdit(f: Record<string, string | string[]>): Promise<unknown> {
  const spec = gatherTxnSpec(f);
  const ledger = spec.ledger;
  const ref = str(f, 'ref');
  if (!ledger) fail('缺少 --ledger');
  if (!ref) fail('缺少 --ref（要编辑的分录块引用，如 ^t-20260807120000）');
  if (Object.keys(spec.fields ?? {}).length > 0) fail('ledger edit 暂不支持 --field 修改字段');

  const config = spec.configPath ? loadConfig(spec.configPath) : undefined;
  const txn = buildTxn(
    { date: spec.date, narration: spec.narration, type: spec.type, owner: spec.owner, legs: spec.legs },
    config,
  );
  if (zeroSumDiff(txn) !== 0) fail('零和不平衡，未写入');
  const newBody = serializeTxnForCopy({ ...txn, id: ref });

  const via = str(f, 'via') ?? 'auto';
  let method = 'fs';
  if (via === 'fs') {
    writeLedgerFsEdit(ledger, ref, newBody);
  } else {
    if (obsidianWriteOk('editLedgerEntry', [ledger, ref, newBody], ledger)) {
      method = 'obsidian';
    } else if (via === 'obsidian') {
      fail('obsidian-cli 编辑失败');
    } else {
      writeLedgerFsEdit(ledger, ref, newBody);
      method = 'fs';
    }
  }
  return { ok: true, path: ledger, method, ref };
}

// ─── ledger delete（软删除墓碑） ────────────────────────────────

async function cmdLedgerDelete(f: Record<string, string | string[]>): Promise<unknown> {
  const ledger = str(f, 'ledger');
  const ref = str(f, 'ref');
  if (!ledger) fail('缺少 --ledger');
  if (!ref) fail('缺少 --ref（要删除的分录块引用，如 ^t-20260807120000）');

  const via = str(f, 'via') ?? 'auto';
  let method = 'fs';
  if (via === 'fs') {
    writeLedgerFsDelete(ledger, ref);
  } else {
    if (obsidianWriteOk('deleteLedgerEntry', [ledger, ref], ledger)) {
      method = 'obsidian';
    } else if (via === 'obsidian') {
      fail('obsidian-cli 删除失败');
    } else {
      writeLedgerFsDelete(ledger, ref);
      method = 'fs';
    }
  }
  return { ok: true, path: ledger, method, ref, tombstoned: true };
}

// ─── ledger valuation（追加 fb-valuation 行） ───────────────────

async function cmdLedgerValuation(f: Record<string, string | string[]>): Promise<unknown> {
  const ledger = str(f, 'ledger');
  const date = str(f, 'date') ?? today();
  const account = str(f, 'account');
  const amount = str(f, 'amount');
  const currency = str(f, 'currency');
  if (!ledger) fail('缺少 --ledger');
  if (!account) fail('缺少 --account');
  if (!amount || !/^-?\d+$/.test(amount)) fail('--amount 应为整数分（如 5300000 = 53 万）');
  const cents = Number(amount);
  const body = buildValuationText(date, account, cents, currency);
  const vRef = '^v-' + generateBlockRefId(date).slice(3);

  const via = str(f, 'via') ?? 'auto';
  let method = 'fs';
  if (via === 'fs') {
    writeLedgerFs(ledger, body, vRef);
  } else {
    if (obsidianWriteOk('appendValuation', [ledger, date, account, cents, currency ?? null], ledger)) {
      method = 'obsidian';
    } else if (via === 'obsidian') {
      fail('obsidian-cli 估值失败');
    } else {
      writeLedgerFs(ledger, body, vRef);
      method = 'fs';
    }
  }
  return { ok: true, path: ledger, method, entry: `${body}\n${vRef}` };
}

// ─── ledger loan-post（续算并批量入账贷款待还期） ───────────────

async function cmdLedgerLoanPost(f: Record<string, string | string[]>): Promise<unknown> {
  const ledger = str(f, 'ledger');
  const configPath = str(f, 'config');
  const id = str(f, 'id');
  const upTo = str(f, 'period');
  if (!ledger) fail('缺少 --ledger');
  if (!configPath) fail('缺少 --config');
  if (!id) fail('缺少 --id（贷款计划 id）');
  const config = loadConfig(configPath);
  const before = countLoanLines(safeRead(ledger), id);

  const post = (): number => {
    const postings = deriveLoanPostings(safeRead(ledger), config, id, upTo ? Number(upTo) : undefined);
    let cur = safeRead(ledger);
    for (const b of postings) cur = appendEntryToContent(cur, b, generateBlockRefId(), ledger);
    writeLedgerAbs(ledger, cur);
    return postings.length;
  };

  const via = str(f, 'via') ?? 'auto';
  let method = 'fs';
  let posted = 0;
  if (via === 'fs') {
    posted = post();
  } else {
    if (obsidianWriteOk('postLoanPeriods', [ledger, id, upTo ? Number(upTo) : null], ledger)) {
      method = 'obsidian';
      posted = countLoanLines(safeRead(ledger), id) - before;
    } else if (via === 'obsidian') {
      fail('obsidian-cli 贷款入账失败');
    } else {
      posted = post();
      method = 'fs';
    }
  }
  return { ok: true, path: ledger, method, loanId: id, posted };
}

// ─── block generate（生成视图块围栏文本） ───────────────────────

function cmdBlockGenerate(f: Record<string, string | string[]>): unknown {
  const block = str(f, 'block');
  if (!block) fail('缺少 --block（如 finance-log / finance-assets / finance-budget / finance-heatmap / finance-ficalc / finance-recurring / fin-beancount）');
  const def = FINANCE_CODE_BLOCK_DEFS.find((d) => d.language === block);
  if (!def) fail(`未知代码块语言：${block}`);

  const values: Record<string, string> = {};
  const json = str(f, 'json');
  if (json) Object.assign(values, JSON.parse(json));
  for (const p of arr(f, 'param')) {
    const eq = p.indexOf('=');
    if (eq < 0) fail(`--param 应为 key=val：收到 ${p}`);
    values[p.slice(0, eq)] = p.slice(eq + 1);
  }

  const text = buildCodeBlock(def, values);
  const note = str(f, 'note');
  if (note) {
    const abs = resolveConfig(note);
    const existing = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    writeLedgerAbs(note, existing + sep + text);
    return { ok: true, note, block, text };
  }
  return { ok: true, block, text };
}

// ─── config 子命令 ──────────────────────────────────────────────

type ConfigOp = (cfg: FinanceConfig, f: Record<string, string | string[]>) => FinanceConfig;

const CONFIG_OPS: Record<string, ConfigOp> = {
  'add-account': (c, f) => addAccount(c, JSON.parse(need(f, 'json'))),
  'update-account': (c, f) => updateAccount(c, need(f, 'name'), JSON.parse(need(f, 'json'))),
  'remove-account': (c, f) => removeAccount(c, need(f, 'name')),
  'add-owner': (c, f) => addOwner(c, need(f, 'name')),
  'remove-owner': (c, f) => removeOwner(c, need(f, 'name')),
  'set-default-owner': (c, f) => setDefaultOwner(c, need(f, 'name')),
  'add-type': (c, f) => addTransactionType(c, JSON.parse(need(f, 'json'))),
  'update-type': (c, f) => updateTransactionType(c, need(f, 'name'), JSON.parse(need(f, 'json'))),
  'remove-type': (c, f) => removeTransactionType(c, need(f, 'name')),
  'add-currency': (c, f) => addCurrency(c, JSON.parse(need(f, 'json'))),
  'update-currency': (c, f) => updateCurrency(c, need(f, 'code'), JSON.parse(need(f, 'json'))),
  'remove-currency': (c, f) => removeCurrency(c, need(f, 'code')),
  'set-base': (c, f) => setBaseCurrency(c, need(f, 'code')),
  'add-budget': (c, f) => addBudget(c, JSON.parse(need(f, 'json'))),
  'update-budget': (c, f) => updateBudget(c, need(f, 'name'), JSON.parse(need(f, 'json'))),
  'remove-budget': (c, f) => removeBudget(c, need(f, 'name')),
  'add-recurring': (c, f) => addRecurringPlan(c, JSON.parse(need(f, 'json'))),
  'update-recurring': (c, f) => updateRecurringPlan(c, need(f, 'id'), JSON.parse(need(f, 'json'))),
  'remove-recurring': (c, f) => removeRecurringPlan(c, need(f, 'id')),
  'skip-recurring': (c, f) => skipRecurring(c, need(f, 'id'), need(f, 'date')),
  'add-loan': (c, f) => addLoanPlan(c, JSON.parse(need(f, 'json'))),
  'update-loan': (c, f) => updateLoanPlan(c, need(f, 'id'), JSON.parse(need(f, 'json'))),
  'remove-loan': (c, f) => removeLoanPlan(c, need(f, 'id')),
  'add-lifeevent': (c, f) => addLifeEvent(c, JSON.parse(need(f, 'json'))),
  'update-lifeevent': (c, f) => updateLifeEvent(c, need(f, 'id'), JSON.parse(need(f, 'json'))),
  'remove-lifeevent': (c, f) => removeLifeEvent(c, need(f, 'id')),
  'set-birthday': (c, f) => setBirthday(c, need(f, 'date')),
};

function need(f: Record<string, string | string[]>, key: string): string {
  const v = str(f, key);
  if (!v) fail(`缺少 --${key}`);
  return v;
}

function cmdConfig(action: string, f: Record<string, string | string[]>): unknown {
  const configPath = str(f, 'config');
  if (!configPath) fail('缺少 --config');
  const abs = resolveConfig(configPath);

  if (action === 'get') {
    const abs = resolveConfig(configPath, { mustExist: true });
    return { ok: true, path: configPath, resolvedPath: abs, config: loadConfig(abs, true) };
  }

  const op = CONFIG_OPS[action];
  if (!op) fail(`未知 config 子命令：${action}`);

  const config = loadConfig(configPath);
  const next = op(config, f);
  saveConfig(configPath, next);
  return { ok: true, path: configPath, action, config: next };
}

// ─── 主分发 ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [group, action, ...rest] = argv;
  const f = parseFlags(rest);
  const vaultFlag = str(f, 'vault');
  if (vaultFlag) _globalVaultOverride = vaultFlag;

  if (group === 'ledger' && action === 'append') {
    const r = await cmdLedgerAppend(f);
    process.stdout.write(JSON.stringify(r) + '\n');
    return;
  }
  if (group === 'ledger' && action === 'list') {
    const r = cmdLedgerList(f);
    process.stdout.write(JSON.stringify(r) + '\n');
    return;
  }
  if (group === 'ledger' && action === 'edit') {
    const r = await cmdLedgerEdit(f);
    process.stdout.write(JSON.stringify(r) + '\n');
    return;
  }
  if (group === 'ledger' && action === 'delete') {
    const r = await cmdLedgerDelete(f);
    process.stdout.write(JSON.stringify(r) + '\n');
    return;
  }
  if (group === 'ledger' && action === 'valuation') {
    const r = await cmdLedgerValuation(f);
    process.stdout.write(JSON.stringify(r) + '\n');
    return;
  }
  if (group === 'ledger' && action === 'loan-post') {
    const r = await cmdLedgerLoanPost(f);
    process.stdout.write(JSON.stringify(r) + '\n');
    return;
  }
  if (group === 'block' && action === 'generate') {
    const r = cmdBlockGenerate(f);
    process.stdout.write(JSON.stringify(r) + '\n');
    return;
  }
  if (group === 'config' && action) {
    const r = cmdConfig(action, f);
    process.stdout.write(JSON.stringify(r) + '\n');
    return;
  }

  process.stdout.write(
    JSON.stringify({
      ok: false,
      error:
        '用法: finance-block-cli.js <ledger|block|config> <action> [flags]\n' +
        '  ledger append  --ledger <path> [--config <cfg>] [--date YYYY-MM-DD] [--narration 摘要]\n' +
        '                  [--type 分类] [--owner 归属] [--via auto|obsidian|fs]\n' +
        '                  --leg "账户|in|元" (可重复) | --json \'{...}\'\n' +
        '  ledger list    --ledger <path>\n' +
        '  ledger edit    --ledger <path> --ref ^t-XXX [同 append 的参数]\n' +
        '  ledger delete  --ledger <path> --ref ^t-XXX\n' +
        '  ledger valuation --ledger <path> --date <d> --account <账户> --amount <整数分> [--currency USD] [--config <cfg>]\n' +
        '  ledger loan-post --ledger <path> --config <cfg> --id <贷款id> [--period N]\n' +
        '  block generate --block <finance-log|finance-assets|finance-budget|finance-heatmap|finance-ficalc|finance-recurring|fin-beancount>\n' +
        '                  [--param key=val ...] [--json \'{...}\'] [--note <笔记路径 可选，写入该文件>]\n' +
        '  config <add-account|update-account|remove-account|add-owner|remove-owner|set-default-owner|\n' +
        '         add-type|update-type|remove-type|add-currency|update-currency|remove-currency|set-base|\n' +
        '         add-budget|update-budget|remove-budget|add-recurring|update-recurring|remove-recurring|skip-recurring|\n' +
        '         add-loan|update-loan|remove-loan|add-lifeevent|update-lifeevent|remove-lifeevent|set-birthday|get>\n' +
        '         --config <cfg> [--json \'{...}\' | --name X | --code X | --id X | --date X]' +
        '' +
        '路径说明：' +
        '  · 建议传入绝对路径（最稳）。相对路径会依次尝试：当前目录 → Obsidian vault 根' +
        '    （自动探测，或显式 --vault <vault根>）。config get 对不存在文件直接报错，' +
        '    不再静默回退默认配置。',
    }) + '\n',
  );
  process.exit(1);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
