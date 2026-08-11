import type { Db } from '../../db/index.js';
import { toMilliQty } from '../../shared/money.js';
import {
  calculateEstimate,
  getActivePriceListVersion,
  type CalculatedEstimate,
  type EstimateNoteDraft,
  type VolumeClaim,
} from './calculate.js';
import { checkCompleteness } from './completeness.js';
import {
  deriveQuantities,
  DEFAULT_ASSUMPTIONS,
  NOT_DERIVABLE,
  type GeometryAssumptions,
  type ObjectParameters,
  type DerivedQuantity,
} from './geometry.js';
import { resolveRules, type ResolvedRule, type UnresolvedRule } from './ruleset.js';

/**
 * Предварительная смета по общим данным объекта.
 *
 * Документация не требуется: объёмы выводятся из геометрии, цены берутся
 * из активного прайса. Это отдельный путь, а не подмена анализа чертежей —
 * результат всегда помечен как предварительный, а каждая величина
 * сопровождается формулой, по которой получена.
 */

export type PreliminaryInput = {
  params: ObjectParameters;
  assumptions?: GeometryAssumptions;
};

export type PreliminaryResult = {
  estimate: CalculatedEstimate;
  quantities: DerivedQuantity[];
  resolved: ResolvedRule[];
  unresolved: UnresolvedRule[];
  assumptions: GeometryAssumptions;
};

export function calculatePreliminaryEstimate(db: Db, input: PreliminaryInput): PreliminaryResult {
  const assumptions = input.assumptions ?? DEFAULT_ASSUMPTIONS;
  const version = getActivePriceListVersion(db);

  const quantities = deriveQuantities(input.params, assumptions);

  const wetZones = input.params.wetZones ?? (input.params.rooms <= 2 ? 1 : 2);
  const { resolved, unresolved } = resolveRules(db, version.id, quantities, {
    initialState: input.params.initialState,
    rooms: input.params.rooms,
    hasWetZones: wetZones > 0,
  });

  // Заявка на объём не содержит цены: её подставит расчёт из БД.
  const claims: VolumeClaim[] = resolved.map((r) => ({
    code: r.item.code,
    quantity: r.quantity.value,
    confidence: r.quantity.confidence,
    source: { fileId: null, page: null, ref: `Расчёт по геометрии: ${r.quantity.formula}` },
    note: r.rule.reason ?? null,
    isManual: false,
  }));

  const notes: EstimateNoteDraft[] = [];

  notes.push({
    kind: 'assumption',
    severity: 'warning',
    title: 'Расчёт выполнен по общим данным объекта, без документации',
    detail:
      'Объёмы выведены из площади, числа комнат и высоты потолка по формулам. ' +
      'Это ориентир для первичного разговора с заказчиком, а не договорная смета. ' +
      'Загрузите проектную документацию, чтобы заменить допущения подтверждёнными объёмами.',
  });

  // Каждое допущение планировки показывается явно.
  notes.push({
    kind: 'assumption',
    severity: 'info',
    title: 'Принятые коэффициенты планировки',
    detail:
      `Высота потолка ${assumptions.ceilingHeight} м; ` +
      `периметр = ${assumptions.perimeterFactor} × √S; ` +
      `длина перегородок = ${assumptions.partitionFactor} × периметр; ` +
      `окно ${assumptions.windowAreaM2} м², дверь ${assumptions.doorAreaM2} м²; ` +
      `мокрая зона ${assumptions.wetZoneAreaM2} м²; ` +
      `мусор ${assumptions.wasteTonsPerM2} т/м². Значения можно изменить.`,
  });

  // Выбор из нескольких подходящих позиций не должен быть скрытым.
  for (const r of resolved.filter((x) => x.candidateCount > 1)) {
    notes.push({
      kind: 'clarification',
      severity: 'info',
      title: `Выбрана позиция: ${r.item.name}`,
      detail:
        `Под правило «${r.rule.title}» подошло ${r.candidateCount} позиций прайса; ` +
        `взята самая дешёвая. Другие варианты: ` +
        `${r.alternatives.map((a) => `${a.name} (${(a.priceKopecks / 100).toFixed(2)} ₽)`).join('; ')}.`,
    });
  }

  // Правила, для которых не нашлось позиции, — это пробел, а не тишина.
  for (const u of unresolved) {
    notes.push({
      kind: 'omission',
      severity: u.reason === 'no_price_item' ? 'warning' : 'info',
      title: `Не включено: ${u.rule.title}`,
      detail: u.detail,
    });
  }

  const estimate = calculateEstimate(db, {
    // Без документации тип определить нельзя: считаем по планировке.
    documentType: 'layout_only',
    areaMilli: toMilliQty(input.params.areaM2),
    claims,
    unknowns: NOT_DERIVABLE.map((n) => ({ title: n.title, detail: n.detail })),
    assumptions: notes,
    versionId: version.id,
  });

  const completeness = checkCompleteness({
    estimate,
    initialState: input.params.initialState,
    hasWetZones: wetZones > 0,
  });
  estimate.notes.push(...completeness);

  return { estimate, quantities, resolved, unresolved, assumptions };
}
