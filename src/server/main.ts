import path from 'node:path';
import fs from 'node:fs';
import fastifyStatic from '@fastify/static';
import { config } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { openDatabase } from '../db/index.js';
import { buildApp } from './app.js';

/**
 * Точка входа веб-сервера.
 *
 * Сервер не выполняет расчёт: он только создаёт задачи и отдаёт статус.
 * Расчёт идёт в процессе воркера (`npm run start:worker`).
 */

const cfg = config();
const logger = createLogger(cfg.logLevel, { component: 'server' });

const db = openDatabase(cfg.databasePath);
fs.mkdirSync(cfg.storageDir, { recursive: true });

const app = await buildApp({ db, config: cfg, logger });

// Статика собранного интерфейса с фолбэком на index.html для SPA-маршрутов.
const webRoot = path.resolve('dist-web');
if (fs.existsSync(webRoot)) {
  await app.register(fastifyStatic, { root: webRoot, prefix: '/' });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api')) {
      // API никогда не отдаёт HTML: иначе клиент получит «Unexpected token '<'».
      void reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'Объект не найден.', retryable: false },
        requestId: request.requestId,
      });
      return;
    }
    void reply.sendFile('index.html');
  });
} else {
  logger.warn('Каталог dist-web не найден — интерфейс не собран. Выполните: npm run build:web');
}

try {
  await app.listen({ port: cfg.port, host: cfg.host });
  logger.info('Сервер запущен', {
    port: cfg.port,
    host: cfg.host,
    publicUrl: cfg.publicUrl,
    aiConfigured: Boolean(cfg.anthropicApiKey),
  });
} catch (e) {
  logger.error('Не удалось запустить сервер', { detail: String(e) });
  process.exit(1);
}

async function shutdown(signal: string): Promise<void> {
  logger.info('Остановка сервера', { signal });
  await app.close();
  db.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
