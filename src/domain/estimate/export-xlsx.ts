import ExcelJS from 'exceljs';
import { fromMilliQty, kopecksToRubles } from '../../shared/money.js';
import type { EstimateLineRow, EstimateNoteRow, EstimateRow } from './repository.js';

/**
 * Экспорт сметы в .xlsx.
 *
 * Числа выгружаются числами, а не текстом, суммы строк — формулами
 * «объём × цена», итог — формулой SUM по строкам. Поэтому файл
 * пересчитывается в Excel и сходится с итогом в интерфейсе.
 */

const CONFIDENCE_LABELS: Record<string, string> = {
  confirmed: 'Подтверждён документом',
  derived: 'Рассчитан из геометрии',
  assumption: 'Предварительное допущение',
};

const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  full_project: 'Полный проект',
  partial_project: 'Частичный проект',
  layout_only: 'Только планировка',
};

const NOTE_KIND_LABELS: Record<string, string> = {
  assumption: 'Допущение',
  clarification: 'Уточнение',
  omission: 'Возможный пропуск',
  excluded: 'Не включено в расчёт',
};

const MONEY_FORMAT = '# ##0.00 "₽"';
const QTY_FORMAT = '# ##0.000';

export type ExportInput = {
  estimate: EstimateRow;
  lines: readonly EstimateLineRow[];
  notes: readonly EstimateNoteRow[];
  projectName: string;
  fileNames?: readonly string[];
};

export async function buildEstimateWorkbook(input: ExportInput): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ИИ Сметчик — Капсула';
  workbook.created = new Date(input.estimate.created_at);

  buildEstimateSheet(workbook, input);
  buildNotesSheet(workbook, input);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function buildEstimateSheet(workbook: ExcelJS.Workbook, input: ExportInput): void {
  const sheet = workbook.addWorksheet('Смета', {
    views: [{ state: 'frozen', ySplit: 0 }],
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  sheet.columns = [
    { key: 'no', width: 6 },
    { key: 'section', width: 26 },
    { key: 'code', width: 16 },
    { key: 'name', width: 52 },
    { key: 'unit', width: 10 },
    { key: 'qty', width: 12 },
    { key: 'price', width: 15 },
    { key: 'amount', width: 17 },
    { key: 'confidence', width: 26 },
    { key: 'source', width: 34 },
  ];

  const title = sheet.addRow([
    input.estimate.is_preliminary
      ? 'ПРЕДВАРИТЕЛЬНАЯ СМЕТА НА РЕМОНТНЫЕ РАБОТЫ'
      : 'СМЕТА НА РЕМОНТНЫЕ РАБОТЫ',
  ]);
  title.font = { bold: true, size: 14 };
  sheet.mergeCells(title.number, 1, title.number, 10);

  const meta: Array<[string, string]> = [
    ['Объект', input.projectName],
    ['Тип документации', DOCUMENT_TYPE_LABELS[input.estimate.document_type] ?? input.estimate.document_type],
    ['Прайс-лист', input.estimate.price_list_label],
    ['Редакция сметы', `№ ${input.estimate.revision}`],
    ['Дата расчёта', new Date(input.estimate.created_at).toLocaleString('ru-RU')],
  ];
  if (input.estimate.area_milli) {
    meta.push(['Площадь объекта, м²', String(fromMilliQty(input.estimate.area_milli))]);
  }
  if (input.fileNames?.length) {
    meta.push(['Обработанные файлы', input.fileNames.join(', ')]);
  }
  if (input.estimate.is_preliminary) {
    meta.push([
      'Внимание',
      'Расчёт предварительный. Он не является точной договорной сметой: часть объёмов не подтверждена документацией.',
    ]);
  }

  for (const [label, value] of meta) {
    const row = sheet.addRow([label, value]);
    row.getCell(1).font = { bold: true };
    sheet.mergeCells(row.number, 2, row.number, 10);
    row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
  }

  sheet.addRow([]);

  const header = sheet.addRow([
    '№',
    'Раздел',
    'Код',
    'Наименование работы',
    'Ед.',
    'Объём',
    'Цена за ед.',
    'Сумма',
    'Достоверность',
    'Источник',
  ]);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.alignment = { vertical: 'middle', wrapText: true };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A237E' } };
    cell.border = thinBorder();
  });
  sheet.views = [{ state: 'frozen', ySplit: header.number }];

  const amountRowNumbers: number[] = [];

  input.lines.forEach((line, index) => {
    const row = sheet.addRow({
      no: index + 1,
      section: line.section,
      code: line.code,
      name: line.is_manual ? `${line.name} (ручная правка)` : line.name,
      unit: line.unit,
      qty: fromMilliQty(line.quantity_milli),
      price: kopecksToRubles(line.price_kopecks),
      confidence: CONFIDENCE_LABELS[line.confidence] ?? line.confidence,
      source: formatSource(line),
    });

    // Сумма — формула, а не записанное число: файл пересчитывается в Excel.
    row.getCell('amount').value = { formula: `F${row.number}*G${row.number}` };

    row.getCell('qty').numFmt = QTY_FORMAT;
    row.getCell('price').numFmt = MONEY_FORMAT;
    row.getCell('amount').numFmt = MONEY_FORMAT;
    row.getCell('name').alignment = { wrapText: true, vertical: 'top' };
    row.getCell('source').alignment = { wrapText: true, vertical: 'top' };
    row.eachCell((cell) => {
      cell.border = thinBorder();
    });

    // Предварительные допущения выделяются: их нельзя принимать за точные.
    if (line.confidence === 'assumption') {
      row.getCell('confidence').font = { color: { argb: 'FFB26A00' } };
    }

    amountRowNumbers.push(row.number);
  });

  const totalRow = sheet.addRow(['', '', '', 'ИТОГО работ', '', '', '', null]);
  totalRow.font = { bold: true };
  totalRow.getCell(8).value =
    amountRowNumbers.length > 0
      ? { formula: `SUM(H${amountRowNumbers[0]}:H${amountRowNumbers.at(-1)})` }
      : 0;
  totalRow.getCell(8).numFmt = MONEY_FORMAT;
  totalRow.eachCell((cell) => {
    cell.border = thinBorder();
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EAF6' } };
  });

  if (input.estimate.area_milli && input.estimate.area_milli > 0) {
    const perM2 = sheet.addRow(['', '', '', 'Цена за м² (производный показатель)', '', '', '', null]);
    perM2.getCell(8).value = {
      formula: `H${totalRow.number}/${fromMilliQty(input.estimate.area_milli)}`,
    };
    perM2.getCell(8).numFmt = MONEY_FORMAT;
    perM2.getCell(4).font = { italic: true };
  }

  sheet.addRow([]);
  const disclaimer = sheet.addRow([
    'Материалы, а также стоимость дверей, сантехнических приборов, светильников, кухни, мебели и техники в расчёт не входят.',
  ]);
  disclaimer.font = { italic: true, size: 9 };
  sheet.mergeCells(disclaimer.number, 1, disclaimer.number, 10);

  sheet.autoFilter = { from: { row: header.number, column: 1 }, to: { row: header.number, column: 10 } };
}

function buildNotesSheet(workbook: ExcelJS.Workbook, input: ExportInput): void {
  const sheet = workbook.addWorksheet('Допущения и пропуски');
  sheet.columns = [
    { key: 'kind', width: 26 },
    { key: 'severity', width: 14 },
    { key: 'title', width: 60 },
    { key: 'detail', width: 80 },
  ];

  const header = sheet.addRow(['Категория', 'Важность', 'Заголовок', 'Пояснение']);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A237E' } };
    cell.border = thinBorder();
  });

  if (input.notes.length === 0) {
    sheet.addRow(['—', '—', 'Замечаний нет', '']);
    return;
  }

  const severityLabels: Record<string, string> = {
    info: 'Информация',
    warning: 'Внимание',
    critical: 'Критично',
  };

  for (const note of input.notes) {
    const row = sheet.addRow({
      kind: NOTE_KIND_LABELS[note.kind] ?? note.kind,
      severity: severityLabels[note.severity] ?? note.severity,
      title: note.title,
      detail: note.detail ?? '',
    });
    row.getCell('title').alignment = { wrapText: true, vertical: 'top' };
    row.getCell('detail').alignment = { wrapText: true, vertical: 'top' };
    row.eachCell((cell) => {
      cell.border = thinBorder();
    });
    if (note.severity === 'critical') {
      row.getCell('severity').font = { bold: true, color: { argb: 'FFC62828' } };
    }
  }
}

function formatSource(line: EstimateLineRow): string {
  if (line.is_manual) return 'Ручная правка сотрудника';
  const parts: string[] = [];
  if (line.source_page !== null) parts.push(`стр. ${line.source_page}`);
  if (line.source_ref) parts.push(line.source_ref);
  return parts.length > 0 ? parts.join(', ') : 'Источник не указан';
}

function thinBorder(): Partial<ExcelJS.Borders> {
  const style = { style: 'thin' as const, color: { argb: 'FF9FA8DA' } };
  return { top: style, left: style, bottom: style, right: style };
}
