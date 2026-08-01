/*
 * RecordTransactionModal —— 「记一笔」入口
 *
 * 与「插入代码块」共用同一张录入表单（EntryFormModal），区别只在于「提交后的行为」：
 *   插入代码块 → 在笔记光标处插入 fin-beancount 块（草稿，待入账）
 *   记一笔     → 直接把分录入账到账本文件（已入账，带 ^t- 块引用 ID）
 *
 * 之所以「直接入账」：用户点这个按钮就是为了立刻落账，不需要先落到笔记再手动入账。
 * 落账后立刻刷新索引，finance-log 等视图即时更新。
 */

import { Notice } from 'obsidian';
import type { App } from 'obsidian';
import { t } from '../i18n';
import type { BlockDefinitionWithParams } from '../blockProvider';
import type { FinanceConfig } from '../types';
import { EntryFormModal } from './EntryFormModal';
import { generateBlockRefId } from '../ledger/poster';
import { appendEntryToLedgerBlock } from '../ledger/ledgerFile';
import type { Indexer } from '../ledger/indexer';

function todayStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export class RecordTransactionModal extends EntryFormModal {
  private ledgerPath: string;
  private indexer: Indexer;

  constructor(
    app: App,
    block: BlockDefinitionWithParams,
    config: FinanceConfig | undefined,
    ledgerPath: string,
    indexer: Indexer,
  ) {
    super(app, block, config);
    this.ledgerPath = ledgerPath;
    this.indexer = indexer;
  }

  protected getSubmitLabel(): string {
    return t('modal.record.submit');
  }

  // 记一笔：没有「默认块」可跳过，必须逐项填写
  protected showSkip(): boolean {
    return false;
  }

  // 标题/图标覆盖为「记一笔」，与左侧 ribbon 文案一致（表单字段仍与插入弹窗共用）
  protected getHeaderTitle(): string {
    return t('command.record');
  }

  protected getHeaderIcon(): string | undefined {
    return 'coins';
  }

  protected onSubmit(blockText: string): void {
    const date = this.values['date'] || todayStr();
    const blockRefId = generateBlockRefId(date);

    // 取出 fin-beancount 内文（去掉围栏），作为账本唯一块内的一笔分录；
    // 块引用 ID 由辅助函数统一追加到该笔之后，indexer 据此判定为已入账（isDraft=false）。
    // 注意：buildCodeBlock 产出的 blockText 末尾是 "\n```\n"（闭合围栏后还带一个换行），
    // 因此不能用 /\r?\n```$/ 这种"围栏必须位于字符串末尾"的写法，否则闭合 ``` 会残留，
    // 并在下一次追加时落到新的 ^t- 块引用之前，造成渲染异常。这里改用更稳健的去围栏方式。
    const entryBody = blockText
      .replace(/^```[^\n]*\r?\n/, '') // 去掉开头围栏行（```fin-beancount）
      .replace(/\r?\n?```\r?\n?/, '') // 去掉闭合围栏行及其周围换行
      .trim();

    void this.record(entryBody, date, blockRefId);
  }

  private async record(entryBody: string, date: string, blockRefId: string): Promise<void> {
    const result = await appendEntryToLedgerBlock(
      this.app,
      this.ledgerPath,
      entryBody,
      blockRefId,
    );

    if (!result.success) {
      new Notice(t('modal.record.error', { error: result.error || '' }));
      return;
    }

    // 落账后立刻刷新索引，finance-log 等视图即时更新
    await this.indexer.updateFile(result.ledgerPath);

    new Notice(t('modal.record.success', { ledgerPath: result.ledgerPath }));
    this.close();
  }
}
