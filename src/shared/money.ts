/**
 * Детерминированная денежная арифметика.
 *
 * Требование задания: денежные вычисления выполняет код с корректным
 * округлением, а не модель. Поэтому:
 *  - деньги хранятся в копейках (целое число);
 *  - объёмы хранятся в тысячных долях единицы (целое число, 3 знака);
 *  - умножение идёт через BigInt, чтобы исключить ошибку double
 *    и переполнение Number.MAX_SAFE_INTEGER на больших сметах.
 *
 * Ни одна величина здесь не проходит через тип number в промежуточных
 * вычислениях — только на входе и выходе.
 */

/** Копейки. */
export type Kopecks = number;
/** Объём, умноженный на 1000. */
export type MilliQty = number;

export const QTY_SCALE = 1000n;
export const KOPECKS_IN_RUBLE = 100n;

/** Округление половины от нуля (0,5 → 1; −0,5 → −1) — бухгалтерский стандарт. */
function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('Деление на ноль в денежном расчёте');
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = n / d;
  const remainder = n % d;
  // remainder * 2 >= d  ⇒  дробная часть >= 0,5
  const rounded = remainder * 2n >= d ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

function assertSafeInteger(value: bigint, what: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`Переполнение при вычислении: ${what}`);
  }
  return Number(value);
}

/**
 * Стоимость строки = объём × цена позиции.
 * Единственная формула, по которой возникает денежная сумма строки.
 */
export function lineAmount(quantityMilli: MilliQty, priceKopecks: Kopecks): Kopecks {
  if (!Number.isInteger(quantityMilli)) {
    throw new Error('Объём должен быть целым числом тысячных долей');
  }
  if (!Number.isInteger(priceKopecks)) {
    throw new Error('Цена должна быть целым числом копеек');
  }
  if (quantityMilli < 0) throw new Error('Объём не может быть отрицательным');
  if (priceKopecks < 0) throw new Error('Цена не может быть отрицательной');

  const product = BigInt(quantityMilli) * BigInt(priceKopecks);
  return assertSafeInteger(divRoundHalfUp(product, QTY_SCALE), 'стоимость строки');
}

/** Сумма строк. Складываются уже округлённые суммы — итог совпадает с показанным. */
export function sumKopecks(values: readonly Kopecks[]): Kopecks {
  let total = 0n;
  for (const v of values) {
    if (!Number.isInteger(v)) throw new Error('Сумма должна быть целым числом копеек');
    total += BigInt(v);
  }
  return assertSafeInteger(total, 'итог сметы');
}

/**
 * Производный показатель: цена за м² = итог работ / площадь.
 * Только производная величина — никогда не вход для расчёта.
 */
export function pricePerSquareMeter(totalKopecks: Kopecks, areaMilli: MilliQty): Kopecks | null {
  if (areaMilli <= 0) return null;
  const numerator = BigInt(totalKopecks) * QTY_SCALE;
  return assertSafeInteger(divRoundHalfUp(numerator, BigInt(areaMilli)), 'цена за м²');
}

/** Разбор объёма из числа в тысячные доли. Отсекает нечисловой мусор. */
export function toMilliQty(value: number): MilliQty {
  if (!Number.isFinite(value)) throw new Error('Объём должен быть конечным числом');
  if (value < 0) throw new Error('Объём не может быть отрицательным');
  // toFixed(3) даёт детерминированное представление до тысячных.
  return Math.round(Number(value.toFixed(3)) * 1000);
}

export function fromMilliQty(milli: MilliQty): number {
  return Number((milli / 1000).toFixed(3));
}

/**
 * Разбор цены из строки прайса. Понимает «1 234,56», «1234.56», «1 234,56 ₽».
 * Возвращает null, если значение не является ценой.
 */
export function parsePriceToKopecks(raw: string | number | null | undefined): Kopecks | null {
  if (raw === null || raw === undefined) return null;

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return null;
    return Math.round(Number(raw.toFixed(2)) * 100);
  }

  const cleaned = raw
    .replace(/[\s\u00A0\u202F\u2009']/g, '') // пробелы всех видов как разделители тысяч
    .replace(/[\u20BD\u0440\u0443\u0431.]*$/iu, '')
    .replace(',', '.')
    .trim();

  if (cleaned === '' || !/^\d+(\.\d+)?$/.test(cleaned)) return null;

  const asNumber = Number(cleaned);
  if (!Number.isFinite(asNumber) || asNumber < 0) return null;
  return Math.round(Number(asNumber.toFixed(2)) * 100);
}

/** Копейки → рубли числом. Только для экспорта и отображения. */
export function kopecksToRubles(kopecks: Kopecks): number {
  return Number((kopecks / 100).toFixed(2));
}

/**
 * Копейки → «1 234,56 ₽» для интерфейса и печати.
 * Разряды и знак валюты отбиваются неразрывным пробелом (U+00A0),
 * чтобы денежная сумма не разрывалась переносом строки.
 */
export const NBSP = '\u00A0';

export function formatKopecks(kopecks: Kopecks): string {
  const negative = kopecks < 0;
  const abs = Math.abs(kopecks);
  const rubles = Math.trunc(abs / 100);
  const cents = abs % 100;
  const grouped = String(rubles).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return `${negative ? '\u2212' : ''}${grouped},${String(cents).padStart(2, '0')}${NBSP}\u20BD`;
}
