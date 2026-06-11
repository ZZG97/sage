#!/usr/bin/env bun
/**
 * Small wrapper for Sage investment APIs.
 *
 * Keep this script in Bun/TypeScript so the skill runtime matches Sage's
 * implementation stack. It talks to the HTTP app instead of writing SQLite
 * directly, so behavior stays aligned with service validation.
 */

type JsonValue = unknown;

const DEFAULT_CANDIDATES = [
  'http://localhost:3001/apps/investment',
  'http://localhost:3000/apps/investment',
];

class ApiError extends Error {
  constructor(
    readonly status: number | null,
    readonly body: JsonValue,
  ) {
    super(`API error status=${status ?? 'connect'} body=${JSON.stringify(body)}`);
  }
}

function unique(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const normalized = item.replace(/\/+$/u, '');
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function candidateBases(explicit?: string): string[] {
  if (explicit) return unique([explicit]);
  if (process.env.SAGE_INVESTMENT_BASE_URL) return unique([process.env.SAGE_INVESTMENT_BASE_URL]);
  if (process.env.PORT) return unique([`http://localhost:${process.env.PORT}/apps/investment`]);
  return unique(DEFAULT_CANDIDATES);
}

function parseJsonText(text: string): JsonValue {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request(
  baseUrl: string,
  method: string,
  path: string,
  body?: JsonValue,
  timeoutMs = 12_000,
): Promise<JsonValue> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(baseUrl.replace(/\/+$/u, '') + path, {
      method,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = parseJsonText(await response.text());
    if (!response.ok) throw new ApiError(response.status, parsed);
    return parsed;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(null, error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timeout);
  }
}

async function detectBase(explicit?: string): Promise<string> {
  const errors: string[] = [];
  for (const base of candidateBases(explicit)) {
    try {
      await request(base, 'GET', '/portfolios', undefined, 2_500);
      return base.replace(/\/+$/u, '');
    } catch (error) {
      if (error instanceof ApiError) {
        errors.push(`${base}: ${error.status ?? 'connect'} ${JSON.stringify(error.body)}`);
      } else {
        errors.push(`${base}: ${String(error)}`);
      }
    }
  }
  throw new Error(`No reachable Sage investment API. Tried:\n${errors.join('\n')}`);
}

function printJson(value: JsonValue): void {
  console.log(JSON.stringify(value, null, 2));
}

async function readJsonArg(path: string): Promise<JsonValue> {
  const text = path === '-'
    ? await new Response(Bun.stdin.stream()).text()
    : await Bun.file(path).text();
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON input: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface GlobalArgs {
  baseUrl?: string;
  args: string[];
}

function parseGlobalArgs(argv: string[]): GlobalArgs {
  const args = [...argv];
  let baseUrl: string | undefined;
  for (let index = 0; index < args.length;) {
    if (args[index] === '--base-url') {
      baseUrl = args[index + 1];
      args.splice(index, 2);
      continue;
    }
    index++;
  }
  return { baseUrl, args };
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value) throw new Error(`Missing value for ${name}`);
  args.splice(index, 2);
  return value;
}

function takeRepeatedOption(args: string[], name: string): string[] {
  const values: string[] = [];
  for (;;) {
    const index = args.indexOf(name);
    if (index === -1) return values;
    const value = args[index + 1];
    if (!value) throw new Error(`Missing value for ${name}`);
    values.push(value);
    args.splice(index, 2);
  }
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function usage(): never {
  throw new Error(`Usage:
  investment_api.ts portfolios [--base-url URL]
  investment_api.ts overview [portfolio_id] [--snapshot-run-id RUN] [--base-url URL]
  investment_api.ts refresh [portfolio_id] [--snapshot-date YYYY-MM-DD] [--base-url URL]
  investment_api.ts import-json <file|-> [--base-url URL]
  investment_api.ts import-simple --holding symbol,name,market,asset_type,quantity[,cost_basis] [--portfolio-id ID] [--portfolio-name NAME] [--snapshot-date YYYY-MM-DD] [--base-url URL]`);
}

async function main(): Promise<number> {
  const { baseUrl, args } = parseGlobalArgs(process.argv.slice(2));
  const command = args.shift();
  if (!command) usage();

  const base = await detectBase(baseUrl);

  if (command === 'portfolios') {
    printJson(await request(base, 'GET', '/portfolios'));
    return 0;
  }

  if (command === 'overview') {
    const snapshotRunId = takeOption(args, '--snapshot-run-id');
    const portfolioId = args.shift() || 'default';
    const suffix = snapshotRunId ? `?snapshot_run_id=${encodeURIComponent(snapshotRunId)}` : '';
    printJson(await request(base, 'GET', `/portfolios/${encodeURIComponent(portfolioId)}/overview${suffix}`));
    return 0;
  }

  if (command === 'refresh') {
    const snapshotDate = takeOption(args, '--snapshot-date');
    const portfolioId = args.shift() || 'default';
    printJson(await request(
      base,
      'POST',
      `/portfolios/${encodeURIComponent(portfolioId)}/prices/refresh`,
      snapshotDate ? { snapshot_date: snapshotDate } : {},
    ));
    return 0;
  }

  if (command === 'import-json') {
    const jsonFile = args.shift();
    if (!jsonFile) usage();
    printJson(await request(base, 'POST', '/holdings/import', await readJsonArg(jsonFile)));
    return 0;
  }

  if (command === 'import-simple') {
    const portfolioId = takeOption(args, '--portfolio-id') || 'default';
    const portfolioName = takeOption(args, '--portfolio-name') || '默认组合';
    const snapshotDate = takeOption(args, '--snapshot-date') || todayIsoDate();
    const rawHoldings = takeRepeatedOption(args, '--holding');
    if (rawHoldings.length === 0) throw new Error('At least one --holding is required');

    const holdings = rawHoldings.map((raw) => {
      const parts = raw.split(',').map((part) => part.trim());
      if (parts.length < 5) {
        throw new Error('Each --holding must be: symbol,name,market,asset_type,quantity[,cost_basis]');
      }
      const item: Record<string, unknown> = {
        instrument: {
          symbol: parts[0],
          name: parts[1],
          market: parts[2],
          asset_type: parts[3],
        },
        quantity: Number(parts[4]),
      };
      if (parts[5]) {
        item.cost_basis = Number(parts[5]);
        item.cost_currency = 'CNY';
      }
      return item;
    });

    printJson(await request(base, 'POST', '/holdings/import', {
      portfolio_id: portfolioId,
      portfolio_name: portfolioName,
      snapshot_date: snapshotDate,
      holdings,
    }));
    return 0;
  }

  usage();
}

try {
  process.exit(await main());
} catch (error) {
  if (error instanceof ApiError) {
    printJson({ error: error.body, status: error.status });
    process.exit(1);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

export {};
