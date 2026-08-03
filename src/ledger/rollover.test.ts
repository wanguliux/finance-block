import { describe, it, expect } from 'vitest';
import { executeRollover } from './rollover';
import type { FinancePluginSettings } from '../settings/settings';
import type { Indexer, IndexEntry } from './indexer';

/** 极简内存 adapter，仅实现被用到的 read/write/exists/mkdir */
function makeApp(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial };
  const dirs = new Set<string>();
  return {
    vault: {
      adapter: {
        async exists(p: string) {
          return Object.prototype.hasOwnProperty.call(store, p) || dirs.has(p);
        },
        async mkdir(p: string) {
          dirs.add(p);
        },
        async read(p: string) {
          if (!(p in store)) throw new Error(`File not found: ${p}`);
          return store[p];
        },
        async write(p: string, c: string) {
          store[p] = c;
        },
      },
    },
    _store: store,
  };
}

const postedEntries: IndexEntry[] = [
  {
    transaction: { id: '^t-1', date: '2026-07-10', legs: [{ account: '现金', amount: 5000 }, { account: '费用:餐饮', amount: -5000 }] },
    sourceFile: '账本/2026-07.md',
    blockRefId: '^t-1',
    isDraft: false,
  },
  {
    transaction: { id: '^t-2', date: '2026-07-20', legs: [{ account: '现金', amount: -3000 }, { account: '费用:交通', amount: 3000 }] },
    sourceFile: '账本/2026-07.md',
    blockRefId: '^t-2',
    isDraft: false,
  },
];

/** 用桩 Indexer：只提供 rollover 实际用到的两个方法 */
function stubIndexer(): Indexer {
  return {
    getAllTransactions: () => postedEntries,
    fullScan: async () => {},
  } as unknown as Indexer;
}

function makeSettings(): FinancePluginSettings {
  return {
    ledgerPath: '账本/2026-07.md',
    archiveLedgers: [],
    configPath: 'finance-config.json',
    draftScan: false,
    draftScanFolders: [],
    language: 'zh',
    managerOrder: [],
  };
}

describe('executeRollover', () => {
  it('把期末余额承接进新账本（期初记录），旧账本归档且不改名', async () => {
    const app = makeApp();
    const settings = makeSettings();
    let saved = false;
    const saveSettings = async () => {
      saved = true;
    };

    const res = await executeRollover(
      app as any,
      settings,
      saveSettings,
      stubIndexer(),
      { newLedgerPath: '账本/账本-2026.md', cutoffDate: '2026-07-31' },
    );

    expect(res.success).toBe(true);

    // 设置更新：ledgerPath 指向新账本，旧账本进入归档列表
    expect(settings.ledgerPath).toBe('账本/账本-2026.md');
    expect(settings.archiveLedgers).toContain('账本/2026-07.md');
    expect(saved).toBe(true);

    // 新账本文件已创建，含标题 + 单个 fin-beancount 块 + 期初记录
    const newContent = app._store['账本/账本-2026.md'];
    expect(newContent).toBeTruthy();
    expect(newContent).toContain('# 账本-2026');
    expect(newContent).toContain('期初结转');
    // 余额：现金 = 5000-3000 = 2000；费用:餐饮 = -5000；费用:交通 = 3000（零和）
    expect(newContent).toContain('现金  2000');
    expect(newContent).toContain('费用:餐饮  -5000');
    expect(newContent).toContain('费用:交通  3000');

    // 旧账本未被触碰（内容不变、仍在）
    expect(app._store['账本/2026-07.md']).toBeUndefined(); // 初始就不存在，确保只新建了新账本
  });

  it('cutoff 之前的已入账余额才被承接（之后交易不入期初）', async () => {
    const app = makeApp();
    const settings = makeSettings();
    // 加一笔 cutoff 之后的交易
    postedEntries.push({
      transaction: { id: '^t-3', date: '2026-08-05', legs: [{ account: '现金', amount: -100 }, { account: '费用:餐饮', amount: 100 }] },
      sourceFile: '账本/2026-07.md',
      blockRefId: '^t-3',
      isDraft: false,
    });

    const res = await executeRollover(
      app as any,
      settings,
      async () => {},
      stubIndexer(),
      { newLedgerPath: '账本/账本-2026.md', cutoffDate: '2026-07-31' },
    );

    expect(res.success).toBe(true);
    const newContent = app._store['账本/账本-2026.md'];
    // 8 月的交易不在期初（截止 7-31）
    expect(newContent).not.toContain('^t-3');
    expect(newContent).toContain('现金  2000'); // 仍只反映 7 月内余额
  });
});
