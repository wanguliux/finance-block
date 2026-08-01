/**
 * PathSuggest —— 设置页路径输入框的「库内候选自动补全」
 *
 * 覆盖两个文件存储路径设置项（configPath / ledgerPath）：
 * 用户在输入框打字时，自动弹出库内已加载的文件与文件夹作为候选，
 * 选中后把完整路径回填并触发设置保存。
 *
 * 复用 Obsidian 官方 AbstractInputSuggest（1.4.10+ 可用），
 * 它负责定位下拉、键盘导航与渲染骨架，本类只实现三件事：
 *   - getSuggestions：按输入做子串匹配（文件夹优先、路径排序、限 50 条）
 *   - renderSuggestion：展示路径，并区分文件夹/文件
 *   - selectSuggestion：回填路径 + 派发 input 事件以触发 TextComponent 的 onChange（即保存）
 */

import { AbstractInputSuggest, App, TAbstractFile, TFolder, TextComponent } from 'obsidian';

export class PathSuggest extends AbstractInputSuggest<TAbstractFile> {
  constructor(
    app: App,
    private text: TextComponent,
  ) {
    super(app, text.inputEl);
  }

  getSuggestions(inputStr: string): TAbstractFile[] {
    const q = inputStr.trim().toLowerCase();
    if (!q) return []; // 空输入不弹，避免一次性列出整个库

    return this.app.vault
      .getAllLoadedFiles()
      .filter((f) => f.path.toLowerCase().includes(q))
      .sort((a, b) => {
        const af = a instanceof TFolder ? 0 : 1;
        const bf = b instanceof TFolder ? 0 : 1;
        if (af !== bf) return af - bf; // 文件夹优先
        return a.path.localeCompare(b.path);
      })
      .slice(0, 50);
  }

  renderSuggestion(file: TAbstractFile, el: HTMLElement): void {
    const isFolder = file instanceof TFolder;
    el.setText(file.path + (isFolder ? '/' : ''));
    el.addClass(isFolder ? 'fb-suggest-folder' : 'fb-suggest-file');
  }

  selectSuggestion(file: TAbstractFile): void {
    const v = file.path;
    this.setValue(v); // 回填输入框
    // 派发 input 事件，触发 TextComponent.onChange → 保存设置
    this.text.inputEl.dispatchEvent(new Event('input'));
    this.close();
  }
}
