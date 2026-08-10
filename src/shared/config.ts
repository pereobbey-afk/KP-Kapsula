import { z } from 'zod';
import path from 'node:path';

/**
 * Конфигурация читается из окружения один раз при старте.
 * Секреты никогда не логируются и не отдаются наружу.
 */

const intFromEnv = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().int().positive());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: intFromEnv(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PUBLIC_URL: z.string().default('http://localhost:3000'),

  DATABASE_PATH: z.string().default('./data/ii-smetchik.sqlite'),
  STORAGE_DIR: z.string().default('./storage'),

  SESSION_SECRET: z.string().optional(),
  SESSION_TTL_HOURS: intFromEnv(12),

  ANTHROPIC_API_KEY: z.string().optional(),
  // Переопределение адреса ИИ API. Читается явно, а не через
  // умолчание SDK: иначе посторонняя переменная окружения могла бы
  // незаметно перенаправить запросы с документацией на чужой хост.
  ANTHROPIC_BASE_URL: z.string().optional(),
  EXTRACTION_MODEL: z.string().default('claude-opus-5'),

  MAX_FILE_BYTES: intFromEnv(64 * 1024 * 1024),
  MAX_FILES_PER_JOB: intFromEnv(20),
  UPLOAD_CHUNK_BYTES: intFromEnv(1024 * 1024),

  WORKER_CONCURRENCY: intFromEnv(2),
  JOB_LEASE_SECONDS: intFromEnv(120),
  JOB_TIMEOUT_SECONDS: intFromEnv(1800),
  JOB_MAX_ATTEMPTS: intFromEnv(3),
  UPLOAD_TTL_HOURS: intFromEnv(168),
});

export type AppConfig = Readonly<{
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  host: string;
  logLevel: string;
  publicUrl: string;
  databasePath: string;
  storageDir: string;
  sessionSecret: string;
  sessionTtlMs: number;
  anthropicApiKey: string | undefined;
  anthropicBaseUrl: string | undefined;
  extractionModel: string;
  maxFileBytes: number;
  maxFilesPerJob: number;
  uploadChunkBytes: number;
  workerConcurrency: number;
  jobLeaseMs: number;
  jobTimeoutMs: number;
  jobMaxAttempts: number;
  uploadTtlMs: number;
}>;

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Некорректная конфигурация окружения: ${issues}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';

  // В production секрет сессии обязателен: без него подпись cookie предсказуема.
  if (isProduction && (!e.SESSION_SECRET || e.SESSION_SECRET.length < 32)) {
    throw new Error(
      'SESSION_SECRET обязателен в production и должен быть не короче 32 символов. ' +
        'Сгенерируйте: openssl rand -hex 32',
    );
  }

  return Object.freeze({
    nodeEnv: e.NODE_ENV,
    isProduction,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    publicUrl: e.PUBLIC_URL.replace(/\/+$/, ''),
    databasePath: path.resolve(e.DATABASE_PATH),
    storageDir: path.resolve(e.STORAGE_DIR),
    sessionSecret: e.SESSION_SECRET ?? 'dev-only-insecure-secret-do-not-use-in-production',
    sessionTtlMs: e.SESSION_TTL_HOURS * 3600_000,
    anthropicApiKey: e.ANTHROPIC_API_KEY || undefined,
    anthropicBaseUrl: e.ANTHROPIC_BASE_URL || undefined,
    extractionModel: e.EXTRACTION_MODEL,
    maxFileBytes: e.MAX_FILE_BYTES,
    maxFilesPerJob: e.MAX_FILES_PER_JOB,
    uploadChunkBytes: e.UPLOAD_CHUNK_BYTES,
    workerConcurrency: e.WORKER_CONCURRENCY,
    jobLeaseMs: e.JOB_LEASE_SECONDS * 1000,
    jobTimeoutMs: e.JOB_TIMEOUT_SECONDS * 1000,
    jobMaxAttempts: e.JOB_MAX_ATTEMPTS,
    uploadTtlMs: e.UPLOAD_TTL_HOURS * 3600_000,
  });
}

export function config(): AppConfig {
  cached ??= loadConfig();
  return cached;
}

/** Только для тестов: сбросить закешированную конфигурацию. */
export function resetConfigCache(): void {
  cached = null;
}
