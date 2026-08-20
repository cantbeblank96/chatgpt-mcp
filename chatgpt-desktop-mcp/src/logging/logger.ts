/**
 * Logger: writes to stderr (stdout is reserved for MCP JSON-RPC).
 * By design, full prompt/response text is NOT logged unless explicitly enabled.
 */
import type { AppConfig } from '../config/index.js';

const LEVELS: Record<'debug' | 'info' | 'warn' | 'error', number> = { debug: 10, info: 20, warn: 30, error: 40 };
type Level = keyof typeof LEVELS;

let threshold: number = LEVELS.info;

export function configureLogging(config: Pick<AppConfig, 'logLevel'>): void {
  threshold = LEVELS[config.logLevel] ?? LEVELS.info;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(fields ?? {}),
  };
  process.stderr.write(JSON.stringify(line) + '\n');
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};

/** Redaction helper: never log content, only its size. */
export function redact(text: string | undefined | null): string {
  if (text == null) return '<none>';
  return `<${text.length} chars>`;
}
