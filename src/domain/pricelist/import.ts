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
  /**
   * Вид строки из колонки «тип»: «работа» или «мат».
   * Материалы в смету не входят, поэтому в прайс не попадают.
   */
  type?: string | null;
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
  /** Поверхность расценки: стены, потолок, пол, откосы. */
  surface: string | null;
  /** Номер варианта, если в исходном файле у позиции несколько цен. */
  variant: number;
  /**
   * true, если позиция неотличима от другой по разделу, поверхности,
   * наименованию и единице, но имеет иную цену. Такие строки требуют
   * проверки сотрудником и помечаются в смете.
   */
  ambiguous: boolean;
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
  reason: 'no_name' | 'no_unit' | 'no_price' | 'section_header' | 'material' | 'stage_marker';
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
  /** Сколько строк отсеяно как материалы. Материалы в смету не входят. */
  materialsExcluded: number;
  /** Дубли внутри одной редакции: полностью совпадают, включая цену. */
  duplicatesWithinEdition: Array<{ edition: string; matchKey: string; name: string }>;
  /**
   * Неоднозначные позиции: те же раздел, поверхность, наименование и
   * единица, но РАЗНАЯ цена. Обе сохраняются — выбрать одну молча
   * значило бы потерять расценку. Требуют проверки исходного файла.
   */
  ambiguousPositions: Array<{
    edition: string;
    name: string;
    unit: string;
    section: string;
    prices: number[];
    sourceRows: Array<string | null>;
  }>;
  sections: Array<{ sectionNo: number | null; section: string; items: number }>;
};

export type MergeResult = {
  items: NormalizedPriceItem[];
  report: ImportReport;
};

/**
 * Значение колонки «тип», означающее материал.
 * Задание запрещает включать материалы в расчёт, поэтому такие строки
 * не попадают даже в каталог: модель не должна их видеть.
 */
function isMaterialRow(row: RawPriceRow): boolean {
  const type = normalizeText(row.type ?? '');
  return type === 'мат' || type.startsWith('материал');
}

/**
 * Строка-маркер этапа или итога («Второй этап:», «Итого за второй этап:»).
 * Это не раздел: если принять её за раздел, следующие работы получат
 * неверную принадлежность.
 */
function isStageMarker(name: string): boolean {
  const n = normalizeText(name);
  // \b и \w в JavaScript работают только с латиницей, поэтому границы
  // слова здесь заданы явно — иначе проверка молча провалится.
  return /^итого(\s|$)/.test(n) || /^(перв|втор|трет|четверт|пят|шест)[а-яё]*\s+этап:?$/.test(n);
}

/**
 * Поверхность, к которой относится расценка: стены, потолок, пол, откосы.
 *
 * В прайсе «Капсулы» один раздел содержит несколько блоков подряд без
 * заголовков: стены м², стены м/п, потолок м², потолок м/п. Общие работы
 * («Грунтовка», «Обеспыливание») повторяются в каждом блоке с РАЗНОЙ ценой —
 * потолок дешевле стен. Различает блоки только строка-якорь вида
 * «Шпаклевка стен» / «Шпаклевка потолка», которая идёт следом.
 *
 * Без учёта поверхности две расценки схлопнулись бы в одну и часть цен
 * потерялась бы молча.
 */
const SURFACE_PATTERNS: Array<[RegExp, string]> = [
  // Границы слова заданы явно: \b и \w в JavaScript не работают с кириллицей.
  [/потолк|потолок|потолоч/, 'потолок'],
  [/(^|[^а-яё])стен/, 'стены'],
  [/откос/, 'откосы'],
  [/напольн|(^|[^а-яё])пол(ы|а|ов|у|ом|е)?([^а-яё]|$)/, 'пол'],
];

export function detectSurface(name: string): string | null {
  const n = normalizeText(name);
  for (const [re, label] of SURFACE_PATTERNS) {
    if (re.test(n)) return label;
  }
  return null;
}

/**
 * Для каждой строки — поверхность ближайшей последующей строки-якоря
 * в пределах того же блока. Смотрим вперёд, потому что в исходном файле
 * якорь стоит после общих работ блока.
 */
function surfaceByLookahead(rows: readonly RawPriceRow[]): Array<string | null> {
  const result: Array<string | null> = new Array(rows.length).fill(null);
  let current: string | null = null;

  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    const name = (row.name ?? '').trim();
    // Заголовок раздела обрывает блок: за него поверхность не переносится.
    if (name && !(row.unit ?? '').trim()) {
      current = null;
      continue;
    }
    const own = detectSurface(name);
    if (own) current = own;
    result[i] = current;
  }
  return result;
}

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
  const ambiguousPositions: ImportReport['ambiguousPositions'] = [];
  const perEdition: ImportReport['perEdition'] = [];

  for (const edition of ordered) {
    let accepted = 0;
    let rejectedHere = 0;
    // Ключ → цена и место первой встреченной позиции.
    const seenInThisEdition = new Map<string, { price: number; sourceRow: string | null }>();
    const variantCount = new Map<string, number>();
    const surfaces = surfaceByLookahead(edition.rows);
    let rowIndex = -1;
    // Заголовок раздела «прилипает» к последующим строкам, если раздел
    // не указан в самой строке — обычная форма прайса в Excel.
    let currentSection = '';

    for (const row of edition.rows) {
      rowIndex += 1;
      const name = (row.name ?? '').trim();
      const unit = (row.unit ?? '').trim();
      const priceKopecks = parsePriceToKopecks(row.price ?? null);

      // Материал — не работа. Задание запрещает включать материалы
      // в расчёт, поэтому в каталог они не попадают вовсе:
      // модель не должна их даже видеть.
      if (isMaterialRow(row)) {
        rejected.push({
          edition: edition.label,
          sourceRow: row.sourceRow ?? null,
          reason: 'material',
          raw: row,
        });
        rejectedHere += 1;
        continue;
      }

      if (looksLikeSectionHeader(row)) {
        // «Второй этап:» и «Итого за второй этап:» — не разделы.
        // Приняв их за раздел, следующие работы получили бы
        // неверную принадлежность.
        const marker = isStageMarker(name);
        if (!marker) currentSection = name;

        rejected.push({
          edition: edition.label,
          sourceRow: row.sourceRow ?? null,
          reason: marker ? 'stage_marker' : 'section_header',
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
      const sectionTitle = normalizeSectionTitle(section);
      const surface = surfaces[rowIndex] ?? null;
      // Позиция опознаётся разделом, поверхностью, наименованием и единицей.
      // Одна и та же работа в разных разделах или на разных поверхностях —
      // это разные расценки, а не дубль.
      const key = `${normalizeText(sectionTitle)}|${surface ?? ''}|${matchKey(name, unit)}`;

      let itemKey = key;
      let variant = 1;
      let ambiguous = false;

      const previousHere = seenInThisEdition.get(key);
      if (previousHere) {
        if (previousHere.price === priceKopecks) {
          // Полное совпадение, включая цену, — настоящий дубль.
          duplicatesWithinEdition.push({ edition: edition.label, matchKey: key, name });
          rejectedHere += 1;
          continue;
        }

        // Цена другая — это отдельная расценка. Сохраняем обе:
        // молчаливый выбор одной из них потерял бы деньги.
        variant = (variantCount.get(key) ?? 1) + 1;
        variantCount.set(key, variant);
        itemKey = `${key}#${variant}`;
        ambiguous = true;

        // Первый вариант был записан до того, как выяснилась неоднозначность.
        // Помечаем и его: иначе строка сметы по нему не предупредит сотрудника.
        const firstVariant = byKey.get(key);
        if (firstVariant) firstVariant.ambiguous = true;

        const existing = ambiguousPositions.find(
          (a) => a.edition === edition.label && a.name === name && a.unit === unit,
        );
        if (existing) {
          existing.prices.push(priceKopecks!);
          existing.sourceRows.push(row.sourceRow ?? null);
        } else {
          ambiguousPositions.push({
            edition: edition.label,
            name,
            unit,
            section: sectionTitle,
            prices: [previousHere.price, priceKopecks!],
            sourceRows: [previousHere.sourceRow, row.sourceRow ?? null],
          });
        }
      } else {
        seenInThisEdition.set(key, { price: priceKopecks!, sourceRow: row.sourceRow ?? null });
      }

      const item: NormalizedPriceItem = {
        code: (row.code ?? '').trim() || deriveCode(itemKey),
        variant,
        ambiguous,
        section: sectionTitle,
        surface,
        sectionNo: row.sectionNo ?? parseSectionNo(section),
        name,
        unit: normalizeUnit(unit),
        priceKopecks: priceKopecks!,
        sourceEdition: edition.label,
        sourceRow: row.sourceRow ?? null,
        matchKey: key,
        searchText: searchText(name, section),
      };

      const previous = byKey.get(itemKey);
      if (previous) {
        overridden.push({
          matchKey: itemKey,
          name,
          fromEdition: previous.sourceEdition,
          toEdition: edition.label,
          oldPriceKopecks: previous.priceKopecks,
          newPriceKopecks: item.priceKopecks,
        });
      } else {
        originEdition.set(itemKey, edition.label);
      }

      byKey.set(itemKey, item);
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
      materialsExcluded: rejected.filter((r) => r.reason === 'material').length,
      duplicatesWithinEdition,
      ambiguousPositions,
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
    `Материалов отсеяно: ${report.materialsExcluded}. ` +
    `Неоднозначных позиций (разная цена при одинаковом описании): ${report.ambiguousPositions.length}. ` +
    `Не принято строк всего: ${report.rejected.length}.`
  );
}

export { normalizeText };
