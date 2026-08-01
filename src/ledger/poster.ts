/**
 * 入账服务（Poster）
 *
 * 核心职责：
 * 1. 将草稿交易从原笔记剪切到账本文件（settings.ledgerPath，单一文件）
 * 2. 生成块引用 ID（^t-YYYYMMDDHHmmss）
 * 3. 在原位置替换为 finance-log 代码块（携带 id 参数指向刚入账的这笔账）
 * 4. 支持批量入账
 *
 * 设计要点（参考《已确定设计点》§1 衍生设计）：
 * - 入账前：记录是草稿，可随意修改
 * - 入账后：记录进入账本，原位留 finance-log 链接，只能在账本中修改
 * - 批量入账：一键处理多条草稿，每条独立生成块引用 ID
 *
 * 账本写入统一走 ledgerFile.appendEntryToLedgerBlock：
 * 账本里始终只保留「一个 fin-beancount 块」，每笔入账都追加进这个块的底部，
 * 而不是每次新建一个块（否则账本会散落成多个块）。
 */

import { App, TFile } from 'obsidian';
import { parseFinBeancount } from '../parser/finBeancount';
import { appendEntryToLedgerBlock } from './ledgerFile';

/** 入账结果 */
export interface PostResult {
  success: boolean;
  blockRefId?: string; // 生成的块引用 ID
  ledgerPath?: string; // 账本文件路径
  error?: string;
}

/** 批量入账结果 */
export interface BatchPostResult {
  total: number;
  success: number;
  failed: number;
  results: PostResult[];
}

/**
 * 生成块引用 ID
 * 格式：^t-YYYYMMDDHHmmss（精确到秒，确保唯一性）
 */
export function generateBlockRefId(date?: string): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  const datePrefix = date ? date.replace(/-/g, '') : `${year}${month}${day}`;
  return `^t-${datePrefix}${hours}${minutes}${seconds}`;
}

/**
 * 生成原位展示代码块：入账后，笔记中原本的 fin-beancount 被替换为
 * 一个 finance-log 代码块（携带 id 参数指向刚入账的这笔账），
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

/**
 * 入账单条交易
 *
 * @param app Obsidian App 实例
 * @param sourceFile 源文件（包含草稿的笔记）
 * @param codeBlockSource 代码块源码（fin-beancount 内文，不含围栏）
 * @param codeBlockStartPos 代码块在文件中的起始位置（用于替换）
 * @param codeBlockEndPos 代码块在文件中的结束位置
 * @param ledgerPath 账本文件完整路径（settings.ledgerPath）
 * @returns 入账结果
 */
export async function postTransaction(
  app: App,
  sourceFile: TFile,
  codeBlockSource: string,
  codeBlockStartPos: number,
  codeBlockEndPos: number,
  ledgerPath: string,
): Promise<PostResult> {
  try {
    // 1. 解析代码块，提取交易
    const parseResult = parseFinBeancount(codeBlockSource);
    if (parseResult.errors.length > 0) {
      return {
        success: false,
        error: `解析失败：${parseResult.errors[0].message}`,
      };
    }

    if (parseResult.transactions.length === 0) {
      return {
        success: false,
        error: '未找到交易记录',
      };
    }

    const transaction = parseResult.transactions[0];

    // 检查是否已经入账（源码中包含块引用 ID 行）
    if (/^\^t-\d+/m.test(codeBlockSource)) {
      return {
        success: false,
        error: '该交易已入账，不能重复入账',
      };
    }

    // 2. 生成块引用 ID
    const blockRefId = generateBlockRefId(transaction.date);

    // 3. 写入账本：追加进唯一的 fin-beancount 块底部（缺失则创建带围栏的块）
    //    codeBlockSource 即分录内文（不含围栏），直接作为 entryBody 传入。
    const writeResult = await appendEntryToLedgerBlock(
      app,
      ledgerPath,
      codeBlockSource,
      blockRefId,
    );

    if (!writeResult.success) {
      return {
        success: false,
        error: `写入账本失败：${writeResult.error || '未知错误'}`,
      };
    }

    // 4. 生成原位展示代码块（finance-log，携带 id 指向本笔账）
    const logCard = generateLogCard(blockRefId);

    // 5. 替换原笔记中的 fin-beancount 代码块为 finance-log 代码块
    const sourceContent = await app.vault.read(sourceFile);
    const before = sourceContent.slice(0, codeBlockStartPos);
    const after = sourceContent.slice(codeBlockEndPos);
    const newContent = before + logCard + after;

    await app.vault.modify(sourceFile, newContent);

    return {
      success: true,
      blockRefId,
      ledgerPath,
    };
  } catch (error) {
    return {
      success: false,
      error: `入账失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 批量入账
 *
 * @param app Obsidian App 实例
 * @param sourceFile 源文件
 * @param codeBlocks 代码块列表（包含源码和位置信息）
 * @param ledgerPath 账本文件完整路径（settings.ledgerPath）
 * @returns 批量入账结果
 */
export async function batchPostTransactions(
  app: App,
  sourceFile: TFile,
  codeBlocks: Array<{
    source: string;
    startPos: number;
    endPos: number;
  }>,
  ledgerPath: string,
): Promise<BatchPostResult> {
  const results: PostResult[] = [];
  let success = 0;
  let failed = 0;

  // 从后往前处理，避免位置偏移问题
  const sortedBlocks = [...codeBlocks].sort((a, b) => b.startPos - a.startPos);

  for (const block of sortedBlocks) {
    const result = await postTransaction(
      app,
      sourceFile,
      block.source,
      block.startPos,
      block.endPos,
      ledgerPath,
    );

    results.push(result);
    if (result.success) {
      success++;
    } else {
      failed++;
    }
  }

  return {
    total: codeBlocks.length,
    success,
    failed,
    results: results.reverse(), // 恢复原始顺序
  };
}
