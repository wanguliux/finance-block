/**
 * 存档管理弹窗（Archive Manager Modal）
 *
 * 入口：设置页「账本文件路径」条目旁的「存档管理」按钮。
 *
 * 可视化 + 清理 archiveLedgers（汇总结转产生的旧账本归档列表）：
 *   - 列出每个归档账本路径，并标注文件是否存在
 *   - 「打开」：在 Obsidian 中打开该归档文件（文件存在时）
 *   - 「移出归档」：从 archiveLedgers 移除（仅从索引移除，不删除文件），随后重建索引
 *
 * 与 rollover 保持一致：archiveLedgers 是 settings 与 indexer 共享的同一数组引用
 * （见 main.ts 构造 Indexer 时的传参）。因此移除时原地 splice 修改，
 * indexer.fullScan() 即可读到最新列表——若重新赋值新数组，indexer 仍持有旧引用会失效。
 */

import { App, Modal, Notice, Setting, TFile } from 'obsidian';
import type FinancePlugin from '../main';
import { t } from '../i18n';
import { confirmWithModal } from './Confirm';

export class ArchiveManagerModal extends Modal {
  private plugin: FinancePlugin;
  private listEl!: HTMLDivElement;

  constructor(plugin: FinancePlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('fb-modal');

    contentEl.createEl('h2', { text: t('modal.archive.title') });
    contentEl.createEl('p', { text: t('modal.archive.desc'), cls: 'fb-meta' });

    this.listEl = contentEl.createDiv();
    this.listEl.addClass('fb-list');

    void this.renderList();

    const btnRow = contentEl.createDiv();
    btnRow.addClass('fb-btn-row');
    const closeBtn = btnRow.createEl('button', { text: t('common.close') });
    closeBtn.addClass('mod-muted');
    closeBtn.addEventListener('click', () => this.close());
  }

  private async renderList(): Promise<void> {
    this.listEl.empty();
    const archives = this.plugin.settings.archiveLedgers ?? [];

    if (archives.length === 0) {
      this.listEl.createEl('p', { text: t('modal.archive.empty') });
      return;
    }

    this.listEl.createEl('p', {
      text: t('modal.archive.count', { n: String(archives.length) }),
      cls: 'fb-meta',
    });

    for (const path of archives) {
      const setting = new Setting(this.listEl);
      setting.setName(path);

      const exists = await this.plugin.app.vault.adapter.exists(path);
      setting.setDesc(exists ? t('modal.archive.status.exists') : t('modal.archive.status.missing'));

      if (exists) {
        setting.addButton((btn) =>
          btn.setButtonText(t('modal.archive.open')).onClick(() => void this.openFile(path)),
        );
      }

      setting.addButton((btn) =>
        btn
          .setButtonText(t('modal.archive.remove'))
          .setClass('mod-destructive')
          .onClick(() => void this.remove(path)),
      );
    }
  }

  private async openFile(path: string): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.plugin.app.workspace.getLeaf(true).openFile(file);
      this.close();
    } else {
      new Notice(t('modal.archive.status.missing'));
    }
  }

  private async remove(path: string): Promise<void> {
    if (!(await confirmWithModal(this.app, t('modal.archive.confirmRemove', { path }), { warning: true }))) {
      return;
    }

    // 原地修改：archiveLedgers 是 settings 与 indexer 共享的同一数组引用（见 main.ts）。
    // 用 splice 而不是重新赋值，索引器才能看到最新列表。
    const arr = this.plugin.settings.archiveLedgers;
    const idx = arr.indexOf(path);
    if (idx >= 0) arr.splice(idx, 1);

    await this.plugin.saveSettings();
    await this.plugin.indexer.fullScan();

    new Notice(t('modal.archive.removed', { path }));
    await this.renderList();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
