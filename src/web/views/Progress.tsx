import { useEffect, useRef, useState } from 'react';
import { api, ApiError, formatDuration, type Job, type JobStatus } from '../api.js';
import { ErrorBanner } from '../components/ErrorBanner.js';
import type { JSX } from 'react';

/**
 * Экран хода расчёта.
 *
 * Опрос статуса — короткие запросы. Обрыв связи или закрытие вкладки
 * задачу не убивают: она живёт на сервере. Поэтому сообщение о том,
 * что страницу можно закрыть, здесь правдиво и подтверждено тестами.
 */

type Props = {
  jobId: string;
  onCompleted: (estimateId: string) => void;
  onCancelled: () => void;
};

const STAGES: Array<{ status: JobStatus; label: string; description: string }> = [
  { status: 'uploading', label: 'Загрузка файлов', description: 'Документация передаётся на сервер' },
  { status: 'queued', label: 'В очереди', description: 'Задача ожидает свободный расчётный процесс' },
  {
    status: 'classifying',
    label: 'Определение типа документа',
    description: 'Полный проект, частичный или планировка',
  },
  { status: 'extracting', label: 'Извлечение объёмов', description: 'Чтение планов, ведомостей и размеров' },
  { status: 'validating', label: 'Проверка данных', description: 'Сверка с прайсом и контроль полноты' },
  { status: 'calculating', label: 'Расчёт сметы', description: 'Расчёт по действующему прайс-листу' },
];

const ORDER: JobStatus[] = ['uploading', 'queued', 'classifying', 'extracting', 'validating', 'calculating'];

export function ProgressView({ jobId, onCompleted, onCancelled }: Props): JSX.Element {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [offline, setOffline] = useState(false);
  const completedRef = useRef(false);

  useEffect(() => {
    let stop = false;
    let delay = 1000;

    const poll = async (): Promise<void> => {
      if (stop) return;

      try {
        // Токен восстановления позволяет видеть статус даже после
        // истечения сессии интерфейса.
        const token = localStorage.getItem(`smetchik:recovery:${jobId}`);
        const next = await api.getJob(jobId, token);

        if (stop) return;
        setJob(next);
        setOffline(false);
        setError(null);
        // Пока задача идёт — опрашиваем часто, потом реже.
        delay = next.status === 'queued' ? 2000 : 1500;

        if (next.status === 'completed' && next.estimateId && !completedRef.current) {
          completedRef.current = true;
          localStorage.removeItem(`smetchik:recovery:${jobId}`);
          onCompleted(next.estimateId);
          return;
        }
        if (next.status === 'failed') {
          setError(
            new ApiError(
              {
                code: next.error?.code ?? 'INTERNAL',
                message: next.error?.message ?? 'Расчёт не выполнен.',
                retryable: true,
              },
              500,
            ),
          );
        }
      } catch (e) {
        if (stop) return;
        if (e instanceof ApiError && e.retryable) {
          // Временная сетевая ошибка: задача продолжается, просто
          // увеличиваем паузу между опросами.
          setOffline(true);
          delay = Math.min(delay * 2, 15_000);
        } else if (e instanceof ApiError) {
          setError(e);
          return;
        }
      }

      if (!stop) setTimeout(() => void poll(), delay);
    };

    void poll();
    return () => {
      stop = true;
    };
  }, [jobId, onCompleted]);

  const retry = async (): Promise<void> => {
    try {
      setError(null);
      completedRef.current = false;
      const next = await api.retryJob(jobId);
      setJob(next);
    } catch (e) {
      setError(e instanceof ApiError ? e : null);
    }
  };

  const currentIndex = job ? ORDER.indexOf(job.status) : -1;
  const durations = new Map(job?.timeline.map((t) => [t.status, t.durationMs]) ?? []);

  return (
    <section className="panel">
      <div className="panel__head">
        <h1>Идёт расчёт сметы</h1>
        <p className="panel__meta">
          Задача выполняется на сервере. Страницу <strong>можно закрыть или обновить</strong> — расчёт
          продолжится, а результат появится в истории проектов.
        </p>
      </div>

      {offline && (
        <div className="banner banner--warning" role="status">
          <div className="banner__content">
            <strong className="banner__title">Связь с сервером потеряна</strong>
            <p className="banner__hint">
              Расчёт при этом не прерван. Подключение восстановится автоматически.
            </p>
          </div>
        </div>
      )}

      {error && <ErrorBanner error={error} onRetry={() => void retry()} onDismiss={() => setError(null)} />}

      <div className="progress-bar progress-bar--large">
        <div className="progress-bar__fill" style={{ width: `${job?.progress ?? 0}%` }} />
      </div>
      <p className="progress-caption">
        {job?.stage ?? 'Подготовка…'} — {job?.progress ?? 0}%
        {job && job.attempts > 1 && (
          <span className="progress-caption__retry">
            {' '}
            (попытка {job.attempts} из {job.maxAttempts})
          </span>
        )}
      </p>

      <ol className="stages">
        {STAGES.map((stage) => {
          const index = ORDER.indexOf(stage.status);
          const isDone = job?.status === 'completed' || (currentIndex >= 0 && index < currentIndex);
          const isCurrent = job?.status === stage.status;
          const duration = durations.get(stage.status);

          return (
            <li
              key={stage.status}
              className={`stage ${isDone ? 'is-done' : ''} ${isCurrent ? 'is-current' : ''}`}
            >
              <span className="stage__marker" aria-hidden="true">
                {isDone ? '✓' : isCurrent ? '●' : '○'}
              </span>
              <span className="stage__body">
                <span className="stage__label">{stage.label}</span>
                <span className="stage__description">{stage.description}</span>
              </span>
              {duration != null && duration > 0 && (
                <span className="stage__duration">{formatDuration(duration)}</span>
              )}
            </li>
          );
        })}
      </ol>

      <div className="panel__actions">
        <button type="button" className="link" onClick={onCancelled}>
          Вернуться к форме
        </button>
      </div>
    </section>
  );
}
