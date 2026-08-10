import type { Db } from '../db/index.js';
import { newId, newToken, sha256, timingSafeEqualHex } from '../shared/crypto.js';
import { AppError, type ErrorCode } from '../shared/errors.js';

/**
 * Durable-очередь задач расчёта.
 *
 * Первопричина исходного дефекта — длительный анализ был привязан к
 * жизненному циклу HTTP-запроса и браузерной сессии. Здесь этой связи нет:
 *
 *  - состояние задачи живёт в БД, а не в памяти процесса или вкладки;
 *  - воркер захватывает задачу атомарным UPDATE ... RETURNING;
 *  - захват берётся в аренду (lease). Умер воркер — аренда истекла,
 *    задача вернулась в очередь и её подобрал другой воркер;
 *  - сессия интерфейса нигде не участвует в жизненном цикле задачи.
 */

export const JOB_STATUSES = [
  'queued',
  'uploading',
  'classifying',
  'extracting',
  'validating',
  'calculating',
  'completed',
  'failed',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/** Этапы, на которых задачу держит воркер. */
export const PROCESSING_STATUSES: readonly JobStatus[] = [
  'classifying',
  'extracting',
  'validating',
  'calculating',
];

export const TERMINAL_STATUSES: readonly JobStatus[] = ['completed', 'failed'];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Доля прогресса на входе в этап — чтобы полоса двигалась предсказуемо. */
export const STAGE_PROGRESS: Record<JobStatus, number> = {
  uploading: 2,
  queued: 5,
  classifying: 15,
  extracting: 35,
  validating: 70,
  calculating: 85,
  completed: 100,
  failed: 100,
};

export const STAGE_LABELS: Record<JobStatus, string> = {
  uploading: 'Загрузка файлов',
  queued: 'В очереди на расчёт',
  classifying: 'Определение типа документа',
  extracting: 'Извлечение объёмов из документации',
  validating: 'Проверка полноты и достоверности данных',
  calculating: 'Расчёт по действующему прайсу',
  completed: 'Смета готова',
  failed: 'Расчёт не выполнен',
};

export type JobRow = {
  id: string;
  user_id: string;
  project_id: string;
  idempotency_key: string;
  status: JobStatus;
  stage_message: string | null;
  progress: number;
  attempts: number;
  max_attempts: number;
  lease_until: number | null;
  worker_id: string | null;
  recovery_token_hash: string;
  error_code: string | null;
  error_message: string | null;
  price_list_version_id: string | null;
  estimate_id: string | null;
  deadline_at: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
};

export type CreateJobInput = {
  userId: string;
  projectId: string;
  idempotencyKey: string;
  maxAttempts: number;
  timeoutMs: number;
  /** true, если хотя бы один файл ещё догружается */
  pendingUploads: boolean;
  now?: number;
};

export type CreateJobResult = {
  job: JobRow;
  /** Отдаётся клиенту один раз. В БД лежит только хеш. */
  recoveryToken: string | null;
  /** true, если задача уже существовала по этому ключу идемпотентности. */
  deduplicated: boolean;
};

/**
 * Создаёт задачу. Повторный вызов с тем же ключом идемпотентности
 * возвращает существующую задачу и НЕ создаёт вторую смету.
 */
export function createJob(db: Db, input: CreateJobInput): CreateJobResult {
  const now = input.now ?? Date.now();

  const existing = db
    .prepare('SELECT * FROM jobs WHERE user_id = ? AND idempotency_key = ?')
    .get(input.userId, input.idempotencyKey) as JobRow | undefined;

  if (existing) {
    return { job: existing, recoveryToken: null, deduplicated: true };
  }

  const recoveryToken = newToken();
  const status: JobStatus = input.pendingUploads ? 'uploading' : 'queued';

  const job: JobRow = {
    id: newId('job'),
    user_id: input.userId,
    project_id: input.projectId,
    idempotency_key: input.idempotencyKey,
    status,
    stage_message: STAGE_LABELS[status],
    progress: STAGE_PROGRESS[status],
    attempts: 0,
    max_attempts: input.maxAttempts,
    lease_until: null,
    worker_id: null,
    recovery_token_hash: sha256(recoveryToken),
    error_code: null,
    error_message: null,
    price_list_version_id: null,
    estimate_id: null,
    deadline_at: now + input.timeoutMs,
    created_at: now,
    updated_at: now,
    started_at: null,
    finished_at: null,
  };

  try {
    db.prepare(
      `INSERT INTO jobs (
         id, user_id, project_id, idempotency_key, status, stage_message, progress,
         attempts, max_attempts, lease_until, worker_id, recovery_token_hash,
         error_code, error_message, price_list_version_id, estimate_id,
         deadline_at, created_at, updated_at, started_at, finished_at
       ) VALUES (
         @id, @user_id, @project_id, @idempotency_key, @status, @stage_message, @progress,
         @attempts, @max_attempts, @lease_until, @worker_id, @recovery_token_hash,
         @error_code, @error_message, @price_list_version_id, @estimate_id,
         @deadline_at, @created_at, @updated_at, @started_at, @finished_at
       )`,
    ).run(job);
  } catch (e) {
    // Гонка: два одновременных нажатия кнопки. Уникальный индекс не дал
    // создать дубль — возвращаем ту задачу, которая успела записаться.
    const raced = db
      .prepare('SELECT * FROM jobs WHERE user_id = ? AND idempotency_key = ?')
      .get(input.userId, input.idempotencyKey) as JobRow | undefined;
    if (raced) return { job: raced, recoveryToken: null, deduplicated: true };
    throw e;
  }

  recordEvent(db, job.id, status, STAGE_LABELS[status], null, now);
  return { job, recoveryToken, deduplicated: false };
}

/** Все файлы догрузились — задача становится в очередь. */
export function markUploadsReady(db: Db, jobId: string, now = Date.now()): boolean {
  const res = db
    .prepare(
      `UPDATE jobs
          SET status = 'queued', stage_message = @label, progress = @progress, updated_at = @now
        WHERE id = @jobId AND status = 'uploading'`,
    )
    .run({ jobId, now, label: STAGE_LABELS.queued, progress: STAGE_PROGRESS.queued });

  if (res.changes > 0) recordEvent(db, jobId, 'queued', STAGE_LABELS.queued, null, now);
  return res.changes > 0;
}

/**
 * Атомарно захватывает одну задачу.
 *
 * Один UPDATE ... RETURNING — два воркера не могут получить одну задачу.
 * Берутся и новые задачи, и те, чья аренда истекла (воркер умер).
 */
export function claimNext(
  db: Db,
  workerId: string,
  leaseMs: number,
  now = Date.now(),
): JobRow | null {
  const row = db
    .prepare(
      `UPDATE jobs
          SET status       = 'classifying',
              worker_id    = @workerId,
              lease_until  = @leaseUntil,
              attempts     = attempts + 1,
              started_at   = COALESCE(started_at, @now),
              updated_at   = @now,
              stage_message= @label,
              progress     = @progress
        WHERE id = (
          SELECT id FROM jobs
           WHERE status NOT IN ('completed','failed','uploading')
             AND (lease_until IS NULL OR lease_until <= @now)
             AND deadline_at > @now
             AND attempts < max_attempts
           ORDER BY created_at ASC
           LIMIT 1
        )
        RETURNING *`,
    )
    .get({
      workerId,
      leaseUntil: now + leaseMs,
      now,
      label: STAGE_LABELS.classifying,
      progress: STAGE_PROGRESS.classifying,
    }) as JobRow | undefined;

  if (!row) return null;
  recordEvent(db, row.id, 'classifying', STAGE_LABELS.classifying, null, now);
  return row;
}

/**
 * Продлевает аренду. Возвращает false, если задачу уже отобрали
 * или она завершилась — воркер обязан прекратить работу.
 */
export function heartbeat(
  db: Db,
  jobId: string,
  workerId: string,
  leaseMs: number,
  now = Date.now(),
): boolean {
  const res = db
    .prepare(
      `UPDATE jobs SET lease_until = @leaseUntil, updated_at = @now
        WHERE id = @jobId AND worker_id = @workerId
          AND status NOT IN ('completed','failed')`,
    )
    .run({ jobId, workerId, leaseUntil: now + leaseMs, now });
  return res.changes > 0;
}

/** Переход на следующий этап. Одновременно продлевает аренду. */
export function setStage(
  db: Db,
  jobId: string,
  workerId: string,
  status: JobStatus,
  leaseMs: number,
  message?: string,
  now = Date.now(),
): boolean {
  const label = message ?? STAGE_LABELS[status];
  const res = db
    .prepare(
      `UPDATE jobs
          SET status = @status, stage_message = @label, progress = @progress,
              lease_until = @leaseUntil, updated_at = @now
        WHERE id = @jobId AND worker_id = @workerId
          AND status NOT IN ('completed','failed')`,
    )
    .run({
      jobId,
      workerId,
      status,
      label,
      progress: STAGE_PROGRESS[status],
      leaseUntil: now + leaseMs,
      now,
    });

  if (res.changes > 0) recordEvent(db, jobId, status, label, null, now);
  return res.changes > 0;
}

export function completeJob(
  db: Db,
  jobId: string,
  workerId: string,
  estimateId: string,
  priceListVersionId: string,
  now = Date.now(),
): boolean {
  const res = db
    .prepare(
      `UPDATE jobs
          SET status = 'completed', stage_message = @label, progress = 100,
              estimate_id = @estimateId, price_list_version_id = @versionId,
              lease_until = NULL, worker_id = NULL,
              error_code = NULL, error_message = NULL,
              finished_at = @now, updated_at = @now
        WHERE id = @jobId AND worker_id = @workerId
          AND status NOT IN ('completed','failed')`,
    )
    .run({
      jobId,
      workerId,
      estimateId,
      versionId: priceListVersionId,
      now,
      label: STAGE_LABELS.completed,
    });

  if (res.changes > 0) recordEvent(db, jobId, 'completed', STAGE_LABELS.completed, null, now);
  return res.changes > 0;
}

/**
 * Помечает неудачу.
 *
 * Ошибка, допускающая повтор, и незакончившиеся попытки — задача
 * возвращается в очередь. Иначе становится окончательно неуспешной
 * с диагностируемым кодом.
 */
export function failJob(
  db: Db,
  jobId: string,
  workerId: string,
  code: ErrorCode,
  message: string,
  retryable: boolean,
  now = Date.now(),
): { requeued: boolean } {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;
  if (!job) return { requeued: false };

  const canRetry = retryable && job.attempts < job.max_attempts && job.deadline_at > now;

  if (canRetry) {
    const res = db
      .prepare(
        `UPDATE jobs
            SET status = 'queued', stage_message = @label, progress = @progress,
                lease_until = NULL, worker_id = NULL,
                error_code = @code, error_message = @message, updated_at = @now
          WHERE id = @jobId AND worker_id = @workerId`,
      )
      .run({
        jobId,
        workerId,
        code,
        message,
        now,
        label: `Повтор после ошибки (попытка ${job.attempts + 1} из ${job.max_attempts})`,
        progress: STAGE_PROGRESS.queued,
      });
    if (res.changes > 0) recordEvent(db, jobId, 'queued', `Повтор: ${code}`, null, now);
    return { requeued: res.changes > 0 };
  }

  const res = db
    .prepare(
      `UPDATE jobs
          SET status = 'failed', stage_message = @label, progress = 100,
              lease_until = NULL, worker_id = NULL,
              error_code = @code, error_message = @message,
              finished_at = @now, updated_at = @now
        WHERE id = @jobId AND status NOT IN ('completed','failed')`,
    )
    .run({ jobId, code, message, now, label: STAGE_LABELS.failed });

  if (res.changes > 0) recordEvent(db, jobId, 'failed', `${code}: ${message}`, null, now);
  return { requeued: false };
}

/**
 * Завершает задачи, вышедшие за общий тайм-аут, и те, что исчерпали попытки.
 * Без этого зависшая задача осталась бы «вечно в работе».
 */
export function sweepStuckJobs(db: Db, now = Date.now()): { timedOut: number; exhausted: number } {
  const timedOut = db
    .prepare(
      `UPDATE jobs
          SET status = 'failed', stage_message = @label, progress = 100,
              lease_until = NULL, worker_id = NULL,
              error_code = 'JOB_TIMEOUT',
              error_message = 'Расчёт превысил допустимое время',
              finished_at = @now, updated_at = @now
        WHERE status NOT IN ('completed','failed') AND deadline_at <= @now`,
    )
    .run({ now, label: STAGE_LABELS.failed }).changes;

  const exhausted = db
    .prepare(
      `UPDATE jobs
          SET status = 'failed', stage_message = @label, progress = 100,
              lease_until = NULL, worker_id = NULL,
              error_code = COALESCE(error_code, 'INTERNAL'),
              error_message = COALESCE(error_message, 'Исчерпаны попытки выполнения'),
              finished_at = @now, updated_at = @now
        WHERE status NOT IN ('completed','failed')
          AND attempts >= max_attempts
          AND (lease_until IS NULL OR lease_until <= @now)`,
    )
    .run({ now, label: STAGE_LABELS.failed }).changes;

  return { timedOut, exhausted };
}

export function getJob(db: Db, jobId: string): JobRow | null {
  return (db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined) ?? null;
}

/** Незавершённые задачи пользователя — источник автоматического восстановления. */
export function listActiveJobs(db: Db, userId: string): JobRow[] {
  return db
    .prepare(
      `SELECT * FROM jobs
        WHERE user_id = ? AND status NOT IN ('completed','failed')
        ORDER BY created_at DESC`,
    )
    .all(userId) as JobRow[];
}

/** Проверка токена восстановления без утечки времени сравнения. */
export function verifyRecoveryToken(job: JobRow, token: string): boolean {
  return timingSafeEqualHex(job.recovery_token_hash, sha256(token));
}

/** Доступ к задаче: либо владелец сессии, либо валидный токен восстановления. */
export function assertJobAccess(job: JobRow | null, userId: string | null, token?: string): JobRow {
  // Единый ответ для «нет задачи» и «чужая задача»: перебор jobId
  // не должен отличать эти случаи.
  if (!job) throw new AppError('NOT_FOUND');
  if (userId && job.user_id === userId) return job;
  if (token && verifyRecoveryToken(job, token)) return job;
  throw new AppError('NOT_FOUND');
}

export type JobEventRow = {
  id: number;
  job_id: string;
  status: string;
  message: string | null;
  duration_ms: number | null;
  created_at: number;
};

/**
 * Записывает событие этапа и проставляет длительность предыдущего.
 * Даёт готовые тайминги этапов для отчёта и диагностики.
 */
export function recordEvent(
  db: Db,
  jobId: string,
  status: string,
  message: string | null,
  durationMs: number | null,
  now = Date.now(),
): void {
  const previous = db
    .prepare('SELECT id, created_at FROM job_events WHERE job_id = ? ORDER BY id DESC LIMIT 1')
    .get(jobId) as { id: number; created_at: number } | undefined;

  if (previous) {
    db.prepare('UPDATE job_events SET duration_ms = ? WHERE id = ? AND duration_ms IS NULL').run(
      now - previous.created_at,
      previous.id,
    );
  }

  db.prepare(
    `INSERT INTO job_events (job_id, status, message, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(jobId, status, message, durationMs, now);
}

export function listJobEvents(db: Db, jobId: string): JobEventRow[] {
  return db
    .prepare('SELECT * FROM job_events WHERE job_id = ? ORDER BY id ASC')
    .all(jobId) as JobEventRow[];
}
