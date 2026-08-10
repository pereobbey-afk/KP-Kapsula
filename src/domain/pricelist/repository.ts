import type { Db } from '../../db/index.js';
import { newId } from '../../shared/crypto.js';
import { AppError } from '../../shared/errors.js';
import { mergeEditions, type ImportReport, type PriceEdition } from './import.js';

/** Сохранение версий прайса и доступ к активной редакции. */

export type ImportPriceListInput = {
  label: string;
  effectiveDate?: string | null;
  sourceNote?: string | null;
  editions: readonly PriceEdition[];
  createdBy?: string | null;
  /** Сделать версию активной сразу после импорта. */
  activate?: boolean;
};

export type ImportPriceListResult = {
  versionId: string;
  report: ImportReport;
  activated: boolean;
};

/**
 * Импортирует версию прайса.
 *
 * Импорт атомарен: либо версия появляется целиком, либо не появляется
 * вовсе. Активная версия переключается в той же транзакции, поэтому
 * расчёт никогда не видит полузагруженный прайс.
 */
export function importPriceList(db: Db, input: ImportPriceListInput): ImportPriceListResult {
  const { items, report } = mergeEditions(input.editions);

  if (items.length === 0) {
    throw new AppError('VALIDATION_FAILED', {
      reason: 'ни одна строка прайса не принята',
      rejected: report.rejected.length,
    });
  }

  const versionId = newId('plv');
  const now = Date.now();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO price_list_versions
         (id, label, source_note, effective_date, is_active, items_count, sections_count, import_report, created_at, created_by)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    ).run(
      versionId,
      input.label,
      input.sourceNote ?? null,
      input.effectiveDate ?? null,
      report.totalItems,
      report.totalSections,
      JSON.stringify(report),
      now,
      input.createdBy ?? null,
    );

    const insert = db.prepare(
      `INSERT INTO price_items
         (id, version_id, code, section_no, section, name, unit, price_kopecks, source_edition, source_row, match_key, search_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const item of items) {
      insert.run(
        newId('pit'),
        versionId,
        item.code,
        item.sectionNo,
        item.section,
        item.name,
        item.unit,
        item.priceKopecks,
        item.sourceEdition,
        item.sourceRow,
        item.matchKey,
        item.searchText,
      );
    }

    if (input.activate) {
      db.prepare('UPDATE price_list_versions SET is_active = 0 WHERE is_active = 1').run();
      db.prepare('UPDATE price_list_versions SET is_active = 1 WHERE id = ?').run(versionId);
    }
  })();

  return { versionId, report, activated: Boolean(input.activate) };
}

export function activateVersion(db: Db, versionId: string): void {
  const exists = db.prepare('SELECT id FROM price_list_versions WHERE id = ?').get(versionId);
  if (!exists) throw new AppError('NOT_FOUND');

  db.transaction(() => {
    db.prepare('UPDATE price_list_versions SET is_active = 0 WHERE is_active = 1').run();
    db.prepare('UPDATE price_list_versions SET is_active = 1 WHERE id = ?').run(versionId);
  })();
}

export type VersionRow = {
  id: string;
  label: string;
  source_note: string | null;
  effective_date: string | null;
  is_active: number;
  items_count: number;
  sections_count: number;
  import_report: string | null;
  created_at: number;
};

export function listVersions(db: Db): VersionRow[] {
  return db.prepare('SELECT * FROM price_list_versions ORDER BY created_at DESC').all() as VersionRow[];
}

export function getActiveVersionOrNull(db: Db): VersionRow | null {
  return (
    (db.prepare('SELECT * FROM price_list_versions WHERE is_active = 1').get() as VersionRow | undefined) ??
    null
  );
}

export type PriceItemPublic = {
  code: string;
  section: string;
  sectionNo: number | null;
  name: string;
  unit: string;
  priceKopecks: number;
};

/** Поиск по активному прайсу — для ручного добавления работы в смету. */
export function searchActiveItems(db: Db, query: string, limit = 50): PriceItemPublic[] {
  const active = getActiveVersionOrNull(db);
  if (!active) throw new AppError('PRICE_LIST_MISSING');

  const trimmed = query.trim().toLowerCase();
  const rows = trimmed
    ? (db
        .prepare(
          `SELECT code, section, section_no, name, unit, price_kopecks
             FROM price_items
            WHERE version_id = ? AND (search_text LIKE ? OR code LIKE ?)
            ORDER BY section_no, name LIMIT ?`,
        )
        .all(active.id, `%${trimmed}%`, `%${trimmed}%`, limit) as Array<Record<string, never>>)
    : (db
        .prepare(
          `SELECT code, section, section_no, name, unit, price_kopecks
             FROM price_items WHERE version_id = ? ORDER BY section_no, name LIMIT ?`,
        )
        .all(active.id, limit) as Array<Record<string, never>>);

  return (
    rows as unknown as Array<{
      code: string;
      section: string;
      section_no: number | null;
      name: string;
      unit: string;
      price_kopecks: number;
    }>
  ).map((r) => ({
    code: r.code,
    section: r.section,
    sectionNo: r.section_no,
    name: r.name,
    unit: r.unit,
    priceKopecks: r.price_kopecks,
  }));
}
