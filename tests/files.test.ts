import { describe, it, expect } from 'vitest';
import {
  sanitizeFilename,
  detectMimeBySignature,
  isEncryptedPdf,
  looksLikeCompletePdf,
  estimatePdfPageCount,
  validateFile,
} from '../src/domain/files/validate.js';
import { makeTestPdf } from './helpers.js';
import { AppError } from '../src/shared/errors.js';

describe('санитизация имени файла', () => {
  it('сохраняет имя со слэшем внутри номера', () => {
    // Регрессия: «№52/2» принималось за путь, и basename отбрасывал
    // всё до слэша, превращая имя в «2 кв.380.pdf».
    expect(sanitizeFilename('Планировка. Дизайн-проект. №52/2 кв.380.pdf')).toBe(
      'Планировка. Дизайн-проект. №52-2 кв.380.pdf',
    );
  });

  it('обезвреживает обход каталогов, не теряя узнаваемости', () => {
    // Расширения здесь нет, поэтому имя сохраняется целиком.
    expect(sanitizeFilename('../../etc/passwd')).toBe('..-..-etc-passwd');
    expect(sanitizeFilename('C:\\Users\\test\\план.pdf')).toBe('C -Users-test-план.pdf');
  });

  it('убирает спецсимволы и не оставляет пустое имя', () => {
    // Спецсимволы заменяются пробелом, лишние пробелы схлопываются и срезаются.
    expect(sanitizeFilename('пла<н>:"|?*.pdf')).toBe('пла н.pdf');
    // Имя из одного расширения остаётся как есть: терять его незачем.
    expect(sanitizeFilename('.pdf')).toBe('.pdf');
  });

  it('ограничивает длину, сохраняя расширение', () => {
    const result = sanitizeFilename(`${'я'.repeat(300)}.pdf`);
    expect(result.endsWith('.pdf')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(124);
  });
});

describe('распознавание содержимого файла', () => {
  it('определяет PDF по сигнатуре, а не по расширению', () => {
    expect(detectMimeBySignature(makeTestPdf(5000))).toBe('application/pdf');
    expect(detectMimeBySignature(Buffer.from('не файл вовсе, просто текст'))).toBeNull();
  });

  it('определяет PNG и JPEG', () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(16),
    ]);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
    expect(detectMimeBySignature(png)).toBe('image/png');
    expect(detectMimeBySignature(jpeg)).toBe('image/jpeg');
  });

  it('отклоняет подделку расширения: содержимое важнее имени', () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(16),
    ]);
    expect(() =>
      validateFile({
        filename: 'на-самом-деле-картинка.pdf',
        declaredMime: 'application/pdf',
        size: png.length,
        maxBytes: 1024 * 1024,
        head: png,
      }),
    ).toThrow(AppError);
  });
});

describe('проверки PDF', () => {
  it('целый файл распознаётся как целый', () => {
    expect(looksLikeCompletePdf(makeTestPdf(10_000))).toBe(true);
  });

  it('обрезанный файл распознаётся как повреждённый', () => {
    const truncated = makeTestPdf(10_000).subarray(0, 5_000);
    expect(looksLikeCompletePdf(truncated)).toBe(false);
  });

  it('зашифрованный PDF опознаётся по словарю /Encrypt', () => {
    const encrypted = Buffer.from('%PDF-1.7\n<</Encrypt 5 0 R>>\ntrailer\n%%EOF\n', 'latin1');
    expect(isEncryptedPdf(encrypted)).toBe(true);
    expect(isEncryptedPdf(makeTestPdf(5000))).toBe(false);
  });

  it('считает страницы простого PDF', () => {
    expect(estimatePdfPageCount(makeTestPdf(50_000))).toBe(1);
  });

  it('не падает на данных без структуры страниц', () => {
    expect(estimatePdfPageCount(Buffer.from('%PDF-1.7\nничего полезного\n%%EOF'))).toBeNull();
  });
});

describe('лимиты загрузки', () => {
  it('превышение размера — отдельная ошибка, а не «неподдерживаемый формат»', () => {
    const pdf = makeTestPdf(5000);
    try {
      validateFile({
        filename: 'проект.pdf',
        declaredMime: 'application/pdf',
        size: 100_000,
        maxBytes: 50_000,
        head: pdf,
      });
      throw new Error('ожидалась ошибка');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('FILE_TOO_LARGE');
    }
  });

  it('PDF под паролем отклоняется отдельным кодом', () => {
    const encrypted = Buffer.from('%PDF-1.7\n<</Encrypt 5 0 R>>\ntrailer\n%%EOF\n', 'latin1');
    try {
      validateFile({
        filename: 'защищённый.pdf',
        declaredMime: 'application/pdf',
        size: encrypted.length,
        maxBytes: 1024 * 1024,
        head: encrypted,
      });
      throw new Error('ожидалась ошибка');
    } catch (e) {
      expect((e as AppError).code).toBe('PDF_PASSWORD_PROTECTED');
    }
  });
});
