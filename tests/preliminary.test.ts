import { describe, it, expect, beforeEach } from 'vitest';
import type { Db } from '../src/db/index.js';
import { makeDb, seedPriceList } from './helpers.js';
import { deriveQuantities, DEFAULT_ASSUMPTIONS } from '../src/domain/estimate/geometry.js';
import { resolveRules, type WorkRule } from '../src/domain/estimate/ruleset.js';
import { calculatePreliminaryEstimate } from '../src/domain/estimate/preliminary.js';
import { lineAmount, toMilliQty } from '../src/shared/money.js';

/**
 * Предварительный расчёт по геометрии.
 *
 * ВНИМАНИЕ: методика вывода объёмов НЕ калибрована по реальной смете
 * «Капсулы», поэтому путь отключён в API и интерфейсе. Тесты проверяют
 * механику (формулы воспроизводимы, подбор работ корректен), но НЕ
 * подтверждают правильность коэффициентов — их предстоит заменить.
 *
 * Проверяется не «примерно похоже», а точные значения формул: смета
 * должна быть воспроизводимой, иначе её нельзя проверить руками.
 */

describe('вывод объёмов из геометрии', () => {
  const q = (id: string, area = 52.4, rooms = 2) =>
    deriveQuantities({ areaM2: area, rooms, initialState: 'concrete' }).find((x) => x.id === id)!;

  it('площадь пола и потолка следуют из подтверждённой площади', () => {
    expect(q('floor_area').value).toBe(52.4);
    expect(q('floor_area').confidence).toBe('derived');
    expect(q('ceiling_area').value).toBe(52.4);
    expect(q('ceiling_area').confidence).toBe('derived');
  });

  it('периметр и перегородки помечены допущением', () => {
    // 4,1 × √52,4 = 29,679
    expect(q('perimeter').value).toBeCloseTo(29.679, 3);
    expect(q('perimeter').confidence).toBe('assumption');
    // 0,6 × 29,679 = 17,807
    expect(q('partitions_length').value).toBeCloseTo(17.807, 3);
  });

  it('площадь стен считает обе стороны перегородок и вычитает проёмы', () => {
    // (29,679 + 2 × 17,807) × 2,7 − (2 × 1,8 + 3 × 1,7) = 167,593
    expect(q('wall_area').value).toBeCloseTo(167.593, 2);
    expect(q('wall_area').formula).toContain('перегородки отделываются с двух сторон');
  });

  it('формула видна пользователю и содержит подставленные числа', () => {
    expect(q('perimeter').formula).toBe('4.1 × √52.4 = 29.679 м.п.');
    expect(q('waste_tons').formula).toContain('52.4 м² × 0.03 т/м²');
  });

  it('указанные сотрудником окна становятся подтверждёнными', () => {
    const withWindows = deriveQuantities({
      areaM2: 52.4,
      rooms: 2,
      initialState: 'concrete',
      windows: 5,
    });
    const windows = withWindows.find((x) => x.id === 'windows_count')!;
    expect(windows.value).toBe(5);
    expect(windows.confidence).toBe('derived');
  });

  it('высота потолка меняет только площадь стен', () => {
    const low = deriveQuantities({ areaM2: 52.4, rooms: 2, initialState: 'concrete' });
    const high = deriveQuantities(
      { areaM2: 52.4, rooms: 2, initialState: 'concrete' },
      { ...DEFAULT_ASSUMPTIONS, ceilingHeight: 3.2 },
    );
    const wall = (list: typeof low) => list.find((x) => x.id === 'wall_area')!.value;
    const floor = (list: typeof low) => list.find((x) => x.id === 'floor_area')!.value;

    expect(wall(high)).toBeGreaterThan(wall(low));
    expect(floor(high)).toBe(floor(low));
  });

  it('нулевая или отрицательная площадь отвергается', () => {
    expect(() => deriveQuantities({ areaM2: 0, rooms: 2, initialState: 'concrete' })).toThrow();
    expect(() => deriveQuantities({ areaM2: -5, rooms: 2, initialState: 'concrete' })).toThrow();
  });

  it('расчёт воспроизводим: одни данные — один результат', () => {
    const a = deriveQuantities({ areaM2: 63.7, rooms: 3, initialState: 'secondary' });
    const b = deriveQuantities({ areaM2: 63.7, rooms: 3, initialState: 'secondary' });
    expect(a).toEqual(b);
  });
});

describe('сопоставление правил с прайсом', () => {
  let db: Db;
  let versionId: string;

  beforeEach(() => {
    db = makeDb();
    versionId = seedPriceList(db, [
      {
        code: 'W-PLASTER',
        name: 'Штукатурка стен по маякам / слой до 30 мм',
        unit: 'м2',
        priceKopecks: 162000,
        section: 'Стены',
      },
      {
        code: 'W-SCREED-CHEAP',
        name: 'Стяжка пола полусухая / слой до 80 мм',
        unit: 'м2',
        priceKopecks: 140000,
        section: 'Стяжка пола',
      },
      {
        code: 'W-SCREED-WET',
        name: 'Стяжка пола мокрая / слой до 80 мм',
        unit: 'м2',
        priceKopecks: 168000,
        section: 'Стяжка пола',
      },
      {
        code: 'W-FILM-SCREED',
        name: 'Укрывные мероприятия / пленка',
        unit: 'м2',
        priceKopecks: 24000,
        section: 'Стяжка пола',
      },
      {
        code: 'W-FILM-PREP',
        name: 'Укрывные / застилочные мероприятия / пленка',
        unit: 'м2',
        priceKopecks: 37500,
        section: 'Укрывные работы',
      },
    ]).versionId;
    db.prepare("UPDATE price_items SET surface = 'стены' WHERE code = 'W-PLASTER'").run();
    db.prepare("UPDATE price_items SET surface = 'пол' WHERE code LIKE 'W-SCREED%'").run();
  });

  const quantities = () => deriveQuantities({ areaM2: 52.4, rooms: 2, initialState: 'concrete' });
  const ctx = { initialState: 'concrete' as const, rooms: 2, hasWetZones: true };

  it('из нескольких подходящих берёт самую дешёвую и показывает остальные', () => {
    const rule: WorkRule = {
      id: 'screed',
      title: 'Стяжка',
      quantity: 'floor_area',
      all: ['стяжка пола'],
      unit: 'м2',
    };
    const { resolved } = resolveRules(db, versionId, quantities(), ctx, [rule]);

    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.item.code).toBe('W-SCREED-CHEAP');
    expect(resolved[0]!.candidateCount).toBe(2);
    expect(resolved[0]!.alternatives[0]!.code).toBe('W-SCREED-WET');
  });

  it('подсказка раздела важнее дешевизны', () => {
    // Регрессия: «укрывные плёнкой» бралось из раздела стяжки,
    // потому что там позиция дешевле.
    const withoutHint: WorkRule = {
      id: 'film',
      title: 'Укрывные',
      quantity: 'floor_area',
      all: ['укрывные', 'пленка'],
      unit: 'м2',
    };
    const withHint: WorkRule = { ...withoutHint, sectionHint: 'укрывные' };

    expect(resolveRules(db, versionId, quantities(), ctx, [withoutHint]).resolved[0]!.item.code).toBe(
      'W-FILM-SCREED',
    );
    expect(resolveRules(db, versionId, quantities(), ctx, [withHint]).resolved[0]!.item.code).toBe(
      'W-FILM-PREP',
    );
  });

  it('несовпадение единиц отклоняет правило, а не пересчитывает наугад', () => {
    const rule: WorkRule = {
      id: 'slopes',
      title: 'Откосы',
      // Объём в м.п., а позиция в м2 — пересчёт был бы выдумкой.
      quantity: 'slopes_length',
      all: ['штукатурка стен'],
      unit: 'м2',
    };
    const { resolved, unresolved } = resolveRules(db, versionId, quantities(), ctx, [rule]);

    expect(resolved).toHaveLength(0);
    expect(unresolved[0]!.reason).toBe('unit_mismatch');
  });

  it('отсутствие позиции в прайсе фиксируется, а не замалчивается', () => {
    const rule: WorkRule = {
      id: 'missing',
      title: 'Несуществующая работа',
      quantity: 'floor_area',
      all: ['такой работы нет в прайсе'],
    };
    const { unresolved } = resolveRules(db, versionId, quantities(), ctx, [rule]);
    expect(unresolved[0]!.reason).toBe('no_price_item');
  });

  it('правило с условием не применяется, когда условие не выполнено', () => {
    const rule: WorkRule = {
      id: 'demo',
      title: 'Демонтаж',
      quantity: 'wall_area',
      all: ['штукатурка стен'],
      unit: 'м2',
      appliesWhen: (c) => c.initialState === 'secondary',
    };
    const { resolved, unresolved } = resolveRules(db, versionId, quantities(), ctx, [rule]);
    expect(resolved).toHaveLength(0);
    expect(unresolved).toHaveLength(0);
  });
});

describe('предварительная смета целиком', () => {
  let db: Db;

  beforeEach(() => {
    db = makeDb();
    seedPriceList(db, [
      {
        code: 'W-PLASTER',
        name: 'Штукатурка стен по маякам / слой до 30 мм',
        unit: 'м2',
        priceKopecks: 162000,
        section: 'Стены',
      },
      {
        code: 'W-TARE',
        name: 'Тарирование мусора / сбор мусора в мешки',
        unit: 'м2',
        priceKopecks: 37500,
        section: 'Укрывные работы',
      },
    ]);
    db.prepare("UPDATE price_items SET surface = 'стены' WHERE code = 'W-PLASTER'").run();
  });

  it('смета помечена предварительной и считает по прайсу', () => {
    const { estimate } = calculatePreliminaryEstimate(db, {
      params: { areaM2: 52.4, rooms: 2, initialState: 'concrete' },
    });

    expect(estimate.isPreliminary).toBe(true);
    expect(estimate.documentType).toBe('layout_only');

    const plaster = estimate.lines.find((l) => l.code === 'W-PLASTER')!;
    // Цена из прайса, объём из формулы, сумма пересчитана кодом.
    expect(plaster.priceKopecks).toBe(162000);
    expect(plaster.amountKopecks).toBe(lineAmount(toMilliQty(167.593), 162000));
    // Источник строки — формула, по которой получен объём.
    expect(plaster.source.ref).toContain('Расчёт по геометрии');
  });

  it('итог равен сумме строк, цена за м² производна', () => {
    const { estimate } = calculatePreliminaryEstimate(db, {
      params: { areaM2: 52.4, rooms: 2, initialState: 'concrete' },
    });
    const sum = estimate.lines.reduce((acc, l) => acc + l.amountKopecks, 0);
    expect(estimate.totalKopecks).toBe(sum);
    expect(estimate.pricePerM2Kopecks).toBe(Math.round((estimate.totalKopecks * 1000) / toMilliQty(52.4)));
  });

  it('предупреждает, что расчёт без документации, и перечисляет коэффициенты', () => {
    const { estimate } = calculatePreliminaryEstimate(db, {
      params: { areaM2: 52.4, rooms: 2, initialState: 'concrete' },
    });
    const titles = estimate.notes.map((n) => n.title).join(' | ');
    expect(titles).toContain('без документации');
    expect(titles).toContain('коэффициенты планировки');
  });

  it('невыводимые величины уходят в «не включено», а не в итог', () => {
    const { estimate } = calculatePreliminaryEstimate(db, {
      params: { areaM2: 52.4, rooms: 2, initialState: 'concrete' },
    });
    const excluded = estimate.notes.filter((n) => n.kind === 'excluded').map((n) => n.title);
    expect(excluded.join(' ')).toMatch(/розето?к|выключател/i);
    expect(excluded.join(' ')).toMatch(/сантехнических точек/i);
    // Ни одна из них не стала строкой сметы.
    expect(estimate.lines.some((l) => /розетк/i.test(l.name))).toBe(false);
  });

  it('правила без позиции в прайсе показываются как пропуски', () => {
    const { estimate, unresolved } = calculatePreliminaryEstimate(db, {
      params: { areaM2: 52.4, rooms: 2, initialState: 'concrete' },
    });
    // В тестовом прайсе почти ничего нет, поэтому пропусков много.
    expect(unresolved.length).toBeGreaterThan(0);
    const omissions = estimate.notes.filter((n) => n.kind === 'omission');
    expect(omissions.some((n) => n.title.startsWith('Не включено'))).toBe(true);
  });

  it('без активного прайса расчёт не выполняется', () => {
    db.prepare('UPDATE price_list_versions SET is_active = 0').run();
    expect(() =>
      calculatePreliminaryEstimate(db, {
        params: { areaM2: 52.4, rooms: 2, initialState: 'concrete' },
      }),
    ).toThrow(/прайс-лист не загружен/i);
  });
});
