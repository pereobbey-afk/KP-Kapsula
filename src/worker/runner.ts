import fs from 'node:fs/promises';
import type { Db } from '../db/index.js';
import type { AppConfig } from '../shared/config.js';
import type { Logger } from '../shared/logger.js';
import { describeUnknown } from '../shared/errors.js';
import { claimNext, sweepStuckJobs } from '../jobs/queue.js';
import { processJob, type PipelineContext } from './pipeline.js';

/**
 * Цикл воркера.
 *
 * Воркер — отдельный процесс. Он не обслуживает HTTP-запросы, поэтому
 * длительность расчёта ничем не ограничена со стороны веб-слоя.
 * Остановка процесса безопасна: незавершённые задачи вернутся в очередь
 * по истечении аренды и будут подобраны заново.
 */

export type WorkerRunner = {
  start: () => void;
  stop: () => Promise<void>;
  /** Один проход цикла — используется в тестах вместо ожидания таймера. */
  tick: () => Promise<number>;
};

export function createWorkerRunner(
  ctx: PipelineContext & { db: Db; config: AppConfig; logger: Logger },
): WorkerRunner {
  const inFlight = new Set<Promise<void>>();
  let stopped = false;
  let loopTimer: NodeJS.Timeout | null = null;
  let maintenanceTimer: NodeJS.Timeout | null = null;

  /** Забирает задачи, пока есть свободные слоты. Возвращает число взятых. */
  async function tick(): Promise<number> {
    if (stopped) return 0;
    let taken = 0;

    while (inFlight.size < ctx.config.workerConcurrency) {
      let job;
      try {
        job = claimNext(ctx.db, ctx.workerId, ctx.config.jobLeaseMs);
      } catch (e) {
        ctx.logger.error('Не удалось захватить задачу', { detail: describeUnknown(e) });
        break;
      }
      if (!job) break;

      taken += 1;
      ctx.logger.info('Задача взята в работу', {
        jobId: job.id,
        attempt: job.attempts,
        queuedMs: Date.now() - job.created_at,
      });

      const promise = processJob(ctx, job)
        .catch((e: unknown) => {
          // processJob сам обрабатывает ошибки; сюда попадает только
          // сбой самого обработчика.
          ctx.logger.error('Сбой обработчика задачи', {
            jobId: job.id,
            detail: describeUnknown(e),
          });
        })
        .finally(() => {
          inFlight.delete(promise);
        });

      inFlight.add(promise);
    }

    return taken;
  }

  /** Уборка: зависшие задачи и просроченные загрузки. */
  async function maintenance(): Promise<void> {
    try {
      const swept = sweepStuckJobs(ctx.db);
      if (swept.timedOut > 0 || swept.exhausted > 0) {
        ctx.logger.warn('Зависшие задачи закрыты', swept);
      }
    } catch (e) {
      ctx.logger.error('Сбой уборки задач', { detail: describeUnknown(e) });
    }

    try {
      await cleanupExpiredUploads(ctx.db, ctx.logger);
    } catch (e) {
      ctx.logger.error('Сбой уборки загрузок', { detail: describeUnknown(e) });
    }
  }

  function scheduleLoop(): void {
    if (stopped) return;
    loopTimer = setTimeout(() => {
      void tick().finally(scheduleLoop);
    }, 1000);
    // Таймер НЕ снимается с учёта (unref): он единственное, что держит
    // процесс воркера живым. Остановка выполняется явно через stop().
  }

  return {
    start() {
      stopped = false;
      ctx.logger.info('Воркер запущен', {
        workerId: ctx.workerId,
        concurrency: ctx.config.workerConcurrency,
        leaseMs: ctx.config.jobLeaseMs,
      });
      scheduleLoop();
      maintenanceTimer = setInterval(() => void maintenance(), 60_000);
      void maintenance();
    },

    async stop() {
      stopped = true;
      if (loopTimer) clearTimeout(loopTimer);
      if (maintenanceTimer) clearInterval(maintenanceTimer);
      // Дожидаемся текущих задач: обрывать их на середине незачем,
      // но и держать процесс вечно нельзя — аренда всё равно вернёт задачу.
      await Promise.allSettled([...inFlight]);
      ctx.logger.info('Воркер остановлен', { workerId: ctx.workerId });
    },

    tick,
  };
}

/**
 * Удаляет загрузки с истёкшим TTL.
 *
 * Файлы задач, по которым пользователь ещё может получить результат,
 * не трогаются: удаляются только загрузки, не привязанные ни к одной
 * незавершённой задаче.
 */
export async function cleanupExpiredUploads(db: Db, logger: Logger): Promise<number> {
  const now = Date.now();
  const expired = db
    .prepare(
      `SELECT u.id, u.storage_path
         FROM uploads u
        WHERE u.expires_at <= ?
          AND NOT EXISTS (
                SELECT 1 FROM job_files jf
                  JOIN jobs j ON j.id = jf.job_id
                 WHERE jf.upload_id = u.id
                   AND j.status NOT IN ('completed','failed')
              )`,
    )
    .all(now) as Array<{ id: string; storage_path: string }>;

  let removed = 0;
  for (const upload of expired) {
    try {
      await fs.rm(upload.storage_path, { force: true });
    } catch (e) {
      logger.warn('Не удалось удалить файл загрузки', {
        uploadId: upload.id,
        detail: describeUnknown(e),
      });
    }
    db.prepare("UPDATE uploads SET status = 'expired' WHERE id = ?").run(upload.id);
    removed += 1;
  }

  if (removed > 0) logger.info('Просроченные загрузки удалены', { removed });
  return removed;
}
