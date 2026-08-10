import { normalizeText } from '../pricelist/normalize.js';
import type { CalculatedEstimate, EstimateNoteDraft } from './calculate.js';

/**
 * Проверка технологической полноты.
 *
 * Ищет блоки работ, которые часто забывают. Проверка ТОЛЬКО предупреждает:
 * она никогда не добавляет строку и не придумывает объём — иначе в смету
 * попали бы выдуманные деньги.
 */

export type CompletenessRule = {
  id: string;
  title: string;
  /** Достаточно одного совпадения, чтобы блок считался учтённым. */
  keywords: string[];
  /** Правило проверяется только при выполнении условия. */
  appliesWhen?: (ctx: CompletenessContext) => boolean;
  severity: 'info' | 'warning';
  hint: string;
};

export type CompletenessContext = {
  estimate: CalculatedEstimate;
  /** Исходное состояние объекта: бетон / White Box / вторичка. */
  initialState?: 'concrete' | 'white_box' | 'secondary' | null;
  /** Есть ли в объекте мокрые зоны по данным документации. */
  hasWetZones?: boolean | null;
};

const hasPartitions = (ctx: CompletenessContext) =>
  matches(ctx, ['перегородк', 'гипсокартон', 'пеноблок', 'газоблок', 'кирпичн']);

export const COMPLETENESS_RULES: readonly CompletenessRule[] = [
  {
    id: 'partition_both_sides',
    title: 'Отделка перегородок с обеих сторон',
    keywords: ['штукатур', 'шпаклев', 'шпатлев', 'обшивк', 'отделк'],
    appliesWhen: hasPartitions,
    severity: 'warning',
    hint: 'В смете есть перегородки. Проверьте, что отделка учтена с обеих сторон.',
  },
  {
    id: 'door_openings',
    title: 'Дверные проёмы, усиления и закладные',
    keywords: ['проем', 'проём', 'усилен', 'закладн', 'перемычк'],
    appliesWhen: hasPartitions,
    severity: 'warning',
    hint: 'Возведены перегородки — проверьте устройство проёмов и закладных.',
  },
  {
    id: 'slopes',
    title: 'Оконные и дверные откосы',
    keywords: ['откос'],
    severity: 'warning',
    hint: 'Откосы не найдены в смете. Проверьте оконные и дверные проёмы.',
  },
  {
    id: 'waterproofing',
    title: 'Гидроизоляция мокрых зон',
    keywords: ['гидроизоляц'],
    appliesWhen: (ctx) => ctx.hasWetZones === true || matches(ctx, ['санузл', 'ванн', 'душев', 'мокр']),
    severity: 'warning',
    hint: 'Обнаружены мокрые зоны. Гидроизоляция в смете не найдена.',
  },
  {
    id: 'substrate',
    title: 'Подготовительные слои под финиш',
    keywords: ['грунт', 'подготовк', 'стяжк', 'наливн', 'выравнив'],
    severity: 'warning',
    hint: 'Не найдены подготовительные слои под чистовую отделку.',
  },
  {
    id: 'engineering_rough',
    title: 'Черновой монтаж инженерии',
    keywords: ['черновой монтаж', 'разводк', 'трасс', 'магистрал', 'стояк'],
    severity: 'info',
    hint: 'Черновой монтаж инженерных систем в смете не найден.',
  },
  {
    id: 'engineering_finish',
    title: 'Чистовой монтаж инженерии',
    keywords: ['чистов', 'установк прибор', 'монтаж прибор', 'подключен'],
    severity: 'info',
    hint: 'Чистовой монтаж приборов и точек в смете не найден.',
  },
  {
    id: 'chasing',
    title: 'Отверстия, штробы и их заделка',
    keywords: ['штроб', 'отверст', 'сверлен', 'бурен', 'заделк'],
    severity: 'info',
    hint: 'Штробление и заделка не найдены. Проверьте электрику и сантехнику.',
  },
  {
    id: 'skirting',
    title: 'Плинтусы, примыкания и завершающие операции',
    keywords: ['плинтус', 'примыкан', 'галтел', 'порожк', 'герметиз'],
    severity: 'warning',
    hint: 'Завершающие операции (плинтусы, примыкания) в смете не найдены.',
  },
  {
    id: 'logistics',
    title: 'Вынос мусора, подъём материалов и клининг',
    keywords: ['мусор', 'вынос', 'подъем', 'подъём', 'клининг', 'уборк', 'вывоз'],
    severity: 'info',
    hint: 'Логистика и уборка не найдены. Проверьте, предусмотрены ли они прайсом.',
  },
  {
    id: 'demolition',
    title: 'Демонтажные работы',
    keywords: ['демонтаж', 'разборк', 'снят'],
    // Для бетона демонтаж не нужен — правило применимо только к White Box и вторичке.
    appliesWhen: (ctx) => ctx.initialState === 'secondary' || ctx.initialState === 'white_box',
    severity: 'warning',
    hint: 'Исходное состояние предполагает демонтаж, но он не найден в смете.',
  },
];

function matches(ctx: CompletenessContext, keywords: readonly string[]): boolean {
  const haystack = ctx.estimate.lines.map((l) => normalizeText(`${l.name} ${l.section}`)).join(' \n ');
  return keywords.some((k) => haystack.includes(normalizeText(k)));
}

/**
 * Возвращает предупреждения о потенциально пропущенных блоках.
 * Пустая смета проверке не подвергается: предупреждать не о чем.
 */
export function checkCompleteness(ctx: CompletenessContext): EstimateNoteDraft[] {
  if (ctx.estimate.lines.length === 0) return [];

  const notes: EstimateNoteDraft[] = [];
  for (const rule of COMPLETENESS_RULES) {
    if (rule.appliesWhen && !rule.appliesWhen(ctx)) continue;
    if (matches(ctx, rule.keywords)) continue;

    notes.push({
      kind: 'omission',
      severity: rule.severity,
      title: `Возможный пропуск: ${rule.title}`,
      detail: `${rule.hint} Проверка предупреждает о возможном пропуске и не добавляет объём автоматически.`,
    });
  }
  return notes;
}
