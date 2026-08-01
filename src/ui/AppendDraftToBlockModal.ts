/*
 * AppendDraftToBlockModal —— 「加入草稿」入口
 *
 * 与 RecordTransactionModal 共用同一张录入表单（EntryFormModal），区别仅在提交后的行为：
 *   记一笔（RecordTransactionModal）：填完 → 直接入账到账本文件（带 ^t- 块引用）
 *   加入草稿（本类）：填完 → 追加一笔新分录到「当前 fin-beancount 代码块」的草稿区
 *     （不带 ^t- 块引用，仍是草稿态；后续可与块内其他草稿一起点「入账」批量入账）
 *
 * 设计意图：用户从 fin-beancount 草稿代码块点「添加记录」时，期望新分录出现在
 * 同一个代码块里、由顶部「入账 / 批量入账」统一入账，而不是悄悄写进账本。
 * 写进账本会与原代码块草稿形成重复，被 finance-log 索引两次（已确认的 bug）。
 */

import { Notice, TFile } from 'obsidian';
import type { App } from 'obsidian';
import { t } from '../i18n';
import type { BlockDefinitionWithParams } from '../blockProvider';
import type { FinanceConfig } from '../types';
import type { Indexer } from '../ledger/indexer';
import { EntryFormModal } from './EntryFormModal';

export class AppendDraftToBlockModal extends EntryFormModal {
  private sourceFile: TFile;
  private codeBlockStartPos: number;
  private codeBlockEndPos: number;
  private indexer: Indexer;

  constructor(
    app: App,
    block: BlockDefinitionWithParams,
    config: FinanceConfig | undefined,
    sourceFile: TFile,
    codeBlockStartPos: number,
    codeBlockEndPos: number,
    indexer: Indexer,
  ) {
    super(app, block, config);
    this.sourceFile = sourceFile;
    this.codeBlockStartPos = codeBlockStartPos;
    this.codeBlockEndPos = codeBlockEndPos;
    this.indexer = indexer;
  }

  protected getSubmitLabel(): string {
    return t('modal.draft.submit');
  }

  protected getHeaderTitle(): string {
    return t('modal.draft.title');
  }

  protected getHeaderIcon(): string | undefined {
    return 'edit';
  }

  // 当前已有草稿代码块，可以跳过参数快速添加一笔空模板
  protected showSkip(): boolean {
    return true;
  }

  protected onSubmit(blockText: string): void {
    // 去掉围栏：拿到纯分录内文
    // 与 RecordTransactionModal 的处理方式保持一致（围栏后可能带 \n）
    const entryBody = blockText
      .replace(/^```[^\n]*\r?\n/, '')
      .replace(/\r?\n?```\r?\n?/, '')
      .trim();

    if (!entryBody) {
      new Notice(t('modal.draft.empty'));
      this.close();
      return;
    }

    void this.append(entryBody);
  }

  private async append(entryBody: string): Promise<void> {
    const file = this.sourceFile;
    const startPos = this.codeBlockStartPos;
    const endPos = this.codeBlockEndPos;

    // 防御：endPos 必须大于 startPos，且至少有闭合 ```（3 个字符）
    if (endPos - startPos < 7) {
      new Notice(t('beancount.addRecordFailed'));
      this.close();
      return;
    }

    const content = await this.app.vault.read(file);

    // 二次校验代码块位置仍然有效（防止打开弹窗期间文件被外部修改）
    if (endPos > content.length || content.slice(startPos, endPos).slice(-3) !== '```') {
      new Notice(t('beancount.addRecordFailed'));
      this.close();
      return;
    }

    // 在闭合 ``` 之前插入新分录：保证与块内其他分录以空行分隔
    const closeFenceStart = endPos - 3;
    const before = content.slice(0, closeFenceStart);
    const after = content.slice(closeFenceStart); // 从闭合 ``` 开始

    // before 通常以换行结尾；若 entryBody 不为空，紧贴插入并补换行
    const separator = before.endsWith('\n') ? '\n' : '\n\n';
    const newContent = `${before}${separator}${entryBody}\n${after}`;

    try {
      await this.app.vault.modify(file, newContent);
    } catch (e) {
      new Notice(t('modal.draft.error', { error: e instanceof Error ? e.message : String(e) }));
      this.close();
      return;
    }

    // 重新索引：Obsidian 在 modify 之后会触发 'modify' 事件被动增量索引，
    // 但为确保 finance-log 等视图立即反映新草稿，主动调一次同步刷新。
    await this.indexer.updateFile(file.path);

    new Notice(t('modal.draft.success'));
    this.close();
  }
}
