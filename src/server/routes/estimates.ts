import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../shared/errors.js';
import { requireUser } from '../auth.js';
import { newId } from '../../shared/crypto.js';
import { fromMilliQty, lineAmount, pricePerSquareMeter, sumKopecks, toMilliQty } from '../../shared/money.js';
import {
  getEstimateForUser,
  recordHistory,
  toCalculatedLines,
  type EstimateLineRow,
} from '../../domain/estimate/repository.js';
import { getPriceItemsByCode, verifyAgainstPriceList } from '../../domain/estimate/calculate.js';
import { buildEstimateWorkbook } from '../../domain/estimate/export-xlsx.js';
import type { Db } from '../../db/index.js';

const CONFIDENCE_LABELS: Record<string, string> = {
  confirmed: 'Подтверждён документом',
  derived: 'Рассчитан из подтверждённой геометрии',
  assumption: 'Предварительное допущение',
};

const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  full_project: 'Полный проект',
  partial_project: 'Частичный проект',
  layout_only: 'Только планировка',
};

/**
 * Пересчитывает итог сметы после ручной правки.
 * Итог всегда получается сложением уже округлённых сумм строк,
 * поэтому он совпадает с тем, что видит пользователь и что уходит в Excel.
 */
function recalcTotals(db: Db, estimateId: string): void {
  const lines = db
    .prepare('SELECT amount_kopecks FROM estimate_lines WHERE estimate_id = ?')
    .all(estimateId) as Array<{ amount_kopecks: number }>;

  const total = sumKopecks(lines.map((l) => l.amount_kopecks));
  const estimate = db
    .prepare('SELECT area_milli FROM estimates WHERE id = ?')
    .get(estimateId) as { area_milli: number | null };

  const perM2 =
    estimate.area_milli && estimate.area_milli > 0
      ? pricePerSquareMeter(total, estimate.area_milli)
      : null;

  db.prepare('UPDATE estimates SET total_kopecks = ?, price_per_m2_kopecks = ? WHERE id = ?').run(
    total,
    perM2,
    estimateId,
  );
}

function serializeLine(line: EstimateLineRow) {
  return {
    id: line.id,
    position: line.position,
    code: line.code,
    section: line.section,
    sectionNo: line.section_no,
    name: line.name,
    unit: line.unit,
    quantity: fromMilliQty(line.quantity_milli),
    priceKopecks: line.price_kopecks,
    amountKopecks: line.amount_kopecks,
    confidence: line.confidence,
    confidenceLabel: CONFIDENCE_LABELS[line.confidence] ?? line.confidence,
    isManual: line.is_manual === 1,
    source: {
      fileId: line.source_file_id,
      page: line.source_page,
      ref: line.source_ref,
    },
    note: line.note,
  };
}

export async function registerEstimateRoutes(app: FastifyInstance): Promise<void> {
  const { db } = app.ctx;

  app.get<{ Params: { id: string } }>('/api/estimates/:id', async (request) => {
    const user = requireUser(request);
    const { estimate, lines, notes } = getEstimateForUser(db, request.params.id, user.id);

    const project = db
      .prepare('SELECT name FROM projects WHERE id = ?')
      .get(estimate.project_id) as { name: string } | undefined;

    const files = estimate.job_id
      ? (db
          .prepare('SELECT id, filename, page_count FROM job_files WHERE job_id = ? ORDER BY position')
          .all(estimate.job_id) as Array<{ id: string; filename: string; page_count: number | null }>)
      : [];

    return {
      estimate: {
        id: estimate.id,
        projectId: estimate.project_id,
        projectName: project?.name ?? '',
        revision: estimate.revision,
        documentType: estimate.document_type,
        documentTypeLabel: DOCUMENT_TYPE_LABELS[estimate.document_type] ?? estimate.document_type,
        isPreliminary: estimate.is_preliminary === 1,
        priceListLabel: estimate.price_list_label,
        priceListVersionId: estimate.price_list_version_id,
        areaM2: estimate.area_milli === null ? null : fromMilliQty(estimate.area_milli),
        totalKopecks: estimate.total_kopecks,
        pricePerM2Kopecks: estimate.price_per_m2_kopecks,
        createdAt: estimate.created_at,
      },
      files: files.map((f) => ({ id: f.id, filename: f.filename, pageCount: f.page_count })),
      lines: lines.map(serializeLine),
      notes: notes.map((n) => ({
        id: n.id,
        kind: n.kind,
        severity: n.severity,
        title: n.title,
        detail: n.detail,
      })),
    };
  });

  /**
   * Ручная правка объёма.
   * Цена берётся из прайса заново — прислать её клиент не может.
   * Строка помечается ручной и теряет статус «подтверждено проектом».
   */
  app.patch<{ Params: { id: string; lineId: string } }>(
    '/api/estimates/:id/lines/:lineId',
    async (request) => {
      const user = requireUser(request);
      const body = z.object({ quantity: z.number().finite().positive().max(1_000_000) }).safeParse(request.body);
      if (!body.success) throw new AppError('VALIDATION_FAILED', { field: 'quantity' });

      const { estimate } = getEstimateForUser(db, request.params.id, user.id);
      const line = db
        .prepare('SELECT * FROM estimate_lines WHERE id = ? AND estimate_id = ?')
        .get(request.params.lineId, estimate.id) as EstimateLineRow | undefined;
      if (!line) throw new AppError('NOT_FOUND');

      const item = getPriceItemsByCode(db, estimate.price_list_version_id, [line.code]).get(line.code);
      if (!item) throw new AppError('PRICE_ITEM_UNKNOWN', { code: line.code });

      const quantityMilli = toMilliQty(body.data.quantity);
      const amount = lineAmount(quantityMilli, item.price_kopecks);
      const previousQuantity = fromMilliQty(line.quantity_milli);

      db.transaction(() => {
        db.prepare(
          `UPDATE estimate_lines
              SET quantity_milli = ?, price_kopecks = ?, amount_kopecks = ?,
                  is_manual = 1,
                  confidence = CASE WHEN confidence = 'confirmed' THEN 'assumption' ELSE confidence END
            WHERE id = ?`,
        ).run(quantityMilli, item.price_kopecks, amount, line.id);

        recalcTotals(db, estimate.id);
        recordHistory(db, {
          projectId: estimate.project_id,
          estimateId: estimate.id,
          userId: user.id,
          action: 'line_quantity_edited',
          payload: {
            code: line.code,
            name: line.name,
            from: previousQuantity,
            to: body.data.quantity,
          },
        });
      })();

      const updated = db.prepare('SELECT * FROM estimate_lines WHERE id = ?').get(line.id) as EstimateLineRow;
      const total = db.prepare('SELECT total_kopecks, price_per_m2_kopecks FROM estimates WHERE id = ?').get(
        estimate.id,
      ) as { total_kopecks: number; price_per_m2_kopecks: number | null };

      return {
        line: serializeLine(updated),
        totalKopecks: total.total_kopecks,
        pricePerM2Kopecks: total.price_per_m2_kopecks,
      };
    },
  );

  /** Ручное добавление работы из прайса. Цена — только серверная. */
  app.post<{ Params: { id: string } }>('/api/estimates/:id/lines', async (request) => {
    const user = requireUser(request);
    const body = z
      .object({
        code: z.string().min(1).max(64),
        quantity: z.number().finite().positive().max(1_000_000),
        note: z.string().max(500).nullable().optional(),
      })
      .safeParse(request.body);
    if (!body.success) throw new AppError('VALIDATION_FAILED');

    const { estimate } = getEstimateForUser(db, request.params.id, user.id);
    const item = getPriceItemsByCode(db, estimate.price_list_version_id, [body.data.code]).get(body.data.code);
    if (!item) throw new AppError('PRICE_ITEM_UNKNOWN', { code: body.data.code });

    const quantityMilli = toMilliQty(body.data.quantity);
    const lineId = newId('lin');

    db.transaction(() => {
      const maxPosition = db
        .prepare('SELECT COALESCE(MAX(position), 0) AS p FROM estimate_lines WHERE estimate_id = ?')
        .get(estimate.id) as { p: number };

      db.prepare(
        `INSERT INTO estimate_lines (
           id, estimate_id, position, price_item_id, code, section_no, section, name, unit,
           quantity_milli, price_kopecks, amount_kopecks, confidence, is_manual,
           source_file_id, source_page, source_ref, note
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'assumption', 1, NULL, NULL, NULL, ?)`,
      ).run(
        lineId,
        estimate.id,
        maxPosition.p + 1,
        item.id,
        item.code,
        item.section_no,
        item.section,
        item.name,
        item.unit,
        quantityMilli,
        item.price_kopecks,
        lineAmount(quantityMilli, item.price_kopecks),
        body.data.note ?? null,
      );

      recalcTotals(db, estimate.id);
      recordHistory(db, {
        projectId: estimate.project_id,
        estimateId: estimate.id,
        userId: user.id,
        action: 'line_added_manually',
        payload: { code: item.code, name: item.name, quantity: body.data.quantity },
      });
    })();

    const created = db.prepare('SELECT * FROM estimate_lines WHERE id = ?').get(lineId) as EstimateLineRow;
    return { line: serializeLine(created) };
  });

  app.delete<{ Params: { id: string; lineId: string } }>(
    '/api/estimates/:id/lines/:lineId',
    async (request) => {
      const user = requireUser(request);
      const { estimate } = getEstimateForUser(db, request.params.id, user.id);
      const line = db
        .prepare('SELECT * FROM estimate_lines WHERE id = ? AND estimate_id = ?')
        .get(request.params.lineId, estimate.id) as EstimateLineRow | undefined;
      if (!line) throw new AppError('NOT_FOUND');

      db.transaction(() => {
        db.prepare('DELETE FROM estimate_lines WHERE id = ?').run(line.id);
        recalcTotals(db, estimate.id);
        recordHistory(db, {
          projectId: estimate.project_id,
          estimateId: estimate.id,
          userId: user.id,
          action: 'line_removed',
          payload: { code: line.code, name: line.name },
        });
      })();

      const total = db
        .prepare('SELECT total_kopecks, price_per_m2_kopecks FROM estimates WHERE id = ?')
        .get(estimate.id) as { total_kopecks: number; price_per_m2_kopecks: number | null };

      return { ok: true, totalKopecks: total.total_kopecks, pricePerM2Kopecks: total.price_per_m2_kopecks };
    },
  );

  /**
   * Экспорт в .xlsx.
   * Перед выгрузкой смета заново сверяется с прайсом: файл не должен
   * разойтись с активными расценками.
   */
  app.get<{ Params: { id: string } }>('/api/estimates/:id/export.xlsx', async (request, reply) => {
    const user = requireUser(request);
    const { estimate, lines, notes } = getEstimateForUser(db, request.params.id, user.id);

    const verification = verifyAgainstPriceList(db, estimate.price_list_version_id, toCalculatedLines(lines));
    if (!verification.ok) {
      throw new AppError('CALCULATION_FAILED', { problems: verification.problems.slice(0, 20) });
    }

    const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(estimate.project_id) as
      | { name: string }
      | undefined;

    const files = estimate.job_id
      ? (db.prepare('SELECT filename FROM job_files WHERE job_id = ? ORDER BY position').all(estimate.job_id) as Array<{
          filename: string;
        }>)
      : [];

    const buffer = await buildEstimateWorkbook({
      estimate,
      lines,
      notes,
      projectName: project?.name ?? 'Объект',
      fileNames: files.map((f) => f.filename),
    });

    const safeName = (project?.name ?? 'smeta').replace(/[^\p{L}\p{N}\-_ ]/gu, '').trim() || 'smeta';
    const filename = `Смета_${safeName}_ред${estimate.revision}.xlsx`;

    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      )
      .send(buffer);
  });
}
