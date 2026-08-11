import { describe, it, expect } from 'vitest';
import {
  mergeEditions,
  formatImportSummary,
  detectSurface,
  type PriceEdition,
} from '../src/domain/pricelist/import.js';
import {
  matchKey,
  normalizeUnit,
  normalizeText,
  deriveCode,
  parseSectionNo,
} from '../src/domain/pricelist/normalize.js';

describe('нормализация', () => {
  it('единицы измерения приводятся к канону', () => {
    expect(normalizeUnit('м²')).toBe('м2');
    expect(normalizeUnit('кв.м')).toBe('м2');
    expect(normalizeUnit('М2')).toBe('м2');
    expect(normalizeUnit('пог.м')).toBe('м.п.');
    expect(normalizeUnit('п.м.')).toBe('м.п.');
    expect(normalizeUnit('шт.')).toBe('шт');
  });

  it('ё и е считаются одной буквой', () => {
    expect(normalizeText('Подъём')).toBe(normalizeText('Подъем'));
  });

  it('ключ сопоставления не зависит от регистра и пробелов', () => {
    expect(matchKey('Штукатурка  стен', 'м²')).toBe(matchKey('штукатурка стен', 'кв.м'));
  });

  it('разные единицы — разные позиции', () => {
    // Одна и та же работа в м² и в м.п. — это две разные расценки.
    expect(matchKey('Устройство откосов', 'м2')).not.toBe(matchKey('Устройство откосов', 'м.п.'));
  });

  it('код выводится детерминированно', () => {
    const key = matchKey('Штукатурка стен', 'м2');
    expect(deriveCode(key)).toBe(deriveCode(key));
    expect(deriveCode(key)).toMatch(/^AUTO-[0-9A-F]{10}$/);
  });

  it('номер раздела разбирается из заголовка', () => {
    expect(parseSectionNo('12. Электромонтажные работы')).toBe(12);
    expect(parseSectionNo('3) Полы')).toBe(3);
    expect(parseSectionNo('Без номера')).toBeNull();
  });
});

describe('слияние редакций прайса', () => {
  const older: PriceEdition = {
    label: '01.07.2026',
    effectiveDate: '2026-07-01',
    rows: [
      { section: '1. Стены', name: 'Штукатурка стен', unit: 'м2', price: '400,00', sourceRow: 'Лист1!A2' },
      { section: '1. Стены', name: 'Шпаклевка стен', unit: 'м2', price: '250,00', sourceRow: 'Лист1!A3' },
      { section: '2. Полы', name: 'Стяжка пола', unit: 'м2', price: '500,00', sourceRow: 'Лист1!A4' },
    ],
  };

  const newer: PriceEdition = {
    label: '05.08.2026',
    effectiveDate: '2026-08-05',
    rows: [
      // Совпадающая позиция — должна вытеснить старую цену.
      { section: '1. Стены', name: 'Штукатурка  стен', unit: 'м²', price: '450,00', sourceRow: 'Лист1!A2' },
      // Новая позиция, которой не было.
      { section: '3. Потолки', name: 'Натяжной потолок', unit: 'м2', price: '900,00', sourceRow: 'Лист1!A5' },
    ],
  };

  it('свежая редакция вытесняет совпадающую позицию', () => {
    const { items, report } = mergeEditions([older, newer]);
    const plaster = items.find((i) => i.name.includes('Штукатурка'))!;

    expect(plaster.priceKopecks).toBe(45000);
    expect(plaster.sourceEdition).toBe('05.08.2026');
    expect(report.overridden).toHaveLength(1);
    expect(report.overridden[0]!.oldPriceKopecks).toBe(40000);
    expect(report.overridden[0]!.newPriceKopecks).toBe(45000);
  });

  it('уникальные позиции старой редакции сохраняются', () => {
    const { items } = mergeEditions([older, newer]);
    const names = items.map((i) => i.name);

    expect(names).toContain('Шпаклевка стен');
    expect(names).toContain('Стяжка пола');
    expect(names).toContain('Натяжной потолок');
    // 3 старых + 1 новая, одна из старых перекрыта — итого 4 уникальные работы.
    expect(items).toHaveLength(4);
  });

  it('порядок передачи редакций не влияет на результат', () => {
    // Приоритет определяется датой редакции, а не порядком аргументов.
    const a = mergeEditions([older, newer]);
    const b = mergeEditions([newer, older]);

    expect(b.items).toHaveLength(a.items.length);
    const priceOf = (r: typeof a) => r.items.find((i) => i.name.includes('Штукатурка'))!.priceKopecks;
    expect(priceOf(b)).toBe(priceOf(a));
    expect(priceOf(b)).toBe(45000);
  });

  it('считает разделы и позиции для сверки с исходным файлом', () => {
    const { report } = mergeEditions([older, newer]);

    expect(report.totalItems).toBe(4);
    expect(report.totalSections).toBe(3);
    expect(report.perEdition.map((e) => e.label)).toEqual(['01.07.2026', '05.08.2026']);
    expect(formatImportSummary(report)).toContain('4 уникальных работ в 3 разделах');
  });
});

describe('строки, не ставшие позициями, не исчезают молча', () => {
  it('строка без цены попадает в отчёт с причиной', () => {
    const edition: PriceEdition = {
      label: 'test',
      effectiveDate: '2026-01-01',
      rows: [
        { section: '1. Стены', name: 'Работа без цены', unit: 'м2', price: 'договорная', sourceRow: 'A2' },
        { section: '1. Стены', name: 'Нормальная работа', unit: 'м2', price: '100', sourceRow: 'A3' },
      ],
    };
    const { items, report } = mergeEditions([edition]);

    expect(items).toHaveLength(1);
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0]!.reason).toBe('no_price');
    expect(report.rejected[0]!.sourceRow).toBe('A2');
  });

  it('нулевая цена — это цена, а не отсутствие данных', () => {
    const edition: PriceEdition = {
      label: 'test',
      effectiveDate: '2026-01-01',
      rows: [{ section: '1', name: 'Бесплатная работа', unit: 'шт', price: '0' }],
    };
    const { items } = mergeEditions([edition]);
    expect(items).toHaveLength(1);
    expect(items[0]!.priceKopecks).toBe(0);
  });

  it('заголовок раздела не становится работой', () => {
    const edition: PriceEdition = {
      label: 'test',
      effectiveDate: '2026-01-01',
      rows: [
        { name: '5. Электромонтажные работы', unit: null, price: null, sourceRow: 'A10' },
        { name: 'Прокладка кабеля', unit: 'м.п.', price: '120', sourceRow: 'A11' },
      ],
    };
    const { items, report } = mergeEditions([edition]);

    expect(items).toHaveLength(1);
    // Заголовок «прилип» к следующей строке как раздел.
    expect(items[0]!.section).toBe('Электромонтажные работы');
    expect(items[0]!.sectionNo).toBe(5);
    expect(report.rejected[0]!.reason).toBe('section_header');
  });

  it('полностью совпадающая строка отбрасывается как дубль', () => {
    const edition: PriceEdition = {
      label: 'test',
      effectiveDate: '2026-01-01',
      rows: [
        { section: '1', name: 'Штукатурка стен', unit: 'м2', price: '400' },
        { section: '1', name: 'ШТУКАТУРКА  СТЕН', unit: 'кв.м', price: '400' },
      ],
    };
    const { items, report } = mergeEditions([edition]);

    expect(items).toHaveLength(1);
    expect(items[0]!.priceKopecks).toBe(40000);
    expect(report.duplicatesWithinEdition).toHaveLength(1);
    expect(report.ambiguousPositions).toHaveLength(0);
  });

  it('одинаковое описание с РАЗНОЙ ценой сохраняет обе расценки', () => {
    // Молчаливый выбор одной из цен потерял бы расценку,
    // поэтому сохраняются обе, а факт попадает в отчёт.
    const edition: PriceEdition = {
      label: 'test',
      effectiveDate: '2026-01-01',
      rows: [
        { section: '1', name: 'Монтаж угла в нише', unit: 'шт', price: '4000' },
        { section: '1', name: 'Монтаж угла в нише', unit: 'шт', price: '2000' },
      ],
    };
    const { items, report } = mergeEditions([edition]);

    expect(items).toHaveLength(2);
    expect(items.map((i) => i.priceKopecks).sort((a, b) => a - b)).toEqual([200000, 400000]);
    // Обе помечены как требующие проверки, коды у них разные.
    expect(items.every((i) => i.ambiguous)).toBe(true);
    expect(new Set(items.map((i) => i.code)).size).toBe(2);
    expect(report.ambiguousPositions).toHaveLength(1);
    expect(report.ambiguousPositions[0]!.prices.sort((a, b) => a - b)).toEqual([200000, 400000]);
  });
});

describe('структура настоящего прайса «Капсулы»', () => {
  it('материалы не попадают в прайс работ', () => {
    // Задание запрещает включать материалы в расчёт, поэтому они
    // не попадают даже в каталог — модель не должна их видеть.
    const edition: PriceEdition = {
      label: 'test',
      effectiveDate: '2026-01-01',
      rows: [
        { type: 'работа', section: '1', name: 'Укладка плитки', unit: 'м2', price: '1200' },
        { type: 'мат', section: '1', name: 'Плиточный клей', unit: 'кг', price: '90' },
        { type: 'материалы', section: '1', name: 'Грунтовка', unit: 'л', price: '450' },
      ],
    };
    const { items, report } = mergeEditions([edition]);

    expect(items).toHaveLength(1);
    expect(items[0]!.name).toBe('Укладка плитки');
    expect(report.materialsExcluded).toBe(2);
  });

  it('маркеры этапов и итогов не становятся разделами', () => {
    const edition: PriceEdition = {
      label: 'test',
      effectiveDate: '2026-01-01',
      rows: [
        { name: 'Демонтажные работы / Стены', unit: null, price: null },
        { type: 'работа', name: 'Демонтаж перегородки', unit: 'м2', price: '500' },
        { name: 'Второй этап:', unit: null, price: null },
        { name: 'Итого за второй этап:', unit: null, price: null },
        { name: 'Монтажные работы / Стяжка пола', unit: null, price: null },
        { type: 'работа', name: 'Стяжка пола', unit: 'м2', price: '700' },
      ],
    };
    const { items, report } = mergeEditions([edition]);

    expect(items).toHaveLength(2);
    // Работа после маркеров попала в свой раздел, а не во «Второй этап:».
    expect(items.map((i) => i.section)).toEqual(
      expect.arrayContaining(['Демонтажные работы / Стены', 'Монтажные работы / Стяжка пола']),
    );
    expect(items.some((i) => i.section.includes('этап'))).toBe(false);
    expect(report.rejected.filter((r) => r.reason === 'stage_marker')).toHaveLength(2);
  });

  it('поверхность различает одинаковые работы с разной ценой', () => {
    // В прайсе один раздел содержит блоки по поверхностям без заголовков:
    // общие работы повторяются, а потолок дешевле стен.
    const edition: PriceEdition = {
      label: 'test',
      effectiveDate: '2026-01-01',
      rows: [
        { name: 'Предчистовая отделка', unit: null, price: null },
        { type: 'работа', name: 'Обеспыливание', unit: 'м2', price: '160' },
        { type: 'работа', name: 'Шпаклевка стен / до 2-ух слоев', unit: 'м2', price: '1080' },
        { type: 'работа', name: 'Обеспыливание', unit: 'м2', price: '135' },
        { type: 'работа', name: 'Шпаклевка потолка / до 2-ух слоев', unit: 'м2', price: '1080' },
      ],
    };
    const { items } = mergeEditions([edition]);

    const dedusting = items.filter((i) => i.name === 'Обеспыливание');
    expect(dedusting).toHaveLength(2);
    expect(dedusting.find((i) => i.surface === 'стены')?.priceKopecks).toBe(16000);
    expect(dedusting.find((i) => i.surface === 'потолок')?.priceKopecks).toBe(13500);
    // Это не неоднозначность: поверхность их однозначно различает.
    expect(dedusting.every((i) => !i.ambiguous)).toBe(true);
  });

  it('определение поверхности работает на кириллице', () => {
    // \\b и \\w в JavaScript не работают с кириллицей — регрессия на эту ловушку.
    expect(detectSurface('Шпаклевка стен / до 2-ух слоев')).toBe('стены');
    expect(detectSurface('Финишная шпаклевка потолка')).toBe('потолок');
    expect(detectSurface('Устройство откосов оконных')).toBe('откосы');
    expect(detectSurface('Монтаж напольного плинтуса')).toBe('пол');
    expect(detectSurface('Обеспыливание')).toBeNull();
  });
});
