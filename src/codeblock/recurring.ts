/**
 * finance-recurring 渲染器（codeblock/recurring.ts）
 *
 * 承载两类「周期性待入账」：
 *   - V1 日常花费计划（固定金额两腿）
 *   - V2 贷款计划（还款引擎按 schedule 生成 3 腿分录）
 *
 * 关键机制（已拍板）：
 *   - 草稿虚派生：不落盘，渲染时从 config + 账本实时计算（应发生 × 未入账 × 未跳过）。
 *   - 入账/跳过/改金额后**主动重绘自身**：Obsidian 代码块不会因账本/config 文件变化自动重画。
 *   - 「改金额」= 仅本次覆盖：写入会话内 override Map，不落盘；重绘后其它草稿回到计划值。
 *   - 「全部入账」前用应用内确认框（禁原生 confirm，Electron 焦点 bug）。
 */

import { App, MarkdownPostProcessorContext, Modal, Notice } from 'obsidian';
import { t } from '../i18n';
import type { AmountInCents, FinanceConfig, LoanDef, LoanPeriod, RecurringPlanDef, Transaction } from '../types';
import { todayLocal } from '../util/date';
import { fmtCents } from '../util/ledgerView';
import { Indexer } from '../ledger/indexer';
import { deriveLoanDrafts, deriveRecurringDrafts, loanProgress, type LoanDraft, type RecurringDraft } from '../engine/recurring';
import { BLOCK_ICONS, setSvg } from './icons';
import { confirmWithModal } from '../ui/Confirm';

/** 渲染器依赖（main.ts 通过 registry 注入） */
export interface RecurringRenderDeps {
  app: App;
  getFinanceConfig: () => FinanceConfig | undefined;
  indexer: Indexer;
  postRecurringEntry: (plan: RecurringPlanDef, date: string, amountCents: AmountInCents) => Promise<void>;
  skipRecurringEntry: (planId: string, date: string) => Promise<void>;
  postLoanEntry: (loan: LoanDef, period: LoanPeriod) => Promise<void>;
  saveRecurringPlan: (plan: RecurringPlanDef) => Promise<void>;
  removeRecurringPlan: (planId: string) => Promise<void>;
  saveLoan: (loan: LoanDef) => Promise<void>;
  removeLoan: (loanId: string) => Promise<void>;
  openRecurringPlanModal: (plan?: RecurringPlanDef, onChanged?: () => void) => void;
  openLoanModal: (loan?: LoanDef, onChanged?: () => void) => void;
}

/** 会话内「改金额（仅本次）」覆盖表：key = `${planId}:${date}` */
const amountOverrides = new Map<string, AmountInCents>();

const fmtYuan = (cents: number): string =>
  '¥' + (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 卡片上操作按钮的最小公因数：返回按钮文字与点击回调 */
interface DraftVM {
  key: string;
  kind: 'plan' | 'loan';
  name: string;
  sub?: string;
  dateLabel: string;
  amount: AmountInCents;
  preview: string;
  split?: string;
  onPost: () => void;
  onSkip?: () => void;
  onEditAmount?: () => void;
}

export function renderRecurring(
  _source: string,
  el: HTMLElement,
  _ctx: MarkdownPostProcessorContext,
  deps: RecurringRenderDeps,
): void {
  // 操作后主动重绘自身（Obsidian 不自动重画）
  const rerender = (): void => {
    el.empty();
    renderInner(el, deps, rerender);
  };
  renderInner(el, deps, rerender);
}

function renderInner(el: HTMLElement, deps: RecurringRenderDeps, rerender: () => void): void {
  const config = deps.getFinanceConfig();
  const posted = deps.indexer.getPostedTransactions().map((e) => e.transaction);
  const today = todayLocal();

  // ── 派生待入账（虚派生） ──
  const planDrafts = deriveRecurringDrafts(config?.recurringPlans ?? [], posted, config?.recurringSkips ?? {}, today);
  const loanDrafts = deriveLoanDrafts(config?.loanPlans ?? [], posted, today);
  lastPlanDrafts = planDrafts;
  lastLoanDrafts = loanDrafts;

  const planVM: DraftVM[] = planDrafts.map((d) => ({
    key: `plan:${d.plan.id}:${d.date}`,
    kind: 'plan',
    name: d.plan.name,
    dateLabel: d.date,
    amount: amountOverrides.get(`${d.plan.id}:${d.date}`) ?? d.amount,
    preview: `${d.plan.account} ${fmtCents(d.amount)} / ${d.plan.fromAccount} ${fmtCents(-d.amount)} · ${d.plan.txnType}`,
    onPost: () => void postPlan(d, deps, rerender),
    onSkip: () => void skipPlan(d, deps, rerender),
    onEditAmount: () => editAmount(d, deps, rerender),
  }));
  const loanVM: DraftVM[] = loanDrafts.map((d) => ({
    key: `loan:${d.loan.id}:${d.period.period}`,
    kind: 'loan',
    name: d.loan.name,
    sub: t('recurring.loan.periodLabel', { n: String(d.period.period) }),
    dateLabel: d.period.date,
    amount: d.period.total,
    preview: `${d.loan.assetAccount} ${fmtCents(-d.period.total)} / ${d.loan.liabilityAccount} ${fmtCents(d.period.principalPart)} / ${d.loan.interestAccount} ${fmtCents(d.period.interestPart)}`,
    split: `${t('recurring.loan.principalPart')} ${fmtYuan(d.period.principalPart)} · ${t('recurring.loan.interest')} ${fmtYuan(d.period.interestPart)}`,
    onPost: () => void postLoan(d, deps, rerender),
  }));
  const drafts: DraftVM[] = [...planVM, ...loanVM].sort((a, b) => (a.dateLabel < b.dateLabel ? -1 : 1));

  // ── 根容器 ──
  const box = el.createDiv({ cls: 'finance-block finance-recurring' });

  // 头部
  const head = box.createDiv({ cls: 'fb-head' });
  setSvg(head.createDiv({ cls: 'fb-icon' }), BLOCK_ICONS.recurring);
  head.createDiv({ cls: 'fb-title', text: t('recurring.title') });
  const pill = head.createDiv({ cls: drafts.length > 0 ? 'fb-pill is-amber' : 'fb-pill is-green' });
  pill.textContent = drafts.length > 0 ? t('recurring.pill.due', { n: String(drafts.length) }) : t('recurring.pill.done');

  // ── 今日待入账 ──
  const dueSec = box.createDiv({ cls: 'fb-section' });
  const dueHead = dueSec.createDiv({ cls: 'rc-sec-head' });
  dueHead.createSpan({ cls: 'rc-sec-label', text: t('recurring.due.title') });
  dueHead.createSpan({ cls: 'rc-sec-count', text: String(drafts.length) });
  if (drafts.length > 0) {
    const allBtn = dueHead.createEl('button', { cls: 'rc-link-btn', text: t('recurring.due.all') });
    allBtn.addEventListener('click', () => void postAll(drafts, deps, rerender));
  }
  const draftList = dueSec.createDiv({ cls: 'rc-draft-list' });
  if (drafts.length === 0) {
    draftList.createDiv({ cls: 'rc-empty', text: t('recurring.due.empty') });
  } else {
    for (const d of drafts) renderDraftCard(draftList, d);
  }

  // ── 管理（tab：我的计划 / 我的贷款） ──
  const mgmtSec = box.createDiv({ cls: 'fb-section' });
  const tabs = mgmtSec.createDiv({ cls: 'rc-tabs' });
  const tabPlans = tabs.createEl('button', { cls: 'rc-tab is-active', text: t('recurring.tab.plans') });
  tabPlans.createSpan({ cls: 'rc-tab-count', text: String(config?.recurringPlans.length ?? 0) });
  const tabLoans = tabs.createEl('button', { cls: 'rc-tab', text: t('recurring.tab.loans') });
  tabLoans.createSpan({ cls: 'rc-tab-count', text: String(config?.loanPlans.length ?? 0) });

  const panelPlans = mgmtSec.createDiv({ cls: 'rc-tab-panel is-active' });
  const panelLoans = mgmtSec.createDiv({ cls: 'rc-tab-panel' });

  const switchTab = (active: HTMLElement, panel: HTMLElement, other: HTMLElement, otherPanel: HTMLElement): void => {
    active.addClass('is-active');
    other.removeClass('is-active');
    panel.addClass('is-active');
    otherPanel.removeClass('is-active');
  };
  tabPlans.addEventListener('click', () => switchTab(tabPlans, panelPlans, tabLoans, panelLoans));
  tabLoans.addEventListener('click', () => switchTab(tabLoans, panelLoans, tabPlans, panelPlans));

  // 计划列表
  renderPlanRows(panelPlans, config, deps, rerender);
  const newPlanBtn = panelPlans.createEl('button', { cls: 'rc-new-btn', text: t('recurring.new.plan') });
  newPlanBtn.addEventListener('click', () => deps.openRecurringPlanModal(undefined, rerender));

  // 贷款列表
  renderLoanRows(panelLoans, config, deps, posted, rerender);
  const newLoanBtn = panelLoans.createEl('button', { cls: 'rc-new-btn is-loan', text: t('recurring.new.loan') });
  newLoanBtn.addEventListener('click', () => deps.openLoanModal(undefined, rerender));
}

// ── 草稿卡 ──────────────────────────────────────────────────────

function renderDraftCard(parent: HTMLElement, d: DraftVM): void {
  const card = parent.createDiv({ cls: `rc-draft ${d.kind === 'loan' ? 'is-loan' : ''}`.trim() });
  const left = card.createDiv({ cls: 'rc-draft-left' });
  const nameRow = left.createDiv({ cls: 'rc-draft-name' });
  if (d.kind === 'loan') nameRow.createSpan({ cls: 'rc-badge', text: t('recurring.badge.loan') });
  nameRow.createSpan({ text: d.name });
  if (d.sub) nameRow.createSpan({ cls: 'rc-draft-sub', text: d.sub });
  left.createDiv({ cls: 'rc-draft-date', text: d.dateLabel });
  card.createDiv({ cls: 'rc-draft-amt', text: fmtYuan(d.amount) });
  card.createDiv({ cls: 'rc-draft-preview', text: d.preview });
  if (d.split) card.createDiv({ cls: 'rc-draft-split', text: d.split });

  const actions = card.createDiv({ cls: 'rc-draft-actions' });
  const postBtn = actions.createEl('button', { cls: 'rc-btn primary', text: t('recurring.post') });
  postBtn.addEventListener('click', () => d.onPost());
  if (d.onSkip) {
    const skipBtn = actions.createEl('button', { cls: 'rc-btn ghost', text: t('recurring.skip') });
    skipBtn.addEventListener('click', () => d.onSkip!());
  }
  if (d.onEditAmount) {
    const editBtn = actions.createEl('button', { cls: 'rc-btn ghost', text: t('recurring.editAmount') });
    editBtn.addEventListener('click', () => d.onEditAmount!());
  }
}

// ── 操作：入账 / 跳过 / 改金额 / 全部入账 ──────────────────────

async function postPlan(d: RecurringDraft, deps: RecurringRenderDeps, rerender: () => void): Promise<void> {
  const amount = amountOverrides.get(`${d.plan.id}:${d.date}`) ?? d.plan.amount;
  try {
    await deps.postRecurringEntry(d.plan, d.date, amount);
    amountOverrides.delete(`${d.plan.id}:${d.date}`);
    new Notice(t('recurring.posted', { name: d.plan.name }));
  } catch (err) {
    new Notice(t('recurring.postError', { error: err instanceof Error ? err.message : String(err) }));
    return;
  }
  rerender();
}

async function skipPlan(d: RecurringDraft, deps: RecurringRenderDeps, rerender: () => void): Promise<void> {
  try {
    await deps.skipRecurringEntry(d.plan.id, d.date);
    new Notice(t('recurring.skipped', { name: d.plan.name }));
  } catch (err) {
    new Notice(t('recurring.postError', { error: err instanceof Error ? err.message : String(err) }));
    return;
  }
  rerender();
}

async function postLoan(d: LoanDraft, deps: RecurringRenderDeps, rerender: () => void): Promise<void> {
  try {
    await deps.postLoanEntry(d.loan, d.period);
    new Notice(t('recurring.posted', { name: `${d.loan.name} ${t('recurring.loan.periodLabel', { n: String(d.period.period) })}` }));
  } catch (err) {
    new Notice(t('recurring.postError', { error: err instanceof Error ? err.message : String(err) }));
    return;
  }
  rerender();
}

async function postAll(drafts: DraftVM[], deps: RecurringRenderDeps, rerender: () => void): Promise<void> {
  const ok = await confirmWithModal(deps.app, t('recurring.confirmAll', { n: String(drafts.length) }), {
    title: t('recurring.confirmAllTitle'),
    warning: true,
  });
  if (!ok) return;
  let fail = 0;
  for (const d of drafts) {
    try {
      if (d.kind === 'plan') {
        const r = findPlanDraft(d.key);
        if (r) await deps.postRecurringEntry(r.plan, r.date, amountOverrides.get(`${r.plan.id}:${r.date}`) ?? r.plan.amount);
      } else {
        const l = findLoanDraft(d.key);
        if (l) await deps.postLoanEntry(l.loan, l.period);
      }
    } catch {
      fail++;
    }
  }
  amountOverrides.clear();
  new Notice(fail > 0 ? t('recurring.batchPartial', { fail: String(fail) }) : t('recurring.batchDone', { n: String(drafts.length) }));
  rerender();
}

/** 改金额：应用内小输入框（禁原生 prompt） */
function editAmount(d: RecurringDraft, deps: RecurringRenderDeps, rerender: () => void): void {
  const modal = new Modal(deps.app);
  modal.titleEl.setText(t('recurring.editAmountTitle', { name: d.plan.name, date: d.date }));
  modal.contentEl.empty();
  const input = modal.contentEl.createEl('input', {
    type: 'number',
    cls: 'finance-input',
    attr: { step: '0.01', min: '0', inputmode: 'decimal' },
  });
  input.value = String(((amountOverrides.get(`${d.plan.id}:${d.date}`) ?? d.plan.amount) / 100));
  input.style.width = '100%';
  const row = modal.contentEl.createDiv({ cls: 'finance-btn-row' });
  const cancel = row.createEl('button', { text: t('recurring.modal.cancel'), cls: 'mod-muted' });
  cancel.addEventListener('click', () => modal.close());
  const save = row.createEl('button', { text: t('recurring.modal.save'), cls: 'mod-cta' });
  save.addEventListener('click', () => {
    const v = parseFloat(input.value);
    if (v > 0) amountOverrides.set(`${d.plan.id}:${d.date}`, Math.round(v * 100));
    modal.close();
    rerender();
  });
  modal.onOpen = () => {
    input.focus();
    input.select();
  };
  modal.open();
}

// 重绘后 draft 对象会重建，用 key 找回当前派生的 draft（供全部入账遍历用）
let lastPlanDrafts: RecurringDraft[] = [];
let lastLoanDrafts: LoanDraft[] = [];
function findPlanDraft(key: string): RecurringDraft | undefined {
  return lastPlanDrafts.find((d) => `plan:${d.plan.id}:${d.date}` === key);
}
function findLoanDraft(key: string): LoanDraft | undefined {
  return lastLoanDrafts.find((d) => `loan:${d.loan.id}:${d.period.period}` === key);
}

// ── 我的计划 / 我的贷款（tab 面板） ────────────────────────────

function renderPlanRows(parent: HTMLElement, config: FinanceConfig | undefined, deps: RecurringRenderDeps, rerender: () => void): void {
  const plans = config?.recurringPlans ?? [];
  const list = parent.createDiv({ cls: 'rc-plan-list' });
  if (plans.length === 0) {
    list.createDiv({ cls: 'rc-empty', text: t('recurring.plans.empty') });
    return;
  }
  for (const p of plans) {
    const row = list.createDiv({ cls: 'rc-plan' });
    const main = row.createDiv({ cls: 'rc-plan-main' });
    main.createDiv({ cls: 'rc-plan-name', text: p.name });
    const freqText =
      p.frequency === 'daily' ? t('recurring.freq.daily') : p.frequency === 'monthly' ? t('recurring.freq.monthlyShort', { d: String(p.monthlyDay ?? 1) }) : t('recurring.freq.weekday');
    main.createDiv({ cls: 'rc-plan-sub', text: `${freqText} · ${p.account} → ${p.fromAccount}` });
    row.createDiv({ cls: 'rc-plan-amt', text: fmtYuan(p.amount) });
    row.createDiv({ cls: `rc-plan-status ${p.active ? '' : 'is-paused'}`.trim(), text: p.active ? t('recurring.status.running') : t('recurring.status.paused') });
    const btns = row.createDiv({ cls: 'rc-plan-btns' });
    const editBtn = btns.createEl('button', { cls: 'rc-icon-btn', text: t('recurring.edit') });
    editBtn.addEventListener('click', () => deps.openRecurringPlanModal(p, rerender));
    const toggleBtn = btns.createEl('button', { cls: 'rc-icon-btn', text: p.active ? t('recurring.pause') : t('recurring.resume') });
    toggleBtn.addEventListener('click', () => void togglePlan(p, deps, rerender));
    const delBtn = btns.createEl('button', { cls: 'rc-icon-btn is-danger', text: t('recurring.del') });
    delBtn.addEventListener('click', () => void removePlan(p, deps, rerender));
  }
}

async function togglePlan(p: RecurringPlanDef, deps: RecurringRenderDeps, rerender: () => void): Promise<void> {
  try {
    await deps.saveRecurringPlan({ ...p, active: !p.active });
    rerender();
  } catch (err) {
    new Notice(String(err));
  }
}

async function removePlan(p: RecurringPlanDef, deps: RecurringRenderDeps, rerender: () => void): Promise<void> {
  const ok = await confirmWithModal(deps.app, t('recurring.confirmDelPlan', { name: p.name }), { warning: true });
  if (!ok) return;
  try {
    await deps.removeRecurringPlan(p.id);
    rerender();
  } catch (err) {
    new Notice(String(err));
  }
}

function renderLoanRows(parent: HTMLElement, config: FinanceConfig | undefined, deps: RecurringRenderDeps, posted: Transaction[], rerender: () => void): void {
  const loans = config?.loanPlans ?? [];
  const list = parent.createDiv({ cls: 'rc-plan-list' });
  if (loans.length === 0) {
    list.createDiv({ cls: 'rc-empty', text: t('recurring.loans.empty') });
    return;
  }
  for (const l of loans) {
    const prog = loanProgress(l, posted, todayLocal());
    const row = list.createDiv({ cls: `rc-plan is-loan ${l.active ? '' : 'is-paused'}`.trim() });
    const main = row.createDiv({ cls: 'rc-plan-main' });
    main.createDiv({ cls: 'rc-plan-name', text: l.name });
    const typeText =
      l.type === 'annuity' ? t('recurring.loan.type.annuity') : l.type === 'equal-principal' ? t('recurring.loan.type.equalPrincipal') : t('recurring.loan.type.interestFirst');
    main.createDiv({ cls: 'rc-plan-sub', text: `${typeText} · ${l.termYears}${t('recurring.loan.years')} · ${l.annualRate}%` });
    const mid = row.createDiv({ cls: 'rc-plan-mid' });
    mid.createDiv({ cls: 'rc-plan-main', text: fmtYuan(prog.remaining) });
    mid.createDiv({ cls: 'rc-plan-sub', text: `${t('recurring.loan.next')} ${prog.next ? fmtYuan(prog.next.total) : '—'}` });
    row.createDiv({ cls: 'rc-plan-amt', text: `${t('recurring.loan.paid', { n: String(prog.paidPeriods), m: String(prog.totalPeriods) })}` });
    const btns = row.createDiv({ cls: 'rc-plan-btns' });
    const editBtn = btns.createEl('button', { cls: 'rc-icon-btn', text: t('recurring.edit') });
    editBtn.addEventListener('click', () => deps.openLoanModal(l, rerender));
    const toggleBtn = btns.createEl('button', { cls: 'rc-icon-btn', text: l.active ? t('recurring.pause') : t('recurring.resume') });
    toggleBtn.addEventListener('click', () => void toggleLoan(l, deps, rerender));
    const delBtn = btns.createEl('button', { cls: 'rc-icon-btn is-danger', text: t('recurring.del') });
    delBtn.addEventListener('click', () => void removeLoan(l, deps, rerender));
    if (prog.totalPeriods > 0) {
      const pct = Math.min(100, (prog.paidPeriods / prog.totalPeriods) * 100);
      const progBar = row.createDiv({ cls: 'rc-prog' });
      const progFill = progBar.createDiv({ cls: 'rc-prog-fill' });
      progFill.style.width = `${pct.toFixed(1)}%`;
    }
  }
}

async function toggleLoan(l: LoanDef, deps: RecurringRenderDeps, rerender: () => void): Promise<void> {
  try {
    await deps.saveLoan({ ...l, active: !l.active });
    rerender();
  } catch (err) {
    new Notice(String(err));
  }
}

async function removeLoan(l: LoanDef, deps: RecurringRenderDeps, rerender: () => void): Promise<void> {
  const ok = await confirmWithModal(deps.app, t('recurring.confirmDelLoan', { name: l.name }), { warning: true });
  if (!ok) return;
  try {
    await deps.removeLoan(l.id);
    rerender();
  } catch (err) {
    new Notice(String(err));
  }
}
