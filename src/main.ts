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
import { FINANCE_CODE_BLOCK_DEFS, type CodeBlockDef } from './codeBlockDefs';
import type { BlockDefinitionWithParams } from './blockProvider';
import type { FinanceConfig } from './types';

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

    // ── 状态栏：未入账提醒 ────────────────────────────────
    if (this.settings.draftReminder) {
      this.registerDraftReminder();
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
    });
    for (const processor of processors) {
      this.registerMarkdownCodeBlockProcessor(processor.language, (source, el, ctx) =>
        processor.render(source, el, ctx),
      );
    }

    // ── 文件变更监听：增量更新索引 ────────────────────────
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile && file.extension === 'md') {
          this.indexer.updateFile(file.path);
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

  /** 注册未入账草稿提醒（状态栏） */
  private registerDraftReminder(): void {
    const statusBar = this.addStatusBarItem();
    statusBar.setText('');

    // 定时更新状态栏（每分钟）
    this.registerInterval(
      window.setInterval(() => {
        this.updateDraftReminder(statusBar);
      }, 60000)
    );

    // 初始更新
    this.updateDraftReminder(statusBar);
  }

  /** 更新状态栏草稿提醒 */
  private updateDraftReminder(statusBar: HTMLElement): void {
    const stats = this.indexer.getStats();
    if (stats.draftCount > 0) {
      statusBar.setText(`${stats.draftCount} 笔未入账`);
      statusBar.setAttribute('aria-label', `${stats.draftCount} 笔草稿未入账`);
    } else {
      statusBar.setText('');
    }
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

  /** 打开代码块插入弹窗（跨插件通用：合并所有 BlockProvider 的定义） */
  private openInsertCodeBlockModal(): void {
    new InsertCodeBlockModal(this.app, this.config).open();
  }

  /** 获取当前 vault 配置（只读） */
  getConfig(): Readonly<FinanceConfig> {
    return this.config;
  }

  /**
   * BlockProvider 契约：暴露本插件可插入的 block 定义列表。
   * 其他 block 插件的通用插入器通过 app.plugins.plugins 扫描此方法，
   * 实现跨插件动态发现与合并展示（无需模块级注册表）。
   * 同时补齐契约要求的 pluginId 与 title 字段（供其他插件 Modal 分组/读取）。
   */
  getBlockRegistry(): BlockDefinitionWithParams[] {
    return this.getBlockDefinitions().map((d) => ({
      ...d,
      title: d.name,
      pluginId: this.manifest.id,
    }));
  }

  /** 将 CodeBlockDef 列表转换为 BlockDefinitionWithParams（供代码块插入器等使用） */
  private getBlockDefinitions(): BlockDefinitionWithParams[] {
    return FINANCE_CODE_BLOCK_DEFS.map((def: CodeBlockDef) => ({
      language: def.language,
      name: t(def.titleKey),
      description: t(def.descKey),
      icon: def.icon,
      template: def.template,
      params: def.params.map((p) => ({
        key: p.key,
        label: t(p.labelKey),
        labelKey: p.labelKey,
        description: p.descKey ? t(p.descKey) : undefined,
        type: p.type,
        optional: p.optional,
        placeholder: p.placeholder,
        options: p.options,
        optionLabels: p.optionLabels,
        optionsFrom: p.optionsFrom,
        defaultValue: p.defaultValue,
        autoToday: p.autoToday,
      })),
    }));
  }
}
