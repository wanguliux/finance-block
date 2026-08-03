/**
 * RecurringPlanModal —— 日常花费计划弹窗（finance-recurring V1）
 *
 * 与 EntryFormModal（代码块参数驱动）不同：计划是配置项，字段带联动
 * （frequency=monthly 才显示「每月几号」），独立渲染表单。
 * 账户/分类/归属下拉从 finance-config.json 实时取（受管词表）。
 */

import { Modal, Notice, setIcon } from 'obsidian';
import type { App } from 'obsidian';
import { t } from '../i18n';
import type { FinanceConfig, RecurringFrequency, RecurringPlanDef } from '../types';
import { todayLocal } from '../util/date';

export class RecurringPlanModal extends Modal {
  private config: FinanceConfig;
  private existing?: RecurringPlanDef;
  private onSave: (plan: RecurringPlanDef) => void;
  private inputs: Record<string, HTMLInputElement | HTMLSelectElement> = {};
  private monthlyWrap!: HTMLElement;

  constructor(
    app: App,
    config: FinanceConfig,
    existing: RecurringPlanDef | undefined,
    onSave: (plan: RecurringPlanDef) => void,
  ) {
    super(app);
    this.config = config;
    this.existing = existing;
    this.onSave = onSave;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('finance-recurring-modal');

    const title = contentEl.createDiv({ cls: 'finance-insert-param-header' });
    const iconEl = title.createSpan({ cls: 'finance-insert-card-icon' });
    setIcon(iconEl, 'repeat');
    title.createEl('h2', { text: t('recurring.modal.planTitle') });

    const form = contentEl.createDiv({ cls: 'finance-insert-params' });

    // 名称
    this.textField(form, 'name', t('recurring.plan.name'), this.existing?.name ?? '');

    // 金额 + 频率（一行两列）
    const row1 = form.createDiv({ cls: 'finance-field-row' });
    const amountWrap = row1.createDiv({ cls: 'finance-field' });
    amountWrap.createDiv({ cls: 'finance-insert-param-label', text: t('recurring.plan.amount') });
    const amount = amountWrap.createEl('input', { type: 'number', cls: 'finance-input', attr: { step: '0.01', min: '0', inputmode: 'decimal' } });
    if (this.existing) amount.value = String(this.existing.amount / 100);
    amount.placeholder = '6.00';
    this.inputs['amount'] = amount;

    const freqWrap = row1.createDiv({ cls: 'finance-field' });
    freqWrap.createDiv({ cls: 'finance-insert-param-label', text: t('recurring.plan.frequency') });
    const freq = freqWrap.createEl('select', { cls: 'finance-select' });
    const freqOptions: Array<[RecurringFrequency, string]> = [
      ['daily', t('recurring.freq.daily')],
      ['weekday', t('recurring.freq.weekday')],
      ['monthly', t('recurring.freq.monthly')],
    ];
    for (const [v, label] of freqOptions) freq.createEl('option', { value: v, text: label });
    freq.value = this.existing?.frequency ?? 'weekday';
    this.inputs['frequency'] = freq;

    // 支出账户 + 出资账户（必填，受管账户列表）
    const row2 = form.createDiv({ cls: 'finance-field-row' });
    this.accountField(row2, 'account', t('recurring.plan.account'), this.existing?.account ?? '');
    this.accountField(row2, 'fromAccount', t('recurring.plan.fromAccount'), this.existing?.fromAccount ?? '');

    // 分类 + 归属
    const row3 = form.createDiv({ cls: 'finance-field-row' });
    this.selectField(row3, 'txnType', t('recurring.plan.txnType'), this.config.transactionTypes.map((x) => x.name), this.existing?.txnType ?? '');
    this.selectField(row3, 'owner', t('recurring.plan.owner'), this.config.owners, this.existing?.owner ?? this.config.defaultOwner);

    // 每月几号（monthly 联动显隐）
    this.monthlyWrap = form.createDiv({ cls: 'finance-field' });
    this.monthlyWrap.createDiv({ cls: 'finance-insert-param-label', text: t('recurring.plan.monthlyDay') });
    const monthlyDay = this.monthlyWrap.createEl('input', { type: 'number', cls: 'finance-input', attr: { min: '1', max: '28' } });
    monthlyDay.value = String(this.existing?.monthlyDay ?? 1);
    this.inputs['monthlyDay'] = monthlyDay;
    freq.addEventListener('change', () => this.syncMonthly());

    // 起始日 + 结束日
    const row4 = form.createDiv({ cls: 'finance-field-row' });
    this.dateField(row4, 'startDate', t('recurring.plan.startDate'), this.existing?.startDate ?? todayLocal());
    this.dateField(row4, 'endDate', t('recurring.plan.endDate'), this.existing?.endDate ?? '');

    // 备注
    this.textField(form, 'note', t('recurring.plan.note'), this.existing?.note ?? '');

    // 按钮行
    const btnRow = contentEl.createDiv({ cls: 'finance-btn-row' });
    const cancel = btnRow.createEl('button', { text: t('recurring.modal.cancel') });
    cancel.addClass('mod-muted');
    cancel.addEventListener('click', () => this.close());
    const save = btnRow.createEl('button', { text: t('recurring.modal.save'), cls: 'mod-cta' });
    save.addEventListener('click', () => this.submit());

    this.syncMonthly();
  }

  private syncMonthly(): void {
    const freq = (this.inputs['frequency'] as HTMLSelectElement).value;
    this.monthlyWrap.toggleClass('is-hidden', freq !== 'monthly');
  }

  private accountField(parent: HTMLElement, key: 'account' | 'fromAccount', label: string, value: string): void {
    this.selectField(parent, key, label, this.config.accounts.map((a) => a.name), value);
  }

  private selectField(parent: HTMLElement, key: string, label: string, options: string[], value: string): void {
    const wrap = parent.createDiv({ cls: 'finance-field' });
    wrap.createDiv({ cls: 'finance-insert-param-label', text: label });
    const sel = wrap.createEl('select', { cls: 'finance-select' });
    sel.createEl('option', { value: '', text: '—' });
    for (const opt of options) sel.createEl('option', { value: opt, text: opt });
    if (value) sel.value = value;
    this.inputs[key] = sel;
  }

  private textField(parent: HTMLElement, key: string, label: string, value: string): void {
    const wrap = parent.createDiv({ cls: 'finance-field' });
    wrap.createDiv({ cls: 'finance-insert-param-label', text: label });
    const input = wrap.createEl('input', { type: 'text', cls: 'finance-input' });
    if (value) input.value = value;
    this.inputs[key] = input;
  }

  private dateField(parent: HTMLElement, key: string, label: string, value: string): void {
    const wrap = parent.createDiv({ cls: 'finance-field' });
    wrap.createDiv({ cls: 'finance-insert-param-label', text: label });
    const input = wrap.createEl('input', { type: 'date', cls: 'finance-input' });
    if (value) input.value = value;
    this.inputs[key] = input;
  }

  private submit(): void {
    const name = (this.inputs['name'] as HTMLInputElement).value.trim();
    const amountYuan = parseFloat((this.inputs['amount'] as HTMLInputElement).value);
    const account = (this.inputs['account'] as HTMLSelectElement).value.trim();
    const fromAccount = (this.inputs['fromAccount'] as HTMLSelectElement).value.trim();
    const txnType = (this.inputs['txnType'] as HTMLSelectElement).value;
    const owner = (this.inputs['owner'] as HTMLSelectElement).value || this.config.defaultOwner;
    const frequency = (this.inputs['frequency'] as HTMLSelectElement).value as RecurringFrequency;
    const startDate = (this.inputs['startDate'] as HTMLInputElement).value;
    const endDate = (this.inputs['endDate'] as HTMLInputElement).value;
    const note = (this.inputs['note'] as HTMLInputElement).value.trim();

    if (!name) return void new Notice(t('recurring.modal.err.name'));
    if (!(amountYuan > 0)) return void new Notice(t('recurring.modal.err.amount'));
    if (!account) return void new Notice(t('recurring.modal.err.account'));
    if (!fromAccount) return void new Notice(t('recurring.modal.err.fromAccount'));
    if (!txnType) return void new Notice(t('recurring.modal.err.txnType'));
    if (!startDate) return void new Notice(t('recurring.modal.err.startDate'));
    if (frequency === 'monthly') {
      const day = parseInt((this.inputs['monthlyDay'] as HTMLInputElement).value, 10);
      if (!(day >= 1 && day <= 28)) return void new Notice(t('recurring.modal.err.monthlyDay'));
    }
    if (this.existing) {
      const others = this.config.recurringPlans.filter((p) => p.id !== this.existing!.id);
      if (others.some((p) => p.name === name)) return void new Notice(t('recurring.modal.err.nameDup'));
    } else if (this.config.recurringPlans.some((p) => p.name === name)) {
      return void new Notice(t('recurring.modal.err.nameDup'));
    }

    const plan: RecurringPlanDef = {
      id: this.existing?.id ?? `plan-${Date.now().toString(36)}`,
      name,
      amount: Math.round(amountYuan * 100),
      account,
      fromAccount,
      txnType,
      owner,
      frequency,
      monthlyDay: frequency === 'monthly' ? parseInt((this.inputs['monthlyDay'] as HTMLInputElement).value, 10) : undefined,
      startDate,
      endDate: endDate || undefined,
      note: note || undefined,
      active: this.existing?.active ?? true,
    };
    this.onSave(plan);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
