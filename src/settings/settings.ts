// 插件设置（持久化在 Obsidian 私有 data.json，区别于 vault 内的 finance-config.json）
export interface FinancePluginSettings {
  ledgerPath: string; // 账本文件路径（单一文件，如 "账本/账本.md"）
  archiveLedgers: string[]; // 归档账本文件路径列表（rollover 维护，旧账本保留作档案）
  configPath: string; // vault 内 finance-config.json 的路径
  draftReminder: boolean; // 仪表盘提醒"你有 N 笔未入账"
  draftScan: boolean; // 待入账筛查：扫描笔记中的未入账草稿块（默认关，关闭时启动不做全库扫描）
  draftScanFolders: string[]; // 筛查范围：仅扫描这些文件夹（空 = 全库；仅当 draftScan 开启时生效）
  language: string; // 界面语言：zh / en
}

export const DEFAULT_SETTINGS: FinancePluginSettings = {
  ledgerPath: '账本/账本.md', // 单一账本文件
  archiveLedgers: [], // 无归档
  configPath: 'finance-config.json',
  draftReminder: true,
  draftScan: false, // 默认关闭：多数用法是「记一笔」直接入账，无散落草稿
  draftScanFolders: [],
  language: 'zh',
};
