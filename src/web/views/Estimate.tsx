import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  ApiError,
  formatMoney,
  formatQuantity,
  type EstimateNote,
  type EstimateResponse,
  type PriceItem,
} from '../api.js';
import { ErrorBanner } from '../components/ErrorBanner.js';
import type { JSX } from 'react';

type Props = { estimateId: string; onBack: () => void };

const NOTE_GROUPS: Array<{ kind: EstimateNote['kind']; title: string; description: string }> = [
  { kind: 'omission', title: 'Потенциальные пропуски', description: 'Проверьте, не забыт ли блок работ' },
  { kind: 'excluded', title: 'Не включено в расчёт', description: 'Данных нет — в итог не входит' },
  { kind: 'clarification', title: 'Критические уточнения', description: 'Требуют проверки сотрудником' },
  { kind: 'assumption', title: 'Принятые допущения', description: 'Приняты при отсутствии точных данных' },
];

const CONFIDENCE_CLASS: Record<string, string> = {
  confirmed: 'chip--confirmed',
  derived: 'chip--derived',
  assumption: 'chip--assumption',
};

export function EstimateView({ estimateId, onBack }: Props): JSX.Element {
  const [data, setData] = useState<EstimateResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<PriceItem[]>([]);
  const [pickedItem, setPickedItem] = useState<PriceItem | null>(null);
  const [addQuantity, setAddQuantity] = useState('');

  const reload = useCallback(async (): Promise<void> => {
    try {
      setData(await api.getEstimate(estimateId));
    } catch (e) {
      setError(e instanceof ApiError ? e : null);
    }
  }, [estimateId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!adding) return;
    const timer = setTimeout(() => {
      void api
        .priceItems(search)
        .then((r) => setFound(r.items))
        .catch(() => setFound([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [search, adding]);

  const bySection = useMemo(() => {
    if (!data) return [];
    const groups = new Map<string, typeof data.lines>();
    for (const line of data.lines) {
      const list = groups.get(line.section);
      if (list) list.push(line);
      else groups.set(line.section, [line]);
    }
    return [...groups.entries()];
  }, [data]);

  if (error && !data) {
    return (
      <section className="panel">
        <ErrorBanner error={error} onDismiss={() => setError(null)} />
        <button type="button" className="link" onClick={onBack}>
          К истории проектов
        </button>
      </section>
    );
  }

  if (!data) {
    return (
      <div className="app-loading">
        <div className="spinner" aria-hidden="true" />
        <p>Загружаем смету…</p>
      </div>
    );
  }

  const { estimate, lines, notes, files } = data;

  const saveQuantity = async (lineId: string): Promise<void> => {
    const quantity = Number(editValue.replace(',', '.'));
    if (!Number.isFinite(quantity) || quantity <= 0) return;
    try {
      await api.editLine(estimate.id, lineId, quantity);
      setEditing(null);
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e : null);
    }
  };

  const addLine = async (): Promise<void> => {
    if (!pickedItem) return;
    const quantity = Number(addQuantity.replace(',', '.'));
    if (!Number.isFinite(quantity) || quantity <= 0) return;
    try {
      await api.addLine(estimate.id, pickedItem.code, quantity);
      setAdding(false);
      setPickedItem(null);
      setAddQuantity('');
      setSearch('');
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e : null);
    }
  };

  const removeLine = async (lineId: string): Promise<void> => {
    try {
      await api.removeLine(estimate.id, lineId);
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e : null);
    }
  };

  return (
    <section className="estimate">
      <div className="estimate__header">
        <div>
          <h1 className="estimate__title">
            {estimate.isPreliminary ? 'Предварительная смета' : 'Смета на ремонтные работы'}
          </h1>
          <p className="estimate__object">{estimate.projectName}</p>
        </div>
        <div className="estimate__actions no-print">
          <a className="button" href={`/api/estimates/${estimate.id}/export.xlsx`} download>
            Скачать .xlsx
          </a>
          <button type="button" className="button" onClick={() => window.print()}>
            Печать / PDF
          </button>
          <button type="button" className="link" onClick={onBack}>
            К истории
          </button>
        </div>
      </div>

      {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}

      {estimate.isPreliminary && (
        <div className="banner banner--warning">
          <div className="banner__content">
            <strong className="banner__title">Это предварительный расчёт, а не договорная смета</strong>
            <p className="banner__hint">
              Часть объёмов не подтверждена документацией. Проверьте уточнения и пропуски ниже.
            </p>
          </div>
        </div>
      )}

      <dl className="estimate__meta">
        <div>
          <dt>Тип документации</dt>
          <dd>{estimate.documentTypeLabel}</dd>
        </div>
        <div>
          <dt>Прайс-лист</dt>
          <dd>{estimate.priceListLabel}</dd>
        </div>
        <div>
          <dt>Площадь</dt>
          <dd>{estimate.areaM2 !== null ? `${formatQuantity(estimate.areaM2)} м²` : 'не указана'}</dd>
        </div>
        <div>
          <dt>Редакция</dt>
          <dd>№ {estimate.revision}</dd>
        </div>
        {files.length > 0 && (
          <div className="estimate__meta-wide">
            <dt>Обработанные файлы</dt>
            <dd>
              {files
                .map((f) => (f.pageCount ? `${f.filename} (${f.pageCount} стр.)` : f.filename))
                .join(', ')}
            </dd>
          </div>
        )}
      </dl>

      <div className="totals">
        <div className="totals__main">
          <span className="totals__label">Итого работ</span>
          <span className="totals__value">{formatMoney(estimate.totalKopecks)}</span>
        </div>
        {estimate.pricePerM2Kopecks !== null && (
          <div className="totals__derived">
            <span className="totals__label">Цена за м² (производный показатель)</span>
            <span className="totals__value-small">{formatMoney(estimate.pricePerM2Kopecks)}</span>
          </div>
        )}
        <p className="totals__disclaimer">
          Материалы, а также стоимость дверей, сантехнических приборов, светильников, кухни, мебели и техники
          в расчёт не входят.
        </p>
      </div>

      {bySection.map(([section, sectionLines]) => {
        const sectionTotal = sectionLines.reduce((sum, l) => sum + l.amountKopecks, 0);
        return (
          <div key={section} className="section">
            <div className="section__head">
              <h2>{section}</h2>
              <span className="section__total">{formatMoney(sectionTotal)}</span>
            </div>

            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Наименование работы</th>
                    <th className="table__num">Объём</th>
                    <th>Ед.</th>
                    <th className="table__num">Цена</th>
                    <th className="table__num">Сумма</th>
                    <th>Достоверность</th>
                    <th>Источник</th>
                    <th className="no-print" />
                  </tr>
                </thead>
                <tbody>
                  {sectionLines.map((line) => (
                    <tr key={line.id} className={line.isManual ? 'is-manual' : ''}>
                      <td>
                        <span className="table__name">{line.name}</span>
                        <span className="table__code">{line.code}</span>
                        {line.note && <span className="table__note">{line.note}</span>}
                      </td>
                      <td className="table__num">
                        {editing === line.id ? (
                          <span className="inline-edit">
                            <input
                              type="text"
                              inputMode="decimal"
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value.replace(/[^\d.,]/g, ''))}
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') void saveQuantity(line.id);
                                if (e.key === 'Escape') setEditing(null);
                              }}
                            />
                            <button type="button" className="link" onClick={() => void saveQuantity(line.id)}>
                              ОК
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="quantity-button no-print"
                            onClick={() => {
                              setEditing(line.id);
                              setEditValue(String(line.quantity));
                            }}
                            title="Изменить объём вручную"
                          >
                            {formatQuantity(line.quantity)}
                          </button>
                        )}
                        <span className="print-only">{formatQuantity(line.quantity)}</span>
                      </td>
                      <td>{line.unit}</td>
                      <td className="table__num">{formatMoney(line.priceKopecks)}</td>
                      <td className="table__num table__amount">{formatMoney(line.amountKopecks)}</td>
                      <td>
                        <span className={`chip ${CONFIDENCE_CLASS[line.confidence] ?? ''}`}>
                          {line.confidenceLabel}
                        </span>
                        {line.isManual && <span className="chip chip--manual">Ручная правка</span>}
                      </td>
                      <td className="table__source">
                        {line.isManual
                          ? 'Правка сотрудника'
                          : [line.source.page ? `стр. ${line.source.page}` : null, line.source.ref]
                              .filter(Boolean)
                              .join(', ') || '—'}
                      </td>
                      <td className="no-print">
                        <button
                          type="button"
                          className="link link--danger"
                          onClick={() => void removeLine(line.id)}
                        >
                          Удалить
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      {lines.length === 0 && (
        <p className="empty">
          Ни одна работа не попала в расчёт. Проверьте раздел «Не включено в расчёт» ниже.
        </p>
      )}

      <div className="no-print add-line">
        {!adding ? (
          <button type="button" className="button" onClick={() => setAdding(true)}>
            Добавить работу из прайса
          </button>
        ) : (
          <div className="add-line__form">
            <h3>Добавление работы из прайс-листа</h3>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по наименованию или коду"
              autoFocus
            />
            {pickedItem ? (
              <div className="add-line__picked">
                <div>
                  <strong>{pickedItem.name}</strong>
                  <span className="table__code">
                    {pickedItem.code} · {pickedItem.unit} · {formatMoney(pickedItem.priceKopecks)}
                  </span>
                </div>
                <input
                  type="text"
                  inputMode="decimal"
                  value={addQuantity}
                  onChange={(e) => setAddQuantity(e.target.value.replace(/[^\d.,]/g, ''))}
                  placeholder={`Объём, ${pickedItem.unit}`}
                />
                <button type="button" className="button button--primary" onClick={() => void addLine()}>
                  Добавить
                </button>
                <button type="button" className="link" onClick={() => setPickedItem(null)}>
                  Выбрать другую
                </button>
              </div>
            ) : (
              <ul className="add-line__results">
                {found.map((item) => (
                  <li key={item.code}>
                    <button type="button" onClick={() => setPickedItem(item)}>
                      <span className="add-line__name">{item.name}</span>
                      <span className="add-line__meta">
                        {item.section} · {item.unit} · {formatMoney(item.priceKopecks)}
                      </span>
                    </button>
                  </li>
                ))}
                {found.length === 0 && <li className="empty">Ничего не найдено</li>}
              </ul>
            )}
            <button type="button" className="link" onClick={() => setAdding(false)}>
              Отмена
            </button>
          </div>
        )}
      </div>

      {NOTE_GROUPS.map((group) => {
        const groupNotes = notes.filter((n) => n.kind === group.kind);
        if (groupNotes.length === 0) return null;
        return (
          <div key={group.kind} className="notes">
            <h2 className="notes__title">
              {group.title}
              <span className="notes__count">{groupNotes.length}</span>
            </h2>
            <p className="notes__description">{group.description}</p>
            <ul className="notes__list">
              {groupNotes.map((note) => (
                <li key={note.id} className={`note note--${note.severity}`}>
                  <strong>{note.title}</strong>
                  {note.detail && <p>{note.detail}</p>}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
