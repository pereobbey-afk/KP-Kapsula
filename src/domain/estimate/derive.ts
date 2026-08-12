import type { UnknownVolume } from './calculate.js';

/**
 * Вывод объёмов работ из величин проекта.
 *
 * Методика восстановлена по паре «дизайн-проект + смета» и описана
 * в docs/methodology.md. Главное её свойство: объёмы не выводятся из
 * площади квартиры — они берутся из ведомостей проекта. Здесь код
 * делает только то, что делает сметчик с калькулятором: раскладывает
 * готовые величины ведомостей по позициям прайса и складывает те
 * немногие суммы, которые в ведомостях не подсчитаны.
 *
 * Инварианты, которые обеспечивает этот модуль:
 *
 *  1. Ни одна величина не выдумывается. Если решение проекта не
 *     указано (формат плитки, рисунок укладки), работа уходит в
 *     «не включено», а не в смету с придуманным объёмом.
 *  2. Каждая производная величина несёт словесную формулу вывода
 *     (`basis`), которую сотрудник может проверить по проекту.
 *  3. Цен здесь нет. Модуль возвращает позицию прайса и объём;
 *     цену подставляет `calculateEstimate` из активной версии прайса.
 */

/** Позиция прайса: наименование, единица и раздел. */
export type PricePosition = {
  name: string;
  unit: string;
  section: string;
};

/** Исходные величины, снятые с ведомостей проекта. */
export type ProjectQuantities = {
  /** Экспликация помещений: итог по квартире, м². */
  totalAreaM2: number;
  /** Ведомость напольного покрытия: суммарная площадь плитки, м². */
  floorTileM2: number;
  /** Ведомость напольного покрытия: суммарная площадь ламината, м². */
  laminateM2: number;
  /** Ведомость плинтусов: суммарная длина, м.п. */
  skirtingM: number | null;
  /** Ведомость тёплого пола: суммарная площадь зон, м². */
  heatedFloorM2: number;
  /** Ведомость отделки стен: «Обои под покраску + покраска», м². */
  wallPaintedM2: number;
  /** Ведомость отделки стен: керамогранит на стенах, м². */
  wallTiledM2: number;
  /** Ведомость отделки стен: декоративные панели, м². */
  wallPanelsM2: number;
  /** Площадь потолка под шумоизоляцию, если проект её предусматривает, м². */
  soundproofCeilingM2: number | null;
  /** Ведомость черновой отделки: площадь шумоизоляции стен, м². */
  soundproofWallsM2: number | null;
  /** Ведомость электроблоков: число механизмов (оно же число подрозетников). */
  electricModules: number | null;

  /**
   * Решения проекта, от которых зависит выбор позиции прайса.
   * Пустое значение означает «в проекте не указано» и уводит работу
   * в «не включено»: угадывать формат плитки нельзя, цены отличаются
   * в разы.
   */
  wallTileFormat: string | null;
  floorTileFormat: string | null;
  laminatePattern: string | null;
  skirtingKind: string | null;
};

export type DerivedVolume = {
  /** Устойчивый ключ правила — по нему пишутся тесты и сверка. */
  key: string;
  position: PricePosition;
  quantity: number;
  /** Словесная формула вывода. Попадает в примечание строки сметы. */
  basis: string;
};

export type DerivedVolumes = {
  volumes: DerivedVolume[];
  unknowns: UnknownVolume[];
};

const SECTION = {
  demolition: 'Демонтажных работ / Комплексы демонтажных работ / Укрывные работы',
  tiling: 'Монтажные работы / Подготовительные работы / Укладка плитки / Гидроизоляция',
  prePaint: 'Монтажные работы / Подготовительные малярные работы / Предчистовая отделка',
  paint: 'Монтажные работы / Малярные работы / Чистовая отделка',
  floors: 'Монтажные работы / Напольные покрытия / Чистовая отделка',
  gkl: 'Монтажные работы / ГКЛ конструкций / Шумоизоляция / Вентиляция ПВХ',
  electricEngineering: 'Монтажные работы / Инженерная электрика',
  electricFinish: 'Монтажные работы / Чистовая электрика',
} as const;

const M2 = 'м2';
const MP = 'м.п.';
const PCS = 'шт';

/** Округление до сотых: объёмы в проекте даны с двумя знаками. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Выводит объёмы работ.
 *
 * Правила ниже проверены совпадением с реальной сметой объекта 1191;
 * каждое из них помечено словесной формулой вывода.
 */
export function deriveVolumes(q: ProjectQuantities): DerivedVolumes {
  const volumes: DerivedVolume[] = [];
  const unknowns: UnknownVolume[] = [];

  const add = (key: string, position: PricePosition, quantity: number, basis: string): void => {
    if (quantity > 0) volumes.push({ key, position, quantity: round2(quantity), basis });
  };

  // --- Подготовка объекта: по площади квартиры из экспликации ---

  if (q.totalAreaM2 > 0) {
    const area = q.totalAreaM2;
    const basis = `площадь квартиры по экспликации — ${area} м²`;

    add(
      'debris',
      {
        name: 'Тарирование мусора / сбор мусора в мешки (работа)',
        unit: M2,
        section: SECTION.demolition,
      },
      area,
      basis,
    );
    add(
      'cover_film',
      {
        name: 'Укрывные / застилочные мероприятия / пленка (работа)',
        unit: M2,
        section: SECTION.demolition,
      },
      area,
      basis,
    );
    add(
      'self_leveling',
      {
        name: 'Наливной пол до 10 мм. (работа)',
        unit: M2,
        section: SECTION.tiling,
      },
      area,
      basis,
    );
  }

  // --- Плитка ---

  const tileTotal = q.wallTiledM2 + q.floorTileM2;

  if (tileTotal > 0) {
    add(
      'waterproofing',
      {
        name: 'Гидроизоляция обмазочная в 2-а слоя (работа)',
        unit: M2,
        section: SECTION.tiling,
      },
      tileTotal,
      `плитка на стенах ${q.wallTiledM2} м² + плитка на полу ${q.floorTileM2} м²`,
    );

    add(
      'primer_tiling',
      {
        name: 'Грунтовка / до 2-ух слоев (работа)',
        unit: M2,
        section: SECTION.tiling,
      },
      q.totalAreaM2 + tileTotal,
      `площадь пола ${q.totalAreaM2} м² + площадь под плитку ${round2(tileTotal)} м²`,
    );
  }

  if (q.wallTiledM2 > 0) {
    if (q.wallTileFormat) {
      add(
        'wall_tile',
        {
          name: `Монтаж настенной плитки с подрезкой / формат плитки ${q.wallTileFormat} (работа)`,
          unit: M2,
          section: SECTION.tiling,
        },
        q.wallTiledM2,
        'ведомость отделки стен: керамогранит на стенах',
      );
      add(
        'wall_tile_grout',
        {
          name: `Монтаж цементной затирки / формат плитки ${q.wallTileFormat} (работа)`,
          unit: M2,
          section: SECTION.tiling,
        },
        q.wallTiledM2,
        'по площади настенной плитки',
      );
    } else {
      unknowns.push({
        title: 'Настенная плитка: в проекте не указан формат',
        detail:
          `Площадь известна — ${q.wallTiledM2} м², но цена зависит от формата плитки ` +
          'и отличается в разы. Укажите формат, чтобы работа попала в смету.',
      });
    }
  }

  if (q.floorTileM2 > 0) {
    if (q.floorTileFormat) {
      add(
        'floor_tile',
        {
          name: `Монтаж напольной плитки с подрезкой / формат плитки ${q.floorTileFormat} (работа)`,
          unit: M2,
          section: SECTION.tiling,
        },
        q.floorTileM2,
        'ведомость напольного покрытия: керамогранит',
      );
      add(
        'floor_tile_grout',
        {
          name: `Монтаж цементной затирки / формат плитки ${q.floorTileFormat} (работа)`,
          unit: M2,
          section: SECTION.tiling,
        },
        q.floorTileM2,
        'по площади напольной плитки',
      );
    } else {
      unknowns.push({
        title: 'Напольная плитка: в проекте не указан формат',
        detail: `Площадь известна — ${q.floorTileM2} м², формат — нет.`,
      });
    }
  }

  // --- Малярный цикл: только по стенам под покраску и обои ---

  if (q.wallPaintedM2 > 0) {
    const area = q.wallPaintedM2;
    const basis = 'ведомость отделки стен: «Обои под покраску + покраска»';

    add(
      'primer_prepaint',
      { name: 'Грунтовка / до 2-ух слоев (работа)', unit: M2, section: SECTION.prePaint },
      area,
      basis,
    );
    add(
      'putty',
      { name: 'Шпаклевка стен / до 2-ух слоев (работа)', unit: M2, section: SECTION.prePaint },
      area,
      basis,
    );
    add(
      'sanding',
      { name: 'Ошкуривание шпаклевки (работа)', unit: M2, section: SECTION.prePaint },
      area,
      basis,
    );
    add(
      'putty_finish',
      {
        name: 'Финишная шпаклевка стен / до 3-ух слоев (работа)',
        unit: M2,
        section: SECTION.prePaint,
      },
      area,
      basis,
    );

    // Технология «обои под покраску + покраска»: сначала обои, затем краска.
    // Это не взаимоисключающие варианты, объёмы складываются.
    add(
      'primer_wallpaper',
      { name: 'Грунтовка стен / до 2-ух слоев (работа)', unit: M2, section: SECTION.paint },
      area,
      `${basis} — грунт под обои`,
    );
    add(
      'wallpaper',
      { name: 'Монтаж обоев / с подбором рисунка (работа)', unit: M2, section: SECTION.paint },
      area,
      basis,
    );
    add(
      'primer_paint',
      { name: 'Грунтовка стен / до 2-ух слоев (работа)', unit: M2, section: SECTION.paint },
      area,
      `${basis} — грунт под покраску`,
    );
    add(
      'paint_reveal',
      {
        name: 'Покраска стен / проявочный слой / валик (работа)',
        unit: M2,
        section: SECTION.paint,
      },
      area,
      basis,
    );
    add(
      'paint',
      { name: 'Покраска стен / до 2-ух слоев / валик (работа)', unit: M2, section: SECTION.paint },
      area,
      basis,
    );
  }

  // --- Декоративные панели ---

  if (q.wallPanelsM2 > 0) {
    add(
      'panels',
      {
        name: 'Монтаж декоративной Бамбуковых панелей (работа)',
        unit: M2,
        section: SECTION.paint,
      },
      q.wallPanelsM2,
      'ведомость отделки стен: сумма позиций бамбуковых панелей',
    );
  }

  // --- Полы ---

  if (q.laminateM2 > 0) {
    if (q.laminatePattern) {
      add(
        'laminate',
        {
          name: `Монтаж ламината / замкового типа / ${q.laminatePattern} (работа)`,
          unit: M2,
          section: SECTION.floors,
        },
        q.laminateM2,
        'ведомость напольного покрытия',
      );
    } else {
      unknowns.push({
        title: 'Ламинат: в проекте не указан рисунок укладки',
        detail:
          `Площадь известна — ${q.laminateM2} м². Цена зависит от рисунка: ` +
          'от «в разбежку» до «французской ёлки» разница более чем вдвое.',
      });
    }
  }

  if (q.skirtingM && q.skirtingM > 0) {
    if (q.skirtingKind) {
      add(
        'skirting',
        {
          name: `Монтаж ${q.skirtingKind} плинтуса (работа)`,
          unit: MP,
          section: SECTION.floors,
        },
        q.skirtingM,
        'ведомость плинтусов: суммарная длина',
      );
    } else {
      unknowns.push({
        title: 'Плинтус: в проекте не указан материал',
        detail: `Длина известна — ${q.skirtingM} м.п., материал — нет.`,
      });
    }
  }

  // --- Инженерия ---

  if (q.heatedFloorM2 > 0) {
    add(
      'heated_floor',
      {
        name: 'Монтаж теплого пола (работа)',
        unit: M2,
        section: SECTION.electricEngineering,
      },
      q.heatedFloorM2,
      'ведомость тёплого пола: сумма зон обогрева',
    );
  }

  if (q.soundproofCeilingM2 && q.soundproofCeilingM2 > 0) {
    add(
      'ceiling_soundproofing',
      {
        name: 'Шумоизоляция потолок ЗИПС / РУС панелями в 2-а слоя до 30 мм. (работа)',
        unit: M2,
        section: SECTION.gkl,
      },
      q.soundproofCeilingM2,
      'площадь помещения, где проект предусматривает шумоизоляцию потолка',
    );
  }

  // Перегородка с шумоизоляцией — один пирог: каркас, звукоизоляция и
  // два слоя ГКЛ идут по одной площади. Проверено на объекте 1191:
  // в смете все три позиции стоят с площадью шумоизоляции, а не с
  // площадью гипсокартона из той же ведомости.
  if (q.soundproofWallsM2 && q.soundproofWallsM2 > 0) {
    const area = q.soundproofWallsM2;
    const basis = 'ведомость черновой отделки: площадь шумоизоляции стен';

    add(
      'partition_frame',
      {
        name: 'Монтаж каркаса под перегородки из ГКЛ / ВГКЛ (работа)',
        unit: M2,
        section: SECTION.gkl,
      },
      area,
      basis,
    );
    add(
      'wall_soundproofing',
      {
        name: 'Руллоная звукоизоляция стен в 2-а слоя (работа)',
        unit: M2,
        section: SECTION.gkl,
      },
      area,
      basis,
    );
    add(
      'partition_sheets',
      {
        name: 'Монтаж ГКЛ / ВГКЛ / ЗГКЛ на основание стены / на клей 2-а слоя (работа)',
        unit: M2,
        section: SECTION.gkl,
      },
      area,
      basis,
    );
  }

  if (q.electricModules && q.electricModules > 0) {
    const basis = `ведомость электроблоков: ${q.electricModules} механизмов`;
    add(
      'socket_boxes',
      {
        name: 'Монтаж подрозетника розетки / выключателя (работа)',
        unit: PCS,
        section: SECTION.electricEngineering,
      },
      q.electricModules,
      basis,
    );
    add(
      'socket_mechanisms',
      {
        name: 'Монтаж механизма розетки / выключателя / накладной монтаж (работа)',
        unit: PCS,
        section: SECTION.electricFinish,
      },
      q.electricModules,
      basis,
    );
  }

  return { volumes, unknowns };
}
