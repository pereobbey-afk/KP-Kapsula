/**
 * Структурированный лог в JSON.
 *
 * Правило: в лог не попадают секреты и содержимое документов.
 * Имена файлов усечены, значения полей с чувствительными именами
 * заменяются на «[скрыто]».
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

const SECRET_KEYS = /(key|token|secret|password|authorization|cookie|apikey)/i;

/** Рекурсивно вычищает секреты и обрезает длинные значения. */
export function sanitizeLogFields(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[глубина превышена]';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (Buffer.isBuffer(value)) return `[двоичные данные, ${value.length} байт]`;

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => sanitizeLogFields(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Маскируются только строковые значения: секрет — это всегда строка.
      // Числа с «секретными» именами (например, счётчики токенов) нужны
      // для диагностики расходов и не несут тайны.
      out[k] = SECRET_KEYS.test(k) && typeof v === 'string' ? '[скрыто]' : sanitizeLogFields(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export type LogFields = Record<string, unknown>;

export class Logger {
  constructor(
    private readonly minLevel: LogLevel = 'info',
    private readonly base: LogFields = {},
    private readonly sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  ) {}

  /** Дочерний логгер с постоянными полями: requestId, jobId, stage. */
  child(fields: LogFields): Logger {
    return new Logger(this.minLevel, { ...this.base, ...fields }, this.sink);
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] > LEVEL_ORDER[this.minLevel]) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      message,
      ...(sanitizeLogFields({ ...this.base, ...fields }) as LogFields),
    };
    try {
      this.sink(JSON.stringify(record));
    } catch {
      this.sink(JSON.stringify({ ts: record.ts, level, message, note: 'поля не сериализуются' }));
    }
  }

  error(message: string, fields?: LogFields): void {
    this.write('error', message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.write('warn', message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.write('info', message, fields);
  }
  debug(message: string, fields?: LogFields): void {
    this.write('debug', message, fields);
  }
}

export function createLogger(level: string, base: LogFields = {}): Logger {
  const normalized = (['error', 'warn', 'info', 'debug'] as const).includes(level as LogLevel)
    ? (level as LogLevel)
    : 'info';
  return new Logger(normalized, base);
}
