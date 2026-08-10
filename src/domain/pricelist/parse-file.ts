import ExcelJS from 'exceljs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeText } from './normalize.js';
import type { RawPriceRow } from './import.js';

/**
 * Разбор исходного файла прайса (.xlsx / .csv).
 *
 * Колонки определяются по заголовку: раскладка реального файла заранее
 * неизвестна. Если заголовок не распознан, разбор не угадывает вслепую,
 * а сообщает, какие колонки найдены, — чтобы их можно было задать явно.
 */

export type ColumnMap = {
  code?: number;
  section?: number;
  name: number;
  unit: number;
  price: number;
};

const HEADER_PATTERNS: Record<keyof ColumnMap, RegExp[]> = {
  code: [/^код/, /^артикул/, /^шифр/, /^id$/, /^№\s*поз/],
  section: [/раздел/, /^группа/, /^категор/, /^блок/],
  name: [/наименование/, /^работ/, /^описание/, /^вид\s*работ/, /^название/],
  unit: [/^ед/, /единиц/, /^изм/],
  price: [/цена/, /стоимость/, /^тариф/, /расценк/, /^руб/],
};

export type SheetParseResult = {
  sheet: string;
  rows: RawPriceRow[];
  columnMap: ColumnMap | null;
  headerRow: number | null;
  detectedHeaders: string[];
};

/** Ищет строку заголовков и сопоставляет колонки. */
export function detectColumns(
  rows: readonly (readonly string[])[],
  maxScanRows = 25,
): { map: ColumnMap; headerRow: number; headers: string[] } | { map: null; headers: string[] } {
  let bestHeaders: string[] = [];

  for (let r = 0; r < Math.min(rows.length, maxScanRows); r += 1) {
    const cells = (rows[r] ?? []).map((c) => normalizeText(String(c ?? '')));
    if (cells.every((c) => !c)) continue;

    const found: Partial<Record<keyof ColumnMap, number>> = {};
    for (let c = 0; c < cells.length; c += 1) {
      const value = cells[c] ?? '';
      if (!value) continue;
      for (const [field, patterns] of Object.entries(HEADER_PATTERNS) as Array<[keyof ColumnMap, RegExp[]]>) {
        if (found[field] !== undefined) continue;
        if (patterns.some((p) => p.test(value))) found[field] = c;
      }
    }

    if (cells.some(Boolean)) bestHeaders = cells.filter(Boolean);

    // Минимально необходимый набор: наименование, единица и цена.
    if (found.name !== undefined && found.unit !== undefined && found.price !== undefined) {
      return {
        map: {
          name: found.name,
          unit: found.unit,
          price: found.price,
          ...(found.code !== undefined ? { code: found.code } : {}),
          ...(found.section !== undefined ? { section: found.section } : {}),
        },
        headerRow: r,
        headers: cells.filter(Boolean),
      };
    }
  }

  return { map: null, headers: bestHeaders };
}

function toRawRows(
  grid: readonly (readonly string[])[],
  map: ColumnMap,
  headerRow: number,
  sheetName: string,
): RawPriceRow[] {
  const rows: RawPriceRow[] = [];

  for (let r = headerRow + 1; r < grid.length; r += 1) {
    const cells = grid[r] ?? [];
    const pick = (index: number | undefined): string | null =>
      index === undefined ? null : (cells[index] ?? '').toString().trim() || null;

    const name = pick(map.name);
    const unit = pick(map.unit);
    const price = pick(map.price);
    const section = pick(map.section);
    const code = pick(map.code);

    // Полностью пустая строка пропускается без записи в отчёт.
    if (!name && !unit && !price && !section && !code) continue;

    rows.push({
      name,
      unit,
      price,
      section,
      code,
      sourceRow: `${sheetName}!строка ${r + 1}`,
    });
  }

  return rows;
}

export async function parseXlsx(
  filePath: string,
  override?: Partial<ColumnMap>,
): Promise<SheetParseResult[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const results: SheetParseResult[] = [];

  for (const sheet of workbook.worksheets) {
    const grid: string[][] = [];
    sheet.eachRow({ includeEmpty: true }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cells[colNumber - 1] = cellToString(cell);
      });
      grid.push(cells);
    });

    const detected = detectColumns(grid);
    const map = mergeColumnMap(detected.map, override);

    results.push({
      sheet: sheet.name,
      rows:
        map && 'headerRow' in detected && detected.headerRow !== undefined
          ? toRawRows(grid, map, detected.headerRow, sheet.name)
          : map
            ? toRawRows(grid, map, 0, sheet.name)
            : [],
      columnMap: map,
      headerRow: 'headerRow' in detected ? detected.headerRow : null,
      detectedHeaders: detected.headers,
    });
  }

  return results;
}

export async function parseCsv(filePath: string, override?: Partial<ColumnMap>): Promise<SheetParseResult[]> {
  const text = await fs.readFile(filePath, 'utf8');
  const delimiter = detectDelimiter(text);
  const grid = text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => splitCsvLine(line, delimiter));

  const detected = detectColumns(grid);
  const map = mergeColumnMap(detected.map, override);
  const sheetName = path.basename(filePath);

  return [
    {
      sheet: sheetName,
      rows: map ? toRawRows(grid, map, 'headerRow' in detected ? detected.headerRow : 0, sheetName) : [],
      columnMap: map,
      headerRow: 'headerRow' in detected ? detected.headerRow : null,
      detectedHeaders: detected.headers,
    },
  ];
}

export async function parsePriceFile(
  filePath: string,
  override?: Partial<ColumnMap>,
): Promise<SheetParseResult[]> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.csv' || ext === '.tsv') return parseCsv(filePath, override);
  if (ext === '.xlsx' || ext === '.xlsm') return parseXlsx(filePath, override);
  throw new Error(`Неподдерживаемый формат прайса: ${ext}. Ожидается .xlsx или .csv`);
}

function mergeColumnMap(detected: ColumnMap | null, override?: Partial<ColumnMap>): ColumnMap | null {
  if (!override || Object.keys(override).length === 0) return detected;

  const merged = { ...(detected ?? {}), ...override } as Partial<ColumnMap>;
  if (merged.name === undefined || merged.unit === undefined || merged.price === undefined) {
    return null;
  }
  return merged as ColumnMap;
}

function cellToString(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((t) => t.text).join('');
    if ('text' in value) return String(value.text);
    if ('result' in value) return String(value.result ?? '');
    if (value instanceof Date) return value.toISOString();
  }
  return String(value);
}

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const counts: Array<[string, number]> = [
    [';', (firstLine.match(/;/g) ?? []).length],
    [',', (firstLine.match(/,/g) ?? []).length],
    ['\t', (firstLine.match(/\t/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ';';
}

/** Разбор строки CSV с учётом кавычек. */
export function splitCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result.map((c) => c.trim());
}
