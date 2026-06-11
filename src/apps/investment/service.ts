import { randomUUID } from 'crypto';
import { Logger } from '../../utils';
import { SinaAQuoteProvider, type PriceQuoteProvider } from './prices';
import { InvestmentRepository } from './repository';
import type {
  ImportHoldingsInput,
  ImportHoldingsResult,
  HoldingSnapshotSource,
  InvestmentAssetType,
  InvestmentMarket,
  PortfolioOverview,
  RefreshPricesInput,
  RefreshPricesResult,
  UpsertHoldingInput,
} from './types';

const logger = new Logger('InvestmentService');
const HOLDING_SOURCES = ['manual', 'csv', 'computed', 'price_refresh', 'carry_forward'] as const;
const INVESTMENT_DATE_TIME_ZONE = 'Asia/Shanghai';

export function formatInvestmentDate(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: INVESTMENT_DATE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const valueByType = new Map(parts.map((part) => [part.type, part.value]));
  return `${valueByType.get('year')}-${valueByType.get('month')}-${valueByType.get('day')}`;
}

function todayIsoDate(): string {
  return formatInvestmentDate();
}

function asFiniteNumber(value: unknown, field: string): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    throw new Error(`${field} must be a finite number`);
  }
  return numberValue;
}

function normalizeMarket(value: unknown): InvestmentMarket {
  const market = typeof value === 'string' ? value : 'cn_a';
  if (['cn_a', 'hk', 'us', 'fund', 'cash', 'crypto', 'other'].includes(market)) {
    return market as InvestmentMarket;
  }
  return 'other';
}

function normalizeAssetType(value: unknown): InvestmentAssetType {
  const assetType = typeof value === 'string' ? value : 'stock';
  if (['stock', 'etf', 'fund', 'cash', 'crypto', 'other'].includes(assetType)) {
    return assetType as InvestmentAssetType;
  }
  return 'other';
}

function isHoldingSnapshotSource(value: unknown): value is HoldingSnapshotSource {
  return typeof value === 'string' && (HOLDING_SOURCES as readonly string[]).includes(value);
}

function normalizeSource(value: unknown): HoldingSnapshotSource {
  return isHoldingSnapshotSource(value) ? value : 'manual';
}

function normalizeHolding(input: UpsertHoldingInput): UpsertHoldingInput {
  if (!input || typeof input !== 'object') throw new Error('holding item must be an object');
  if (!input.instrument?.symbol) throw new Error('holding.instrument.symbol is required');
  const symbol = String(input.instrument.symbol).trim();
  if (!symbol) throw new Error('holding.instrument.symbol is required');

  return {
    ...input,
    instrument: {
      ...input.instrument,
      symbol,
      name: input.instrument.name?.trim(),
      market: normalizeMarket(input.instrument.market),
      asset_type: normalizeAssetType(input.instrument.asset_type),
      themes: Array.isArray(input.instrument.themes)
        ? input.instrument.themes.filter((theme): theme is string => typeof theme === 'string')
        : [],
      metadata: input.instrument.metadata || {},
    },
    quantity: asFiniteNumber(input.quantity, 'holding.quantity'),
    cost_basis: input.cost_basis === undefined || input.cost_basis === null
      ? null
      : asFiniteNumber(input.cost_basis, 'holding.cost_basis'),
    last_price: input.last_price === undefined || input.last_price === null
      ? null
      : asFiniteNumber(input.last_price, 'holding.last_price'),
    market_value: input.market_value === undefined || input.market_value === null
      ? null
      : asFiniteNumber(input.market_value, 'holding.market_value'),
    market_value_base: input.market_value_base === undefined || input.market_value_base === null
      ? null
      : asFiniteNumber(input.market_value_base, 'holding.market_value_base'),
    source: normalizeSource(input.source),
  };
}

export class InvestmentService {
  constructor(
    private repository = new InvestmentRepository(),
    private quoteProvider: PriceQuoteProvider = new SinaAQuoteProvider(),
  ) {}

  importHoldings(input: ImportHoldingsInput): ImportHoldingsResult {
    if (!Array.isArray(input.holdings) || input.holdings.length === 0) {
      throw new Error('holdings must be a non-empty array');
    }

    const snapshotDate = input.snapshot_date || todayIsoDate();
    const snapshotRunId = input.snapshot_run_id || `snapshot_${snapshotDate}_${randomUUID().slice(0, 8)}`;
    const holdings = input.holdings.map(normalizeHolding);
    const seenHoldings = new Set<string>();
    for (const holding of holdings) {
      const holdingKey = `${holding.instrument.market}:${holding.instrument.symbol.toUpperCase()}`;
      if (seenHoldings.has(holdingKey)) {
        throw new Error(`duplicate holding in one snapshot: ${holding.instrument.market}/${holding.instrument.symbol}`);
      }
      seenHoldings.add(holdingKey);
    }

    const portfolio = this.repository.runInTransaction(() => {
      const nextPortfolio = this.repository.ensureDefaultPortfolio({
        id: input.portfolio_id,
        name: input.portfolio_name,
        baseCurrency: input.base_currency,
        description: input.description,
      });

      for (const holding of holdings) {
        const instrument = this.repository.upsertInstrument({
          symbol: holding.instrument.symbol,
          name: holding.instrument.name,
          market: holding.instrument.market,
          assetType: holding.instrument.asset_type,
          industry: holding.instrument.industry,
          themes: holding.instrument.themes,
          metadata: holding.instrument.metadata,
        });

        this.repository.createHoldingSnapshot({
          portfolioId: nextPortfolio.id,
          instrumentId: instrument.id,
          snapshotDate,
          snapshotRunId,
          quantity: holding.quantity,
          costBasis: holding.cost_basis,
          costCurrency: holding.cost_currency,
          lastPrice: holding.last_price,
          priceCurrency: holding.price_currency,
          marketValue: holding.market_value,
          marketValueBase: holding.market_value_base,
          source: holding.source || 'manual',
        });

        if (holding.note) {
          this.repository.upsertPositionNote({
            portfolioId: nextPortfolio.id,
            instrumentId: instrument.id,
            note: holding.note,
          });
        }
      }

      this.repository.updateSnapshotWeights(nextPortfolio.id, snapshotRunId);
      return nextPortfolio;
    });

    const overview = this.getPortfolioOverview(portfolio.id, snapshotRunId);
    logger.info(`导入持仓快照 portfolio=${portfolio.id} run=${snapshotRunId} count=${holdings.length}`);

    return {
      portfolio,
      snapshot_date: snapshotDate,
      snapshot_run_id: snapshotRunId,
      imported_count: holdings.length,
      positions: overview.positions,
    };
  }

  getPortfolioOverview(portfolioId = 'default', snapshotRunId?: string): PortfolioOverview {
    const overview = this.repository.getPortfolioOverview(portfolioId, snapshotRunId);
    if (!overview) throw new Error(`portfolio not found: ${portfolioId}`);
    return overview;
  }

  async refreshCnAPrices(input: RefreshPricesInput = {}): Promise<RefreshPricesResult> {
    const portfolioId = input.portfolio_id || 'default';
    const previousOverview = this.getPortfolioOverview(portfolioId);
    if (!previousOverview.snapshot_run_id) {
      throw new Error(`portfolio has no holding snapshot: ${portfolioId}`);
    }
    if (previousOverview.positions.length === 0) {
      throw new Error(`portfolio has no positions: ${portfolioId}`);
    }

    const snapshotDate = input.snapshot_date || todayIsoDate();
    const snapshotRunId = input.snapshot_run_id || `price_${snapshotDate}_${randomUUID().slice(0, 8)}`;
    const quoteTargets = previousOverview.positions.filter((position) => (
      position.instrument.market === 'cn_a'
      && position.instrument.asset_type !== 'cash'
    ));
    if (quoteTargets.length === 0) {
      throw new Error(`portfolio has no cn_a positions to refresh: ${portfolioId}`);
    }

    const quoteResult = await this.quoteProvider.fetchQuotes(quoteTargets.map((position) => position.instrument));
    if (quoteResult.failures.length > 0) {
      const details = quoteResult.failures
        .map((failure) => `${failure.symbol}: ${failure.reason}`)
        .join('; ');
      throw new Error(`failed to fetch cn_a quotes: ${details}`);
    }

    this.repository.runInTransaction(() => {
      for (const position of previousOverview.positions) {
        const quote = quoteResult.quotes.get(position.instrument.id);
        const snapshot = position.snapshot;
        this.repository.createHoldingSnapshot({
          portfolioId,
          instrumentId: position.instrument.id,
          snapshotDate,
          snapshotRunId,
          quantity: snapshot.quantity,
          costBasis: snapshot.cost_basis,
          costCurrency: snapshot.cost_currency,
          lastPrice: quote ? quote.price : snapshot.last_price,
          priceCurrency: quote ? quote.price_currency : snapshot.price_currency,
          marketValue: quote ? undefined : snapshot.market_value,
          marketValueBase: quote ? undefined : snapshot.market_value_base,
          source: quote ? 'price_refresh' : 'carry_forward',
        });
      }
      this.repository.updateSnapshotWeights(portfolioId, snapshotRunId);
    });

    const overview = this.getPortfolioOverview(portfolioId, snapshotRunId);
    const carriedCount = previousOverview.positions.length - quoteResult.quotes.size;
    logger.info(
      `刷新A股价格 portfolio=${portfolioId} run=${snapshotRunId} updated=${quoteResult.quotes.size} carried=${carriedCount}`,
    );

    return {
      portfolio: overview.portfolio,
      snapshot_date: snapshotDate,
      snapshot_run_id: snapshotRunId,
      previous_snapshot_run_id: previousOverview.snapshot_run_id,
      updated_count: quoteResult.quotes.size,
      carried_count: carriedCount,
      failed_count: 0,
      failures: [],
      positions: overview.positions,
    };
  }

  listPortfolios() {
    return this.repository.listPortfolios();
  }

  listInstruments() {
    return this.repository.listInstruments();
  }
}
