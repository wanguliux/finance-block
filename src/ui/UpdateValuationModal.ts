import { Modal, Notice } from 'obsidian';
import type FinancePlugin from '../main';
import type { AccountDef, Valuation, AmountInCents } from '../types';
import { t } from '../i18n';
import { localDateString } from '../util/date';
import { calculateBalances } from '../ledger/closing';
import { generateValuationRefId } from '../ledger/poster';
import { appendEntryToLedgerBlock } from '../ledger/ledgerFile';
import { setHtml } from '../util/dom';

const VAL_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-6 4 4 5-8 4 5"/><path d="M3 21h18"/></svg>';

/** 元 → 分（round 避免浮点漂移）。 */
function yuanToCents(yuan: number): number {
  return Math.round(yuan * 100);
}

function fmtYuan(cents: AmountInCents): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}¥${(Math.abs(cents) / 100).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtPct(pct: number): string {
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

/**
 * 更新资产估值弹窗（§4 原型落地）
 *
 * 相比旧版的三处升级：
 *   1. 实时预览面板：上次估值 / 本次变化 / 账面余额 / 未实现损益，边填边看。
 *   2. 写入方式选择（默认「插入当前笔记（草稿）」）：与交易「先草稿后入账」心智一致。
 *   3. 账户下拉带计价方式徽标 + 提示：book 账户给明确警示，避免沉默失败。
 *   4. 快捷调整 chip：在上次估值基础上微调（房产类常见，不是从零填）。
 */
export class UpdateValuationModal extends Modal {
  private plugin: FinancePlugin;
  private preselectedAccount?: string;

  private accountSelect!: HTMLSelectElement;
  private accountHint!: HTMLElement;
  private amountInput!: HTMLInputElement;
  private currencySelect!: HTMLSelectElement;
  private dateInput!: HTMLInputElement;
  private commentInput!: HTMLInputElement;
  private quickWrap!: HTMLElement;
  private pvLast!: HTMLElement;
  private pvDelta!: HTMLElement;
  private pvBook!: HTMLElement;
  private pvPnl!: HTMLElement;
  private pvLine!: HTMLElement;

  // 预计算：每个账户的账面余额（来自已入账交易）与最新估值。
  private bookBalanceByAccount = new Map<string, AmountInCents>();
  private lastValByAccount = new Map<string, Valuation | undefined>();

  constructor(plugin: FinancePlugin, preselectedAccount?: string) {
    super(plugin.app);
    this.plugin = plugin;
    this.preselectedAccount = preselectedAccount;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('fb-modal');
    contentEl.addClass('valuation-modal');

    const config = this.plugin.config;
    const assetAccounts = config.accounts.filter((a) => a.class === 'asset');

    if (assetAccounts.length === 0) {
      contentEl.createEl('h2', { text: t('modal.valuation.title') });
      contentEl.createEl('p', { text: t('modal.valuation.noAssetAccount') });
      return;
    }

    // 预计算账面余额（来自已入账交易，按账户聚合）。
    const balances = calculateBalances(this.plugin.indexer.getPostedTransactions());
    this.bookBalanceByAccount = new Map(balances.map((b) => [b.account, b.balance]));

    // 标题 + 青色图标
    const head = contentEl.createEl('h2');
    const icon = head.createSpan({ cls: 'fb-icon is-val' });
    setHtml(icon, VAL_ICON);
    head.createSpan({ text: t('modal.valuation.title') });
    contentEl.createEl('div', {
      cls: 'fb-subhead',
      text: t('modal.valuation.subtitle'),
    });

    // ── 账户选择 ──
    // 从具体资产条目点开时锁定账户：只能更新这一个记账资产（#3 需求）。
    const accountField = contentEl.createDiv();
    accountField.addClass('fb-field');
    accountField.createEl('label', { text: t('modal.valuation.account') });
    if (this.preselectedAccount) {
      const lock = accountField.createDiv({ cls: 'vm-account-lock' });
      lock.createSpan({ cls: 'vm-lock-name', text: this.preselectedAccount });
      lock.createSpan({
        cls: 'vm-lock-badge',
        text: this.valuationBadge(this.accountDef(this.preselectedAccount)?.valuation ?? 'book'),
      });
      accountField.createDiv({ cls: 'm-hint', text: t('modal.valuation.lockedHint') });
    } else {
      this.accountSelect = accountField.createEl('select', { cls: 'fb-input' });
      for (const acc of assetAccounts) {
        const icon = acc.icon ? `${acc.icon} ` : '';
        const label = `${icon}${acc.name}  ${this.valuationBadge(acc.valuation ?? 'book')}`;
        const opt = this.accountSelect.createEl('option', { text: label, value: acc.name });
        if (this.preselectedAccount && acc.name === this.preselectedAccount) opt.selected = true;
      }
      this.accountHint = accountField.createDiv({ cls: 'm-hint' });
    }

    // ── 市值 + 币种 ──
    const amountField = contentEl.createDiv();
    amountField.addClass('fb-field');
    amountField.createEl('label', { text: t('modal.valuation.amount') });
    const row2 = amountField.createDiv({ cls: 'fb-row2' });
    this.amountInput = row2.createEl('input', {
      type: 'number',
      cls: 'fb-input',
      placeholder: t('modal.valuation.amountPlaceholder'),
      attr: { step: '0.01' },
    });
    this.currencySelect = row2.createEl('select', { cls: 'fb-input narrow' });
    this.currencySelect.createEl('option', {
      text: `${config.baseCurrency}（${t('common.default')}）`,
      value: '',
    });
    for (const cur of config.currencies) {
      if (cur.code === config.baseCurrency) continue;
      this.currencySelect.createEl('option', { text: `${cur.code} - ${cur.name}`, value: cur.code });
    }
    this.quickWrap = amountField.createDiv({ cls: 'm-quick' });

    // ── 日期 ──
    const dateField = contentEl.createDiv();
    dateField.addClass('fb-field');
    dateField.createEl('label', { text: t('modal.valuation.date') });
    this.dateInput = dateField.createEl('input', { type: 'date', cls: 'fb-input' });
    this.dateInput.value = localDateString(new Date());

    // ── 备注 ──
    const commentField = contentEl.createDiv();
    commentField.addClass('fb-field');
    commentField.createEl('label', { text: t('modal.valuation.comment') });
    this.commentInput = commentField.createEl('input', {
      type: 'text',
      cls: 'fb-input',
      placeholder: t('modal.valuation.commentPlaceholder'),
    });

    // ── 分隔线 ──
    contentEl.createDiv({ cls: 'vm-separator' });

    // ── 实时预览面板 ──
    const preview = contentEl.createDiv({ cls: 'm-preview' });
    preview.createEl('div', { cls: 'pv-title', text: t('modal.valuation.preview') });
    const grid = preview.createDiv({ cls: 'pv-grid' });
    const cellLast = grid.createDiv({ cls: 'pv-cell' });
    cellLast.createEl('span', { cls: 'k', text: t('modal.valuation.pv.last') });
    this.pvLast = cellLast.createEl('span', { cls: 'v', text: '—' });
    const cellDelta = grid.createDiv({ cls: 'pv-cell' });
    cellDelta.createEl('span', { cls: 'k', text: t('modal.valuation.pv.delta') });
    this.pvDelta = cellDelta.createEl('span', { cls: 'v', text: '—' });
    const cellBook = grid.createDiv({ cls: 'pv-cell' });
    cellBook.createEl('span', { cls: 'k', text: t('modal.valuation.pv.book') });
    this.pvBook = cellBook.createEl('span', { cls: 'v', text: '—' });
    const cellPnl = grid.createDiv({ cls: 'pv-cell' });
    cellPnl.createEl('span', { cls: 'k', text: t('modal.valuation.pv.pnl') });
    this.pvPnl = cellPnl.createEl('span', { cls: 'v', text: '—' });
    this.pvLine = preview.createEl('div', { cls: 'pv-line' });

    // ── 分隔线 ──
    contentEl.createDiv({ cls: 'vm-separator' });

    // ── 按钮 ──
    const btnRow = contentEl.createDiv();
    btnRow.addClass('fb-btn-row');
    const cancelBtn = btnRow.createEl('button', { text: t('common.cancel') });
    cancelBtn.addClass('mod-muted');
    cancelBtn.addEventListener('click', () => this.close());
    const saveBtn = btnRow.createEl('button', { text: t('common.save') });
    saveBtn.addClass('mod-cta');
    saveBtn.addEventListener('click', () => void this.onSave());

    // 事件绑定（账户锁定态无 select，跳过）
    if (this.accountSelect) {
      this.accountSelect.addEventListener('change', () => {
        this.refreshAccountHint();
        this.renderQuickChips();
        this.updatePreview();
      });
    }
    for (const el of [this.amountInput, this.currencySelect, this.dateInput, this.commentInput]) {
      el.addEventListener('input', () => this.updatePreview());
      el.addEventListener('change', () => this.updatePreview());
    }

    // 初始渲染
    this.refreshAccountHint();
    this.renderQuickChips();
    this.updatePreview();
  }

  private accountDef(name: string): AccountDef | undefined {
    return this.plugin.config.accounts.find((a) => a.name === name);
  }

  /** 计价方式徽标（与账户下拉一致）。 */
  private valuationBadge(method: AccountDef['valuation']): string {
    const m = method ?? 'book';
    return m === 'market'
      ? `[${t('valuation.kind.market')}]`
      : `[${t('valuation.kind.book')}]`;
  }

  /** 当前选中的账户：锁定态用预选账户，否则取下拉值。 */
  private selectedAccount(): string {
    return this.preselectedAccount ?? (this.accountSelect ? this.accountSelect.value : '');
  }

  /** 该账户的最新一条估值（按日期升序取最后一条）。 */
  private lastValuationOf(name: string): Valuation | undefined {
    if (this.lastValByAccount.has(name)) return this.lastValByAccount.get(name);
    const arr = this.plugin.indexer
      .getValuations(name)
      .slice()
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const v = arr[arr.length - 1];
    this.lastValByAccount.set(name, v);
    return v;
  }

  private refreshAccountHint(): void {
    if (!this.accountHint) return; // 锁定态无 hint 容器
    const name = this.selectedAccount();
    const def = this.accountDef(name);
    const method = def?.valuation ?? 'book';
    this.accountHint.className = 'm-hint';
    if (method === 'book') {
      this.accountHint.className = 'm-hint warn';
      this.accountHint.setText(t('modal.valuation.hint.book'));
    } else {
      const stale = def?.staleDays ?? this.plugin.config.defaultStaleDays;
      let s = t('modal.valuation.hint.market', { n: String(stale) });
      const prev = this.lastValuationOf(name);
      if (prev) s += t('modal.valuation.hint.lastAt', { date: prev.date });
      this.accountHint.setText(s);
    }
  }

  /** 上次估值存在时，渲染 ±5% / ±1% / 沿用上次 快捷 chip。 */
  private renderQuickChips(): void {
    this.quickWrap.empty();
    const prev = this.lastValuationOf(this.selectedAccount());
    if (!prev) return;
    const prevYuan = prev.amount / 100;
    const specs: Array<{ pct: number; label: string }> = [
      { pct: -5, label: '-5%' },
      { pct: -1, label: '-1%' },
      { pct: 0, label: t('modal.valuation.quick.same') },
      { pct: 1, label: '+1%' },
      { pct: 5, label: '+5%' },
    ];
    for (const spec of specs) {
      const chip = this.quickWrap.createEl('span', { cls: 'chip', text: spec.label });
      const yuan = spec.pct === 0 ? prevYuan : (prevYuan * (1 + spec.pct / 100));
      chip.addEventListener('click', () => {
        this.amountInput.value = yuan.toFixed(2);
        this.updatePreview();
      });
    }
  }

  /** 当前填写的估值行（不含 ^v- 前缀）。非法时返回 null。 */
  private buildLine(): string | null {
    const account = this.accountSelect.value;
    if (!account) return null;
    const yuan = parseFloat(this.amountInput.value);
    if (isNaN(yuan)) return null;
    const amountCents = yuanToCents(yuan);
    if (amountCents <= 0) return null;
    const currency = this.currencySelect.value;
    const date = this.dateInput.value || localDateString(new Date());
    const comment = this.commentInput.value.trim();
    let line = `${date} custom "fb-valuation" ${account} ${amountCents}`;
    if (currency) line += ` ${currency}`;
    if (comment) line += `   ; ${comment}`;
    return line;
  }

  private updatePreview(): void {
    const name = this.selectedAccount();
    const prev = this.lastValuationOf(name);
    const book = this.bookBalanceByAccount.get(name) ?? 0;

    this.pvLast.setText(prev ? fmtYuan(prev.amount) : '—');
    this.pvBook.setText(fmtYuan(book));

    const line = this.buildLine();
    if (line == null) {
      this.pvDelta.className = 'v';
      this.pvDelta.setText('—');
      this.pvPnl.className = 'v';
      this.pvPnl.setText('—');
      setHtml(this.pvLine, `${t('modal.valuation.pv.willWrite')} <b>—</b>`);
      return;
    }

    const cents = yuanToCents(parseFloat(this.amountInput.value));

    // 本次变化（对比上次估值）
    if (prev) {
      const d = cents - prev.amount;
      const pct = prev.amount ? (d / prev.amount) * 100 : 0;
      this.pvDelta.className = `v ${d > 0 ? 'up' : d < 0 ? 'down' : ''}`;
      this.pvDelta.setText(`${d >= 0 ? '+' : ''}${fmtYuan(d)} (${fmtPct(pct)})`);
    } else {
      this.pvDelta.className = 'v';
      this.pvDelta.setText('—');
    }

    // 未实现损益（对比账面余额）
    const pnl = cents - book;
    this.pvPnl.className = `v ${pnl > 0 ? 'up' : pnl < 0 ? 'down' : ''}`;
    this.pvPnl.setText(`${pnl >= 0 ? '+' : ''}${fmtYuan(pnl)}`);

    // 预览行
    setHtml(this.pvLine, `${t('modal.valuation.pv.willWrite')} <b>${line.replace(/</g, '&lt;')}</b>`);
  }

  private async onSave(): Promise<void> {
    const line = this.buildLine();
    if (line == null) {
      new Notice(t('modal.valuation.amountRequired'));
      return;
    }
    // 估值更新直接入账（#2）：不再区分草稿/账本，省去二次确认的心智负担。
    await this.appendLedger(line);
  }

  /** 写入方式 = 账本：追加到账本唯一 fin-beancount 块，并生成 ^v- 块引用。 */
  private async appendLedger(line: string): Promise<void> {
    const refId = generateValuationRefId(this.dateInput.value || undefined);
    const res = await appendEntryToLedgerBlock(this.app, this.plugin.settings.ledgerPath, line, refId);
    if (!res.success) {
      new Notice(t('modal.valuation.error', { error: res.error || '' }));
      return;
    }
    await this.plugin.indexer.updateFile(res.ledgerPath);
    new Notice(t('modal.valuation.success', { ledgerPath: res.ledgerPath }));
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
