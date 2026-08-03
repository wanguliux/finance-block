import { Modal, Notice } from 'obsidian';
import type FinancePlugin from '../main';
import type { CurrencyDef } from '../types';
import { t } from '../i18n';
import { confirmWithModal } from './Confirm';

/*
 * CurrencyManagerModal —— "币种与汇率"管理弹窗。
 * 打开后列出所有币种（含默认币种），每条可「设为默认 / 编辑 / 删除」。
 * 点「新增币种」打开 CurrencyEditModal 编辑单个币种（代码 / 名称 / 符号 / 汇率）。
 * 数据持久化在 vault 的 finance-config.json（FinanceConfig.currencies + baseCurrency）。
 */

export class CurrencyManagerModal extends Modal {
  private plugin: FinancePlugin;
  private listContainer!: HTMLDivElement;
  private searchWrap!: HTMLDivElement;
  private searchQuery = '';

  constructor(plugin: FinancePlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('fb-modal');

    contentEl.createEl('h2', { text: t('modal.currency.title') });

    // 顶部搜索框（吸顶）：按代码 / 名称实时过滤。
    this.searchWrap = contentEl.createDiv();
    this.searchWrap.addClass('fb-search');
    const search = this.searchWrap.createEl('input', {
      type: 'text',
      cls: 'fb-input',
      placeholder: t('modal.currency.search'),
    });
    search.addEventListener('input', () => {
      this.searchQuery = search.value.trim().toLowerCase();
      this.renderCurrencies();
    });

    // 顶部工具栏：新增币种。
    const topToolbar = contentEl.createDiv();
    topToolbar.addClass('fb-btn-row');
    topToolbar.setCssStyles({ justifyContent: 'flex-start' });
    const addBtn = topToolbar.createEl('button', { text: t('modal.currency.add') });
    addBtn.addClass('mod-cta');
    addBtn.addEventListener('click', () => this.openAddCurrency());

    this.listContainer = contentEl.createDiv();
    this.listContainer.addClass('fb-list');

    this.renderCurrencies();

    // 底部按钮行：关闭。
    const btnRow = contentEl.createDiv();
    btnRow.addClass('fb-btn-row');
    const closeBtn = btnRow.createEl('button', { text: t('common.close') });
    closeBtn.addClass('mod-muted');
    closeBtn.addEventListener('click', () => this.close());
  }

  // 渲染币种列表：无数据显示空提示，否则逐条画出名称、符号、代码、汇率与操作按钮。
  private renderCurrencies(): void {
    this.listContainer.empty();

    const currencies = this.getCurrencies();
    const base = this.plugin.config.baseCurrency;

    if (currencies.length === 0) {
      this.listContainer.createEl('p', { text: t('modal.currency.noData') });
      return;
    }

    const q = this.searchQuery;
    const visible = currencies.filter((c) => {
      if (!q) return true;
      return (
        c.code.toLowerCase().includes(q) ||
        (c.name || '').toLowerCase().includes(q) ||
        (c.symbol || '').toLowerCase().includes(q)
      );
    });

    if (visible.length === 0) {
      this.listContainer.createEl('p', { text: t('common.noMatch') });
      return;
    }

    for (const currency of visible) {
      const isBase = currency.code === base;
      const row = this.listContainer.createDiv();
      row.addClass('fb-card');

      const infoCol = row.createDiv();
      infoCol.addClass('fb-info');

      const titleRow = infoCol.createDiv();
      titleRow.addClass('fb-title');
      titleRow.createSpan({ text: `${currency.symbol || currency.code} ${currency.name || currency.code}` });
      if (isBase) {
        const badge = titleRow.createSpan({ text: t('common.default') });
        badge.addClass('fb-badge');
      }

      const metaLines = [
        `code: ${currency.code}`,
        isBase
          ? t('modal.currency.baseRateFixed')
          : t('modal.currency.rateHint', {
              base,
              code: currency.code,
              rate: String(currency.rate ?? 1),
            }),
      ];
      for (const line of metaLines) {
        infoCol.createDiv({ text: line, cls: 'fb-meta' });
      }

      const btnCol = row.createDiv();
      btnCol.addClass('fb-actions');

      // 设为默认（默认币种本身不显示）
      if (!isBase) {
        const setDefaultBtn = btnCol.createEl('button', { text: t('modal.currency.setDefault') });
        setDefaultBtn.addClass('fb-default-btn');
        setDefaultBtn.addEventListener('click', () => void this.setDefaultCurrency(currency.code));
      }

      const editBtn = btnCol.createEl('button', { text: t('common.edit') });
      editBtn.addClass('fb-action-btn');
      editBtn.addEventListener('click', () => this.openEditCurrency(currency.code));

      const deleteBtn = btnCol.createEl('button', { text: t('common.delete') });
      deleteBtn.addClass('fb-danger-btn');
      if (isBase) {
        // 默认币种不可删除（也不可直接删，需先「设为默认」别的币种）
        deleteBtn.disabled = true;
      } else {
        deleteBtn.addEventListener('click', () => void this.deleteCurrency(currency.code));
      }
    }
  }

  private openAddCurrency(): void {
    const editModal = new CurrencyEditModal(this.plugin);
    editModal.onClose = () => {
      void this.refresh();
    };
    editModal.open();
  }

  private openEditCurrency(code: string): void {
    const editModal = new CurrencyEditModal(this.plugin, { editCode: code });
    editModal.onClose = () => {
      void this.refresh();
    };
    editModal.open();
  }

  // 设某币种为默认：以新基准重新折算所有汇率，保证报表口径一致。
  private async setDefaultCurrency(code: string): Promise<void> {
    const config = this.plugin.config;
    const oldBase = config.baseCurrency;
    if (code === oldBase) return;

    const newBaseOldRate = this.rateOf(code); // 新基准相对旧基准的汇率
    for (const c of config.currencies) {
      if (c.code === code) {
        c.rate = 1;
        continue;
      }
      const oldRate = this.rateOf(c.code);
      // 新汇率 = 旧汇率 / 新基准旧汇率（保留 6 位精度）
      c.rate = newBaseOldRate > 0 ? Math.round((oldRate / newBaseOldRate) * 1e6) / 1e6 : oldRate;
    }
    config.baseCurrency = code;
    await this.save();
    new Notice(t('modal.currency.rebased'));
    await this.refresh();
  }

  private async deleteCurrency(code: string): Promise<void> {
    const config = this.plugin.config;
    if (code === config.baseCurrency) {
      new Notice(t('modal.currency.cannotDeleteDefault'));
      return;
    }

    const currency = config.currencies.find((c) => c.code === code);
    const label = currency ? currency.name || currency.code : code;
    if (!(await confirmWithModal(this.app, t('modal.currency.confirmDelete', { name: label, code })))) {
      return;
    }

    config.currencies = config.currencies.filter((c) => c.code !== code);
    await this.save();
    new Notice(t('modal.currency.deleted'));
    await this.refresh();
  }

  // 重新读取配置并刷新列表。
  private async refresh(): Promise<void> {
    this.renderCurrencies();
  }

  private getCurrencies(): CurrencyDef[] {
    return this.plugin.config.currencies ?? [];
  }

  private rateOf(code: string): number {
    const c = this.getCurrencies().find((x) => x.code === code);
    return c?.rate ?? 1;
  }

  private async save(): Promise<void> {
    await this.plugin.configManager.save();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/*
 * CurrencyEditModal —— "新增 / 编辑币种"弹窗。
 * 字段：代码（必填、唯一、编辑时只读）、名称（必填）、符号、汇率（相对默认币种）。
 * 默认币种的汇率固定为 1，编辑时禁用汇率输入。
 */
interface CurrencyEditModalOptions {
  editCode?: string; // 省略 = 新增模式
}

class CurrencyEditModal extends Modal {
  private plugin: FinancePlugin;
  private options: CurrencyEditModalOptions;
  private codeInput!: HTMLInputElement;
  private nameInput!: HTMLInputElement;
  private symbolInput!: HTMLInputElement;
  private rateInput!: HTMLInputElement;
  private isBase = false;

  constructor(plugin: FinancePlugin, options: CurrencyEditModalOptions = {}) {
    super(plugin.app);
    this.plugin = plugin;
    this.options = options;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('fb-modal');

    const editCurrency = this.options.editCode
      ? this.plugin.config.currencies.find((c) => c.code === this.options.editCode)
      : undefined;
    this.isBase = !!editCurrency && editCurrency.code === this.plugin.config.baseCurrency;

    contentEl.createEl('h2', {
      text: editCurrency ? t('modal.currency.editTitle') : t('modal.currency.newTitle'),
    });

    // 代码
    const codeField = contentEl.createDiv();
    codeField.addClass('fb-field');
    codeField.createEl('label', { text: t('modal.currency.code') });
    this.codeInput = codeField.createEl('input', {
      type: 'text',
      cls: 'fb-input',
      placeholder: t('modal.currency.codePlaceholder'),
    });
    if (editCurrency) {
      this.codeInput.value = editCurrency.code;
      this.codeInput.disabled = true; // 编辑时代码不可改，避免引用关系错乱
    }

    // 名称
    const nameField = contentEl.createDiv();
    nameField.addClass('fb-field');
    nameField.createEl('label', { text: t('modal.currency.name') });
    this.nameInput = nameField.createEl('input', {
      type: 'text',
      cls: 'fb-input',
      placeholder: t('modal.currency.namePlaceholder'),
    });
    if (editCurrency) this.nameInput.value = editCurrency.name;

    // 符号
    const symbolField = contentEl.createDiv();
    symbolField.addClass('fb-field');
    symbolField.createEl('label', { text: t('modal.currency.symbol') });
    this.symbolInput = symbolField.createEl('input', {
      type: 'text',
      cls: 'fb-input',
      placeholder: t('modal.currency.symbolPlaceholder'),
    });
    if (editCurrency) this.symbolInput.value = editCurrency.symbol;

    // 汇率
    const rateField = contentEl.createDiv();
    rateField.addClass('fb-field');
    rateField.createEl('label', { text: t('modal.currency.rate') });
    this.rateInput = rateField.createEl('input', {
      type: 'number',
      cls: 'fb-input',
      placeholder: t('modal.currency.ratePlaceholder'),
    });
    if (this.isBase) {
      this.rateInput.value = '1';
      this.rateInput.disabled = true; // 默认币种汇率固定 1
    } else if (editCurrency) {
      this.rateInput.value = String(editCurrency.rate ?? 1);
    } else {
      this.rateInput.value = '1';
    }

    // 底部按钮行：取消 + 保存
    const btnRow = contentEl.createDiv();
    btnRow.addClass('fb-btn-row');
    const cancelBtn = btnRow.createEl('button', { text: t('common.cancel') });
    cancelBtn.addClass('mod-muted');
    cancelBtn.addEventListener('click', () => this.close());

    const saveBtn = btnRow.createEl('button', { text: t('common.save') });
    saveBtn.addClass('mod-cta');
    saveBtn.addEventListener('click', () => {
      void this.save().catch((err) => {
        console.error('[finance-block] save currency failed:', err);
        new Notice(t('common.saveFailed'));
      });
    });
  }

  private async save(): Promise<void> {
    const code = this.codeInput.value.trim().toUpperCase();
    if (!code) {
      new Notice(t('modal.currency.codeRequired'));
      return;
    }
    const name = this.nameInput.value.trim();
    if (!name) {
      new Notice(t('modal.currency.nameRequired'));
      return;
    }
    const symbol = this.symbolInput.value.trim() || code;
    const rateRaw = parseFloat(this.rateInput.value);
    const rate = Number.isFinite(rateRaw) && rateRaw > 0 ? rateRaw : 1;

    const currencies = this.plugin.config.currencies;
    if (!this.options.editCode) {
      // 新增：检查代码重复
      if (currencies.some((c) => c.code === code)) {
        new Notice(t('modal.currency.codeDuplicate'));
        return;
      }
      currencies.push({ code, name, symbol, rate });
    } else {
      // 编辑：代码不可改，仅更新名称 / 符号 / 汇率
      const target = currencies.find((c) => c.code === this.options.editCode);
      if (target) {
        target.name = name;
        target.symbol = symbol;
        if (!this.isBase) target.rate = rate;
      }
    }

    await this.plugin.configManager.save();
    new Notice(t('modal.currency.saved'));
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
