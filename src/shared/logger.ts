/**
 * Structured logging utility for N2O.
 * Wraps console methods with log levels and prefixes.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = 'info';

/**
 * Correlation id of the sync run currently holding the sync lock, or null
 * outside a run. Set by SyncOrchestrator at the start of each orchestrated
 * sync and cleared in its finally, so every log line emitted during the run
 * carries the same short id as the SyncResult.
 */
let currentRunId: string | null = null;

/** Pattern matching Notion API tokens and session cookies to prevent accidental logging. */
const TOKEN_RE = /\b(ntn_[A-Za-z0-9]{20,}|secret_[A-Za-z0-9]{20,})\b|token_v2=[A-Za-z0-9%]{10,}/g;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/** Set (or clear, with null) the correlation id appended to every log line. */
export function setRunId(id: string | null): void {
  currentRunId = id;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

/** Redact Notion tokens and session cookies from a string to prevent accidental exposure in logs. */
function redact(text: string): string {
  return text.replace(TOKEN_RE, (match) => {
    if (match.startsWith('token_v2=')) return 'token_v2=***';
    return match.substring(0, 6) + '***';
  });
}

function formatMessage(level: LogLevel, module: string, message: string): string {
  const timestamp = new Date().toISOString().substring(11, 23);
  const runTag = currentRunId ? ` [run:${currentRunId}]` : '';
  return `[N2O ${timestamp}] [${level.toUpperCase()}] [${module}]${runTag} ${redact(message)}`;
}

/** Recursively redact Notion tokens from data structures (strings, Errors, arrays, objects). */
function safeData(data: unknown): unknown {
  if (typeof data === 'string') return redact(data);
  if (data instanceof Error) {
    const safe = new Error(redact(data.message));
    if (data.stack) safe.stack = redact(data.stack);
    safe.name = data.name;
    return safe;
  }
  if (Array.isArray(data)) return data.map(safeData);
  if (data !== null && typeof data === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      result[key] = safeData(value);
    }
    return result;
  }
  return data;
}

export function createLogger(module: string) {
  return {
    debug(message: string, data?: unknown): void {
      if (shouldLog('debug')) {
        if (data !== undefined) {
          console.debug(formatMessage('debug', module, message), safeData(data));
        } else {
          console.debug(formatMessage('debug', module, message));
        }
      }
    },

    info(message: string, data?: unknown): void {
      if (shouldLog('info')) {
        if (data !== undefined) {
          console.debug(formatMessage('info', module, message), safeData(data));
        } else {
          console.debug(formatMessage('info', module, message));
        }
      }
    },

    warn(message: string, data?: unknown): void {
      if (shouldLog('warn')) {
        console.warn(formatMessage('warn', module, message), safeData(data));
      }
    },

    error(message: string, error?: unknown): void {
      if (shouldLog('error')) {
        console.error(formatMessage('error', module, message), safeData(error));
      }
    },
  };
}
