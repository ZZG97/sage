export type InvestmentMarket = 'cn_a' | 'hk' | 'us' | 'fund' | 'cash' | 'crypto' | 'other';
export type InvestmentAssetType = 'stock' | 'etf' | 'fund' | 'cash' | 'crypto' | 'other';
export type HoldingSnapshotSource = 'manual' | 'csv' | 'computed' | 'price_refresh' | 'carry_forward';
export type PositionStatus = 'holding' | 'watching' | 'closed';
export type ConvictionLevel = 'low' | 'medium' | 'high';
export type ReviewCadence = 'weekly' | 'monthly' | 'event_driven';

export interface Instrument {
  id: string;
  symbol: string;
  name: string;
  market: InvestmentMarket;
  asset_type: InvestmentAssetType;
  industry: string | null;
  themes: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface Portfolio {
  id: string;
  name: string;
  base_currency: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface HoldingSnapshot {
  id: string;
  portfolio_id: string;
  instrument_id: string;
  snapshot_date: string;
  snapshot_run_id: string;
  quantity: number;
  cost_basis: number | null;
  cost_currency: string | null;
  last_price: number | null;
  price_currency: string | null;
  market_value: number | null;
  market_value_base: number | null;
  unrealized_pnl: number | null;
  unrealized_pnl_pct: number | null;
  weight: number | null;
  source: HoldingSnapshotSource;
  created_at: string;
}

export interface PositionNote {
  id: string;
  portfolio_id: string;
  instrument_id: string;
  status: PositionStatus;
  conviction: ConvictionLevel | null;
  thesis: string | null;
  buy_reason: string | null;
  risk_notes: string | null;
  invalidation_condition: string | null;
  review_cadence: ReviewCadence | null;
  next_review_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PortfolioPosition {
  instrument: Instrument;
  snapshot: HoldingSnapshot;
  note: PositionNote | null;
}

export interface PortfolioOverview {
  portfolio: Portfolio;
  snapshot_date: string | null;
  snapshot_run_id: string | null;
  positions: PortfolioPosition[];
  totals: {
    market_value_base: number | null;
    cost_basis: number | null;
    unrealized_pnl: number | null;
    incomplete_value_count: number;
  };
}

export interface UpsertInstrumentInput {
  symbol: string;
  name?: string;
  market?: InvestmentMarket;
  asset_type?: InvestmentAssetType;
  industry?: string | null;
  themes?: string[];
  metadata?: Record<string, unknown>;
}

export interface UpsertHoldingInput {
  instrument: UpsertInstrumentInput;
  quantity: number;
  cost_basis?: number | null;
  cost_currency?: string | null;
  last_price?: number | null;
  price_currency?: string | null;
  market_value?: number | null;
  market_value_base?: number | null;
  source?: HoldingSnapshotSource;
  note?: {
    status?: PositionStatus;
    conviction?: ConvictionLevel | null;
    thesis?: string | null;
    buy_reason?: string | null;
    risk_notes?: string | null;
    invalidation_condition?: string | null;
    review_cadence?: ReviewCadence | null;
    next_review_at?: string | null;
  };
}

export interface ImportHoldingsInput {
  portfolio_id?: string;
  portfolio_name?: string;
  base_currency?: string;
  description?: string | null;
  snapshot_date?: string;
  snapshot_run_id?: string;
  holdings: UpsertHoldingInput[];
}

export interface ImportHoldingsResult {
  portfolio: Portfolio;
  snapshot_date: string;
  snapshot_run_id: string;
  imported_count: number;
  positions: PortfolioPosition[];
}

export interface PriceQuote {
  symbol: string;
  market: InvestmentMarket;
  name: string | null;
  price: number;
  price_currency: string;
  previous_close: number | null;
  change_amount: number | null;
  change_pct: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  amount: number | null;
  as_of: string;
  source: string;
}

export interface RefreshPricesInput {
  portfolio_id?: string;
  snapshot_date?: string;
  snapshot_run_id?: string;
}

export interface PriceRefreshFailure {
  instrument_id: string;
  symbol: string;
  reason: string;
}

export interface RefreshPricesResult {
  portfolio: Portfolio;
  snapshot_date: string;
  snapshot_run_id: string;
  previous_snapshot_run_id: string;
  updated_count: number;
  carried_count: number;
  failed_count: number;
  failures: PriceRefreshFailure[];
  positions: PortfolioPosition[];
}
