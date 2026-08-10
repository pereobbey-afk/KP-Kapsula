import { parsePriceToKopecks, type Kopecks } from '../../shared/money.js';
import {
  deriveCode,
  matchKey,
  normalizeText,
  normalizeUnit,
  parseSectionNo,
  searchText,
} from './normalize.js';

/**
 * Объединение редакций прайс-листа.
 *
 * Правило из задания: при совпадении позиции более свежая редакция
 * вытесняет старую, уникальные позиции старой редакции сохраняются.
 *
 * Ни одна строка не исчезает молча: всё, что не попало в результат,
 * попадает в отчёт с причиной. Молчаливый пропуск строки прайса
 * означал бы работу, которой нет в смете, — это недопустимо.
 */

export type RawPriceRow = {
  section?: string | null;
  sectionNo?: number | null;
  code?: string | null;
  name?: string | null;
  unit?: string | null;
  price?: string | number | null;
  /** Ссылка на место в исходном файле: лист и строка. */
  sourceRow?: string | null;
};

export type PriceEdition = {
  /** Человекочитаемая метка редакции, например «05.08.2026». */
  label: string;
  /** Дата редакции в формате ISO. Определяет приоритет при слиянии. */
  effectiveDate: string;
  rows: RawPriceRow[];
};

export type NormalizedPriceItem = {
  code: string;
  section: string;
  sectionNo: number | null;
  name: string;
  unit: string;
  priceKopecks: Kopecks;
  sourceEdition: string;
  sourceRow: string | null;
  matchKey: string;
  searchText: string;
};

export type RejectedRow = {
  edition: string;
  sourceRow: string | null;
  reason: 'no_name' | 'no_unit' | 'no_price' | 'section_header';
  raw: RawPriceRow;
};

export type OverriddenItem = {
  matchKey: string;
  name: string;
  fromEdition: string;
  toEdition: string;
  oldPriceKopecks: Kopecks;
  newPriceKopecks: Kopecks;
};

export type ImportReport = {
  /** Итоговое число уникальных работ. */
  totalItems: number;
  /** Итоговое число разделов. */
  totalSections: number;
  /** Разбор по редакциям: сколько строк прочитано и сколько принято. */
  perEdition: Array<{ label: string; rowsRead: number; accepted: number; rejected: number }>;
  /** Позиции, вытесненные более свежей редакцией. */
  overridden: OverriddenItem[];
  /** Позиции, сохранённые из старых редакций как уникальные. */
  keptUniqueFromOlder: number;
  /** Строки, не ставшие позициями, с причиной. */
  rejected: RejectedRow[];
  /** Дубли внутри одной редакции. */
  duplicatesWithinEdition: Array<{ edition: string; matchKey: string; name: string }>;
  sections: Array<{ sectionNo: number | null; section: string; items: number }>;
};

export type MergeResult = {
  items: NormalizedPriceItem[];
  report: ImportReport;
};

/** Строка похожа на заголовок раздела, а не на работу. */
function looksLikeSectionHeader(row: RawPriceRow): boolean {
  const hasName = Boolean(row.name && row.name.trim());
  const hasUnit = Boolean(row.unit && row.unit.trim());
  const hasPrice = parsePriceToKopecks(row.price ?? null) !== null;
  return hasName && !hasUnit && !hasPrice;
}

/**
 * Объединяет редакции в один прайс.
 * Редакции сортируются по дате: более поздняя перекрывает более раннюю.
 */
export function mergeEditions(editions: readonly PriceEdition[]): MergeResult {
  const ordered = [...editions].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));

  const byKey = new Map<string, NormalizedPriceItem>();
  const originEdition = new Map<string, string>();
  const rejected: RejectedRow[] = [];
  const overridden: OverriddenItem[] = [];
  const duplicatesWithinEdition: ImportReport['duplicatesWithinEdition'] = [];
  const perEdition: ImportReport['perEdition'] = [];

  for (const edition of ordered) {
    let accepted = 0;
    let rejectedHere = 0;
    const seenInThisEdition = new Set<string>();
    // Заголовок раздела «прилипает» к последующим строкам, если раздел
    // не указан в самой строке — обычная форма прайса в Excel.
    let currentSection = '';

    for (const row of edition.rows) {
      const name = (row.name ?? '').trim();
      const unit = (row.unit ?? '').trim();
      const priceKopecks = parsePriceToKopecks(row.price ?? null);

      if (looksLikeSectionHeader(row)) {
        currentSection = name;
        rejected.push({
          edition: edition.label,
          sourceRow: row.sourceRow ?? null,
          reason: 'section_header',
          raw: row,
        });
        rejectedHere += 1;
        continue;
      }

      const reason: RejectedRow['reason'] | null = !name
        ? 'no_name'
        : !unit
          ? 'no_unit'
          : priceKopecks === null
            ? 'no_price'
            : null;

      if (reason) {
        rejected.push({ edition: edition.label, sourceRow: row.sourceRow ?? null, reason, raw: row });
        rejectedHere += 1;
        continue;
      }

      const section = (row.section ?? '').trim() || currentSection || 'Без раздела';
      const key = matchKey(name, unit);

      if (seenInThisEdition.has(key)) {
        // Дубль внутри одной редакции: остаётся первая встреченная строка,
        // факт фиксируется в отчёте для проверки исходного файла.
        duplicatesWithinEdition.push({ edition: edition.label, matchKey: key, name });
        rejectedHere += 1;
        continue;
      }
      seenInThisEdition.add(key);

      const item: NormalizedPriceItem = {
        code: (row.code ?? '').trim() || deriveCode(key),
        section: normalizeSectionTitle(section),
        sectionNo: row.sectionNo ?? parseSectionNo(section),
        name,
        unit: normalizeUnit(unit),
        priceKopecks: priceKopecks!,
        sourceEdition: edition.label,
        sourceRow: row.sourceRow ?? null,
        matchKey: key,
        searchText: searchText(name, section),
      };

      const previous = byKey.get(key);
      if (previous) {
        overridden.push({
          matchKey: key,
          name,
          fromEdition: previous.sourceEdition,
          toEdition: edition.label,
          oldPriceKopecks: previous.priceKopecks,
          newPriceKopecks: item.priceKopecks,
        });
      } else {
        originEdition.set(key, edition.label);
      }

      byKey.set(key, item);
      accepted += 1;
    }

    perEdition.push({
      label: edition.label,
      rowsRead: edition.rows.length,
      accepted,
      rejected: rejectedHere,
    });
  }

  const items = [...byKey.values()].sort((a, b) => {
    const sa = a.sectionNo ?? Number.MAX_SAFE_INTEGER;
    const sb = b.sectionNo ?? Number.MAX_SAFE_INTEGER;
    if (sa !== sb) return sa - sb;
    if (a.section !== b.section) return a.section.localeCompare(b.section, 'ru');
    return a.name.localeCompare(b.name, 'ru');
  });

  const newestEdition = ordered.at(-1)?.label ?? '';
  const keptUniqueFromOlder = items.filter((i) => i.sourceEdition !== newestEdition).length;

  const sectionMap = new Map<string, { sectionNo: number | null; section: string; items: number }>();
  for (const item of items) {
    const entry = sectionMap.get(item.section);
    if (entry) entry.items += 1;
    else sectionMap.set(item.section, { sectionNo: item.sectionNo, section: item.section, items: 1 });
  }
  const sections = [...sectionMap.values()].sort((a, b) => (a.sectionNo ?? 1e9) - (b.sectionNo ?? 1e9));

  return {
    items,
    report: {
      totalItems: items.length,
      totalSections: sections.length,
      perEdition,
      overridden,
      keptUniqueFromOlder,
      rejected,
      duplicatesWithinEdition,
      sections,
    },
  };
}

/** Убирает ведущую нумерацию из заголовка раздела, оставляя название. */
export function normalizeSectionTitle(section: string): string {
  return section.replace(/^\s*\d{1,3}\s*[.)]\s*/, '').trim() || section.trim();
}

/** Короткая сводка отчёта для лога и интерфейса администратора. */
export function formatImportSummary(report: ImportReport): string {
  const editions = report.perEdition
    .map((e) => `${e.label}: прочитано ${e.rowsRead}, принято ${e.accepted}`)
    .join('; ');
  return (
    `Итог: ${report.totalItems} уникальных работ в ${report.totalSections} разделах. ` +
    `${editions}. Вытеснено свежей редакцией: ${report.overridden.length}. ` +
    `Сохранено уникальных из старых редакций: ${report.keptUniqueFromOlder}. ` +
    `Не принято строк: ${report.rejected.length}.`
  );
}

export { normalizeText };
