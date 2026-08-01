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
 */

import { Modal, Notice, setIcon } from 'obsidian';
import type { App } from 'obsidian';
import { t } from '../i18n';
import type { BlockDefinitionWithParams } from '../blockProvider';
import { buildCodeBlock } from '../codeBlockDefs';
import type { FinanceConfig } from '../types';

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

// ─── 今日日期 ──────────────────────────────────────────────────

function todayStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ─── 可复用表单基类 ────────────────────────────────────────────

export abstract class EntryFormModal extends Modal {
  protected block: BlockDefinitionWithParams;
  protected config?: FinanceConfig;
  protected values: Record<string, string> = {};
  protected paramContainer!: HTMLDivElement;
  protected inputs: Record<string, HTMLInputElement | HTMLSelectElement> = {};

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
        this.handleSubmit(buildCodeBlock(this.block, {}));
      });
    }

    const submitBtn = btnRow.createEl('button', { text: this.getSubmitLabel() });
    submitBtn.addClass('mod-cta');
    submitBtn.addEventListener('click', () => {
      if (!this.validateRequired()) return;
      this.collectValues();
      const text = buildCodeBlock(this.block, this.values);
      this.handleSubmit(text);
    });
  }

  /** 提交统一入口：子类通过 onSubmit 拿到文本做各自处理 */
  private handleSubmit(text: string): void {
    this.onSubmit(text);
  }

  // ─── 表单渲染（与具体入口无关，完全共用） ────────────────────

  protected renderParams(): void {
    this.paramContainer.empty();
    const lastAccount = getLastUsedAccount();

    for (const p of this.block.params) {
      const row = this.paramContainer.createDiv({ cls: 'finance-field' });

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
      } else if (p.type === 'account') {
        // 账户输入：input + datalist 组合（可搜索、可编辑、可手打新名称）
        const listId = `fb-datalist-${p.key}-${Date.now()}`;
        const datalist = row.createEl('datalist', { attr: { id: listId } });

        const accounts = this.config?.accounts ?? [];
        for (const acc of accounts) {
          const icon = acc.icon ? `${acc.icon} ` : '';
          datalist.createEl('option', { value: acc.name, attr: { label: `${icon}${acc.name}` } });
        }

        const input = row.createEl('input', {
          type: 'text',
          cls: 'finance-input',
          attr: { list: listId, autocomplete: 'off' },
        });
        if (p.placeholder) input.placeholder = p.placeholder;

        // 默认填入上次使用的支出账户
        if (lastAccount && accounts.some((a) => a.name === lastAccount)) {
          input.value = lastAccount;
        }

        input.addEventListener('change', () => {
          if (input.value) saveLastUsedAccount(input.value);
        });

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
      } else if (p.type === 'select') {
        const select = row.createEl('select', { cls: 'finance-select' });
        select.createEl('option', { value: '', text: '—' });

        // 动态选项：由参数定义显式声明数据源（optionsFrom），从 vault 配置实时取值。
        // 取不到配置时回落到定义里的静态 options，保证弹窗永远不会出现空下拉。
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

  // ─── 校验与收集（与具体入口无关，完全共用） ──────────────────

  protected validateRequired(): boolean {
    for (const p of this.block.params) {
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

  protected collectValues(): void {
    for (const p of this.block.params) {
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

      // 记住上次使用的支出账户
      if (p.type === 'account' && el.value) {
        saveLastUsedAccount(el.value);
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
