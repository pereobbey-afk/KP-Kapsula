import { describe, expect, it } from 'vitest';
import { deriveVolumes, type ProjectQuantities } from '../src/domain/estimate/derive.js';

/**
 * Правила вывода объёмов проверяются на реальном объекте: квартира 1191,
 * улица Академика Волгина, 78,06 м². Слева — величины ведомостей проекта,
 * справа — объёмы, которые сметчик проставил в смету вручную.
 *
 * Это не искусственный пример: каждое ожидание ниже взято из настоящей
 * сметы, а не придумано под код. Если правило изменится, тест покажет,
 * что расчёт разошёлся с работой сметчика.
 */

/** Величины, снятые с ведомостей проекта 1191. */
const PROJECT_1191: ProjectQuantities = {
  totalAreaM2: 78.06,
  floorTileM2: 30.42,
  laminateM2: 47.62,
  skirtingM: 56.512,
  heatedFloorM2: 17.37,
  wallPaintedM2: 144.05,
  wallTiledM2: 50.37,
  wallPanelsM2: 63.74,
  soundproofCeilingM2: 17.79,
  soundproofWallsM2: 11.87,
  electricModules: 95,
  wallTileFormat: 'от 60 см. до 120 см.',
  floorTileFormat: 'от 60 см. до 120 см.',
  laminatePattern: 'французская елка',
  skirtingKind: 'дюрополимерного',
};

function quantityOf(quantities: ProjectQuantities, key: string): number | undefined {
  return deriveVolumes(quantities).volumes.find((volume) => volume.key === key)?.quantity;
}

describe('вывод объёмов по методике «Капсулы»', () => {
  it('подготовку объекта считает по площади из экспликации', () => {
    expect(quantityOf(PROJECT_1191, 'debris')).toBe(78.06);
    expect(quantityOf(PROJECT_1191, 'cover_film')).toBe(78.06);
    expect(quantityOf(PROJECT_1191, 'self_leveling')).toBe(78.06);
  });

  it('гидроизоляцию считает по площади плитки, а не мокрых зон', () => {
    // 50,37 стены + 30,42 пол
    expect(quantityOf(PROJECT_1191, 'waterproofing')).toBe(80.79);
  });

  it('грунтовку в разделе плитки считает как пол плюс площадь под плитку', () => {
    // 78,06 пол + 80,79 плитка
    expect(quantityOf(PROJECT_1191, 'primer_tiling')).toBe(158.85);
  });

  it('малярный цикл идёт по площади стен под покраску, а не по всем стенам', () => {
    for (const key of ['primer_prepaint', 'putty', 'sanding', 'putty_finish']) {
      expect(quantityOf(PROJECT_1191, key), key).toBe(144.05);
    }
  });

  it('обои и покраска идут по одной площади и складываются', () => {
    // Технология «обои под покраску + покраска»: обои клеятся, затем красятся.
    for (const key of ['wallpaper', 'paint_reveal', 'paint']) {
      expect(quantityOf(PROJECT_1191, key), key).toBe(144.05);
    }
  });

  it('перегородку с шумоизоляцией считает одним пирогом по одной площади', () => {
    for (const key of ['partition_frame', 'wall_soundproofing', 'partition_sheets']) {
      expect(quantityOf(PROJECT_1191, key), key).toBe(11.87);
    }
  });

  it('площади отдельных помещений тоже идут в дело', () => {
    // Шумоизоляция потолка — площадь спальни, а не всей квартиры.
    expect(quantityOf(PROJECT_1191, 'ceiling_soundproofing')).toBe(17.79);
  });

  it('не выдумывает объём, когда решение проекта не указано', () => {
    const withoutFormat: ProjectQuantities = {
      ...PROJECT_1191,
      wallTileFormat: null,
      laminatePattern: null,
    };
    const result = deriveVolumes(withoutFormat);

    expect(result.volumes.find((v) => v.key === 'wall_tile')).toBeUndefined();
    expect(result.volumes.find((v) => v.key === 'laminate')).toBeUndefined();
    expect(result.unknowns.map((u) => u.title)).toEqual([
      'Настенная плитка: в проекте не указан формат',
      'Ламинат: в проекте не указан рисунок укладки',
    ]);
  });

  it('не выводит работы, которых нет в проекте', () => {
    const bareShell: ProjectQuantities = {
      ...PROJECT_1191,
      wallTiledM2: 0,
      floorTileM2: 0,
      wallPanelsM2: 0,
      soundproofCeilingM2: null,
      soundproofWallsM2: null,
    };
    const keys = deriveVolumes(bareShell).volumes.map((v) => v.key);

    expect(keys).not.toContain('waterproofing');
    expect(keys).not.toContain('wall_tile');
    expect(keys).not.toContain('panels');
    expect(keys).not.toContain('ceiling_soundproofing');
    expect(keys).not.toContain('partition_frame');
    // А малярный цикл на месте: стены под покраску никуда не делись.
    expect(keys).toContain('paint');
  });

  it('каждый выведенный объём несёт проверяемую формулу', () => {
    for (const volume of deriveVolumes(PROJECT_1191).volumes) {
      expect(volume.basis, volume.key).not.toBe('');
    }
  });
});
