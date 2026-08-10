import os from 'node:os';
import { config } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { openDatabase } from '../db/index.js';
import { createExtractionProvider } from '../domain/extraction/provider.js';
import { createWorkerRunner } from './runner.js';
import { newId } from '../shared/crypto.js';

/**
 * Точка входа воркера.
 *
 * Запускается отдельно от веб-сервера: `npm run start:worker`.
 * Именно это отделение снимает исходный дефект — расчёт больше не
 * ограничен временем жизни HTTP-запроса.
 */

const cfg = config();
const workerId = `${os.hostname()}-${process.pid}-${newId('w').slice(2, 10)}`;
const logger = createLogger(cfg.logLevel, { component: 'worker', workerId });

const db = openDatabase(cfg.databasePath);

const provider = createExtractionProvider({
  apiKey: cfg.anthropicApiKey,
  model: cfg.extractionModel,
  baseURL: cfg.anthropicBaseUrl,
});

if (cfg.anthropicBaseUrl) {
  // Документация уходит не на стандартный адрес — это должно быть видно в логе.
  logger.warn('Используется нестандартный адрес ИИ API', { baseUrl: cfg.anthropicBaseUrl });
}

if (!cfg.anthropicApiKey) {
  logger.warn(
    'ANTHROPIC_API_KEY не задан. Воркер запущен, но расчёты будут завершаться ' +
      'ошибкой AI_NOT_CONFIGURED до настройки ключа.',
  );
}

const runner = createWorkerRunner({ db, config: cfg, provider, logger, workerId });
runner.start();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Остановка воркера', { signal });
  await runner.stop();
  db.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Необработанное отклонение промиса', { reason: String(reason) });
});
