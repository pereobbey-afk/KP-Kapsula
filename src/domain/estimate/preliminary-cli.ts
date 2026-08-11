import { config } from '../../shared/config.js';
import { openDatabase } from '../../db/index.js';
import { formatKopecks, fromMilliQty } from '../../shared/money.js';
import { calculatePreliminaryEstimate } from './preliminary.js';
import { DEFAULT_ASSUMPTIONS, type InitialState } from './geometry.js';

/**
 * Предварительный расчёт из командной строки — чтобы логику можно было
 * посмотреть и проверить руками, без интерфейса и без ИИ.
 *
 * Пример:
 *   npm run estimate:preview -- --area 52.4 --rooms 2 --state concrete
 */

const out = (line = ''): void => void process.stdout.write(`${line}\n`);

function parseArgs(argv: readonly string[]): {
  area: number;
  rooms: number;
  state: InitialState;
  wetZones: number | null;
  windows: number | null;
  height: number | null;
} {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (flag: string): number | null => {
    const v = get(flag);
    if (v === undefined) return null;
    const n = Number(v.replace(',', '.'));
    if (!Number.isFinite(n)) throw new Error(`Некорректное значение ${flag}: ${v}`);
    return n;
  };

  const area = num('--area');
  if (area === null) throw new Error('Укажите площадь: --area 52.4');

  const state = (get('--state') ?? 'concrete') as InitialState;
  if (!['concrete', 'white_box', 'secondary'].includes(state)) {
    throw new Error('--state должен быть concrete, white_box или secondary');
  }

  return {
    area,
    rooms: num('--rooms') ?? 2,
    state,
    wetZones: num('--wet-zones'),
    windows: num('--windows'),
    height: num('--height'),
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const cfg = config();
  const db = openDatabase(cfg.databasePath);

  try {
    const result = calculatePreliminaryEstimate(db, {
      params: {
        areaM2: args.area,
        rooms: args.rooms,
        initialState: args.state,
        wetZones: args.wetZones,
        windows: args.windows,
      },
      ...(args.height !== null
        ? { assumptions: { ...DEFAULT_ASSUMPTIONS, ceilingHeight: args.height } }
        : {}),
    });

    const { estimate, quantities, resolved } = result;

    out();
    out('!!! МЕТОДИКА НЕ КАЛИБРОВАНА — ЧИСЛА НЕВЕРНЫ !!!');
    out('Коэффициенты вывода объёмов взяты не из методики «Капсулы».');
    out('Не установлено: измеряются ли настенные работы в м² стен или');
    out('в м² площади квартиры, и складываются ли слои шпаклёвки.');
    out('Расчёт оставлен только для отладки правил подбора работ.');
    out();
    out('════════ ИСХОДНЫЕ ДАННЫЕ ════════');
    out(`Площадь: ${args.area} м²   Комнат: ${args.rooms}   Состояние: ${args.state}`);
    out(`Прайс:   ${estimate.priceListLabel}`);

    out();
    out('════════ ВЫВЕДЕННЫЕ ОБЪЁМЫ ════════');
    out('(D — следует из подтверждённой площади, A — получено через коэффициент)');
    for (const q of quantities) {
      const mark = q.confidence === 'derived' ? 'D' : 'A';
      out(`  [${mark}] ${q.title}: ${q.value} ${q.unit}`);
      out(`        ${q.formula}`);
    }

    out();
    out('════════ СМЕТА ════════');
    let section = '';
    for (const line of estimate.lines) {
      if (line.section !== section) {
        section = line.section;
        out();
        out(`── ${section}`);
      }
      const rule = resolved.find((r) => r.item.code === line.code);
      out(`  ${line.name}`);
      out(
        `     ${fromMilliQty(line.quantityMilli)} ${line.unit} × ${formatKopecks(line.priceKopecks)}` +
          ` = ${formatKopecks(line.amountKopecks)}`,
      );
      if (rule)
        out(
          `     правило: ${rule.rule.title}${rule.candidateCount > 1 ? ` (из ${rule.candidateCount} подходящих)` : ''}`,
        );
    }

    out();
    out('════════ ИТОГ ════════');
    out(`Работ в смете:   ${estimate.lines.length}`);
    out(`ИТОГО работ:     ${formatKopecks(estimate.totalKopecks)}`);
    if (estimate.pricePerM2Kopecks !== null) {
      out(`Цена за м²:      ${formatKopecks(estimate.pricePerM2Kopecks)}  (производная: итог / площадь)`);
    }
    out('Материалы, двери, приборы, светильники, кухня, мебель и техника не входят.');

    const byKind = (kind: string) => estimate.notes.filter((n) => n.kind === kind);
    for (const [kind, title] of [
      ['omission', 'ВОЗМОЖНЫЕ ПРОПУСКИ И НЕ ВКЛЮЧЁННОЕ'],
      ['excluded', 'ДАННЫХ НЕТ — В ИТОГ НЕ ВХОДИТ'],
      ['clarification', 'УТОЧНЕНИЯ'],
      ['assumption', 'ДОПУЩЕНИЯ'],
    ] as const) {
      const notes = byKind(kind);
      if (notes.length === 0) continue;
      out();
      out(`════════ ${title} (${notes.length}) ════════`);
      for (const n of notes) {
        out(`  • ${n.title}`);
        if (n.detail) out(`    ${n.detail}`);
      }
    }
    out();
  } finally {
    db.close();
  }
}

try {
  main();
} catch (e) {
  process.stderr.write(`\nОшибка: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
