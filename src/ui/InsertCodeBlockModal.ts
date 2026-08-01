/*
 * InsertCodeBlockModal —— 「插入代码块」主弹窗（按插件 Tab 分组）
 *
 * 跨插件聚合所有 BlockProvider（getBlockProviders 扫描 app.plugins.plugins 上实现了
 * getBlockRegistry() 的插件），按插件分组展示：
 *   - 顶部 Tab 栏显示各插件名称（ProviderGroup.pluginName）
 *   - 点击 Tab 切换该插件的代码块卡片
 *   - 搜索在当前 Tab 内过滤
 *   - 仅一个 Provider 时 Tab 栏自动隐藏
 * 点击某张卡片即打开对应的 InsertCodeBlockParamModal 配置参数并插入到光标处。
 */

import type { App } from 'obsidian';
import { Modal, setIcon } from 'obsidian';
import { t } from '../i18n';
import type { BlockDefinitionWithParams, ProviderGroup } from '../blockProvider';
import { getBlockProviders } from '../blockProvider';
import type { FinanceConfig } from '../types';
import { InsertCodeBlockParamModal } from './InsertCodeBlockParamModal';

export class InsertCodeBlockModal extends Modal {
  private config?: FinanceConfig;
  private groups: ProviderGroup[] = [];
  private activePluginId = '';
  private tabBarEl!: HTMLDivElement;
  private listEl!: HTMLDivElement;
  private searchEl!: HTMLInputElement;

  constructor(app: App, config?: FinanceConfig) {
    super(app);
    this.config = config;
    this.groups = getBlockProviders(app);
    this.activePluginId = this.groups[0]?.pluginId ?? '';
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('finance-insert-modal');

    contentEl.createEl('h2', { text: t('modal.insert.title') });

    const searchWrap = contentEl.createDiv({ cls: 'finance-insert-search' });
    this.searchEl = searchWrap.createEl('input', {
      type: 'text',
      placeholder: t('modal.insert.searchPlaceholder'),
      cls: 'finance-input',
    });
    this.searchEl.addEventListener('input', () => this.renderList());

    // Tab 栏：仅一个 Provider 时隐藏
    this.tabBarEl = contentEl.createDiv({ cls: 'finance-insert-tabs' });
    this.tabBarEl.style.display = this.groups.length > 1 ? '' : 'none';

    this.listEl = contentEl.createDiv({ cls: 'finance-insert-list' });
    this.renderTabs();
    this.renderList();
  }

  private renderTabs(): void {
    this.tabBarEl.empty();
    for (const g of this.groups) {
      const tab = this.tabBarEl.createEl('button', {
        text: g.pluginName,
        cls: 'finance-insert-tab',
      });
      if (g.pluginId === this.activePluginId) tab.addClass('is-active');
      tab.addEventListener('click', () => {
        this.activePluginId = g.pluginId;
        this.renderTabs();
        this.renderList();
      });
    }
  }

  private activeGroup(): ProviderGroup | undefined {
    return this.groups.find((g) => g.pluginId === this.activePluginId);
  }

  private renderList(): void {
    this.listEl.empty();
    const group = this.activeGroup();
    if (!group) return;

    const q = this.searchEl.value.trim().toLowerCase();
    const blocks = q
      ? group.blocks.filter(
          (b) =>
            b.name.toLowerCase().includes(q) || (b.description ?? '').toLowerCase().includes(q),
        )
      : group.blocks;

    if (blocks.length === 0) {
      this.listEl.createDiv({ text: t('modal.insert.noMatch'), cls: 'finance-insert-empty' });
      return;
    }

    for (const block of blocks) {
      const card = this.listEl.createDiv({ cls: 'finance-insert-card' });

      const iconEl = card.createSpan({ cls: 'finance-insert-card-icon' });
      if (block.icon) setIcon(iconEl, block.icon);

      const body = card.createDiv({ cls: 'finance-insert-card-body' });
      body.createEl('div', { text: block.name, cls: 'finance-insert-card-title' });
      if (block.description) {
        body.createEl('div', {
          text: block.description,
          cls: 'finance-insert-card-desc',
        });
      }
      body.createEl('div', {
        text: t('modal.insert.paramsCount', { n: String(block.params.length) }),
        cls: 'finance-insert-card-meta',
      });

      card.addEventListener('click', () => {
        this.close();
        new InsertCodeBlockParamModal(this.app, block, this.config).open();
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
