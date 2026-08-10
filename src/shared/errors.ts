/**
 * Единая таксономия ошибок.
 *
 * Правило: наружу уходит только { code, message, retryable }.
 * HTML служебных страниц, stack trace и сырой ответ внешнего API
 * никогда не попадают пользователю — они остаются в серверном логе.
 */

export const ERROR_CODES = [
  // Загрузка и файлы
  'UNSUPPORTED_FORMAT',
  'FILE_TOO_LARGE',
  'PDF_CORRUPTED',
  'PDF_PASSWORD_PROTECTED',
  'UPLOAD_CHUNK_FAILED',
  'UPLOAD_INCOMPLETE',
  'TOO_MANY_FILES',

  // Доступ
  'AUTH_REQUIRED',
  'AUTH_EXPIRED',
  'FORBIDDEN',
  'NOT_FOUND',

  // Сеть и внешние сервисы
  'NETWORK_TEMPORARY',
  'AI_UNAVAILABLE',
  'AI_QUOTA_EXCEEDED',
  'AI_BILLING_PROBLEM',
  'AI_NOT_CONFIGURED',

  // Обработка
  'EXTRACTION_FAILED',
  'EXTRACTION_SCHEMA_INVALID',
  'JOB_TIMEOUT',
  'JOB_CANCELLED',

  // Прайс и расчёт
  'PRICE_LIST_MISSING',
  'PRICE_ITEM_UNKNOWN',
  'CALCULATION_FAILED',

  // Прочее
  'VALIDATION_FAILED',
  'RATE_LIMITED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

type ErrorSpec = {
  /** Что видит пользователь. Без технических деталей. */
  message: string;
  /** HTTP-статус для ответа API. */
  status: number;
  /**
   * Можно ли безопасно повторить операцию.
   * Управляет и кнопкой «Повторить» в интерфейсе, и retry воркера.
   */
  retryable: boolean;
};

const SPECS: Record<ErrorCode, ErrorSpec> = {
  UNSUPPORTED_FORMAT: {
    message: 'Формат файла не поддерживается. Загрузите PDF, JPG или PNG.',
    status: 415,
    retryable: false,
  },
  FILE_TOO_LARGE: {
    message: 'Файл превышает допустимый размер.',
    status: 413,
    retryable: false,
  },
  PDF_CORRUPTED: {
    message: 'PDF повреждён и не читается. Пересохраните файл и попробуйте снова.',
    status: 422,
    retryable: false,
  },
  PDF_PASSWORD_PROTECTED: {
    message: 'PDF защищён паролем. Снимите защиту и загрузите файл заново.',
    status: 422,
    retryable: false,
  },
  UPLOAD_CHUNK_FAILED: {
    message: 'Часть файла не загрузилась. Загрузка возобновится автоматически.',
    status: 409,
    retryable: true,
  },
  UPLOAD_INCOMPLETE: {
    message: 'Файл загружен не полностью. Дождитесь окончания загрузки.',
    status: 409,
    retryable: true,
  },
  TOO_MANY_FILES: {
    message: 'Слишком много файлов в одном расчёте.',
    status: 400,
    retryable: false,
  },

  AUTH_REQUIRED: {
    message: 'Требуется вход в систему.',
    status: 401,
    retryable: false,
  },
  AUTH_EXPIRED: {
    message: 'Сессия истекла. Войдите заново — начатый расчёт не потерян.',
    status: 401,
    retryable: false,
  },
  FORBIDDEN: {
    message: 'Нет доступа к этому объекту.',
    status: 403,
    retryable: false,
  },
  NOT_FOUND: {
    message: 'Объект не найден.',
    status: 404,
    retryable: false,
  },

  NETWORK_TEMPORARY: {
    message: 'Временная ошибка сети. Повторяем автоматически.',
    status: 503,
    retryable: true,
  },
  AI_UNAVAILABLE: {
    message: 'Сервис анализа документов временно недоступен. Расчёт будет повторён.',
    status: 503,
    retryable: true,
  },
  AI_QUOTA_EXCEEDED: {
    message: 'Исчерпан лимит запросов к сервису анализа. Обратитесь к администратору.',
    status: 429,
    retryable: false,
  },
  AI_BILLING_PROBLEM: {
    message: 'Проблема с оплатой сервиса анализа. Обратитесь к администратору.',
    status: 402,
    retryable: false,
  },
  AI_NOT_CONFIGURED: {
    message: 'Сервис анализа документов не настроен. Обратитесь к администратору.',
    status: 503,
    retryable: false,
  },

  EXTRACTION_FAILED: {
    message: 'Не удалось распознать документ. Проверьте читаемость чертежей.',
    status: 422,
    retryable: true,
  },
  EXTRACTION_SCHEMA_INVALID: {
    message: 'Результат анализа не прошёл проверку. Расчёт остановлен во избежание ошибок в смете.',
    status: 422,
    retryable: true,
  },
  JOB_TIMEOUT: {
    message: 'Расчёт превысил допустимое время. Можно повторить.',
    status: 504,
    retryable: true,
  },
  JOB_CANCELLED: {
    message: 'Расчёт отменён.',
    status: 409,
    retryable: true,
  },

  PRICE_LIST_MISSING: {
    message: 'Активный прайс-лист не загружен. Обратитесь к администратору.',
    status: 503,
    retryable: false,
  },
  PRICE_ITEM_UNKNOWN: {
    message: 'В расчёте встретилась позиция, которой нет в активном прайсе.',
    status: 422,
    retryable: false,
  },
  CALCULATION_FAILED: {
    message: 'Внутренняя ошибка расчёта сметы.',
    status: 500,
    retryable: true,
  },

  VALIDATION_FAILED: {
    message: 'Проверьте правильность заполнения полей.',
    status: 400,
    retryable: false,
  },
  RATE_LIMITED: {
    message: 'Слишком много запросов. Подождите немного.',
    status: 429,
    retryable: true,
  },
  INTERNAL: {
    message: 'Внутренняя ошибка сервера. Мы уже знаем о проблеме.',
    status: 500,
    retryable: true,
  },
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  /** Технические детали — только для лога, наружу не отдаются. */
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, details?: Record<string, unknown>, cause?: unknown) {
    const spec = SPECS[code];
    super(spec.message, cause === undefined ? undefined : { cause });
    this.name = 'AppError';
    this.code = code;
    this.status = spec.status;
    this.retryable = spec.retryable;
    this.details = details;
  }

  /** Безопасное представление для клиента. */
  toPublic(): { code: ErrorCode; message: string; retryable: boolean } {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/**
 * Приводит любую пойманную ошибку к AppError.
 * Неизвестные ошибки становятся INTERNAL — наружу не утекает ни текст, ни stack.
 */
export function toAppError(e: unknown): AppError {
  if (isAppError(e)) return e;
  return new AppError('INTERNAL', { original: describeUnknown(e) }, e);
}

/** Короткое описание неизвестной ошибки для лога (без stack и без секретов). */
export function describeUnknown(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === 'string') return e.slice(0, 500);
  try {
    return JSON.stringify(e)?.slice(0, 500) ?? 'unknown';
  } catch {
    return 'unserializable error';
  }
}

export function publicErrorBody(e: unknown): {
  error: { code: ErrorCode; message: string; retryable: boolean };
} {
  return { error: toAppError(e).toPublic() };
}
