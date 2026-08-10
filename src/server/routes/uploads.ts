import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../shared/errors.js';
import { requireUser } from '../auth.js';
import {
  completeUpload,
  getUpload,
  initUpload,
  missingChunks,
  writeChunk,
  type UploadConfig,
} from '../../domain/files/uploads.js';

const initSchema = z.object({
  filename: z.string().min(1).max(300),
  mime: z.string().min(1).max(120),
  size: z.number().int().positive(),
});

export async function registerUploadRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.ctx;

  const uploadConfig: UploadConfig = {
    storageDir: config.storageDir,
    maxFileBytes: config.maxFileBytes,
    chunkBytes: config.uploadChunkBytes,
    ttlMs: config.uploadTtlMs,
  };

  /**
   * Шаг 1: объявление загрузки.
   * Лимит размера проверяется здесь, до передачи байтов, поэтому
   * пользователь узнаёт о превышении сразу, а не после долгой отправки.
   */
  app.post('/api/uploads', async (request) => {
    const user = requireUser(request);
    const body = initSchema.safeParse(request.body);
    if (!body.success) throw new AppError('VALIDATION_FAILED');

    const { upload, chunkSize, totalChunks } = await initUpload(db, uploadConfig, {
      userId: user.id,
      filename: body.data.filename,
      mime: body.data.mime,
      size: body.data.size,
    });

    return {
      uploadId: upload.id,
      filename: upload.filename,
      chunkSize,
      totalChunks,
      maxFileBytes: config.maxFileBytes,
    };
  });

  /**
   * Шаг 2: приём одной части.
   * Тело — двоичные данные. Повторная отправка той же части безопасна,
   * поэтому обрыв сети не начинает загрузку заново.
   */
  app.put<{ Params: { id: string; index: string } }>(
    '/api/uploads/:id/chunks/:index',
    async (request) => {
      const user = requireUser(request);
      const chunkIndex = Number(request.params.index);
      const body = request.body;

      if (!Buffer.isBuffer(body)) {
        throw new AppError('UPLOAD_CHUNK_FAILED', { reason: 'ожидаются двоичные данные' });
      }

      const progress = await writeChunk(db, request.params.id, user.id, chunkIndex, body);
      return progress;
    },
  );

  /** Какие части ещё не получены — для возобновления после обрыва. */
  app.get<{ Params: { id: string } }>('/api/uploads/:id', async (request) => {
    const user = requireUser(request);
    const upload = getUpload(db, request.params.id, user.id);
    return {
      uploadId: upload.id,
      filename: upload.filename,
      status: upload.status,
      declaredSize: upload.declared_size,
      receivedSize: upload.received_size,
      chunkSize: upload.chunk_size,
      totalChunks: upload.total_chunks,
      missingChunks: upload.status === 'complete' ? [] : missingChunks(db, upload.id, user.id),
    };
  });

  /**
   * Шаг 3: завершение.
   * Здесь проверяются комплектность, фактическая сигнатура содержимого
   * и защита паролем — до того, как файл попадёт в расчёт.
   */
  app.post<{ Params: { id: string } }>('/api/uploads/:id/complete', async (request) => {
    const user = requireUser(request);
    const upload = await completeUpload(db, uploadConfig, request.params.id, user.id);
    return {
      uploadId: upload.id,
      filename: upload.filename,
      mime: upload.mime,
      size: upload.declared_size,
      status: upload.status,
      sha256: upload.sha256,
    };
  });
}
