import { describe, it, expect } from 'vitest';
import {
  lineAmount,
  sumKopecks,
  pricePerSquareMeter,
  toMilliQty,
  fromMilliQty,
  parsePriceToKopecks,
  formatKopecks,
  kopecksToRubles,
} from '../src/shared/money.js';

describe('lineAmount — стоимость строки = объём × цена', () => {
  it('считает целые объёмы точно', () => {
    // 12 м² × 450,00 ₽ = 5 400,00 ₽
    expect(lineAmount(toMilliQty(12), 45000)).toBe(540000);
  });

  it('считает дробные объёмы до тысячных', () => {
    // 12,345 м² × 450,00 ₽ = 5 555,25 ₽
    expect(lineAmount(toMilliQty(12.345), 45000)).toBe(555525);
  });

  it('округляет половину вверх, а не по правилу банкира', () => {
    // 1,005 × 1,00 ₽ = 1,005 ₽ → 1,01 ₽ (100,5 коп → 101 коп)
    expect(lineAmount(toMilliQty(1.005), 100)).toBe(101);
    // 2,005 × 1,00 ₽ → 201 коп (банкирское округление дало бы 200)
    expect(lineAmount(toMilliQty(2.005), 100)).toBe(201);
  });

  it('не теряет точность на суммах, где double уже врёт', () => {
    // 0,1 + 0,2 в double даёт 0,30000000000000004.
    // В копейках результат обязан быть ровным.
    const a = lineAmount(toMilliQty(0.1), 100);
    const b = lineAmount(toMilliQty(0.2), 100);
    expect(sumKopecks([a, b])).toBe(30);
  });

  it('выдерживает крупную смету без переполнения double', () => {
    // 100 000 м² × 999 999,99 ₽ — произведение выходит за пределы
    // безопасного целого в double, но BigInt считает точно.
    const amount = lineAmount(toMilliQty(100_000), 99_999_999);
    expect(amount).toBe(9_999_999_900_000);
    expect(Number.isSafeInteger(amount)).toBe(true);
  });

  it('отвергает отрицательные и нецелые аргументы', () => {
    expect(() => lineAmount(-1000, 100)).toThrow(/отрицательным/);
    expect(() => lineAmount(1000, -100)).toThrow(/отрицательной/);
    expect(() => lineAmount(1.5, 100)).toThrow(/целым числом/);
  });
});

describe('sumKopecks — итог складывает уже округлённые строки', () => {
  it('итог совпадает с суммой показанных строк', () => {
    // Каждая строка округлена до копейки; итог обязан быть их суммой,
    // иначе интерфейс и экспорт разойдутся с итогом.
    const lines = [
      lineAmount(toMilliQty(1.333), 33333),
      lineAmount(toMilliQty(2.667), 33333),
      lineAmount(toMilliQty(0.5), 19999),
    ];
    expect(sumKopecks(lines)).toBe(lines[0]! + lines[1]! + lines[2]!);
  });

  it('пустая смета даёт ноль', () => {
    expect(sumKopecks([])).toBe(0);
  });
});

describe('pricePerSquareMeter — только производный показатель', () => {
  it('делит итог на площадь', () => {
    // 1 000 000,00 ₽ / 50 м² = 20 000,00 ₽/м²
    expect(pricePerSquareMeter(100_000_000, toMilliQty(50))).toBe(2_000_000);
  });

  it('возвращает null при отсутствующей площади, а не делит на ноль', () => {
    expect(pricePerSquareMeter(100_000, 0)).toBeNull();
    expect(pricePerSquareMeter(100_000, -1)).toBeNull();
  });
});

describe('parsePriceToKopecks — разбор цен из прайса', () => {
  it('понимает русский формат с запятой и пробелами', () => {
    expect(parsePriceToKopecks('1 234,56')).toBe(123456);
    expect(parsePriceToKopecks('1 234,56')).toBe(123456); // неразрывный пробел
    expect(parsePriceToKopecks('1234.56')).toBe(123456);
    expect(parsePriceToKopecks('450')).toBe(45000);
  });

  it('принимает число', () => {
    expect(parsePriceToKopecks(1234.56)).toBe(123456);
    expect(parsePriceToKopecks(0)).toBe(0);
  });

  it('отвергает нечисловой мусор вместо молчаливого нуля', () => {
    // Молчаливый ноль превратил бы платную работу в бесплатную.
    expect(parsePriceToKopecks('договорная')).toBeNull();
    expect(parsePriceToKopecks('')).toBeNull();
    expect(parsePriceToKopecks(null)).toBeNull();
    expect(parsePriceToKopecks(undefined)).toBeNull();
    expect(parsePriceToKopecks('-100')).toBeNull();
    expect(parsePriceToKopecks(NaN)).toBeNull();
  });
});

describe('преобразование объёмов', () => {
  it('туда и обратно без потерь до тысячных', () => {
    for (const v of [0, 1, 12.345, 0.001, 999.999]) {
      expect(fromMilliQty(toMilliQty(v))).toBe(v);
    }
  });

  it('отвергает бесконечность и отрицательные значения', () => {
    expect(() => toMilliQty(Infinity)).toThrow();
    expect(() => toMilliQty(-1)).toThrow();
  });
});

describe('форматирование', () => {
  const NB = '\u00A0';

  it('печатает рубли с разрядами и неразрывными пробелами', () => {
    expect(formatKopecks(123456789)).toBe(`1${NB}234${NB}567,89${NB}\u20BD`);
    expect(formatKopecks(5)).toBe(`0,05${NB}\u20BD`);
    expect(formatKopecks(0)).toBe(`0,00${NB}\u20BD`);
  });

  it('в рубли для экспорта', () => {
    expect(kopecksToRubles(123456)).toBe(1234.56);
  });
});
