import { useEffect, useState } from 'react';
import { api, ApiError, formatMoney, formatQuantity, type ProjectSummary } from '../api.js';
import { ErrorBanner } from '../components/ErrorBanner.js';
import type { JSX } from 'react';

type Props = {
  onOpenEstimate: (estimateId: string) => void;
  onNew: () => void;
};

const STATE_LABELS: Record<string, string> = {
  concrete: 'Бетон',
  white_box: 'White Box',
  secondary: 'Вторичка',
};

export function HistoryView({ onOpenEstimate, onNew }: Props): JSX.Element {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    void api
      .projects()
      .then((r) => setProjects(r.projects))
      .catch((e: unknown) => setError(e instanceof ApiError ? e : null));
  }, []);

  if (error) {
    return (
      <section className="panel">
        <ErrorBanner error={error} onDismiss={() => setError(null)} />
      </section>
    );
  }

  if (!projects) {
    return (
      <div className="app-loading">
        <div className="spinner" aria-hidden="true" />
        <p>Загружаем историю…</p>
      </div>
    );
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <h1>История проектов</h1>
        <button type="button" className="button button--primary" onClick={onNew}>
          Новый расчёт
        </button>
      </div>

      {projects.length === 0 ? (
        <p className="empty">Расчётов пока нет. Загрузите документацию, чтобы получить первую смету.</p>
      ) : (
        <ul className="project-list">
          {projects.map((project) => (
            <li key={project.id} className="project-card">
              <div className="project-card__main">
                <h2 className="project-card__name">{project.name}</h2>
                <p className="project-card__meta">
                  {[
                    project.areaM2 !== null ? `${formatQuantity(project.areaM2)} м²` : null,
                    project.rooms !== null ? `${project.rooms} комн.` : null,
                    project.initialState ? STATE_LABELS[project.initialState] : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                <p className="project-card__date">
                  Обновлён {new Date(project.updatedAt).toLocaleString('ru-RU')}
                </p>
              </div>

              <div className="project-card__side">
                {project.latestEstimate ? (
                  <>
                    <span className="project-card__total">
                      {formatMoney(project.latestEstimate.totalKopecks)}
                    </span>
                    <span className="project-card__revision">
                      Редакция № {project.latestEstimate.revision}
                      {project.latestEstimate.isPreliminary && ' · предварительная'}
                    </span>
                    <button
                      type="button"
                      className="button button--small"
                      onClick={() => onOpenEstimate(project.latestEstimate!.id)}
                    >
                      Открыть смету
                    </button>
                  </>
                ) : (
                  <span className="project-card__empty">Смета не рассчитана</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
