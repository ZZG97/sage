#!/usr/bin/env bun
/**
 * Thin CLI wrapper for Agent-side calls to Sage HTTP APIs.
 *
 * It centralizes PORT/base-url resolution and Bearer token handling so skills
 * do not duplicate curl snippets.
 */

type JsonValue = unknown;

class ApiError extends Error {
  constructor(
    readonly status: number | null,
    readonly body: JsonValue,
  ) {
    super(`Sage API error status=${status ?? 'connect'} body=${JSON.stringify(body)}`);
  }
}

interface CliOptions {
  method: string;
  path: string;
  baseUrl?: string;
  json?: string;
  timeoutMs: number;
}

function usage(): never {
  throw new Error(`Usage:
  sage-api.ts METHOD PATH [--json JSON|@file|-] [--base-url URL] [--timeout-ms MS]

Examples:
  bun agent_home/scripts/sage-api.ts GET /scheduler/tasks
  bun agent_home/scripts/sage-api.ts POST /scheduler/tasks --json '{"kind":"message","message":"hi","triggerAt":1712345678000}'`);
}

function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value) throw new Error(`Missing value for ${name}`);
  args.splice(index, 2);
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  const baseUrl = takeOption(args, '--base-url') || process.env.SAGE_API_BASE_URL;
  const json = takeOption(args, '--json');
  const timeoutMs = Number(takeOption(args, '--timeout-ms') || 12_000);
  const method = args.shift()?.toUpperCase();
  const path = args.shift();

  if (!method || !path || args.length > 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    usage();
  }

  return { method, path, baseUrl, json, timeoutMs };
}

function defaultBaseUrl(): string {
  const port = process.env.PORT || '3000';
  return `http://localhost:${port}`;
}

function resolveUrl(path: string, baseUrl?: string): string {
  if (/^https?:\/\//iu.test(path)) return path;
  const normalizedBase = (baseUrl || defaultBaseUrl()).replace(/\/+$/u, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

function authToken(): string | undefined {
  return process.env.SAGE_INTERNAL_HTTP_TOKEN || process.env.SAGE_HTTP_TOKEN;
}

async function readJsonInput(input: string | undefined): Promise<JsonValue | undefined> {
  if (input === undefined) return undefined;
  const text = input === '-'
    ? await new Response(Bun.stdin.stream()).text()
    : input.startsWith('@')
      ? await Bun.file(input.slice(1)).text()
      : input;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON input: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseJsonText(text: string): JsonValue {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request(options: CliOptions): Promise<JsonValue> {
  const body = await readJsonInput(options.json);
  const headers: Record<string, string> = { accept: 'application/json' };
  const token = authToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(resolveUrl(options.path, options.baseUrl), {
      method: options.method,
      headers,
      signal: controller.signal,
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

try {
  const result = await request(parseArgs(process.argv.slice(2)));
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
} catch (error) {
  if (error instanceof ApiError) {
    const hint = error.status === 401 && !authToken()
      ? 'Missing SAGE_INTERNAL_HTTP_TOKEN or SAGE_HTTP_TOKEN in the Agent environment.'
      : undefined;
    console.error(JSON.stringify({ error: error.body, status: error.status, hint }, null, 2));
    process.exit(1);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

export {};
