/*
 * VaultFolderSuggestModal —— 模糊搜索选择 vault 中的文件夹
 * 继承 Obsidian 内置 FuzzySuggestModal<TFolder>，用于设置页选择账本文件夹。
 */

import { App, FuzzySuggestModal, TFolder } from 'obsidian';
import { t } from '../i18n';

export class VaultFolderSuggestModal extends FuzzySuggestModal<TFolder> {
  private onSelectCallback: (value: string) => void;

  constructor(app: App, onSelect: (value: string) => void) {
    super(app);
    this.onSelectCallback = onSelect;
    this.setPlaceholder(t('settings.selectFolder'));
  }

  getItems(): TFolder[] {
    return this.app.vault.getAllLoadedFiles().filter((file): file is TFolder => file instanceof TFolder);
  }

  getItemText(item: TFolder): string {
    return item.path || '/';
  }

  onChooseItem(item: TFolder): void {
    this.onSelectCallback(item.path || '');
  }
}
