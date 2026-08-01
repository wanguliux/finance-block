/*
 * InsertCodeBlockParamModal —— 「插入代码块」的参数配置弹窗
 *
 * 复用 EntryFormModal 的全部表单/校验/金额元→分逻辑（与「记一笔」「加入草稿」共用同一套），
 * 仅覆盖 onSubmit：把生成的代码块纯文本插入到当前编辑器光标处，而非入账或追加到草稿。
 */

import type { App } from 'obsidian';
import { MarkdownView, Notice } from 'obsidian';
import { t } from '../i18n';
import type { BlockDefinitionWithParams } from '../blockProvider';
import type { FinanceConfig } from '../types';
import { EntryFormModal } from './EntryFormModal';

export class InsertCodeBlockParamModal extends EntryFormModal {
  constructor(app: App, block: BlockDefinitionWithParams, config?: FinanceConfig) {
    super(app, block, config);
  }

  /** 提交按钮文案：点到光标处 */
  protected getSubmitLabel(): string {
    return t('modal.insert.param.insert');
  }

  /** 校验通过、收集完 values 后，把生成的代码块文本插入到当前笔记光标处 */
  protected onSubmit(blockText: string): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice(t('modal.insert.noEditor'));
      return;
    }
    const editor = view.editor;
    editor.replaceRange(blockText, editor.getCursor());
    new Notice(t('modal.insert.inserted'));
    this.close();
  }
}
