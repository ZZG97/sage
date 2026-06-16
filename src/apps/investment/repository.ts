import { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import { getDatabase } from '../../shared/db';
import { runDatabaseMigrations } from '../../shared/db-migrations';
import { Logger } from '../../utils';
import type {
  HoldingSnapshot,
  HoldingSnapshotSource,
  Instrument,
  InvestmentAssetType,
  InvestmentMarket,
  Portfolio,
  PortfolioOverview,
  PortfolioPosition,
  PositionNote,
  UpsertHoldingInput,
} from './types';

const logger = new Logger('InvestmentRepository');
const DEFAULT_PORTFOLIO_ID = 'default';

interface InstrumentRow extends Omit<Instrument, 'themes' | 'metadata'> {
  themes_json: string;
  metadata_json: string;
}

interface HoldingSnapshotRow extends HoldingSnapshot {}
interface PortfolioRow extends Portfolio {}

interface PositionNoteRow extends PositionNote {}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toInstrument(row: InstrumentRow): Instrument {
  const { themes_json, metadata_json, ...rest } = row;
  return {
    ...rest,
    themes: parseJsonArray(themes_json),
    metadata: parseJsonObject(metadata_json),
  };
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

export class InvestmentRepository {
  private db: Database;

  constructor(db?: Database) {
    this.db = db || getDatabase('investment');
    runDatabaseMigrations('investment', this.db, { logger });
    logger.info('投资研究数据库 schema 已就绪');
  }

  ensureDefaultPortfolio(input: { id?: string; name?: string; baseCurrency?: string; description?: string | null } = {}): Portfolio {
    const id = input.id || DEFAULT_PORTFOLIO_ID;
    const existing = this.getPortfolio(id);
    const timestamp = nowIso();

    if (existing) {
      const nextName = input.name ?? existing.name;
      const nextBaseCurrency = input.baseCurrency ?? existing.base_currency;
      const nextDescription = input.description !== undefined ? input.description : existing.description;
      this.db.prepare(`
        UPDATE portfolios
        SET name = ?, base_currency = ?, description = ?, updated_at = ?
        WHERE id = ?
      `).run(nextName, nextBaseCurrency, nextDescription ?? null, timestamp, id);
      return this.getPortfolio(id)!;
    }

    this.db.prepare(`
      INSERT INTO portfolios (id, name, base_currency, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.name || '默认组合',
      input.baseCurrency || 'CNY',
      input.description ?? null,
      timestamp,
      timestamp,
    );
    return this.getPortfolio(id)!;
  }

  getPortfolio(id = DEFAULT_PORTFOLIO_ID): Portfolio | null {
    return this.db.prepare('SELECT * FROM portfolios WHERE id = ?').get(id) as PortfolioRow | null;
  }

  listPortfolios(): Portfolio[] {
    return this.db.prepare('SELECT * FROM portfolios ORDER BY created_at ASC').all() as PortfolioRow[];
  }

  upsertInstrument(input: {
    symbol: string;
    name?: string;
    market?: InvestmentMarket;
    assetType?: InvestmentAssetType;
    industry?: string | null;
    themes?: string[];
    metadata?: Record<string, unknown>;
  }): Instrument {
    const symbol = normalizeSymbol(input.symbol);
    if (!symbol) throw new Error('instrument symbol is required');

    const market = input.market || 'cn_a';
    const existing = this.db.prepare(
      'SELECT * FROM instruments WHERE market = ? AND symbol = ?',
    ).get(market, symbol) as InstrumentRow | null;
    const timestamp = nowIso();

    if (existing) {
      const current = toInstrument(existing);
      this.db.prepare(`
        UPDATE instruments
        SET name = ?, asset_type = ?, industry = ?, themes_json = ?, metadata_json = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.name || current.name || symbol,
        input.assetType || current.asset_type,
        input.industry !== undefined ? input.industry : current.industry,
        JSON.stringify(input.themes ?? current.themes),
        JSON.stringify({ ...current.metadata, ...(input.metadata || {}) }),
        timestamp,
        current.id,
      );
      return this.getInstrument(current.id)!;
    }

    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO instruments (
        id, symbol, name, market, asset_type, industry, themes_json, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      symbol,
      input.name || symbol,
      market,
      input.assetType || 'stock',
      input.industry ?? null,
      JSON.stringify(input.themes || []),
      JSON.stringify(input.metadata || {}),
      timestamp,
      timestamp,
    );
    return this.getInstrument(id)!;
  }

  getInstrument(id: string): Instrument | null {
    const row = this.db.prepare('SELECT * FROM instruments WHERE id = ?').get(id) as InstrumentRow | null;
    return row ? toInstrument(row) : null;
  }

  listInstruments(): Instrument[] {
    const rows = this.db.prepare('SELECT * FROM instruments ORDER BY market ASC, symbol ASC').all() as InstrumentRow[];
    return rows.map(toInstrument);
  }

  runInTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  createHoldingSnapshot(input: {
    portfolioId: string;
    instrumentId: string;
    snapshotDate: string;
    snapshotRunId: string;
    quantity: number;
    costBasis?: number | null;
    costCurrency?: string | null;
    lastPrice?: number | null;
    priceCurrency?: string | null;
    marketValue?: number | null;
    marketValueBase?: number | null;
    source: HoldingSnapshotSource;
  }): HoldingSnapshot {
    const id = randomUUID();
    const marketValue = input.marketValue ?? (
      input.lastPrice === null || input.lastPrice === undefined ? null : input.quantity * input.lastPrice
    );
    const priceCurrency = input.priceCurrency ?? input.costCurrency ?? null;
    const marketValueBase = input.marketValueBase ?? (
      priceCurrency === null || input.costCurrency === null || input.costCurrency === undefined || priceCurrency === input.costCurrency
        ? marketValue
        : null
    );
    const unrealizedPnl = input.costBasis === null || input.costBasis === undefined || marketValueBase === null
      ? null
      : marketValueBase - input.costBasis;
    const unrealizedPnlPct = unrealizedPnl === null || !input.costBasis
      ? null
      : unrealizedPnl / input.costBasis;

    this.db.prepare(`
      INSERT INTO holding_snapshots (
        id, portfolio_id, instrument_id, snapshot_date, snapshot_run_id,
        quantity, cost_basis, cost_currency, last_price, price_currency,
        market_value, market_value_base, unrealized_pnl, unrealized_pnl_pct,
        weight, source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      id,
      input.portfolioId,
      input.instrumentId,
      input.snapshotDate,
      input.snapshotRunId,
      input.quantity,
      input.costBasis ?? null,
      input.costCurrency ?? null,
      input.lastPrice ?? null,
      priceCurrency,
      marketValue,
      marketValueBase,
      unrealizedPnl,
      unrealizedPnlPct,
      input.source,
      nowIso(),
    );
    return this.getHoldingSnapshot(id)!;
  }

  getHoldingSnapshot(id: string): HoldingSnapshot | null {
    return this.db.prepare('SELECT * FROM holding_snapshots WHERE id = ?').get(id) as HoldingSnapshotRow | null;
  }

  updateSnapshotWeights(portfolioId: string, snapshotRunId: string): void {
    const rows = this.db.prepare(`
      SELECT id, market_value_base
      FROM holding_snapshots
      WHERE portfolio_id = ? AND snapshot_run_id = ?
    `).all(portfolioId, snapshotRunId) as Array<{ id: string; market_value_base: number | null }>;

    const total = rows.reduce((sum, row) => sum + (row.market_value_base ?? 0), 0);
    const stmt = this.db.prepare('UPDATE holding_snapshots SET weight = ? WHERE id = ?');
    for (const row of rows) {
      stmt.run(total > 0 && row.market_value_base !== null ? row.market_value_base / total : null, row.id);
    }
  }

  upsertPositionNote(input: {
    portfolioId: string;
    instrumentId: string;
    note: NonNullable<UpsertHoldingInput['note']>;
  }): PositionNote {
    const existing = this.db.prepare(
      'SELECT * FROM position_notes WHERE portfolio_id = ? AND instrument_id = ?',
    ).get(input.portfolioId, input.instrumentId) as PositionNoteRow | null;
    const timestamp = nowIso();

    if (existing) {
      this.db.prepare(`
        UPDATE position_notes
        SET status = ?, conviction = ?, thesis = ?, buy_reason = ?, risk_notes = ?,
            invalidation_condition = ?, review_cadence = ?, next_review_at = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.note.status ?? existing.status,
        input.note.conviction !== undefined ? input.note.conviction : existing.conviction,
        input.note.thesis !== undefined ? input.note.thesis : existing.thesis,
        input.note.buy_reason !== undefined ? input.note.buy_reason : existing.buy_reason,
        input.note.risk_notes !== undefined ? input.note.risk_notes : existing.risk_notes,
        input.note.invalidation_condition !== undefined ? input.note.invalidation_condition : existing.invalidation_condition,
        input.note.review_cadence !== undefined ? input.note.review_cadence : existing.review_cadence,
        input.note.next_review_at !== undefined ? input.note.next_review_at : existing.next_review_at,
        timestamp,
        existing.id,
      );
      return this.getPositionNote(existing.id)!;
    }

    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO position_notes (
        id, portfolio_id, instrument_id, status, conviction, thesis, buy_reason,
        risk_notes, invalidation_condition, review_cadence, next_review_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.portfolioId,
      input.instrumentId,
      input.note.status || 'holding',
      input.note.conviction ?? null,
      input.note.thesis ?? null,
      input.note.buy_reason ?? null,
      input.note.risk_notes ?? null,
      input.note.invalidation_condition ?? null,
      input.note.review_cadence ?? null,
      input.note.next_review_at ?? null,
      timestamp,
      timestamp,
    );
    return this.getPositionNote(id)!;
  }

  getPositionNote(id: string): PositionNote | null {
    return this.db.prepare('SELECT * FROM position_notes WHERE id = ?').get(id) as PositionNoteRow | null;
  }

  getPortfolioOverview(portfolioId = DEFAULT_PORTFOLIO_ID, snapshotRunId?: string): PortfolioOverview | null {
    const portfolio = this.getPortfolio(portfolioId);
    if (!portfolio) return null;

    const latestRun = snapshotRunId || this.latestSnapshotRunId(portfolioId);
    if (!latestRun) {
      return {
        portfolio,
        snapshot_date: null,
        snapshot_run_id: null,
        positions: [],
        totals: {
          market_value_base: null,
          cost_basis: null,
          unrealized_pnl: null,
          incomplete_value_count: 0,
        },
      };
    }

    const rows = this.db.prepare(`
      SELECT
        hs.*,
        i.id AS instrument_id_row,
        i.symbol,
        i.name,
        i.market,
        i.asset_type,
        i.industry,
        i.themes_json,
        i.metadata_json,
        i.created_at AS instrument_created_at,
        i.updated_at AS instrument_updated_at,
        pn.id AS note_id,
        pn.status AS note_status,
        pn.conviction,
        pn.thesis,
        pn.buy_reason,
        pn.risk_notes,
        pn.invalidation_condition,
        pn.review_cadence,
        pn.next_review_at,
        pn.created_at AS note_created_at,
        pn.updated_at AS note_updated_at
      FROM holding_snapshots hs
      JOIN instruments i ON i.id = hs.instrument_id
      LEFT JOIN position_notes pn ON pn.portfolio_id = hs.portfolio_id AND pn.instrument_id = hs.instrument_id
      WHERE hs.portfolio_id = ? AND hs.snapshot_run_id = ?
      ORDER BY hs.weight DESC, i.market ASC, i.symbol ASC
    `).all(portfolioId, latestRun) as any[];

    const positions: PortfolioPosition[] = rows.map((row) => ({
      instrument: toInstrument({
        id: row.instrument_id,
        symbol: row.symbol,
        name: row.name,
        market: row.market,
        asset_type: row.asset_type,
        industry: row.industry,
        themes_json: row.themes_json,
        metadata_json: row.metadata_json,
        created_at: row.instrument_created_at,
        updated_at: row.instrument_updated_at,
      }),
      snapshot: {
        id: row.id,
        portfolio_id: row.portfolio_id,
        instrument_id: row.instrument_id,
        snapshot_date: row.snapshot_date,
        snapshot_run_id: row.snapshot_run_id,
        quantity: row.quantity,
        cost_basis: row.cost_basis,
        cost_currency: row.cost_currency,
        last_price: row.last_price,
        price_currency: row.price_currency,
        market_value: row.market_value,
        market_value_base: row.market_value_base,
        unrealized_pnl: row.unrealized_pnl,
        unrealized_pnl_pct: row.unrealized_pnl_pct,
        weight: row.weight,
        source: row.source,
        created_at: row.created_at,
      },
      note: row.note_id ? {
        id: row.note_id,
        portfolio_id: row.portfolio_id,
        instrument_id: row.instrument_id,
        status: row.note_status,
        conviction: row.conviction,
        thesis: row.thesis,
        buy_reason: row.buy_reason,
        risk_notes: row.risk_notes,
        invalidation_condition: row.invalidation_condition,
        review_cadence: row.review_cadence,
        next_review_at: row.next_review_at,
        created_at: row.note_created_at,
        updated_at: row.note_updated_at,
      } : null,
    }));

    const totalMarketValue = positions.reduce((sum, position) => sum + (position.snapshot.market_value_base ?? 0), 0);
    const totalCost = positions.reduce((sum, position) => sum + (position.snapshot.cost_basis ?? 0), 0);
    const incompleteValueCount = positions.filter((position) => position.snapshot.market_value_base === null).length;

    return {
      portfolio,
      snapshot_date: positions[0]?.snapshot.snapshot_date ?? null,
      snapshot_run_id: latestRun,
      positions,
      totals: {
        market_value_base: incompleteValueCount === positions.length ? null : totalMarketValue,
        cost_basis: totalCost > 0 ? totalCost : null,
        unrealized_pnl: totalCost > 0 && incompleteValueCount === 0 ? totalMarketValue - totalCost : null,
        incomplete_value_count: incompleteValueCount,
      },
    };
  }

  private latestSnapshotRunId(portfolioId: string): string | null {
    const row = this.db.prepare(`
      SELECT snapshot_run_id
      FROM holding_snapshots
      WHERE portfolio_id = ?
      ORDER BY snapshot_date DESC, created_at DESC
      LIMIT 1
    `).get(portfolioId) as { snapshot_run_id: string } | null;
    return row?.snapshot_run_id ?? null;
  }
}
