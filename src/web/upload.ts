import { api, ApiError } from './api.js';

/**
 * Поэтапная загрузка файла с возобновлением.
 *
 * При обрыве сети недостающие части догружаются, а не начинается
 * загрузка заново. Повторная отправка уже принятой части безопасна.
 */

export type UploadProgress = {
  filename: string;
  sentBytes: number;
  totalBytes: number;
  percent: number;
};

const MAX_CHUNK_RETRIES = 5;

function backoffMs(attempt: number): number {
  // 0,5 с, 1 с, 2 с, 4 с, 8 с
  return Math.min(8000, 500 * 2 ** attempt);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function uploadFileResumable(
  file: File,
  onProgress: (progress: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  const mime = file.type || guessMime(file.name);

  const init = await api.initUpload(file.name, mime, file.size);
  const { uploadId, chunkSize, totalChunks } = init;

  let pending = Array.from({ length: totalChunks }, (_, i) => i);
  let sentBytes = 0;

  const report = (): void => {
    onProgress({
      filename: file.name,
      sentBytes,
      totalBytes: file.size,
      percent: file.size === 0 ? 100 : Math.round((sentBytes / file.size) * 100),
    });
  };

  report();

  for (let pass = 0; pass < MAX_CHUNK_RETRIES && pending.length > 0; pass += 1) {
    const failed: number[] = [];

    for (const index of pending) {
      if (signal?.aborted)
        throw new ApiError({ code: 'JOB_CANCELLED', message: 'Загрузка отменена.', retryable: true }, 0);

      const start = index * chunkSize;
      const end = Math.min(start + chunkSize, file.size);

      try {
        await api.uploadChunk(uploadId, index, file.slice(start, end));
        sentBytes += end - start;
        report();
      } catch (e) {
        // Неповторяемая ошибка прекращает загрузку немедленно.
        if (e instanceof ApiError && !e.retryable) throw e;
        failed.push(index);
      }
    }

    pending = failed;
    if (pending.length > 0) await sleep(backoffMs(pass));
  }

  if (pending.length > 0) {
    // Сверяемся с сервером: часть могла дойти, несмотря на ошибку ответа.
    const state = await api.uploadState(uploadId);
    if (state.missingChunks.length > 0) {
      throw new ApiError(
        {
          code: 'UPLOAD_CHUNK_FAILED',
          message: `Не удалось загрузить файл «${file.name}» полностью. Проверьте связь и повторите.`,
          retryable: true,
        },
        0,
      );
    }
  }

  await api.completeUpload(uploadId);
  sentBytes = file.size;
  report();

  return uploadId;
}

function guessMime(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  switch (ext) {
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Ключ идемпотентности хранится вместе с черновиком расчёта:
 * повторное нажатие кнопки (в том числе после перезагрузки страницы)
 * использует тот же ключ и не создаёт вторую смету.
 */
export function stableIdempotencyKey(seed: string): string {
  const storageKey = `smetchik:idempotency:${seed}`;
  const existing = localStorage.getItem(storageKey);
  if (existing) return existing;

  const key = `${Date.now().toString(36)}-${crypto.randomUUID()}`;
  localStorage.setItem(storageKey, key);
  return key;
}

export function clearIdempotencyKey(seed: string): void {
  localStorage.removeItem(`smetchik:idempotency:${seed}`);
}
