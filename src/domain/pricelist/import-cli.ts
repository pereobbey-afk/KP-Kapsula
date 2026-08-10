import path from 'node:path';
import { config } from '../../shared/config.js';
import { openDatabase } from '../../db/index.js';
import { parsePriceFile, type ColumnMap } from './parse-file.js';
import { formatImportSummary, type PriceEdition } from './import.js';
import { importPriceList } from './repository.js';

/**
 * Импорт прайс-листа из файлов.
 *
 * Пример:
 *   npm run pricelist:import -- \
 *     --file "./prices/price_01.07.2026.xlsx:01.07.2026:2026-07-01" \
 *     --file "./prices/price_05.08.2026.xlsx:05.08.2026:2026-08-05" \
 *     --label "Объединённый прайс Капсула" --activate
 *
 * Порядок --file значения не имеет: приоритет редакции определяется датой.
 * Без --activate версия загружается, но активной не становится —
 * можно сверить отчёт и только потом переключить.
 */

type Args = {
  files: Array<{ path: string; label: string; date: string }>;
  label: string;
  activate: boolean;
  dryRun: boolean;
  columns: Partial<ColumnMap>;
  sheet: string | null;
};

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    files: [],
    label: 'Прайс-лист',
    activate: false,
    dryRun: false,
    columns: {},
    sheet: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`Не указано значение для ${arg}`);
      i += 1;
      return value;
    };

    switch (arg) {
      case '--file': {
        // формат: путь:метка:дата
        const raw = next();
        const parts = raw.split(':');
        // Учитываем windows-пути вида C:\... — путь собирается обратно.
        const date = parts.pop() ?? '';
        const label = parts.pop() ?? '';
        const filePath = parts.join(':');
        if (!filePath || !label || !date) {
          throw new Error(`Ожидается --file "путь:метка:ГГГГ-ММ-ДД", получено: ${raw}`);
        }
        args.files.push({ path: filePath, label, date });
        break;
      }
      case '--label':
        args.label = next();
        break;
      case '--activate':
        args.activate = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--sheet':
        args.sheet = next();
        break;
      case '--col-name':
        args.columns.name = Number(next());
        break;
      case '--col-unit':
        args.columns.unit = Number(next());
        break;
      case '--col-price':
        args.columns.price = Number(next());
        break;
      case '--col-section':
        args.columns.section = Number(next());
        break;
      case '--col-code':
        args.columns.code = Number(next());
        break;
      default:
        if (arg?.startsWith('--')) throw new Error(`Неизвестный аргумент: ${arg}`);
    }
  }

  if (args.files.length === 0) {
    throw new Error(
      'Укажите хотя бы один файл: --file "путь:метка:ГГГГ-ММ-ДД"\n' +
        'Номера колонок (--col-name и т.п.) отсчитываются с нуля.',
    );
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const out = (line: string): void => void process.stdout.write(`${line}\n`);

  const editions: PriceEdition[] = [];

  for (const file of args.files) {
    out(`\nЧитаю: ${path.basename(file.path)} (редакция ${file.label}, дата ${file.date})`);
    const sheets = await parsePriceFile(file.path, args.columns);

    const selected = args.sheet ? sheets.filter((s) => s.sheet === args.sheet) : sheets;
    if (selected.length === 0) {
      throw new Error(
        `Лист «${args.sheet}» не найден. Доступные листы: ${sheets.map((s) => s.sheet).join(', ')}`,
      );
    }

    const rows = [];
    for (const sheet of selected) {
      if (!sheet.columnMap) {
        // Не угадываем раскладку вслепую — показываем, что нашли.
        out(`  Лист «${sheet.sheet}»: колонки не распознаны.`);
        out(`  Найденные заголовки: ${sheet.detectedHeaders.join(' | ') || '(нет)'}`);
        out(
          '  Задайте колонки явно: --col-name N --col-unit N --col-price N [--col-section N] [--col-code N]',
        );
        continue;
      }
      out(
        `  Лист «${sheet.sheet}»: строк ${sheet.rows.length}, ` +
          `колонки name=${sheet.columnMap.name} unit=${sheet.columnMap.unit} price=${sheet.columnMap.price}` +
          `${sheet.columnMap.section !== undefined ? ` section=${sheet.columnMap.section}` : ''}` +
          `${sheet.columnMap.code !== undefined ? ` code=${sheet.columnMap.code}` : ''}`,
      );
      rows.push(...sheet.rows);
    }

    if (rows.length === 0) throw new Error(`Из файла ${file.path} не прочитано ни одной строки`);
    editions.push({ label: file.label, effectiveDate: file.date, rows });
  }

  const cfg = config();
  const db = openDatabase(cfg.databasePath);

  try {
    if (args.dryRun) {
      const { mergeEditions } = await import('./import.js');
      const { report } = mergeEditions(editions);
      out('\n--- Проверка без записи (--dry-run) ---');
      printReport(report, out);
      return;
    }

    const result = importPriceList(db, {
      label: args.label,
      effectiveDate:
        args.files
          .map((f) => f.date)
          .sort()
          .at(-1) ?? null,
      sourceNote: args.files.map((f) => `${path.basename(f.path)} (${f.label})`).join('; '),
      editions,
      activate: args.activate,
    });

    out('\n--- Результат импорта ---');
    printReport(result.report, out);
    out(`\nВерсия сохранена: ${result.versionId}`);
    out(
      result.activated
        ? 'Версия активирована и используется для расчётов.'
        : 'Версия НЕ активирована. Активируйте после сверки отчёта:\n' +
            `  POST /api/pricelist/versions/${result.versionId}/activate`,
    );
  } finally {
    db.close();
  }
}

function printReport(
  report: ReturnType<typeof import('./import.js').mergeEditions>['report'],
  out: (s: string) => void,
): void {
  out(formatImportSummary(report));

  out('\nРазделы:');
  for (const section of report.sections) {
    out(`  ${section.sectionNo ?? '—'}. ${section.section}: ${section.items}`);
  }

  if (report.overridden.length > 0) {
    out(`\nВытеснено свежей редакцией: ${report.overridden.length}. Первые 10:`);
    for (const o of report.overridden.slice(0, 10)) {
      out(
        `  «${o.name}»: ${o.oldPriceKopecks / 100} → ${o.newPriceKopecks / 100} (${o.fromEdition} → ${o.toEdition})`,
      );
    }
  }

  if (report.duplicatesWithinEdition.length > 0) {
    out(`\nДубли внутри редакции: ${report.duplicatesWithinEdition.length}. Проверьте исходный файл.`);
  }

  const byReason = new Map<string, number>();
  for (const r of report.rejected) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
  if (byReason.size > 0) {
    out('\nНе принято строк по причинам:');
    for (const [reason, count] of byReason) out(`  ${reason}: ${count}`);
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`\nОшибка импорта: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
