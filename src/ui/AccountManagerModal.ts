import { Modal, Notice } from 'obsidian';
import type FinancePlugin from '../main';
import type { AccountClass, AccountDef, DepreciationDef } from '../types';
import { t, tClass } from '../i18n';
import { confirmWithModal } from './Confirm';

/*
 * AccountManagerModal —— "账户"管理弹窗。
 * 列出所有账户（含五大类徽章 + 图标），每条可「编辑 / 删除」。
 * 点「新增账户」打开 AccountEditModal（名称 / 类别 / 图标）。
 * 数据持久化在 vault 的 finance-config.json（FinanceConfig.accounts）。
 *
 * 注意：账户名是交易 legs 中引用的身份（account: string）。
 * 因此编辑时名称只读，避免改名为已有交易造成悬空引用（与币种 code 只读一致）。
 */

export class AccountManagerModal extends Modal {
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

    contentEl.createEl('h2', { text: t('modal.accounts.title') });

    // 顶部搜索框：按名称 / 图标实时过滤。
    this.searchWrap = contentEl.createDiv();
    this.searchWrap.addClass('fb-search');
    const search = this.searchWrap.createEl('input', {
      type: 'text', cls: 'fb-input', placeholder: t('modal.accounts.search'),
    });
    search.addEventListener('input', () => {
      this.searchQuery = search.value.trim().toLowerCase();
      this.renderAccounts();
    });

    const topToolbar = contentEl.createDiv();
    topToolbar.addClass('fb-btn-row');
    topToolbar.setCssStyles({ justifyContent: 'flex-start' });
    const addBtn = topToolbar.createEl('button', { text: t('modal.accounts.add') });
    addBtn.addClass('mod-cta');
    addBtn.addEventListener('click', () => this.openAdd());

    this.listContainer = contentEl.createDiv();
    this.listContainer.addClass('fb-list');

    this.renderAccounts();

    const btnRow = contentEl.createDiv();
    btnRow.addClass('fb-btn-row');
    const closeBtn = btnRow.createEl('button', { text: t('common.close') });
    closeBtn.addClass('mod-muted');
    closeBtn.addEventListener('click', () => this.close());
  }

  private renderAccounts(): void {
    this.listContainer.empty();
    const accounts = this.getAccounts();

    if (accounts.length === 0) {
      this.listContainer.createEl('p', { text: t('modal.accounts.noData') });
      return;
    }

    const q = this.searchQuery;
    const visible = q
      ? accounts.filter((a) => (a.name + (a.icon ?? '')).toLowerCase().includes(q))
      : accounts;

    if (visible.length === 0) {
      this.listContainer.createEl('p', { text: t('common.noMatch') });
      return;
    }

    for (const account of visible) {
      const row = this.listContainer.createDiv();
      row.addClass('fb-card');

      const infoCol = row.createDiv();
      infoCol.addClass('fb-info');

      const titleRow = infoCol.createDiv();
      titleRow.addClass('fb-title');
      const label = account.icon ? `${account.icon} ${account.name}` : account.name;
      titleRow.createSpan({ text: label });

      const badge = titleRow.createSpan({ text: tClass(account.class) });
      badge.addClass('fb-badge');

      // 计价方式徽章（仅非 book / 已设置时显示）
      if (account.valuation && account.valuation !== 'book') {
        const valuationKey = account.valuation === 'market'
          ? 'assets.marketValue'
          : 'assets.depreciationValue';
        const valBadge = titleRow.createSpan({ text: t(valuationKey) });
        valBadge.addClass('fb-badge');
      }

      // 归属徽章
      if (account.owner) {
        const ownerBadge = titleRow.createSpan({ text: account.owner });
        ownerBadge.addClass('fb-badge');
      }

      // 现金流角色徽章（仅资产类且有设置时显示）
      if (account.class === 'asset' && account.cashflowRole) {
        const roleKey = `modal.accounts.cashflowRole.${account.cashflowRole}`;
        const roleBadge = titleRow.createSpan({ text: t(roleKey) });
        roleBadge.addClass('fb-badge');
      }

      infoCol.createDiv({ text: '', cls: 'fb-meta' });

      const btnCol = row.createDiv();
      btnCol.addClass('fb-actions');

      const editBtn = btnCol.createEl('button', { text: t('common.edit') });
      editBtn.addClass('fb-action-btn');
      editBtn.addEventListener('click', () => this.openEdit(account.name));

      const deleteBtn = btnCol.createEl('button', { text: t('common.delete') });
      deleteBtn.addClass('fb-danger-btn');
      deleteBtn.addEventListener('click', () => void this.delete(account.name));
    }
  }

  private openAdd(): void {
    const editModal = new AccountEditModal(this.plugin);
    editModal.onClose = () => void this.refresh();
    editModal.open();
  }

  private openEdit(name: string): void {
    const editModal = new AccountEditModal(this.plugin, { editName: name });
    editModal.onClose = () => void this.refresh();
    editModal.open();
  }

  private async delete(name: string): Promise<void> {
    const account = this.plugin.config.accounts.find((a) => a.name === name);
    if (!(await confirmWithModal(this.app, t('modal.accounts.confirmDelete', { name })))) {
      return;
    }
    this.plugin.config.accounts = this.plugin.config.accounts.filter((a) => a.name !== name);
    await this.save();
    new Notice(t('modal.accounts.deleted'));
    await this.refresh();
  }

  private async refresh(): Promise<void> { this.renderAccounts(); }
  private getAccounts(): AccountDef[] { return this.plugin.config.accounts ?? []; }
  private async save(): Promise<void> { await this.plugin.configManager.save(); }

  onClose(): void { this.contentEl.empty(); }
}

interface AccountEditModalOptions { editName?: string; }

class AccountEditModal extends Modal {
  private plugin: FinancePlugin;
  private options: AccountEditModalOptions;
  private nameInput!: HTMLInputElement;
  private classSelect!: HTMLSelectElement;
  private iconInput!: HTMLInputElement;
  private ownerSelect!: HTMLSelectElement;
  private valuationSelect!: HTMLSelectElement;
  private cashflowRoleField!: HTMLDivElement;
  private cashflowRoleSelect!: HTMLSelectElement;
  private staleDaysInput!: HTMLInputElement;
  private staleDaysField!: HTMLDivElement;
  private depSection!: HTMLDivElement;
  private depPriceInput!: HTMLInputElement;
  private depDateInput!: HTMLInputElement;
  private depYearsInput!: HTMLInputElement;
  private depSalvageInput!: HTMLInputElement;

  constructor(plugin: FinancePlugin, options: AccountEditModalOptions = {}) {
    super(plugin.app);
    this.plugin = plugin;
    this.options = options;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('fb-modal');

    const editAccount = this.options.editName
      ? this.plugin.config.accounts.find((a) => a.name === this.options.editName)
      : undefined;

    contentEl.createEl('h2', {
      text: editAccount ? t('modal.accounts.editTitle') : t('modal.accounts.newTitle'),
    });

    // 名称（新增可填；编辑只读——账户名是交易引用的身份）
    const nameField = contentEl.createDiv(); nameField.addClass('fb-field');
    nameField.createEl('label', { text: t('modal.accounts.name') });
    this.nameInput = nameField.createEl('input', {
      type: 'text', cls: 'fb-input', placeholder: t('modal.accounts.namePlaceholder'),
    });
    if (editAccount) {
      this.nameInput.value = editAccount.name;
      this.nameInput.disabled = true;
    }

    // 类别（五大类下拉）
    const classField = contentEl.createDiv(); classField.addClass('fb-field');
    classField.createEl('label', { text: t('modal.accounts.class') });
    this.classSelect = classField.createEl('select', { cls: 'fb-input' });
    this.classSelect.createEl('option', { text: t('modal.accounts.classPlaceholder'), value: '' });
    for (const cls of this.plugin.config.classes) {
      const opt = this.classSelect.createEl('option', { text: tClass(cls), value: cls });
      if (editAccount && editAccount.class === cls) opt.selected = true;
    }
    if (editAccount && editAccount.class) this.classSelect.value = editAccount.class;

    // 图标（可选）
    const iconField = contentEl.createDiv(); iconField.addClass('fb-field');
    iconField.createEl('label', { text: t('modal.accounts.icon') });
    this.iconInput = iconField.createEl('input', {
      type: 'text', cls: 'fb-input', placeholder: t('modal.accounts.iconPlaceholder'),
    });
    if (editAccount) this.iconInput.value = editAccount.icon ?? '';

    // 归属（Owner 下拉）
    const ownerField = contentEl.createDiv(); ownerField.addClass('fb-field');
    ownerField.createEl('label', { text: t('modal.accounts.owner') });
    this.ownerSelect = ownerField.createEl('select', { cls: 'fb-input' });
    this.ownerSelect.createEl('option', { text: t('modal.accounts.ownerPlaceholder'), value: '' });
    for (const owner of this.plugin.config.owners ?? []) {
      const opt = this.ownerSelect.createEl('option', { text: owner, value: owner });
      if (editAccount && editAccount.owner === owner) opt.selected = true;
    }
    if (editAccount && editAccount.owner) this.ownerSelect.value = editAccount.owner;

    // 计价方式（Valuation 下拉）
    const valuationField = contentEl.createDiv(); valuationField.addClass('fb-field');
    valuationField.createEl('label', { text: t('modal.accounts.valuation') });
    this.valuationSelect = valuationField.createEl('select', { cls: 'fb-input' });
    this.valuationSelect.createEl('option', { text: t('modal.accounts.valuationPlaceholder'), value: '' });
    const valuationOptions: Array<{ value: 'book' | 'market' | 'depreciation'; label: string }> = [
      { value: 'book', label: t('modal.accounts.valuation.book') },
      { value: 'market', label: t('modal.accounts.valuation.market') },
      { value: 'depreciation', label: t('modal.accounts.valuation.depreciation') },
    ];
    for (const v of valuationOptions) {
      const opt = this.valuationSelect.createEl('option', { text: v.label, value: v.value });
      if (editAccount && editAccount.valuation === v.value) opt.selected = true;
    }
    if (editAccount && editAccount.valuation) this.valuationSelect.value = editAccount.valuation;

    // 现金流角色（仅资产类显示；负债类由引擎统一按负债桶处理）
    this.cashflowRoleField = contentEl.createDiv(); this.cashflowRoleField.addClass('fb-field');
    this.cashflowRoleField.createEl('label', { text: t('modal.accounts.cashflowRole') });
    this.cashflowRoleSelect = this.cashflowRoleField.createEl('select', { cls: 'fb-input' });
    this.cashflowRoleSelect.createEl('option', { text: t('modal.accounts.cashflowRolePlaceholder'), value: '' });
    const roleOptions: Array<{ value: 'growth' | 'cash' | 'fixed' | 'rental'; label: string }> = [
      { value: 'growth', label: t('modal.accounts.cashflowRole.growth') },
      { value: 'cash', label: t('modal.accounts.cashflowRole.cash') },
      { value: 'fixed', label: t('modal.accounts.cashflowRole.fixed') },
      { value: 'rental', label: t('modal.accounts.cashflowRole.rental') },
    ];
    for (const r of roleOptions) {
      const opt = this.cashflowRoleSelect.createEl('option', { text: r.label, value: r.value });
      if (editAccount && editAccount.cashflowRole === r.value) opt.selected = true;
    }
    if (editAccount && editAccount.cashflowRole) this.cashflowRoleSelect.value = editAccount.cashflowRole;

    // 估值过期天数（仅 market / depreciation 时显示）
    this.staleDaysField = contentEl.createDiv(); this.staleDaysField.addClass('fb-field');
    this.staleDaysField.createEl('label', { text: t('modal.accounts.staleDays') });
    this.staleDaysInput = this.staleDaysField.createEl('input', {
      type: 'number', cls: 'fb-input', placeholder: t('modal.accounts.staleDaysPlaceholder'),
    });
    this.staleDaysField.createDiv({ text: t('modal.accounts.staleDaysHint'), cls: 'fb-hint' });
    if (editAccount && editAccount.staleDays != null) this.staleDaysInput.value = String(editAccount.staleDays);

    // 折旧参数（仅 depreciation 时显示）
    this.depSection = contentEl.createDiv(); this.depSection.addClass('fb-field');
    this.depSection.createEl('label', { text: t('modal.accounts.depreciation') });

    const depPriceField = this.depSection.createDiv(); depPriceField.addClass('fb-field');
    depPriceField.createEl('label', { text: t('modal.accounts.depPrice') });
    this.depPriceInput = depPriceField.createEl('input', {
      type: 'number', cls: 'fb-input', placeholder: '0.00',
    });

    const depDateField = this.depSection.createDiv(); depDateField.addClass('fb-field');
    depDateField.createEl('label', { text: t('modal.accounts.depDate') });
    this.depDateInput = depDateField.createEl('input', {
      type: 'date', cls: 'fb-input',
    });

    const depYearsField = this.depSection.createDiv(); depYearsField.addClass('fb-field');
    depYearsField.createEl('label', { text: t('modal.accounts.depYears') });
    this.depYearsInput = depYearsField.createEl('input', {
      type: 'number', cls: 'fb-input', placeholder: '0',
    });

    const depSalvageField = this.depSection.createDiv(); depSalvageField.addClass('fb-field');
    depSalvageField.createEl('label', { text: t('modal.accounts.depSalvage') });
    this.depSalvageInput = depSalvageField.createEl('input', {
      type: 'number', cls: 'fb-input', placeholder: '0.00',
    });
    depSalvageField.createDiv({ text: t('modal.accounts.depSalvageHint'), cls: 'fb-hint' });

    // 预填折旧参数
    if (editAccount?.depreciation) {
      const dep = editAccount.depreciation;
      this.depPriceInput.value = String(dep.purchasePrice / 100);
      this.depDateInput.value = dep.purchaseDate;
      this.depYearsInput.value = String(dep.usefulLifeYears);
      if (dep.salvageValue != null) this.depSalvageInput.value = String(dep.salvageValue / 100);
    }

    // 根据计价方式切换 staleDays / 折旧区可见性；根据类别切换现金流角色
    const updateVisibility = (): void => {
      const val = this.valuationSelect.value;
      const showStale = val === 'market' || val === 'depreciation';
      const showDep = val === 'depreciation';
      this.staleDaysField.toggleClass('is-hidden', !showStale);
      this.depSection.toggleClass('is-hidden', !showDep);
      const cls = this.classSelect.value;
      this.cashflowRoleField.toggleClass('is-hidden', cls !== 'asset');
    };
    this.valuationSelect.addEventListener('change', updateVisibility);
    this.classSelect.addEventListener('change', updateVisibility);
    updateVisibility();

    const btnRow = contentEl.createDiv();
    btnRow.addClass('fb-btn-row');
    const cancelBtn = btnRow.createEl('button', { text: t('common.cancel') });
    cancelBtn.addClass('mod-muted');
    cancelBtn.addEventListener('click', () => this.close());
    const saveBtn = btnRow.createEl('button', { text: t('common.save') });
    saveBtn.addClass('mod-cta');
    saveBtn.addEventListener('click', () => {
      void this.save().catch((err) => {
        console.error('[finance-block] save account failed:', err);
        new Notice(t('common.saveFailed'));
      });
    });
  }

  private async save(): Promise<void> {
    const name = this.nameInput.value.trim();
    if (!name) { new Notice(t('modal.accounts.nameRequired')); return; }
    const cls = this.classSelect.value as AccountClass;
    const icon = this.iconInput.value.trim();

    // 资产管理扩展字段
    const owner = this.ownerSelect.value || undefined;
    const valuation = (this.valuationSelect.value || undefined) as AccountDef['valuation'];
    const cashflowRole = (this.cashflowRoleSelect.value || undefined) as AccountDef['cashflowRole'];
    const staleDaysRaw = parseInt(this.staleDaysInput.value, 10);
    const staleDays = (valuation === 'market' || valuation === 'depreciation') && !isNaN(staleDaysRaw)
      ? staleDaysRaw : undefined;

    let depreciation: DepreciationDef | undefined;
    if (valuation === 'depreciation') {
      const price = parseFloat(this.depPriceInput.value);
      const date = this.depDateInput.value;
      const years = parseFloat(this.depYearsInput.value);
      const salvage = parseFloat(this.depSalvageInput.value);
      if (!isNaN(price) && date && !isNaN(years)) {
        depreciation = {
          purchasePrice: Math.round(price * 100),
          purchaseDate: date,
          usefulLifeYears: years,
          method: 'straight-line',
          salvageValue: !isNaN(salvage) ? Math.round(salvage * 100) : undefined,
        };
      }
    }

    const accounts = this.plugin.config.accounts;
    if (!this.options.editName) {
      if (accounts.some((a) => a.name === name)) { new Notice(t('modal.accounts.nameDuplicate')); return; }
      // 新增：默认 asset 类
      accounts.push({
        name, class: cls || 'asset', icon: icon || undefined,
        owner, valuation, staleDays, depreciation, cashflowRole,
      });
    } else {
      const target = accounts.find((a) => a.name === this.options.editName);
      if (target) {
        // 名称只读：更新类别、图标与资产管理字段；保留会计增强字段（accrued / sinkingFund）
        target.class = cls || target.class;
        target.icon = icon || undefined;
        target.owner = owner;
        target.valuation = valuation;
        target.staleDays = staleDays;
        // 仅当计价方式为 depreciation 时写入折旧参数，否则清除
        target.depreciation = depreciation;
        // 现金流角色：空值表示「按计价方式智能推断」
        target.cashflowRole = cashflowRole;
      }
    }
    await this.plugin.configManager.save();
    new Notice(t('modal.accounts.saved'));
    this.close();
  }

  onClose(): void { this.contentEl.empty(); }
}
