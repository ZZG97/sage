import { describe, expect, it } from 'bun:test';
import { SinaAQuoteProvider } from './prices';
import type { Instrument } from './types';

function instrument(symbol: string): Instrument {
  return {
    id: symbol,
    symbol,
    name: '测试标的',
    market: 'cn_a',
    asset_type: 'stock',
    industry: null,
    themes: [],
    metadata: {},
    created_at: '2026-06-11T00:00:00.000Z',
    updated_at: '2026-06-11T00:00:00.000Z',
  };
}

describe('SinaAQuoteProvider', () => {
  it('maps SH symbols to Sina symbols and parses quote fields', async () => {
    const provider = new SinaAQuoteProvider(async (input, init) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe('hq.sinajs.cn');
      expect(url.href).toContain('sh600519');
      expect((init?.headers as Record<string, string>).referer).toBe('https://finance.sina.com.cn/');
      return new Response(
        'var hq_str_sh600519="贵州茅台,1252.080,1256.000,1275.880,1282.000,1250.210,1275.880,1275.900,3924414,4991686419.000,424,1275.880,100,1275.860,300,1275.850,100,1275.840,1500,1275.830,900,1275.900,100,1275.910,100,1275.950,200,1275.980,600,1275.990,2026-06-10,15:00:01,00,";',
        { status: 200 },
      );
    });

    const result = await provider.fetchQuotes([instrument('600519.SH')]);

    expect(result.failures).toHaveLength(0);
    expect(result.quotes.get('600519.SH')?.price).toBe(1275.88);
    expect(result.quotes.get('600519.SH')?.name).toBe('测试标的');
    expect(result.quotes.get('600519.SH')?.price_currency).toBe('CNY');
    expect(result.quotes.get('600519.SH')?.change_pct).toBeCloseTo(1.5828);
    expect(result.quotes.get('600519.SH')?.as_of).toBe('2026-06-10T07:00:01.000Z');
  });

  it('reports unsupported Beijing symbols as failures', async () => {
    const provider = new SinaAQuoteProvider(async () => {
      throw new Error('fetch should not be called');
    });

    const result = await provider.fetchQuotes([instrument('430047.BJ')]);

    expect(result.quotes.size).toBe(0);
    expect(result.failures[0]?.reason).toContain('unsupported A-share symbol');
  });
});
