/**
 * 交易索引器（Indexer）—— 纯内存
 *
 * 核心职责：
 * 1. 解析账本文件与笔记中的 fin-beancount 代码块，聚合成内存索引
 * 2. 文件增删改时增量更新对应条目
 * 3. 提供查询接口（全部 / 已入账 / 统计）
 *
 * 设计取舍（2026-07-31 改造）：
 * 旧版把索引落盘为 vault 内的 finance-index.json，实测收益为零且有害——
 * - 启动时若缓存文件存在则**完全不重扫**，插件关闭期间在外部改动的笔记读到陈旧数据；
 * - mtime 元数据（files[]）只在跨会话时才可能命中，而 modify 事件必然使 mtime 变化，等于永不命中；
 * - vault 里多一个机器生成的大 JSON，污染文件树与 Git diff。
 * 现改为纯内存：启动全量扫描重建，vault 内只保留 finance-config.json 一个文件。
 */

import { App, TFile, normalizePath } from 'obsidian';
import { parseFinBeancount } from '../parser/finBeancount';
import type { Transaction, Valuation } from '../types';

/** 索引条目（一条交易记录） */
export interface IndexEntry {
  transaction: Transaction;
  sourceFile: string; // 源文件路径
  blockRefId?: string; // 块引用 ID（入账后生成）
  isDraft: boolean; // 是否草稿（未入账）
}

/** 索引统计 */
export interface IndexStats {
  totalTransactions: number;
  draftCount: number; // 未入账草稿数
  postedCount: number; // 已入账数
}

/** 估值索引条目（带来源文件，用于增量更新） */
interface ValuationEntry {
  valuation: Valuation;
  sourceFile: string;
}

/** 待入账筛查配置（由 settings 注入，实时读取） */
export interface DraftScanConfig {
  enabled: boolean; // 是否扫描笔记中的未入账草稿（默认关：关闭时启动只读账本文件，零全库扫描）
  folders: string[]; // 筛查范围文件夹（空 = 全库；仅 enabled 时生效）
}

/** 旧版落盘缓存文件名（仅用于一次性清理遗留文件） */
const LEGACY_INDEX_FILE_NAME = 'finance-index.json';

/**
 * 索引器类
 */
export class Indexer {
  private app: App;
  private ledgerPath: string;
  private archiveLedgers: string[];
  private getDraftScan: () => DraftScanConfig;
  private entries: IndexEntry[] = [];
  private valuations: ValuationEntry[] = []; // 估值快照索引（跨活跃+归档账本合并）
  private isInitialized = false;

  constructor(
    app: App,
    ledgerPath: string,
    archiveLedgers: string[],
    getDraftScan: () => DraftScanConfig = () => ({ enabled: false, folders: [] }),
  ) {
    this.app = app;
    // 统一路径分隔符：Obsidian 内部一律用 '/'，但用户设置在 Windows 上常含 '\'。
    // 不规范化会导致 fullScan 的 ledgerPaths 与 file.path 形态不一致，
    // scanDrafts 的「跳过账本文件」判断失效 → 账本被当草稿重复索引（finance-log 重复 bug）。
    this.ledgerPath = normalizePath(ledgerPath);
    this.archiveLedgers = archiveLedgers.map((p) => normalizePath(p));
    // 待入账筛查配置用 getter 注入（而非快照）：设置页改动后 fullScan 即读到新值
    this.getDraftScan = getDraftScan;
  }

  /** 是否在待入账筛查范围内（enabled 且命中范围文件夹；范围为空 = 全库） */
  private isInDraftScope(np: string): boolean {
    const cfg = this.getDraftScan();
    if (!cfg.enabled) return false;
    if (cfg.folders.length === 0) return true;
    return cfg.folders.some((f) => {
      const folder = normalizePath(f).replace(/\/+$/, '');
      return folder !== '' && np.startsWith(folder + '/');
    });
  }

  /**
   * 初始化索引器：全量扫描重建内存索引，并清理旧版遗留的落盘缓存
   */
  async init(): Promise<void> {
    if (this.isInitialized) return;

    await this.cleanupLegacyIndexFile();
    await this.fullScan();

    this.isInitialized = true;
  }

  /**
   * 一次性清理：删除旧版本遗留在 vault 里的 finance-index.json
   * （索引已改为纯内存，vault 内只应留 finance-config.json）
   */
  private async cleanupLegacyIndexFile(): Promise<void> {
    try {
      const adapter = this.app.vault.adapter;
      const folder = this.ledgerPath.includes('/')
        ? this.ledgerPath.slice(0, this.ledgerPath.lastIndexOf('/'))
        : '';
      const legacyPath = folder
        ? `${folder}/${LEGACY_INDEX_FILE_NAME}`
        : LEGACY_INDEX_FILE_NAME;

      if (await adapter.exists(legacyPath)) {
        await adapter.remove(legacyPath);
        console.log(`[finance-block] Removed legacy index cache: ${legacyPath}`);
      }
    } catch (error) {
      // 清理失败不阻塞插件启动
      console.warn('[finance-block] Failed to remove legacy index cache:', error);
    }
  }

  /**
   * 全量扫描：解析所有账本文件（激活账本 + 归档账本）+ 笔记中的草稿
   */
  async fullScan(): Promise<void> {
    this.entries = [];
    this.valuations = [];

    // 激活账本 + 所有归档账本，统一作为"已入账"数据源
    const ledgerPaths = new Set<string>([this.ledgerPath, ...this.archiveLedgers]);
    for (const path of ledgerPaths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        await this.indexFile(file);
      }
    }

    // 扫描其余 md 文件中的草稿（笔记里的未入账 fin-beancount 块）
    await this.scanDrafts(ledgerPaths);
  }

  /**
   * 扫描草稿（非账本文件中的交易）。
   * 仅当「待入账筛查」开启时执行；范围文件夹非空时只扫范围内的笔记。
   * 关闭时启动只读账本几个文件，无全库遍历。
   */
  private async scanDrafts(ledgerPaths: Set<string>): Promise<void> {
    if (!this.getDraftScan().enabled) return;

    const allFiles = this.app.vault.getMarkdownFiles();

    for (const file of allFiles) {
      // 跳过账本文件（激活 / 归档，已由 fullScan 索引）
      if (ledgerPaths.has(file.path)) continue;
      // 范围过滤（含 enabled 判定；folders 为空 = 全库）
      if (!this.isInDraftScope(file.path)) continue;

      const content = await this.app.vault.cachedRead(file);
      const codeBlocks = this.extractFinBeancountBlocks(content);

      for (const block of codeBlocks) {
        const result = parseFinBeancount(block.source);
        for (const txn of result.transactions) {
          this.entries.push({
            transaction: txn,
            sourceFile: file.path,
            blockRefId: undefined,
            isDraft: true,
          });
        }
      }
    }
  }

  /**
   * 索引单个文件（先清掉该文件的旧条目，再重新解析，保证幂等）
   */
  async indexFile(file: TFile): Promise<void> {
    this.entries = this.entries.filter((e) => e.sourceFile !== file.path);
    this.valuations = this.valuations.filter((v) => v.sourceFile !== file.path);

    const content = await this.app.vault.read(file);
    const codeBlocks = this.extractFinBeancountBlocks(content);

    for (const block of codeBlocks) {
      const result = parseFinBeancount(block.source);

      // 检查是否已入账（源码中包含 ^t- 行）
      const isPosted = /^\^t-\d+/m.test(block.source);

      for (const txn of result.transactions) {
        this.entries.push({
          transaction: txn,
          sourceFile: file.path,
          blockRefId: isPosted ? txn.id : undefined,
          isDraft: !isPosted,
        });
      }

      // 收集估值行（仅账本文件中的估值生效，草稿笔记中的不计入）
      for (const val of result.valuations) {
        this.valuations.push({ valuation: val, sourceFile: file.path });
      }
    }
  }

  /**
   * 从文件内容中提取 fin-beancount 代码块
   */
  private extractFinBeancountBlocks(
    content: string
  ): Array<{ source: string; startPos: number; endPos: number }> {
    const blocks: Array<{ source: string; startPos: number; endPos: number }> = [];
    const pattern = /```fin-beancount\r?\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(content)) !== null) {
      blocks.push({
        source: match[1],
        startPos: match.index,
        endPos: match.index + match[0].length,
      });
    }

    return blocks;
  }

  /**
   * 增量更新：重新索引指定文件
   */
  async updateFile(filePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(filePath));
    if (file instanceof TFile) {
      await this.indexFile(file);
    }
  }

  /**
   * 删除文件后清理其索引条目（避免删除账本/笔记后索引残留陈旧数据）
   */
  async removeFile(filePath: string): Promise<void> {
    const np = normalizePath(filePath);
    this.entries = this.entries.filter((e) => e.sourceFile !== np);
    this.valuations = this.valuations.filter((v) => v.sourceFile !== np);
  }

  /**
   * 获取估值快照（跨活跃+归档账本合并）。
   * @param account 可选，按账户名筛选
   */
  getValuations(account?: string): Valuation[] {
    const vals = this.valuations.map((v) => v.valuation);
    if (account) return vals.filter((v) => v.account === account);
    return vals;
  }

  /**
   * 获取所有已入账交易
   */
  getPostedTransactions(): IndexEntry[] {
    return this.entries.filter((e) => !e.isDraft);
  }

  /**
   * 获取索引统计
   */
  getStats(): IndexStats {
    const total = this.entries.length;
    const drafts = this.entries.filter((e) => e.isDraft).length;

    return {
      totalTransactions: total,
      draftCount: drafts,
      postedCount: total - drafts,
    };
  }

  /**
   * 获取所有交易（包括草稿）
   */
  getAllTransactions(): IndexEntry[] {
    return [...this.entries];
  }
}
