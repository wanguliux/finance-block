/**
 * LoanModal —— 贷款计划弹窗（finance-recurring V2）
 *
 * 特性：
 *  - 实时还款预览：本金/年利率/年限/还款方式/周期 变化即重算首期金额、本息构成、总期数、总利息。
 *  - 编辑模式才显示「剩余本金」输入框：改小 = 模拟部分提前还本（已拍板唯一入口），
 *    还款计划从下一未入账期以新剩余本金续算。
 *  - 三账户（出资/负债/利息）+ 分类/归属 走受管词表。
 */

import { Modal, Notice, setIcon } from 'obsidian';
import type { App } from 'obsidian';
import { t } from '../i18n';
import type { FinanceConfig, LoanDef, LoanFrequency, LoanType } from '../types';
import { computeLoanSchedule } from '../engine/loan';

export class LoanModal extends Modal {
  private config: FinanceConfig;
  private existing?: LoanDef;
  private onSave: (loan: LoanDef) => void;
  private inputs: Record<string, HTMLInputElement | HTMLSelectElement> = {};
  private remainingWrap!: HTMLElement;
  private pvFirst!: HTMLElement;
  private pvDesc!: HTMLElement;
  private pvSplit!: HTMLElement;
  private pvPeriods!: HTMLElement;
  private pvInterest!: HTMLElement;

  constructor(
    app: App,
    config: FinanceConfig,
    existing: LoanDef | undefined,
    onSave: (loan: LoanDef) => void,
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
    setIcon(iconEl, 'landmark');
    title.createEl('h2', { text: t('recurring.modal.loanTitle') });

    const form = contentEl.createDiv({ cls: 'finance-insert-params' });

    // ── 实时预览区 ──
    const preview = form.createDiv({ cls: 'rc-preview' });
    preview.createDiv({ cls: 'rc-preview-title', text: t('recurring.loan.preview') });
    this.pvFirst = preview.createDiv({ cls: 'rc-preview-main', text: '—' });
    this.pvDesc = preview.createDiv({ cls: 'rc-preview-sub' });
    this.pvSplit = preview.createDiv({ cls: 'rc-preview-row', text: t('recurring.loan.pvSplit') });
    this.pvPeriods = preview.createDiv({ cls: 'rc-preview-row', text: t('recurring.loan.pvPeriods') });
    this.pvInterest = preview.createDiv({ cls: 'rc-preview-row', text: t('recurring.loan.pvInterest') });

    // ── 名称 ──
    this.textField(form, 'name', t('recurring.loan.name'), this.existing?.name ?? '');

    // 本金 + 年利率
    const row1 = form.createDiv({ cls: 'finance-field-row' });
    this.numberField(row1, 'principal', t('recurring.loan.principal'), this.existing ? String(this.existing.principal / 100) : '1000000');
    this.numberField(row1, 'annualRate', t('recurring.loan.annualRate'), this.existing ? String(this.existing.annualRate) : '3.5');

    // 年限 + 还款方式
    const row2 = form.createDiv({ cls: 'finance-field-row' });
    this.numberField(row2, 'termYears', t('recurring.loan.termYears'), this.existing ? String(this.existing.termYears) : '30');
    const typeWrap = row2.createDiv({ cls: 'finance-field' });
    typeWrap.createDiv({ cls: 'finance-insert-param-label', text: t('recurring.loan.type') });
    const typeSel = typeWrap.createEl('select', { cls: 'finance-select' });
    const typeOptions: Array<[LoanType, string]> = [
      ['annuity', t('recurring.loan.type.annuity')],
      ['equal-principal', t('recurring.loan.type.equalPrincipal')],
      ['interest-first', t('recurring.loan.type.interestFirst')],
    ];
    for (const [v, label] of typeOptions) typeSel.createEl('option', { value: v, text: label });
    typeSel.value = this.existing?.type ?? 'annuity';
    this.inputs['type'] = typeSel;

    // 周期 + 首期还款日
    const row3 = form.createDiv({ cls: 'finance-field-row' });
    const freqWrap = row3.createDiv({ cls: 'finance-field' });
    freqWrap.createDiv({ cls: 'finance-insert-param-label', text: t('recurring.loan.frequency') });
    const freqSel = freqWrap.createEl('select', { cls: 'finance-select' });
    freqSel.createEl('option', { value: 'monthly', text: t('recurring.loan.freq.monthly') });
    freqSel.createEl('option', { value: 'quarterly', text: t('recurring.loan.freq.quarterly') });
    freqSel.value = this.existing?.frequency ?? 'monthly';
    this.inputs['frequency'] = freqSel;
    this.dateField(row3, 'firstPaymentDate', t('recurring.loan.firstPaymentDate'), this.existing?.firstPaymentDate ?? '2026-09-01');

    // 剩余本金（仅编辑模式显示；新建默认 = 本金）
    this.remainingWrap = form.createDiv({ cls: 'finance-field' });
    this.remainingWrap.createDiv({ cls: 'finance-insert-param-label', text: t('recurring.loan.remaining') });
    const remaining = this.remainingWrap.createEl('input', { type: 'number', cls: 'finance-input', attr: { step: '0.01', min: '0' } });
    this.inputs['remainingPrincipal'] = remaining;
    if (this.existing?.remainingPrincipal !== undefined) remaining.value = String(this.existing.remainingPrincipal / 100);
    this.remainingWrap.createDiv({ cls: 'rc-hint', text: t('recurring.loan.remainingHint') });
    this.remainingWrap.toggleClass('is-hidden', !this.existing);

    // 三账户
    const row4 = form.createDiv({ cls: 'finance-field-row' });
    this.accountField(row4, 'assetAccount', t('recurring.loan.assetAccount'), this.existing?.assetAccount ?? '');
    this.accountField(row4, 'liabilityAccount', t('recurring.loan.liabilityAccount'), this.existing?.liabilityAccount ?? '');
    const row5 = form.createDiv({ cls: 'finance-field-row' });
    this.accountField(row5, 'interestAccount', t('recurring.loan.interestAccount'), this.existing?.interestAccount ?? '');

    // 分类 + 归属
    const row6 = form.createDiv({ cls: 'finance-field-row' });
    this.selectField(row6, 'txnType', t('recurring.loan.txnType'), this.config.transactionTypes.map((x) => x.name), this.existing?.txnType ?? '');
    this.selectField(row6, 'owner', t('recurring.loan.owner'), this.config.owners, this.existing?.owner ?? this.config.defaultOwner);

    // 备注
    this.textField(form, 'note', t('recurring.loan.note'), this.existing?.note ?? '');

    // 按钮
    const btnRow = contentEl.createDiv({ cls: 'finance-btn-row' });
    const cancel = btnRow.createEl('button', { text: t('recurring.modal.cancel') });
    cancel.addClass('mod-muted');
    cancel.addEventListener('click', () => this.close());
    const save = btnRow.createEl('button', { text: t('recurring.modal.save'), cls: 'mod-cta' });
    save.addEventListener('click', () => this.submit());

    // 实时预览联动
    const refreshKeys = ['principal', 'annualRate', 'termYears', 'type', 'frequency'];
    for (const key of refreshKeys) {
      const el = this.inputs[key];
      el.addEventListener('input', () => this.refreshPreview());
      el.addEventListener('change', () => this.refreshPreview());
    }
    this.refreshPreview();
  }

  private refreshPreview(): void {
    const P = parseFloat((this.inputs['principal'] as HTMLInputElement).value) || 0;
    const rate = parseFloat((this.inputs['annualRate'] as HTMLInputElement).value) || 0;
    const years = parseFloat((this.inputs['termYears'] as HTMLInputElement).value) || 0;
    const type = (this.inputs['type'] as HTMLSelectElement).value as LoanType;
    const freq = (this.inputs['frequency'] as HTMLSelectElement).value as LoanFrequency;
    if (P <= 0 || rate <= 0 || years <= 0) {
      this.pvFirst.textContent = '—';
      this.pvDesc.textContent = t('recurring.loan.previewEmpty');
      this.pvSplit.textContent = t('recurring.loan.pvSplit');
      this.pvPeriods.textContent = t('recurring.loan.pvPeriods');
      this.pvInterest.textContent = t('recurring.loan.pvInterest');
      return;
    }
    const def: LoanDef = {
      id: this.existing?.id ?? 'preview',
      name: (this.inputs['name'] as HTMLInputElement).value || '贷款',
      type, principal: Math.round(P * 100), annualRate: rate, termYears: Math.max(1, Math.round(years)),
      frequency: freq, firstPaymentDate: '2026-09-01',
      assetAccount: '', liabilityAccount: '', interestAccount: '',
      txnType: '', owner: '', active: true,
    };
    const s = computeLoanSchedule(def);
    if (s.length === 0) return;
    const first = s[0];
    const totalInterest = s.reduce((acc, p) => acc + p.interestPart, 0);
    this.pvFirst.textContent = `¥${(first.total / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / 期`;
    this.pvDesc.textContent = t('recurring.loan.pvDesc', { n: String(s.length) });
    this.pvSplit.textContent = t('recurring.loan.pvSplit') + ` 本金 ¥${(first.principalPart / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · 利息 ¥${(first.interestPart / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    this.pvPeriods.textContent = t('recurring.loan.pvPeriods') + ` ${s.length} 期`;
    this.pvInterest.textContent = t('recurring.loan.pvInterest') + ` ¥${(totalInterest / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  private accountField(parent: HTMLElement, key: string, label: string, value: string): void {
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

  private numberField(parent: HTMLElement, key: string, label: string, value: string): void {
    const wrap = parent.createDiv({ cls: 'finance-field' });
    wrap.createDiv({ cls: 'finance-insert-param-label', text: label });
    const input = wrap.createEl('input', { type: 'number', cls: 'finance-input', attr: { inputmode: 'decimal' } });
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
    const principalYuan = parseFloat((this.inputs['principal'] as HTMLInputElement).value);
    const rate = parseFloat((this.inputs['annualRate'] as HTMLInputElement).value);
    const years = parseInt((this.inputs['termYears'] as HTMLInputElement).value, 10);
    const assetAccount = (this.inputs['assetAccount'] as HTMLSelectElement).value.trim();
    const liabilityAccount = (this.inputs['liabilityAccount'] as HTMLSelectElement).value.trim();
    const interestAccount = (this.inputs['interestAccount'] as HTMLSelectElement).value.trim();
    const txnType = (this.inputs['txnType'] as HTMLSelectElement).value;
    const firstPaymentDate = (this.inputs['firstPaymentDate'] as HTMLInputElement).value;
    const remainingRaw = (this.inputs['remainingPrincipal'] as HTMLInputElement).value;

    if (!name) return void new Notice(t('recurring.modal.err.name'));
    if (!(principalYuan > 0)) return void new Notice(t('recurring.modal.err.loanPrincipal'));
    if (!(rate > 0)) return void new Notice(t('recurring.modal.err.loanRate'));
    if (!(years >= 1 && years <= 50)) return void new Notice(t('recurring.modal.err.loanYears'));
    if (!assetAccount || !liabilityAccount || !interestAccount) return void new Notice(t('recurring.modal.err.loanAccounts'));
    if (!txnType) return void new Notice(t('recurring.modal.err.txnType'));
    if (!firstPaymentDate) return void new Notice(t('recurring.modal.err.startDate'));

    const loan: LoanDef = {
      id: this.existing?.id ?? `loan-${Date.now().toString(36)}`,
      name,
      type: (this.inputs['type'] as HTMLSelectElement).value as LoanType,
      principal: Math.round(principalYuan * 100),
      annualRate: rate,
      termYears: years,
      frequency: (this.inputs['frequency'] as HTMLSelectElement).value as LoanFrequency,
      firstPaymentDate,
      assetAccount,
      liabilityAccount,
      interestAccount,
      txnType,
      owner: (this.inputs['owner'] as HTMLSelectElement).value || this.config.defaultOwner,
      note: (this.inputs['note'] as HTMLInputElement).value.trim() || undefined,
      active: this.existing?.active ?? true,
    };
    // 仅编辑模式允许设定剩余本金（部分提前还本）；留空 = 不覆盖（按 principal）
    if (this.existing && remainingRaw !== '') {
      const r = parseFloat(remainingRaw);
      if (r >= 0) loan.remainingPrincipal = Math.round(r * 100);
    }
    this.onSave(loan);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
