import { useState } from 'react';
import { api, ApiError, type User } from '../api.js';
import { ErrorBanner } from '../components/ErrorBanner.js';
import type { JSX } from 'react';

type Props = {
  needsSetup: boolean;
  onAuthenticated: (user: User) => void | Promise<void>;
};

export function LoginView({ needsSetup, onAuthenticated }: Props): JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = needsSetup ? await api.register(email, password) : await api.login(email, password);
      await onAuthenticated(result.user);
    } catch (e) {
      setError(e instanceof ApiError ? e : null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <form className="auth__card" onSubmit={(e) => void submit(e)}>
        <div className="auth__brand">КАПСУЛА</div>
        <h1 className="auth__title">ИИ Сметчик</h1>
        <p className="auth__subtitle">
          {needsSetup
            ? 'Первый запуск. Создайте учётную запись администратора.'
            : 'Внутренний инструмент расчёта стоимости ремонтных работ.'}
        </p>

        {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}

        <label className="field">
          <span className="field__label">Электронная почта</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </label>

        <label className="field">
          <span className="field__label">Пароль</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={needsSetup ? 'new-password' : 'current-password'}
            minLength={needsSetup ? 10 : 1}
            required
          />
          {needsSetup && <span className="field__hint">Не короче 10 символов.</span>}
        </label>

        <button type="submit" className="button button--primary" disabled={busy}>
          {busy ? 'Проверяем…' : needsSetup ? 'Создать администратора' : 'Войти'}
        </button>
      </form>
    </div>
  );
}
