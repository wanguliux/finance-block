// globals 模式（vitest.config.ts 中 globals:true）。
// 覆盖《记账问题分析与引擎优化报告》Bug #1 的软告警层：只提示、不拦截，且必须低误报。
import { auditTransaction } from './audit';
import type { AccountDef, TransactionTypeDef } from '../types';

const Y = 100;

const defs: AccountDef[] = [
  { name: '活期', class: 'asset' },
  { name: '储蓄', class: 'asset' },
  { name: '股票', class: 'asset', valuation: 'market' },
  { name: '信用卡', class: 'liability' },
  { name: '工资', class: 'income' },
  { name: '餐饮', class: 'expense' },
];

const types: TransactionTypeDef[] = [
  { name: '餐饮', direction: 'expense' },
  { name: '工资', direction: 'income' },
  { name: '投资', direction: 'expense' }, // 故意标成支出类，用来验证 tagMismatch
];

describe('#1 软告警：符号方向', () => {
  it('正常支出（现金负、支出正）无告警', () => {
    const w = auditTransaction(
      { legs: [{ account: '活期', amount: -35 * Y }, { account: '餐饮', amount: 35 * Y }], txnType: '餐饮' },
      defs,
      types,
    );
    expect(w).toEqual([]);
  });

  it('正常收入（工资负、活期正）无告警', () => {
    const w = auditTransaction(
      { legs: [{ account: '工资', amount: -3000 * Y }, { account: '活期', amount: 3000 * Y }], txnType: '工资' },
      defs,
      types,
    );
    expect(w).toEqual([]);
  });

  it('转账（两条 asset 腿一正一负）不误报 —— 这正是当初硬校验被暂缓的原因', () => {
    const w = auditTransaction(
      { legs: [{ account: '活期', amount: -1000 * Y }, { account: '储蓄', amount: 1000 * Y }] },
      defs,
      types,
    );
    expect(w).toEqual([]);
  });

  it('买股票（现金→股票，无收支腿）不误报方向', () => {
    const w = auditTransaction(
      { legs: [{ account: '活期', amount: -10000 * Y }, { account: '股票', amount: 10000 * Y }] },
      defs,
    );
    expect(w).toEqual([]);
  });

  it('还信用卡（负债转正、现金转负）不误报', () => {
    const w = auditTransaction(
      { legs: [{ account: '活期', amount: -500 * Y }, { account: '信用卡', amount: 500 * Y }] },
      defs,
    );
    expect(w).toEqual([]);
  });

  it('支出腿记成负数 → 提示符号可能反了', () => {
    const w = auditTransaction(
      { legs: [{ account: '活期', amount: 35 * Y }, { account: '餐饮', amount: -35 * Y }] },
      defs,
    );
    expect(w).toHaveLength(1);
    expect(w[0].code).toBe('signFlipped');
    expect(w[0].accounts).toEqual(['餐饮']);
  });

  it('收入腿记成正数 → 提示符号可能反了', () => {
    const w = auditTransaction(
      { legs: [{ account: '工资', amount: 3000 * Y }, { account: '活期', amount: -3000 * Y }] },
      defs,
    );
    expect(w.map((x) => x.code)).toEqual(['signFlipped']);
    expect(w[0].accounts).toEqual(['工资']);
  });
});

describe('#1 软告警：账户未声明类别', () => {
  it('账本里冒出未声明账户 → 提示不会计入总览', () => {
    const w = auditTransaction(
      { legs: [{ account: '活期', amount: -100 * Y }, { account: '神秘账户', amount: 100 * Y }] },
      defs,
    );
    expect(w).toHaveLength(1);
    expect(w[0].code).toBe('unclassifiedAccount');
    expect(w[0].accounts).toEqual(['神秘账户']);
  });

  it('持仓子账户能从父账户继承 → 不告警', () => {
    const w = auditTransaction(
      { legs: [{ account: '活期', amount: -100 * Y }, { account: '股票:腾讯', amount: 100 * Y }] },
      defs,
    );
    expect(w).toEqual([]);
  });

  it('config 为空时整体跳过审计（单测/解析场景不刷屏）', () => {
    const w = auditTransaction({ legs: [{ account: '随便什么', amount: 1 }] }, []);
    expect(w).toEqual([]);
  });
});

describe('#1 软告警：标签与分录结构不符', () => {
  it('买股票标成「投资(支出类)」但无 expense 腿 → 告警（报告 #2/#3 的根因场景）', () => {
    const w = auditTransaction(
      {
        legs: [{ account: '活期', amount: -10000 * Y }, { account: '股票', amount: 10000 * Y }],
        txnType: '投资',
      },
      defs,
      types,
    );
    expect(w).toHaveLength(1);
    expect(w[0].code).toBe('tagMismatch');
    expect(w[0].tag).toBe('投资');
    expect(w[0].tagDirection).toBe('expense');
  });

  it('标签在词表外 → 不告警（自由标签不做方向推断）', () => {
    const w = auditTransaction(
      { legs: [{ account: '活期', amount: -100 * Y }, { account: '储蓄', amount: 100 * Y }], txnType: '未知标签' },
      defs,
      types,
    );
    expect(w).toEqual([]);
  });

  it('未传词表 → 跳过标签检查', () => {
    const w = auditTransaction(
      { legs: [{ account: '活期', amount: -100 * Y }, { account: '股票', amount: 100 * Y }], txnType: '投资' },
      defs,
    );
    expect(w).toEqual([]);
  });

  it('工资代扣（同时有 income 与 expense 腿）标「工资」不误报', () => {
    const w = auditTransaction(
      {
        legs: [
          { account: '工资', amount: -3000 * Y },
          { account: '餐饮', amount: 200 * Y },
          { account: '活期', amount: 2800 * Y },
        ],
        txnType: '工资',
      },
      defs,
      types,
    );
    expect(w).toEqual([]);
  });

  it('多类问题可同时触发，互不吞掉', () => {
    const w = auditTransaction(
      {
        legs: [
          { account: '餐饮', amount: -50 * Y },
          { account: '神秘账户', amount: 50 * Y },
        ],
        txnType: '工资',
      },
      defs,
      types,
    );
    expect(w.map((x) => x.code).sort()).toEqual(['signFlipped', 'tagMismatch', 'unclassifiedAccount']);
  });
});
