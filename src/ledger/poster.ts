/**
 * 入账服务（Poster）
 *
 * 核心职责：
 * 1. 将草稿交易从原笔记剪切到账本文件（settings.ledgerPath，单一文件）
 * 2. 生成块引用 ID（^t-YYYYMMDDHHmmss）
 * 3. 在原位置替换为 finance-log 代码块（携带 id 参数指向刚入账的这笔账）
 * 4. 支持批量入账 / 逐笔入账（一个 fin-beancount 草稿块里可含多笔，各自独立入账）
 *
 * 设计要点（参考《已确定设计点》§1 衍生设计）：
 * - 入账前：记录是草稿，可随意修改
 * - 入账后：记录进入账本，原位留 finance-log 链接，只能在账本中修改
 * - 逐笔/批量入账：一个草稿块里的每一笔都独立生成块引用 ID、独立写入账本、
 *   原位各自替换为一张 finance-log 卡片；未入账的草稿仍留在（新生成的）
 *   fin-beancount 块中，按原顺序排布。
 *
 * 账本写入统一走 ledgerFile.appendEntryToLedgerBlock：
 * 账本里始终只保留「一个 fin-beancount 块」，每笔入账都追加进这个块的底部，
 * 而不是每次新建一个块（否则账本会散落成多个块）。
 */

import { App, TFile } from 'obsidian';
import { parseFinBeancount } from '../parser/finBeancount';
import { appendEntryToLedgerBlock } from './ledgerFile';
import { t } from '../i18n';

/** 入账结果（单笔） */
export interface PostOneResult {
  index: number; // 区块内第几笔（0 基）
  success: boolean;
  blockRefId?: string; // 生成的块引用 ID
  ledgerPath?: string; // 账本文件路径
  error?: string;
}

/**
 * 生成块引用 ID
 * 格式：^t-YYYYMMDDHHmmssNN（精确到秒 + 两位递增序号，确保批量入账时同秒内唯一）
 * 估值行用对称的 ^v-（见 generateValuationRefId）。
 */
let blockRefSeq = 0;
export function generateBlockRefId(date?: string): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const seq = String(blockRefSeq++ % 100).padStart(2, '0');

  const datePrefix = date ? date.replace(/-/g, '') : `${year}${month}${day}`;
  return `^t-${datePrefix}${hours}${minutes}${seconds}${seq}`;
}

/**
 * 生成估值行的块引用 ID
 * 格式：^v-YYYYMMDDHHmmss（与交易的 ^t- 对称且可区分）
 *
 * 之所以另起一个前缀而非复用 ^t-：估值不是交易（不产生分录、不参与零和），
 * finance-log 只索引交易，用同一前缀会让流水视图误收估值。
 */
export function generateValuationRefId(date?: string): string {
  return generateBlockRefId(date).replace(/^\^t-/, '^v-');
}

/**
 * 生成原位展示代码块：入账后，笔记中原本的 fin-beancount 被替换为
 * 一个 finance-log 代码块（携带 id 指向刚入账的这笔账），
 * 既保留"此地记过一笔"的痕迹，又能就地展示该笔明细，而非 Obsidian 双链。
 *
 * 格式：
 *   ```finance-log
 *   id: ^t-20260729120000
 *   ```
 */
function generateLogCard(blockRefId: string): string {
  return '```finance-log\n' + `id: ${blockRefId}\n` + '```\n';
}

/** 代码块内的一个可入账条目：一笔交易，或一条估值快照 */
export interface BlockEntry {
  kind: 'txn' | 'valuation';
  /** 该条目在源文件中的原始文本（交易含缩进的分录/元数据行；估值为单行 + 可能的 ^v- 行） */
  text: string;
}

/**
 * 把一个 fin-beancount 代码块的内文拆成「可独立入账的条目」序列。
 *
 * 用于支持一个代码块里容纳多条草稿、并各自独立入账：
 *   - 「日期行 + custom "fb-valuation"」→ 一条估值条目（单行，自成片段）
 *   - 其它「日期行」→ 一笔交易的起点，后续缩进行归属该笔
 *   - 空行 / 全行注释作为条目之间的分隔（不进入片段）
 *   - ^t- / ^v- 块引用行归属上一个条目
 *
 * 返回顺序 = 源文件中的出现顺序，渲染层据此建立「卡片下标 ↔ 条目下标」的映射。
 */
export function splitEntries(source: string): BlockEntry[] {
  const DATE_LINE = /^\d{4}-\d{2}-\d{2}\s+([*!]?)\s*(.*)$/;
  const VALUATION_LINE = /^\d{4}-\d{2}-\d{2}\s+custom\s+"fb-valuation"\s+/;
  const lines = source.split(/\r?\n/);
  const groups: { kind: 'txn' | 'valuation'; lines: string[] }[] = [];
  let current: { kind: 'txn' | 'valuation'; lines: string[] } | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    // 全行注释 / 空行：仅作为分隔，结束当前片段
    if (trimmed === '' || trimmed.startsWith(';')) {
      current = null;
      continue;
    }
    // 块引用 ID 行：归属当前片段
    if (/^\^[tv]-/.test(trimmed)) {
      if (current) current.lines.push(line);
      continue;
    }
    // 估值行：自成一个条目（后续 ^v- 行会追加进来）
    if (VALUATION_LINE.test(line)) {
      current = { kind: 'valuation', lines: [line] };
      groups.push(current);
      continue;
    }
    // 新交易起点：先结束上一条
    if (DATE_LINE.test(line)) {
      current = { kind: 'txn', lines: [line] };
      groups.push(current);
      continue;
    }
    if (current) {
      current.lines.push(line);
    } else {
      // 非日期、非空的游离行：兜底归为独立片段，避免数据丢失
      current = { kind: 'txn', lines: [line] };
      groups.push(current);
    }
  }

  return groups
    .map((g) => ({ kind: g.kind, text: g.lines.join('\n') }))
    .filter((e) => e.text.trim() !== '');
}

/**
 * 仅取交易片段（向后兼容的便捷封装）。
 * 估值条目不在返回值中——它们不是交易。
 */
export function splitTransactions(source: string): string[] {
  return splitEntries(source)
    .filter((e) => e.kind === 'txn')
    .map((e) => e.text);
}

/**
 * 入账单个 fin-beancount 草稿代码块内的若干条目（交易 / 估值）。
 *
 * - indices 指定要入账的条目下标（0 基，对应 splitEntries 的顺序）。
 * - 交易：独立生成 ^t- 块引用 ID → 追加到账本 → 原位替换为 finance-log 卡片。
 * - 估值：独立生成 ^v- 块引用 ID → 追加到账本 → **原位保留在 fin-beancount 块中**
 *   （附上 ^v- 行）。不替换成 finance-log——finance-log 只索引交易，
 *   塞估值进去会污染流水视图。
 * - 未选中 / 入账失败的条目一律原样保留，绝不丢数据。
 *
 * @param app          Obsidian App 实例
 * @param sourceFile   源文件（含草稿的笔记）
 * @param blockSource  代码块内文（不含围栏）
 * @param startPos     代码块在文件中的起始位置（整段围栏的起点）——保留为兼容参数，
 *                     写回时会基于最新文件内容重新定位（见函数尾部），不直接信任该值。
 * @param endPos       代码块在文件中的结束位置（整段围栏的终点）
 * @param ledgerPath   账本文件完整路径（settings.ledgerPath）
 * @param indices      要入账的条目下标集合
 */
export async function postTransactionsInBlock(
  app: App,
  sourceFile: TFile,
  blockSource: string,
  startPos: number,
  endPos: number,
  ledgerPath: string,
  indices: number[],
): Promise<{ results: PostOneResult[]; ledgerPath?: string; writebackFailed?: boolean }> {
  const entries = splitEntries(blockSource);
  const idByIndex = new Map<number, string>();
  const results: PostOneResult[] = [];

  // 1) 逐条写入账本（交易 ^t- / 估值 ^v-，各自独立）
  for (const i of indices) {
    const entry = entries[i];
    if (entry === undefined) {
      results.push({ index: i, success: false, error: t('poster.err.notFound', { n: String(i + 1) }) });
      continue;
    }
    const { kind, text } = entry;

    // 重复入账守卫：片段中已带块引用行
    if (/^\^[tv]-\d+/m.test(text)) {
      results.push({
        index: i,
        success: false,
        error: kind === 'valuation' ? t('poster.err.postedVal') : t('poster.err.postedTxn'),
      });
      continue;
    }

    const parsed = parseFinBeancount(text);
    if (parsed.errors.length > 0) {
      results.push({ index: i, success: false, error: parsed.errors[0].message });
      continue;
    }

    let refId: string;
    if (kind === 'valuation') {
      const val = parsed.valuations[0];
      if (!val) {
        results.push({ index: i, success: false, error: t('poster.err.noValuation') });
        continue;
      }
      refId = generateValuationRefId(val.date);
    } else {
      const txn = parsed.transactions[0];
      if (!txn) {
        results.push({ index: i, success: false, error: t('poster.err.noTxn') });
        continue;
      }
      refId = generateBlockRefId(txn.date);
    }

    const writeResult = await appendEntryToLedgerBlock(app, ledgerPath, text, refId);
    if (!writeResult.success) {
      results.push({
        index: i,
        success: false,
        error: t('poster.err.writeFailed', { error: writeResult.error || t('poster.err.unknown') }),
      });
      continue;
    }

    idByIndex.set(i, refId);
    results.push({ index: i, success: true, blockRefId: refId, ledgerPath });
  }

  // 2) 原位重建（保序）
  //    - 已入账交易 → finance-log 卡片
  //    - 已入账估值 → 留在 fin-beancount 块中（附 ^v- 行）
  //    - 未入账条目 → 留在 fin-beancount 草稿块中
  //    已入账估值与未入账草稿必须分属不同的块：同块混排会让整块被判为「已入账」
  //    （isPosted 看块内是否含 ^t-/^v-），草稿卡片会被错误渲染成已入账态。
  const segments: string[] = [];
  let buffer: string[] = [];
  let bufferPosted = false;
  const flushBuffer = (): void => {
    if (buffer.length > 0) {
      segments.push('```fin-beancount\n' + buffer.join('\n\n') + '\n```');
      buffer = [];
    }
  };
  const pushToBuffer = (text: string, posted: boolean): void => {
    if (buffer.length > 0 && bufferPosted !== posted) flushBuffer();
    bufferPosted = posted;
    buffer.push(text);
  };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const id = idByIndex.get(i);
    if (id && entry.kind === 'txn') {
      flushBuffer();
      segments.push(generateLogCard(id));
    } else if (id) {
      // 已入账估值：原位保留，附块引用行
      pushToBuffer(`${entry.text}\n${id}`, true);
    } else {
      // 未选中、或选中但入账失败：保留原样，避免数据丢失
      pushToBuffer(entry.text, /^\^[tv]-\d+/m.test(entry.text));
    }
  }
  flushBuffer();

  const newBlock = segments.join('\n\n');

  // 写回前重新定位代码块：以「最新文件内容」重新匹配目标代码块，而不是信任
  // 调用方渲染时捕获的 startPos/endPos。弹窗打开期间用户可能编辑过笔记（增删行、
  // 移动代码块），旧位置会漂移——盲目按旧位置切片会破坏用户笔记结构。
  const content = await app.vault.read(sourceFile);
  const codeBlockPattern = /```fin-beancount\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let curStart = -1;
  let curEnd = -1;
  while ((match = codeBlockPattern.exec(content)) !== null) {
    if (match[1].trim() === blockSource.trim()) {
      curStart = match.index;
      curEnd = match.index + match[0].length;
      break;
    }
  }

  if (curStart === -1) {
    // 代码块已不存在或被改得面目全非：放弃原位替换（绝不破坏文件）。
    // 账本写入已成功；草稿留在原笔记，下次渲染会显示「已入账」状态，用户可手动清理。
    return { results, ledgerPath, writebackFailed: true };
  }

  const before = content.slice(0, curStart);
  const after = content.slice(curEnd);
  await app.vault.modify(sourceFile, before + newBlock + after);

  return { results, ledgerPath };
}
