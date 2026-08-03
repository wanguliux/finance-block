import { Modal, Notice, TextComponent } from 'obsidian';
import type FinancePlugin from '../main';
import type { AmountInCents, LifeEventDef, LifeEventType } from '../types';
import { t } from '../i18n';
import { confirmWithModal } from './Confirm';
import { PathSuggest } from './PathSuggest';
import { currencySymbol, buildSymbolMap } from '../engine/fx';

/*
 * LifeEventManagerModal —— "人生事件"弹窗（阶段三 事件模拟器）。
 *
 * 列出所有人生事件（名称 + 类型徽章 + 触发年龄 + 财务影响摘要），每条可「启用 / 编辑 / 删除」。
 * 点「新增事件」打开 LifeEventEditModal（名称 / 类型 / 年龄 / 五项财务影响 / 关联笔记）。
 * 数据持久化在 vault 的 finance-config.json（FinanceConfig.lifeEvents）——
 * 人生事件是全局唯一真相（一个人只有一套人生规划），所有 finance-ficalc 块共享同一份。
 *
 * 事件按触发年龄升序展示，与生命周期图的时间轴顺序一致。
 * 「启用」开关允许临时关掉某个事件而不删除，便于做"有无此事件"的对比推演。
 */

/** 事件类型的下拉选项顺序（与 i18n 键 event.type.* 对应） */
const EVENT_TYPES: LifeEventType[] = ['house', 'child', 'marriage', 'windfall', 'career', 'custom'];

/** 财务影响字段定义：驱动编辑表单渲染与保存时的收集，避免五处重复代码 */
const IMPACT_FIELDS = [
  { key: 'oneOff', labelKey: 'modal.event.oneOff', descKey: 'modal.event.oneOff.desc' },
  { key: 'deltaSpend', labelKey: 'modal.event.deltaSpend', descKey: 'modal.event.deltaSpend.desc' },
  { key: 'deltaIncome', labelKey: 'modal.event.deltaIncome', descKey: 'modal.event.deltaIncome.desc' },
  { key: 'deltaFixed', labelKey: 'modal.event.deltaFixed', descKey: 'modal.event.deltaFixed.desc' },
  { key: 'deltaLiability', labelKey: 'modal.event.deltaLiability', descKey: 'modal.event.deltaLiability.desc' },
] as const;

type ImpactKey = (typeof IMPACT_FIELDS)[number]['key'];

export class LifeEventManagerModal extends Modal {
  private plugin: FinancePlugin;
  private listContainer!: HTMLDivElement;
  /** 弹窗关闭时回调，供 finance-ficalc 块在事件变更后重算刷新 */
  private onChanged?: () => void;

  constructor(plugin: FinancePlugin, onChanged?: () => void) {
    super(plugin.app);
    this.plugin = plugin;
    this.onChanged = onChanged;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('fb-modal');

    // 保证「退休」事件始终存在且可管理（旧配置可能缺此种子，这里补种一次）
    this.ensureRetire();

    contentEl.createEl('h2', { text: t('modal.event.title') });
    contentEl.createEl('p', { text: t('modal.event.intro'), cls: 'fb-meta' });

    const topToolbar = contentEl.createDiv();
    topToolbar.addClass('fb-btn-row');
    topToolbar.setCssStyles({ justifyContent: 'flex-start' });
    const addBtn = topToolbar.createEl('button', { text: t('modal.event.add') });
    addBtn.addClass('mod-cta');
    addBtn.addEventListener('click', () => this.openEdit());

    this.listContainer = contentEl.createDiv();
    this.listContainer.addClass('fb-list');
    this.renderEvents();

    const btnRow = contentEl.createDiv();
    btnRow.addClass('fb-btn-row');
    const closeBtn = btnRow.createEl('button', { text: t('common.close') });
    closeBtn.addClass('mod-muted');
    closeBtn.addEventListener('click', () => this.close());
  }

  private renderEvents(): void {
    this.listContainer.empty();
    const events = this.getEvents();

    if (events.length === 0) {
      this.listContainer.createEl('p', { text: t('modal.event.noData') });
      return;
    }

    // 按触发年龄升序，与生命周期图时间轴一致
    const sorted = [...events].sort((a, b) => a.age - b.age);
    const symbol = this.baseSymbol();

    for (const ev of sorted) {
      const row = this.listContainer.createDiv();
      row.addClass('fb-card', 'fb-event-card');
      if (!ev.enabled) row.addClass('is-disabled');

      const infoCol = row.createDiv();
      infoCol.addClass('fb-info');

      const titleRow = infoCol.createDiv();
      titleRow.addClass('fb-title');
      titleRow.createSpan({ text: ev.label });
      const badge = titleRow.createSpan({ text: t(`event.type.${ev.type}`) });
      badge.addClass('fb-badge', `ev-${ev.type}`);
      if (ev.note) {
        const noteBadge = titleRow.createSpan({ text: t('modal.event.hasNote') });
        noteBadge.addClass('fb-badge');
        noteBadge.setAttribute('title', ev.note);
      }

      const summary = this.impactSummary(ev, symbol);
      infoCol.createDiv({
        text: `${t('modal.event.atAge', { n: String(ev.age) })}${summary ? ' · ' + summary : ''}`,
        cls: 'fb-meta',
      });

      const btnCol = row.createDiv();
      btnCol.addClass('fb-actions');

      // 启用开关：临时关掉事件而不删除，用于「有无此事件」对比推演
      const toggleBtn = btnCol.createEl('button', {
        text: ev.enabled ? t('modal.event.enabled') : t('modal.event.disabled'),
      });
      toggleBtn.addClass('fb-action-btn');
      if (!ev.enabled) toggleBtn.addClass('is-off');
      toggleBtn.addEventListener('click', () => void this.toggle(ev.id));

      const editBtn = btnCol.createEl('button', { text: t('common.edit') });
      editBtn.addClass('fb-action-btn');
      editBtn.addEventListener('click', () => this.openEdit(ev.id));

      // 退休事件不可删除（由系统管理）
      if (ev.type !== 'retire') {
        const deleteBtn = btnCol.createEl('button', { text: t('common.delete') });
        deleteBtn.addClass('fb-danger-btn');
        deleteBtn.addEventListener('click', () => void this.delete(ev.id));
      }
    }
  }

  /** 财务影响摘要：只列出非零项，形如「一次性 -¥80万 · 负债 +¥240万」 */
  private impactSummary(ev: LifeEventDef, symbol: string): string {
    const parts: string[] = [];
    for (const f of IMPACT_FIELDS) {
      const cents = ev[f.key as ImpactKey];
      if (!cents) continue;
      const sign = cents > 0 ? '+' : '−';
      const wan = Math.abs(cents) / 1_000_000; // 分 → 万元
      const num = wan >= 1 ? wan.toFixed(wan >= 10 ? 0 : 1) + t('ficalc.unit.wan') : (Math.abs(cents) / 100).toFixed(0);
      parts.push(`${t(f.labelKey)} ${sign}${symbol}${num}`);
    }
    return parts.join(' · ');
  }

  private openEdit(id?: string): void {
    const editModal = new LifeEventEditModal(this.plugin, id);
    editModal.onClose = () => {
      this.renderEvents();
      this.onChanged?.();
    };
    editModal.open();
  }

  private async toggle(id: string): Promise<void> {
    const target = this.plugin.config.lifeEvents.find((e) => e.id === id);
    if (!target) return;
    target.enabled = !target.enabled;
    await this.plugin.configManager.save();
    this.renderEvents();
    this.onChanged?.();
  }

  private async delete(id: string): Promise<void> {
    const ev = this.plugin.config.lifeEvents.find((e) => e.id === id);
    if (!ev) return;
    if (!(await confirmWithModal(this.app, t('modal.event.confirmDelete', { name: ev.label })))) {
      return;
    }
    this.plugin.config.lifeEvents = this.plugin.config.lifeEvents.filter((e) => e.id !== id);
    await this.plugin.configManager.save();
    new Notice(t('modal.event.deleted'));
    this.renderEvents();
    this.onChanged?.();
  }

  private getEvents(): LifeEventDef[] {
    return this.plugin.config.lifeEvents ?? [];
  }

  /** 确保「退休」事件存在：旧配置若缺这个特殊事件，补种一次（幂等、可管理、不可删除） */
  private ensureRetire(): void {
    const list = this.plugin.config.lifeEvents ?? (this.plugin.config.lifeEvents = []);
    if (list.some((e) => e.type === 'retire')) return;
    list.unshift({ id: 'retire', label: t('event.type.retire'), type: 'retire', age: 60, enabled: true });
    void this.plugin.configManager.save().catch((err) => {
      console.error('[finance-block] seed retire event failed:', err);
    });
  }

  private baseSymbol(): string {
    const base = this.plugin.config.baseCurrency ?? 'CNY';
    return currencySymbol(base, buildSymbolMap(this.plugin.config.currencies));
  }

  onClose(): void {
    this.contentEl.empty();
    this.onChanged?.();
  }
}

/**
 * LifeEventEditModal —— 单个人生事件的新增 / 编辑表单。
 * 金额字段以「元」输入，保存时统一折算为分（AmountInCents）；留空 = 该项无影响（存 undefined）。
 */
class LifeEventEditModal extends Modal {
  private plugin: FinancePlugin;
  private editId?: string;
  private labelInput!: HTMLInputElement;
  private typeSelect!: HTMLSelectElement;
  private ageInput!: HTMLInputElement;
  private enabledInput!: HTMLInputElement;
  private noteText!: TextComponent;
  private impactInputs = new Map<ImpactKey, HTMLInputElement>();
  private isRetire = false;

  constructor(plugin: FinancePlugin, editId?: string) {
    super(plugin.app);
    this.plugin = plugin;
    this.editId = editId;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('fb-modal');

    const editEvent = this.editId
      ? this.plugin.config.lifeEvents.find((e) => e.id === this.editId)
      : undefined;
    this.isRetire = editEvent?.type === 'retire';

    contentEl.createEl('h2', {
      text: editEvent ? t('modal.event.editTitle') : t('modal.event.newTitle'),
    });

    // 事件名称
    const labelField = contentEl.createDiv();
    labelField.addClass('fb-field');
    labelField.createEl('label', { text: t('modal.event.label') });
    this.labelInput = labelField.createEl('input', {
      type: 'text', cls: 'fb-input', placeholder: t('modal.event.labelPlaceholder'),
    });
    if (editEvent) this.labelInput.value = editEvent.label;

    // 事件类型（决定图上配色）
    const typeField = contentEl.createDiv();
    typeField.addClass('fb-field');
    typeField.createEl('label', { text: t('modal.event.type') });
    this.typeSelect = typeField.createEl('select', { cls: 'fb-input' });
    for (const ty of EVENT_TYPES) {
      const opt = this.typeSelect.createEl('option', { text: t(`event.type.${ty}`), value: ty });
      if (editEvent && editEvent.type === ty) opt.selected = true;
    }
    if (editEvent) this.typeSelect.value = editEvent.type;
    if (this.isRetire) {
      this.typeSelect.disabled = true;
    }

    // 触发年龄
    const ageField = contentEl.createDiv();
    ageField.addClass('fb-field');
    ageField.createEl('label', { text: t('modal.event.age') });
    this.ageInput = ageField.createEl('input', {
      type: 'number', cls: 'fb-input', placeholder: t('modal.event.agePlaceholder'),
    });
    if (editEvent) this.ageInput.value = String(editEvent.age);
    if (this.isRetire) {
      this.ageInput.disabled = true;
      const ageHint = ageField.createDiv();
      ageHint.addClass('fb-meta');
      ageHint.setText(t('modal.event.retireAgeHint'));
    }

    // 退休事件没有财务影响字段（退休边界由「退休年龄」参数驱动），隐藏此分组
    if (!this.isRetire) {
    // 财务影响分组：五项均可留空，正数=流入/增加，负数=流出/减少
    contentEl.createEl('h3', { text: t('modal.event.impactSection'), cls: 'fb-subhead' });
    contentEl.createEl('p', { text: t('modal.event.impactHint'), cls: 'fb-meta' });

    const impactGrid = contentEl.createDiv();
    impactGrid.addClass('fb-dep-grid');
    for (const f of IMPACT_FIELDS) {
      const field = impactGrid.createDiv();
      field.addClass('fb-field');
      field.createEl('label', { text: t(f.labelKey) });
      const input = field.createEl('input', {
        type: 'number', cls: 'fb-input', placeholder: t(f.descKey),
      });
      const cents = editEvent?.[f.key as ImpactKey];
      if (cents != null) input.value = String(cents / 100); // 分 → 元
      this.impactInputs.set(f.key, input);
    }
    }

    // 关联笔记（Obsidian 路径，图上点击事件即打开）
    const noteField = contentEl.createDiv();
    noteField.addClass('fb-field');
    noteField.createEl('label', { text: t('modal.event.note') });
    this.noteText = new TextComponent(noteField);
    this.noteText.inputEl.addClass('fb-input');
    this.noteText.setPlaceholder(t('modal.event.notePlaceholder'));
    if (editEvent?.note) this.noteText.setValue(editEvent.note);
    new PathSuggest(this.app, this.noteText);

    // 参与计算开关
    const enabledField = contentEl.createDiv();
    enabledField.addClass('fb-field', 'fb-check-field');
    const checkWrap = enabledField.createDiv();
    checkWrap.addClass('fb-check-row');
    this.enabledInput = checkWrap.createEl('input', { type: 'checkbox' });
    this.enabledInput.checked = editEvent ? editEvent.enabled : true;
    checkWrap.createEl('label', { text: t('modal.event.enabledLabel') });

    const btnRow = contentEl.createDiv();
    btnRow.addClass('fb-btn-row');
    const cancelBtn = btnRow.createEl('button', { text: t('common.cancel') });
    cancelBtn.addClass('mod-muted');
    cancelBtn.addEventListener('click', () => this.close());
    const saveBtn = btnRow.createEl('button', { text: t('common.save') });
    saveBtn.addClass('mod-cta');
    saveBtn.addEventListener('click', () => {
      void this.save().catch((err) => {
        console.error('[finance-block] save life event failed:', err);
        new Notice(t('common.saveFailed'));
      });
    });
  }

  private async save(): Promise<void> {
    const label = this.labelInput.value.trim();
    if (!label) { new Notice(t('modal.event.labelRequired')); return; }

    const age = this.isRetire
      ? (this.plugin.config.lifeEvents.find((e) => e.id === this.editId)?.age ?? 60)
      : parseInt(this.ageInput.value, 10);
    if (!this.isRetire && (!Number.isFinite(age) || age < 0 || age > 120)) {
      new Notice(t('modal.event.ageRequired'));
      return;
    }

    // 收集五项财务影响：空串 → undefined（不写入配置），有值 → 元转分
    const impacts: Partial<Record<ImpactKey, AmountInCents>> = {};
    for (const f of IMPACT_FIELDS) {
      const raw = this.impactInputs.get(f.key)?.value.trim() ?? '';
      if (!raw) continue;
      const yuan = parseFloat(raw);
      if (!Number.isFinite(yuan)) { new Notice(t('modal.event.impactInvalid')); return; }
      if (yuan === 0) continue; // 0 等价于无影响，不落库
      impacts[f.key] = Math.round(yuan * 100) as AmountInCents;
    }

    const note = this.noteText.getValue().trim() || undefined;
    const type = (this.typeSelect.value || 'custom') as LifeEventType;
    const enabled = this.enabledInput.checked;

    const events = this.plugin.config.lifeEvents;
    if (!this.editId) {
      events.push({
        id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        label, type, age, enabled, note, ...impacts,
      });
    } else {
      const target = events.find((e) => e.id === this.editId);
      if (target) {
        // 全量覆盖：先清掉旧的影响字段，再写入本次填的（避免清空输入后旧值残留）
        for (const f of IMPACT_FIELDS) delete target[f.key as ImpactKey];
        Object.assign(target, { label, type, age, enabled, note, ...impacts });
      }
    }

    await this.plugin.configManager.save();
    new Notice(t('modal.event.saved'));
    this.close();
  }

  onClose(): void { this.contentEl.empty(); }
}
