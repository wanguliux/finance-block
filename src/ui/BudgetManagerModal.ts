import { Modal, Notice } from 'obsidian';
import type FinancePlugin from '../main';
import type { AmountInCents, BudgetDef, BudgetPeriod } from '../types';
import { t, formatBudgetPeriod } from '../i18n';
import { confirmWithModal } from './Confirm';
import { currencySymbol, buildSymbolMap } from '../engine/fx';

/*
 * BudgetManagerModal —— "预算管理"弹窗。
 * 列出所有预算计划（计划名称 + 关联交易类型徽章 + 金额），每条可「编辑 / 删除」。
 * 点「新增预算」打开 BudgetEditModal（计划名称 / 关联交易类型 / 预算金额）。
 * 数据持久化在 vault 的 finance-config.json（FinanceConfig.budgets）。
 *
 * 预算通过 type 关联到预算视图的分类：预算视图按交易类型匹配，多个计划可累加。
 * 计划名称是编辑时的只读键（避免改名后预算视图匹配错乱）。
 */

export class BudgetManagerModal extends Modal {
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

    contentEl.createEl('h2', { text: t('modal.budget.title') });

    // 顶部搜索框：按计划名称 / 交易类型实时过滤。
    this.searchWrap = contentEl.createDiv();
    this.searchWrap.addClass('fb-search');
    const search = this.searchWrap.createEl('input', {
      type: 'text', cls: 'fb-input', placeholder: t('modal.budget.search'),
    });
    search.addEventListener('input', () => {
      this.searchQuery = search.value.trim().toLowerCase();
      this.renderBudgets();
    });

    const topToolbar = contentEl.createDiv();
    topToolbar.addClass('fb-btn-row');
    topToolbar.setCssStyles({ justifyContent: 'flex-start' });
    const addBtn = topToolbar.createEl('button', { text: t('modal.budget.add') });
    addBtn.addClass('mod-cta');
    addBtn.addEventListener('click', () => this.openAdd());

    this.listContainer = contentEl.createDiv();
    this.listContainer.addClass('fb-list');

    this.renderBudgets();

    const btnRow = contentEl.createDiv();
    btnRow.addClass('fb-btn-row');
    const closeBtn = btnRow.createEl('button', { text: t('common.close') });
    closeBtn.addClass('mod-muted');
    closeBtn.addEventListener('click', () => this.close());
  }

  private renderBudgets(): void {
    this.listContainer.empty();
    const budgets = this.getBudgets();

    if (budgets.length === 0) {
      this.listContainer.createEl('p', { text: t('modal.budget.noData') });
      return;
    }

    const q = this.searchQuery;
    const visible = q
      ? budgets.filter((b) => (b.name + ' ' + b.type).toLowerCase().includes(q))
      : budgets;

    if (visible.length === 0) {
      this.listContainer.createEl('p', { text: t('common.noMatch') });
      return;
    }

    const symbol = this.baseSymbol();
    for (const budget of visible) {
      const row = this.listContainer.createDiv();
      row.addClass('fb-card');

      const infoCol = row.createDiv();
      infoCol.addClass('fb-info');

      const titleRow = infoCol.createDiv();
      titleRow.addClass('fb-title');
      titleRow.createSpan({ text: budget.name });
      const badge = titleRow.createSpan({ text: budget.type });
      badge.addClass('fb-badge');

      const yuan = (budget.amount ?? 0) / 100;
      const periodLabel = formatBudgetPeriod(budget.period ?? 'month', budget.periodDays);
      infoCol.createDiv({ text: `${symbol}${yuan.toFixed(2)} · ${periodLabel}`, cls: 'fb-meta' });

      const btnCol = row.createDiv();
      btnCol.addClass('fb-actions');

      const editBtn = btnCol.createEl('button', { text: t('common.edit') });
      editBtn.addClass('fb-action-btn');
      editBtn.addEventListener('click', () => this.openEdit(budget.name));

      const deleteBtn = btnCol.createEl('button', { text: t('common.delete') });
      deleteBtn.addClass('fb-danger-btn');
      deleteBtn.addEventListener('click', () => void this.delete(budget.name));
    }
  }

  private openAdd(): void {
    const editModal = new BudgetEditModal(this.plugin);
    editModal.onClose = () => void this.refresh();
    editModal.open();
  }

  private openEdit(name: string): void {
    const editModal = new BudgetEditModal(this.plugin, { editName: name });
    editModal.onClose = () => void this.refresh();
    editModal.open();
  }

  private async delete(name: string): Promise<void> {
    const budget = this.plugin.config.budgets.find((b) => b.name === name);
    const label = budget ? budget.name : name;
    if (!(await confirmWithModal(this.app, t('modal.budget.confirmDelete', { name: label })))) {
      return;
    }
    this.plugin.config.budgets = this.plugin.config.budgets.filter((b) => b.name !== name);
    await this.save();
    new Notice(t('modal.budget.deleted'));
    await this.refresh();
  }

  private async refresh(): Promise<void> { this.renderBudgets(); }
  private getBudgets(): BudgetDef[] { return this.plugin.config.budgets ?? []; }
  private baseSymbol(): string {
    const base = this.plugin.config.baseCurrency ?? 'CNY';
    return currencySymbol(base, buildSymbolMap(this.plugin.config.currencies));
  }
  private async save(): Promise<void> { await this.plugin.configManager.save(); }

  onClose(): void { this.contentEl.empty(); }
}

interface BudgetEditModalOptions { editName?: string; }

class BudgetEditModal extends Modal {
  private plugin: FinancePlugin;
  private options: BudgetEditModalOptions;
  private nameInput!: HTMLInputElement;
  private typeSelect!: HTMLSelectElement;
  private amountInput!: HTMLInputElement;
  private periodSelect!: HTMLSelectElement;
  private periodDaysInput!: HTMLInputElement;
  private periodDaysField!: HTMLDivElement;

  constructor(plugin: FinancePlugin, options: BudgetEditModalOptions = {}) {
    super(plugin.app);
    this.plugin = plugin;
    this.options = options;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('fb-modal');

    const editBudget = this.options.editName
      ? this.plugin.config.budgets.find((b) => b.name === this.options.editName)
      : undefined;

    contentEl.createEl('h2', {
      text: editBudget ? t('modal.budget.editTitle') : t('modal.budget.newTitle'),
    });

    // 计划名称（新增可填；编辑只读——名称是预算视图按类型匹配的引用身份）
    const nameField = contentEl.createDiv();
    nameField.addClass('fb-field');
    nameField.createEl('label', { text: t('modal.budget.name') });
    this.nameInput = nameField.createEl('input', {
      type: 'text', cls: 'fb-input', placeholder: t('modal.budget.namePlaceholder'),
    });
    if (editBudget) {
      this.nameInput.value = editBudget.name;
      this.nameInput.disabled = true;
    }

    // 关联交易类型（下拉自配置的交易类型）
    const typeField = contentEl.createDiv();
    typeField.addClass('fb-field');
    typeField.createEl('label', { text: t('modal.budget.type') });
    this.typeSelect = typeField.createEl('select', { cls: 'fb-input' });
    this.typeSelect.createEl('option', { text: t('modal.budget.typePlaceholder'), value: '' });
    for (const tt of this.plugin.config.transactionTypes) {
      const opt = this.typeSelect.createEl('option', { text: tt.name, value: tt.name });
      if (editBudget && editBudget.type === tt.name) opt.selected = true;
    }
    if (editBudget && editBudget.type) this.typeSelect.value = editBudget.type;

    // 预算金额（元，保存时折算为分）
    const amountField = contentEl.createDiv();
    amountField.addClass('fb-field');
    amountField.createEl('label', { text: t('modal.budget.amount') });
    this.amountInput = amountField.createEl('input', {
      type: 'number', cls: 'fb-input', placeholder: t('modal.budget.amountPlaceholder'),
    });
    if (editBudget) this.amountInput.value = String((editBudget.amount ?? 0) / 100);

    // 预算周期（每日 / 每周 / 每月 / 每年 / 自定义 N 日）
    const periodField = contentEl.createDiv();
    periodField.addClass('fb-field');
    periodField.createEl('label', { text: t('modal.budget.period') });
    this.periodSelect = periodField.createEl('select', { cls: 'fb-input' });
    for (const [value, labelKey] of [
      ['day', 'budget.period.day'],
      ['week', 'budget.period.week'],
      ['month', 'budget.period.month'],
      ['year', 'budget.period.year'],
      ['custom', 'modal.budget.periodCustom'],
    ] as const) {
      const opt = this.periodSelect.createEl('option', { text: t(labelKey), value });
      if (editBudget && (editBudget.period ?? 'month') === value) opt.selected = true;
    }
    if (editBudget && editBudget.period) this.periodSelect.value = editBudget.period;
    this.periodSelect.addEventListener('change', () => this.togglePeriodDays());

    // 周期天数（仅 period === 'custom' 时显示）
    this.periodDaysField = contentEl.createDiv();
    this.periodDaysField.addClass('fb-field');
    this.periodDaysField.createEl('label', { text: t('modal.budget.periodDays') });
    this.periodDaysInput = this.periodDaysField.createEl('input', {
      type: 'number', cls: 'fb-input', placeholder: t('modal.budget.periodDaysPlaceholder'),
    });
    if (editBudget && editBudget.periodDays != null) {
      this.periodDaysInput.value = String(editBudget.periodDays);
    }
    this.togglePeriodDays();

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
    if (!name) { new Notice(t('modal.budget.nameRequired')); return; }

    const type = this.typeSelect.value;
    if (!type) { new Notice(t('modal.budget.typeRequired')); return; }

    const amountRaw = parseFloat(this.amountInput.value);
    if (!Number.isFinite(amountRaw) || amountRaw <= 0) {
      new Notice(t('modal.budget.amountRequired'));
      return;
    }
    const amount = Math.round(amountRaw * 100) as AmountInCents; // 元 → 分

    const period = (this.periodSelect.value || 'month') as BudgetPeriod;
    let periodDays: number | undefined;
    if (period === 'custom') {
      const n = parseInt(this.periodDaysInput.value, 10);
      if (!Number.isFinite(n) || n <= 0) {
        new Notice(t('modal.budget.periodDaysRequired'));
        return;
      }
      periodDays = n;
    }

    const budgets = this.plugin.config.budgets;
    if (!this.options.editName) {
      if (budgets.some((b) => b.name === name)) { new Notice(t('modal.budget.nameDuplicate')); return; }
      budgets.push({ name, type, amount, period, periodDays });
    } else {
      const target = budgets.find((b) => b.name === this.options.editName);
      if (target) {
        // 名称只读：仅更新关联交易类型、金额与周期
        target.type = type;
        target.amount = amount;
        target.period = period;
        target.periodDays = periodDays;
      }
    }

    await this.plugin.configManager.save();
    new Notice(t('modal.budget.saved'));
    this.close();
  }

  private togglePeriodDays(): void {
    const isCustom = this.periodSelect.value === 'custom';
    this.periodDaysField.style.display = isCustom ? '' : 'none';
  }

  onClose(): void { this.contentEl.empty(); }
}
