import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Job, type User } from './api.js';
import { LoginView } from './views/Login.js';
import { NewCalculationView } from './views/NewCalculation.js';
import { ProgressView } from './views/Progress.js';
import { EstimateView } from './views/Estimate.js';
import { HistoryView } from './views/History.js';
import { ErrorBanner } from './components/ErrorBanner.js';
import type { JSX } from 'react';

type Screen =
  | { name: 'new' }
  | { name: 'progress'; jobId: string }
  | { name: 'estimate'; estimateId: string }
  | { name: 'history' };

export function App(): JSX.Element {
  const [user, setUser] = useState<User | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [loading, setLoading] = useState(true);
  const [screen, setScreen] = useState<Screen>({ name: 'new' });
  const [error, setError] = useState<ApiError | null>(null);

  /**
   * Восстановление после перезагрузки.
   * Незавершённая задача находится на сервере, а не в состоянии вкладки,
   * поэтому обновление страницы её не теряет.
   */
  const restore = useCallback(async () => {
    try {
      const { jobs } = await api.activeJobs();
      const active = jobs[0];
      if (active) {
        setScreen({ name: 'progress', jobId: active.jobId });
        return;
      }
      // Незавершённых нет — возможно, расчёт закончился, пока вкладка была закрыта.
      const lastJobId = localStorage.getItem('smetchik:lastJobId');
      if (lastJobId) {
        const job = await api.getJob(lastJobId).catch(() => null);
        if (job?.status === 'completed' && job.estimateId) {
          setScreen({ name: 'estimate', estimateId: job.estimateId });
          localStorage.removeItem('smetchik:lastJobId');
        }
      }
    } catch {
      // Ошибка восстановления не должна блокировать вход в приложение.
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const state = await api.setupState();
        setNeedsSetup(state.needsSetup);
        if (!state.needsSetup) {
          const me = await api.me();
          setUser(me.user);
          await restore();
        }
      } catch (e) {
        if (e instanceof ApiError && e.status !== 401) setError(e);
      } finally {
        setLoading(false);
      }
    })();
  }, [restore]);

  const handleAuthenticated = useCallback(
    async (authenticated: User) => {
      setUser(authenticated);
      setNeedsSetup(false);
      await restore();
    },
    [restore],
  );

  const handleJobStarted = useCallback((job: Job) => {
    localStorage.setItem('smetchik:lastJobId', job.jobId);
    if (job.recoveryToken) {
      localStorage.setItem(`smetchik:recovery:${job.jobId}`, job.recoveryToken);
    }
    setScreen({ name: 'progress', jobId: job.jobId });
  }, []);

  const handleJobFinished = useCallback((estimateId: string) => {
    localStorage.removeItem('smetchik:lastJobId');
    setScreen({ name: 'estimate', estimateId });
  }, []);

  const logout = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setUser(null);
    setScreen({ name: 'new' });
  }, []);

  if (loading) {
    return (
      <div className="app-loading">
        <div className="spinner" aria-hidden="true" />
        <p>Загрузка…</p>
      </div>
    );
  }

  if (!user) {
    return <LoginView needsSetup={needsSetup} onAuthenticated={handleAuthenticated} />;
  }

  return (
    <div className="app">
      <header className="app-header no-print">
        <div className="app-header__brand">
          <span className="app-header__logo">КАПСУЛА</span>
          <span className="app-header__title">ИИ Сметчик</span>
        </div>
        <nav className="app-nav">
          <button
            type="button"
            className={screen.name === 'new' ? 'is-active' : ''}
            onClick={() => setScreen({ name: 'new' })}
          >
            Новый расчёт
          </button>
          <button
            type="button"
            className={screen.name === 'history' ? 'is-active' : ''}
            onClick={() => setScreen({ name: 'history' })}
          >
            История проектов
          </button>
        </nav>
        <div className="app-header__user">
          <span>{user.email}</span>
          <button type="button" className="link" onClick={() => void logout()}>
            Выйти
          </button>
        </div>
      </header>

      <main className="app-main">
        {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}

        {screen.name === 'new' && <NewCalculationView onStarted={handleJobStarted} />}

        {screen.name === 'progress' && (
          <ProgressView
            jobId={screen.jobId}
            onCompleted={handleJobFinished}
            onCancelled={() => setScreen({ name: 'new' })}
          />
        )}

        {screen.name === 'estimate' && (
          <EstimateView estimateId={screen.estimateId} onBack={() => setScreen({ name: 'history' })} />
        )}

        {screen.name === 'history' && (
          <HistoryView
            onOpenEstimate={(id) => setScreen({ name: 'estimate', estimateId: id })}
            onNew={() => setScreen({ name: 'new' })}
          />
        )}
      </main>
    </div>
  );
}
