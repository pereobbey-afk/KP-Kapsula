import type { Db } from '../../db/index.js';
import { newId } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
import type { CalculatedEstimate, CalculatedLine, EstimateNoteDraft } from './calculate.js';
import { verifyAgainstPriceList } from './calculate.js';

/** Сохранение и чтение смет. */

export type SaveEstimateInput = {
  projectId: string;
  jobId: string | null;
  userId: string;
  estimate: CalculatedEstimate;
  extraNotes?: readonly EstimateNoteDraft[];
};

/**
 * Сохраняет смету.
 *
 * Перед записью выполняется повторная сверка с прайсом. Если хотя бы одна
 * строка разошлась с активной версией, сохранение отменяется целиком —
 * лучше отсутствие сметы, чем смета с неверной ценой.
 */
export function saveEstimate(db: Db, input: SaveEstimateInput): string {
  const { estimate } = input;

  const verification = verifyAgainstPriceList(db, estimate.priceListVersionId, estimate.lines);
  if (!verification.ok) {
    throw new AppError('CALCULATION_FAILED', { problems: verification.problems.slice(0, 20) });
  }

  const estimateId = newId('est');
  const now = Date.now();

  const previousRevision = db
    .prepare('SELECT MAX(revision) AS r FROM estimates WHERE project_id = ?')
    .get(input.projectId) as { r: number | null } | undefined;
  const revision = (previousRevision?.r ?? 0) + 1;

  const notes = [...estimate.notes, ...(input.extraNotes ?? [])];

  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO estimates (
         id, project_id, job_id, user_id, price_list_version_id, price_list_label,
         document_type, completeness, is_preliminary, area_milli,
         total_kopecks, price_per_m2_kopecks, revision, created_at
       ) VALUES (
         @id, @projectId, @jobId, @userId, @versionId, @label,
         @documentType, @completeness, @isPreliminary, @areaMilli,
         @total, @perM2, @revision, @now
       )`,
    ).run({
      id: estimateId,
      projectId: input.projectId,
      jobId: input.jobId,
      userId: input.userId,
      versionId: estimate.priceListVersionId,
      label: estimate.priceListLabel,
      documentType: estimate.documentType,
      completeness: estimate.isPreliminary ? 'preliminary' : 'detailed',
      isPreliminary: estimate.isPreliminary ? 1 : 0,
      areaMilli: estimate.areaMilli,
      total: estimate.totalKopecks,
      perM2: estimate.pricePerM2Kopecks,
      revision,
      now,
    });

    const insertLine = db.prepare(
      `INSERT INTO estimate_lines (
         id, estimate_id, position, price_item_id, code, section_no, section, name, unit,
         quantity_milli, price_kopecks, amount_kopecks, confidence, is_manual,
         source_file_id, source_page, source_ref, note
       ) VALUES (
         @id, @estimateId, @position, @priceItemId, @code, @sectionNo, @section, @name, @unit,
         @quantityMilli, @priceKopecks, @amountKopecks, @confidence, @isManual,
         @sourceFileId, @sourcePage, @sourceRef, @note
       )`,
    );

    for (const line of estimate.lines) {
      insertLine.run({
        id: newId('lin'),
        estimateId,
        position: line.position,
        priceItemId: line.priceItemId,
        code: line.code,
        sectionNo: line.sectionNo,
        section: line.section,
        name: line.name,
        unit: line.unit,
        quantityMilli: line.quantityMilli,
        priceKopecks: line.priceKopecks,
        amountKopecks: line.amountKopecks,
        confidence: line.confidence,
        isManual: line.isManual ? 1 : 0,
        sourceFileId: line.source.fileId ?? null,
        sourcePage: line.source.page ?? null,
        sourceRef: line.source.ref ?? null,
        note: line.note,
      });
    }

    const insertNote = db.prepare(
      `INSERT INTO estimate_notes (id, estimate_id, kind, severity, title, detail, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    notes.forEach((note, index) => {
      insertNote.run(newId('nte'), estimateId, note.kind, note.severity, note.title, note.detail ?? null, index);
    });

    db.prepare(
      `INSERT INTO project_history (project_id, estimate_id, user_id, action, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.projectId,
      estimateId,
      input.userId,
      'estimate_created',
      JSON.stringify({
        revision,
        totalKopecks: estimate.totalKopecks,
        lines: estimate.lines.length,
        documentType: estimate.documentType,
        priceList: estimate.priceListLabel,
      }),
      now,
    );

    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, input.projectId);
  });

  run();
  return estimateId;
}

export type EstimateRow = {
  id: string;
  project_id: string;
  job_id: string | null;
  user_id: string;
  price_list_version_id: string;
  price_list_label: string;
  document_type: string;
  completeness: string;
  is_preliminary: number;
  area_milli: number | null;
  total_kopecks: number;
  price_per_m2_kopecks: number | null;
  revision: number;
  created_at: number;
};

export type EstimateLineRow = {
  id: string;
  estimate_id: string;
  position: number;
  price_item_id: string;
  code: string;
  section_no: number | null;
  section: string;
  name: string;
  unit: string;
  quantity_milli: number;
  price_kopecks: number;
  amount_kopecks: number;
  confidence: string;
  is_manual: number;
  source_file_id: string | null;
  source_page: number | null;
  source_ref: string | null;
  note: string | null;
};

export type EstimateNoteRow = {
  id: string;
  estimate_id: string;
  kind: string;
  severity: string;
  title: string;
  detail: string | null;
  position: number;
};

export type FullEstimate = {
  estimate: EstimateRow;
  lines: EstimateLineRow[];
  notes: EstimateNoteRow[];
};

export function getEstimate(db: Db, estimateId: string): FullEstimate | null {
  const estimate = db.prepare('SELECT * FROM estimates WHERE id = ?').get(estimateId) as
    | EstimateRow
    | undefined;
  if (!estimate) return null;

  return {
    estimate,
    lines: db
      .prepare('SELECT * FROM estimate_lines WHERE estimate_id = ? ORDER BY position')
      .all(estimateId) as EstimateLineRow[],
    notes: db
      .prepare('SELECT * FROM estimate_notes WHERE estimate_id = ? ORDER BY position')
      .all(estimateId) as EstimateNoteRow[],
  };
}

/** Доступ по владельцу. Чужую смету перебором идентификатора не получить. */
export function getEstimateForUser(db: Db, estimateId: string, userId: string): FullEstimate {
  const full = getEstimate(db, estimateId);
  if (!full || full.estimate.user_id !== userId) throw new AppError('NOT_FOUND');
  return full;
}

export function listProjectEstimates(db: Db, projectId: string): EstimateRow[] {
  return db
    .prepare('SELECT * FROM estimates WHERE project_id = ? ORDER BY revision DESC')
    .all(projectId) as EstimateRow[];
}

export type HistoryRow = {
  id: number;
  project_id: string;
  estimate_id: string | null;
  user_id: string | null;
  action: string;
  payload_json: string | null;
  created_at: number;
};

export function listProjectHistory(db: Db, projectId: string): HistoryRow[] {
  return db
    .prepare('SELECT * FROM project_history WHERE project_id = ? ORDER BY id DESC LIMIT 200')
    .all(projectId) as HistoryRow[];
}

export function recordHistory(
  db: Db,
  input: {
    projectId: string;
    estimateId?: string | null;
    userId?: string | null;
    action: string;
    payload?: unknown;
  },
): void {
  db.prepare(
    `INSERT INTO project_history (project_id, estimate_id, user_id, action, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.projectId,
    input.estimateId ?? null,
    input.userId ?? null,
    input.action,
    input.payload === undefined ? null : JSON.stringify(input.payload),
    Date.now(),
  );
}

/** Строки сметы в форме, пригодной для пересчёта. */
export function toCalculatedLines(rows: readonly EstimateLineRow[]): CalculatedLine[] {
  return rows.map((r) => ({
    position: r.position,
    priceItemId: r.price_item_id,
    code: r.code,
    section: r.section,
    sectionNo: r.section_no,
    name: r.name,
    unit: r.unit,
    quantityMilli: r.quantity_milli,
    priceKopecks: r.price_kopecks,
    amountKopecks: r.amount_kopecks,
    confidence: r.confidence as CalculatedLine['confidence'],
    isManual: r.is_manual === 1,
    source: { fileId: r.source_file_id, page: r.source_page, ref: r.source_ref },
    note: r.note,
  }));
}
