import { formatRequestContext } from './request-context';
export * from './request-context';

const DEFAULT_LOG_VALUE_MAX = 240;
const DEFAULT_LOG_ARG_MAX = 2_000;
const LOG_TIMESTAMP_ENABLED = process.env.SAGE_LOG_TIMESTAMP !== 'false';

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function toSingleLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === 'bigint') return val.toString();
    if (val instanceof Error) {
      return {
        name: val.name,
        message: val.message,
        stack: val.stack,
        cause: val.cause,
      };
    }
    if (typeof val === 'object' && val !== null) {
      if (seen.has(val)) return '[Circular]';
      seen.add(val);
    }
    return val;
  });
}

export function sanitizeLogValue(value: unknown, maxLength = DEFAULT_LOG_VALUE_MAX): string {
  let text: string;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') text = String(value);
  else if (value === null || value === undefined) text = '';
  else {
    try {
      text = safeStringify(value);
    } catch {
      text = String(value);
    }
  }
  return truncate(toSingleLine(text), maxLength);
}

export function maskSensitiveId(value: unknown, keepStart = 6, keepEnd = 4): string {
  const text = sanitizeLogValue(value, 256);
  if (!text || text === 'unknown') return text;
  if (text.length <= keepStart + keepEnd + 2) return '***';
  return `${text.slice(0, keepStart)}…${text.slice(-keepEnd)}`;
}

function formatLogArg(arg: unknown): string {
  if (arg instanceof Error) {
    return sanitizeLogValue(arg.stack || `${arg.name}: ${arg.message}`, DEFAULT_LOG_ARG_MAX);
  }

  if (typeof arg === 'string') {
    return sanitizeLogValue(arg, DEFAULT_LOG_ARG_MAX);
  }

  try {
    return sanitizeLogValue(safeStringify(arg), DEFAULT_LOG_ARG_MAX);
  } catch {
    return sanitizeLogValue(String(arg), DEFAULT_LOG_ARG_MAX);
  }
}

// 日志工具
export class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  info(message: string, ...args: any[]) {
    this.write('INFO', console.log, message, args);
  }

  error(message: string, ...args: any[]) {
    this.write('ERROR', console.error, message, args);
  }

  warn(message: string, ...args: any[]) {
    this.write('WARN', console.warn, message, args);
  }

  debug(message: string, ...args: any[]) {
    if (process.env.NODE_ENV === 'development' || process.env.LOG_LEVEL === 'debug') {
      this.write('DEBUG', console.debug, message, args);
    }
  }

  private write(level: string, sink: (...data: any[]) => void, message: string, args: any[]) {
    const prefix = LOG_TIMESTAMP_ENABLED
      ? `[${new Date().toISOString()}] [${level}] [${this.context}]`
      : `[${level}] [${this.context}]`;
    const context = formatRequestContext();
    const parts = context
      ? [prefix, context, sanitizeLogValue(message, DEFAULT_LOG_ARG_MAX)]
      : [prefix, sanitizeLogValue(message, DEFAULT_LOG_ARG_MAX)];
    for (const arg of args) {
      const formatted = formatLogArg(arg);
      if (formatted) parts.push(formatted);
    }
    sink(parts.join(' '));
  }
}

// 错误处理工具
export class AppError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 500,
    public isOperational: boolean = true
  ) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace(this, this.constructor);
  }
}

export function handleError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof Error) {
    return new AppError(error.message, 'INTERNAL_ERROR');
  }

  return new AppError('未知错误', 'UNKNOWN_ERROR');
}

// 异步函数重试工具
export async function retryAsync<T>(
  fn: () => Promise<T>,
  retries: number = 3,
  delay: number = 1000
): Promise<T> {
  let lastError: Error;

  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)));
      }
    }
  }

  throw lastError!;
}
