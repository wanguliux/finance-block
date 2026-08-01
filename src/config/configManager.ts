import type { App } from 'obsidian';
import type { FinanceConfig } from '../types';
import { DEFAULT_CONFIG } from './defaults';
import { CURRENCY_SYMBOLS } from '../engine/fx';

/**
 * 配置管理器：负责从 vault 读取 / 写入 finance-config.json，
 * 并与 DEFAULT_CONFIG 做深度合并（用户只需写差异部分）。
 */
export class ConfigManager {
  private config: FinanceConfig;
  private readonly configPath: string;
  private readonly app: App;

  constructor(app: App, configPath: string) {
    this.app = app;
    this.configPath = configPath;
    this.config = structuredClone(DEFAULT_CONFIG);
  }

  /** 从 vault 加载配置，与默认值合并 */
  async load(): Promise<FinanceConfig> {
    const adapter = this.app.vault.adapter;
    if (await adapter.exists(this.configPath)) {
      try {
        const raw = await adapter.read(this.configPath);
        const userConfig = JSON.parse(raw) as Partial<FinanceConfig> & {
          fxRates?: Record<string, number>; // 旧版字段，迁移用
        };
        this.config = this.merge(DEFAULT_CONFIG, userConfig);

        // 迁移：旧版汇率表 fxRates → 新版币种列表 currencies。
        // 仅当用户尚未使用 currencies（老用户）时触发，新配置跳过。
        const legacyFx = userConfig.fxRates;
        if (legacyFx && (!this.config.currencies || this.config.currencies.length === 0)) {
          this.config.currencies = Object.entries(legacyFx).map(([code, rate]) => ({
            code,
            name: code,
            symbol: CURRENCY_SYMBOLS[code] ?? code,
            rate,
          }));
        }
        // 清掉已被 currencies 取代的 fxRates 字段，避免旧结构残留
        delete (this.config as unknown as Record<string, unknown>).fxRates;
      } catch {
        // 解析失败时回退默认配置，不阻塞插件启动
        console.warn(`[finance-block] 配置文件解析失败，使用默认配置: ${this.configPath}`);
        this.config = structuredClone(DEFAULT_CONFIG);
      }
    } else {
      // 首次使用：写入默认配置
      this.config = structuredClone(DEFAULT_CONFIG);
      await this.save();
    }
    return this.config;
  }

  /** 将当前配置写入 vault */
  async save(): Promise<void> {
    const adapter = this.app.vault.adapter;
    const dir = this.configPath.includes('/')
      ? this.configPath.slice(0, this.configPath.lastIndexOf('/'))
      : '';
    if (dir && !(await adapter.exists(dir))) {
      await adapter.mkdir(dir);
    }
    await adapter.write(this.configPath, JSON.stringify(this.config, null, 2));
  }

  /** 获取当前配置（只读引用） */
  get(): Readonly<FinanceConfig> {
    return this.config;
  }

  /** 更新配置（部分更新）并持久化 */
  async update(patch: Partial<FinanceConfig>): Promise<FinanceConfig> {
    this.config = this.merge(this.config, patch);
    await this.save();
    return this.config;
  }

  /** 浅层合并：数组与对象直接覆盖（用户意图明确），标量取用户值 */
  private merge(base: FinanceConfig, patch: Partial<FinanceConfig>): FinanceConfig {
    const result = structuredClone(base);
    for (const key of Object.keys(patch) as (keyof FinanceConfig)[]) {
      const val = patch[key];
      if (val !== undefined) {
        (result as unknown as Record<string, unknown>)[key] = structuredClone(val);
      }
    }
    return result;
  }
}
