import { describe, it, expect } from 'vitest';
import { appendEntryToLedgerBlock } from './ledgerFile';

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

const FENCE_RE = /```fin-beancount[\s\S]*?```/g;
function countBlocks(content: string): number {
  return (content.match(FENCE_RE) || []).length;
}

describe('appendEntryToLedgerBlock', () => {
  it('账本文件不存在时：创建文件 + 单个 fin-beancount 块', async () => {
    const app = makeApp();
    const res = await appendEntryToLedgerBlock(
      app as any,
      '账本/2026-07.md',
      '2026-07-29 * 午餐\n  现金 -3500\n  餐饮 3500',
      '^t-20260729120000',
    );

    expect(res.success).toBe(true);
    expect(res.ledgerPath).toBe('账本/2026-07.md');
    const content = app._store['账本/2026-07.md'];
    expect(countBlocks(content)).toBe(1);
    expect(content).toContain('# 2026-07');
    expect(content).toContain('2026-07-29 * 午餐');
    expect(content).toContain('^t-20260729120000');
  });

  it('账本已存在唯一块时：新分录追加进该块底部（仍只有一个块）', async () => {
    const existing =
      '# 2026-07\n\n' +
      '```fin-beancount\n' +
      '2026-07-28 * 早餐\n  现金 -1500\n  餐饮 1500\n^t-20260728080000\n' +
      '```\n';
    const app = makeApp({ '账本/2026-07.md': existing });

    const res = await appendEntryToLedgerBlock(
      app as any,
      '账本/2026-07.md',
      '2026-07-29 * 午餐\n  现金 -3500\n  餐饮 3500',
      '^t-20260729120000',
    );

    expect(res.success).toBe(true);
    const content = app._store['账本/2026-07.md'];
    expect(countBlocks(content)).toBe(1); // 关键：仍是唯一一个块
    // 新分录在旧分录之后、闭合 ``` 之前
    const firstIdx = content.indexOf('2026-07-28 * 早餐');
    const secondIdx = content.indexOf('2026-07-29 * 午餐');
    const closeIdx = content.lastIndexOf('```');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(closeIdx).toBeGreaterThan(secondIdx);
    expect(content).toContain('^t-20260729120000');
    expect(content).toContain('^t-20260728080000');
  });

  it('blockRefId 缺前导 ^t- 时自动补全', async () => {
    const app = makeApp();
    const res = await appendEntryToLedgerBlock(
      app as any,
      '2026-07.md',
      '2026-07-29 * 咖啡\n  现金 -2000\n  餐饮 2000',
      't-20260729120000',
    );
    expect(res.success).toBe(true);
    expect(app._store['2026-07.md']).toContain('^t-20260729120000');
  });

  it('账本文件存在但无 fin-beancount 块时：末尾追加一个新块', async () => {
    const app = makeApp({ '账本/2026-07.md': '# 2026-07\n\n一些备注文字\n' });
    const res = await appendEntryToLedgerBlock(
      app as any,
      '账本/2026-07.md',
      '2026-07-29 * 午餐\n  现金 -3500\n  餐饮 3500',
      '^t-20260729120000',
    );
    expect(res.success).toBe(true);
    const content = app._store['账本/2026-07.md'];
    expect(countBlocks(content)).toBe(1);
    expect(content).toContain('2026-07-29 * 午餐');
  });

  it('连续追加多笔：最后一条分录的 ^t- 与闭合 ``` 之间必须有换行（修复黏连 bug）', async () => {
    const existing =
      '# 2026-07\n\n' +
      '```fin-beancount\n' +
      '2026-07-28 * 早餐\n  现金 -1500\n  餐饮 1500\n^t-20260728080000\n' +
      '```\n';
    const app = makeApp({ '账本/2026-07.md': existing });

    // 追加第 2 笔
    await appendEntryToLedgerBlock(
      app as any,
      '账本/2026-07.md',
      '2026-07-29 * 午餐\n  现金 -3500\n  餐饮 3500',
      '^t-20260729120000',
    );
    // 追加第 3 笔（最后一条）
    await appendEntryToLedgerBlock(
      app as any,
      '账本/2026-07.md',
      '2026-07-30 * 晚餐\n  现金 -2000\n  餐饮 2000',
      '^t-20260730190000',
    );

    const content = app._store['账本/2026-07.md'];
    expect(countBlocks(content)).toBe(1);

    // 关键断言：最后一条分录的块引用 ID 绝不能黏在闭合 ``` 上
    expect(content).not.toContain('^t-20260730190000```');
    expect(content).toMatch(/\^t-20260730190000\n```/);
    expect(content).not.toContain('^t-20260729120000```');
    expect(content).toMatch(/\^t-20260729120000\n/);
    expect(content).toMatch(/\^t-20260728080000\n/);
  });
});
