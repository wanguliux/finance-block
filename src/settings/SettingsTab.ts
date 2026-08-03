import { App, PluginSettingTab, Setting, TextComponent } from 'obsidian';
import type { SettingDefinitionItem, SettingGroupItem } from 'obsidian';
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

/* FinanceSettingTab —— 插件设置页（双轨渲染，参照 workout-block 同款结构）。
 *
 * - Obsidian ≥ 1.13.0：用声明式 getSettingDefinitions() 渲染。
 *   原生支持：设置搜索 / 「管理」列表的拖拽排序（type:'list' + onReorder）/
 *   条件显隐（visible 回调）。
 * - Obsidian < 1.13.0：回退到命令式 display()。
 *   「管理」条目降级为 ↑/↓ 箭头按钮排序（拖拽是 1.13 原生能力，低版本无此能力）。
 *
 * 两套渲染内容完全一致。管理条目顺序持久化在 settings.managerOrder，
 * 由 normalizeManagerOrder 校验补齐（只认 MANAGER_KEYS 里的 key）。
 */

/** 管理条目 key 全集（顺序持久化以它为准；新增管理入口时在此追加） */
const MANAGER_KEYS = ['currency', 'account', 'type', 'owner', 'budget', 'lifeEvent'] as const;
type ManagerKey = (typeof MANAGER_KEYS)[number];

/** 路径类输入行的 key（存储语义不同，bindPathInput 里分别处理） */
type PathKey = 'configPath' | 'ledgerPath' | 'draftScanFolders';

export class FinanceSettingTab extends PluginSettingTab {
  plugin: FinancePlugin;

  constructor(app: App, plugin: FinancePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  // ── 管理条目定义（声明式 + 命令式共用） ────────────────
  private buildManagers(): Record<ManagerKey, { name: string; desc: string; open: () => void }> {
    return {
      currency: {
        name: t('settings.currencyManager'),
        desc: t('settings.currencyManager.desc'),
        open: () => new CurrencyManagerModal(this.plugin).open(),
      },
      account: {
        name: t('settings.accounts'),
        desc: t('settings.accounts.desc'),
        open: () => new AccountManagerModal(this.plugin).open(),
      },
      type: {
        name: t('settings.transactionTypes'),
        desc: t('settings.transactionTypes.desc'),
        open: () => new TypeManagerModal(this.plugin).open(),
      },
      owner: {
        name: t('settings.owners'),
        desc: t('settings.owners.desc'),
        open: () => new OwnerManagerModal(this.plugin).open(),
      },
      budget: {
        name: t('settings.budgetManager'),
        desc: t('settings.budgetManager.desc'),
        open: () => new BudgetManagerModal(this.plugin).open(),
      },
      lifeEvent: {
        name: t('settings.lifeEventManager'),
        desc: t('settings.lifeEventManager.desc'),
        open: () => new LifeEventManagerModal(this.plugin).open(),
      },
    };
  }

  /** 校验管理条目顺序：仅保留已知 key 并补齐缺失 key，保证顺序数组始终完整合法 */
  private normalizeManagerOrder(saved: string[] | undefined): ManagerKey[] {
    const valid = (saved ?? []).filter((k): k is ManagerKey => (MANAGER_KEYS as readonly string[]).includes(k));
    const missing = MANAGER_KEYS.filter((k) => !valid.includes(k));
    return [...valid, ...missing];
  }

  // ===== 声明式渲染（Obsidian ≥ 1.13.0）：设置搜索 / 拖拽排序 / 条件显隐 =====

  getSettingDefinitions(): SettingDefinitionItem[] {
    const managers = this.buildManagers();
    const order = this.normalizeManagerOrder(this.plugin.settings.managerOrder);

    // 管理条目列表：整行 name/desc + 「打开管理」按钮；
    // onReorder 会让 Obsidian 自动为每行加拖拽手柄（设置搜索也顺带可用）。
    const managerItems: SettingGroupItem[] = order.map((key) => {
      const m = managers[key];
      return {
        name: m.name,
        desc: m.desc,
        render: (setting: Setting) => {
          setting.addButton((btn) => btn.setButtonText(t('settings.openManager')).onClick(() => m.open()));
        },
      };
    });

    return [
      // ── 区块一：数据文件（configPath / ledgerPath） ──
      {
        type: 'group',
        heading: t('settings.dataSection'),
        items: [
          {
            name: t('settings.configPath'),
            desc: t('settings.configPath.desc'),
            render: (setting: Setting) => this.renderPathInput(setting, 'configPath', t('settings.configPath.placeholder')),
          },
          {
            name: t('settings.ledgerPath'),
            desc: t('settings.ledgerPath.desc'),
            render: (setting: Setting) => {
              this.renderPathInput(setting, 'ledgerPath', t('settings.ledgerPath.placeholder'));
              // 存档管理入口挂在账本路径行（与原命令式布局一致）
              setting.addButton((btn) =>
                btn.setButtonText(t('settings.archiveManager')).onClick(() => new ArchiveManagerModal(this.plugin).open()),
              );
            },
          },
        ],
      },
      // ── 区块二：管理（可拖拽排序） ──
      {
        type: 'list',
        heading: t('settings.managers'),
        items: managerItems,
        onReorder: (oldIndex: number, newIndex: number) => {
          const current = this.normalizeManagerOrder(this.plugin.settings.managerOrder);
          const [moved] = current.splice(oldIndex, 1);
          current.splice(newIndex, 0, moved);
          this.plugin.settings.managerOrder = [...current];
          void this.plugin.saveSettings();
        },
      },
      // ── 区块三：通用 ──
      {
        type: 'group',
        heading: t('settings.generalSection'),
        items: [
          {
            name: t('settings.language'),
            desc: t('settings.language.desc'),
            control: { type: 'dropdown', key: 'language', options: { zh: '中文', en: 'English' } },
          },
          {
            name: t('settings.draftScan'),
            desc: t('settings.draftScan.desc'),
            control: { type: 'toggle', key: 'draftScan' },
          },
          {
            name: t('settings.draftScanFolders'),
            desc: t('settings.draftScanFolders.desc'),
            // 仅当「待入账筛查」开启时才展示范围输入
            visible: () => this.plugin.settings.draftScan,
            render: (setting: Setting) => this.renderPathInput(setting, 'draftScanFolders', t('settings.draftScanFolders.placeholder')),
          },
        ],
      },
    ];
  }

  // 声明式控件「当前值读取」钩子（Obsidian ≥ 1.13.0 调用）
  getControlValue(key: string): unknown {
    const s = this.plugin.settings as unknown as Record<string, unknown>;
    return s[key];
  }

  // 声明式控件「值变更持久化」钩子（Obsidian ≥ 1.13.0 调用）
  async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.plugin.settings as unknown as Record<string, unknown>;
    s[key] = value;
    await this.plugin.saveSettings();
    if (key === 'language') {
      setLocale((value as Locale) ?? 'zh');
      rerenderAllBlocks(); // 已打开的笔记里代码块同步切语言
      this.update(); // 刷新设置页文案（重取 getSettingDefinitions()）
    } else if (key === 'draftScan') {
      // 开关变化即时重建索引：开启=按范围扫草稿；关闭=清空草稿、只读账本
      void this.plugin.indexer?.fullScan();
      this.update(); // 重估「筛查范围」的 visible
    }
  }

  // ===== 命令式回退（Obsidian < 1.13.0）：与声明式内容一致 =====

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── 区块一：数据文件 ──────────────────────────────
    new Setting(containerEl).setName(t('settings.dataSection')).setHeading();
    new Setting(containerEl)
      .setName(t('settings.configPath'))
      .setDesc(t('settings.configPath.desc'))
      .addText((text) => this.bindPathInput(text, 'configPath', t('settings.configPath.placeholder')));
    new Setting(containerEl)
      .setName(t('settings.ledgerPath'))
      .setDesc(t('settings.ledgerPath.desc'))
      .addText((text) => this.bindPathInput(text, 'ledgerPath', t('settings.ledgerPath.placeholder')))
      .addButton((button) =>
        button
          .setButtonText(t('settings.archiveManager'))
          .onClick(() => {
            new ArchiveManagerModal(this.plugin).open();
          }),
      );

    // ── 区块二：管理（↑/↓ 箭头排序 + 打开管理按钮） ────
    new Setting(containerEl).setName(t('settings.managers')).setHeading();
    const managers = this.buildManagers();
    const order = this.normalizeManagerOrder(this.plugin.settings.managerOrder);
    order.forEach((key, idx) => {
      const m = managers[key];
      const row = new Setting(containerEl).setName(m.name).setDesc(m.desc);
      // ↑/↓ 排序箭头（低版本无拖拽能力，用箭头等价调整顺序；首尾项不显示对应方向）
      if (idx > 0) {
        row.addExtraButton((cb) =>
          cb
            .setIcon('arrow-up')
            .setTooltip(t('settings.moveUp'))
            .onClick(() => void this.moveManager(idx, idx - 1)),
        );
      }
      if (idx < order.length - 1) {
        row.addExtraButton((cb) =>
          cb
            .setIcon('arrow-down')
            .setTooltip(t('settings.moveDown'))
            .onClick(() => void this.moveManager(idx, idx + 1)),
        );
      }
      row.addButton((btn) => btn.setButtonText(t('settings.openManager')).onClick(() => m.open()));
    });

    // ── 区块三：通用 ──────────────────────────────────
    new Setting(containerEl).setName(t('settings.generalSection')).setHeading();
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
        .addText((text) => this.bindPathInput(text, 'draftScanFolders', t('settings.draftScanFolders.placeholder')));
    }
  }

  // ── 共享行渲染 ────────────────────────────────────────

  /** 声明式路径输入行：text + 库内路径建议器（PathSuggest） */
  private renderPathInput(setting: Setting, key: PathKey, placeholder: string): void {
    setting.addText((text) => this.bindPathInput(text, key, placeholder));
  }

  /** 绑定路径类输入：回显现值 + PathSuggest + onChange 持久化。
   * configPath / ledgerPath 存字符串；draftScanFolders 逗号拆分成数组。 */
  private bindPathInput(text: TextComponent, key: PathKey, placeholder: string): void {
    const settings = this.plugin.settings;
    const current =
      key === 'draftScanFolders' ? settings.draftScanFolders.join(', ') : key === 'configPath' ? settings.configPath : settings.ledgerPath;
    text
      .setPlaceholder(placeholder)
      .setValue(current)
      .onChange(async (value) => {
        if (key === 'draftScanFolders') {
          settings.draftScanFolders = value
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          await this.plugin.saveSettings();
          // 范围变化即时重建索引（仅开启时该设置才有意义）
          void this.plugin.indexer?.fullScan();
        } else {
          settings[key] = value;
          await this.plugin.saveSettings();
        }
      });
    new PathSuggest(this.app, text);
  }

  /** 命令式回退下移动管理条目顺序（保存后重绘） */
  private async moveManager(from: number, to: number): Promise<void> {
    const current = this.normalizeManagerOrder(this.plugin.settings.managerOrder);
    const [moved] = current.splice(from, 1);
    current.splice(to, 0, moved);
    this.plugin.settings.managerOrder = [...current];
    await this.plugin.saveSettings();
    this.display();
  }
}
