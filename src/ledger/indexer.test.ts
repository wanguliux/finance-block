import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock Obsidian（vitest 环境无 obsidian 模块）───────────────
// normalizePath 把 Windows 分隔符统一成 '/'，模拟 Obsidian 的真实行为
vi.mock('obsidian', () => {
  const normalizePath = (p: string): string => p.replace(/\\/g, '/');
  class TFile {}
  class TFolder {}
  return { normalizePath, TFile, TFolder };
});

import { Indexer } from './indexer';
import { TFile } from 'obsidian';

/** 极简内存 vault：getAbstractFileByPath 对 '\' 容错（与 Obsidian 一致） */
function makeApp(files: Map<string, { content: string; mtime: number }>) {
  const np = (p: string) => p.replace(/\\/g, '/');
  return {
    vault: {
      adapter: {
        async exists(p: string) {
          return files.has(np(p));
        },
        async stat(p: string) {
          const f = files.get(np(p));
          if (!f) return null;
          return { mtime: f.mtime, ctime: f.mtime, size: f.content.length };
        },
        async read(p: string) {
          const f = files.get(np(p));
          if (!f) throw new Error(`File not found: ${p}`);
          return f.content;
        },
        async write(p: string, c: string) {
          const f = files.get(np(p));
          files.set(np(p), { content: c, mtime: (f?.mtime ?? 0) + 1 });
        },
        async mkdir(_p: string) {
          /* noop */
        },
        async remove(p: string) {
          files.delete(np(p));
        },
      },
      getAbstractFileByPath(p: string) {
        const key = np(p);
        if (files.has(key)) return Object.assign(new TFile(), { path: key });
        return null;
      },
      getMarkdownFiles() {
        return [...files.keys()].map((p) => Object.assign(new TFile(), { path: p }));
      },
      cachedRead(file: { path: string }) {
        const f = files.get(np(file.path));
        if (!f) throw new Error(`File not found: ${file.path}`);
        return f.content;
      },
      async read(file: { path: string }) {
        const f = files.get(np(file.path));
        if (!f) throw new Error(`File not found: ${file.path}`);
        return f.content;
      },
    },
  };
}

// 账本内容：3 条已入账交易（真实用户场景）
const LEDGER_CONTENT = [
  '```fin-beancount',
  '2026-07-30 * 下午茶',
  '  支付宝 -1500',
  '  餐饮 1500',
  '  type: 餐饮',
  '^t-202607300001',
  '',
  '2026-07-30 * 入账工资',
  '  银行卡 400',
  '  工资 -400',
  '  type: 工资',
  '^t-202607300002',
  '',
  '2026-07-30 * 打车',
  '  支付宝 -300',
  '  交通 300',
  '  type: 交通',
  '^t-202607300003',
  '```',
].join('\n');

describe('Indexer 重复索引防护（finance-log 重复 bug）', () => {
  let files: Map<string, { content: string; mtime: number }>;

  beforeEach(() => {
    files = new Map();
    files.set('账本/账本.md', { content: LEDGER_CONTENT, mtime: 1000 });
  });

  it('ledgerPath 含 Windows 分隔符时不应重复索引（bug 复现/修复验证）', async () => {
    const app = makeApp(files);
    // 用户设置里常填成 \ 分隔
    const indexer = new Indexer(app as any, '账本\\账本.md', []);
    await indexer.init(); // 纯内存索引：init 必定触发 fullScan

    const entries = indexer.getAllTransactions();
    // 修复后：账本文件只被索引一次（scanDrafts 正确跳过），应为 3 条，而非 6 条
    expect(entries.length, `索引条目数应为3，实际为${entries.length}`).toBe(3);
    // 且不应出现“既是 posted 又是 draft”的重复
    const posted = entries.filter((e) => !e.isDraft);
    const drafts = entries.filter((e) => e.isDraft);
    expect(posted.length).toBe(3);
    expect(drafts.length).toBe(0);
  });

  it('updateFile（Windows 分隔符）幂等：不产生重复', async () => {
    const app = makeApp(files);
    const indexer = new Indexer(app as any, '账本\\账本.md', []);
    await indexer.init();

    expect(indexer.getAllTransactions().length).toBe(3);

    // 模拟 Obsidian 修改事件（传入 Windows 分隔符路径）
    await indexer.updateFile('账本\\账本.md');
    await indexer.updateFile('账本\\账本.md');

    expect(indexer.getAllTransactions().length, '多次 updateFile 后仍应为3').toBe(3);
  });

  it('ledgerPath 同时出现在 archiveLedgers（路径形态不同）时不重复索引', async () => {
    const app = makeApp(files);
    // 把同一文件以不同分隔符形态同时放进 ledgerPath 与 archiveLedgers
    const indexer = new Indexer(app as any, '账本/账本.md', ['账本\\账本.md']);
    await indexer.init();

    expect(indexer.getAllTransactions().length, '多形态路径指向同一文件应只索引一次').toBe(3);
  });
});

describe('Indexer 纯内存化（不再落盘 finance-index.json）', () => {
  it('init 后 vault 内不应生成索引缓存文件', async () => {
    const files = new Map<string, { content: string; mtime: number }>();
    files.set('账本/账本.md', { content: LEDGER_CONTENT, mtime: 1000 });

    const app = makeApp(files);
    const indexer = new Indexer(app as any, '账本/账本.md', []);
    await indexer.init();
    await indexer.fullScan();
    await indexer.updateFile('账本/账本.md');
    await indexer.removeFile('不存在的文件.md');

    expect(files.has('账本/finance-index.json'), '不应写出索引缓存文件').toBe(false);
  });

  it('init 时自动清理旧版遗留的 finance-index.json', async () => {
    const files = new Map<string, { content: string; mtime: number }>();
    files.set('账本/账本.md', { content: LEDGER_CONTENT, mtime: 1000 });
    files.set('账本/finance-index.json', { content: '{"version":2}', mtime: 1000 });

    const app = makeApp(files);
    const indexer = new Indexer(app as any, '账本\\账本.md', []);
    await indexer.init();

    expect(files.has('账本/finance-index.json'), '遗留缓存文件应被删除').toBe(false);
    // 遗留 json 不是 md，删除后账本仍应正常索引
    expect(indexer.getAllTransactions().length).toBe(3);
  });

  it('getStats 正确区分已入账与草稿', async () => {
    const files = new Map<string, { content: string; mtime: number }>();
    files.set('账本/账本.md', { content: LEDGER_CONTENT, mtime: 1000 });
    files.set('日记/2026-07-30.md', {
      content: ['```fin-beancount', '2026-07-30 * 咖啡', '  现金 -30', '  餐饮 30', '```'].join(
        '\n'
      ),
      mtime: 1000,
    });

    const app = makeApp(files);
    const indexer = new Indexer(app as any, '账本/账本.md', [], () => ({
      enabled: true,
      folders: [],
    }));
    await indexer.init();

    const stats = indexer.getStats();
    expect(stats.postedCount).toBe(3);
    expect(stats.draftCount).toBe(1);
    expect(stats.totalTransactions).toBe(4);
    expect(indexer.getPostedTransactions().length).toBe(3);
  });
});

describe('Indexer 待入账筛查（范围过滤）', () => {
  const DRAFT_IN_SCOPE = ['```fin-beancount', '2026-07-30 * 咖啡', '  现金 -30', '  餐饮 30', '```'].join(
    '\n'
  );
  const DRAFT_OUT_SCOPE = ['```fin-beancount', '2026-07-30 * 电影', '  现金 -80', '  娱乐 80', '```'].join(
    '\n'
  );

  function buildFiles() {
    const files = new Map<string, { content: string; mtime: number }>();
    files.set('账本/账本.md', { content: LEDGER_CONTENT, mtime: 1000 });
    files.set('日记/2026-07-30.md', { content: DRAFT_IN_SCOPE, mtime: 1000 });
    files.set('其他/随手记.md', { content: DRAFT_OUT_SCOPE, mtime: 1000 });
    return files;
  }

  it('关闭筛查（默认）：不扫描任何笔记草稿，draftCount=0', async () => {
    const app = makeApp(buildFiles());
    const indexer = new Indexer(app as any, '账本/账本.md', []);
    await indexer.init();
    expect(indexer.getStats().draftCount, '默认关，应零草稿、零全库遍历').toBe(0);
  });

  it('开启筛查 + 限定范围「日记」：只扫范围内草稿', async () => {
    const app = makeApp(buildFiles());
    const indexer = new Indexer(app as any, '账本/账本.md', [], () => ({
      enabled: true,
      folders: ['日记'],
    }));
    await indexer.init();
    const stats = indexer.getStats();
    expect(stats.postedCount).toBe(3);
    expect(stats.draftCount, '仅 日记/ 下 1 笔草稿被扫到').toBe(1);
  });

  it('开启筛查 + 范围留空：扫描整个库的所有草稿', async () => {
    const app = makeApp(buildFiles());
    const indexer = new Indexer(app as any, '账本/账本.md', [], () => ({
      enabled: true,
      folders: [],
    }));
    await indexer.init();
    const stats = indexer.getStats();
    expect(stats.draftCount, '日记 + 其他 共 2 笔草稿').toBe(2);
  });
});
