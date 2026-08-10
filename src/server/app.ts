import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import type { Db } from '../db/index.js';
import type { AppConfig } from '../shared/config.js';
import { AppError, publicErrorBody, toAppError } from '../shared/errors.js';
import { createLogger, type Logger } from '../shared/logger.js';
import { newId } from '../shared/crypto.js';
import { resolveSession, SESSION_COOKIE } from './auth.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerUploadRoutes } from './routes/uploads.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerEstimateRoutes } from './routes/estimates.js';
import { registerPriceListRoutes } from './routes/pricelist.js';

export type AppDeps = {
  db: Db;
  config: AppConfig;
  logger?: Logger;
  /**
   * Каталог собранного интерфейса. Если задан, приложение отдаёт статику
   * и возвращает index.html для маршрутов SPA.
   *
   * Регистрируется здесь, а не снаружи: Fastify допускает только один
   * обработчик 404 на экземпляр, и он же обязан отдавать JSON для /api.
   */
  webRoot?: string;
};

export type AppContext = {
  db: Db;
  config: AppConfig;
  logger: Logger;
};

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
  interface FastifyRequest {
    requestId: string;
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const logger = deps.logger ?? createLogger(deps.config.logLevel, { component: 'server' });
  const ctx: AppContext = { db: deps.db, config: deps.config, logger };

  const app = Fastify({
    // Собственный структурированный логгер вместо встроенного:
    // в нём гарантированно нет секретов и содержимого документов.
    logger: false,
    trustProxy: true,
    bodyLimit: 1024 * 1024, // JSON-запросы небольшие; файлы идут частями отдельным парсером
  });

  app.decorate('ctx', ctx);

  await app.register(cookie, { secret: deps.config.sessionSecret });
  await app.register(rateLimit, {
    global: false,
    max: 100,
    timeWindow: '1 minute',
  });

  /** Парсер бинарного тела для частей файла. */
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: deps.config.uploadChunkBytes + 1024 },
    (_req, body, done) => {
      done(null, body);
    },
  );

  // Идентификатор запроса и разбор сессии.
  app.addHook('onRequest', async (request) => {
    request.requestId = newId('req');
    const token = request.cookies[SESSION_COOKIE];
    const user = resolveSession(deps.db, token);
    if (user) request.user = user;
  });

  app.addHook('onResponse', async (request, reply) => {
    // Служебные и статические запросы не засоряют лог.
    if (!request.url.startsWith('/api')) return;
    logger.info('Запрос обработан', {
      requestId: request.requestId,
      method: request.method,
      url: request.url.split('?')[0],
      status: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
      userId: request.user?.id,
    });
  });

  /**
   * Единая обработка ошибок.
   * Наружу уходит только { code, message, retryable } — ни HTML,
   * ни stack trace, ни сырой ответ внешнего API.
   */
  app.setErrorHandler((error: unknown, request, reply) => {
    // Ошибка разбора тела запроса или превышение лимита.
    const statusFromFastify = (error as { statusCode?: number } | null)?.statusCode;
    const message = error instanceof Error ? error.message : undefined;
    let appError: AppError;

    if (error instanceof AppError) {
      appError = error;
    } else if (statusFromFastify === 413) {
      appError = new AppError('FILE_TOO_LARGE', { source: 'body limit' });
    } else if (statusFromFastify === 429) {
      appError = new AppError('RATE_LIMITED');
    } else if (statusFromFastify === 400) {
      appError = new AppError('VALIDATION_FAILED', { detail: message });
    } else {
      appError = toAppError(error);
    }

    const level = appError.status >= 500 ? 'error' : 'warn';
    logger[level]('Ошибка запроса', {
      requestId: request.requestId,
      method: request.method,
      url: request.url.split('?')[0],
      code: appError.code,
      status: appError.status,
      details: appError.details,
      userId: request.user?.id,
      // Stack пишется только в лог и только для внутренних ошибок.
      ...(appError.status >= 500 && error instanceof Error ? { stack: error.stack?.slice(0, 2000) } : {}),
    });

    void reply.status(appError.status).send({
      ...publicErrorBody(appError),
      requestId: request.requestId,
    });
  });

  const serveWeb = Boolean(deps.webRoot && fs.existsSync(deps.webRoot));
  if (deps.webRoot && !serveWeb) {
    logger.warn('Каталог интерфейса не найден — отдаётся только API', { webRoot: deps.webRoot });
  }
  if (serveWeb) {
    await app.register(fastifyStatic, { root: deps.webRoot!, prefix: '/' });
  }

  /**
   * Единственный обработчик 404 на приложение.
   *
   * Для /api — строго JSON: HTML на месте JSON и давал пользователю
   * «Unexpected token '<'». Остальные пути уходят в SPA.
   */
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api') || !serveWeb) {
      void reply.status(404).send({
        ...publicErrorBody(new AppError('NOT_FOUND')),
        requestId: request.requestId,
      });
      return;
    }
    void reply.sendFile('index.html');
  });

  app.get('/api/health', async () => {
    const priceList = deps.db
      .prepare('SELECT label, items_count FROM price_list_versions WHERE is_active = 1')
      .get() as { label: string; items_count: number } | undefined;

    const jobs = deps.db
      .prepare(
        `SELECT
           SUM(CASE WHEN status NOT IN ('completed','failed') THEN 1 ELSE 0 END) AS active,
           SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued
         FROM jobs`,
      )
      .get() as { active: number | null; queued: number | null };

    return {
      status: 'ok',
      time: new Date().toISOString(),
      priceList: priceList ? { label: priceList.label, items: priceList.items_count } : null,
      aiConfigured: Boolean(deps.config.anthropicApiKey),
      jobs: { active: jobs.active ?? 0, queued: jobs.queued ?? 0 },
    };
  });

  await registerAuthRoutes(app);
  await registerUploadRoutes(app);
  await registerProjectRoutes(app);
  await registerJobRoutes(app);
  await registerEstimateRoutes(app);
  await registerPriceListRoutes(app);

  return app;
}
