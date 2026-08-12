import fs from 'node:fs';
import ExcelJS from 'exceljs';
import { openDatabase } from '../../src/db/index.js';
import { matchKey, normalizeUnit } from '../../src/domain/pricelist/normalize.js';
import {
  calculateEstimate,
  getActivePriceListVersion,
  type VolumeClaim,
} from '../../src/domain/estimate/calculate.js';
import { deriveVolumes, type ProjectQuantities } from '../../src/domain/estimate/derive.js';
import { formatKopecks, type Kopecks } from '../../src/shared/money.js';

/**
 * Калибровка методики на реальном объекте.
 *
 * Берёт величины, снятые с ведомостей проекта (scripts/calibration/parse_project.py
 * --json), прогоняет их через продуктовые правила вывода объёмов и через
 * настоящий расчёт по активному прайсу, после чего сверяет результат
 * с фактической сметой сметчика — построчно.
 *
 * Скрипт не входит в приложение. Он отвечает на один вопрос: совпадает ли
 * машинный расчёт с ручным, и если нет, то где именно.
 *
 * Запуск:
 *   python3 scripts/calibration/parse_project.py проект.pdf --json > /tmp/p.json
 *   DATABASE_PATH=./data/calib.sqlite npx tsx scripts/calibration/compare.ts \
 *     --project /tmp/p.json --estimate ./prices/смета.xlsx
 */

type ProjectJson = {
  totalAreaM2: number;
  rooms: Array<{ number: string; name: string; area: number }>;
  floorTotals: Record<string, number>;
  skirtingM: number | null;
  heatedFloorM2: number;
  roughMaterials: Array<{ name: string; volume_m3: number; area_m2: number }>;
  wallTotals: Record<string, number>;
  electricModules: number;
};

/** Строка фактической сметы: та, где сметчик проставил объём. */
type ActualLine = {
  row: number;
  section: string;
  name: string;
  unit: string;
  quantity: number;
  priceKopecks: number;
  amountKopecks: number;
};

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Не указан аргумент --${name}`);
  }
  return value;
}

function toKopecks(value: number): number {
  return Math.round(value * 100);
}

/**
 * Читает фактическую смету.
 *
 * Смета «Капсулы» — это весь прайс с проставленными объёмами: значимы
 * только строки, где объём заполнен.
 */
async function readActual(path: string): Promise<ActualLine[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('В файле сметы нет листов');

  const lines: ActualLine[] = [];
  let section = '';

  sheet.eachRow((row, number) => {
    const cell = (index: number): unknown => {
      const value = row.getCell(index).value;
      if (value && typeof value === 'object') {
        const rich = value as { result?: unknown; text?: unknown };
        return rich.result ?? rich.text ?? '';
      }
      return value ?? '';
    };

    const type = String(cell(1)).trim();
    const name = String(cell(2)).replace(/\s+/g, ' ').trim();
    const unit = String(cell(3)).trim();
    const quantity = cell(4);
    const price = cell(5);
    const amount = cell(6);

    // Строка-заголовок раздела: есть наименование, но нет типа и единицы.
    if (!type && name && !unit) {
      section = name;
      return;
    }

    if (typeof quantity !== 'number' || quantity === 0) return;

    const priceKopecks = toKopecks(Number(price) || 0);
    const amountKopecks =
      typeof amount === 'number' ? toKopecks(amount) : Math.round(quantity * priceKopecks);

    lines.push({
      row: number,
      section,
      name,
      unit,
      quantity,
      priceKopecks,
      amountKopecks,
    });
  });

  return lines;
}

/** Разряды и рубли — для читаемого отчёта. */
function money(kopecks: number): string {
  return formatKopecks(kopecks as Kopecks);
}

function pad(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

async function main(): Promise<void> {
  const projectPath = arg('project');
  const estimatePath = arg('estimate');
  const databasePath = arg('database', process.env.DATABASE_PATH ?? './data/calib.sqlite');

  const project = JSON.parse(fs.readFileSync(projectPath, 'utf8')) as ProjectJson;
  const actual = await readActual(estimatePath);
  const db = openDatabase(databasePath);
  const version = getActivePriceListVersion(db);

  // Помещение под шумоизоляцию потолка проект задаёт решением, а не
  // площадью: здесь это спальня. Величина берётся из экспликации.
  const bedroom = project.rooms.find((room) => /спальн/i.test(room.name));

  const quantities: ProjectQuantities = {
    totalAreaM2: project.totalAreaM2,
    floorTileM2: project.floorTotals['плитка_пол'] ?? 0,
    laminateM2: project.floorTotals['ламинат'] ?? 0,
    skirtingM: project.skirtingM,
    heatedFloorM2: project.heatedFloorM2,
    wallPaintedM2: project.wallTotals['покраска_обои'] ?? 0,
    wallTiledM2: project.wallTotals['плитка_стены'] ?? 0,
    wallPanelsM2: project.wallTotals['панели'] ?? 0,
    soundproofCeilingM2: bedroom?.area ?? null,
    soundproofWallsM2:
      project.roughMaterials.find((material) => /шумоизоляц/i.test(material.name))?.area_m2 ?? null,
    electricModules: project.electricModules || null,

    // Решения проекта, снятые с ведомостей вручную: в продукте их
    // извлекает модель вместе с площадями.
    wallTileFormat: arg('wall-tile-format', 'от 60 см. до 120 см.'),
    floorTileFormat: arg('floor-tile-format', 'от 60 см. до 120 см.'),
    laminatePattern: arg('laminate-pattern', 'французская елка'),
    skirtingKind: arg('skirting-kind', 'дюрополимерного'),
  };

  const derived = deriveVolumes(quantities);

  // Позиция прайса → код. Сопоставление строгое: наименование, единица
  // и раздел. Если позиция не нашлась, она не подменяется похожей.
  const claims: VolumeClaim[] = [];
  const unresolved: string[] = [];

  const lookup = db.prepare(
    `SELECT code, name, unit, price_kopecks FROM price_items
      WHERE version_id = ? AND section = ?`,
  );

  const bySection = new Map<string, Array<{ code: string; key: string; price: number }>>();
  for (const volume of derived.volumes) {
    if (!bySection.has(volume.position.section)) {
      const rows = lookup.all(version.id, volume.position.section) as Array<{
        code: string;
        name: string;
        unit: string;
        price_kopecks: number;
      }>;
      bySection.set(
        volume.position.section,
        rows.map((r) => ({ code: r.code, key: matchKey(r.name, r.unit), price: r.price_kopecks })),
      );
    }

    const wanted = matchKey(volume.position.name, normalizeUnit(volume.position.unit));
    const candidates = (bySection.get(volume.position.section) ?? []).filter((item) => item.key === wanted);

    if (candidates.length === 0) {
      unresolved.push(`${volume.key}: «${volume.position.name}» (${volume.position.unit})`);
      continue;
    }

    const prices = new Set(candidates.map((c) => c.price));
    if (prices.size > 1) {
      unresolved.push(`${volume.key}: «${volume.position.name}» — ${prices.size} разных цен в одном разделе`);
      continue;
    }

    claims.push({
      code: candidates[0]!.code,
      quantity: volume.quantity,
      confidence: 'derived',
      note: volume.basis,
    });
  }

  const estimate = calculateEstimate(db, {
    documentType: 'full_project',
    areaMilli: null,
    claims,
    unknowns: derived.unknowns,
  });

  // --- Сверка ---

  const out = (line = ''): void => void process.stdout.write(`${line}\n`);

  out(`Прайс: ${estimate.priceListLabel}`);
  out(`Проект: ${project.totalAreaM2} м², помещений ${project.rooms.length}`);
  out(`Смета сметчика: ${actual.length} позиций`);
  out();

  const actualByKey = new Map<string, ActualLine[]>();
  for (const line of actual) {
    const key = matchKey(line.name, line.unit);
    const list = actualByKey.get(key) ?? [];
    list.push(line);
    actualByKey.set(key, list);
  }

  out('СОВПАДЕНИЕ ПОСТРОЧНО (объём расчёта против объёма сметы)');
  out(
    `${pad('работа', 62)} ${pad('ед', 5)} ${'расчёт'.padStart(10)} ${'смета'.padStart(10)} ${'Δ'.padStart(9)}`,
  );
  out('-'.repeat(102));

  let matched = 0;
  let exact = 0;
  let computedMatchedKopecks = 0;
  let actualMatchedKopecks = 0;
  const consumed = new Set<ActualLine>();

  for (const line of estimate.lines) {
    const key = matchKey(line.name, line.unit);
    const pool = actualByKey.get(key) ?? [];
    const candidate = pool.find((item) => !consumed.has(item));
    const computedQty = line.quantityMilli / 1000;

    if (!candidate) {
      out(
        `${pad(line.name, 62)} ${pad(line.unit, 5)} ${computedQty.toFixed(2).padStart(10)} ${'—'.padStart(10)} ${'нет в смете'.padStart(9)}`,
      );
      continue;
    }

    consumed.add(candidate);
    matched += 1;
    computedMatchedKopecks += line.amountKopecks;
    actualMatchedKopecks += candidate.amountKopecks;

    const delta = computedQty - candidate.quantity;
    // Объёмы в проекте даны с двумя знаками; расхождение меньше половины
    // копейки объёма — это артефакт хранения чисел, а не разница.
    const isExact = Math.abs(delta) < 0.005;
    if (isExact) exact += 1;

    out(
      `${pad(line.name, 62)} ${pad(line.unit, 5)} ${computedQty.toFixed(2).padStart(10)} ${candidate.quantity.toFixed(2).padStart(10)} ${(isExact ? '—' : delta.toFixed(2)).padStart(9)}`,
    );
  }

  const missing = actual.filter((line) => !consumed.has(line));
  const missingKopecks = missing.reduce((sum, line) => sum + line.amountKopecks, 0);
  const actualTotalKopecks = actual.reduce((sum, line) => sum + line.amountKopecks, 0);

  out();
  out(`Строк расчёта: ${estimate.lines.length}, из них найдено в смете: ${matched}`);
  out(`Объём совпал точно: ${exact} из ${matched}`);
  out();
  out(`Сумма совпавших строк, расчёт: ${money(computedMatchedKopecks)}`);
  out(`Сумма тех же строк в смете:    ${money(actualMatchedKopecks)}`);
  out(`Итог сметы сметчика:          ${money(actualTotalKopecks)}`);
  const share = actualTotalKopecks > 0 ? (actualMatchedKopecks / actualTotalKopecks) * 100 : 0;
  out(`Доля сметы, закрытая ведомостями проекта: ${share.toFixed(1)} %`);

  if (unresolved.length > 0) {
    out();
    out('НЕ НАЙДЕНО В ПРАЙСЕ:');
    for (const item of unresolved) out(`  ${item}`);
  }

  if (derived.unknowns.length > 0) {
    out();
    out('НЕ ВКЛЮЧЕНО (нет данных):');
    for (const item of derived.unknowns) out(`  ${item.title}`);
  }

  out();
  out(`ЕСТЬ В СМЕТЕ, НЕТ В РАСЧЁТЕ: ${missing.length} позиций на ${money(missingKopecks)}`);
  const bySectionMissing = new Map<string, { count: number; sum: number }>();
  for (const line of missing) {
    const entry = bySectionMissing.get(line.section) ?? { count: 0, sum: 0 };
    entry.count += 1;
    entry.sum += line.amountKopecks;
    bySectionMissing.set(line.section, entry);
  }
  for (const [section, entry] of [...bySectionMissing].sort((a, b) => b[1].sum - a[1].sum)) {
    out(`  ${pad(section, 56)} ${String(entry.count).padStart(3)} поз.  ${money(entry.sum).padStart(16)}`);
  }

  out();
  out('ПОДРОБНО, ЧЕГО НЕТ В РАСЧЁТЕ:');
  for (const line of [...missing].sort((a, b) => b.amountKopecks - a.amountKopecks)) {
    out(
      `  ${pad(line.name, 70)} ${pad(line.unit, 6)} ${line.quantity.toFixed(2).padStart(9)} ${money(line.amountKopecks).padStart(16)}`,
    );
  }
}

await main();
