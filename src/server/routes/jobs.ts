import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../shared/errors.js';
import { requireUser } from '../auth.js';
import { newId } from '../../shared/crypto.js';
import { toMilliQty } from '../../shared/money.js';
import {
  assertJobAccess,
  createJob,
  getJob,
  listActiveJobs,
  listJobEvents,
  markUploadsReady,
  STAGE_LABELS,
  type JobRow,
} from '../../jobs/queue.js';
import { getUpload } from '../../domain/files/uploads.js';
import { projectInputSchema } from './projects.js';

const createJobSchema = z.object({
  /**
   * Ключ идемпотентности генерирует клиент один раз на нажатие кнопки.
   * Повтор с тем же ключом возвращает уже созданную задачу.
   */
  idempotencyKey: z.string().min(8).max(120),
  project: projectInputSchema,
  projectId: z.string().max(64).optional(),
  uploadIds: z.array(z.string().min(1).max(64)).min(1).max(50),
});

/** Публичное представление задачи. Денежных данных здесь нет. */
function serializeJob(job: JobRow, events: ReturnType<typeof listJobEvents>) {
  return {
    jobId: job.id,
    projectId: job.project_id,
    status: job.status,
    stage: job.stage_message ?? STAGE_LABELS[job.status],
    progress: job.progress,
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
    estimateId: job.estimate_id,
    error: job.error_code ? { code: job.error_code, message: job.error_message ?? '' } : null,
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    /** Тайминги этапов — для отображения прогресса и диагностики. */
    timeline: events.map((e) => ({
      status: e.status,
      message: e.message,
      durationMs: e.duration_ms,
      at: e.created_at,
    })),
  };
}

export async function registerJobRoutes(app: FastifyInstance): Promise<void> {
  const { db, config, logger } = app.ctx;

  /**
   * Запуск расчёта.
   *
   * Отвечает немедленно: создаёт задачу и возвращает jobId.
   * Сам анализ идёт в отдельном процессе-воркере, поэтому длительность
   * расчёта никак не связана с временем жизни этого запроса.
   */
  app.post('/api/jobs', async (request) => {
    const user = requireUser(request);
    const body = createJobSchema.safeParse(request.body);
    if (!body.success) {
      throw new AppError('VALIDATION_FAILED', {
        issues: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }

    const { idempotencyKey, project, uploadIds } = body.data;

    if (uploadIds.length > config.maxFilesPerJob) {
      throw new AppError('TOO_MANY_FILES', { limit: config.maxFilesPerJob });
    }

    // Проверка идемпотентности ДО создания проекта: иначе повторное
    // нажатие плодило бы проекты-сироты без задач.
    const existing = db
      .prepare('SELECT * FROM jobs WHERE user_id = ? AND idempotency_key = ?')
      .get(user.id, idempotencyKey) as JobRow | undefined;

    if (existing) {
      logger.info('Повторный запуск с тем же ключом — задача не продублирована', {
        requestId: request.requestId,
        jobId: existing.id,
      });
      return { ...serializeJob(existing, listJobEvents(db, existing.id)), deduplicated: true };
    }

    // Все загрузки должны принадлежать пользователю.
    const uploads = uploadIds.map((id) => getUpload(db, id, user.id));
    const pendingUploads = uploads.some((u) => u.status !== 'complete');
    const failed = uploads.find((u) => u.status === 'failed' || u.status === 'expired');
    if (failed) {
      throw new AppError('UPLOAD_INCOMPLETE', { uploadId: failed.id, status: failed.status });
    }

    const now = Date.now();
    let projectId = body.data.projectId ?? null;

    const created = db.transaction(() => {
      if (projectId) {
        const owned = db
          .prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?')
          .get(projectId, user.id);
        if (!owned) throw new AppError('NOT_FOUND');
      } else {
        projectId = newId('prj');
        db.prepare(
          `INSERT INTO projects (id, user_id, name, area_milli, rooms, initial_state, scope_level, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          projectId,
          user.id,
          project.name,
          project.areaM2 === null || project.areaM2 === undefined ? null : toMilliQty(project.areaM2),
          project.rooms ?? null,
          project.initialState ?? null,
          project.scopeLevel ?? null,
          now,
          now,
        );
      }

      const result = createJob(db, {
        userId: user.id,
        projectId: projectId!,
        idempotencyKey,
        maxAttempts: config.jobMaxAttempts,
        timeoutMs: config.jobTimeoutMs,
        pendingUploads,
        now,
      });

      const insertFile = db.prepare(
        `INSERT INTO job_files (id, job_id, upload_id, filename, mime, size, sha256, storage_path, page_count, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      );
      uploads.forEach((upload, index) => {
        insertFile.run(
          newId('jfl'),
          result.job.id,
          upload.id,
          upload.filename,
          upload.mime,
          upload.declared_size,
          upload.sha256 ?? '',
          upload.storage_path,
          index,
          now,
        );
      });

      return result;
    })();

    logger.info('Задача расчёта создана', {
      requestId: request.requestId,
      jobId: created.job.id,
      projectId,
      files: uploads.length,
      pendingUploads,
    });

    return {
      ...serializeJob(created.job, listJobEvents(db, created.job.id)),
      // Токен восстановления выдаётся один раз. Он позволяет следить
      // за задачей, даже если сессия интерфейса истекла.
      recoveryToken: created.recoveryToken,
      deduplicated: created.deduplicated,
    };
  });

  /**
   * Статус задачи.
   *
   * Доступен владельцу по сессии либо держателю токена восстановления.
   * Токен нужен ровно для того, чтобы истёкшая сессия не отрезала
   * пользователя от идущего расчёта.
   */
  app.get<{ Params: { id: string }; Querystring: { token?: string } }>(
    '/api/jobs/:id',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (request) => {
      const job = assertJobAccess(
        getJob(db, request.params.id),
        request.user?.id ?? null,
        request.query.token,
      );
      return serializeJob(job, listJobEvents(db, job.id));
    },
  );

  /** Незавершённые задачи — интерфейс восстанавливает их после перезагрузки. */
  app.get('/api/jobs', async (request) => {
    const user = requireUser(request);
    const jobs = listActiveJobs(db, user.id);
    return { jobs: jobs.map((j) => serializeJob(j, listJobEvents(db, j.id))) };
  });

  /** Отмечает, что все файлы задачи догрузились, и ставит её в очередь. */
  app.post<{ Params: { id: string } }>('/api/jobs/:id/ready', async (request) => {
    const user = requireUser(request);
    const job = assertJobAccess(getJob(db, request.params.id), user.id);

    const files = db
      .prepare(`SELECT u.status FROM job_files jf JOIN uploads u ON u.id = jf.upload_id WHERE jf.job_id = ?`)
      .all(job.id) as Array<{ status: string }>;

    if (files.some((f) => f.status !== 'complete')) {
      throw new AppError('UPLOAD_INCOMPLETE', { reason: 'не все файлы загружены' });
    }

    markUploadsReady(db, job.id);
    const updated = getJob(db, job.id)!;
    return serializeJob(updated, listJobEvents(db, updated.id));
  });

  /**
   * Безопасный повтор.
   * Возвращает неуспешную задачу в очередь, не создавая вторую смету.
   */
  app.post<{ Params: { id: string } }>('/api/jobs/:id/retry', async (request) => {
    const user = requireUser(request);
    const job = assertJobAccess(getJob(db, request.params.id), user.id);

    if (job.status !== 'failed') {
      throw new AppError('VALIDATION_FAILED', { reason: 'повтор доступен только для неуспешной задачи' });
    }

    const now = Date.now();
    db.prepare(
      `UPDATE jobs
          SET status = 'queued', progress = 5, stage_message = 'Повторный запуск расчёта',
              attempts = 0, error_code = NULL, error_message = NULL,
              lease_until = NULL, worker_id = NULL, finished_at = NULL,
              deadline_at = @deadline, updated_at = @now
        WHERE id = @jobId AND status = 'failed'`,
    ).run({ jobId: job.id, now, deadline: now + config.jobTimeoutMs });

    logger.info('Задача перезапущена пользователем', { requestId: request.requestId, jobId: job.id });

    const updated = getJob(db, job.id)!;
    return serializeJob(updated, listJobEvents(db, updated.id));
  });
}
