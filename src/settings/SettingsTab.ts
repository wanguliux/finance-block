import { App, PluginSettingTab, Setting } from 'obsidian';
import type FinancePlugin from '../main';
import { t, setLocale, type Locale } from '../i18n';
import { rerenderAllBlocks } from '../codeblock/registry';
import { CurrencyManagerModal } from '../ui/CurrencyManagerModal';
import { AccountManagerModal } from '../ui/AccountManagerModal';
import { TypeManagerModal } from '../ui/TypeManagerModal';
import { OwnerManagerModal } from '../ui/OwnerManagerModal';
import { ArchiveManagerModal } from '../ui/ArchiveManagerModal';
import { BudgetManagerModal } from '../ui/BudgetManagerModal';
import { LifeEventManagerModal } from '../ui/LifeEventManagerModal';
import { PathSuggest } from '../ui/PathSuggest';

export class FinanceSettingTab extends PluginSettingTab {
  plugin: FinancePlugin;

  constructor(app: App, plugin: FinancePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── 置顶：配置文件路径 ───────────────────────────────
    new Setting(containerEl)
      .setName(t('settings.configPath'))
      .setDesc(t('settings.configPath.desc'))
      .addText((text) => {
        text
          .setPlaceholder(t('settings.configPath.placeholder'))
          .setValue(this.plugin.settings.configPath)
          .onChange(async (value) => {
            this.plugin.settings.configPath = value;
            await this.plugin.saveSettings();
          });
        new PathSuggest(this.app, text);
      });

    // ── 置顶：账本文件路径（单一文件） + 存档管理入口 ────
    new Setting(containerEl)
      .setName(t('settings.ledgerPath'))
      .setDesc(t('settings.ledgerPath.desc'))
      .addText((text) => {
        text
          .setPlaceholder(t('settings.ledgerPath.placeholder'))
          .setValue(this.plugin.settings.ledgerPath)
          .onChange(async (value) => {
            this.plugin.settings.ledgerPath = value;
            await this.plugin.saveSettings();
          });
        new PathSuggest(this.app, text);
      })
      .addButton((button) =>
        button
          .setButtonText(t('settings.archiveManager'))
          .onClick(() => {
            new ArchiveManagerModal(this.plugin).open();
          }),
      );

    // ── 语言选择 ──────────────────────────────────────────
    new Setting(containerEl)
      .setName(t('settings.language'))
      .setDesc(t('settings.language.desc'))
      .addDropdown((dropdown) =>
        dropdown
          .addOption('zh', '中文')
          .addOption('en', 'English')
          .setValue(this.plugin.settings.language)
          .onChange(async (value) => {
            this.plugin.settings.language = value;
            await this.plugin.saveSettings();
            setLocale(value as Locale);
            rerenderAllBlocks(); // 已打开的笔记里代码块同步切语言
            this.display(); // 刷新设置页文本
          }),
      );

    // ── 币种与汇率（打开管理弹窗） ────────────────────────
    new Setting(containerEl)
      .setName(t('settings.currencyManager'))
      .setDesc(t('settings.currencyManager.desc'))
      .addButton((button) =>
        button
          .setButtonText(t('settings.openManager'))
          .onClick(() => {
            new CurrencyManagerModal(this.plugin).open();
          }),
      );

    // ── 账户（打开管理弹窗） ──────────────────────────────
    new Setting(containerEl)
      .setName(t('settings.accounts'))
      .setDesc(t('settings.accounts.desc'))
      .addButton((button) =>
        button
          .setButtonText(t('settings.openManager'))
          .onClick(() => {
            new AccountManagerModal(this.plugin).open();
          }),
      );

    // ── 交易类型（打开管理弹窗） ──────────────────────────
    new Setting(containerEl)
      .setName(t('settings.transactionTypes'))
      .setDesc(t('settings.transactionTypes.desc'))
      .addButton((button) =>
        button
          .setButtonText(t('settings.openManager'))
          .onClick(() => {
            new TypeManagerModal(this.plugin).open();
          }),
      );

    // ── 归属维度（打开管理弹窗） ──────────────────────────
    new Setting(containerEl)
      .setName(t('settings.owners'))
      .setDesc(t('settings.owners.desc'))
      .addButton((button) =>
        button
          .setButtonText(t('settings.openManager'))
          .onClick(() => {
            new OwnerManagerModal(this.plugin).open();
          }),
      );

    // ── 预算管理（打开管理弹窗） ──────────────────────────
    new Setting(containerEl)
      .setName(t('settings.budgetManager'))
      .setDesc(t('settings.budgetManager.desc'))
      .addButton((button) =>
        button
          .setButtonText(t('settings.openManager'))
          .onClick(() => {
            new BudgetManagerModal(this.plugin).open();
          }),
      );

    // ── 人生事件（打开管理弹窗，阶段三事件模拟器入口） ─────
    new Setting(containerEl)
      .setName(t('settings.lifeEventManager'))
      .setDesc(t('settings.lifeEventManager.desc'))
      .addButton((button) =>
        button
          .setButtonText(t('settings.openManager'))
          .onClick(() => {
            new LifeEventManagerModal(this.plugin).open();
          }),
      );

    // ── 未入账提醒 ────────────────────────────────────────
    new Setting(containerEl)
      .setName(t('settings.draftReminder'))
      .setDesc(t('settings.draftReminder.desc'))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.draftReminder).onChange(async (value) => {
          this.plugin.settings.draftReminder = value;
          await this.plugin.saveSettings();
        }),
      );

    // ── 待入账筛查（默认关：关闭时启动零全库扫描）───────────
    new Setting(containerEl)
      .setName(t('settings.draftScan'))
      .setDesc(t('settings.draftScan.desc'))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.draftScan).onChange(async (value) => {
          this.plugin.settings.draftScan = value;
          await this.plugin.saveSettings();
          // 开关变化即时重建索引：开启=按范围扫草稿；关闭=清空草稿、只读账本
          void this.plugin.indexer?.fullScan();
          this.display(); // 按开关显隐「筛查范围」输入
        }),
      );

    // 仅当开启筛查时才展示范围输入（留空 = 全库）
    if (this.plugin.settings.draftScan) {
      new Setting(containerEl)
        .setName(t('settings.draftScanFolders'))
        .setDesc(t('settings.draftScanFolders.desc'))
        .addText((text) => {
          text
            .setPlaceholder(t('settings.draftScanFolders.placeholder'))
            .setValue(this.plugin.settings.draftScanFolders.join(', '))
            .onChange(async (value) => {
              this.plugin.settings.draftScanFolders = value
                .split(',')
                .map((s) => s.trim())
                .filter((s) => s.length > 0);
              await this.plugin.saveSettings();
              // 范围变化即时重建索引（仅开启时该设置才有意义）
              void this.plugin.indexer?.fullScan();
            });
          new PathSuggest(this.app, text);
        });
    }
  }
}
