// obsidian 测试桩（vitest 用，避免依赖真实 Obsidian 运行时）
// 仅覆盖本插件在单元测试中实际用到的最小子集；真实运行由 Obsidian 提供 obsidian 模块。

export class Plugin {
  app: unknown;
  constructor(app: unknown) {
    this.app = app;
  }
  addCommand(): void {}
  addRibbonIcon(): void {}
  addSettingTab(): void {}
  registerMarkdownCodeBlockProcessor(): void {}
  async loadData(): Promise<Record<string, unknown>> {
    return {};
  }
  async saveData(): Promise<void> {}
}

export type MarkdownPostProcessorContext = unknown;
export type TFile = { path: string; extension: string };
export type TFolder = { path: string; children: unknown[] };

export class App {
  vault = {
    adapter: {
      async exists(_path: string): Promise<boolean> { return false; },
      async read(_path: string): Promise<string> { return '{}'; },
      async write(_path: string, _data: string): Promise<void> {},
      async mkdir(_path: string): Promise<void> {},
    },
    getAbstractFileByPath(_path: string): unknown { return null; },
    getAllLoadedFiles(): unknown[] { return []; },
    async cachedRead(_file: unknown): Promise<string> { return ''; },
  };
  workspace = {
    getActiveViewOfType(_type: unknown): unknown { return null; },
  };
  commands = {
    commands: new Map<string, unknown>(),
  };
  isMobile = false;
}

export class Modal {
  app: App;
  contentEl = document.createElement('div');
  constructor(app: App) { this.app = app; }
  open(): void {}
  close(): void {}
  onOpen(): void {}
  onClose(): void {}
}

export class FuzzySuggestModal<T> extends Modal {
  setPlaceholder(_text: string): void {}
  getItems(): T[] { return []; }
  getItemText(_item: T): string { return ''; }
  onChooseItem(_item: T): void {}
}

export class MarkdownView {
  editor = {
    replaceSelection(_text: string): void {},
  };
}

export class Notice {
  constructor(_message: string) {}
}

export function setIcon(_el: HTMLElement, _iconName: string): void {}

export class PluginSettingTab {
  app: unknown;
  plugin: unknown;
  containerEl = { empty() {} };
  constructor(app: unknown, plugin: unknown) {
    this.app = app;
    this.plugin = plugin;
  }
  display(): void {}
}

export class Setting {
  constructor(_containerEl: unknown) {}
  setName(_name: string): this { return this; }
  setDesc(_desc: string): this { return this; }
  addText(
    cb: (t: {
      setValue: (v: string) => { onChange: (cb: (v: string) => Promise<void>) => void };
    }) => void,
  ): this {
    cb({ setValue: () => ({ onChange: () => {} }) });
    return this;
  }
  addToggle(
    cb: (t: {
      setValue: (v: boolean) => { onChange: (cb: (v: boolean) => Promise<void>) => void };
    }) => void,
  ): this {
    cb({ setValue: () => ({ onChange: () => {} }) });
    return this;
  }
  addDropdown(
    cb: (d: {
      addOption: (value: string, display: string) => { addOption: (value: string, display: string) => unknown; setValue: (v: string) => { onChange: (cb: (v: string) => Promise<void>) => void } };
    }) => void,
  ): this {
    const chain = {
      addOption: () => chain,
      setValue: () => ({ onChange: () => {} }),
    };
    cb(chain);
    return this;
  }
  addButton(
    cb: (b: {
      setButtonText: (text: string) => { onClick: (cb: () => void) => void };
    }) => void,
  ): this {
    cb({ setButtonText: () => ({ onClick: () => {} }) });
    return this;
  }
}
