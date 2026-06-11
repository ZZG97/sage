import type { Instrument, PriceQuote, PriceRefreshFailure } from './types';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface QuoteFetchResult {
  quotes: Map<string, PriceQuote>;
  failures: PriceRefreshFailure[];
}

export interface PriceQuoteProvider {
  fetchQuotes(instruments: Instrument[]): Promise<QuoteFetchResult>;
}

function normalizeAStockCode(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/\.(SH|SZ)$/u, '');
}

function sinaSymbol(symbol: string): { symbol: string; code: string } | null {
  const upper = symbol.trim().toUpperCase();
  if (upper.endsWith('.BJ')) return null;

  const code = normalizeAStockCode(upper);
  if (!/^\d{6}$/u.test(code)) return null;

  if (upper.endsWith('.SH')) return { symbol: `sh${code}`, code };
  if (upper.endsWith('.SZ')) return { symbol: `sz${code}`, code };

  if (/^[569]/u.test(code)) return { symbol: `sh${code}`, code };
  if (/^[0123]/u.test(code)) return { symbol: `sz${code}`, code };
  return null;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || value === '-') return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function withTimeout(timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timeout),
  };
}

export class SinaAQuoteProvider implements PriceQuoteProvider {
  constructor(
    private fetchFn: FetchLike = fetch,
    private timeoutMs = 8_000,
  ) {}

  async fetchQuotes(instruments: Instrument[]): Promise<QuoteFetchResult> {
    const targets: Array<{ instrument: Instrument; sourceSymbol: string; code: string }> = [];
    const failures: PriceRefreshFailure[] = [];

    for (const instrument of instruments) {
      const mapped = sinaSymbol(instrument.symbol);
      if (!mapped) {
        failures.push({
          instrument_id: instrument.id,
          symbol: instrument.symbol,
          reason: `unsupported A-share symbol: ${instrument.symbol}`,
        });
        continue;
      }
      targets.push({ instrument, sourceSymbol: mapped.symbol, code: mapped.code });
    }

    const rowBySymbol = new Map<string, string[]>();
    for (const chunk of this.chunk(targets, 50)) {
      try {
        const text = await this.fetchQuoteText(chunk.map((target) => target.sourceSymbol));
        for (const [sourceSymbol, fields] of this.parseResponse(text)) {
          rowBySymbol.set(sourceSymbol, fields);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        for (const target of chunk) {
          failures.push({
            instrument_id: target.instrument.id,
            symbol: target.instrument.symbol,
            reason,
          });
        }
      }
    }

    const quotes = new Map<string, PriceQuote>();
    const failedIds = new Set(failures.map((failure) => failure.instrument_id));
    for (const target of targets) {
      if (failedIds.has(target.instrument.id)) continue;

      const fields = rowBySymbol.get(target.sourceSymbol);
      if (!fields) {
        failures.push({
          instrument_id: target.instrument.id,
          symbol: target.instrument.symbol,
          reason: `quote not found: ${target.instrument.symbol}`,
        });
        continue;
      }

      try {
        quotes.set(target.instrument.id, this.toQuote(target.instrument, target.code, fields));
      } catch (error) {
        failures.push({
          instrument_id: target.instrument.id,
          symbol: target.instrument.symbol,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { quotes, failures };
  }

  private async fetchQuoteText(symbols: string[]): Promise<string> {
    const url = new URL('https://hq.sinajs.cn/list=' + symbols.join(','));
    const timeout = withTimeout(this.timeoutMs);
    try {
      const response = await this.fetchFn(url, {
        signal: timeout.signal,
        headers: {
          referer: 'https://finance.sina.com.cn/',
          'user-agent': 'Mozilla/5.0',
        },
      });
      if (!response.ok) throw new Error(`quote http ${response.status}`);
      return await response.text();
    } finally {
      timeout.cancel();
    }
  }

  private parseResponse(text: string): Map<string, string[]> {
    const rows = new Map<string, string[]>();
    const pattern = /var hq_str_(sh|sz)(\d{6})="([^"]*)";/gu;
    for (const match of text.matchAll(pattern)) {
      const sourceSymbol = `${match[1]}${match[2]}`;
      const fields = match[3].split(',');
      if (fields.length > 3) rows.set(sourceSymbol, fields);
    }
    return rows;
  }

  private toQuote(instrument: Instrument, code: string, fields: string[]): PriceQuote {
    const open = toNullableNumber(fields[1]);
    const previousClose = toNullableNumber(fields[2]);
    const price = toNullableNumber(fields[3]);
    if (price === null || price <= 0) {
      throw new Error(`quote price unavailable: ${instrument.symbol}`);
    }

    const tradeDate = fields[30];
    const tradeTime = fields[31];
    const asOf = tradeDate && tradeTime
      ? new Date(`${tradeDate}T${tradeTime}+08:00`).toISOString()
      : new Date().toISOString();
    const changeAmount = previousClose === null ? null : price - previousClose;
    const changePct = previousClose && previousClose > 0 ? (changeAmount! / previousClose) * 100 : null;

    return {
      symbol: code,
      market: 'cn_a',
      name: instrument.name,
      price,
      price_currency: 'CNY',
      previous_close: previousClose,
      change_amount: changeAmount,
      change_pct: changePct,
      open,
      high: toNullableNumber(fields[4]),
      low: toNullableNumber(fields[5]),
      volume: toNullableNumber(fields[8]),
      amount: toNullableNumber(fields[9]),
      as_of: Number.isNaN(Date.parse(asOf)) ? new Date().toISOString() : asOf,
      source: 'sina_quote',
    };
  }

  private chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }
    return chunks;
  }
}
