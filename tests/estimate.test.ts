import { describe, it, expect, beforeEach } from 'vitest';
import type { Db } from '../src/db/index.js';
import { makeDb, seedPriceList } from './helpers.js';
import {
  calculateEstimate,
  verifyAgainstPriceList,
  applyManualQuantity,
  getActivePriceListVersion,
  getPriceItemsByCode,
  type VolumeClaim,
} from '../src/domain/estimate/calculate.js';
import { checkCompleteness } from '../src/domain/estimate/completeness.js';
import { toMilliQty } from '../src/shared/money.js';

let db: Db;
let versionId: string;

const PRICE_ROWS = [
  { code: 'W-PLASTER', name: 'Штукатурка стен', unit: 'м2', priceKopecks: 45000, section: 'Стены', sectionNo: 1 },
  { code: 'W-PUTTY', name: 'Шпаклевка стен', unit: 'м2', priceKopecks: 25000, section: 'Стены', sectionNo: 1 },
  { code: 'W-SCREED', name: 'Стяжка пола', unit: 'м2', priceKopecks: 50000, section: 'Полы', sectionNo: 2 },
  { code: 'W-SOCKET', name: 'Установка розетки', unit: 'шт', priceKopecks: 35000, section: 'Электрика', sectionNo: 3 },
];

beforeEach(() => {
  db = makeDb();
  versionId = seedPriceList(db, PRICE_ROWS).versionId;
});

const claim = (code: string, quantity: number, over: Partial<VolumeClaim> = {}): VolumeClaim => ({
  code,
  quantity,
  confidence: 'confirmed',
  ...over,
});

describe('строка сметы считается по активному прайсу', () => {
  it('сумма строки = объём × цена из прайса', () => {
    const est = calculateEstimate(db, {
      documentType: 'full_project',
      areaMilli: toMilliQty(50),
      claims: [claim('W-PLASTER', 120)],
    });

    expect(est.lines).toHaveLength(1);
    // 120 м² × 450,00 ₽ = 54 000,00 ₽
    expect(est.lines[0]!.amountKopecks).toBe(5_400_000);
    expect(est.lines[0]!.priceKopecks).toBe(45000);
    expect(est.totalKopecks).toBe(5_400_000);
  });

  it('каждая строка ссылается на позицию активного прайса', () => {
    const est = calculateEstimate(db, {
      documentType: 'full_project',
      areaMilli: toMilliQty(50),
      claims: [claim('W-PLASTER', 10), claim('W-SCREED', 20)],
    });

    const active = getActivePriceListVersion(db);
    expect(est.priceListVersionId).toBe(active.id);
    for (const line of est.lines) {
      expect(line.priceItemId).toBeTruthy();
      expect(PRICE_ROWS.map((r) => r.code)).toContain(line.code);
    }
  });

  it('в смете видна версия и источник прайса', () => {
    const est = calculateEstimate(db, {
      documentType: 'full_project',
      areaMilli: null,
      claims: [claim('W-PLASTER', 1)],
    });
    expect(est.priceListLabel).toContain('05.08.2026');
  });

  it('без активного прайса расчёт не выполняется', () => {
    db.prepare('UPDATE price_list_versions SET is_active = 0').run();
    expect(() =>
      calculateEstimate(db, { documentType: 'full_project', areaMilli: null, claims: [] }),
    ).toThrow(/прайс-лист не загружен/i);
  });
});

describe('цену нельзя подменить со стороны клиента', () => {
  it('заявка на объём не содержит поля цены — цена берётся только из БД', () => {
    // Даже если в объект заявки подложить цену, она игнорируется:
    // тип VolumeClaim её не содержит, а расчёт читает прайс из БД.
    const hostile = { ...claim('W-PLASTER', 10), priceKopecks: 1, price: 1, amount: 1 };

    const est = calculateEstimate(db, {
      documentType: 'full_project',
      areaMilli: null,
      claims: [hostile as VolumeClaim],
    });

    expect(est.lines[0]!.priceKopecks).toBe(45000);
    expect(est.lines[0]!.amountKopecks).toBe(450_000);
  });

  it('подделанная сумма отклоняется серверной перепроверкой', () => {
    const est = calculateEstimate(db, {
      documentType: 'full_project',
      areaMilli: null,
      claims: [claim('W-PLASTER', 10)],
    });

    expect(verifyAgainstPriceList(db, versionId, est.lines)).toEqual({ ok: true });

    const tampered = est.lines.map((l) => ({ ...l, priceKopecks: 1, amountKopecks: 10 }));
    const result = verifyAgainstPriceList(db, versionId, tampered);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems.join(' ')).toMatch(/цена .* не совпадает/i);
  });

  it('подменённая единица измерения отклоняется', () => {
    const est = calculateEstimate(db, {
      documentType: 'full_project',
      areaMilli: null,
      claims: [claim('W-PLASTER', 10)],
    });
    const tampered = est.lines.map((l) => ({ ...l, unit: 'шт' }));
    const result = verifyAgainstPriceList(db, versionId, tampered);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems.join(' ')).toMatch(/единица/i);
  });
});

describe('неизвестные объёмы не попадают в итог', () => {
  it('работа вне активного прайса не становится строкой, но видна в примечаниях', () => {
    const est = calculateEstimate(db, {
      documentType: 'full_project',
      areaMilli: null,
      claims: [claim('W-PLASTER', 10), claim('W-НЕСУЩЕСТВУЮЩАЯ', 5)],
    });

    expect(est.lines).toHaveLength(1);
    expect(est.totalKopecks).toBe(450_000);
    const note = est.notes.find((n) => n.title.includes('W-НЕСУЩЕСТВУЮЩАЯ'));
    expect(note?.kind).toBe('omission');
    expect(note?.severity).toBe('critical');
  });

  it('отсутствующие данные показываются отдельно и не растворяются в сумме', () => {
    const est = calculateEstimate(db, {
      documentType: 'layout_only',
      areaMilli: toMilliQty(50),
      claims: [claim('W-PLASTER', 100)],
      unknowns: [
        { title: 'Количество розеток неизвестно', detail: 'На планировке нет схемы электрики' },
        { title: 'Длины трасс неизвестны' },
      ],
    });

    expect(est.totalKopecks).toBe(4_500_000); // только штукатурка
    const excluded = est.notes.filter((n) => n.kind === 'excluded');
    expect(excluded).toHaveLength(2);
    expect(excluded[0]!.title).toContain('розеток');
  });

  it('нулевой объём не превращается в бесплатную строку', () => {
    const est = calculateEstimate(db, {
      documentType: 'full_project',
      areaMilli: null,
      claims: [claim('W-SOCKET', 0)],
    });

    expect(est.lines).toHaveLength(0);
    expect(est.notes.some((n) => n.kind === 'excluded')).toBe(true);
  });
});

describe('предварительная смета по одной планировке', () => {
  it('расчёт по планировке помечается предварительным', () => {
    const est = calculateEstimate(db, {
      documentType: 'layout_only',
      areaMilli: toMilliQty(50),
      claims: [claim('W-PLASTER', 100, { confidence: 'derived' })],
    });
    expect(est.isPreliminary).toBe(true);
  });

  it('полный проект даёт непредварительную смету', () => {
    const est = calculateEstimate(db, {
      documentType: 'full_project',
      areaMilli: toMilliQty(50),
      claims: [claim('W-PLASTER', 100)],
    });
    expect(est.isPreliminary).toBe(false);
  });

  it('частичный проект тоже не выдаётся за точную договорную смету', () => {
    const est = calculateEstimate(db, {
      documentType: 'partial_project',
      areaMilli: toMilliQty(50),
      claims: [claim('W-PLASTER', 100)],
    });
    expect(est.isPreliminary).toBe(true);
  });
});

describe('цена за м² — только производный показатель', () => {
  it('вычисляется делением итога на площадь', () => {
    const est = calculateEstimate(db, {
      documentType: 'full_project',
      areaMilli: toMilliQty(50),
      claims: [claim('W-PLASTER', 100)], // 100 × 450 = 45 000,00 ₽
    });

    expect(est.totalKopecks).toBe(4_500_000);
    // 45 000,00 / 50 = 900,00 ₽/м²
    expect(est.pricePerM2Kopecks).toBe(90_000);
  });

  it('без площади показатель отсутствует, а итог не меняется', () => {
    const est = calculateEstimate(db, {
      documentType: 'full_project',
      areaMilli: null,
      claims: [claim('W-PLASTER', 100)],
    });

    expect(est.pricePerM2Kopecks).toBeNull();
    expect(est.totalKopecks).toBe(4_500_000);
  });
});

describe('ручная правка объёма', () => {
  it('помечается как ручная и теряет статус «подтверждено проектом»', () => {
    const est = calculateEstimate(db, {
      documentType: 'full_project',
      areaMilli: null,
      claims: [claim('W-PLASTER', 100)],
    });
    const line = est.lines[0]!;
    expect(line.confidence).toBe('confirmed');
    expect(line.isManual).toBe(false);

    const item = getPriceItemsByCode(db, versionId, ['W-PLASTER']).get('W-PLASTER')!;
    const edited = applyManualQuantity(line, 120, item);

    expect(edited.isManual).toBe(true);
    expect(edited.confidence).toBe('assumption');
    expect(edited.quantityMilli).toBe(toMilliQty(120));
    // Цена осталась прайсовой, сумма пересчитана кодом.
    expect(edited.priceKopecks).toBe(45000);
    expect(edited.amountKopecks).toBe(5_400_000);
  });

  it('заявка, помеченная ручной, не может прийти со статусом «подтверждено»', () => {
    const est = calculateEstimate(db, {
      documentType: 'full_project',
      areaMilli: null,
      claims: [claim('W-PLASTER', 10, { isManual: true, confidence: 'confirmed' })],
    });
    expect(est.lines[0]!.confidence).toBe('assumption');
    expect(est.lines[0]!.isManual).toBe(true);
  });

  it('нулевой ручной объём отклоняется', () => {
    const est = calculateEstimate(db, {
      documentType: 'full_project',
      areaMilli: null,
      claims: [claim('W-PLASTER', 10)],
    });
    const item = getPriceItemsByCode(db, versionId, ['W-PLASTER']).get('W-PLASTER')!;
    expect(() => applyManualQuantity(est.lines[0]!, 0, item)).toThrow();
  });
});

describe('источник и достоверность каждой строки', () => {
  it('сохраняются файл, страница и указатель на фрагмент', () => {
    const est = calculateEstimate(db, {
      documentType: 'full_project',
      areaMilli: null,
      claims: [
        claim('W-PLASTER', 10, {
          confidence: 'derived',
          source: { fileId: 'f1', page: 4, ref: 'План стен, экспликация' },
        }),
      ],
    });

    const line = est.lines[0]!;
    expect(line.confidence).toBe('derived');
    expect(line.source.page).toBe(4);
    expect(line.source.ref).toContain('экспликация');
  });
});

describe('проверка технологической полноты', () => {
  it('предупреждает о пропущенных блоках, не добавляя строк', () => {
    const est = calculateEstimate(db, {
      documentType: 'full_project',
      areaMilli: toMilliQty(50),
      claims: [claim('W-PLASTER', 100)],
    });

    const before = est.lines.length;
    const notes = checkCompleteness({ estimate: est, initialState: 'concrete' });

    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((n) => n.kind === 'omission')).toBe(true);
    expect(notes.some((n) => n.title.includes('откосы'))).toBe(true);
    // Ни одной строки не добавлено — сумма не изменилась.
    expect(est.lines.length).toBe(before);
    expect(est.totalKopecks).toBe(4_500_000);
  });

  it('не требует демонтажа для бетона и требует для вторички', () => {
    const est = calculateEstimate(db, {
      documentType: 'full_project',
      areaMilli: null,
      claims: [claim('W-PLASTER', 10)],
    });

    const concrete = checkCompleteness({ estimate: est, initialState: 'concrete' });
    const secondary = checkCompleteness({ estimate: est, initialState: 'secondary' });

    expect(concrete.some((n) => n.title.includes('Демонтаж'))).toBe(false);
    expect(secondary.some((n) => n.title.includes('Демонтаж'))).toBe(true);
  });

  it('пустая смета не порождает предупреждений', () => {
    const est = calculateEstimate(db, {
      documentType: 'layout_only',
      areaMilli: null,
      claims: [],
    });
    expect(checkCompleteness({ estimate: est })).toEqual([]);
  });
});
