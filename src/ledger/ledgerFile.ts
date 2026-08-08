/**
 * 账本文件写入辅助（Ledger File Helper）
 *
 * 将一笔 fin-beancount 分录写入账本文件。复式记账的两条主路径
 * （笔记内「入账」、以及「记一笔」直接入账）共用这里，避免各自重复
 * 计算账本路径与落盘逻辑：
 *   - appendEntryToLedgerBlock：确保账本文件存在后，把这一笔分录写入账本文件里
 *     **唯一的那个 fin-beancount 块**底部（不存在则创建带标题的新文件 + 块）。
 *
 * 设计要点：
 *   - 账本路径由调用方直接给出（settings.ledgerPath，单一文件），不再按月切片。
 *   - 账本里只保留「一个 fin-beancount 块」：后续每一笔都追加进这一个块的底部，
 *     而不是每次新建一个块（否则账本会散落成多个块，难以维护）。
 *   - 不直接处理「入账」语义（是否带 ^t- 块引用由调用方决定），只负责落盘，
 *     保持单一职责、便于复用与测试。
 */

import { App } from 'obsidian';
import { appendEntryToContent } from '../shared/ledgerWrite';

export interface AppendResult {
  success: boolean;
  ledgerPath: string;
  error?: string;
}

/**
 * 将一笔已入账分录写入账本文件的「唯一 fin-beancount 块」底部。
 *
 * 行为：
 *   - 账本文件 / 唯一的 fin-beancount 块不存在 → 创建文件（含一级标题 + 单个 fin-beancount 块），把这笔放进去。
 *   - 已存在唯一的 fin-beancount 块 → 在该块内、闭合 ``` 之前插入这笔（与块内其他分录用空行隔开）。
 *   - 文件存在但没有 fin-beancount 块 → 在文件末尾追加一个 fin-beancount 块。
 *
 * 纯字符串变换（块的查找与插入）已抽到 src/shared/ledgerWrite.appendEntryToContent，
 * 本函数只负责 Obsidian 文件 IO，供插件与 CLI 共用同一份插入逻辑。
 *
 * @param ledgerPath  账本文件完整路径（如 账本/账本.md）
 * @param entryBody   分录内文（**不含** ``` 围栏），如（虚构示例）：
 *                      2026-01-01 * 示例支出\n  资产:现金 -3500\n  费用:示例 3500
 * @param blockRefId  块引用 ID（可带或不带前导 ^t-），如 ^t-20260729120000
 */
export async function appendEntryToLedgerBlock(
  app: App,
  ledgerPath: string,
  entryBody: string,
  blockRefId: string,
): Promise<AppendResult> {
  const adapter = app.vault.adapter;

  // 账本文件所在文件夹（用于确保目录存在）
  const folder = ledgerPath.includes('/')
    ? ledgerPath.slice(0, ledgerPath.lastIndexOf('/'))
    : '';

  try {
    // 确保账本文件夹存在（根目录无需创建）
    if (folder && !(await adapter.exists(folder))) {
      await adapter.mkdir(folder);
    }

    const existing = (await adapter.exists(ledgerPath))
      ? await adapter.read(ledgerPath)
      : null;

    const newContent = appendEntryToContent(existing, entryBody, blockRefId, ledgerPath);
    await adapter.write(ledgerPath, newContent);
    return { success: true, ledgerPath };
  } catch (error) {
    return {
      success: false,
      ledgerPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
