/*
 * EntryFormModal —— 复式记账录入表单的「可复用基类」
 *
 * 设计意图（用户要求：两套入口共用同一张表单，改一处两处同步）：
 *   - 加入草稿（AppendDraftToBlockModal）：填完 → 追加到当前 fin-beancount 块的草稿区
 *   - 记一笔（RecordTransactionModal）：填完 → 直接入账到账本文件
 * 两者只是「提交后的行为」不同，表单本身（字段、校验、金额元→分、上次账户记忆）
 * 完全一致。因此所有表单逻辑都收敛到本基类，子类只覆盖三个钩子：
 *   - getSubmitLabel()：提交按钮文案
 *   - showSkip()：是否显示「跳过参数」按钮（记一笔无默认块，必须填 → false）
 *   - onSubmit(blockText)：校验+收集完成后，拿到生成的代码块纯文本，做各自的事
 *
 * 占位语法：{{key}} —— 当 block 有 template 时，用模板替换模式生成代码块文本，
 * 由 buildCodeBlock 统一处理（见 codeBlockDefs.ts）。
 *
 * 复式分录（fin-beancount，block.multiLeg=true）：分录本身是动态的 N 腿结构，
 * 由 type:'legs' 参数驱动的多腿编辑器录入；借贷符号由账户类别推导（界面只填正数金额
 * + 方向标签，不出现 +/- 输入框，见《报告》#2/#6）。
 */

import { Modal, Notice, setIcon } from 'obsidian';
import type { App } from 'obsidian';
import { t } from '../i18n';
import type { BlockDefinitionWithParams, ParamDef } from '../blockProvider';
import { buildCodeBlock } from '../codeBlockDefs';
import type { FinanceConfig } from '../types';
import { resolveAccountClass, legSignedCents, type LegDirection } from '../util/ledgerView';

// ─── 上次使用记忆（来源账户） ──────────────────────────────────

const LAST_ACCOUNT_KEY = 'finance-block:lastExpenseAccount';

function getLastUsedAccount(): string {
  try {
    return localStorage.getItem(LAST_ACCOUNT_KEY) || '';
  } catch {
    return '';
  }
}

function saveLastUsedAccount(account: string): void {
  try {
    localStorage.setItem(LAST_ACCOUNT_KEY, account);
  } catch {
    // ignore
  }
}

/** 金额（元）→ ¥x,xxx.xx */
function formatYuan(yuan: number): string {
  const v = Math.round(yuan * 100) / 100;
  return (
    '¥' +
    v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

// ─── 今日日期 ──────────────────────────────────────────────────

function todayStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 单条腿录入状态（界面只填正数金额 amountYuan + 选择方向 dir，符号由 legSignedCents 推导） */
interface LegRow {
  account: string;
  amountYuan: number;
  dir: LegDirection; // 'in' = 账户余额增加，'out' = 减少
}

// ─── 可复用表单基类 ────────────────────────────────────────────

export abstract class EntryFormModal extends Modal {
  protected block: BlockDefinitionWithParams;
  protected config?: FinanceConfig;
  protected values: Record<string, string> = {};
  protected paramContainer!: HTMLDivElement;
  protected inputs: Record<string, HTMLInputElement | HTMLSelectElement> = {};
  private docMousedownHandler: ((e: MouseEvent) => void) | null = null;

  // 多腿录入状态（仅 block.multiLeg 时使用）
  protected legs: LegRow[] = [];
  private legRows: HTMLElement[] = [];
  private legEditorContainer: HTMLElement | null = null;
  private sharedAmountInput: HTMLInputElement | null = null;
  private statusEl: HTMLElement | null = null;

  constructor(app: App, block: BlockDefinitionWithParams, config?: FinanceConfig) {
    super(app);
    this.block = block;
    this.config = config;
  }

  // ─── 子类覆盖的钩子 ──────────────────────────────────────────

  /** 提交按钮文案 */
  protected abstract getSubmitLabel(): string;

  /** 校验通过、收集完 values 后，拿到生成的代码块纯文本，执行各入口自己的行为 */
  protected abstract onSubmit(blockText: string): void;

  /** 是否显示「跳过参数」按钮（默认 true；记一笔模式无默认块，必须填 → 覆盖为 false） */
  protected showSkip(): boolean {
    return true;
  }

  /** 弹窗标题（默认用 block 名称，保证与「插入代码块」共用同一套文案；记一笔可覆盖为「记一笔」） */
  protected getHeaderTitle(): string {
    return this.block.name;
  }

  /** 弹窗图标（默认用 block 图标） */
  protected getHeaderIcon(): string | undefined {
    return this.block.icon;
  }

  // ─── 生命周期 ────────────────────────────────────────────────

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('finance-insert-param-modal');

    // 标题（图标 + 名称）
    const header = contentEl.createDiv({ cls: 'finance-insert-param-header' });
    const icon = this.getHeaderIcon();
    if (icon) {
      const iconEl = header.createSpan({ cls: 'finance-insert-card-icon' });
      setIcon(iconEl, icon);
    }
    header.createEl('h2', { text: this.getHeaderTitle() });

    if (this.block.description) {
      contentEl.createDiv({ text: this.block.description, cls: 'finance-insert-card-desc' });
    }

    // 参数区
    if (this.block.params.length > 0) {
      const paramTitle = contentEl.createDiv({ cls: 'finance-insert-param-subtitle' });
      paramTitle.textContent = t('modal.insert.param.title');

      this.paramContainer = contentEl.createDiv({ cls: 'finance-insert-params' });
      this.renderParams();
    }

    // 底部按钮行
    const btnRow = contentEl.createDiv({ cls: 'finance-btn-row' });

    if (this.showSkip() && this.block.params.length > 0) {
      const skipBtn = btnRow.createEl('button', { text: t('modal.insert.param.skip') });
      skipBtn.addClass('mod-muted');
      skipBtn.addEventListener('click', () => {
        // 多腿块：跳过也要走完整校验（不能插入零金额的分录）
        if (this.block.multiLeg) {
          this.submitInternal();
        } else {
          this.handleSubmit(buildCodeBlock(this.block, {}));
        }
      });
    }

    const submitBtn = btnRow.createEl('button', { text: this.getSubmitLabel() });
    submitBtn.addClass('mod-cta');
    submitBtn.addEventListener('click', () => {
      this.submitInternal();
    });

    // 统一：点击弹窗外部关闭所有打开的账户下拉（避免多个 combobox 各自维护 handler 的竞态）
    this.docMousedownHandler = (e: MouseEvent) => {
      const target = e.target as Node;
      this.contentEl.querySelectorAll('.finance-combobox.is-open').forEach((el) => {
        const wrap = el as HTMLElement;
        if (!wrap.contains(target)) wrap.classList.remove('is-open');
      });
    };
    document.addEventListener('mousedown', this.docMousedownHandler);
  }

  /** 提交统一入口：子类通过 onSubmit 拿到文本做各自处理 */
  private handleSubmit(text: string): void {
    this.onSubmit(text);
  }

  /** 提交主流程：校验（含多腿零和）→ 收集 → 生成文本 → 提交 */
  private submitInternal(): void {
    if (!this.validateRequired()) return;
    if (this.block.multiLeg) {
      if (!this.validateLegs()) return;
      // 把多腿序列化为 signed cents 的 JSON，交给 buildCodeBlock 的 multiLeg 分支生成文本
      this.values['legs'] = JSON.stringify(
        this.legs.map((l) => ({
          account: l.account.trim(),
          amountCents: legSignedCents(l.account, Math.round(l.amountYuan * 100), l.dir, this.config),
        })),
      );
    }
    this.collectValues();
    const text = buildCodeBlock(this.block, this.values);
    this.handleSubmit(text);
  }

  // ─── 表单渲染（与具体入口无关，完全共用） ────────────────────

  protected renderParams(): void {
    this.paramContainer.empty();
    const lastAccount = getLastUsedAccount();

    // 预处理：把连续的非 legs 参数按 (date + select) 配对成行，其余各自独立一行。
    // 这样 fin-beancount 的「日期 + 交易类型」会并列在第一行，归属第二行，摘要第三行。
    const nonLegs = this.block.params.filter((p) => p.type !== 'legs');
    const legsParam = this.block.params.find((p) => p.type === 'legs') ?? null;

    type RowGroup = { items: ParamDef[] };
    const groups: RowGroup[] = [];
    let ni = 0;
    while (ni < nonLegs.length) {
      const cur = nonLegs[ni];
      const next = nonLegs[ni + 1];
      if (
        cur.type === 'date' &&
        next &&
        next.type === 'select' &&
        next.optionsFrom !== 'accounts'
      ) {
        groups.push({ items: [cur, next] });
        ni += 2;
      } else {
        groups.push({ items: [cur] });
        ni += 1;
      }
    }

    for (const group of groups) {
      if (group.items.length > 1) {
        const rowWrap = this.paramContainer.createDiv({ cls: 'finance-field-row' });
        for (const item of group.items) {
          this.renderSingleParam(rowWrap, item);
        }
      } else {
        this.renderSingleParam(this.paramContainer, group.items[0]);
      }
    }

    // legs 编辑器
    if (legsParam) {
      const field = this.paramContainer.createDiv({ cls: 'finance-field' });
      const labelRow = field.createDiv({ cls: 'finance-insert-param-label' });
      labelRow.createSpan({ text: legsParam.label });
      if (legsParam.optional !== false) {
        const optTag = labelRow.createSpan({ text: t('modal.insert.param.optional') });
        optTag.addClass('finance-insert-param-optional');
      }
      if (legsParam.description) {
        field.createDiv({ text: legsParam.description, cls: 'finance-insert-param-hint' });
      }
      const editor = field.createDiv({ cls: 'fb-legs' });
      if (this.legs.length === 0) {
        this.legs = [
          { account: lastAccount || '现金', amountYuan: 0, dir: 'out' },
          { account: '日常', amountYuan: 0, dir: 'in' },
        ];
      }
      this.renderLegsEditor(editor);
    }
  }

  /** 渲染单个参数字段到指定父容器（从 renderParams 抽出，支持行内分组） */
  private renderSingleParam(
    parent: HTMLElement,
    p: ParamDef,
  ): void {
    const row = parent.createDiv({ cls: 'finance-field' });

    const labelRow = row.createDiv({ cls: 'finance-insert-param-label' });
    labelRow.createSpan({ text: p.label });
    if (p.optional !== false) {
      const optTag = labelRow.createSpan({ text: t('modal.insert.param.optional') });
      optTag.addClass('finance-insert-param-optional');
    }

    if (p.description) {
      row.createDiv({ text: p.description, cls: 'finance-insert-param-hint' });
    }

      if (p.type === 'date') {
        // 日期输入：仅记账类字段自动填今日（autoToday）。
        // 筛选类日期（如 finance-log 的起始日）必须留空，否则会把「滚动窗口」写死成插入当天。
        const input = row.createEl('input', {
          type: 'date',
          cls: 'finance-input',
        });
        if (p.autoToday) input.value = todayStr();
        this.inputs[p.key] = input;
      } else if (p.type === 'amount') {
        // 引导式金额筛选：运算符下拉 + 数字框（「之间」时显示两个框）。
        // 组合结果写入隐藏 input（如 ">100" / "100-200"），与 log.ts 的 parseAmountFilter 完全对齐；
        // 隐藏框作为 p.key 的值，collectValues 不再做元→分换算（type 已非 'number'）。
        const control = row.createDiv({ cls: 'amount-range-control' });

        const opSelect = control.createEl('select', { cls: 'finance-select' });
        const opMap: Array<[string, string]> = [
          ['gt', 'param.amount.op.gt'],
          ['gte', 'param.amount.op.gte'],
          ['lt', 'param.amount.op.lt'],
          ['lte', 'param.amount.op.lte'],
          ['between', 'param.amount.op.between'],
          ['eq', 'param.amount.op.eq'],
        ];
        for (const [val, key] of opMap) {
          opSelect.createEl('option', { value: val, text: t(key) });
        }

        const singleWrap = control.createSpan({ cls: 'amount-num' });
        const singleNum = singleWrap.createEl('input', { type: 'number', cls: 'finance-input' });
        singleNum.setAttribute('step', '0.01');
        singleNum.setAttribute('inputmode', 'decimal');
        if (p.placeholder) singleNum.placeholder = p.placeholder;

        const betweenWrap = control.createSpan({ cls: 'amount-num' });
        betweenWrap.style.display = 'none';
        const numA = betweenWrap.createEl('input', { type: 'number', cls: 'finance-input' });
        numA.setAttribute('step', '0.01');
        numA.setAttribute('inputmode', 'decimal');
        if (p.placeholder) numA.placeholder = p.placeholder;
        betweenWrap.createSpan({ text: ' ~ ' });
        const numB = betweenWrap.createEl('input', { type: 'number', cls: 'finance-input' });
        numB.setAttribute('step', '0.01');
        numB.setAttribute('inputmode', 'decimal');
        if (p.placeholder) numB.placeholder = p.placeholder;

        const hidden = row.createEl('input', { type: 'hidden' });

        const recompute = (): void => {
          const op = opSelect.value;
          let composed = '';
          if (op === 'between') {
            const a = numA.value.trim();
            const b = numB.value.trim();
            if (a && b) composed = `${a}-${b}`;
          } else {
            const n = singleNum.value.trim();
            if (n) {
              if (op === 'gt') composed = `>${n}`;
              else if (op === 'gte') composed = `>=${n}`;
              else if (op === 'lt') composed = `<${n}`;
              else if (op === 'lte') composed = `<=${n}`;
              else composed = n; // eq：精确等于
            }
          }
          hidden.value = composed;
        };

        opSelect.addEventListener('change', () => {
          const isBetween = opSelect.value === 'between';
          betweenWrap.style.display = isBetween ? '' : 'none';
          singleWrap.style.display = isBetween ? 'none' : '';
          recompute();
        });
        singleNum.addEventListener('input', recompute);
        numA.addEventListener('input', recompute);
        numB.addEventListener('input', recompute);

        this.inputs[p.key] = hidden;
      } else if (p.type === 'select' && p.optionsFrom === 'accounts') {
        // ── 账户可编辑下拉框（combobox） ────────────────────────
        // 既有候选列表可选，又支持手打新账户名。
        // 不用 <select>（不可编辑）、不用 <datalist>（原生弹出层白色+不可样式化）。
        const { wrapper, input } = this.createCombobox(p.defaultValue ?? '', 'accounts');
        row.appendChild(wrapper);
        this.inputs[p.key] = input;
      } else if (p.type === 'select') {
        // 普通 select（交易类型、归属等非账户字段，不需要可编辑）
        const select = row.createEl('select', { cls: 'finance-select' });
        select.createEl('option', { value: '', text: '—' });

        const dynamic = this.resolveDynamicOptions(p.optionsFrom);
        const options = dynamic?.options ?? p.options ?? [];
        const optionLabels = dynamic?.labels ?? p.optionLabels ?? {};

        for (const opt of options) {
          const label = optionLabels[opt] ?? opt;
          select.createEl('option', { value: opt, text: label });
        }
        if (p.defaultValue) select.value = p.defaultValue;
        this.inputs[p.key] = select;
      } else {
        // text / number / 以及未知类型（如跨插件的 'exercise' 等）均 fallback 为文本输入
        const isNumber = p.type === 'number';
        const input = row.createEl('input', {
          type: isNumber ? 'number' : 'text',
          cls: 'finance-input',
        });
        if (isNumber) {
          // 金额字段：支持两位小数（元→分转换在 collectValues 中处理）
          const isAmount = p.key === 'amount';
          input.setAttribute('step', isAmount ? '0.01' : 'any');
          input.setAttribute('inputmode', isAmount ? 'decimal' : 'numeric');
          if (isAmount) {
            // 限制最多两位小数
            input.addEventListener('blur', () => {
              const v = parseFloat(input.value);
              if (!isNaN(v)) {
                input.value = String(Math.round(v * 100) / 100); // 四舍五入到2位小数
              }
            });
          }
        }
        if (p.placeholder) input.placeholder = p.placeholder;
        if (p.defaultValue) input.value = p.defaultValue;
        this.inputs[p.key] = input;
      }
  }

  /**
   * 可编辑下拉框（combobox）构造器：账户选择等场景复用。
   * 返回 { wrapper, input }；wrapper 负责样式与下拉面板，input 为实际取值元素。
   * 下拉关闭由 onOpen 统一安装的 document mousedown 监听器处理（关闭所有打开的面板）。
   */
  private createCombobox(
    initialValue: string,
    source: 'accounts',
  ): { wrapper: HTMLDivElement; input: HTMLInputElement } {
    const dynamic = this.resolveDynamicOptions(source);
    const allOptions = dynamic?.options ?? [];
    const optionLabels = dynamic?.labels ?? {};

    const wrapper = document.createElement('div');
    wrapper.className = 'finance-combobox';
    const input = wrapper.createEl('input', {
      type: 'text',
      cls: 'finance-input finance-combobox-input',
      attr: { autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' },
    });
    if (initialValue) input.value = initialValue;

    // 下拉箭头按钮
    const toggleBtn = wrapper.createEl('button', {
      cls: 'finance-combobox-toggle',
      attr: { type: 'button', tabindex: '-1', 'aria-label': 'Toggle dropdown' },
    });

    // 自定义下拉面板（非原生 select/datalist）
    const dropdown = wrapper.createDiv({ cls: 'finance-combobox-dropdown' });

    let isOpen = false;
    let highlightIdx = -1;
    let filteredOptions: string[] = [];

    /** 根据当前输入值过滤并渲染下拉选项 */
    const renderDropdown = (): void => {
      dropdown.empty();
      const query = input.value.trim().toLowerCase();
      filteredOptions = query
        ? allOptions.filter((o) => o.toLowerCase().includes(query))
        : [...allOptions];
      highlightIdx = -1;

      if (filteredOptions.length === 0) {
        dropdown.createDiv({ cls: 'finance-combobox-empty', text: t('modal.combobox.noMatch') ?? '无匹配项' });
        return;
      }

      for (const opt of filteredOptions) {
        const item = dropdown.createDiv({
          cls: 'finance-combobox-option',
          text: optionLabels[opt] ?? opt,
          attr: { 'data-value': opt },
        });
        item.addEventListener('mousedown', (e) => {
          e.preventDefault(); // 防止 blur 抢先关闭
          input.value = opt;
          input.dispatchEvent(new Event('input')); // 触发腿行刷新（方向标签随账户更新）
          closeDropdown();
          saveLastUsedAccount(opt);
        });
      }
    };

    /** 打开下拉 */
    const openDropdown = (): void => {
      renderDropdown();
      dropdown.classList.add('is-open');
      isOpen = true;
    };

    /** 关闭下拉 */
    const closeDropdown = (): void => {
      dropdown.classList.remove('is-open');
      isOpen = false;
      highlightIdx = -1;
    };

    /** 切换下拉开关状态 */
    const toggleDropdown = (): void => {
      if (isOpen) closeDropdown();
      else {
        input.focus();
        openDropdown();
      }
    };

    /** 高亮某一项（键盘导航） */
    const highlightItem = (idx: number): void => {
      const items = dropdown.querySelectorAll('.finance-combobox-option');
      items.forEach((el) => el.removeClass('is-highlighted'));
      if (idx >= 0 && idx < items.length) {
        items[idx].addClass('is-highlighted');
        items[idx].scrollIntoView({ block: 'nearest' });
      }
      highlightIdx = idx;
    };

    // 事件绑定：输入框
    input.addEventListener('focus', () => openDropdown());
    input.addEventListener('input', () => {
      if (isOpen) renderDropdown();
    });
    input.addEventListener('keydown', (e) => {
      if (!isOpen) {
        if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openDropdown();
        }
        return;
      }
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          highlightItem(Math.min(highlightIdx + 1, filteredOptions.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          highlightItem(Math.max(highlightIdx - 1, 0));
          break;
        case 'Enter':
          e.preventDefault();
          if (highlightIdx >= 0 && highlightIdx < filteredOptions.length) {
            input.value = filteredOptions[highlightIdx];
            input.dispatchEvent(new Event('input')); // 触发腿行刷新
            saveLastUsedAccount(input.value);
          }
          closeDropdown();
          break;
        case 'Escape':
          e.preventDefault();
          closeDropdown();
          break;
      }
    });

    // 事件绑定：箭头按钮
    toggleBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      toggleDropdown();
    });

    return { wrapper, input };
  }

  /**
   * 按声明的数据源从 vault 配置取下拉选项。
   * 返回 undefined 表示「该数据源不可用」，由调用方回落到静态 options。
   */
  protected resolveDynamicOptions(
    source: string | undefined,
  ): { options: string[]; labels: Record<string, string> } | undefined {
    if (!source || !this.config) return undefined;

    const build = (values: string[], label: (v: string) => string) => {
      if (values.length === 0) return undefined;
      const labels: Record<string, string> = {};
      for (const v of values) labels[v] = label(v);
      return { options: values, labels };
    };

    switch (source) {
      case 'accounts': {
        const accounts = this.config.accounts ?? [];
        const iconOf = new Map(accounts.map((a) => [a.name, a.icon]));
        return build(
          accounts.map((a) => a.name),
          (v) => (iconOf.get(v) ? `${iconOf.get(v)} ${v}` : v),
        );
      }
      case 'transactionTypes':
        return build((this.config.transactionTypes ?? []).map((tt) => tt.name), (v) => v);
      case 'owners':
        return build(this.config.owners ?? [], (v) => v);
      default:
        return undefined;
    }
  }

  // ─── 多腿录入编辑器 ──────────────────────────────────────────

  /** 渲染整个多腿编辑器到 container */
  private renderLegsEditor(container: HTMLElement): void {
    this.legEditorContainer = container;
    this.legRows = [];
    this.sharedAmountInput = null;
    container.empty();

    const isSimple = this.legs.length <= 2;

    // 简易模式（2 腿）：单一共享金额字段，两条分录金额自动相等
    if (isSimple) {
      const sharedField = container.createDiv({ cls: 'finance-field' });
      const lbl = sharedField.createEl('label');
      lbl.textContent = t('legs.amount');
      lbl.createSpan({ cls: 'finance-insert-param-optional', text: ` ${t('legs.amountHint')}` });
      const shared = sharedField.createEl('input', {
        type: 'number',
        cls: 'finance-input',
        attr: { min: '0', step: '0.01', inputmode: 'decimal' },
      });
      shared.placeholder = '35.00';
      shared.value = this.legs[0] && this.legs[0].amountYuan ? String(this.legs[0].amountYuan) : '';
      this.sharedAmountInput = shared;
      shared.addEventListener('input', () => {
        const v = parseFloat(shared.value) || 0;
        this.legs.forEach((l) => (l.amountYuan = v));
        this.legRows.forEach((row) => {
          const m = row.querySelector('[data-leg-mirror]');
          if (m) m.textContent = formatYuan(v);
        });
        this.refreshStatus();
      });
    }

    // 每条腿
    this.legs.forEach((leg, i) => {
      const row = container.createDiv({ cls: 'fb-leg' });
      this.legRows.push(row);
      row.dataset.index = String(i);

      const head = row.createDiv({ cls: 'fb-leg-head' });
      head.createSpan({ cls: 'fb-leg-num', text: String(i + 1) });
      head.createSpan({ cls: 'fb-leg-label' });
      const pill = head.createEl('button', {
        cls: 'fb-leg-dir',
        attr: { type: 'button', 'aria-label': t('legs.flip'), title: t('legs.flip') },
        text: t('legs.dir.in'),
      });
      pill.addEventListener('click', () => this.flipLegDir(i));
      if (!isSimple) {
        const del = head.createEl('button', {
          cls: 'fb-leg-del',
          text: t('legs.remove'),
          attr: { type: 'button', 'aria-label': t('legs.remove') },
        });
        del.addEventListener('click', () => this.deleteLeg(i));
      }

      const grid = row.createDiv({ cls: 'fb-leg-grid' });

      const accField = grid.createDiv({ cls: 'finance-field' });
      accField.createEl('label', { text: t('legs.account') });
      const { wrapper, input } = this.createCombobox(leg.account, 'accounts');
      input.setAttribute('data-leg-account', '');
      accField.appendChild(wrapper);
      input.addEventListener('input', () => {
        leg.account = input.value;
        this.refreshLegRow(row, i);
        this.refreshStatus();
      });

      const amtField = grid.createDiv({ cls: 'finance-field' });
      amtField.createEl('label', { text: t('legs.amount') });
      if (!isSimple) {
        const amt = amtField.createEl('input', {
          type: 'number',
          cls: 'finance-input',
          attr: { 'data-leg-amount': '', min: '0', step: '0.01', inputmode: 'decimal' },
        });
        amt.placeholder = '0.00';
        amt.value = leg.amountYuan ? String(leg.amountYuan) : '';
        amt.addEventListener('input', () => {
          leg.amountYuan = parseFloat(amt.value) || 0;
          this.refreshStatus();
        });
      } else {
        const mirror = amtField.createDiv({ cls: 'fb-leg-amount-mirror' });
        mirror.setAttribute('data-leg-mirror', '');
        mirror.createSpan({ cls: 'fb-amt-val', text: formatYuan(leg.amountYuan || 0) });
        mirror.createSpan({ cls: 'fb-amt-note', text: t('legs.mirrorNote') });
      }

      this.refreshLegRow(row, i);
    });

    // 操作按钮行
    const actions = container.createDiv({ cls: 'fb-leg-actions' });
    const addBtn = actions.createEl('button', {
      cls: 'fb-addleg',
      text: t('legs.add'),
      attr: { type: 'button' },
    });
    addBtn.addEventListener('click', () => this.addLeg());

    // 状态 + 一键补平
    this.statusEl = container.createDiv({ cls: 'fb-leg-status' });
    this.refreshStatus();
  }

  /** 刷新单条腿的「账户类别标签 + 方向标签」 */
  private refreshLegRow(row: HTMLElement, i: number): void {
    const leg = this.legs[i];
    if (!leg) return;
    const info = legDirInfo(leg.account, leg.dir, this.config);
    const pill = row.querySelector('.fb-leg-dir') as HTMLElement | null;
    if (pill) {
      pill.className = `fb-leg-dir ${info.cls}`;
      pill.textContent = info.label;
    }
    const label = row.querySelector('.fb-leg-label') as HTMLElement | null;
    if (label) label.textContent = this.accountClassLabel(leg.account);
  }

  /** 刷新底部状态（已平衡 / 未平衡 + 一键补平） */
  private refreshStatus(): void {
    if (!this.statusEl) return;
    const sum = this.legSumCents();
    this.statusEl.empty();
    if (sum === 0) {
      this.statusEl.createSpan({ cls: 'fb-leg-status-ok', text: `✓ ${t('legs.balanced')}` });
    } else {
      const diffYuan = Math.abs(sum) / 100;
      const diffText = diffYuan.toLocaleString('zh-CN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      this.statusEl.createSpan({
        cls: 'fb-leg-status-warn',
        text: t('legs.unbalanced', { diff: diffText }),
      });
      const btn = this.statusEl.createEl('button', {
        cls: 'fb-balance-btn',
        text: t('legs.balance'),
        attr: { type: 'button' },
      });
      btn.addEventListener('click', () => this.autoBalance());
    }
  }

  /** 当前所有腿的 signed cents 之和 */
  private legSumCents(): number {
    return this.legs.reduce(
      (s, l) => s + legSignedCents(l.account, Math.round(l.amountYuan * 100), l.dir, this.config),
      0,
    );
  }

  /** 把输入框的当前值同步回 this.legs（提交/校验前调用，避免状态滞后） */
  private syncLegsFromUI(): void {
    this.legs.forEach((leg, i) => {
      const row = this.legRows[i];
      if (!row) return;
      const acc = row.querySelector('[data-leg-account]') as HTMLInputElement | null;
      if (acc) leg.account = acc.value;
      const amt = row.querySelector('[data-leg-amount]') as HTMLInputElement | null;
      if (amt) leg.amountYuan = parseFloat(amt.value) || 0;
      else if (this.sharedAmountInput) leg.amountYuan = parseFloat(this.sharedAmountInput.value) || 0;
    });
  }

  /** 反转第 i 条腿的方向（流入 ↔ 流出） */
  private flipLegDir(i: number): void {
    const leg = this.legs[i];
    if (!leg) return;
    leg.dir = leg.dir === 'in' ? 'out' : 'in';
    const row = this.legRows[i];
    if (row) this.refreshLegRow(row, i);
    this.refreshStatus();
  }

  /** 新增一条腿（进入拆分模式） */
  private addLeg(): void {
    this.syncLegsFromUI();
    this.legs.push({ account: '', amountYuan: 0, dir: 'out' });
    if (this.legEditorContainer) this.renderLegsEditor(this.legEditorContainer);
  }

  /** 删除第 i 条腿（仅拆分模式，最少保留 2 条） */
  private deleteLeg(i: number): void {
    if (this.legs.length <= 2) return;
    this.legs.splice(i, 1);
    // 回到 2 腿简易模式时，把两条金额对齐为同一共享值，避免镜像显示不一致
    if (this.legs.length === 2) {
      this.legs[1].amountYuan = this.legs[0].amountYuan;
    }
    if (this.legEditorContainer) this.renderLegsEditor(this.legEditorContainer);
  }

  /** 一键补平：自动生成差额腿（收益/亏损） */
  private autoBalance(): void {
    this.syncLegsFromUI();
    const sum = this.legSumCents();
    if (sum === 0) return;
    const diff = -sum; // 使总和归零所需的差额（signed cents）
    const amountYuan = Math.abs(diff) / 100;
    if (sum > 0) {
      // 需贷方补（负）：收入类账户，dir='in' → 自然增记号为负 → 实现收益
      this.legs.push({ account: '投资收益', amountYuan, dir: 'in' });
    } else {
      // 需借方补（正）：亏损类账户，dir='in' → 自然增记号为正 → 实现亏损
      this.legs.push({ account: '投资亏损', amountYuan, dir: 'in' });
    }
    if (this.legEditorContainer) this.renderLegsEditor(this.legEditorContainer);
  }

  /** 账户名 → 类别中文标签（用于腿头展示） */
  private accountClassLabel(account: string): string {
    const cls = resolveAccountClass(account, this.config);
    const map: Record<string, string> = {
      asset: t('legs.class.asset'),
      liability: t('legs.class.liability'),
      equity: t('legs.class.equity'),
      income: t('legs.class.income'),
      expense: t('legs.class.expense'),
    };
    return cls ? (map[cls] ?? t('legs.class.account')) : t('legs.class.account');
  }

  // ─── 校验与收集（与具体入口无关，完全共用） ──────────────────

  protected validateRequired(): boolean {
    for (const p of this.block.params) {
      if (p.type === 'legs') continue; // 多腿由 validateLegs 单独校验
      if (p.optional === false) {
        const el = this.inputs[p.key];
        if (!el || !el.value.trim()) {
          new Notice(`${t(p.labelKey ?? p.label)}${t('modal.insert.param.requiredHint')}`);
          el?.focus();
          return false;
        }
      }
    }
    return true;
  }

  /** 多腿校验：≥2 腿、每条都有账户与正数金额、零和 */
  private validateLegs(): boolean {
    this.syncLegsFromUI();
    if (this.legs.length < 2) {
      new Notice(t('legs.needTwo'));
      return false;
    }
    for (const l of this.legs) {
      if (!l.account || !l.account.trim()) {
        new Notice(t('legs.needAccount'));
        return false;
      }
      if (!(l.amountYuan > 0)) {
        new Notice(t('legs.needAmount'));
        return false;
      }
    }
    if (this.legSumCents() !== 0) {
      const diffYuan = Math.abs(this.legSumCents()) / 100;
      new Notice(
        t('legs.unbalanced', {
          diff: diffYuan.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        }),
      );
      return false;
    }
    return true;
  }

  protected collectValues(): void {
    for (const p of this.block.params) {
      if (p.type === 'legs') continue; // 已由 submitInternal 写入 values['legs']
      const el = this.inputs[p.key];
      if (!el) continue;
      let val = el.value;

      // 金额字段：用户输入元（如 35.00），转换为整数分存储。
      // 必须同时限定 type==='number'：finance-log 的 amount 是筛选表达式（如 ">100"），
      // 走文本输入，绝不能被当成金额做元→分换算。
      if (p.key === 'amount' && p.type === 'number' && val.trim()) {
        const yuan = parseFloat(val);
        if (!isNaN(yuan)) {
          val = String(Math.round(yuan * 100)); // 元→分，四舍五入到整数
        }
      }

      this.values[p.key] = val;

      // 记住上次使用的支出账户（fromAccount / toAccount 统一记忆，不依赖 type 字段）
      if ((p.key === 'fromAccount' || p.key === 'toAccount') && el.value) {
        saveLastUsedAccount(el.value);
      }
    }
  }

  onClose(): void {
    if (this.docMousedownHandler) {
      document.removeEventListener('mousedown', this.docMousedownHandler);
      this.docMousedownHandler = null;
    }
    this.contentEl.empty();
  }
}

/**
 * 单条腿的方向标签：由账户类别 + 方向推导（流入/流出/来源/去向/权益）。
 * 与 ledgerView.dirOfPost 的用词一致，但本函数面向「录入方向」维度。
 */
function legDirInfo(
  account: string,
  dir: LegDirection,
  config?: FinanceConfig,
): { label: string; cls: string } {
  const cls = resolveAccountClass(account, config);
  let key: string;
  if (cls === 'income') key = dir === 'in' ? 'legs.dir.src' : 'legs.dir.sink';
  else if (cls === 'expense') key = dir === 'in' ? 'legs.dir.sink' : 'legs.dir.src';
  else if (cls === 'asset' || cls === 'liability' || cls === 'equity')
    key = dir === 'in' ? 'legs.dir.in' : 'legs.dir.out';
  else key = 'legs.dir.flat';
  return { label: t(key), cls: key.split('.').pop() ?? 'flat' };
}
