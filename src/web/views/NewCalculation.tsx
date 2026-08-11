import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type Job } from '../api.js';
import {
  uploadFileResumable,
  stableIdempotencyKey,
  clearIdempotencyKey,
  type UploadProgress,
} from '../upload.js';
import { ErrorBanner } from '../components/ErrorBanner.js';
import type { JSX } from 'react';

/**
 * Первый экран.
 *
 * Только общие данные объекта — сотрудник не вводит десятки технических
 * параметров. Главный источник объёмов — загруженная документация.
 */

type Props = {
  onStarted: (job: Job) => void;
  onPreliminary: (estimateId: string) => void;
};

const INITIAL_STATES = [
  { value: 'concrete', label: 'Бетон', hint: 'Черновое состояние, демонтаж не требуется' },
  { value: 'white_box', label: 'White Box', hint: 'Частичная готовность' },
  { value: 'secondary', label: 'Вторичка', hint: 'Вероятен демонтаж существующей отделки' },
] as const;

export function NewCalculationView({ onStarted, onPreliminary }: Props): JSX.Element {
  const [name, setName] = useState('');
  const [areaM2, setAreaM2] = useState('');
  const [rooms, setRooms] = useState('');
  const [initialState, setInitialState] = useState<string>('concrete');
  const [scopeLevel, setScopeLevel] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<Record<string, UploadProgress>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [priceList, setPriceList] = useState<{ label: string; itemsCount: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api
      .activePriceList()
      .then((r) => setPriceList({ label: r.version.label, itemsCount: r.version.itemsCount }))
      .catch((e: unknown) => {
        // Отсутствие прайса — не повод прятать экран: сообщаем прямо.
        if (e instanceof ApiError && e.code === 'PRICE_LIST_MISSING') setError(e);
      });
  }, []);

  const addFiles = (list: FileList | null): void => {
    if (!list) return;
    setFiles((current) => [...current, ...Array.from(list)].slice(0, 20));
  };

  const removeFile = (index: number): void => {
    setFiles((current) => current.filter((_, i) => i !== index));
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (files.length === 0) {
      setError(
        new ApiError(
          {
            code: 'VALIDATION_FAILED',
            message: 'Приложите хотя бы один файл документации.',
            retryable: false,
          },
          400,
        ),
      );
      return;
    }

    setBusy(true);
    setError(null);

    // Ключ идемпотентности переживает перезагрузку страницы:
    // повторное нажатие не создаст вторую смету.
    const seed = `${name}|${files.map((f) => `${f.name}:${f.size}`).join('|')}`;
    const idempotencyKey = stableIdempotencyKey(seed);

    try {
      const uploadIds: string[] = [];
      for (const file of files) {
        const uploadId = await uploadFileResumable(file, (p) =>
          setProgress((current) => ({ ...current, [file.name]: p })),
        );
        uploadIds.push(uploadId);
      }

      const job = await api.createJob({
        idempotencyKey,
        uploadIds,
        project: {
          name: name.trim() || 'Объект без названия',
          areaM2: areaM2 ? Number(areaM2.replace(',', '.')) : null,
          rooms: rooms ? Number(rooms) : null,
          initialState,
          scopeLevel: scopeLevel.trim() || null,
        },
      });

      clearIdempotencyKey(seed);
      onStarted(job);
    } catch (e) {
      setError(e instanceof ApiError ? e : null);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Расчёт без документации: объёмы выводятся из площади и числа комнат
   * по формулам. Документы не нужны, ИИ не участвует, ответ мгновенный.
   */
  const submitPreliminary = async (): Promise<void> => {
    const area = Number(areaM2.replace(',', '.'));
    if (!Number.isFinite(area) || area <= 0) {
      setError(
        new ApiError(
          {
            code: 'VALIDATION_FAILED',
            message: 'Для расчёта без документации укажите площадь объекта.',
            retryable: false,
          },
          400,
        ),
      );
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const result = await api.preliminary({
        name: name.trim() || 'Объект без названия',
        areaM2: area,
        rooms: rooms ? Number(rooms) : 2,
        initialState,
        scopeLevel: scopeLevel.trim() || null,
      });
      onPreliminary(result.estimateId);
    } catch (e) {
      setError(e instanceof ApiError ? e : null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel" onSubmit={(e) => void submit(e)}>
      <div className="panel__head">
        <h1>Новый расчёт</h1>
        {priceList && (
          <p className="panel__meta">
            Действующий прайс: <strong>{priceList.label}</strong> — {priceList.itemsCount} работ
          </p>
        )}
      </div>

      {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}

      <label className="field">
        <span className="field__label">Название объекта</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Например: Квартира на Ленина, 12"
          maxLength={200}
        />
      </label>

      <fieldset className="dropzone-wrap">
        <legend className="field__label">Документация</legend>
        <div
          className="dropzone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            addFiles(e.dataTransfer.files);
          }}
          onClick={() => fileInput.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') fileInput.current?.click();
          }}
        >
          <input
            ref={fileInput}
            type="file"
            multiple
            accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/*"
            onChange={(e) => addFiles(e.target.files)}
            hidden
          />
          <p className="dropzone__title">Перетащите файлы или нажмите для выбора</p>
          <p className="dropzone__hint">
            Полный дизайн-проект, частичный проект или только план помещения. PDF, JPG, PNG.
          </p>
        </div>

        {files.length > 0 && (
          <ul className="file-list">
            {files.map((file, index) => {
              const p = progress[file.name];
              return (
                <li key={`${file.name}-${index}`} className="file-list__item">
                  <div className="file-list__info">
                    <span className="file-list__name">{file.name}</span>
                    <span className="file-list__size">{(file.size / 1024 / 1024).toFixed(2)} МБ</span>
                  </div>
                  {p && p.percent < 100 && (
                    <div className="file-list__progress">
                      <div className="progress-bar">
                        <div className="progress-bar__fill" style={{ width: `${p.percent}%` }} />
                      </div>
                      <span>{p.percent}%</span>
                    </div>
                  )}
                  {!busy && (
                    <button type="button" className="link" onClick={() => removeFile(index)}>
                      Убрать
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>

      <div className="field-row">
        <label className="field">
          <span className="field__label">Площадь объекта, м²</span>
          <input
            type="text"
            inputMode="decimal"
            value={areaM2}
            onChange={(e) => setAreaM2(e.target.value.replace(/[^\d.,]/g, ''))}
            placeholder="50"
          />
        </label>

        <label className="field">
          <span className="field__label">Количество комнат</span>
          <input
            type="number"
            min={0}
            max={100}
            value={rooms}
            onChange={(e) => setRooms(e.target.value)}
            placeholder="2"
          />
        </label>
      </div>

      <fieldset className="field">
        <legend className="field__label">Исходное состояние</legend>
        <div className="choice-group">
          {INITIAL_STATES.map((option) => (
            <label
              key={option.value}
              className={`choice ${initialState === option.value ? 'is-selected' : ''}`}
            >
              <input
                type="radio"
                name="initialState"
                value={option.value}
                checked={initialState === option.value}
                onChange={(e) => setInitialState(e.target.value)}
              />
              <span className="choice__label">{option.label}</span>
              <span className="choice__hint">{option.hint}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="field">
        <span className="field__label">Общий состав или уровень ремонта</span>
        <textarea
          value={scopeLevel}
          onChange={(e) => setScopeLevel(e.target.value)}
          rows={3}
          maxLength={500}
          placeholder="Например: полный ремонт под ключ, чистовая отделка, санузел под плитку"
        />
      </label>

      <button type="submit" className="button button--primary button--large" disabled={busy}>
        {busy ? 'Загружаем документацию…' : 'Рассчитать смету'}
      </button>

      <p className="form-note">
        Объёмы берутся из документации. Вручную вводить технические параметры не нужно.
      </p>

      <div className="alt-action">
        <div className="alt-action__text">
          <strong>Нет документации под рукой?</strong>
          <span>
            Посчитаем предварительно по площади и числу комнат: объёмы выводятся по формулам, каждая видна в
            смете. Это ориентир для разговора с заказчиком, а не договорная смета.
          </span>
        </div>
        <button type="button" className="button" disabled={busy} onClick={() => void submitPreliminary()}>
          Рассчитать без документации
        </button>
      </div>
    </form>
  );
}
