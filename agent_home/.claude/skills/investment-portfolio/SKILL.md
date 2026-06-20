---
name: investment-portfolio
description: >
  Manage Laozhang's personal investment portfolio tracking through Sage investment APIs.
  Use this skill whenever the user mentions 持仓, 股票持仓, 组合, 投资组合, 刷新持仓,
  查看持仓, 录入持仓, 更新持仓, 持仓体检, A股价格, 春风动力, 立昂微, or asks the agent
  to operate portfolio APIs on their behalf. This skill is for portfolio tracking,
  price refresh, and evidence-backed summaries; it is not for trading advice.
user_invocable: true
---

# Investment Portfolio Skill

通过 Sage investment app 帮老张管理持仓：录入持仓、刷新 A 股价格、查看组合概览、做基础持仓摘要。

**API app:** `src/apps/investment/`
**Routes:** `/apps/investment`
**DB:** `~/workspace/sage/data/investment.db`
**Wrapper script:** `scripts/investment_api.ts`

## Current Capability

- 支持 portfolio holding import。
- 支持 SH/SZ A 股股票和 ETF 价格刷新，当前 provider 是新浪行情。
- 支持 overview 查询：数量、最新价、市值、权重、浮盈亏。
- 刷新价格会生成新的 `price_...` 快照，不覆盖旧快照。
- 没有券商接入、自动交易、港美股刷新、基金净值刷新、Feishu slash command、scheduler 定时任务。

## Operating Rules

- Do the API calls for the user. Do not tell the user to run curl unless they explicitly ask for commands.
- Use `scripts/investment_api.ts`; it uses `SAGE_INVESTMENT_BASE_URL` when set, otherwise the current Sage `PORT`, otherwise local dev/prod fallback ports for terminal testing. It automatically sends `SAGE_INTERNAL_HTTP_TOKEN` or `SAGE_HTTP_TOKEN` when present.
- If the wrapper returns 401, first check that the Agent environment has `SAGE_INTERNAL_HTTP_TOKEN` or `SAGE_HTTP_TOKEN`; do not bypass Sage HTTP auth with localhost assumptions.
- Default to portfolio id `default` for real personal holdings. Use `test-*` only when explicitly testing.
- If the API returns 404/connection refused while `PORT` is set, explain that the current running Sage instance may not have loaded the investment app yet; do not fall back to another Sage instance unless the user explicitly targets it.
- Do not give buy/sell instructions. Summaries should focus on current positions, market value, weight, missing cost data, and data-source limitations.
- For 新易盛 specifically, if its weight is high in Laozhang's portfolio, describe the risk as passive high weight caused by A-share lot-size granularity and high share price, not as intentional heavy concentration or strong bullish intent; still report its portfolio volatility impact clearly.
- If cost basis is missing, state that unrealized PnL cannot be computed.
- If the user provides a stock name without a code and the code is not obvious, verify it before importing. Do not guess ambiguous tickers.

## API Wrapper

```bash
bun .claude/skills/investment-portfolio/scripts/investment_api.ts portfolios
bun .claude/skills/investment-portfolio/scripts/investment_api.ts overview default
bun .claude/skills/investment-portfolio/scripts/investment_api.ts refresh default --snapshot-date 2026-06-12
bun .claude/skills/investment-portfolio/scripts/investment_api.ts import-json -
```

Set `SAGE_INVESTMENT_BASE_URL` only when targeting a specific instance:

```bash
SAGE_INVESTMENT_BASE_URL=http://localhost:3001/apps/investment \
bun .claude/skills/investment-portfolio/scripts/investment_api.ts overview default
```

## Workflows

### 1. 查看持仓

Call:

```bash
bun .claude/skills/investment-portfolio/scripts/investment_api.ts overview default
```

If no portfolio exists, tell the user there is no recorded holding snapshot yet and ask for holdings to import.

Output summary:

- Portfolio name and snapshot run id.
- Total market value.
- A table with symbol/name/quantity/last price/market value/weight/source.
- PnL only if `unrealized_pnl` is non-null.

### 2. 刷新持仓价格

Call:

```bash
bun .claude/skills/investment-portfolio/scripts/investment_api.ts refresh default
```

Then call overview and summarize the refreshed snapshot.

If quote refresh fails, report failed symbols and state that no partial price snapshot should have been written.

### 3. 录入或更新持仓

When the user gives holdings in natural language, construct an import JSON and send it to the script via stdin.

Example input: “春风动力 100股，立昂微 200股”

Known codes from this project context:

- 春风动力: `603129.SH`
- 立昂微: `605358.SH`

Example call:

```bash
bun .claude/skills/investment-portfolio/scripts/investment_api.ts import-json - <<'JSON'
{
  "portfolio_id": "default",
  "portfolio_name": "默认组合",
  "snapshot_date": "2026-06-12",
  "holdings": [
    {
      "instrument": { "symbol": "603129.SH", "name": "春风动力", "market": "cn_a", "asset_type": "stock" },
      "quantity": 100
    },
    {
      "instrument": { "symbol": "605358.SH", "name": "立昂微", "market": "cn_a", "asset_type": "stock" },
      "quantity": 200
    }
  ]
}
JSON
```

After import, refresh prices and show overview unless the user only asked to record without refresh.

If the user gives cost:

- Treat `cost_basis` as total cost, not unit cost.
- If the user gives unit cost, multiply by quantity before sending `cost_basis`.
- Use `cost_currency: "CNY"` for A-share holdings unless told otherwise.

### 4. 持仓体检

Current implementation can only do a basic API-backed check:

- Refresh A-share prices.
- Show total value and weight concentration.
- Point out missing cost basis.
- Point out unsupported assets or quote failures.
- Do not infer investment recommendations.

Later full body check should use Evidence/Signal/ReportRun, but that is not implemented yet.

## Response Format

Keep responses concise and operational.

Recommended format:

```text
已刷新持仓。

组合总市值：36283 CNY
快照：price_2026-06-12_xxxxxxxx

| 标的 | 数量 | 最新价 | 市值 | 权重 |
|---|---:|---:|---:|---:|
| 春风动力 | 100 | 220.49 | 22049 | 60.77% |
| 立昂微 | 200 | 71.17 | 14234 | 39.23% |

成本未录入，所以暂不能计算浮盈亏。
```

## Failure Handling

- 400 duplicate holding: tell the user the same symbol appears twice in one import; do not retry without fixing input.
- 400 quote failure: report failed symbols; do not present stale prices as refreshed prices.
- 404 portfolio: no holding snapshot exists for that portfolio.
- Connection refused or 404 on `/apps/investment`: running Sage instance likely has not loaded the investment app; ask for permission before restarting any service, and never restart prod from a live Feishu conversation.
