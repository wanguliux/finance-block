import { Modal, Notice, TFile } from 'obsidian';
import type FinancePlugin from '../main';
import type { FinanceConfig } from '../types';
import { t } from '../i18n';
import { localDateString } from '../util/date';

export class UpdateValuationModal extends Modal {
  private plugin: FinancePlugin;
  private preselectedAccount?: string;

  constructor(plugin: FinancePlugin, preselectedAccount?: string) {
    super(plugin.app);
    this.plugin = plugin;
    this.preselectedAccount = preselectedAccount;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('fb-modal');

    const config = this.plugin.config;

    contentEl.createEl('h2', { text: t('modal.valuation.title') });

    // Account selector
    const accountField = contentEl.createDiv(); accountField.addClass('fb-field');
    accountField.createEl('label', { text: t('modal.valuation.account') });
    const accountSelect = accountField.createEl('select', { cls: 'fb-input' });
    
    const assetAccounts = config.accounts.filter(a => a.class === 'asset');
    for (const acc of assetAccounts) {
      const label = acc.icon ? `${acc.icon} ${acc.name}` : acc.name;
      const opt = accountSelect.createEl('option', { text: label, value: acc.name });
      if (this.preselectedAccount && acc.name === this.preselectedAccount) {
        opt.selected = true;
      }
    }

    // Amount (yuan)
    const amountField = contentEl.createDiv(); amountField.addClass('fb-field');
    amountField.createEl('label', { text: t('modal.valuation.amount') });
    const amountInput = amountField.createEl('input', {
      type: 'number', cls: 'fb-input',
      placeholder: t('modal.valuation.amountPlaceholder'),
    });

    // Currency (optional)
    const currencyField = contentEl.createDiv(); currencyField.addClass('fb-field');
    currencyField.createEl('label', { text: t('modal.valuation.currency') });
    const currencySelect = currencyField.createEl('select', { cls: 'fb-input' });
    currencySelect.createEl('option', { text: config.baseCurrency + ' (' + t('common.default') + ')', value: '' });
    for (const cur of config.currencies) {
      if (cur.code === config.baseCurrency) continue;
      currencySelect.createEl('option', { text: `${cur.code} - ${cur.name}`, value: cur.code });
    }

    // Date (default today)
    const dateField = contentEl.createDiv(); dateField.addClass('fb-field');
    dateField.createEl('label', { text: t('modal.valuation.date') });
    const dateInput = dateField.createEl('input', { type: 'date', cls: 'fb-input' });
    dateInput.value = localDateString(new Date());

    // Comment (optional)
    const commentField = contentEl.createDiv(); commentField.addClass('fb-field');
    commentField.createEl('label', { text: t('modal.valuation.comment') });
    const commentInput = commentField.createEl('input', {
      type: 'text', cls: 'fb-input',
      placeholder: t('modal.valuation.commentPlaceholder'),
    });

    // Buttons
    const btnRow = contentEl.createDiv();
    btnRow.addClass('fb-btn-row');
    const cancelBtn = btnRow.createEl('button', { text: t('common.cancel') });
    cancelBtn.addClass('mod-muted');
    cancelBtn.addEventListener('click', () => this.close());
    const saveBtn = btnRow.createEl('button', { text: t('common.save') });
    saveBtn.addClass('mod-cta');
    saveBtn.addEventListener('click', () => {
      const account = accountSelect.value;
      const amountYuan = parseFloat(amountInput.value);
      if (!account || isNaN(amountYuan)) {
        new Notice(t('modal.valuation.amountRequired'));
        return;
      }
      const amountCents = Math.round(amountYuan * 100);
      const currency = currencySelect.value;
      const date = dateInput.value || localDateString(new Date());
      const comment = commentInput.value.trim();

      // Build the valuation line
      let line = `${date} custom "fb-valuation" ${account} ${amountCents}`;
      if (currency) line += ` ${currency}`;
      if (comment) line += `   ; ${comment}`;
      line += '\n';

      // Append to ledger file
      this.appendToLedger(line).then(() => {
        new Notice(t('modal.valuation.success', { ledgerPath: this.plugin.settings.ledgerPath }));
        this.close();
      }).catch((err: Error) => {
        new Notice(t('modal.valuation.error', { error: err.message }));
      });
    });
  }

  private async appendToLedger(line: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const ledgerPath = this.plugin.settings.ledgerPath;
    
    if (await adapter.exists(ledgerPath)) {
      const existing = await adapter.read(ledgerPath);
      // Ensure there's a newline before appending
      const separator = existing.endsWith('\n') ? '' : '\n';
      await adapter.write(ledgerPath, existing + separator + line);
    } else {
      const fileName = ledgerPath.split('/').pop()?.replace('.md', '') || '账本';
      const header = `# ${fileName}\n\n`;
      await adapter.write(ledgerPath, header + line);
    }

    // Trigger re-index
    await this.plugin.indexer.updateFile(ledgerPath);
  }

  onClose(): void { this.contentEl.empty(); }
}
