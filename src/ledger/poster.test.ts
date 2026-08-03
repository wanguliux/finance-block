import { describe, it, expect } from 'vitest';
import { postTransactionsInBlock, splitTransactions, splitEntries, generateValuationRefId, generateBlockRefId } from './poster';

/** 内存 App mock：同时覆盖 ledger 的 vault.adapter.* 与 note 的 vault.read/modify */
function makeApp(initial: Record<string, string> = {}) {
  const files: Record<string, string> = { ...initial };
  const dirs = new Set<string>();
  const asFile = (p: string) => ({ path: p }) as any;
  return {
    vault: {
      adapter: {
        async exists(p: string) {
          return Object.prototype.hasOwnProperty.call(files, p) || dirs.has(p);
        },
        async mkdir(p: string) {
          dirs.add(p);
        },
        async read(p: string) {
          if (!(p in files)) throw new Error(`File not found: ${p}`);
          return files[p];
        },
        async write(p: string, c: string) {
          files[p] = c;
        },
      },
      async read(file: any) {
        const p = typeof file === 'string' ? file : file.path;
        if (!(p in files)) throw new Error(`File not found: ${p}`);
        return files[p];
      },
      async modify(file: any, c: string) {
        const p = typeof file === 'string' ? file : file.path;
        files[p] = c;
      },
    },
    _files: files,
  };
}

const DRAFT_BLOCK = [
  '```fin-beancount',
  '2026-08-01 * 工资',
  '  现金 1000000',
  '  工资 -1000000',
  '  type: 收入',
  '',
  '2026-08-02 * 午餐',
  '  现金 -3500',
  '  日常 3500',
  '  type: 支出',
  '',
  '2026-08-03 * 买股票',
  '  现金 -5000000',
  '  股票 5000000',
  '```',
].join('\n');

const NOTE_PATH = '笔记/草稿.md';
const LEDGER_PATH = '账本/账本.md';

describe('splitTransactions', () => {
  it('按空行拆分成多笔交易', () => {
    const parts = splitTransactions(DRAFT_BLOCK.replace(/```fin-beancount\n/, '').replace(/\n```$/, ''));
    expect(parts).toHaveLength(3);
    expect(parts[0]).toContain('工资');
    expect(parts[1]).toContain('午餐');
    expect(parts[2]).toContain('买股票');
  });

  it('无空行分隔的连续交易也能拆分', () => {
    const src = '2026-08-01 * A\n  现金 -100\n  日常 100\n2026-08-02 * B\n  现金 -200\n  日常 200';
    const parts = splitTransactions(src);
    expect(parts).toHaveLength(2);
  });

  it('valuation 指令不被视为交易', () => {
    const src = '2026-08-01 * A\n  现金 -100\n  日常 100\n2026-08-01 custom "fb-valuation" 股票 5000000';
    const parts = splitTransactions(src);
    expect(parts).toHaveLength(1);
  });
});

describe('postTransactionsInBlock（多笔草稿逐笔/批量入账）', () => {
  it('批量入账：每笔独立 ^t-，原位重建为各自 finance-log 卡片', async () => {
    const app = makeApp({ [NOTE_PATH]: DRAFT_BLOCK });
    const startPos = 0;
    const endPos = DRAFT_BLOCK.length;

    const { results } = await postTransactionsInBlock(
      app as any,
      { path: NOTE_PATH } as any,
      DRAFT_BLOCK.replace(/```fin-beancount\n/, '').replace(/\n```$/, ''),
      startPos,
      endPos,
      LEDGER_PATH,
      [0, 1, 2],
    );

    expect(results.every((r) => r.success)).toBe(true);
    expect(results.map((r) => r.blockRefId)).toHaveLength(3);

    // 账本：3 笔各自带独立 ^t- 块引用
    const ledger = app._files[LEDGER_PATH];
    const ids = (ledger.match(/\^t-\d+/g) || []);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(ledger).toContain('工资');
    expect(ledger).toContain('午餐');
    expect(ledger).toContain('买股票');

    // 笔记：整块被替换为 3 张 finance-log 卡片，不再有 fin-beancount 草稿块
    const note = app._files[NOTE_PATH];
    expect((note.match(/```finance-log/g) || []).length).toBe(3);
    expect((note.match(/```fin-beancount/g) || []).length).toBe(0);
  });

  it('逐笔入账中间一笔：该笔变 finance-log 卡片，其余留在 fin-beancount 草稿块', async () => {
    const app = makeApp({ [NOTE_PATH]: DRAFT_BLOCK });
    const body = DRAFT_BLOCK.replace(/```fin-beancount\n/, '').replace(/\n```$/, '');

    const { results } = await postTransactionsInBlock(
      app as any,
      { path: NOTE_PATH } as any,
      body,
      0,
      DRAFT_BLOCK.length,
      LEDGER_PATH,
      [1], // 只入账「午餐」
    );

    expect(results[0].success).toBe(true);

    const ledger = app._files[LEDGER_PATH];
    expect((ledger.match(/\^t-\d+/g) || []).length).toBe(1);
    expect(ledger).toContain('午餐');

    const note = app._files[NOTE_PATH];
    // 1 张 finance-log 卡片（已入账的「午餐」）
    expect((note.match(/```finance-log/g) || []).length).toBe(1);
    // 剩余 2 笔按原顺序保留在 fin-beancount 草稿块中（被已入账卡片隔开 → 2 个块）
    expect((note.match(/```fin-beancount/g) || []).length).toBe(2);
    expect(note).toContain('工资');
    expect(note).toContain('买股票');
  });

  it('重复入账同一笔：第二次被拒绝，不重复写入账本', async () => {
    const app = makeApp({ [NOTE_PATH]: DRAFT_BLOCK });
    const body = DRAFT_BLOCK.replace(/```fin-beancount\n/, '').replace(/\n```$/, '');

    await postTransactionsInBlock(app as any, { path: NOTE_PATH } as any, body, 0, DRAFT_BLOCK.length, LEDGER_PATH, [0]);
    // 模拟该笔已带 ^t-（入账后原位已是 finance-log，这里直接对带 ^t- 的 body 再入账验证守卫）
    const postedBody = body.replace('2026-08-01 * 工资', '2026-08-01 * 工资\n^t-20260801120000');
    const { results } = await postTransactionsInBlock(app as any, { path: NOTE_PATH } as any, postedBody, 0, postedBody.length, LEDGER_PATH, [0]);

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('已入账');
  });
});

describe('splitEntries（含估值）', () => {
  it('估值行被拆为独立条目（kind=valuation）', () => {
    const src = '2026-08-01 * A\n  现金 -100\n  日常 100\n2026-08-01 custom "fb-valuation" 股票 5300000';
    const parts = splitEntries(src);
    expect(parts).toHaveLength(2);
    expect(parts[0].kind).toBe('txn');
    expect(parts[1].kind).toBe('valuation');
    expect(parts[1].text).toContain('fb-valuation');
  });

  it('已带 ^v- 的估值行仍被识别为 valuation 且带块引用', () => {
    const src = '2026-08-01 custom "fb-valuation" 股票 5300000\n^v-20260801120000';
    const parts = splitEntries(src);
    expect(parts).toHaveLength(1);
    expect(parts[0].kind).toBe('valuation');
    expect(parts[0].text).toContain('^v-20260801120000');
  });
});

describe('generateValuationRefId', () => {
  it('生成 ^v- 前缀且与 ^t- 对称', () => {
    const v = generateValuationRefId();
    const t = generateBlockRefId();
    expect(v.startsWith('^v-')).toBe(true);
    expect(t.startsWith('^t-')).toBe(true);
  });
});

describe('postTransactionsInBlock（估值入账）', () => {
  const VAL_BLOCK = ['```fin-beancount', '2026-08-01 custom "fb-valuation" 股票 5300000   ; 约 350 股', '```'].join('\n');

  it('估值入账：留在 fin-beancount 块中并带 ^v-，账本追加 ^v-，不生成 finance-log 卡片', async () => {
    const app = makeApp({ [NOTE_PATH]: VAL_BLOCK });
    const body = '2026-08-01 custom "fb-valuation" 股票 5300000   ; 约 350 股';

    const { results } = await postTransactionsInBlock(
      app as any,
      { path: NOTE_PATH } as any,
      body,
      0,
      VAL_BLOCK.length,
      LEDGER_PATH,
      [0],
    );

    expect(results[0].success).toBe(true);
    expect(results[0].blockRefId?.startsWith('^v-')).toBe(true);

    // 账本：带 ^v- 引用
    const ledger = app._files[LEDGER_PATH];
    expect((ledger.match(/\^v-\d+/g) || []).length).toBe(1);
    expect(ledger).toContain('fb-valuation');
    expect(ledger).toContain('5300000');

    // 笔记：原位仍是 fin-beancount 块（带 ^v-），不产生 finance-log 卡片
    const note = app._files[NOTE_PATH];
    expect((note.match(/```finance-log/g) || []).length).toBe(0);
    expect((note.match(/```fin-beancount/g) || []).length).toBe(1);
    expect(note).toMatch(/\^v-\d+/);
  });

  it('重复入账已带 ^v- 的估值：被拒绝', async () => {
    const app = makeApp({ [NOTE_PATH]: VAL_BLOCK });
    const postedBody = '2026-08-01 custom "fb-valuation" 股票 5300000\n^v-20260801120000';
    const { results } = await postTransactionsInBlock(
      app as any,
      { path: NOTE_PATH } as any,
      postedBody,
      0,
      postedBody.length,
      LEDGER_PATH,
      [0],
    );
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('已入账');
  });

  it('混合块：交易入账变 finance-log，估值入账保留 ^v-，各自分块', async () => {
    const mixed = [
      '```fin-beancount',
      '2026-08-01 * 买股票',
      '  现金 -5000000',
      '  股票 5000000',
      '',
      '2026-08-01 custom "fb-valuation" 股票 5300000',
      '```',
    ].join('\n');
    const app = makeApp({ [NOTE_PATH]: mixed });
    const body = mixed.replace(/```fin-beancount\n/, '').replace(/\n```$/, '');
    const { results } = await postTransactionsInBlock(
      app as any,
      { path: NOTE_PATH } as any,
      body,
      0,
      mixed.length,
      LEDGER_PATH,
      [0, 1],
    );
    expect(results.every((r) => r.success)).toBe(true);

    const note = app._files[NOTE_PATH];
    // 交易 → finance-log 卡片；估值 → fin-beancount（带 ^v-）。两者必须分属不同块
    expect((note.match(/```finance-log/g) || []).length).toBe(1);
    expect(note).toMatch(/\^v-\d+/);
    expect(note).toContain('5300000');
  });
});
