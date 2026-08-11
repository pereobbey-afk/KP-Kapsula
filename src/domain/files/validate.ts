import path from 'node:path';
import zlib from 'node:zlib';
import { AppError } from '../../shared/errors.js';

/**
 * Проверка загружаемых файлов.
 *
 * Проверяются четыре вещи, а не одна: расширение, заявленный MIME,
 * фактическая сигнатура содержимого и размер. Доверять только имени
 * или только заголовку Content-Type нельзя — и то и другое задаёт клиент.
 */

export const ALLOWED_MIMES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

const EXTENSION_BY_MIME: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
};

/** Сигнатуры содержимого. Проверяются по фактическим байтам. */
const SIGNATURES: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
  { mime: 'application/pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/png',
    test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    mime: 'image/webp',
    test: (b) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

/** Определяет тип по содержимому. null — тип не распознан. */
export function detectMimeBySignature(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  for (const sig of SIGNATURES) {
    if (sig.test(buffer)) return sig.mime;
  }
  return null;
}

/**
 * Убирает из имени файла всё, что может навредить файловой системе
 * или интерфейсу. Расширение сохраняется.
 */
export function sanitizeFilename(raw: string): string {
  // Разделители путей заменяются ДО basename: в реальных именах
  // встречается «№52/2», и basename отбросил бы всё до слэша,
  // превратив имя в неузнаваемое. Заодно это снимает обход каталогов.
  const flattened = raw.replace(/[\\/]+/g, '-');
  const base = path.basename(flattened);

  const rawExt = path.extname(base);
  // Слишком длинная «точка с хвостом» — это часть имени, а не расширение.
  // Обрезать её нельзя: длина основы считается от той же величины,
  // иначе конец имени будет съеден.
  const ext = rawExt.length > 1 && rawExt.length <= 10 ? rawExt.toLowerCase() : '';
  const stem = base
    .slice(0, base.length - ext.length)
    // Вырезаются управляющие символы (U+0000–U+001F) и спецсимволы
    // оболочки — в имени файла они недопустимы.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F<>:"|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

  const safeStem = stem || 'файл';
  return `${safeStem}${ext}`;
}

export type FileValidationInput = {
  filename: string;
  declaredMime: string;
  size: number;
  maxBytes: number;
  /** Первые байты файла для проверки сигнатуры. */
  head: Buffer;
};

export type ValidatedFile = {
  filename: string;
  mime: string;
  size: number;
};

/**
 * Полная проверка файла. Бросает AppError с точным кодом,
 * чтобы пользователь увидел причину, а не «что-то пошло не так».
 */
export function validateFile(input: FileValidationInput): ValidatedFile {
  if (input.size <= 0) {
    throw new AppError('UPLOAD_INCOMPLETE', { reason: 'пустой файл' });
  }
  // Фактический лимит размера — отдельная ошибка, не «неподдерживаемый формат».
  if (input.size > input.maxBytes) {
    throw new AppError('FILE_TOO_LARGE', { size: input.size, maxBytes: input.maxBytes });
  }

  const detected = detectMimeBySignature(input.head);
  if (!detected) {
    throw new AppError('UNSUPPORTED_FORMAT', { reason: 'сигнатура не распознана' });
  }
  if (!ALLOWED_MIMES.has(detected)) {
    throw new AppError('UNSUPPORTED_FORMAT', { detected });
  }

  // Заявленный тип и фактическое содержимое должны совпадать.
  if (input.declaredMime && ALLOWED_MIMES.has(input.declaredMime) && input.declaredMime !== detected) {
    throw new AppError('UNSUPPORTED_FORMAT', {
      reason: 'заявленный тип не совпадает с содержимым',
      declared: input.declaredMime,
      detected,
    });
  }

  const filename = sanitizeFilename(input.filename);
  const ext = path.extname(filename).toLowerCase();
  const allowedExts = EXTENSION_BY_MIME[detected] ?? [];
  if (ext && !allowedExts.includes(ext)) {
    throw new AppError('UNSUPPORTED_FORMAT', {
      reason: 'расширение не соответствует содержимому',
      ext,
      detected,
    });
  }

  if (detected === 'application/pdf' && isEncryptedPdf(input.head)) {
    throw new AppError('PDF_PASSWORD_PROTECTED');
  }

  return { filename, mime: detected, size: input.size };
}

/**
 * Признак зашифрованного PDF.
 * Словарь /Encrypt в трейлере означает, что содержимое защищено.
 */
export function isEncryptedPdf(buffer: Buffer): boolean {
  // Шифрование объявляется в трейлере — он в конце файла,
  // но у линеаризованных PDF встречается и в начале.
  const head = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('latin1');
  const tail = buffer.subarray(Math.max(0, buffer.length - 4096)).toString('latin1');
  return /\/Encrypt\s/.test(head) || /\/Encrypt\s/.test(tail);
}

/**
 * Оценка числа страниц PDF.
 *
 * В PDF 1.5+ объекты часто лежат в сжатых потоках (/ObjStm), поэтому
 * по сырым байтам счётчик ничего не находит. Поэтому при нулевом
 * результате потоки распаковываются и просматриваются заново.
 */
export function estimatePdfPageCount(buffer: Buffer): number | null {
  // Объекты страниц могут быть раскиданы по нескольким потокам, поэтому
  // они суммируются. /Count корневого узла дерева страниц даёт общее
  // число напрямую — берём наибольшее из двух оценок.
  let pageObjects = countPageObjects(buffer.toString('latin1'));
  let maxCount = maxPageTreeCount(buffer.toString('latin1'));

  const marker = Buffer.from('stream');
  const endMarker = Buffer.from('endstream');
  let from = 0;
  for (;;) {
    const index = buffer.indexOf(marker, from);
    if (index === -1) break;

    // «endstream» тоже содержит «stream»: без этой проверки потоки
    // распаковывались бы с наложением и страницы считались дважды.
    if (index >= 3 && buffer.subarray(index - 3, index).toString('latin1') === 'end') {
      from = index + marker.length;
      continue;
    }
    from = index + marker.length;

    let start = from;
    if (buffer[start] === 0x0d) start += 1;
    if (buffer[start] === 0x0a) start += 1;

    const end = buffer.indexOf(endMarker, start);
    if (end === -1) break;
    from = end + endMarker.length;

    try {
      const text = zlib.inflateSync(buffer.subarray(start, end)).toString('latin1');
      pageObjects += countPageObjects(text);
      maxCount = Math.max(maxCount, maxPageTreeCount(text));
    } catch {
      // Поток не сжат методом Flate или повреждён — пропускаем.
    }
  }

  const best = Math.max(pageObjects, maxCount);
  return best > 0 ? best : null;
}

/** Число объектов страниц: «/Type /Page», но не «/Pages». */
function countPageObjects(text: string): number {
  return text.match(/\/Type\s*\/Page(?![s])/g)?.length ?? 0;
}

/** Наибольшее значение /Count — в корне дерева страниц это общее число. */
function maxPageTreeCount(text: string): number {
  const counts = [...text.matchAll(/\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  return counts.length > 0 ? Math.max(...counts) : 0;
}

/** Проверка, что PDF не оборван на середине. */
export function looksLikeCompletePdf(buffer: Buffer): boolean {
  if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') return false;
  const tail = buffer.subarray(Math.max(0, buffer.length - 2048)).toString('latin1');
  return tail.includes('%%EOF');
}
