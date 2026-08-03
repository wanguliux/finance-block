/*
 * blockProvider.ts —— 代码块定义共享类型 + 跨插件通用「插入代码块」发现机制
 *
 * BlockDefinitionWithParams / ParamDef 描述一个可插入的代码块及其参数，
 * 被代码块处理器（registry）与各类录入弹窗（EntryFormModal、RecordTransactionModal 等）共用。
 *
 * 文件末尾的 tryRegisterInsertCommand / getBlockProviders 实现「跨插件通用插入器」：
 * 多个 block 插件可同时安装，但通用插入命令/ribbon 只有一个宿主，其余插件仅作为
 * BlockProvider 被合并展示（通过 app.plugins.plugins 动态发现，无硬编码依赖）。
 */

import { App, Command } from 'obsidian';
import { t } from './i18n';

/** 单个可插入的 block 参数定义 */
export interface ParamDef {
  key: string;
  label: string;
  labelKey?: string; // i18n key（原始 key，用于校验提示等需要回查翻译的场景）
  description?: string;
  type: string; // 参数类型（各插件可扩展；通用 Modal 对未知类型 fallback 为 text）
  optional?: boolean; // 是否选填（默认 true，false=必填）
  placeholder?: string;
  options?: string[]; // 静态选项
  optionLabels?: Record<string, string>;
  /**
   * 动态选项数据源（type=select 时生效，优先于 options）。
   * 通用 Modal 对未知来源直接回落到 options，因此其他插件可以安全忽略此字段。
   * finance-block 支持：'accounts' | 'transactionTypes' | 'owners'
   */
  optionsFrom?: string;
  defaultValue?: string;
  /** type=date 时是否自动填入今天（记账场景要，筛选场景留空才对） */
  autoToday?: boolean;
}

/** 单个可插入的 block 定义（对外暴露给 Modal / 表单的格式） */
export interface BlockDefinitionWithParams {
  language: string; // fence 语言标识
  name: string; // 显示名（i18n 翻译后）
  description?: string; // 说明（i18n 翻译后）
  icon?: string; // Obsidian 图标名
  template?: string; // 原始模板（含 {{key}} 占位）——有 template 时用模板替换模式生成代码块
  multiLeg?: boolean; // 复式分录块：录入为 N 腿动态结构（type:'legs' 参数驱动），文本由 buildCodeBlock 动态生成
  params: ParamDef[]; // 参数定义
  /** 所属插件 ID，用于跨插件 Modal 的 Tab 分组（契约要求） */
  pluginId?: string;
  /** 契约别名：与 name 同义，供遵循契约的其他插件 Modal 读取（本插件内部用 name） */
  title?: string;
}

// ─────────────────────────────────────────────────────────────
// 跨插件通用「插入代码块」机制（BlockProvider 契约 + 宿主协商）
// 设计遵循 obsidian-block-provider 契约（first-claim-wins 宿主策略、
// app.plugins.plugins 动态扫描、app.commands.commands key 匹配避免重复注册）。
// ─────────────────────────────────────────────────────────────

/** 跨插件通用「插入代码块」命令 ID（所有 block 插件共用同一 ID，靠宿主协商避免重复注册） */
export const COMMAND_ID = 'insert-block';

/** 实现「跨插件通用插入器」宿主协商的插件需满足的最小接口 */
export interface UniversalInsertPlugin {
  app: App;
  addCommand(command: Command): Command;
  /** BlockProvider 契约：声明本插件提供的可插入 block 定义 */
  getBlockRegistry?: () => BlockDefinitionWithParams[];
}

/** App.plugins / App.commands 在 Obsidian 公开类型中均未暴露，这里仅声明发现所需的最小形状 */
interface AppWithPlugins extends App {
  plugins: { plugins: Record<string, unknown> };
  commands?: { commands?: Record<string, unknown> };
}

/** 按插件分组的代码块集合（供 Modal 的 Tab 分组展示） */
export interface ProviderGroup {
  pluginId: string;
  pluginName: string;
  blocks: BlockDefinitionWithParams[];
}

/**
 * 跨插件通用「插入代码块」命令的宿主协商（first-claim wins）。
 *
 * 多个 block 插件可能同时安装，但通用插入命令/ribbon 只能有一个宿主，
 * 否则命令面板/侧栏会出现重复项。
 *
 * 关键：Obsidian 内部将命令以 `pluginId:commandId` 形式存储（如 `finance-block:insert-block`）。
 * 因此必须遍历 app.commands.commands 的所有 key，匹配 `endsWith(':insert-block')`
 * 来判断「是否已有宿主」——不能依赖插件实例上的私有标记（独立模块作用域下对其他插件不可见）。
 *
 * @returns 本插件是否成为宿主（决定是否显示 ribbon）
 */
export function tryRegisterInsertCommand(plugin: UniversalInsertPlugin, open: () => void): boolean {
  const commands = (plugin.app as AppWithPlugins).commands?.commands;
  if (commands) {
    for (const key of Object.keys(commands)) {
      if (key === COMMAND_ID || key.endsWith(`:${COMMAND_ID}`)) {
        // 已有插件注册了通用插入命令，本插件退让，仅作为 Provider
        return false;
      }
    }
  }

  plugin.addCommand({
    id: COMMAND_ID,
    name: t('command.insertBlock'),
    callback: open,
  });
  return true;
}

/**
 * 跨插件聚合所有 BlockProvider（按插件分组）。
 * 通过运行时扫描 app.plugins.plugins 上实现了 getBlockRegistry() 的插件动态发现，
 * 无需模块级注册表（独立模块作用域下模块级数组对别的插件不可见）。
 */
export function getBlockProviders(app: App): ProviderGroup[] {
  const plugins = (app as AppWithPlugins).plugins.plugins;
  const groups: ProviderGroup[] = [];

  for (const [id, plugin] of Object.entries(plugins)) {
    const candidate = plugin as {
      getBlockRegistry?: () => BlockDefinitionWithParams[];
      manifest?: { name?: string };
    };
    if (typeof candidate.getBlockRegistry === 'function') {
      const blocks = candidate.getBlockRegistry();
      if (blocks.length > 0) {
        groups.push({
          pluginId: id,
          pluginName: candidate.manifest?.name ?? id,
          blocks,
        });
      }
    }
  }
  return groups;
}
