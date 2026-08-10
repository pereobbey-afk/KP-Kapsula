import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Db } from '../../db/index.js';
import { AppError } from '../../shared/errors.js';
import { newId } from '../../shared/crypto.js';
import { ALLOWED_MIMES, sanitizeFilename, validateFile } from './validate.js';

/**
 * Поэтапная загрузка файлов.
 *
 * Крупный PDF не передаётся целиком в теле одного запроса: он приходит
 * частями и пишется в один файл по смещениям. Поэтому обрыв сети не
 * начинает загрузку заново — недостающие части догружаются,
 * а уже принятые видны в статусе.
 */

export type UploadRow = {
  id: string;
  user_id: string;
  filename: string;
  original_filename: string;
  mime: string;
  declared_size: number;
  received_size: number;
  chunk_size: number;
  total_chunks: number;
  storage_path: string;
  sha256: string | null;
  status: 'pending' | 'complete' | 'failed' | 'expired';
  error_code: string | null;
  created_at: number;
  completed_at: number | null;
  expires_at: number;
};

export type InitUploadInput = {
  userId: string;
  filename: string;
  mime: string;
  size: number;
};

export type UploadConfig = {
  storageDir: string;
  maxFileBytes: number;
  chunkBytes: number;
  ttlMs: number;
};

export async function initUpload(
  db: Db,
  cfg: UploadConfig,
  input: InitUploadInput,
): Promise<{ upload: UploadRow; chunkSize: number; totalChunks: number }> {
  if (!Number.isInteger(input.size) || input.size <= 0) {
    throw new AppError('VALIDATION_FAILED', { field: 'size' });
  }
  // Лимит проверяется до приёма байтов — пользователь узнаёт сразу,
  // а не после долгой загрузки.
  if (input.size > cfg.maxFileBytes) {
    throw new AppError('FILE_TOO_LARGE', { size: input.size, maxBytes: cfg.maxFileBytes });
  }
  if (!ALLOWED_MIMES.has(input.mime)) {
    throw new AppError('UNSUPPORTED_FORMAT', { declared: input.mime });
  }

  const id = newId('upl');
  const filename = sanitizeFilename(input.filename);
  const dir = path.join(cfg.storageDir, id.slice(0, 8));
  await fs.mkdir(dir, { recursive: true });
  const storagePath = path.join(dir, `${id}${path.extname(filename)}`);

  // Файл создаётся сразу нужного размера: части пишутся по смещениям.
  const handle = await fs.open(storagePath, 'w');
  try {
    await handle.truncate(input.size);
  } finally {
    await handle.close();
  }

  const now = Date.now();
  const chunkSize = cfg.chunkBytes;
  const totalChunks = Math.ceil(input.size / chunkSize);

  const upload: UploadRow = {
    id,
    user_id: input.userId,
    filename,
    original_filename: input.filename.slice(0, 300),
    mime: input.mime,
    declared_size: input.size,
    received_size: 0,
    chunk_size: chunkSize,
    total_chunks: totalChunks,
    storage_path: storagePath,
    sha256: null,
    status: 'pending',
    error_code: null,
    created_at: now,
    completed_at: null,
    expires_at: now + cfg.ttlMs,
  };

  db.prepare(
    `INSERT INTO uploads (
       id, user_id, filename, original_filename, mime, declared_size, received_size,
       chunk_size, total_chunks, storage_path, sha256, status, error_code,
       created_at, completed_at, expires_at
     ) VALUES (
       @id, @user_id, @filename, @original_filename, @mime, @declared_size, @received_size,
       @chunk_size, @total_chunks, @storage_path, @sha256, @status, @error_code,
       @created_at, @completed_at, @expires_at
     )`,
  ).run(upload);

  return { upload, chunkSize, totalChunks };
}

export function getUpload(db: Db, uploadId: string, userId: string): UploadRow {
  const row = db.prepare('SELECT * FROM uploads WHERE id = ?').get(uploadId) as UploadRow | undefined;
  // Чужая загрузка неотличима от несуществующей.
  if (!row || row.user_id !== userId) throw new AppError('NOT_FOUND');
  return row;
}

/** Записывает одну часть файла. Повторная запись той же части безопасна. */
export async function writeChunk(
  db: Db,
  uploadId: string,
  userId: string,
  chunkIndex: number,
  data: Buffer,
): Promise<{ receivedChunks: number; totalChunks: number; receivedSize: number }> {
  const upload = getUpload(db, uploadId, userId);

  if (upload.status === 'complete') {
    return {
      receivedChunks: upload.total_chunks,
      totalChunks: upload.total_chunks,
      receivedSize: upload.received_size,
    };
  }
  if (upload.status !== 'pending') {
    throw new AppError('UPLOAD_CHUNK_FAILED', { status: upload.status });
  }
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= upload.total_chunks) {
    throw new AppError('UPLOAD_CHUNK_FAILED', { reason: 'номер части вне диапазона', chunkIndex });
  }

  const offset = chunkIndex * upload.chunk_size;
  const expectedSize = Math.min(upload.chunk_size, upload.declared_size - offset);
  if (data.length !== expectedSize) {
    throw new AppError('UPLOAD_CHUNK_FAILED', {
      reason: 'размер части не совпадает с ожидаемым',
      chunkIndex,
      expected: expectedSize,
      actual: data.length,
    });
  }

  const handle = await fs.open(upload.storage_path, 'r+');
  try {
    await handle.write(data, 0, data.length, offset);
  } finally {
    await handle.close();
  }

  // Повторная отправка той же части не увеличивает счётчик.
  const inserted = db
    .prepare(
      `INSERT INTO upload_chunks (upload_id, chunk_index, size, received_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (upload_id, chunk_index) DO NOTHING`,
    )
    .run(uploadId, chunkIndex, data.length, Date.now());

  if (inserted.changes > 0) {
    db.prepare('UPDATE uploads SET received_size = received_size + ? WHERE id = ?').run(
      data.length,
      uploadId,
    );
  }

  const received = db
    .prepare('SELECT COUNT(*) AS c FROM upload_chunks WHERE upload_id = ?')
    .get(uploadId) as { c: number };
  const current = db.prepare('SELECT received_size FROM uploads WHERE id = ?').get(uploadId) as {
    received_size: number;
  };

  return {
    receivedChunks: received.c,
    totalChunks: upload.total_chunks,
    receivedSize: current.received_size,
  };
}

/** Части, которых ещё нет. Позволяет клиенту догрузить только их. */
export function missingChunks(db: Db, uploadId: string, userId: string): number[] {
  const upload = getUpload(db, uploadId, userId);
  const present = new Set(
    (
      db.prepare('SELECT chunk_index FROM upload_chunks WHERE upload_id = ?').all(uploadId) as Array<{
        chunk_index: number;
      }>
    ).map((r) => r.chunk_index),
  );

  const missing: number[] = [];
  for (let i = 0; i < upload.total_chunks; i += 1) {
    if (!present.has(i)) missing.push(i);
  }
  return missing;
}

/**
 * Завершает загрузку: проверяет комплектность, сигнатуру содержимого
 * и считает контрольную сумму.
 */
export async function completeUpload(
  db: Db,
  cfg: UploadConfig,
  uploadId: string,
  userId: string,
): Promise<UploadRow> {
  const upload = getUpload(db, uploadId, userId);
  if (upload.status === 'complete') return upload;

  const missing = missingChunks(db, uploadId, userId);
  if (missing.length > 0) {
    throw new AppError('UPLOAD_INCOMPLETE', { missingChunks: missing.slice(0, 20), total: missing.length });
  }

  const stat = await fs.stat(upload.storage_path);
  if (stat.size !== upload.declared_size) {
    throw new AppError('UPLOAD_INCOMPLETE', { expected: upload.declared_size, actual: stat.size });
  }

  // Проверка по фактическому содержимому, а не по заявленному типу.
  const handle = await fs.open(upload.storage_path, 'r');
  let head: Buffer;
  let tail: Buffer;
  try {
    head = Buffer.alloc(Math.min(4096, stat.size));
    await handle.read(head, 0, head.length, 0);
    const tailSize = Math.min(4096, stat.size);
    tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tailSize, Math.max(0, stat.size - tailSize));
  } finally {
    await handle.close();
  }

  try {
    validateFile({
      filename: upload.filename,
      declaredMime: upload.mime,
      size: stat.size,
      maxBytes: cfg.maxFileBytes,
      head: Buffer.concat([head, tail]),
    });
  } catch (e) {
    const code = e instanceof AppError ? e.code : 'UNSUPPORTED_FORMAT';
    db.prepare("UPDATE uploads SET status = 'failed', error_code = ? WHERE id = ?").run(code, uploadId);
    throw e;
  }

  const digest = await sha256File(upload.storage_path);
  db.prepare(
    "UPDATE uploads SET status = 'complete', sha256 = ?, completed_at = ? WHERE id = ?",
  ).run(digest, Date.now(), uploadId);

  return getUpload(db, uploadId, userId);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}
