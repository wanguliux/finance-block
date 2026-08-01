/**
 * 汇总结转弹窗（Rollover Modal）
 *
 * 在账本 fin-beancount 块上点「汇总结转」后弹出，配置：
 *   - 新账本文件路径（默认建议 账本/账本-<年>.md）
 *   - 结转截止日（截至今天 / 截至本月末）
 * 提交后调用 rollover 服务，把余额承接进新账本、旧账本归档。
 */

import { App, Modal, Notice, Setting } from 'obsidian';
import { t } from '../i18n';
import { localDateString } from '../util/date';
import type { FinancePluginSettings } from '../settings/settings';
import type { Indexer } from '../ledger/indexer';
import { executeRollover } from '../ledger/rollover';

function defaultNewLedgerPath(current: string): string {
  const year = new Date().getFullYear();
  const folder = current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : '';
  return folder ? `${folder}/账本-${year}.md` : `账本-${year}.md`;
}

function endOfMonth(): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return localDateString(d);
}

export class RolloverModal extends Modal {
  private settings: FinancePluginSettings;
  private saveSettings: () => Promise<void>;
  private indexer: Indexer;

  constructor(
    app: App,
    settings: FinancePluginSettings,
    saveSettings: () => Promise<void>,
    indexer: Indexer,
  ) {
    super(app);
    this.settings = settings;
    this.saveSettings = saveSettings;
    this.indexer = indexer;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h3', { text: t('modal.rollover.title') });

    // ── 新账本路径 ──────────────────────────────────────
    let newLedgerPath = defaultNewLedgerPath(this.settings.ledgerPath);
    new Setting(contentEl)
      .setName(t('modal.rollover.newPath'))
      .setDesc(t('modal.rollover.newPath.desc'))
      .addText((text) =>
        text
          .setPlaceholder('账本/账本-2026.md')
          .setValue(newLedgerPath)
          .onChange((value) => {
            newLedgerPath = value;
          }),
      );

    // ── 结转截止日 ──────────────────────────────────────
    let cutoff = localDateString(new Date());
    new Setting(contentEl)
      .setName(t('modal.rollover.cutoff'))
      .setDesc(t('modal.rollover.cutoff.desc'))
      .addDropdown((dropdown) =>
        dropdown
          .addOption('today', t('modal.rollover.cutoff.today'))
          .addOption('monthEnd', t('modal.rollover.cutoff.monthEnd'))
          .setValue('today')
          .onChange((value) => {
            cutoff = value === 'monthEnd' ? endOfMonth() : localDateString(new Date());
          }),
      );

    // ── 提交 ────────────────────────────────────────────
    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText(t('modal.rollover.submit'))
        .setCta()
        .onClick(async () => {
          const result = await executeRollover(this.app, this.settings, this.saveSettings, this.indexer, {
            newLedgerPath,
            cutoffDate: cutoff,
          });
          if (result.success) {
            new Notice(
              t('modal.rollover.success', {
                newLedgerPath: result.newLedgerPath,
                oldLedgerPath: result.oldLedgerPath,
              }),
            );
            this.close();
          } else {
            new Notice(t('modal.rollover.error', { error: result.error || '' }));
          }
        }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
