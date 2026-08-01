import { Modal, Notice } from 'obsidian';
import type FinancePlugin from '../main';
import { t } from '../i18n';
import { confirmWithModal } from './Confirm';

/*
 * OwnerManagerModal —— "归属维度"管理弹窗。
 * 列出所有归属维度（含默认徽章），每条可「设为默认 / 编辑 / 删除」。
 * 点「新增归属」打开 OwnerEditModal（名称）。
 * 数据持久化在 vault 的 finance-config.json（FinanceConfig.owners + defaultOwner）。
 *
 * 注意：归属名是交易 owner 引用的身份，编辑时名称只读，避免改名造成悬空引用。
 */

export class OwnerManagerModal extends Modal {
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

    contentEl.createEl('h2', { text: t('modal.owners.title') });

    this.searchWrap = contentEl.createDiv();
    this.searchWrap.addClass('fb-search');
    const search = this.searchWrap.createEl('input', {
      type: 'text', cls: 'fb-input', placeholder: t('modal.owners.search'),
    });
    search.addEventListener('input', () => {
      this.searchQuery = search.value.trim().toLowerCase();
      this.renderOwners();
    });

    const topToolbar = contentEl.createDiv();
    topToolbar.addClass('fb-btn-row');
    topToolbar.setCssStyles({ justifyContent: 'flex-start' });
    const addBtn = topToolbar.createEl('button', { text: t('modal.owners.add') });
    addBtn.addClass('mod-cta');
    addBtn.addEventListener('click', () => this.openAdd());

    this.listContainer = contentEl.createDiv();
    this.listContainer.addClass('fb-list');

    this.renderOwners();

    const btnRow = contentEl.createDiv();
    btnRow.addClass('fb-btn-row');
    const closeBtn = btnRow.createEl('button', { text: t('common.close') });
    closeBtn.addClass('mod-muted');
    closeBtn.addEventListener('click', () => this.close());
  }

  private renderOwners(): void {
    this.listContainer.empty();
    const owners = this.getOwners();
    const def = this.plugin.config.defaultOwner;

    if (owners.length === 0) {
      this.listContainer.createEl('p', { text: t('modal.owners.noData') });
      return;
    }

    const q = this.searchQuery;
    const visible = q
      ? owners.filter((o) => o.toLowerCase().includes(q))
      : owners;

    if (visible.length === 0) {
      this.listContainer.createEl('p', { text: t('common.noMatch') });
      return;
    }

    for (const owner of visible) {
      const isDefault = owner === def;
      const row = this.listContainer.createDiv();
      row.addClass('fb-card');

      const infoCol = row.createDiv();
      infoCol.addClass('fb-info');

      const titleRow = infoCol.createDiv();
      titleRow.addClass('fb-title');
      titleRow.createSpan({ text: owner });
      if (isDefault) {
        const badge = titleRow.createSpan({ text: t('common.default') });
        badge.addClass('fb-badge');
      }
      infoCol.createDiv({ text: '', cls: 'fb-meta' });

      const btnCol = row.createDiv();
      btnCol.addClass('fb-actions');

      if (!isDefault) {
        const setDefaultBtn = btnCol.createEl('button', { text: t('modal.owners.setDefault') });
        setDefaultBtn.addClass('fb-default-btn');
        setDefaultBtn.addEventListener('click', () => void this.setDefault(owner));
      }

      const editBtn = btnCol.createEl('button', { text: t('common.edit') });
      editBtn.addClass('fb-action-btn');
      editBtn.addEventListener('click', () => this.openEdit(owner));

      const deleteBtn = btnCol.createEl('button', { text: t('common.delete') });
      deleteBtn.addClass('fb-danger-btn');
      if (isDefault) {
        deleteBtn.disabled = true;
      } else {
        deleteBtn.addEventListener('click', () => void this.delete(owner));
      }
    }
  }

  private openAdd(): void {
    const editModal = new OwnerEditModal(this.plugin);
    editModal.onClose = () => void this.refresh();
    editModal.open();
  }

  private openEdit(name: string): void {
    const editModal = new OwnerEditModal(this.plugin, { editName: name });
    editModal.onClose = () => void this.refresh();
    editModal.open();
  }

  private async setDefault(name: string): Promise<void> {
    if (name === this.plugin.config.defaultOwner) return;
    this.plugin.config.defaultOwner = name;
    await this.save();
    await this.refresh();
  }

  private async delete(name: string): Promise<void> {
    if (name === this.plugin.config.defaultOwner) {
      new Notice(t('modal.owners.cannotDeleteDefault'));
      return;
    }
    if (!(await confirmWithModal(this.app, t('modal.owners.confirmDelete', { name })))) {
      return;
    }
    this.plugin.config.owners = this.plugin.config.owners.filter((o) => o !== name);
    await this.save();
    new Notice(t('modal.owners.deleted'));
    await this.refresh();
  }

  private async refresh(): Promise<void> { this.renderOwners(); }
  private getOwners(): string[] { return this.plugin.config.owners ?? []; }
  private async save(): Promise<void> { await this.plugin.configManager.save(); }

  onClose(): void { this.contentEl.empty(); }
}

interface OwnerEditModalOptions { editName?: string; }

class OwnerEditModal extends Modal {
  private plugin: FinancePlugin;
  private options: OwnerEditModalOptions;
  private nameInput!: HTMLInputElement;

  constructor(plugin: FinancePlugin, options: OwnerEditModalOptions = {}) {
    super(plugin.app);
    this.plugin = plugin;
    this.options = options;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('fb-modal');

    const editOwner = this.options.editName
      ? this.plugin.config.owners.find((o) => o === this.options.editName)
      : undefined;

    contentEl.createEl('h2', {
      text: editOwner ? t('modal.owners.editTitle') : t('modal.owners.newTitle'),
    });

    const nameField = contentEl.createDiv(); nameField.addClass('fb-field');
    nameField.createEl('label', { text: t('modal.owners.name') });
    this.nameInput = nameField.createEl('input', {
      type: 'text', cls: 'fb-input', placeholder: t('modal.owners.namePlaceholder'),
    });
    if (editOwner) { this.nameInput.value = editOwner; this.nameInput.disabled = true; }

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
    if (!name) { new Notice(t('modal.owners.nameRequired')); return; }

    const owners = this.plugin.config.owners;
    if (!this.options.editName) {
      if (owners.includes(name)) { new Notice(t('modal.owners.nameDuplicate')); return; }
      owners.push(name);
    }
    // 编辑：名称只读，无需更新
    await this.plugin.configManager.save();
    new Notice(t('modal.owners.saved'));
    this.close();
  }

  onClose(): void { this.contentEl.empty(); }
}
