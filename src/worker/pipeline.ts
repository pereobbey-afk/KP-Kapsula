import fs from 'node:fs/promises';
import type { Db } from '../db/index.js';
import type { AppConfig } from '../shared/config.js';
import { AppError, toAppError } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';
import { toMilliQty } from '../shared/money.js';
import {
  calculateEstimate,
  getActivePriceListVersion,
  type DocumentType,
  type EstimateNoteDraft,
  type VolumeClaim,
} from '../domain/estimate/calculate.js';
import { checkCompleteness } from '../domain/estimate/completeness.js';
import { saveEstimate } from '../domain/estimate/repository.js';
import type { ExtractionProvider, ExtractionDocument } from '../domain/extraction/provider.js';
import type { ExtractionResult } from '../domain/extraction/schema.js';
import { normalizeUnit } from '../domain/pricelist/normalize.js';
import { estimatePdfPageCount, looksLikeCompletePdf } from '../domain/files/validate.js';
import { completeJob, failJob, heartbeat, setStage, type JobRow } from '../jobs/queue.js';
import { newId } from '../shared/crypto.js';

/**
 * Конвейер расчёта.
 *
 * Каждый этап делает настоящую работу, а не рисует прогресс:
 *  classifying  — чтение и проверка файлов, подсчёт страниц, загрузка каталога;
 *  extracting   — обращение к модели за фактами;
 *  validating   — сверка кодов с прайсом, проверка полноты;
 *  calculating  — детерминированный расчёт и сохранение.
 *
 * Пока идёт длительный этап, аренда задачи продлевается фоновым
 * heartbeat. Если аренду отобрали, работа прерывается немедленно:
 * два воркера не должны писать один результат.
 */

export type PipelineContext = {
  db: Db;
  config: AppConfig;
  provider: ExtractionProvider;
  logger: Logger;
  workerId: string;
};

type JobFileRow = {
  id: string;
  job_id: string;
  filename: string;
  mime: string;
  size: number;
  storage_path: string;
  page_count: number | null;
  position: number;
};

type ProjectRow = {
  id: string;
  name: string;
  area_milli: number | null;
  rooms: number | null;
  initial_state: 'concrete' | 'white_box' | 'secondary' | null;
  scope_level: string | null;
};

export async function processJob(ctx: PipelineContext, job: JobRow): Promise<void> {
  const log = ctx.logger.child({ jobId: job.id, workerId: ctx.workerId, attempt: job.attempts });
  const startedAt = Date.now();

  // Продление аренды на время длительных этапов.
  const controller = new AbortController();
  const heartbeatInterval = setInterval(
    () => {
      const alive = heartbeat(ctx.db, job.id, ctx.workerId, ctx.config.jobLeaseMs);
      if (!alive) {
        log.warn('Аренда задачи потеряна, работа прерывается');
        controller.abort();
      }
    },
    Math.max(5_000, Math.floor(ctx.config.jobLeaseMs / 3)),
  );

  try {
    // ---------- Этап: классификация и подготовка ----------
    const stageClassify = Date.now();
    const project = ctx.db
      .prepare(
        'SELECT id, name, area_milli, rooms, initial_state, scope_level FROM projects WHERE id = ?',
      )
      .get(job.project_id) as ProjectRow | undefined;
    if (!project) throw new AppError('NOT_FOUND', { reason: 'проект задачи не найден' });

    const files = ctx.db
      .prepare('SELECT * FROM job_files WHERE job_id = ? ORDER BY position')
      .all(job.id) as JobFileRow[];
    if (files.length === 0) {
      throw new AppError('UPLOAD_INCOMPLETE', { reason: 'к задаче не приложено ни одного файла' });
    }

    const documents = await loadDocuments(ctx, files, log);
    const version = getActivePriceListVersion(ctx.db);
    const catalogue = ctx.db
      .prepare('SELECT code, section, name, unit FROM price_items WHERE version_id = ? ORDER BY section_no, name')
      .all(version.id) as Array<{ code: string; section: string; name: string; unit: string }>;

    if (catalogue.length === 0) throw new AppError('PRICE_LIST_MISSING');

    log.info('Этап завершён', {
      stage: 'classifying',
      durationMs: Date.now() - stageClassify,
      files: files.length,
      catalogueItems: catalogue.length,
      priceList: version.label,
    });

    // ---------- Этап: извлечение ----------
    if (!setStage(ctx.db, job.id, ctx.workerId, 'extracting', ctx.config.jobLeaseMs)) return;
    const stageExtract = Date.now();

    const outcome = await ctx.provider.extract({
      brief: {
        name: project.name,
        areaM2: project.area_milli === null ? null : project.area_milli / 1000,
        rooms: project.rooms,
        initialState: project.initial_state,
        scopeLevel: project.scope_level,
      },
      catalogue,
      documents,
      signal: controller.signal,
    });

    const extractDuration = Date.now() - stageExtract;
    log.info('Этап завершён', {
      stage: 'extracting',
      durationMs: extractDuration,
      documentType: outcome.result.documentType,
      facts: outcome.result.facts.length,
      unknowns: outcome.result.unknowns.length,
      promptInjectionSuspected: outcome.result.suspectedPromptInjection,
      usage: outcome.usage,
    });

    ctx.db
      .prepare(
        `INSERT INTO extractions (id, job_id, document_type, completeness, model, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId('ext'),
        job.id,
        outcome.result.documentType,
        outcome.result.documentType === 'full_project' ? 'detailed' : 'preliminary',
        outcome.model,
        JSON.stringify(outcome.result),
        Date.now(),
      );

    // ---------- Этап: проверка ----------
    if (!setStage(ctx.db, job.id, ctx.workerId, 'validating', ctx.config.jobLeaseMs)) return;
    const stageValidate = Date.now();

    const fileIdByName = new Map(files.map((f) => [f.filename, f.id]));
    const { claims, notes: validationNotes } = mapFactsToClaims(
      outcome.result,
      new Map(catalogue.map((c) => [c.code, c])),
      fileIdByName,
    );

    log.info('Этап завершён', {
      stage: 'validating',
      durationMs: Date.now() - stageValidate,
      acceptedClaims: claims.length,
      rejectedFacts: outcome.result.facts.length - claims.length,
    });

    // ---------- Этап: расчёт ----------
    if (!setStage(ctx.db, job.id, ctx.workerId, 'calculating', ctx.config.jobLeaseMs)) return;
    const stageCalc = Date.now();

    // Площадь: приоритет у введённой сотрудником, затем найденная в документе.
    const areaMilli =
      project.area_milli ??
      (outcome.result.detectedAreaM2 !== null ? toMilliQty(outcome.result.detectedAreaM2) : null);

    const estimate = calculateEstimate(ctx.db, {
      documentType: outcome.result.documentType as DocumentType,
      areaMilli,
      claims,
      unknowns: outcome.result.unknowns.map((u) => ({ title: u.title, detail: u.detail })),
      assumptions: [
        ...validationNotes,
        ...outcome.result.assumptions.map(
          (a): EstimateNoteDraft => ({
            kind: 'assumption',
            severity: 'info',
            title: a.title,
            detail: a.detail,
          }),
        ),
        ...buildDocumentNotes(outcome.result),
      ],
      versionId: version.id,
    });

    const completenessNotes = checkCompleteness({
      estimate,
      initialState: project.initial_state,
      hasWetZones: outcome.result.hasWetZones,
    });

    const estimateId = saveEstimate(ctx.db, {
      projectId: job.project_id,
      jobId: job.id,
      userId: job.user_id,
      estimate,
      extraNotes: completenessNotes,
    });

    log.info('Этап завершён', {
      stage: 'calculating',
      durationMs: Date.now() - stageCalc,
      lines: estimate.lines.length,
      totalKopecks: estimate.totalKopecks,
      estimateId,
    });

    if (!completeJob(ctx.db, job.id, ctx.workerId, estimateId, version.id)) {
      log.warn('Задача уже завершена другим воркером, результат не записан');
      return;
    }

    log.info('Расчёт завершён', {
      totalDurationMs: Date.now() - startedAt,
      estimateId,
      lines: estimate.lines.length,
    });
  } catch (e) {
    const err = toAppError(e);
    log.error('Расчёт не выполнен', {
      code: err.code,
      retryable: err.retryable,
      details: err.details,
      durationMs: Date.now() - startedAt,
    });
    failJob(ctx.db, job.id, ctx.workerId, err.code, err.message, err.retryable);
  } finally {
    clearInterval(heartbeatInterval);
  }
}

/** Читает файлы с диска и проверяет их целостность. */
async function loadDocuments(
  ctx: PipelineContext,
  files: readonly JobFileRow[],
  log: Logger,
): Promise<ExtractionDocument[]> {
  const documents: ExtractionDocument[] = [];

  for (const file of files) {
    let data: Buffer;
    try {
      data = await fs.readFile(file.storage_path);
    } catch (e) {
      throw new AppError('UPLOAD_INCOMPLETE', { filename: file.filename, reason: 'файл недоступен' }, e);
    }

    if (data.length !== file.size) {
      throw new AppError('UPLOAD_INCOMPLETE', {
        filename: file.filename,
        expected: file.size,
        actual: data.length,
      });
    }

    if (file.mime === 'application/pdf') {
      if (!looksLikeCompletePdf(data)) throw new AppError('PDF_CORRUPTED', { filename: file.filename });

      const pages = estimatePdfPageCount(data);
      if (pages !== null && file.page_count === null) {
        ctx.db.prepare('UPDATE job_files SET page_count = ? WHERE id = ?').run(pages, file.id);
      }
      log.debug('Файл прочитан', { filename: file.filename, bytes: data.length, pages });
    }

    documents.push({ filename: file.filename, mime: file.mime, data });
  }

  return documents;
}

/**
 * Превращает факты модели в заявки на объём.
 *
 * Здесь стоит барьер доверия: код обязан существовать в каталоге,
 * а единица измерения — совпадать с прайсовой. Несовпадение единиц
 * не «исправляется» пересчётом наугад — факт отбрасывается в примечания,
 * потому что молчаливая конвертация исказила бы смету.
 */
export function mapFactsToClaims(
  result: ExtractionResult,
  catalogue: Map<string, { code: string; name: string; unit: string }>,
  fileIdByName: Map<string, string>,
): { claims: VolumeClaim[]; notes: EstimateNoteDraft[] } {
  const claims: VolumeClaim[] = [];
  const notes: EstimateNoteDraft[] = [];

  for (const fact of result.facts) {
    const item = catalogue.get(fact.code);
    if (!item) {
      notes.push({
        kind: 'omission',
        severity: 'critical',
        title: `Работа не найдена в активном прайсе: ${fact.code}`,
        detail:
          `Извлечено из документа как «${fact.documentWording ?? fact.code}». ` +
          'В расчёт не включено.',
      });
      continue;
    }

    if (normalizeUnit(fact.unit) !== normalizeUnit(item.unit)) {
      notes.push({
        kind: 'clarification',
        severity: 'warning',
        title: `Единица измерения не совпадает: ${item.name}`,
        detail:
          `В документации объём указан в «${fact.unit}», прайс считает в «${item.unit}». ` +
          'Строка не включена в расчёт — требуется ручная проверка объёма.',
      });
      continue;
    }

    claims.push({
      code: fact.code,
      quantity: fact.quantity,
      confidence: fact.confidence,
      source: {
        fileId: fileIdByName.get(fact.source.file) ?? null,
        page: fact.source.page,
        ref: fact.source.ref,
      },
      note: fact.basis,
      isManual: false,
    });
  }

  return { claims, notes };
}

/** Примечания об уровне полноты и подозрении на инъекцию в документе. */
function buildDocumentNotes(result: ExtractionResult): EstimateNoteDraft[] {
  const notes: EstimateNoteDraft[] = [];

  if (result.completenessNote.trim()) {
    notes.push({
      kind: 'clarification',
      severity: 'info',
      title: 'Уровень полноты документации',
      detail: result.completenessNote,
    });
  }

  if (result.suspectedPromptInjection) {
    // Пользователь обязан знать, что в документе был текст,
    // пытавшийся управлять анализом.
    notes.push({
      kind: 'clarification',
      severity: 'warning',
      title: 'В документе обнаружен текст, похожий на попытку управления анализом',
      detail:
        'Такой текст обработан как обычные данные документа и не влиял на расчёт. ' +
        'Рекомендуется проверить источник документации.',
    });
  }

  return notes;
}
