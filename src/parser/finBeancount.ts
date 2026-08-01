import type { BeancountLeg, Transaction, Valuation } from '../types';

/**
 * fin-beancount 轻量复式代码块解析器
 *
 * 语法规范（M1 定稿）：
 *
 *   ; 全行注释
 *   2026-07-29 * 午餐 牛肉面        ; 行内注释
 *     现金        -3500              ; 金额单位：分
 *     费用:餐饮    3500
 *     type: 餐饮                     ; 元数据行（缩进 key: value）
 *     owner: 自己
 *
 *   2026-07-30 ! 待确认转账          ; ! = pending 标记
 *     银行卡      -10000 USD         ; 可选币种后缀
 *     支付宝       10000 USD
 *
 * 规则：
 *   - 首行：YYYY-MM-DD [flag: * | !] [摘要]
 *   - 缩进行（leg）：账户名  整数金额 [币种]
 *   - 缩进行（meta）：key: value（无空格的 key + 冒号 + 空格 + 值）
 *   - 一笔交易所有 leg 之和必须为零（零和校验）
 *   - 空行或新日期行结束当前交易
 *   - 以 ; 开头的行为注释，忽略
 */

// ─── 正则 ──────────────────────────────────────────────────────

/** 日期行：YYYY-MM-DD [flag] [narration] */
const DATE_RE = /^(\d{4}-\d{2}-\d{2})\s+([*!])?\s*(.*)$/;

/** 分录行（leg）：缩进 + 账户名 + 金额(整数分) + [币种] */
const LEG_RE = /^\s+([\p{L}\p{N}_:／/-]+)\s+(-?\d+)\s*([A-Z]{3})?\s*$/u;

/** 元数据行：缩进 + key: value（key 支持中文等 Unicode 字符） */
const META_RE = /^\s+([\p{L}\p{N}_][\p{L}\p{N}_-]*):\s+(.+)$/u;

/** 估值指令行：YYYY-MM-DD custom "fb-valuation" <账户名> <金额> [币种]
 *  采用 beancount 官方 custom 指令作为唯一写法（保证账本 100% 合法 beancount）。
 *  不参与零和校验、不产生分录、不改余额——仅作为视图层覆盖。 */
const VALUATION_RE = /^(\d{4}-\d{2}-\d{2})\s+custom\s+"fb-valuation"\s+([\p{L}\p{N}_:／/-]+)\s+(-?\d+)\s*([A-Z]{3})?\s*$/u;

// ─── 类型 ──────────────────────────────────────────────────────

export interface ParseError {
  line: number; // 1-based 行号
  message: string;
}

export interface ParseResult {
  transactions: Transaction[];
  valuations: Valuation[]; // 估值快照指令（custom "fb-valuation"）
  errors: ParseError[];
}

// ─── 解析器 ────────────────────────────────────────────────────

interface PendingTxn {
  date: string;
  flag: string | undefined;
  narration: string;
  legs: BeancountLeg[];
  meta: Record<string, string>;
  currency: string | undefined;
  blockRefId?: string; // 入账后由 poster 附加的 ^t- 块引用 ID（真实值，优先于合成 id）
  startLine: number;
}

export function parseFinBeancount(source: string, opts?: { draft?: boolean }): ParseResult {
  const transactions: Transaction[] = [];
  const valuations: Valuation[] = [];
  const errors: ParseError[] = [];
  const lines = source.split(/\r?\n/);

  let current: PendingTxn | null = null;
  let txnIndex = 0;

  const flush = (): void => {
    if (!current) return;

    // 零和校验
    const sum = current.legs.reduce((acc, l) => acc + l.amount, 0);
    if (current.legs.length === 0) {
      errors.push({ line: current.startLine, message: `交易无分录行：${current.date} ${current.narration}` });
    } else if (sum !== 0) {
      errors.push({
        line: current.startLine,
        message: `零和不平衡（差额 ${sum > 0 ? '+' : ''}${sum} 分）：${current.date} ${current.narration}`,
      });
    }

    // 生成块引用 ID：优先使用账本中真实的 ^t- 行（保证与 poster 写入一致，
    // 使 finance-log 的 id 参数能精确命中）；草稿交易无 ^t- 行时退化为合成 id。
    const id = current.blockRefId ?? `^t-${current.date.replace(/-/g, '')}${String(txnIndex).padStart(4, '0')}`;

    const txn: Transaction = {
      id,
      date: current.date,
      legs: current.legs,
      draft: opts?.draft ?? false,
    };

    if (current.narration) txn.narration = current.narration;
    if (current.currency) txn.currency = current.currency;

    // 从元数据提取结构化字段
    if (current.meta['type']) txn.txnType = current.meta['type'];
    if (current.meta['owner']) txn.owner = current.meta['owner'];

    // 剩余元数据放入 fields（可筛选）
    const reservedKeys = new Set(['type', 'owner']);
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(current.meta)) {
      if (!reservedKeys.has(k)) fields[k] = v;
    }
    if (Object.keys(fields).length > 0) txn.fields = fields;

    transactions.push(txn);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    let line = lines[i];

    // 去除行内注释（; 之后的内容），但保留注释文本供估值行使用
    const commentIdx = line.indexOf(';');
    let inlineComment: string | undefined;
    if (commentIdx === 0) continue; // 全行注释
    if (commentIdx > 0) {
      inlineComment = line.slice(commentIdx + 1).trim();
      line = line.slice(0, commentIdx);
    }

    // 空行 → 结束当前交易
    if (line.trim() === '') {
      flush();
      continue;
    }

    // 跳过块引用 ID 行（^t-YYYYMMDDHHmmss，Obsidian block ref，非交易数据）
    // 入账后的分录会在 fence 内附带该行，解析时应忽略其作为交易行，
    // 但需捕获其真实值作为交易 id（finance-log 的 id 参数据此精确查询），
    // 同时让 indexer 的 isPosted 判定（源码含 ^t-）生效。
    if (/^\^t-/.test(line.trim())) {
      if (current) current.blockRefId = line.trim();
      continue;
    }

    // 尝试匹配估值指令行（custom "fb-valuation"，独立于交易，无需上下文）
    const valMatch = VALUATION_RE.exec(line);
    if (valMatch) {
      flush(); // 估值行结束当前未闭合的交易
      valuations.push({
        date: valMatch[1],
        account: valMatch[2],
        amount: parseInt(valMatch[3], 10),
        currency: valMatch[4] || undefined,
        comment: inlineComment || undefined,
      });
      continue;
    }

    // 尝试匹配日期行（新交易开始）
    const dateMatch = DATE_RE.exec(line);
    if (dateMatch) {
      flush(); // 先结束上一笔
      txnIndex++;
      current = {
        date: dateMatch[1],
        flag: dateMatch[2] || undefined,
        narration: dateMatch[3].trim(),
        legs: [],
        meta: {},
        currency: undefined,
        startLine: lineNo,
      };
      continue;
    }

    // 以下行必须属于某个交易
    if (!current) {
      // 非缩进的无效行（既不是日期也不是注释）
      if (line.trim() !== '') {
        errors.push({ line: lineNo, message: `无法识别的行（缺少日期行上下文）：${line.trim()}` });
      }
      continue;
    }

    // 尝试匹配分录行（leg）
    const legMatch = LEG_RE.exec(line);
    if (legMatch) {
      const amount = parseInt(legMatch[2], 10);
      const currency = legMatch[3] || undefined;
      current.legs.push({ account: legMatch[1], amount });
      // 记录币种（若多个 leg 币种不一致，以最后一个为准，后续可加校验）
      if (currency) current.currency = currency;
      continue;
    }

    // 尝试匹配元数据行
    const metaMatch = META_RE.exec(line);
    if (metaMatch) {
      current.meta[metaMatch[1]] = metaMatch[2].trim();
      continue;
    }

    // 无法识别的缩进行
    errors.push({ line: lineNo, message: `无法解析的行：${line.trim()}` });
  }

  flush(); // 处理最后一笔

  return { transactions, valuations, errors };
}
