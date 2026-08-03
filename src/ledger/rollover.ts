/**
 * 汇总结转服务（Rollover / Roll-forward）
 *
 * 背景（参考用户设计点）：
 *   账本改为「单一文件」后会越滚越大。为此在账本 fin-beancount 块上提供
 *   「汇总结转」按钮：把当前账本的余额**承接**到新账本，旧账本保留作归档。
 *
 * 核心职责：
 * 1. 计算截至截止日的各账户期末余额（复用 closing.calculateBalances）
 * 2. 生成新账本的「期初 / 结转」记录（用正向余额铺账，符号与 closing 的清零相反）
 * 3. 创建新账本文件（含标题 + 单个 fin-beancount 块）
 * 4. 更新设置：ledgerPath 指向新账本；旧账本加入 archiveLedgers（rollover 维护）
 * 5. 重建索引：新账本 + 旧账本归档，所有视图照常工作
 *
 * 关键约定（来自设计 spec）：
 * - 余额结转，非全量搬移：新账本只写期初记录，旧文件留全部明细作归档。
 * - 旧文件不重命名（笔记里的 finance-log id= 走 index 按 ID 查，不受改名影响）。
 * - 草稿不随轮换丢失：只结转已入账交易，未入账草稿仍在原笔记。
 */

import type { App } from 'obsidian';
import type { Indexer, IndexEntry } from './indexer';
import { calculateBalances, type AccountBalance } from './closing';
import type { FinancePluginSettings } from '../settings/settings';

/** 汇总结转选项 */
export interface RolloverOptions {
  newLedgerPath: string; // 新账本文件路径（如 账本/账本-2026.md）
  cutoffDate: string; // 结转截止日（含），YYYY-MM-DD
}

/** 汇总结转结果 */
export interface RolloverResult {
  success: boolean;
  oldLedgerPath: string;
  newLedgerPath: string;
  openingEntry?: string; // 生成的期初 / 结转分录
  error?: string;
}

/**
 * 生成期初 / 结转分录（fin-beancount 格式，正向余额铺账）
 *
 * 与 closing.generateClosingEntry 的区别：
 *   - closing 把余额取反（清零旧账）：账户 = -balance，equity:结转 = +total
 *   - 此处把余额原样铺到新账本作为期初：账户 = +balance，equity:期初 = -total
 *   两者合计为零，新账本起点即旧账本期末余额。
 */
function generateOpeningEntry(closingDate: string, balances: AccountBalance[]): string {
  const lines: string[] = [];
  lines.push(`${closingDate} * 期初结转 · 余额承接`);

  let sum = 0;
  for (const b of balances) {
    if (b.balance === 0) continue;
    lines.push(`  ${b.account}  ${b.balance}`);
    sum += b.balance;
  }

  // 轧差到 equity:期初（使整笔零和）
  if (sum !== 0) {
    lines.push(`  equity:期初  ${-sum}`);
  }

  lines.push(`  period: 期初`);
  lines.push(`^t-rollover-${Date.now()}`); // 块引用 ID（已入账）
  lines.push('');

  return lines.join('\n');
}

/**
 * 执行汇总结转
 */
export async function executeRollover(
  app: App,
  settings: FinancePluginSettings,
  saveSettings: () => Promise<void>,
  indexer: Indexer,
  options: RolloverOptions,
): Promise<RolloverResult> {
  const oldLedgerPath = settings.ledgerPath;

  try {
    // 1. 计算截至截止日的各账户期末余额（仅已入账）
    const allEntries: IndexEntry[] = indexer.getAllTransactions();
    const balances = calculateBalances(allEntries, undefined, options.cutoffDate);

    // 2. 生成新账本期初记录（正向余额铺账）
    const openingEntry = generateOpeningEntry(options.cutoffDate, balances);

    // 3. 创建新账本文件（含标题 + 单个 fin-beancount 块，期初记录入块内）
    const adapter = app.vault.adapter;
    const folder = options.newLedgerPath.includes('/')
      ? options.newLedgerPath.slice(0, options.newLedgerPath.lastIndexOf('/'))
      : '';
    if (folder && !(await adapter.exists(folder))) {
      await adapter.mkdir(folder);
    }
    const title = options.newLedgerPath.split('/').pop()?.replace(/\.md$/, '') || '账本';
    const content = `# ${title}\n\n\`\`\`fin-beancount\n${openingEntry}\n\`\`\`\n`;
    await adapter.write(options.newLedgerPath, content);

    // 4. 更新设置：ledgerPath 指向新账本，旧账本加入归档列表
    settings.ledgerPath = options.newLedgerPath;
    if (!settings.archiveLedgers.includes(oldLedgerPath)) {
      settings.archiveLedgers.push(oldLedgerPath);
    }
    await saveSettings();

    // 5. 重建索引（新账本 + 旧账本归档），所有视图即时更新
    await indexer.fullScan();

    return {
      success: true,
      oldLedgerPath,
      newLedgerPath: options.newLedgerPath,
      openingEntry,
    };
  } catch (error) {
    // 回滚内存中的设置变更，避免 settings 与持久化状态不一致
    settings.ledgerPath = oldLedgerPath;
    settings.archiveLedgers = settings.archiveLedgers.filter((p) => p !== oldLedgerPath);
    return {
      success: false,
      oldLedgerPath,
      newLedgerPath: options.newLedgerPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
