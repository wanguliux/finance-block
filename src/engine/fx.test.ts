/**
 * fx 引擎单元测试（§1 跨币种换算）
 * 覆盖 convertToBase / currencySymbol 两个被各报表复用的纯函数。
 */

import { describe, it, expect } from 'vitest';
import { convertToBase, currencySymbol } from './fx';

describe('convertToBase', () => {
  const fxRates = { USD: 7.2, EUR: 7.8 };

  it('默认币种不折算', () => {
    expect(convertToBase(10000, 'CNY', fxRates, 'CNY')).toBe(10000);
  });

  it('无币种视为等价', () => {
    expect(convertToBase(10000, undefined, fxRates, 'CNY')).toBe(10000);
  });

  it('未知币种回退为 1（等价）', () => {
    expect(convertToBase(10000, 'GBP', fxRates, 'CNY')).toBe(10000);
  });

  it('按汇率折算并取整', () => {
    // 100 USD * 7.2 = 720 分
    expect(convertToBase(100, 'USD', fxRates, 'CNY')).toBe(720);
  });

  it('EUR 同样按汇率折算', () => {
    // 100 EUR * 7.8 = 780 分
    expect(convertToBase(100, 'EUR', fxRates, 'CNY')).toBe(780);
  });
});

describe('currencySymbol', () => {
  it('已知币种返回符号', () => {
    expect(currencySymbol('CNY')).toBe('¥');
    expect(currencySymbol('USD')).toBe('$');
    expect(currencySymbol('EUR')).toBe('€');
  });

  it('未知币种回退为代码本身', () => {
    expect(currencySymbol('SGD')).toBe('SGD');
  });
});
