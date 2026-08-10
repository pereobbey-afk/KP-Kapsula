import { describe, it, expect, beforeEach } from 'vitest';
import type { Db } from '../src/db/index.js';
import { makeDb, seedUser, seedProject, seedPriceList } from './helpers.js';
import {
  createJob,
  claimNext,
  heartbeat,
  setStage,
  completeJob,
  failJob,
  sweepStuckJobs,
  getJob,
  listActiveJobs,
  markUploadsReady,
  assertJobAccess,
  verifyRecoveryToken,
  listJobEvents,
} from '../src/jobs/queue.js';

/**
 * Регрессия на первопричину исходного дефекта.
 *
 * Дефект: длительный анализ был привязан к HTTP-запросу, процессу и
 * браузерной сессии, поэтому обрывался. Тесты ниже фиксируют, что
 * жизненный цикл задачи не зависит ни от одного из этих слоёв.
 */

let db: Db;
let userId: string;
let projectId: string;
let versionId: string;

const DEFAULTS = { maxAttempts: 3, timeoutMs: 60_000, pendingUploads: false };

function newJob(key: string, over: Partial<typeof DEFAULTS> = {}) {
  return createJob(db, { userId, projectId, idempotencyKey: key, ...DEFAULTS, ...over });
}

beforeEach(() => {
  db = makeDb();
  userId = seedUser(db);
  projectId = seedProject(db, userId);
  // Задача ссылается на версию прайса внешним ключом — нужна настоящая.
  versionId = seedPriceList(db, [
    { code: 'W-001', name: 'Штукатурка стен', unit: 'м2', priceKopecks: 45000 },
  ]).versionId;
});

describe('идемпотентность: повторное нажатие не создаёт две сметы', () => {
  it('второй вызов с тем же ключом возвращает ту же задачу', () => {
    const first = newJob('idem-1');
    const second = newJob('idem-1');

    expect(second.deduplicated).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(db.prepare('SELECT COUNT(*) c FROM jobs').get()).toEqual({ c: 1 });
  });

  it('токен восстановления выдаётся только при первом создании', () => {
    const first = newJob('idem-2');
    const second = newJob('idem-2');

    expect(first.recoveryToken).toBeTruthy();
    expect(second.recoveryToken).toBeNull();
  });

  it('разные ключи создают разные задачи', () => {
    expect(newJob('a').job.id).not.toBe(newJob('b').job.id);
    expect(db.prepare('SELECT COUNT(*) c FROM jobs').get()).toEqual({ c: 2 });
  });
});

describe('атомарный захват задачи', () => {
  it('одну задачу не получают два воркера', () => {
    newJob('single');

    const a = claimNext(db, 'worker-A', 30_000);
    const b = claimNext(db, 'worker-B', 30_000);

    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect(a!.worker_id).toBe('worker-A');
  });

  it('две задачи расходятся по двум воркерам', () => {
    newJob('one');
    newJob('two');

    const a = claimNext(db, 'worker-A', 30_000);
    const b = claimNext(db, 'worker-B', 30_000);

    expect(a!.id).not.toBe(b!.id);
  });

  it('задача со статусом uploading не берётся в работу', () => {
    newJob('waiting', { pendingUploads: true });
    expect(claimNext(db, 'worker-A', 30_000)).toBeNull();

    markUploadsReady(db, getJob(db, listActiveJobs(db, userId)[0]!.id)!.id);
    expect(claimNext(db, 'worker-A', 30_000)).not.toBeNull();
  });
});

describe('смерть воркера не убивает задачу', () => {
  it('истёкшая аренда возвращает задачу в очередь', () => {
    const { job } = newJob('lease');
    const t0 = Date.now();

    // Воркер захватил задачу и умер, не продлив аренду.
    const claimed = claimNext(db, 'dead-worker', 10_000, t0);
    expect(claimed).not.toBeNull();

    // Пока аренда жива, задачу не отобрать.
    expect(claimNext(db, 'live-worker', 10_000, t0 + 5_000)).toBeNull();

    // Аренда истекла — другой воркер подобрал ту же задачу.
    const reclaimed = claimNext(db, 'live-worker', 10_000, t0 + 11_000);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.id).toBe(job.id);
    expect(reclaimed!.attempts).toBe(2);
  });

  it('умерший воркер не может дописать результат в отобранную задачу', () => {
    const { job } = newJob('stolen');
    const t0 = Date.now();

    claimNext(db, 'dead-worker', 10_000, t0);
    claimNext(db, 'live-worker', 10_000, t0 + 11_000);

    // Ожил и пытается продлить аренду и завершить — обе операции отклонены.
    expect(heartbeat(db, job.id, 'dead-worker', 10_000, t0 + 12_000)).toBe(false);
    expect(setStage(db, job.id, 'dead-worker', 'calculating', 10_000, undefined, t0 + 12_000)).toBe(false);
    expect(completeJob(db, job.id, 'dead-worker', 'est_x', versionId, t0 + 12_000)).toBe(false);

    expect(getJob(db, job.id)!.status).not.toBe('completed');
    expect(getJob(db, job.id)!.worker_id).toBe('live-worker');
  });

  it('живой воркер продлевает аренду и удерживает задачу', () => {
    const { job } = newJob('alive');
    const t0 = Date.now();

    claimNext(db, 'worker-A', 10_000, t0);
    expect(heartbeat(db, job.id, 'worker-A', 10_000, t0 + 8_000)).toBe(true);

    // Аренда продлена — чужой воркер задачу не получит.
    expect(claimNext(db, 'worker-B', 10_000, t0 + 11_000)).toBeNull();
  });
});

describe('расчёт не зависит от сессии интерфейса', () => {
  it('задача выполняется после удаления всех сессий пользователя', () => {
    const { job, recoveryToken } = newJob('survives-session');

    // Пользователь вошёл, потом сессия истекла и была вычищена.
    db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?,?,?,?)').run(
      'sess-hash',
      userId,
      Date.now(),
      Date.now() + 1000,
    );
    db.prepare('DELETE FROM sessions').run();

    // Задача продолжает жить и доходит до результата.
    const claimed = claimNext(db, 'worker-A', 30_000);
    expect(claimed).not.toBeNull();
    expect(completeJob(db, job.id, 'worker-A', 'est_1', versionId)).toBe(true);
    expect(getJob(db, job.id)!.status).toBe('completed');

    // Токен восстановления продолжает открывать доступ к задаче.
    expect(verifyRecoveryToken(getJob(db, job.id)!, recoveryToken!)).toBe(true);
  });

  it('незавершённые задачи находятся для автоматического восстановления', () => {
    newJob('active-1');
    newJob('active-2');

    // Завершаем именно ту задачу, которую воркер захватил:
    // очередь отдаёт старшую, и завязываться на порядок создания нельзя.
    const claimed = claimNext(db, 'w', 30_000)!;
    expect(completeJob(db, claimed.id, 'w', 'est', versionId)).toBe(true);

    const active = listActiveJobs(db, userId);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).not.toBe(claimed.id);
    expect(active[0]!.status).toBe('queued');
  });
});

describe('доступ к задаче', () => {
  it('чужую задачу перебором jobId не достать', () => {
    const { job } = newJob('private');
    const stranger = seedUser(db, 'stranger@kapsula.test');

    expect(() => assertJobAccess(job, stranger)).toThrow(/не найден/i);
    // Ответ неотличим от несуществующей задачи — перебор ничего не выдаёт.
    expect(() => assertJobAccess(null, stranger)).toThrow(/не найден/i);
  });

  it('владелец и держатель токена восстановления получают доступ', () => {
    const { job, recoveryToken } = newJob('access');

    expect(assertJobAccess(job, userId).id).toBe(job.id);
    expect(assertJobAccess(job, null, recoveryToken!).id).toBe(job.id);
    expect(() => assertJobAccess(job, null, 'подобранный-токен')).toThrow();
  });
});

describe('ошибки, повторы и тайм-ауты', () => {
  it('ошибка с возможностью повтора возвращает задачу в очередь', () => {
    const { job } = newJob('retry');
    claimNext(db, 'w1', 30_000);

    const res = failJob(db, job.id, 'w1', 'AI_UNAVAILABLE', 'сервис недоступен', true);
    expect(res.requeued).toBe(true);
    expect(getJob(db, job.id)!.status).toBe('queued');

    // Задача снова доступна для захвата.
    expect(claimNext(db, 'w2', 30_000)).not.toBeNull();
  });

  it('неповторяемая ошибка завершает задачу с диагностируемым кодом', () => {
    const { job } = newJob('fatal');
    claimNext(db, 'w1', 30_000);

    failJob(db, job.id, 'w1', 'PDF_PASSWORD_PROTECTED', 'файл под паролем', false);

    const after = getJob(db, job.id)!;
    expect(after.status).toBe('failed');
    expect(after.error_code).toBe('PDF_PASSWORD_PROTECTED');
    expect(after.finished_at).toBeTruthy();
  });

  it('исчерпание попыток окончательно завершает задачу', () => {
    const { job } = newJob('exhaust', { maxAttempts: 2 });

    claimNext(db, 'w', 30_000);
    failJob(db, job.id, 'w', 'AI_UNAVAILABLE', 'раз', true);
    claimNext(db, 'w', 30_000);
    failJob(db, job.id, 'w', 'AI_UNAVAILABLE', 'два', true);

    const after = getJob(db, job.id)!;
    expect(after.status).toBe('failed');
    expect(after.attempts).toBe(2);
    // Больше в работу не берётся.
    expect(claimNext(db, 'w', 30_000)).toBeNull();
  });

  it('зависшая задача закрывается по тайм-ауту, а не висит вечно', () => {
    const { job } = newJob('stuck', { timeoutMs: 1_000 });
    const t0 = Date.now();
    claimNext(db, 'w', 30_000, t0);

    const swept = sweepStuckJobs(db, t0 + 2_000);

    expect(swept.timedOut).toBe(1);
    const after = getJob(db, job.id)!;
    expect(after.status).toBe('failed');
    expect(after.error_code).toBe('JOB_TIMEOUT');
  });

  it('завершённые задачи тайм-аут не трогает', () => {
    const { job } = newJob('done', { timeoutMs: 1_000 });
    const t0 = Date.now();
    claimNext(db, 'w', 30_000, t0);
    completeJob(db, job.id, 'w', 'est', versionId, t0);

    expect(sweepStuckJobs(db, t0 + 5_000).timedOut).toBe(0);
    expect(getJob(db, job.id)!.status).toBe('completed');
  });
});

describe('журнал этапов', () => {
  it('фиксирует длительность каждого этапа', () => {
    const { job } = newJob('timeline');
    const t0 = Date.now();

    claimNext(db, 'w', 30_000, t0);
    setStage(db, job.id, 'w', 'extracting', 30_000, undefined, t0 + 3_000);
    setStage(db, job.id, 'w', 'calculating', 30_000, undefined, t0 + 8_000);
    completeJob(db, job.id, 'w', 'est', versionId, t0 + 9_000);

    const events = listJobEvents(db, job.id);
    const statuses = events.map((e) => e.status);
    expect(statuses).toEqual(['queued', 'classifying', 'extracting', 'calculating', 'completed']);

    const extracting = events.find((e) => e.status === 'extracting')!;
    expect(extracting.duration_ms).toBe(5_000);
  });
});
