import { describe, it, expect } from 'vitest';
import { parseFinBeancount } from './finBeancount';

describe('fin-beancount 解析器', () => {
  it('解析单笔简单交易', () => {
    const source = `2026-07-29 * 午餐 牛肉面
  现金        -3500
  费用:餐饮    3500`;

    const { transactions, errors } = parseFinBeancount(source);
    expect(errors).toHaveLength(0);
    expect(transactions).toHaveLength(1);

    const txn = transactions[0];
    expect(txn.date).toBe('2026-07-29');
    expect(txn.narration).toBe('午餐 牛肉面');
    expect(txn.legs).toHaveLength(2);
    expect(txn.legs[0]).toEqual({ account: '现金', amount: -3500 });
    expect(txn.legs[1]).toEqual({ account: '费用:餐饮', amount: 3500 });
    expect(txn.draft).toBe(false);
  });

  it('解析多笔交易（空行分隔）', () => {
    const source = `2026-07-29 * 早餐
  支付宝  -1500
  费用:餐饮  1500

2026-07-30 * 工资
  费用:工资  -2000000
  银行卡    2000000`;

    const { transactions, errors } = parseFinBeancount(source);
    expect(errors).toHaveLength(0);
    expect(transactions).toHaveLength(2);
    expect(transactions[0].date).toBe('2026-07-29');
    expect(transactions[1].date).toBe('2026-07-30');
  });

  it('零和不平衡时报错', () => {
    const source = `2026-07-29 * 错误交易
  现金  -3500
  费用:餐饮  3000`;

    const { transactions, errors } = parseFinBeancount(source);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('零和不平衡');
    expect(errors[0].message).toContain('-500');
    // 交易仍然被解析出来（带错误标记）
    expect(transactions).toHaveLength(1);
  });

  it('支持注释（全行 + 行内）', () => {
    const source = `; 这是全行注释
2026-07-29 * 午餐  ; 行内注释
  现金  -3500  ; 花了35元
  费用:餐饮  3500`;

    const { transactions, errors } = parseFinBeancount(source);
    expect(errors).toHaveLength(0);
    expect(transactions).toHaveLength(1);
    expect(transactions[0].narration).toBe('午餐');
    expect(transactions[0].legs[0].amount).toBe(-3500);
  });

  it('解析元数据行（type / owner / 自定义字段）', () => {
    const source = `2026-07-29 * 午餐 牛肉面
  现金  -3500
  费用:餐饮  3500
  type: 餐饮
  owner: 自己
  餐厅: 兰州拉面`;

    const { transactions, errors } = parseFinBeancount(source);
    expect(errors).toHaveLength(0);

    const txn = transactions[0];
    expect(txn.txnType).toBe('餐饮');
    expect(txn.owner).toBe('自己');
    expect(txn.fields).toEqual({ '餐厅': '兰州拉面' });
  });

  it('支持多币种标注', () => {
    const source = `2026-07-29 * 海淘
  银行卡  -7200 USD
  费用:购物  7200 USD`;

    const { transactions, errors } = parseFinBeancount(source);
    expect(errors).toHaveLength(0);
    expect(transactions[0].currency).toBe('USD');
  });

  it('支持 pending 标记 (!)', () => {
    const source = `2026-07-29 ! 待确认
  现金  -1000
  费用:交通  1000`;

    const { transactions, errors } = parseFinBeancount(source);
    expect(errors).toHaveLength(0);
    expect(transactions).toHaveLength(1);
  });

  it('draft 选项传递', () => {
    const source = `2026-07-29 * 草稿
  现金  -500
  费用:其他  500`;

    const { transactions } = parseFinBeancount(source, { draft: true });
    expect(transactions[0].draft).toBe(true);
  });

  it('无分录行的交易报错', () => {
    const source = `2026-07-29 * 空交易`;

    const { errors } = parseFinBeancount(source);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('无分录行');
  });

  it('无法识别的行报错', () => {
    const source = `这是一行无效内容
2026-07-29 * 正常
  现金  -100
  费用:其他  100`;

    const { errors } = parseFinBeancount(source);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('无法识别');
  });

  it('生成正确的块引用 ID', () => {
    const source = `2026-07-29 * 第一笔
  现金  -100
  费用:其他  100

2026-07-29 * 第二笔
  现金  -200
  费用:其他  200`;

    const { transactions } = parseFinBeancount(source);
    expect(transactions[0].id).toBe('^t-202607290001');
    expect(transactions[1].id).toBe('^t-202607290002');
  });

  it('处理 CRLF 换行', () => {
    const source = '2026-07-29 * 测试\r\n  现金  -100\r\n  费用:其他  100';
    const { transactions, errors } = parseFinBeancount(source);
    expect(errors).toHaveLength(0);
    expect(transactions).toHaveLength(1);
  });

  it('中文账户名含特殊字符（冒号、斜杠）', () => {
    const source = `2026-07-29 * 复合
  资产／银行卡:招商  -5000
  费用:餐饮/外卖    5000`;

    const { transactions, errors } = parseFinBeancount(source);
    expect(errors).toHaveLength(0);
    expect(transactions[0].legs[0].account).toBe('资产／银行卡:招商');
    expect(transactions[0].legs[1].account).toBe('费用:餐饮/外卖');
  });

  it('跳过块引用 ID 行（^t-...，入账后写入 fence 内）', () => {
    const source = `2026-07-29 * 已入账
  现金  -3500
  费用:餐饮  3500
^t-20260729120000`;

    const { transactions, errors } = parseFinBeancount(source);
    expect(errors).toHaveLength(0);
    expect(transactions).toHaveLength(1);
    expect(transactions[0].legs).toHaveLength(2);
    expect(transactions[0].legs[0]).toEqual({ account: '现金', amount: -3500 });
  });

  it('捕获真实块引用 ID（与 poster 写入一致，finance-log 的 id 参数据此精确查询）', () => {
    const source = `2026-07-29 * 已入账
  现金  -3500
  费用:餐饮  3500
^t-20260729120099`;

    const { transactions } = parseFinBeancount(source);
    // 关键：必须采用账本中真实的 ^t- 行，而非合成 id，否则 finance-log 按 id 查不到
    expect(transactions[0].id).toBe('^t-20260729120099');
  });

  it('无 ^t- 行时退化为合成 id（草稿交易）', () => {
    const source = `2026-07-29 * 第一笔
  现金  -100
  费用:其他  100

2026-07-29 * 第二笔
  现金  -200
  费用:其他  200`;

    const { transactions } = parseFinBeancount(source);
    // 无 ^t- 行，沿用原合成 id 规则（日期 + 序号）
    expect(transactions[0].id).toBe('^t-202607290001');
    expect(transactions[1].id).toBe('^t-202607290002');
  });
});
