import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../shared/errors.js';
import {
  authenticate,
  clearSessionCookie,
  createSession,
  createUser,
  destroySession,
  purgeExpiredSessions,
  requireAdmin,
  requireUser,
  setSessionCookie,
  SESSION_COOKIE,
} from '../auth.js';

const credentialsSchema = z.object({
  email: z.string().min(3).max(200),
  password: z.string().min(1).max(200),
});

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const { db, config } = app.ctx;
  const secureCookie = config.isProduction;

  /**
   * Регистрация.
   * Первый пользователь становится администратором — иначе систему
   * невозможно было бы развернуть. Дальше создавать учётные записи
   * может только администратор.
   */
  app.post(
    '/api/auth/register',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = credentialsSchema.safeParse(request.body);
      if (!body.success) throw new AppError('VALIDATION_FAILED');

      const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
      const isFirstUser = userCount.c === 0;

      if (!isFirstUser) requireAdmin(request);

      const user = await createUser(db, {
        email: body.data.email,
        password: body.data.password,
        role: isFirstUser ? 'admin' : 'user',
      });

      // Первый пользователь сразу входит в систему.
      if (isFirstUser) {
        const token = createSession(db, user.id, config.sessionTtlMs);
        setSessionCookie(reply, token, { ttlMs: config.sessionTtlMs, secure: secureCookie });
      }

      return { user };
    },
  );

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = credentialsSchema.safeParse(request.body);
      if (!body.success) throw new AppError('VALIDATION_FAILED');

      const user = await authenticate(db, body.data.email, body.data.password);
      // Единый ответ и для неверного пароля, и для несуществующего логина.
      if (!user) throw new AppError('AUTH_REQUIRED');

      purgeExpiredSessions(db);
      const token = createSession(db, user.id, config.sessionTtlMs);
      setSessionCookie(reply, token, { ttlMs: config.sessionTtlMs, secure: secureCookie });

      return { user };
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) destroySession(db, token);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (request) => {
    const user = requireUser(request);
    return { user };
  });

  /** Есть ли вообще пользователи — нужно интерфейсу для первого запуска. */
  app.get('/api/auth/setup-state', async () => {
    const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
    return { needsSetup: userCount.c === 0 };
  });
}
