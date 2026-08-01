import { Modal, Notice } from 'obsidian';
import type FinancePlugin from '../main';
import type { TransactionTypeDef } from '../types';
import { t } from '../i18n';
import { confirmWithModal } from './Confirm';

/*
 * TypeManagerModal —— "交易类型"管理弹窗。
 * 列出所有交易类型（含收支方向徽章 + 自定义字段数），每条可「编辑 / 删除」。
 * 点「新增类型」打开 TypeEditModal（名称 / 方向 / 自定义字段）。
 * 数据持久化在 vault 的 finance-config.json（FinanceConfig.transactionTypes）。
 *
 * 注意：类型名是交易 txnType 引用的身份，编辑时名称只读，避免改名造成悬空引用。
 */

export class TypeManagerModal extends Modal {
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

    contentEl.createEl('h2', { text: t('modal.transactionTypes.title') });

    this.searchWrap = contentEl.createDiv();
    this.searchWrap.addClass('fb-search');
    const search = this.searchWrap.createEl('input', {
      type: 'text', cls: 'fb-input', placeholder: t('modal.transactionTypes.search'),
    });
    search.addEventListener('input', () => {
      this.searchQuery = search.value.trim().toLowerCase();
      this.renderTypes();
    });

    const topToolbar = contentEl.createDiv();
    topToolbar.addClass('fb-btn-row');
    topToolbar.setCssStyles({ justifyContent: 'flex-start' });
    const addBtn = topToolbar.createEl('button', { text: t('modal.transactionTypes.add') });
    addBtn.addClass('mod-cta');
    addBtn.addEventListener('click', () => this.openAdd());

    this.listContainer = contentEl.createDiv();
    this.listContainer.addClass('fb-list');

    this.renderTypes();

    const btnRow = contentEl.createDiv();
    btnRow.addClass('fb-btn-row');
    const closeBtn = btnRow.createEl('button', { text: t('common.close') });
    closeBtn.addClass('mod-muted');
    closeBtn.addEventListener('click', () => this.close());
  }

  private renderTypes(): void {
    this.listContainer.empty();
    const types = this.getTypes();

    if (types.length === 0) {
      this.listContainer.createEl('p', { text: t('modal.transactionTypes.noData') });
      return;
    }

    const q = this.searchQuery;
    const visible = q
      ? types.filter((ty) => ty.name.toLowerCase().includes(q))
      : types;

    if (visible.length === 0) {
      this.listContainer.createEl('p', { text: t('common.noMatch') });
      return;
    }

    for (const ty of visible) {
      const row = this.listContainer.createDiv();
      row.addClass('fb-card');

      const infoCol = row.createDiv();
      infoCol.addClass('fb-info');

      const titleRow = infoCol.createDiv();
      titleRow.addClass('fb-title');
      titleRow.createSpan({ text: ty.name });

      const badge = titleRow.createSpan({
        text: ty.direction === 'income'
          ? t('modal.transactionTypes.direction.income')
          : t('modal.transactionTypes.direction.expense'),
      });
      badge.addClass('fb-badge');

      const fieldCount = ty.customFields?.length ?? 0;
      infoCol.createDiv({
        text: fieldCount > 0 ? `${fieldCount} 个自定义字段` : '无自定义字段',
        cls: 'fb-meta',
      });

      const btnCol = row.createDiv();
      btnCol.addClass('fb-actions');

      const editBtn = btnCol.createEl('button', { text: t('common.edit') });
      editBtn.addClass('fb-action-btn');
      editBtn.addEventListener('click', () => this.openEdit(ty.name));

      const deleteBtn = btnCol.createEl('button', { text: t('common.delete') });
      deleteBtn.addClass('fb-danger-btn');
      deleteBtn.addEventListener('click', () => void this.delete(ty.name));
    }
  }

  private openAdd(): void {
    const editModal = new TypeEditModal(this.plugin);
    editModal.onClose = () => void this.refresh();
    editModal.open();
  }

  private openEdit(name: string): void {
    const editModal = new TypeEditModal(this.plugin, { editName: name });
    editModal.onClose = () => void this.refresh();
    editModal.open();
  }

  private async delete(name: string): Promise<void> {
    if (!(await confirmWithModal(this.app, t('modal.transactionTypes.confirmDelete', { name })))) {
      return;
    }
    this.plugin.config.transactionTypes = this.plugin.config.transactionTypes.filter((ty) => ty.name !== name);
    await this.save();
    new Notice(t('modal.transactionTypes.deleted'));
    await this.refresh();
  }

  private async refresh(): Promise<void> { this.renderTypes(); }
  private getTypes(): TransactionTypeDef[] { return this.plugin.config.transactionTypes ?? []; }
  private async save(): Promise<void> { await this.plugin.configManager.save(); }

  onClose(): void { this.contentEl.empty(); }
}

interface TypeEditModalOptions { editName?: string; }

class TypeEditModal extends Modal {
  private plugin: FinancePlugin;
  private options: TypeEditModalOptions;
  private nameInput!: HTMLInputElement;
  private directionSelect!: HTMLSelectElement;
  private fieldsInput!: HTMLInputElement;

  constructor(plugin: FinancePlugin, options: TypeEditModalOptions = {}) {
    super(plugin.app);
    this.plugin = plugin;
    this.options = options;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('fb-modal');

    const editType = this.options.editName
      ? this.plugin.config.transactionTypes.find((ty) => ty.name === this.options.editName)
      : undefined;

    contentEl.createEl('h2', {
      text: editType ? t('modal.transactionTypes.editTitle') : t('modal.transactionTypes.newTitle'),
    });

    // 名称（新增可填；编辑只读——类型名是交易引用的身份）
    const nameField = contentEl.createDiv(); nameField.addClass('fb-field');
    nameField.createEl('label', { text: t('modal.transactionTypes.name') });
    this.nameInput = nameField.createEl('input', {
      type: 'text', cls: 'fb-input', placeholder: t('modal.transactionTypes.namePlaceholder'),
    });
    if (editType) { this.nameInput.value = editType.name; this.nameInput.disabled = true; }

    // 方向（收入 / 支出）
    const dirField = contentEl.createDiv(); dirField.addClass('fb-field');
    dirField.createEl('label', { text: t('modal.transactionTypes.direction') });
    this.directionSelect = dirField.createEl('select', { cls: 'fb-input' });
    const incomeOpt = this.directionSelect.createEl('option', {
      text: t('modal.transactionTypes.direction.income'), value: 'income',
    });
    this.directionSelect.createEl('option', {
      text: t('modal.transactionTypes.direction.expense'), value: 'expense',
    });
    if (editType) {
      this.directionSelect.value = editType.direction;
      if (editType.direction === 'income') incomeOpt.selected = true;
    } else {
      incomeOpt.selected = true;
    }

    // 自定义字段（逗号分隔）
    const fieldsField = contentEl.createDiv(); fieldsField.addClass('fb-field');
    fieldsField.createEl('label', { text: t('modal.transactionTypes.customFields') });
    this.fieldsInput = fieldsField.createEl('input', {
      type: 'text', cls: 'fb-input', placeholder: t('modal.transactionTypes.customFieldsPlaceholder'),
    });
    if (editType && editType.customFields) this.fieldsInput.value = editType.customFields.join(', ');

    const btnRow = contentEl.createDiv();
    btnRow.addClass('fb-btn-row');
    const cancelBtn = btnRow.createEl('button', { text: t('common.cancel') });
    cancelBtn.addClass('mod-muted');
    cancelBtn.addEventListener('click', () => this.close());
    const saveBtn = btnRow.createEl('button', { text: t('common.save') });
    saveBtn.addClass('mod-cta');
    saveBtn.addEventListener('click', () => void this.save());
  }

  private async save(): Promise<void> {
    const name = this.nameInput.value.trim();
    if (!name) { new Notice(t('modal.transactionTypes.nameRequired')); return; }
    const direction = (this.directionSelect.value || 'expense') as 'income' | 'expense';
    const customFields = this.fieldsInput.value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const types = this.plugin.config.transactionTypes;
    if (!this.options.editName) {
      if (types.some((ty) => ty.name === name)) { new Notice(t('modal.transactionTypes.nameDuplicate')); return; }
      types.push({ name, direction, customFields: customFields.length ? customFields : undefined });
    } else {
      const target = types.find((ty) => ty.name === this.options.editName);
      if (target) {
        target.direction = direction;
        target.customFields = customFields.length ? customFields : undefined;
      }
    }
    await this.plugin.configManager.save();
    new Notice(t('modal.transactionTypes.saved'));
    this.close();
  }

  onClose(): void { this.contentEl.empty(); }
}
