import type { ApiError } from '../api.js';
import type { JSX } from 'react';

/**
 * Показ ошибки пользователю.
 *
 * Показывается только подготовленное сообщение и код для обращения
 * в поддержку. Ни stack trace, ни сырой ответ API сюда не попадают.
 */

type Props = {
  error: ApiError;
  onRetry?: () => void;
  onDismiss?: () => void;
};

/** Что делать пользователю — зависит от кода ошибки. */
const ACTION_HINTS: Record<string, string> = {
  UNSUPPORTED_FORMAT: 'Поддерживаются PDF, JPG, PNG и WebP.',
  FILE_TOO_LARGE: 'Разделите документацию на несколько файлов.',
  PDF_CORRUPTED: 'Откройте PDF и пересохраните его из программы просмотра.',
  PDF_PASSWORD_PROTECTED: 'Снимите пароль с файла и загрузите заново.',
  UPLOAD_CHUNK_FAILED: 'Проверьте подключение — загрузка продолжится с места обрыва.',
  UPLOAD_INCOMPLETE: 'Дождитесь окончания загрузки файлов.',
  AUTH_EXPIRED: 'Войдите заново. Начатый расчёт продолжается на сервере.',
  AUTH_REQUIRED: 'Войдите в систему.',
  AI_QUOTA_EXCEEDED: 'Обратитесь к администратору: исчерпан лимит запросов.',
  AI_BILLING_PROBLEM: 'Обратитесь к администратору: проблема с оплатой сервиса анализа.',
  AI_NOT_CONFIGURED: 'Обратитесь к администратору: не настроен доступ к сервису анализа.',
  PRICE_LIST_MISSING: 'Обратитесь к администратору: не загружен активный прайс-лист.',
  JOB_TIMEOUT: 'Расчёт занял слишком много времени. Попробуйте повторить.',
  EXTRACTION_FAILED: 'Проверьте, что чертежи читаемы и не являются фотографиями низкого качества.',
};

export function ErrorBanner({ error, onRetry, onDismiss }: Props): JSX.Element {
  const hint = ACTION_HINTS[error.code];

  return (
    <div className={`banner banner--${error.retryable ? 'warning' : 'error'}`} role="alert">
      <div className="banner__content">
        <strong className="banner__title">{error.message}</strong>
        {hint && <p className="banner__hint">{hint}</p>}
        <p className="banner__code">Код ошибки: {error.code}</p>
      </div>
      <div className="banner__actions">
        {error.retryable && onRetry && (
          <button type="button" className="button button--small" onClick={onRetry}>
            Повторить
          </button>
        )}
        {onDismiss && (
          <button type="button" className="link" onClick={onDismiss}>
            Закрыть
          </button>
        )}
      </div>
    </div>
  );
}
