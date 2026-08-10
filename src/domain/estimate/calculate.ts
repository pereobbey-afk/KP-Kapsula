import type { Db } from '../../db/index.js';
import { AppError } from '../../shared/errors.js';
import {
  lineAmount,
  pricePerSquareMeter,
  sumKopecks,
  toMilliQty,
  type Kopecks,
  type MilliQty,
} from '../../shared/money.js';

/**
 * Расчёт сметы.
 *
 * Инварианты, которые обеспечивает этот модуль:
 *
 *  1. Цена НИКОГДА не приходит извне. На вход подаётся только код работы
 *     и объём; цена читается из активной версии прайса в БД. Поэтому
 *     подменить цену запросом или состоянием интерфейса невозможно.
 *  2. Стоимость строки = объём × цена. Другой формулы нет.
 *  3. Целевой цены за м² не существует. Цена за м² — только производная
 *     величина, вычисляемая после итога.
 *  4. Неизвестный объём не превращается в строку и не растворяется
 *     в общей сумме: он уходит в примечания как «не включено».
 *  5. Деньги считает код, а не модель.
 */

export type Confidence = 'confirmed' | 'derived' | 'assumption';
export type DocumentType = 'full_project' | 'partial_project' | 'layout_only';

/** Источник факта: файл, страница и указатель на фрагмент. */
export type FactSource = {
  fileId?: string | null;
  page?: number | null;
  ref?: string | null;
};

/**
 * Заявка на объём работ.
 * Обратите внимание: поля цены здесь нет и быть не может.
 */
export type VolumeClaim = {
  /** Код позиции активного прайса. */
  code: string;
  /** Объём работ в единицах позиции прайса. */
  quantity: number;
  confidence: Confidence;
  source?: FactSource;
  note?: string | null;
  /** Правка сотрудника, а не результат распознавания. */
  isManual?: boolean;
};

/** Объём, которого нет в данных. В сумму не попадает никогда. */
export type UnknownVolume = {
  title: string;
  detail?: string | null;
  /** Код работы из прайса, если известна работа, но не объём. */
  code?: string | null;
};

export type EstimateNoteDraft = {
  kind: 'assumption' | 'clarification' | 'omission' | 'excluded';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail?: string | null;
};

export type CalculatedLine = {
  position: number;
  priceItemId: string;
  code: string;
  section: string;
  sectionNo: number | null;
  name: string;
  unit: string;
  quantityMilli: MilliQty;
  priceKopecks: Kopecks;
  amountKopecks: Kopecks;
  confidence: Confidence;
  isManual: boolean;
  source: FactSource;
  note: string | null;
};

export type CalculatedEstimate = {
  priceListVersionId: string;
  priceListLabel: string;
  documentType: DocumentType;
  isPreliminary: boolean;
  lines: CalculatedLine[];
  totalKopecks: Kopecks;
  areaMilli: MilliQty | null;
  pricePerM2Kopecks: Kopecks | null;
  notes: EstimateNoteDraft[];
};

export type PriceItemRow = {
  id: string;
  version_id: string;
  code: string;
  section: string;
  section_no: number | null;
  name: string;
  unit: string;
  price_kopecks: number;
};

export type ActiveVersion = {
  id: string;
  label: string;
  effective_date: string | null;
};

/** Активная версия прайса. Единственный источник расценок. */
export function getActivePriceListVersion(db: Db): ActiveVersion {
  const row = db
    .prepare(
      'SELECT id, label, effective_date FROM price_list_versions WHERE is_active = 1 LIMIT 1',
    )
    .get() as ActiveVersion | undefined;
  if (!row) throw new AppError('PRICE_LIST_MISSING');
  return row;
}

export function getPriceItemsByCode(
  db: Db,
  versionId: string,
  codes: readonly string[],
): Map<string, PriceItemRow> {
  const result = new Map<string, PriceItemRow>();
  if (codes.length === 0) return result;

  // Пакетами, чтобы не упереться в лимит переменных SQLite.
  const unique = [...new Set(codes)];
  const BATCH = 400;
  for (let i = 0; i < unique.length; i += BATCH) {
    const slice = unique.slice(i, i + BATCH);
    const placeholders = slice.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT id, version_id, code, section, section_no, name, unit, price_kopecks
           FROM price_items WHERE version_id = ? AND code IN (${placeholders})`,
      )
      .all(versionId, ...slice) as PriceItemRow[];
    for (const row of rows) result.set(row.code, row);
  }
  return result;
}

export type CalculateInput = {
  documentType: DocumentType;
  areaMilli: MilliQty | null;
  claims: readonly VolumeClaim[];
  unknowns?: readonly UnknownVolume[];
  assumptions?: readonly EstimateNoteDraft[];
  /**
   * Версия прайса. По умолчанию активная.
   * Пересчёт сохранённой сметы может явно указать её версию.
   */
  versionId?: string;
};

/**
 * Собирает смету.
 *
 * Заявка на объём, для которой нет позиции в активном прайсе,
 * не становится строкой: она уходит в примечания. Тихо подставить
 * «похожую» позицию нельзя — это исказило бы денежный итог.
 */
export function calculateEstimate(db: Db, input: CalculateInput): CalculatedEstimate {
  const version = input.versionId
    ? (db
        .prepare('SELECT id, label, effective_date FROM price_list_versions WHERE id = ?')
        .get(input.versionId) as ActiveVersion | undefined)
    : getActivePriceListVersion(db);

  if (!version) throw new AppError('PRICE_LIST_MISSING');

  const items = getPriceItemsByCode(
    db,
    version.id,
    input.claims.map((c) => c.code),
  );

  const notes: EstimateNoteDraft[] = [...(input.assumptions ?? [])];
  const lines: CalculatedLine[] = [];

  for (const claim of input.claims) {
    const item = items.get(claim.code);

    if (!item) {
      // Работы нет в активном прайсе — в сумму она не попадёт,
      // но и молча не исчезнет.
      notes.push({
        kind: 'omission',
        severity: 'critical',
        title: `Работа отсутствует в активном прайсе: ${claim.code}`,
        detail:
          'Позиция не включена в расчёт. Проверьте версию прайс-листа ' +
          'или добавьте работу вручную из справочника.',
      });
      continue;
    }

    // Объём должен быть положительным числом. Нулевой или неверный объём —
    // это отсутствие данных, а не бесплатная работа.
    let quantityMilli: MilliQty;
    try {
      quantityMilli = toMilliQty(claim.quantity);
    } catch {
      notes.push({
        kind: 'omission',
        severity: 'warning',
        title: `Некорректный объём для работы «${item.name}»`,
        detail: 'Строка не включена в расчёт.',
      });
      continue;
    }

    if (quantityMilli <= 0) {
      notes.push({
        kind: 'excluded',
        severity: 'info',
        title: `Нулевой объём: ${item.name}`,
        detail: 'Работа не включена в итог.',
      });
      continue;
    }

    // Ручная правка не может сохранять статус «подтверждено проектом».
    const confidence: Confidence =
      claim.isManual && claim.confidence === 'confirmed' ? 'assumption' : claim.confidence;

    lines.push({
      position: lines.length + 1,
      priceItemId: item.id,
      code: item.code,
      section: item.section,
      sectionNo: item.section_no,
      name: item.name,
      unit: item.unit,
      quantityMilli,
      // Цена только отсюда — из строки прайса в БД.
      priceKopecks: item.price_kopecks,
      amountKopecks: lineAmount(quantityMilli, item.price_kopecks),
      confidence,
      isManual: Boolean(claim.isManual),
      source: claim.source ?? {},
      note: claim.note ?? null,
    });
  }

  // Неизвестные объёмы — отдельным блоком, вне суммы.
  for (const unknown of input.unknowns ?? []) {
    notes.push({
      kind: 'excluded',
      severity: 'warning',
      title: unknown.title,
      detail: unknown.detail ?? 'Данных в документации нет — в итог не включено.',
    });
  }

  const totalKopecks = sumKopecks(lines.map((l) => l.amountKopecks));

  return {
    priceListVersionId: version.id,
    priceListLabel: version.label,
    documentType: input.documentType,
    // Точная договорная смета возможна только по полному проекту.
    isPreliminary: input.documentType !== 'full_project',
    lines,
    totalKopecks,
    areaMilli: input.areaMilli,
    pricePerM2Kopecks:
      input.areaMilli && input.areaMilli > 0
        ? pricePerSquareMeter(totalKopecks, input.areaMilli)
        : null,
    notes,
  };
}

/**
 * Повторная серверная проверка перед сохранением и экспортом.
 *
 * Защищает от расхождения сметы с прайсом: идентификатор, единица
 * измерения, цена и пересчёт суммы сверяются заново по БД.
 * Любое расхождение — ошибка, а не тихое исправление.
 */
export function verifyAgainstPriceList(
  db: Db,
  versionId: string,
  lines: readonly CalculatedLine[],
): { ok: true } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const items = getPriceItemsByCode(
    db,
    versionId,
    lines.map((l) => l.code),
  );

  for (const line of lines) {
    const item = items.get(line.code);
    if (!item) {
      problems.push(`Позиция ${line.code} отсутствует в версии прайса ${versionId}`);
      continue;
    }
    if (item.id !== line.priceItemId) {
      problems.push(`Позиция ${line.code}: идентификатор не совпадает с прайсом`);
    }
    if (item.unit !== line.unit) {
      problems.push(
        `Позиция ${line.code}: единица «${line.unit}» не совпадает с прайсом «${item.unit}»`,
      );
    }
    if (item.price_kopecks !== line.priceKopecks) {
      problems.push(
        `Позиция ${line.code}: цена ${line.priceKopecks} не совпадает с прайсом ${item.price_kopecks}`,
      );
    }
    const expected = lineAmount(line.quantityMilli, item.price_kopecks);
    if (expected !== line.amountKopecks) {
      problems.push(`Позиция ${line.code}: сумма ${line.amountKopecks} не равна расчётной ${expected}`);
    }
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/**
 * Пересчёт строки после ручной правки объёма сотрудником.
 * Статус достоверности понижается: подтверждённой документом
 * такая строка больше не является.
 */
export function applyManualQuantity(
  line: CalculatedLine,
  newQuantity: number,
  priceItem: PriceItemRow,
): CalculatedLine {
  const quantityMilli = toMilliQty(newQuantity);
  if (quantityMilli <= 0) {
    throw new AppError('VALIDATION_FAILED', { reason: 'Объём должен быть больше нуля' });
  }
  return {
    ...line,
    quantityMilli,
    priceKopecks: priceItem.price_kopecks,
    amountKopecks: lineAmount(quantityMilli, priceItem.price_kopecks),
    isManual: true,
    // Ручная правка никогда не остаётся «подтверждена проектом».
    confidence: line.confidence === 'confirmed' ? 'assumption' : line.confidence,
  };
}
