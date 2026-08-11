import crypto from 'node:crypto';

/**
 * Нормализация наименований и единиц измерения.
 *
 * Нужна для двух задач:
 *  1. дедупликация при объединении редакций прайса;
 *  2. сопоставление извлечённой из документации работы с позицией прайса.
 *
 * Нормализация обязана быть детерминированной: один и тот же вход
 * всегда даёт один и тот же ключ, иначе повторный импорт разъедется.
 */

/** Единицы измерения приводятся к каноническому виду. */
const UNIT_ALIASES: Record<string, string> = {
  м2: 'м2',
  'м²': 'м2',
  'кв.м': 'м2',
  'кв. м': 'м2',
  'кв.м.': 'м2',
  'м.кв': 'м2',
  m2: 'м2',
  м3: 'м3',
  'м³': 'м3',
  'куб.м': 'м3',
  'куб. м': 'м3',
  'м.куб': 'м3',
  'м/п': 'м.п.',
  'м\\п': 'м.п.',
  мп: 'м.п.',
  'м.п': 'м.п.',
  'м.п.': 'м.п.',
  'пог.м': 'м.п.',
  'пог. м': 'м.п.',
  'п.м': 'м.п.',
  'п.м.': 'м.п.',
  погм: 'м.п.',
  м: 'м',
  шт: 'шт',
  'шт.': 'шт',
  штука: 'шт',
  точка: 'точка',
  точек: 'точка',
  компл: 'компл',
  'компл.': 'компл',
  комплект: 'компл',
  т: 'т',
  кг: 'кг',
  л: 'л',
  час: 'час',
  смена: 'смена',
  'усл.ед': 'усл.ед',
  услед: 'усл.ед',
};

/** Базовая нормализация текста: регистр, ё, пробелы, дефисы, кавычки. */
export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/ё/g, 'е') // ё → е
    .replace(/[‐-―−]/g, '-') // все виды тире → дефис
    .replace(/[«»“”„‟"']/g, '') // кавычки убираются
    .replace(/[\u00A0\u202F\u2009]/g, ' ') // неразрывные пробелы \u2192 обычный
    .replace(/\s+/g, ' ')
    .trim();
}

/** Каноническая единица измерения. Неизвестная возвращается нормализованной. */
export function normalizeUnit(input: string): string {
  const base = normalizeText(input).replace(/\s+/g, '');
  return UNIT_ALIASES[base] ?? normalizeText(input);
}

/**
 * Ключ сопоставления позиций между редакциями.
 * Совпадение по нему означает «та же работа».
 *
 * В ключ входят наименование и единица: одна и та же работа,
 * посчитанная в м² и в м.п., — это разные позиции прайса.
 */
export function matchKey(name: string, unit: string): string {
  const normalizedName = normalizeText(name)
    .replace(/[.,;:()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${normalizedName}|${normalizeUnit(unit)}`;
}

/** Текст для полнотекстового сопоставления с формулировками из документации. */
export function searchText(name: string, section: string): string {
  return normalizeText(`${name} ${section}`);
}

/**
 * Детерминированный код позиции, когда в исходном файле его нет.
 * Один и тот же ключ всегда даёт один и тот же код,
 * поэтому повторный импорт не ломает ссылки из сохранённых смет.
 */
export function deriveCode(key: string): string {
  const digest = crypto.createHash('sha256').update(key).digest('hex');
  return `AUTO-${digest.slice(0, 10).toUpperCase()}`;
}

/** Номер раздела из строки вида «12. Электромонтажные работы». */
export function parseSectionNo(section: string): number | null {
  const m = /^\s*(\d{1,3})\s*[.)]/.exec(section);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) ? n : null;
}
