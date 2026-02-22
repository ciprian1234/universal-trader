// ================================================================================================
// LOGGER — lightweight structured logging for Bun
// Uses console with structured prefixes. No heavy deps like winston.
// ================================================================================================

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'debug';
const currentLevelNum = LOG_LEVELS[currentLevel] ?? 0;

const COLORS = {
  debug: '\x1b[36m', // cyan
  info: '\x1b[32m', // green
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
  reset: '\x1b[0m',
  dim: '\x1b[2m',
};

function timestamp(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return `${a.message}\n${a.stack}`;
      if (typeof a === 'object' && a !== null) {
        try {
          return JSON.stringify(a, replacer, 0);
        } catch {
          return String(a);
        }
      }
      return String(a);
    })
    .join(' ');
}

/** JSON replacer that handles BigInt */
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function write(level: LogLevel, context: string, args: unknown[]): void {
  if (LOG_LEVELS[level]! < currentLevelNum) return;

  const ts = timestamp();
  const color = COLORS[level];
  const pad = context.padEnd(22);
  const msg = formatArgs(args);

  const line = `${COLORS.dim}${ts}${COLORS.reset} ${color}${level.padEnd(5)}${COLORS.reset} ${pad} ${msg}`;

  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/** Create a namespaced logger */
export function createLogger(context: string): Logger {
  return {
    debug: (...args: unknown[]) => write('debug', context, args),
    info: (...args: unknown[]) => write('info', context, args),
    warn: (...args: unknown[]) => write('warn', context, args),
    error: (...args: unknown[]) => write('error', context, args),
  };
}

/** Global logger shorthand */
export const log = createLogger('[main]');
