import { Plugin, TFile, Notice } from 'obsidian';
import { FinanceSettingTab } from './settings/SettingsTab';
import { createProcessors } from './codeblock/registry';
import { DEFAULT_SETTINGS, type FinancePluginSettings } from './settings/settings';
import { ConfigManager } from './config/configManager';
import { Indexer } from './ledger/indexer';
import { setLocale, type Locale } from './i18n';
import { t } from './i18n';
import { tryRegisterInsertCommand } from './blockProvider';
import { RecordTransactionModal } from './ui/RecordTransactionModal';
import { InsertCodeBlockModal } from './ui/InsertCodeBlockModal';
import { RolloverModal } from './ui/RolloverModal';
import { UpdateValuationModal } from './ui/UpdateValuationModal';
import { LifeEventManagerModal } from './ui/LifeEventManagerModal';
import { RecurringPlanModal } from './ui/RecurringPlanModal';
import { LoanModal } from './ui/LoanModal';
import { FINANCE_CODE_BLOCK_DEFS, type CodeBlockDef } from './codeBlockDefs';
import type { BlockDefinitionWithParams } from './blockProvider';
import type { FinanceConfig, LoanDef, LoanPeriod, RecurringPlanDef, AmountInCents } from './types';
import { generateBlockRefId } from './ledger/poster';
import { appendEntryToLedgerBlock } from './ledger/ledgerFile';
import { legSignedCents } from './util/ledgerView';
import { loanEntryText } from './engine/loan';

export default class FinancePlugin extends Plugin {
  settings!: FinancePluginSettings;
  configManager!: ConfigManager;
  indexer!: Indexer;
  config!: FinanceConfig;
  /** 是否为跨插件通用「插入代码块」命令的宿主（first-claim wins） */
  private ownsUniversalInsert = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    // 设置 i18n 语言
    setLocale((this.settings.language ?? 'zh') as Locale);

    // 初始化配置管理器（vault 内 finance-config.json）
    this.configManager = new ConfigManager(this.app, this.settings.configPath);
    this.config = await this.configManager.load();

    // 初始化索引器（纯内存索引；待入账筛查范围由 settings 实时注入，关闭时启动零全库扫描）
    this.indexer = new Indexer(
      this.app,
      this.settings.ledgerPath,
      this.settings.archiveLedgers,
      () => ({ enabled: this.settings.draftScan, folders: this.settings.draftScanFolders }),
    );
    await this.indexer.init();

    // ── 命令面板 ──────────────────────────────────────────
    this.addCommand({
      id: 'finance-record',
      name: t('command.record'),
      callback: () => {
        this.openRecordModal();
      },
    });

    // 跨插件通用「插入代码块」命令：first-claim wins 宿主策略（§2 已确认）。
    // 第一个注册 insert-block 命令的插件成为宿主；其余插件自动跳过、仅作为
    // BlockProvider 被合并展示。单插件独立装也可用，多插件合并也不写死任何一对。
    this.ownsUniversalInsert = tryRegisterInsertCommand(this, () => this.openInsertCodeBlockModal());

    // ── 侧边栏 Ribbon ────────────────────────────────────
    this.addRibbonIcon('coins', t('command.record'), () => {
      this.openRecordModal();
    });

    // 仅当本插件是通用插入命令宿主时才显示「插入代码块」ribbon。
    // 多插件共存时只有宿主显示 ribbon（避免重复按钮）；单插件独立装时自动成为宿主、显示 ribbon。
    if (this.ownsUniversalInsert) {
      this.addRibbonIcon('code', t('command.insertBlock'), () => {
        this.openInsertCodeBlockModal();
      });
    }

    // ── 代码块处理器（依赖注入） ─────────────────────────
    const processors = createProcessors({
      app: this.app,
      indexer: this.indexer,
      getLedgerPath: () => this.settings.ledgerPath,
      getArchiveLedgers: () => this.settings.archiveLedgers ?? [],
      getFinanceConfig: () => this.config,
      getBlockDefinitions: () => this.getBlockDefinitions(),
      openRolloverModal: () => this.openRolloverModal(),
      openRecordModal: () => this.openRecordModal(),
      openValuationModal: (account) => this.openValuationModal(account),
      openLifeEventModal: (onChanged) => this.openLifeEventModal(onChanged),
      postRecurringEntry: (plan, date, amountCents) => this.postRecurringEntry(plan, date, amountCents),
      skipRecurringEntry: (planId, date) => this.skipRecurringEntry(planId, date),
      postLoanEntry: (loan, period) => this.postLoanEntry(loan, period),
      saveRecurringPlan: (plan) => this.saveRecurringPlan(plan),
      removeRecurringPlan: (planId) => this.removeRecurringPlan(planId),
      saveLoan: (loan) => this.saveLoan(loan),
      removeLoan: (loanId) => this.removeLoan(loanId),
      openRecurringPlanModal: (plan, onChanged) => this.openRecurringPlanModal(plan, onChanged),
      openLoanModal: (loan, onChanged) => this.openLoanModal(loan, onChanged),
    });
    for (const processor of processors) {
      this.registerMarkdownCodeBlockProcessor(processor.language, (source, el, ctx) =>
        processor.render(source, el, ctx),
      );
    }

    // ── 文件变更监听：增量更新索引 + 配置热重载 ──────────
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (!(file instanceof TFile)) return;
        if (file.extension === 'md') {
          // 账本 / 草稿笔记变更：增量更新内存索引
          this.indexer.updateFile(file.path);
        } else if (file.path === this.settings.configPath) {
          // finance-config.json 被外部直接编辑：重载内存配置，
          // 使 getBlockRegistry() 物化的账户/类型/所有者选项保持新鲜
          // （Pitfall #7：物化成静态快照后，若 config 缓存过期会导致跨插件下拉显示旧数据）。
          this.reloadConfig().catch((err) => {
            console.warn('[finance-block] Config hot-reload failed:', err);
            new Notice(t('settings.configReloadError'));
          });
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('create', (file) => {
        // 新建账本 / 草稿笔记时增量索引（否则要等下次全量扫描才出现）
        if (file instanceof TFile && file.extension === 'md') {
          this.indexer.updateFile(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (file instanceof TFile && file.extension === 'md') {
          // 删除文件：清理索引中该文件的陈旧条目
          this.indexer.removeFile(file.path);
        }
      })
    );

    // ── 设置页 ────────────────────────────────────────────
    this.addSettingTab(new FinanceSettingTab(this.app, this));
  }

  onunload(): void {
    // 清理由 Obsidian 自动处理
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** 打开「记一笔」弹窗：复用 fin-beancount 录入表单，提交后直接入账到账本 */
  private openRecordModal(): void {
    const defs = this.getBlockDefinitions();
    const beancount = defs.find((d) => d.language === 'fin-beancount');
    if (!beancount) {
      new Notice(t('modal.record.noDef'));
      return;
    }
    new RecordTransactionModal(
      this.app,
      beancount,
      this.config,
      this.settings.ledgerPath,
      this.indexer,
    ).open();
  }

  /** 打开「汇总结转」弹窗：把当前账本余额承接进新账本，旧账本归档 */
  private openRolloverModal(): void {
    new RolloverModal(
      this.app,
      this.settings,
      () => this.saveSettings(),
      this.indexer,
    ).open();
  }

  /** 打开「更新估值」弹窗：为资产账户写入 custom "fb-valuation" 指令行 */
  private openValuationModal(account?: string): void {
    new UpdateValuationModal(this, account).open();
  }

  /** 打开「人生事件」弹窗：规划买房/生娃等节点，驱动现金流模拟器的事件层与计算。
   * onChanged 由调用方（finance-ficalc 块）传入，事件增删改后触发重算刷新。 */
  private openLifeEventModal(onChanged?: () => void): void {
    new LifeEventManagerModal(this, onChanged).open();
  }

  // ── finance-recurring（日常花费 + 贷款）操作实现 ────────────────

  /** 日常草稿入账：组装 2 腿分录（符号按账户类别推导）→ 追加账本 → 刷新索引 */
  private async postRecurringEntry(plan: RecurringPlanDef, date: string, amountCents: AmountInCents): Promise<void> {
    const cfg = this.config;
    const expense = legSignedCents(plan.account, amountCents, 'in', cfg); // 支出账户增加 → 正
    const asset = legSignedCents(plan.fromAccount, amountCents, 'out', cfg); // 出资账户减少 → 负
    const lines = [
      `${date} * ${plan.name}`,
      `  ${plan.account}  ${expense}`,
      `  ${plan.fromAccount}  ${asset}`,
      `  plan: ${plan.id}`,
      `  plan-date: ${date}`,
    ];
    if (plan.txnType) lines.push(`  type: ${plan.txnType}`);
    if (plan.owner) lines.push(`  owner: ${plan.owner}`);
    await this.appendToLedger(lines.join('\n'), date);
  }

  /** 日常草稿跳过：写 recurringSkips（键=应发生日） */
  private async skipRecurringEntry(planId: string, date: string): Promise<void> {
    const skips = { ...this.config.recurringSkips };
    const arr = [...(skips[planId] ?? [])];
    if (!arr.includes(date)) arr.push(date);
    skips[planId] = arr;
    await this.configManager.update({ recurringSkips: skips });
    await this.syncConfig();
  }

  /** 贷款期入账：引擎生成 3 腿分录 → 追加账本 → 刷新索引 */
  private async postLoanEntry(loan: LoanDef, period: LoanPeriod): Promise<void> {
    const text = loanEntryText(period, loan, this.config);
    await this.appendToLedger(text, period.date);
  }

  /** 日常计划新建/更新（含暂停/启用）；plan.id 存在则替换，否则追加 */
  private async saveRecurringPlan(plan: RecurringPlanDef): Promise<void> {
    const exists = this.config.recurringPlans.some((p) => p.id === plan.id);
    const recurringPlans = exists
      ? this.config.recurringPlans.map((p) => (p.id === plan.id ? plan : p))
      : [...this.config.recurringPlans, plan];
    await this.configManager.update({ recurringPlans });
    await this.syncConfig();
  }

  /** 删除日常计划（已入账账本记录不受影响） */
  private async removeRecurringPlan(planId: string): Promise<void> {
    await this.configManager.update({ recurringPlans: this.config.recurringPlans.filter((p) => p.id !== planId) });
    await this.syncConfig();
  }

  /** 贷款新建/更新（含暂停/启用、剩余本金覆盖=部分提前还本） */
  private async saveLoan(loan: LoanDef): Promise<void> {
    const exists = this.config.loanPlans.some((l) => l.id === loan.id);
    const loanPlans = exists
      ? this.config.loanPlans.map((l) => (l.id === loan.id ? loan : l))
      : [...this.config.loanPlans, loan];
    await this.configManager.update({ loanPlans });
    await this.syncConfig();
  }

  /** 删除贷款 */
  private async removeLoan(loanId: string): Promise<void> {
    await this.configManager.update({ loanPlans: this.config.loanPlans.filter((l) => l.id !== loanId) });
    await this.syncConfig();
  }

  /** 打开日常计划弹窗；onChanged 在保存后回调（渲染器重绘） */
  private openRecurringPlanModal(plan?: RecurringPlanDef, onChanged?: () => void): void {
    new RecurringPlanModal(this.app, this.config, plan, (saved) => {
      void this.saveRecurringPlan(saved)
        .then(onChanged)
        .catch((err) => {
          console.error('[finance-block] save recurring plan failed:', err);
          new Notice(t('common.saveFailed'));
        });
    }).open();
  }

  /** 打开贷款弹窗；onChanged 在保存后回调（渲染器重绘） */
  private openLoanModal(loan?: LoanDef, onChanged?: () => void): void {
    new LoanModal(this.app, this.config, loan, (saved) => {
      void this.saveLoan(saved)
        .then(onChanged)
        .catch((err) => {
          console.error('[finance-block] save loan failed:', err);
          new Notice(t('common.saveFailed'));
        });
    }).open();
  }

  /** 追加分录到账本（复用 ledgerFile.appendEntryToLedgerBlock）并刷新索引 */
  private async appendToLedger(entryBody: string, date: string): Promise<void> {
    const refId = generateBlockRefId(date);
    const result = await appendEntryToLedgerBlock(this.app, this.settings.ledgerPath, entryBody, refId);
    if (!result.success) throw new Error(result.error || 'append failed');
    await this.indexer.updateFile(result.ledgerPath);
  }

  /** configManager.update 后同步内存 config（update 内部重新赋值，main 持有的旧引用会过期） */
  private async syncConfig(): Promise<void> {
    this.config = await this.configManager.load();
  }

  /** 打开代码块插入弹窗（跨插件通用：合并所有 BlockProvider 的定义） */
  private openInsertCodeBlockModal(): void {
    new InsertCodeBlockModal(this.app, this.config).open();
  }

  /** 获取当前 vault 配置（只读） */
  getConfig(): Readonly<FinanceConfig> {
    return this.config;
  }

  /** 从 vault 重新加载内存配置（外部编辑 finance-config.json 后调用）。
   * 让 getBlockRegistry() 物化的账户/类型/所有者选项保持新鲜，避免 Pitfall #7 的快照过期。 */
  private async reloadConfig(): Promise<void> {
    this.config = await this.configManager.load();
  }

  /**
   * BlockProvider 契约：暴露本插件可插入的 block 定义列表。
   * 其他 block 插件的通用插入器通过 app.plugins.plugins 扫描此方法，
   * 实现跨插件动态发现与合并展示（无需模块级注册表）。
   * 同时补齐契约要求的 pluginId 与 title 字段（供其他插件 Modal 分组/读取）。
   */
  getBlockRegistry(): BlockDefinitionWithParams[] {
    return this.getBlockDefinitions().map((d) => {
      // fin-beancount 的「插入代码块」只需插入空壳（```fin-beancount```），
      // 录入走代码块内的「添加记录」按钮或「记一笔」命令——它们用 getBlockDefinitions() 拿完整 params。
      // 这里同时把 multiLeg 归零：空壳块没有 legs 参数，若仍保留 multiLeg:true，
      // InsertCodeBlockParamModal（EntryFormModal）会走 legs 校验分支，
      // 因 legs 编辑器从未渲染、this.legs 为空而报「至少需要 2 条分录」、无法插入（已修）。
      if (d.language === 'fin-beancount') {
        return { ...d, title: d.name, pluginId: this.manifest.id, multiLeg: false, params: [] };
      }
      return { ...d, title: d.name, pluginId: this.manifest.id };
    });
  }

  /** 将 CodeBlockDef 列表转换为 BlockDefinitionWithParams（供代码块插入器等使用） */
  private getBlockDefinitions(): BlockDefinitionWithParams[] {
    return FINANCE_CODE_BLOCK_DEFS.map((def: CodeBlockDef) => ({
      language: def.language,
      name: t(def.titleKey),
      description: t(def.descKey),
      icon: def.icon,
      template: def.template,
      multiLeg: def.multiLeg,
      params: def.params.map((p) => {
        // 跨插件联动关键：把 optionsFrom 动态数据源「物化」成静态 options/optionLabels。
        // 任何宿主插件（含 workout-block 等其它 block 插件）拿到后都能直接渲染下拉，
        // 无需知道数据源细节、也无需访问本插件配置。否则其它宿主会因无法解析
        // optionsFrom，把 select 渲染成空选项（表现为「— 不设置 —」）。
        const resolved = p.optionsFrom ? this.resolveOptionSource(p.optionsFrom) : undefined;
        return {
          key: p.key,
          label: t(p.labelKey),
          labelKey: p.labelKey,
          description: p.descKey ? t(p.descKey) : undefined,
          type: p.type,
          optional: p.optional,
          placeholder: p.placeholder,
          options: resolved?.options ?? p.options,
          optionLabels: resolved?.labels ?? p.optionLabels,
          optionsFrom: p.optionsFrom,
          defaultValue: p.defaultValue,
          autoToday: p.autoToday,
        };
      }),
    }));
  }

  /**
   * 把 optionsFrom 数据源解析为具体 options（供 getBlockRegistry 跨插件暴露）。
   * 逻辑与 EntryFormModal.resolveDynamicOptions 一致，但使用插件级 config，
   * 以便在暴露 registry 时就完成「物化」，使宿主无需访问本插件私有配置。
   */
  private resolveOptionSource(
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
}
