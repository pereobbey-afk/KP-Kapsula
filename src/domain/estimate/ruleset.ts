import type { Db } from '../../db/index.js';
import { normalizeText, normalizeUnit } from '../pricelist/normalize.js';
import type { DerivedQuantity, InitialState } from './geometry.js';

/**
 * Правила предварительного расчёта: какие работы нужны объекту и каким
 * объёмом они считаются.
 *
 * Правило не хранит ни цену, ни код позиции: оно описывает работу словами
 * и находит её в активном прайсе. Поэтому смена прайса не ломает правила,
 * а цена по-прежнему приходит только из БД.
 *
 * Поиск идёт по наименованию позиции, а не по разделу: название раздела
 * содержит десятки слов и давало бы ложные совпадения.
 */

export type RuleContext = {
  initialState: InitialState;
  rooms: number;
  /** Есть ли мокрые зоны. */
  hasWetZones: boolean;
};

export type WorkRule = {
  id: string;
  title: string;
  /** Идентификатор выведенной величины из geometry.ts. */
  quantity: string;
  /** Все слова должны встретиться в наименовании позиции. */
  all: string[];
  /** Ни одно из этих слов не должно встретиться. */
  none?: string[];
  unit?: string;
  surface?: string;
  /**
   * Подсказка раздела. Не жёсткий фильтр, а приоритет: позиция из
   * ожидаемого раздела выигрывает у более дешёвой из чужого.
   * Без этого «укрывные плёнкой» брались из раздела стяжки.
   */
  sectionHint?: string;
  appliesWhen?: (ctx: RuleContext) => boolean;
  /** Пояснение, почему работа включена. */
  reason?: string;
};

const needsDemolition = (ctx: RuleContext): boolean =>
  ctx.initialState === 'secondary' || ctx.initialState === 'white_box';

/**
 * Состав предварительной сметы.
 *
 * Включены только работы, объём которых выводится из геометрии.
 * Электрика, сантехника и декор сюда не входят: их объём без
 * документации неизвестен, и придумывать его нельзя.
 */
export const PRELIMINARY_RULES: readonly WorkRule[] = [
  // --- Подготовка ---
  {
    id: 'protection_film',
    title: 'Укрывные мероприятия',
    quantity: 'floor_area',
    all: ['укрывные', 'пленка'],
    none: ['потолок'],
    unit: 'м2',
    sectionHint: 'укрывные',
    reason: 'Защита поверхностей на время работ.',
  },
  {
    id: 'waste_bagging',
    title: 'Тарирование мусора',
    quantity: 'floor_area',
    all: ['тарирование'],
    unit: 'м2',
    reason: 'Сбор мусора в мешки по площади объекта.',
  },
  {
    id: 'waste_removal',
    title: 'Вынос мусора и подъём материалов',
    quantity: 'waste_tons',
    all: ['такелажн'],
    unit: 'т',
    reason: 'Масса мусора оценена по площади объекта.',
  },

  // --- Демонтаж: только при наличии основания ---
  //
  // В прайсе демонтаж задан комплексом на м² площади: без снятия стяжки
  // и со снятием. Вторичка предполагает полный демонтаж, White Box —
  // облегчённый. Для бетона демонтажа нет вовсе.
  {
    id: 'demolition_full',
    title: 'Комплекс демонтажных работ (со снятием стяжки)',
    quantity: 'floor_area',
    all: ['комплекс демонтажных', 'стяжки'],
    unit: 'м2',
    appliesWhen: (ctx) => ctx.initialState === 'secondary',
    reason: 'Вторичное жильё: снимается существующая отделка вместе со стяжкой.',
  },
  {
    id: 'demolition_light',
    title: 'Комплекс демонтажных работ (без снятия стяжки)',
    quantity: 'floor_area',
    all: ['комплекс демонтажных'],
    none: ['стяжки'],
    unit: 'м2',
    appliesWhen: (ctx) => ctx.initialState === 'white_box',
    reason: 'White Box: снимается частичная отделка, стяжка остаётся.',
  },

  // --- Стены ---
  {
    id: 'wall_plaster',
    title: 'Штукатурка стен по маякам',
    quantity: 'wall_area',
    all: ['штукатурка стен', 'маяк'],
    none: ['дополнительный'],
    unit: 'м2',
    surface: 'стены',
    reason: 'Выравнивание стен под чистовую отделку.',
  },
  {
    id: 'wall_putty',
    title: 'Шпаклевка стен',
    quantity: 'wall_area',
    all: ['шпаклевка стен'],
    none: ['финишная', 'дополнительный'],
    unit: 'м2',
    surface: 'стены',
    reason: 'Подготовительный слой под финиш.',
  },
  {
    id: 'wall_putty_finish',
    title: 'Финишная шпаклевка стен',
    quantity: 'wall_area',
    all: ['финишная шпаклевка стен'],
    unit: 'м2',
    surface: 'стены',
    reason: 'Финишный слой под покраску или обои.',
  },
  {
    id: 'wall_sanding',
    title: 'Ошкуривание финишной шпаклевки',
    quantity: 'wall_area',
    all: ['ошкуривание финишной'],
    unit: 'м2',
    surface: 'стены',
    reason: 'Обязательная операция перед чистовой отделкой.',
  },

  // --- Откосы ---
  {
    id: 'slopes_plaster',
    title: 'Штукатурка откосов',
    quantity: 'slopes_length',
    all: ['штукатурка откоса'],
    none: ['дополнительный'],
    surface: 'откосы',
    reason: 'Оконные и дверные откосы — частый пропуск в сметах.',
  },

  // --- Потолок ---
  {
    id: 'ceiling_stretch',
    title: 'Монтаж натяжного потолка',
    quantity: 'ceiling_area',
    all: ['натяжного', 'потолка'],
    none: ['демонтаж'],
    unit: 'м2',
    surface: 'потолок',
    reason: 'Базовое потолочное решение.',
  },

  // --- Полы ---
  {
    id: 'floor_prep',
    title: 'Подготовка пола под стяжку',
    quantity: 'floor_area',
    all: ['подготовка пола'],
    unit: 'м2',
    surface: 'пол',
    reason: 'Уборка и подготовка основания.',
  },
  {
    id: 'floor_screed',
    title: 'Стяжка пола',
    quantity: 'floor_area',
    all: ['стяжка пола'],
    none: ['дополнительный', 'демонтаж', 'подготовка', 'армирование'],
    unit: 'м2',
    surface: 'пол',
    sectionHint: 'стяжка',
    reason: 'Выравнивание основания пола.',
  },

  // --- Мокрые зоны ---
  {
    id: 'waterproofing',
    title: 'Гидроизоляция мокрых зон',
    quantity: 'wet_area',
    all: ['гидроизоляция'],
    none: ['демонтаж', 'ниши'],
    unit: 'м2',
    sectionHint: 'гидроизоляц',
    appliesWhen: (ctx) => ctx.hasWetZones,
    reason: 'Обязательна в санузлах и ванных.',
  },
];

export type PriceCandidate = {
  id: string;
  code: string;
  name: string;
  unit: string;
  section: string;
  surface: string | null;
  priceKopecks: number;
  ambiguous: number;
};

export type ResolvedRule = {
  rule: WorkRule;
  quantity: DerivedQuantity;
  item: PriceCandidate;
  /** Сколько позиций прайса подошло под правило. */
  candidateCount: number;
  /** Другие подошедшие позиции — показываются как уточнение. */
  alternatives: PriceCandidate[];
};

export type UnresolvedRule = {
  rule: WorkRule;
  reason: 'no_quantity' | 'no_price_item' | 'unit_mismatch';
  detail: string;
};

/**
 * Сопоставляет правила с позициями активного прайса.
 *
 * Из нескольких подходящих позиций выбирается самая дешёвая: для
 * предварительной сметы занижение безопаснее завышения, а альтернативы
 * показываются пользователю, чтобы выбор не был скрытым.
 */
export function resolveRules(
  db: Db,
  versionId: string,
  quantities: readonly DerivedQuantity[],
  ctx: RuleContext,
  rules: readonly WorkRule[] = PRELIMINARY_RULES,
): { resolved: ResolvedRule[]; unresolved: UnresolvedRule[] } {
  const rows = db
    .prepare(
      `SELECT id, code, name, unit, section, surface, price_kopecks AS priceKopecks, ambiguous
         FROM price_items WHERE version_id = ?`,
    )
    .all(versionId) as PriceCandidate[];

  // Наименования нормализуются один раз: правил много, позиций — сотни.
  const indexed = rows.map((row) => ({
    row,
    name: normalizeText(row.name),
    section: normalizeText(row.section),
  }));
  const byId = new Map(quantities.map((q) => [q.id, q]));

  const resolved: ResolvedRule[] = [];
  const unresolved: UnresolvedRule[] = [];

  for (const rule of rules) {
    if (rule.appliesWhen && !rule.appliesWhen(ctx)) continue;

    const quantity = byId.get(rule.quantity);
    if (!quantity || quantity.value <= 0) {
      unresolved.push({
        rule,
        reason: 'no_quantity',
        detail: `Объём «${rule.quantity}» не вычислен или равен нулю.`,
      });
      continue;
    }

    const wanted = rule.all.map(normalizeText);
    const forbidden = (rule.none ?? []).map(normalizeText);

    const candidates = indexed
      .filter(({ row, name }) => {
        if (rule.unit && normalizeUnit(row.unit) !== normalizeUnit(rule.unit)) return false;
        if (rule.surface && row.surface !== rule.surface) return false;
        if (forbidden.some((word) => name.includes(word))) return false;
        return wanted.every((word) => name.includes(word));
      })
      .sort((a, b) => {
        // Позиция из ожидаемого раздела важнее дешевизны: иначе правило
        // подберёт похожую работу из чужого контекста.
        if (rule.sectionHint) {
          const hint = normalizeText(rule.sectionHint);
          const aHit = a.section.includes(hint) ? 0 : 1;
          const bHit = b.section.includes(hint) ? 0 : 1;
          if (aHit !== bHit) return aHit - bHit;
        }
        return a.row.priceKopecks - b.row.priceKopecks;
      })
      .map(({ row }) => row);

    if (candidates.length === 0) {
      unresolved.push({
        rule,
        reason: 'no_price_item',
        detail: `В активном прайсе нет позиции по признакам: ${rule.all.join(' + ')}.`,
      });
      continue;
    }

    const item = candidates[0]!;
    // Объём считается в единице позиции прайса. Несовпадение единиц —
    // повод отказаться, а не пересчитывать наугад.
    if (normalizeUnit(item.unit) !== normalizeUnit(quantity.unit)) {
      unresolved.push({
        rule,
        reason: 'unit_mismatch',
        detail: `Объём в «${quantity.unit}», позиция прайса в «${item.unit}».`,
      });
      continue;
    }

    resolved.push({
      rule,
      quantity,
      item,
      candidateCount: candidates.length,
      alternatives: candidates.slice(1, 4),
    });
  }

  return { resolved, unresolved };
}
