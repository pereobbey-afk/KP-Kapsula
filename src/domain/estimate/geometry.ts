/**
 * Вывод объёмов работ из геометрии объекта.
 *
 * Это путь предварительной сметы: он не требует ИИ и не читает чертежи.
 * Объёмы выводятся из площади, числа комнат и высоты потолка по явным
 * формулам, каждая из которых видна пользователю.
 *
 * Разделение достоверности здесь принципиальное:
 *  - derived    — прямое следствие подтверждённой площади (пол, потолок);
 *  - assumption — получено через коэффициент планировки, то есть догадка.
 *
 * Ни один коэффициент не спрятан: все они собраны в GeometryAssumptions,
 * показываются в смете и могут быть заменены сотрудником. Когда появится
 * документация, ИИ заменит эти догадки подтверждёнными объёмами.
 */

export type InitialState = 'concrete' | 'white_box' | 'secondary';

/** Коэффициенты планировки. Все — допущения, все переопределяемы. */
export type GeometryAssumptions = {
  /** Высота потолка, м. */
  ceilingHeight: number;
  /**
   * Периметр наружных стен = perimeterFactor × √S.
   * 4,1 соответствует компактному прямоугольнику со сторонами 1:1,5.
   */
  perimeterFactor: number;
  /** Длина перегородок = partitionFactor × периметр. */
  partitionFactor: number;
  /** Площадь одного оконного проёма, м². */
  windowAreaM2: number;
  /** Площадь одного дверного проёма, м². */
  doorAreaM2: number;
  /** Периметр откоса одного окна, м.п. */
  windowSlopeM: number;
  /** Периметр откоса одной двери, м.п. */
  doorSlopeM: number;
  /** Площадь одной мокрой зоны, м². */
  wetZoneAreaM2: number;
  /** Масса мусора на м² площади, т. */
  wasteTonsPerM2: number;
};

export const DEFAULT_ASSUMPTIONS: GeometryAssumptions = {
  ceilingHeight: 2.7,
  perimeterFactor: 4.1,
  partitionFactor: 0.6,
  windowAreaM2: 1.8,
  doorAreaM2: 1.7,
  windowSlopeM: 5.4,
  doorSlopeM: 5.2,
  wetZoneAreaM2: 4.0,
  wasteTonsPerM2: 0.03,
};

export type ObjectParameters = {
  /** Площадь пола, м². Вводит сотрудник — считается подтверждённой. */
  areaM2: number;
  /** Количество комнат. */
  rooms: number;
  initialState: InitialState;
  /** Количество санузлов. Если не указано — оценивается по числу комнат. */
  wetZones?: number | null;
  /** Количество окон. Если не указано — оценивается по числу комнат. */
  windows?: number | null;
  /** Количество дверных проёмов. Если не указано — комнаты + 1. */
  doors?: number | null;
};

/** Величина, выведенная из геометрии, вместе с обоснованием. */
export type DerivedQuantity = {
  id: string;
  title: string;
  value: number;
  unit: string;
  /** Формула с подставленными числами — её видит пользователь. */
  formula: string;
  /** derived — следствие подтверждённых данных; assumption — через коэффициент. */
  confidence: 'derived' | 'assumption';
};

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * Считает объёмы. Функция чистая: одни и те же параметры всегда дают
 * один и тот же результат, поэтому смету можно воспроизвести.
 */
export function deriveQuantities(
  params: ObjectParameters,
  assumptions: GeometryAssumptions = DEFAULT_ASSUMPTIONS,
): DerivedQuantity[] {
  if (!Number.isFinite(params.areaM2) || params.areaM2 <= 0) {
    throw new Error('Площадь объекта должна быть положительным числом');
  }

  const a = assumptions;
  const S = params.areaM2;
  const rooms = Math.max(1, Math.trunc(params.rooms || 1));

  const windows = params.windows ?? Math.max(1, rooms);
  const doors = params.doors ?? rooms + 1;
  const wetZones = params.wetZones ?? (rooms <= 2 ? 1 : 2);

  const perimeter = a.perimeterFactor * Math.sqrt(S);
  const partitions = a.partitionFactor * perimeter;
  const openingsArea = windows * a.windowAreaM2 + doors * a.doorAreaM2;

  // Отделываются: внутренняя сторона наружных стен и ОБЕ стороны перегородок.
  const wallGross = (perimeter + 2 * partitions) * a.ceilingHeight;
  const wallArea = Math.max(0, wallGross - openingsArea);

  const slopes = windows * a.windowSlopeM + doors * a.doorSlopeM;
  const wetArea = wetZones * a.wetZoneAreaM2;
  const waste = S * a.wasteTonsPerM2;

  const f = (n: number): string => String(round3(n));

  return [
    {
      id: 'floor_area',
      title: 'Площадь пола',
      value: round3(S),
      unit: 'м2',
      formula: `Площадь объекта = ${f(S)} м²`,
      confidence: 'derived',
    },
    {
      id: 'ceiling_area',
      title: 'Площадь потолка',
      value: round3(S),
      unit: 'м2',
      formula: `Равна площади пола = ${f(S)} м²`,
      confidence: 'derived',
    },
    {
      id: 'perimeter',
      title: 'Периметр наружных стен',
      value: round3(perimeter),
      unit: 'м.п.',
      formula: `${f(a.perimeterFactor)} × √${f(S)} = ${f(perimeter)} м.п.`,
      confidence: 'assumption',
    },
    {
      id: 'partitions_length',
      title: 'Длина перегородок',
      value: round3(partitions),
      unit: 'м.п.',
      formula: `${f(a.partitionFactor)} × ${f(perimeter)} = ${f(partitions)} м.п.`,
      confidence: 'assumption',
    },
    {
      id: 'wall_area',
      title: 'Площадь стен под отделку',
      value: round3(wallArea),
      unit: 'м2',
      formula:
        `(${f(perimeter)} + 2 × ${f(partitions)}) × ${f(a.ceilingHeight)} − ${f(openingsArea)} ` +
        `= ${f(wallArea)} м² (перегородки отделываются с двух сторон, проёмы вычтены)`,
      confidence: 'assumption',
    },
    {
      id: 'slopes_length',
      title: 'Откосы оконные и дверные',
      value: round3(slopes),
      unit: 'м.п.',
      formula:
        `${windows} окон × ${f(a.windowSlopeM)} + ${doors} проёмов × ${f(a.doorSlopeM)} ` +
        `= ${f(slopes)} м.п.`,
      confidence: 'assumption',
    },
    {
      id: 'wet_area',
      title: 'Площадь мокрых зон',
      value: round3(wetArea),
      unit: 'м2',
      formula: `${wetZones} санузл. × ${f(a.wetZoneAreaM2)} м² = ${f(wetArea)} м²`,
      confidence: 'assumption',
    },
    {
      id: 'waste_tons',
      title: 'Масса мусора к вывозу',
      value: round3(waste),
      unit: 'т',
      formula: `${f(S)} м² × ${f(a.wasteTonsPerM2)} т/м² = ${f(waste)} т`,
      confidence: 'assumption',
    },
    {
      id: 'windows_count',
      title: 'Количество окон',
      value: windows,
      unit: 'шт',
      formula: params.windows != null ? 'Указано сотрудником' : `Принято по числу комнат = ${windows}`,
      confidence: params.windows != null ? 'derived' : 'assumption',
    },
    {
      id: 'doors_count',
      title: 'Количество дверных проёмов',
      value: doors,
      unit: 'шт',
      formula: params.doors != null ? 'Указано сотрудником' : `Комнаты + 1 = ${doors}`,
      confidence: params.doors != null ? 'derived' : 'assumption',
    },
  ];
}

/** Величины, которые нельзя вывести из геометрии, — они идут в «не включено». */
export const NOT_DERIVABLE = [
  {
    title: 'Количество розеток, выключателей и light-точек',
    detail: 'Определяется только по схеме электрики. В предварительный расчёт не включено.',
  },
  {
    title: 'Количество сантехнических точек и длины трасс',
    detail: 'Определяется только по схеме водоснабжения и канализации.',
  },
  {
    title: 'Ниши, сложные потолки, встроенные конструкции и декор',
    detail: 'Определяются только по дизайн-проекту.',
  },
  {
    title: 'Отверстия, штробы и запилы',
    detail: 'Определяются по инженерным разделам проекта.',
  },
] as const;
