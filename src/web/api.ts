/**
 * Клиент API.
 *
 * Ключевое правило: любой ответ разбирается через safeJson. Если сервер
 * или прокси вернул HTML вместо JSON, пользователь увидит понятное
 * сообщение, а не «Unexpected token '<'».
 */

export type ApiErrorBody = {
  code: string;
  message: string;
  retryable: boolean;
};

export class ApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;

  constructor(body: ApiErrorBody, status: number) {
    super(body.message);
    this.name = 'ApiError';
    this.code = body.code;
    this.retryable = body.retryable;
    this.status = status;
  }
}

const NETWORK_ERROR: ApiErrorBody = {
  code: 'NETWORK_TEMPORARY',
  message: 'Нет связи с сервером. Проверьте подключение — расчёт при этом не прерывается.',
  retryable: true,
};

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Сюда попадает HTML служебной страницы прокси или балансировщика.
    throw new ApiError(
      {
        code: response.status === 502 || response.status === 504 ? 'NETWORK_TEMPORARY' : 'INTERNAL',
        message:
          response.status >= 500
            ? 'Сервер временно недоступен. Расчёт продолжается — обновите страницу через минуту.'
            : 'Неожиданный ответ сервера.',
        retryable: response.status >= 500,
      },
      response.status,
    );
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: 'same-origin', ...init });
  } catch {
    throw new ApiError(NETWORK_ERROR, 0);
  }

  const body = await safeJson(response);

  if (!response.ok) {
    const error = (body as { error?: ApiErrorBody }).error;
    throw new ApiError(
      error ?? { code: 'INTERNAL', message: 'Внутренняя ошибка сервера.', retryable: true },
      response.status,
    );
  }
  return body as T;
}

const json = (data: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(data),
});

// ---------- Типы ----------

export type User = { id: string; email: string; role: 'user' | 'admin' };

export type JobStatus =
  | 'queued'
  | 'uploading'
  | 'classifying'
  | 'extracting'
  | 'validating'
  | 'calculating'
  | 'completed'
  | 'failed';

export type Job = {
  jobId: string;
  projectId: string;
  status: JobStatus;
  stage: string;
  progress: number;
  attempts: number;
  maxAttempts: number;
  estimateId: string | null;
  error: { code: string; message: string } | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  timeline: Array<{ status: string; message: string | null; durationMs: number | null; at: number }>;
  recoveryToken?: string | null;
  deduplicated?: boolean;
};

export type EstimateLine = {
  id: string;
  position: number;
  code: string;
  section: string;
  sectionNo: number | null;
  name: string;
  unit: string;
  quantity: number;
  priceKopecks: number;
  amountKopecks: number;
  confidence: 'confirmed' | 'derived' | 'assumption';
  confidenceLabel: string;
  isManual: boolean;
  source: { fileId: string | null; page: number | null; ref: string | null };
  note: string | null;
};

export type EstimateNote = {
  id: string;
  kind: 'assumption' | 'clarification' | 'omission' | 'excluded';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string | null;
};

export type EstimateResponse = {
  estimate: {
    id: string;
    projectId: string;
    projectName: string;
    revision: number;
    documentType: string;
    documentTypeLabel: string;
    isPreliminary: boolean;
    priceListLabel: string;
    priceListVersionId: string;
    areaM2: number | null;
    totalKopecks: number;
    pricePerM2Kopecks: number | null;
    createdAt: number;
  };
  files: Array<{ id: string; filename: string; pageCount: number | null }>;
  lines: EstimateLine[];
  notes: EstimateNote[];
};

export type ProjectSummary = {
  id: string;
  name: string;
  areaM2: number | null;
  rooms: number | null;
  initialState: string | null;
  scopeLevel: string | null;
  createdAt: number;
  updatedAt: number;
  latestEstimate: {
    id: string;
    totalKopecks: number;
    revision: number;
    isPreliminary: boolean;
    createdAt: number;
  } | null;
};

export type PriceItem = {
  code: string;
  section: string;
  sectionNo: number | null;
  name: string;
  unit: string;
  priceKopecks: number;
};

// ---------- Методы ----------

export const api = {
  setupState: () => request<{ needsSetup: boolean }>('/api/auth/setup-state'),
  me: () => request<{ user: User }>('/api/auth/me'),
  login: (email: string, password: string) =>
    request<{ user: User }>('/api/auth/login', json({ email, password })),
  register: (email: string, password: string) =>
    request<{ user: User }>('/api/auth/register', json({ email, password })),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  initUpload: (filename: string, mime: string, size: number) =>
    request<{
      uploadId: string;
      filename: string;
      chunkSize: number;
      totalChunks: number;
      maxFileBytes: number;
    }>('/api/uploads', json({ filename, mime, size })),

  uploadChunk: async (uploadId: string, index: number, chunk: Blob): Promise<void> => {
    const response = await fetch(`/api/uploads/${uploadId}/chunks/${index}`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/octet-stream' },
      body: chunk,
    });
    if (!response.ok) {
      const body = (await safeJson(response)) as { error?: ApiErrorBody };
      throw new ApiError(body.error ?? NETWORK_ERROR, response.status);
    }
  },

  uploadState: (uploadId: string) =>
    request<{
      uploadId: string;
      status: string;
      declaredSize: number;
      receivedSize: number;
      chunkSize: number;
      totalChunks: number;
      missingChunks: number[];
    }>(`/api/uploads/${uploadId}`),

  completeUpload: (uploadId: string) =>
    request<{ uploadId: string; filename: string; size: number; status: string }>(
      `/api/uploads/${uploadId}/complete`,
      { method: 'POST' },
    ),

  createJob: (payload: {
    idempotencyKey: string;
    uploadIds: string[];
    project: {
      name: string;
      areaM2: number | null;
      rooms: number | null;
      initialState: string | null;
      scopeLevel: string | null;
    };
  }) => request<Job>('/api/jobs', json(payload)),

  getJob: (jobId: string, token?: string | null) =>
    request<Job>(`/api/jobs/${jobId}${token ? `?token=${encodeURIComponent(token)}` : ''}`),

  activeJobs: () => request<{ jobs: Job[] }>('/api/jobs'),
  retryJob: (jobId: string) => request<Job>(`/api/jobs/${jobId}/retry`, { method: 'POST' }),

  getEstimate: (id: string) => request<EstimateResponse>(`/api/estimates/${id}`),

  editLine: (estimateId: string, lineId: string, quantity: number) =>
    request<{ line: EstimateLine; totalKopecks: number; pricePerM2Kopecks: number | null }>(
      `/api/estimates/${estimateId}/lines/${lineId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ quantity }),
      },
    ),

  addLine: (estimateId: string, code: string, quantity: number) =>
    request<{ line: EstimateLine }>(`/api/estimates/${estimateId}/lines`, json({ code, quantity })),

  removeLine: (estimateId: string, lineId: string) =>
    request<{ ok: boolean; totalKopecks: number; pricePerM2Kopecks: number | null }>(
      `/api/estimates/${estimateId}/lines/${lineId}`,
      { method: 'DELETE' },
    ),

  projects: () => request<{ projects: ProjectSummary[] }>('/api/projects'),

  priceItems: (query: string) =>
    request<{ items: PriceItem[] }>(`/api/pricelist/items?q=${encodeURIComponent(query)}&limit=40`),

  activePriceList: () =>
    request<{ version: { id: string; label: string; itemsCount: number; sectionsCount: number } }>(
      '/api/pricelist/active',
    ),
};

/** Копейки → «1 234,56 ₽». */
export function formatMoney(kopecks: number): string {
  const negative = kopecks < 0;
  const abs = Math.abs(kopecks);
  const rubles = Math.trunc(abs / 100);
  const cents = abs % 100;
  const grouped = String(rubles).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0');
  return `${negative ? '\u2212' : ''}${grouped},${String(cents).padStart(2, '0')}\u00A0\u20BD`;
}

export function formatQuantity(value: number): string {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(value);
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '';
  if (ms < 1000) return `${ms} мс`;
  const seconds = Math.round(ms / 100) / 10;
  if (seconds < 60) return `${seconds.toString().replace('.', ',')} с`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} мин ${Math.round(seconds % 60)} с`;
}
