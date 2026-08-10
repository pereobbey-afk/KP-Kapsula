import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db/index.js';
import { openDatabase } from '../src/db/index.js';
import { loadConfig, type AppConfig } from '../src/shared/config.js';
import { buildApp } from '../src/server/app.js';
import { createLogger } from '../src/shared/logger.js';
import { createWorkerRunner } from '../src/worker/runner.js';
import type { ExtractionProvider, ExtractionOutcome } from '../src/domain/extraction/provider.js';
import { AppError } from '../src/shared/errors.js';
import { makeTestPdf, seedPriceList } from './helpers.js';
import { kopecksToRubles } from '../src/shared/money.js';

/**
 * Сквозной тест конвейера через настоящие HTTP-маршруты и настоящий воркер.
 *
 * Мокается только обращение к модели — всё остальное работает по-честному:
 * поэтапная загрузка, БД, очередь, расчёт, экспорт.
 */

/** Размер PDF из отчёта об ошибке: 2,23 МБ. */
const PDF_SIZE = 2_338_193;

const PRICE_ROWS = [
  { code: 'W-PLASTER', name: 'Штукатурка стен', unit: 'м2', priceKopecks: 45000, section: 'Стены', sectionNo: 1 },
  { code: 'W-PUTTY', name: 'Шпаклевка стен', unit: 'м2', priceKopecks: 25000, section: 'Стены', sectionNo: 1 },
  { code: 'W-SCREED', name: 'Стяжка пола', unit: 'м2', priceKopecks: 50000, section: 'Полы', sectionNo: 2 },
  { code: 'W-SOCKET', name: 'Установка розетки', unit: 'шт', priceKopecks: 35000, section: 'Электрика', sectionNo: 3 },
];

let tmpDir: string;
let db: Db;
let app: FastifyInstance;
let config: AppConfig;
let cookie: string;
let provider: MutableProvider;

/** Провайдер, поведение которого меняется по ходу теста. */
class MutableProvider implements ExtractionProvider {
  calls = 0;
  behaviour: () => Promise<ExtractionOutcome> = async () => defaultOutcome();

  async extract(): Promise<ExtractionOutcome> {
    this.calls += 1;
    return this.behaviour();
  }
}

function defaultOutcome(over: Partial<ExtractionOutcome['result']> = {}): ExtractionOutcome {
  return {
    model: 'test-model',
    usage: { inputTokens: 100, outputTokens: 200 },
    result: {
      documentType: 'full_project',
      completenessNote: 'Есть планы, размеры и ведомости.',
      detectedAreaM2: 50,
      detectedRooms: 2,
      hasWetZones: true,
      facts: [
        {
          code: 'W-PLASTER',
          documentWording: 'Штукатурка стен по маякам',
          quantity: 120,
          unit: 'м2',
          confidence: 'confirmed',
          source: { file: 'проект.pdf', page: 4, ref: 'Ведомость отделки' },
          basis: 'Из ведомости отделки помещений',
        },
        {
          code: 'W-SCREED',
          documentWording: 'Стяжка пола',
          quantity: 50,
          unit: 'м2',
          confidence: 'derived',
          source: { file: 'проект.pdf', page: 6, ref: 'План полов' },
          basis: 'Площадь помещений по плану',
        },
      ],
      unknowns: [
        { title: 'Количество розеток не указано', detail: 'Схемы электрики в проекте нет', code: 'W-SOCKET' },
      ],
      assumptions: [{ title: 'Высота потолка принята 2,7 м', detail: 'Явно не указана' }],
      processedPages: [
        { file: 'проект.pdf', page: 4, kind: 'Ведомость отделки' },
        { file: 'проект.pdf', page: 6, kind: 'План полов' },
      ],
      suspectedPromptInjection: false,
      ...over,
    },
  };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smetchik-test-'));

  config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: path.join(tmpDir, 'test.sqlite'),
    STORAGE_DIR: path.join(tmpDir, 'storage'),
    SESSION_SECRET: 'test-secret-at-least-32-characters-long!!',
    UPLOAD_CHUNK_BYTES: String(512 * 1024),
    MAX_FILE_BYTES: String(64 * 1024 * 1024),
    JOB_LEASE_SECONDS: '30',
    JOB_TIMEOUT_SECONDS: '600',
    JOB_MAX_ATTEMPTS: '3',
    LOG_LEVEL: 'error',
  });

  fs.mkdirSync(config.storageDir, { recursive: true });
  db = openDatabase(config.databasePath);
  seedPriceList(db, PRICE_ROWS);

  provider = new MutableProvider();
  app = await buildApp({ db, config, logger: createLogger('error', {}) });
  await app.ready();

  // Регистрация первого пользователя — он же администратор.
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email: 'smetchik@kapsula.test', password: 'очень-надёжный-пароль-1' },
  });
  expect(res.statusCode).toBe(200);
  cookie = extractCookie(res.headers['set-cookie']);
});

afterEach(async () => {
  await app.close();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function extractCookie(raw: string | string[] | undefined): string {
  const list = Array.isArray(raw) ? raw : [raw ?? ''];
  const session = list.find((c) => c.startsWith('smetchik_session='));
  return session?.split(';')[0] ?? '';
}

/** Загружает файл частями, как это делает интерфейс. */
async function uploadFile(data: Buffer, filename = 'проект.pdf'): Promise<string> {
  const init = await app.inject({
    method: 'POST',
    url: '/api/uploads',
    headers: { cookie },
    payload: { filename, mime: 'application/pdf', size: data.length },
  });
  expect(init.statusCode).toBe(200);
  const { uploadId, chunkSize, totalChunks } = init.json();

  for (let i = 0; i < totalChunks; i += 1) {
    const slice = data.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, data.length));
    const res = await app.inject({
      method: 'PUT',
      url: `/api/uploads/${uploadId}/chunks/${i}`,
      headers: { cookie, 'content-type': 'application/octet-stream' },
      payload: slice,
    });
    expect(res.statusCode).toBe(200);
  }

  const complete = await app.inject({
    method: 'POST',
    url: `/api/uploads/${uploadId}/complete`,
    headers: { cookie },
  });
  expect(complete.statusCode).toBe(200);
  return uploadId;
}

async function startJob(uploadIds: string[], idempotencyKey = 'key-' + Math.random().toString(36).slice(2)) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/jobs',
    headers: { cookie },
    payload: {
      idempotencyKey,
      uploadIds,
      project: { name: 'Квартира на Ленина', areaM2: 50, rooms: 2, initialState: 'concrete', scopeLevel: 'Полный ремонт' },
    },
  });
  return res;
}

/** Прогоняет воркер до завершения задачи. */
async function runWorkerUntilDone(jobId: string, maxTicks = 20): Promise<void> {
  const runner = createWorkerRunner({
    db,
    config,
    provider,
    logger: createLogger('error', {}),
    workerId: 'test-worker',
  });

  for (let i = 0; i < maxTicks; i += 1) {
    await runner.tick();
    await new Promise((r) => setImmediate(r));
    const job = db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as { status: string };
    if (job.status === 'completed' || job.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await runner.stop();
}

describe('1. PDF 2,23 МБ загружается без ложной ошибки размера', () => {
  it('файл принимается частями и проходит проверку целиком', async () => {
    const pdf = makeTestPdf(PDF_SIZE);
    expect(pdf.length).toBe(PDF_SIZE);

    const uploadId = await uploadFile(pdf);

    const status = await app.inject({ method: 'GET', url: `/api/uploads/${uploadId}`, headers: { cookie } });
    const body = status.json();

    expect(body.status).toBe('complete');
    expect(body.receivedSize).toBe(PDF_SIZE);
    expect(body.missingChunks).toEqual([]);
  });

  it('файл сверх лимита отклоняется с отдельным кодом ошибки', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { cookie },
      payload: { filename: 'огромный.pdf', mime: 'application/pdf', size: config.maxFileBytes + 1 },
    });

    expect(res.statusCode).toBe(413);
    // Отдельный код — не «неподдерживаемый формат» и не общая ошибка.
    expect(res.json().error.code).toBe('FILE_TOO_LARGE');
  });
});

describe('2-3. расчёт переживает перезагрузку страницы и истечение сессии', () => {
  it('после перезагрузки незавершённая задача находится и доводится до сметы', async () => {
    const uploadId = await uploadFile(makeTestPdf(PDF_SIZE));
    const created = await startJob([uploadId]);
    const { jobId } = created.json();

    // «Перезагрузка страницы»: новый запрос без какого-либо клиентского состояния.
    const active = await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie } });
    expect(active.json().jobs.map((j: { jobId: string }) => j.jobId)).toContain(jobId);

    await runWorkerUntilDone(jobId);

    const done = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers: { cookie } });
    expect(done.json().status).toBe('completed');
    expect(done.json().estimateId).toBeTruthy();
  });

  it('истечение сессии не убивает расчёт, а токен восстановления даёт статус', async () => {
    const uploadId = await uploadFile(makeTestPdf(PDF_SIZE));
    const created = await startJob([uploadId]);
    const { jobId, recoveryToken } = created.json();
    expect(recoveryToken).toBeTruthy();

    // Сессия интерфейса истекла и вычищена.
    db.prepare('DELETE FROM sessions').run();

    const denied = await app.inject({ method: 'GET', url: '/api/jobs', headers: { cookie } });
    expect(denied.statusCode).toBe(401);
    expect(denied.json().error.code).toBe('AUTH_REQUIRED');

    // Расчёт при этом продолжается и доходит до конца.
    await runWorkerUntilDone(jobId);

    const byToken = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}?token=${recoveryToken}` });
    expect(byToken.statusCode).toBe(200);
    expect(byToken.json().status).toBe('completed');
  });

  it('чужой jobId перебором не открывается', async () => {
    const uploadId = await uploadFile(makeTestPdf(PDF_SIZE));
    const { jobId } = (await startJob([uploadId])).json();

    // Без сессии и без токена — 404, неотличимо от несуществующей задачи.
    const anonymous = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}` });
    expect(anonymous.statusCode).toBe(404);

    const wrongToken = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}?token=подбор` });
    expect(wrongToken.statusCode).toBe(404);
  });
});

describe('4. временный обрыв сети не уничтожает загрузку', () => {
  it('недостающие части догружаются, повтор части безопасен', async () => {
    const pdf = makeTestPdf(PDF_SIZE);
    const init = await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: { cookie },
      payload: { filename: 'проект.pdf', mime: 'application/pdf', size: pdf.length },
    });
    const { uploadId, chunkSize, totalChunks } = init.json();

    // Отправляем все части, кроме одной — имитация обрыва.
    const skipped = 2;
    for (let i = 0; i < totalChunks; i += 1) {
      if (i === skipped) continue;
      await app.inject({
        method: 'PUT',
        url: `/api/uploads/${uploadId}/chunks/${i}`,
        headers: { cookie, 'content-type': 'application/octet-stream' },
        payload: pdf.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, pdf.length)),
      });
    }

    // Завершение отклоняется, но загрузка не потеряна.
    const early = await app.inject({ method: 'POST', url: `/api/uploads/${uploadId}/complete`, headers: { cookie } });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('UPLOAD_INCOMPLETE');

    const state = await app.inject({ method: 'GET', url: `/api/uploads/${uploadId}`, headers: { cookie } });
    expect(state.json().missingChunks).toEqual([skipped]);

    // Догружаем недостающую часть и повторяем уже принятую — обе операции безопасны.
    for (const index of [skipped, 0]) {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/uploads/${uploadId}/chunks/${index}`,
        headers: { cookie, 'content-type': 'application/octet-stream' },
        payload: pdf.subarray(index * chunkSize, Math.min((index + 1) * chunkSize, pdf.length)),
      });
      expect(res.statusCode).toBe(200);
    }

    const complete = await app.inject({ method: 'POST', url: `/api/uploads/${uploadId}/complete`, headers: { cookie } });
    expect(complete.statusCode).toBe(200);
    // Двойная отправка части не раздула размер.
    expect(complete.json().size).toBe(pdf.length);
  });
});

describe('5. повторное нажатие не создаёт две сметы', () => {
  it('тот же ключ идемпотентности возвращает ту же задачу', async () => {
    const uploadId = await uploadFile(makeTestPdf(PDF_SIZE));

    const first = await startJob([uploadId], 'одно-нажатие');
    const second = await startJob([uploadId], 'одно-нажатие');

    expect(second.json().jobId).toBe(first.json().jobId);
    expect(second.json().deduplicated).toBe(true);

    const jobs = db.prepare('SELECT COUNT(*) AS c FROM jobs').get() as { c: number };
    const projects = db.prepare('SELECT COUNT(*) AS c FROM projects').get() as { c: number };
    expect(jobs.c).toBe(1);
    // Проект-сирота тоже не создан.
    expect(projects.c).toBe(1);

    await runWorkerUntilDone(first.json().jobId);
    const estimates = db.prepare('SELECT COUNT(*) AS c FROM estimates').get() as { c: number };
    expect(estimates.c).toBe(1);
  });
});

describe('6. ошибка этапа понятна и допускает безопасный повтор', () => {
  it('недоступность ИИ показывается отдельным кодом и повторяется', async () => {
    const uploadId = await uploadFile(makeTestPdf(PDF_SIZE));
    const { jobId } = (await startJob([uploadId])).json();

    let attempt = 0;
    provider.behaviour = async () => {
      attempt += 1;
      // Первые две попытки — сервис недоступен, третья успешна.
      if (attempt < 3) throw new AppError('AI_UNAVAILABLE');
      return defaultOutcome();
    };

    await runWorkerUntilDone(jobId);

    const status = await app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers: { cookie } });
    // Задача сама пережила две временные ошибки и дошла до результата.
    expect(status.json().status).toBe('completed');
    expect(attempt).toBe(3);
  });

  it('неповторяемая ошибка завершает задачу понятным сообщением без stack trace', async () => {
    const uploadId = await uploadFile(makeTestPdf(PDF_SIZE));
    const { jobId } = (await startJob([uploadId])).json();

    provider.behaviour = async () => {
      throw new AppError('PDF_PASSWORD_PROTECTED');
    };

    await runWorkerUntilDone(jobId);

    const status = (await app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers: { cookie } })).json();
    expect(status.status).toBe('failed');
    expect(status.error.code).toBe('PDF_PASSWORD_PROTECTED');
    expect(status.error.message).toContain('паролем');
    // Наружу не утекают ни stack, ни внутренние подробности.
    expect(JSON.stringify(status)).not.toMatch(/at .*\(.*:\d+:\d+\)/);

    // Безопасный повтор возвращает задачу в очередь, не создавая вторую смету.
    provider.behaviour = async () => defaultOutcome();
    const retry = await app.inject({ method: 'POST', url: `/api/jobs/${jobId}/retry`, headers: { cookie } });
    expect(retry.json().status).toBe('queued');

    await runWorkerUntilDone(jobId);
    expect((db.prepare('SELECT COUNT(*) AS c FROM estimates').get() as { c: number }).c).toBe(1);
  });

  it('несуществующий маршрут API отдаёт JSON, а не HTML', async () => {
    // Именно HTML на месте JSON давал пользователю «Unexpected token '<'».
    const res = await app.inject({ method: 'GET', url: '/api/такого-нет', headers: { cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

describe('7. классификация документа', () => {
  it('только планировка помечается предварительной сметой', async () => {
    const uploadId = await uploadFile(makeTestPdf(PDF_SIZE));
    const { jobId } = (await startJob([uploadId])).json();

    provider.behaviour = async () =>
      defaultOutcome({
        documentType: 'layout_only',
        completenessNote: 'Только геометрия помещения.',
        facts: [
          {
            code: 'W-PLASTER',
            documentWording: 'Стены',
            quantity: 100,
            unit: 'м2',
            confidence: 'derived',
            source: { file: 'план.pdf', page: 1, ref: 'План' },
            basis: 'Периметр × высота',
          },
        ],
      });

    await runWorkerUntilDone(jobId);

    const estimateId = (await app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers: { cookie } })).json()
      .estimateId;
    const estimate = (
      await app.inject({ method: 'GET', url: `/api/estimates/${estimateId}`, headers: { cookie } })
    ).json();

    expect(estimate.estimate.documentType).toBe('layout_only');
    expect(estimate.estimate.isPreliminary).toBe(true);
  });

  it('полный проект даёт непредварительную смету', async () => {
    const uploadId = await uploadFile(makeTestPdf(PDF_SIZE));
    const { jobId } = (await startJob([uploadId])).json();
    await runWorkerUntilDone(jobId);

    const estimateId = (await app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers: { cookie } })).json()
      .estimateId;
    const estimate = (
      await app.inject({ method: 'GET', url: `/api/estimates/${estimateId}`, headers: { cookie } })
    ).json();

    expect(estimate.estimate.documentType).toBe('full_project');
    expect(estimate.estimate.isPreliminary).toBe(false);
  });
});

describe('8-9. содержимое сметы', () => {
  it('неизвестные объёмы не попадают в итог, а показаны отдельно', async () => {
    const uploadId = await uploadFile(makeTestPdf(PDF_SIZE));
    const { jobId } = (await startJob([uploadId])).json();
    await runWorkerUntilDone(jobId);

    const estimateId = (await app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers: { cookie } })).json()
      .estimateId;
    const body = (await app.inject({ method: 'GET', url: `/api/estimates/${estimateId}`, headers: { cookie } })).json();

    // Розетки объявлены неизвестными — строки для них нет.
    expect(body.lines.some((l: { code: string }) => l.code === 'W-SOCKET')).toBe(false);
    const excluded = body.notes.filter((n: { kind: string }) => n.kind === 'excluded');
    expect(excluded.some((n: { title: string }) => n.title.includes('розеток'))).toBe(true);

    // Итог — ровно сумма показанных строк.
    const sum = body.lines.reduce((acc: number, l: { amountKopecks: number }) => acc + l.amountKopecks, 0);
    expect(body.estimate.totalKopecks).toBe(sum);
    // 120 × 450,00 + 50 × 500,00 = 54 000 + 25 000 = 79 000,00 ₽
    expect(body.estimate.totalKopecks).toBe(7_900_000);
  });

  it('каждая денежная строка соответствует позиции активного прайса', async () => {
    const uploadId = await uploadFile(makeTestPdf(PDF_SIZE));
    const { jobId } = (await startJob([uploadId])).json();
    await runWorkerUntilDone(jobId);

    const estimateId = (await app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers: { cookie } })).json()
      .estimateId;
    const body = (await app.inject({ method: 'GET', url: `/api/estimates/${estimateId}`, headers: { cookie } })).json();

    for (const line of body.lines) {
      const item = PRICE_ROWS.find((r) => r.code === line.code)!;
      expect(item).toBeTruthy();
      expect(line.priceKopecks).toBe(item.priceKopecks);
      expect(line.unit).toBe(item.unit);
      expect(line.amountKopecks).toBe(Math.round(line.quantity * item.priceKopecks));
    }

    expect(body.estimate.priceListLabel).toContain('05.08.2026');
    // Цена за м² — производная: 79 000,00 / 50 = 1 580,00 ₽
    expect(body.estimate.pricePerM2Kopecks).toBe(158_000);
  });

  it('источник и достоверность видны в каждой строке', async () => {
    const uploadId = await uploadFile(makeTestPdf(PDF_SIZE));
    const { jobId } = (await startJob([uploadId])).json();
    await runWorkerUntilDone(jobId);

    const estimateId = (await app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers: { cookie } })).json()
      .estimateId;
    const body = (await app.inject({ method: 'GET', url: `/api/estimates/${estimateId}`, headers: { cookie } })).json();

    const plaster = body.lines.find((l: { code: string }) => l.code === 'W-PLASTER');
    expect(plaster.confidence).toBe('confirmed');
    expect(plaster.source.page).toBe(4);
    expect(plaster.source.ref).toContain('Ведомость');
  });
});

describe('10-11. защита цены и ручные правки', () => {
  it('присланная клиентом цена игнорируется — берётся серверная', async () => {
    const uploadId = await uploadFile(makeTestPdf(PDF_SIZE));
    const { jobId } = (await startJob([uploadId])).json();
    await runWorkerUntilDone(jobId);

    const estimateId = (await app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers: { cookie } })).json()
      .estimateId;
    const before = (await app.inject({ method: 'GET', url: `/api/estimates/${estimateId}`, headers: { cookie } })).json();
    const line = before.lines[0];

    // Пытаемся протащить свою цену и сумму вместе с правкой объёма.
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/estimates/${estimateId}/lines/${line.id}`,
      headers: { cookie },
      payload: { quantity: 10, priceKopecks: 1, amountKopecks: 1, price: 1 },
    });

    expect(res.statusCode).toBe(200);
    // Цена осталась прайсовой, сумма пересчитана сервером.
    expect(res.json().line.priceKopecks).toBe(45000);
    expect(res.json().line.amountKopecks).toBe(450_000);
  });

  it('ручная правка помечается и снимает статус «подтверждено проектом»', async () => {
    const uploadId = await uploadFile(makeTestPdf(PDF_SIZE));
    const { jobId } = (await startJob([uploadId])).json();
    await runWorkerUntilDone(jobId);

    const estimateId = (await app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers: { cookie } })).json()
      .estimateId;
    const before = (await app.inject({ method: 'GET', url: `/api/estimates/${estimateId}`, headers: { cookie } })).json();
    const line = before.lines.find((l: { code: string }) => l.code === 'W-PLASTER');
    expect(line.confidence).toBe('confirmed');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/estimates/${estimateId}/lines/${line.id}`,
      headers: { cookie },
      payload: { quantity: 130 },
    });

    expect(res.json().line.isManual).toBe(true);
    expect(res.json().line.confidence).toBe('assumption');
    // Итог пересчитан: 130 × 450 + 50 × 500 = 58 500 + 25 000 = 83 500,00 ₽
    expect(res.json().totalKopecks).toBe(8_350_000);
  });

  it('ручное добавление работы берёт цену из прайса', async () => {
    const uploadId = await uploadFile(makeTestPdf(PDF_SIZE));
    const { jobId } = (await startJob([uploadId])).json();
    await runWorkerUntilDone(jobId);

    const estimateId = (await app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers: { cookie } })).json()
      .estimateId;

    const res = await app.inject({
      method: 'POST',
      url: `/api/estimates/${estimateId}/lines`,
      headers: { cookie },
      payload: { code: 'W-SOCKET', quantity: 24, priceKopecks: 1 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().line.priceKopecks).toBe(35000);
    expect(res.json().line.amountKopecks).toBe(840_000);
    expect(res.json().line.isManual).toBe(true);
    expect(res.json().line.confidence).toBe('assumption');
  });

  it('работы вне активного прайса добавить нельзя', async () => {
    const uploadId = await uploadFile(makeTestPdf(PDF_SIZE));
    const { jobId } = (await startJob([uploadId])).json();
    await runWorkerUntilDone(jobId);

    const estimateId = (await app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers: { cookie } })).json()
      .estimateId;

    const res = await app.inject({
      method: 'POST',
      url: `/api/estimates/${estimateId}/lines`,
      headers: { cookie },
      payload: { code: 'ВЫДУМАННЫЙ-КОД', quantity: 1 },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('PRICE_ITEM_UNKNOWN');
  });
});

describe('12. проект сохраняется и восстанавливается из истории', () => {
  it('проект, смета и журнал изменений доступны после расчёта', async () => {
    const uploadId = await uploadFile(makeTestPdf(PDF_SIZE));
    const { jobId, projectId } = (await startJob([uploadId])).json();
    await runWorkerUntilDone(jobId);

    const estimateId = (await app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers: { cookie } })).json()
      .estimateId;
    await app.inject({
      method: 'POST',
      url: `/api/estimates/${estimateId}/lines`,
      headers: { cookie },
      payload: { code: 'W-SOCKET', quantity: 10 },
    });

    const list = (await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie } })).json();
    expect(list.projects).toHaveLength(1);
    expect(list.projects[0].latestEstimate.id).toBe(estimateId);

    const detail = (await app.inject({ method: 'GET', url: `/api/projects/${projectId}`, headers: { cookie } })).json();
    expect(detail.project.name).toBe('Квартира на Ленина');
    expect(detail.estimates).toHaveLength(1);

    const actions = detail.history.map((h: { action: string }) => h.action);
    expect(actions).toContain('estimate_created');
    expect(actions).toContain('line_added_manually');
  });

  it('чужой проект недоступен', async () => {
    const uploadId = await uploadFile(makeTestPdf(PDF_SIZE));
    const { projectId } = (await startJob([uploadId])).json();

    // Второй пользователь.
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { cookie },
      payload: { email: 'other@kapsula.test', password: 'другой-надёжный-пароль-2' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'other@kapsula.test', password: 'другой-надёжный-пароль-2' },
    });
    const otherCookie = extractCookie(login.headers['set-cookie']);

    const res = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}`,
      headers: { cookie: otherCookie },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('13. экспорт .xlsx открывается и совпадает с итогом интерфейса', () => {
  it('файл читается Excel-библиотекой, суммы совпадают', async () => {
    const uploadId = await uploadFile(makeTestPdf(PDF_SIZE));
    const { jobId } = (await startJob([uploadId])).json();
    await runWorkerUntilDone(jobId);

    const estimateId = (await app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers: { cookie } })).json()
      .estimateId;
    const ui = (await app.inject({ method: 'GET', url: `/api/estimates/${estimateId}`, headers: { cookie } })).json();

    const res = await app.inject({
      method: 'GET',
      url: `/api/estimates/${estimateId}/export.xlsx`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');

    // Файл действительно открывается как .xlsx.
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.rawPayload as unknown as ArrayBuffer);

    const sheet = workbook.getWorksheet('Смета');
    expect(sheet).toBeTruthy();
    expect(workbook.getWorksheet('Допущения и пропуски')).toBeTruthy();

    // Объёмы и цены выгружены числами, а суммы — формулами.
    const rows: Array<{ qty: number; price: number; formula: string }> = [];
    sheet!.eachRow((row) => {
      const qty = row.getCell(6).value;
      const price = row.getCell(7).value;
      const amount = row.getCell(8).value;
      if (typeof qty === 'number' && typeof price === 'number' && amount && typeof amount === 'object' && 'formula' in amount) {
        rows.push({ qty, price, formula: (amount as { formula: string }).formula });
      }
    });

    expect(rows).toHaveLength(ui.lines.length);
    rows.forEach((row, index) => {
      const uiLine = ui.lines[index];
      expect(row.qty).toBe(uiLine.quantity);
      expect(row.price).toBe(kopecksToRubles(uiLine.priceKopecks));
      // Сумма — формула «объём × цена», а не записанное число.
      expect(row.formula).toMatch(/^F\d+\*G\d+$/);
    });

    // Итог вычисляется формулой SUM по тем же строкам.
    const computed = rows.reduce((acc, r) => acc + Math.round(r.qty * r.price * 100), 0);
    expect(computed).toBe(ui.estimate.totalKopecks);
  });
});

describe('наблюдаемость: тайминги этапов', () => {
  it('журнал этапов содержит длительности', async () => {
    const uploadId = await uploadFile(makeTestPdf(PDF_SIZE));
    const { jobId } = (await startJob([uploadId])).json();
    await runWorkerUntilDone(jobId);

    const status = (await app.inject({ method: 'GET', url: `/api/jobs/${jobId}`, headers: { cookie } })).json();
    const statuses = status.timeline.map((t: { status: string }) => t.status);

    expect(statuses).toContain('queued');
    expect(statuses).toContain('extracting');
    expect(statuses).toContain('validating');
    expect(statuses).toContain('calculating');
    expect(statuses).toContain('completed');
    // У завершённых этапов есть измеренная длительность.
    expect(status.timeline.filter((t: { durationMs: number | null }) => t.durationMs !== null).length).toBeGreaterThan(0);
  });
});
