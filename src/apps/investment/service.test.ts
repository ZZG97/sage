import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import type { PriceQuoteProvider, QuoteFetchResult } from './prices';
import { InvestmentRepository } from './repository';
import { formatInvestmentDate, InvestmentService } from './service';
import type { Instrument, PriceQuote } from './types';

class FakeQuoteProvider implements PriceQuoteProvider {
  constructor(private prices: Record<string, number>) {}

  async fetchQuotes(instruments: Instrument[]): Promise<QuoteFetchResult> {
    const quotes = new Map<string, PriceQuote>();
    const failures: QuoteFetchResult['failures'] = [];
    for (const instrument of instruments) {
      const price = this.prices[instrument.symbol.toUpperCase()];
      if (!price) {
        failures.push({
          instrument_id: instrument.id,
          symbol: instrument.symbol,
          reason: 'missing fake quote',
        });
        continue;
      }
      quotes.set(instrument.id, {
        symbol: instrument.symbol.replace(/\.(SH|SZ)$/u, ''),
        market: 'cn_a',
        name: instrument.name,
        price,
        price_currency: 'CNY',
        previous_close: null,
        change_amount: null,
        change_pct: null,
        open: null,
        high: null,
        low: null,
        volume: null,
        amount: null,
        as_of: '2026-06-11T10:00:00.000Z',
        source: 'fake',
      });
    }
    return { quotes, failures };
  }
}

function createService(quoteProvider?: PriceQuoteProvider): InvestmentService {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  return new InvestmentService(new InvestmentRepository(db), quoteProvider);
}

describe('InvestmentService', () => {
  it('uses Asia/Shanghai for default investment snapshot dates', () => {
    expect(formatInvestmentDate(new Date('2026-06-11T17:00:00.000Z'))).toBe('2026-06-12');
  });

  it('imports a holding snapshot and computes base weights', () => {
    const service = createService();

    const result = service.importHoldings({
      snapshot_date: '2026-06-11',
      holdings: [
        {
          instrument: { symbol: '600519.SH', name: '贵州茅台', market: 'cn_a', asset_type: 'stock' },
          quantity: 10,
          cost_basis: 12_000,
          cost_currency: 'CNY',
          last_price: 1_500,
          price_currency: 'CNY',
          note: { thesis: '高质量消费资产', status: 'holding' },
        },
        {
          instrument: { symbol: '510300.SH', name: '沪深300ETF', market: 'cn_a', asset_type: 'etf' },
          quantity: 1_000,
          cost_basis: 3_000,
          cost_currency: 'CNY',
          last_price: 4,
          price_currency: 'CNY',
        },
      ],
    });

    expect(result.imported_count).toBe(2);
    expect(result.positions).toHaveLength(2);

    const overview = service.getPortfolioOverview('default', result.snapshot_run_id);
    expect(overview.totals.market_value_base).toBe(19_000);
    expect(overview.totals.unrealized_pnl).toBe(4_000);
    expect(overview.positions[0].snapshot.weight).toBeCloseTo(15_000 / 19_000);
    expect(overview.positions.find((position) => position.instrument.symbol === '600519.SH')?.note?.thesis).toBe('高质量消费资产');
  });

  it('deduplicates instruments and marks cross-currency values incomplete without base value', () => {
    const service = createService();

    const first = service.importHoldings({
      snapshot_date: '2026-06-11',
      holdings: [
        {
          instrument: { symbol: 'AAPL.US', name: 'Apple', market: 'us', asset_type: 'stock' },
          quantity: 1,
          cost_basis: 100,
          cost_currency: 'CNY',
          last_price: 200,
          price_currency: 'USD',
        },
      ],
    });
    service.importHoldings({
      snapshot_date: '2026-06-12',
      holdings: [
        {
          instrument: { symbol: 'aapl.us', name: 'Apple Inc.', market: 'us', asset_type: 'stock' },
          quantity: 1,
          cost_basis: 100,
          cost_currency: 'CNY',
          last_price: 210,
          price_currency: 'USD',
        },
      ],
    });

    expect(service.listInstruments()).toHaveLength(1);
    const overview = service.getPortfolioOverview('default', first.snapshot_run_id);
    expect(overview.totals.market_value_base).toBeNull();
    expect(overview.totals.incomplete_value_count).toBe(1);
    expect(overview.positions[0].snapshot.weight).toBeNull();
  });

  it('rejects duplicate holdings in the same snapshot import', () => {
    const service = createService();

    expect(() => service.importHoldings({
      snapshot_date: '2026-06-11',
      holdings: [
        {
          instrument: { symbol: 'AAPL.US', name: 'Apple', market: 'us', asset_type: 'stock' },
          quantity: 1,
        },
        {
          instrument: { symbol: 'aapl.us', name: 'Apple Inc.', market: 'us', asset_type: 'stock' },
          quantity: 2,
        },
      ],
    })).toThrow('duplicate holding');
    expect(service.listInstruments()).toHaveLength(0);
  });

  it('refreshes cn_a prices into a new snapshot and carries cash forward', async () => {
    const service = createService(new FakeQuoteProvider({ '600519.SH': 1_600 }));
    const imported = service.importHoldings({
      snapshot_date: '2026-06-11',
      holdings: [
        {
          instrument: { symbol: '600519.SH', name: '贵州茅台', market: 'cn_a', asset_type: 'stock' },
          quantity: 10,
          cost_basis: 12_000,
          cost_currency: 'CNY',
          last_price: 1_500,
          price_currency: 'CNY',
        },
        {
          instrument: { symbol: 'CNY', name: '现金', market: 'cash', asset_type: 'cash' },
          quantity: 1_000,
          cost_basis: 1_000,
          cost_currency: 'CNY',
          last_price: 1,
          price_currency: 'CNY',
        },
      ],
    });

    const refreshed = await service.refreshCnAPrices({ snapshot_date: '2026-06-12' });

    expect(refreshed.previous_snapshot_run_id).toBe(imported.snapshot_run_id);
    expect(refreshed.updated_count).toBe(1);
    expect(refreshed.carried_count).toBe(1);
    expect(refreshed.positions).toHaveLength(2);

    const overview = service.getPortfolioOverview('default', refreshed.snapshot_run_id);
    const stock = overview.positions.find((position) => position.instrument.symbol === '600519.SH');
    const cash = overview.positions.find((position) => position.instrument.symbol === 'CNY');
    expect(stock?.snapshot.last_price).toBe(1_600);
    expect(stock?.snapshot.market_value_base).toBe(16_000);
    expect(stock?.snapshot.source).toBe('price_refresh');
    expect(cash?.snapshot.source).toBe('carry_forward');
    expect(overview.totals.market_value_base).toBe(17_000);
  });
});
