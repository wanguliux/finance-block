import { describe, it, expect } from 'vitest';
import { buildCodeBlock, FINANCE_CODE_BLOCK_DEFS, type CodeBlockDef } from './codeBlockDefs';

const finBeancount = FINANCE_CODE_BLOCK_DEFS.find((d) => d.language === 'fin-beancount')!;

describe('buildCodeBlock · multiLeg（fin-beancount 动态 N 腿）', () => {
  it('fin-beancount 定义已切换为 multiLeg，不再有固定 2 腿 template', () => {
    expect(finBeancount.multiLeg).toBe(true);
    expect(finBeancount.template).toBeUndefined();
    const keys = finBeancount.params.map((p) => p.key);
    expect(keys).toContain('legs');
    expect(keys).not.toContain('fromAccount');
    expect(keys).not.toContain('toAccount');
    expect(keys).not.toContain('amount');
  });

  function buildLegs(values: Record<string, string>) {
    return buildCodeBlock(finBeancount as CodeBlockDef, values);
  }

  it('生成标准双分录（现金 out + 费用 in，零和）', () => {
    const text = buildLegs({
      date: '2026-08-02',
      narration: '午餐 牛肉面',
      txnType: '餐饮',
      owner: '自己',
      legs: JSON.stringify([
        { account: '现金', amountCents: -3500 },
        { account: '餐饮', amountCents: 3500 },
      ]),
    });
    expect(text).toBe(
      '```fin-beancount\n' +
        '2026-08-02 * 午餐 牛肉面\n' +
        '  现金  -3500\n' +
        '  餐饮  3500\n' +
        '  type: 餐饮\n' +
        '  owner: 自己\n' +
        '```\n',
    );
  });

  it('买卖股票：现金 out + 股票 in，不污染 type 标签', () => {
    const text = buildLegs({
      date: '2026-08-02',
      narration: '买腾讯',
      txnType: '腾讯股票',
      legs: JSON.stringify([
        { account: '现金', amountCents: -1000000 },
        { account: '股票', amountCents: 1000000 },
      ]),
    });
    expect(text).toContain('现金  -1000000');
    expect(text).toContain('股票  1000000');
    expect(text).toContain('type: 腾讯股票');
  });

  it('已实现收益（卖出 + 一键补平）：现金 in + 股票 out + 投资收益', () => {
    const text = buildLegs({
      date: '2026-05-03',
      narration: '卖腾讯',
      txnType: '腾讯股票',
      legs: JSON.stringify([
        { account: '现金', amountCents: 1100000 },
        { account: '股票', amountCents: -1000000 },
        { account: '投资收益', amountCents: -100000 },
      ]),
    });
    // 1100000 - 1000000 - 100000 = 0 ✓ 零和
    expect(text).toContain('现金  1100000');
    expect(text).toContain('股票  -1000000');
    expect(text).toContain('投资收益  -100000');
  });

  it('空 legs / 空账户条目被跳过，至少要产出头行', () => {
    const text = buildLegs({
      date: '2026-08-02',
      narration: '空分录',
      legs: JSON.stringify([{ account: '', amountCents: 0 }]),
    });
    expect(text.startsWith('```fin-beancount\n2026-08-02 * 空分录')).toBe(true);
    expect(text).not.toContain('  -0');
  });

  it('legs 为非法 JSON 时不崩溃，退化为空 legs', () => {
    const text = buildLegs({
      date: '2026-08-02',
      narration: '坏数据',
      legs: 'not-json',
    });
    expect(text.startsWith('```fin-beancount\n2026-08-02 * 坏数据')).toBe(true);
  });
});
