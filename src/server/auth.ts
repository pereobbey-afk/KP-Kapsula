import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/index.js';
import { AppError } from '../shared/errors.js';
import { hashPassword, newId, newToken, sha256, verifyPassword } from '../shared/crypto.js';

/**
 * Сессии интерфейса.
 *
 * Сессия намеренно короткая и НЕ участвует в жизненном цикле расчёта:
 * задача живёт в БД и продолжает выполняться, даже когда сессия истекла.
 * Это прямое следствие первопричины исходного дефекта.
 */

export const SESSION_COOKIE = 'smetchik_session';

export type UserRow = {
  id: string;
  email: string;
  password_hash: string;
  role: 'user' | 'admin';
  created_at: number;
};

export type SessionUser = { id: string; email: string; role: 'user' | 'admin' };

export async function createUser(
  db: Db,
  input: { email: string; password: string; role?: 'user' | 'admin' },
): Promise<SessionUser> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new AppError('VALIDATION_FAILED', { field: 'email' });
  }
  if (input.password.length < 10) {
    throw new AppError('VALIDATION_FAILED', { field: 'password', reason: 'минимум 10 символов' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(email);
  if (existing) throw new AppError('VALIDATION_FAILED', { field: 'email', reason: 'уже зарегистрирован' });

  const id = newId('usr');
  db.prepare(
    'INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, email, await hashPassword(input.password), input.role ?? 'user', Date.now());

  return { id, email, role: input.role ?? 'user' };
}

export async function authenticate(
  db: Db,
  email: string,
  password: string,
): Promise<SessionUser | null> {
  const user = db
    .prepare('SELECT * FROM users WHERE lower(email) = ?')
    .get(email.trim().toLowerCase()) as UserRow | undefined;

  // Пароль проверяется даже при отсутствии пользователя, чтобы время
  // ответа не выдавало, существует ли учётная запись.
  const hash = user?.password_hash ?? 'scrypt$00$00';
  const ok = await verifyPassword(password, hash);

  if (!user || !ok) return null;
  return { id: user.id, email: user.email, role: user.role };
}

/** Создаёт сессию. В БД хранится только хеш токена. */
export function createSession(db: Db, userId: string, ttlMs: number): string {
  const token = newToken();
  const now = Date.now();
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    sha256(token),
    userId,
    now,
    now + ttlMs,
  );
  return token;
}

export function destroySession(db: Db, token: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(token));
}

export function resolveSession(db: Db, token: string | undefined): SessionUser | null {
  if (!token) return null;

  const row = db
    .prepare(
      `SELECT s.expires_at, u.id, u.email, u.role
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`,
    )
    .get(sha256(token)) as
    | { expires_at: number; id: string; email: string; role: 'user' | 'admin' }
    | undefined;

  if (!row) return null;
  if (row.expires_at <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(token));
    return null;
  }
  return { id: row.id, email: row.email, role: row.role };
}

export function purgeExpiredSessions(db: Db): number {
  return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now()).changes;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

/** Требует вход. Истёкшая сессия отличается от отсутствующей. */
export function requireUser(request: FastifyRequest): SessionUser {
  if (!request.user) throw new AppError('AUTH_REQUIRED');
  return request.user;
}

export function requireAdmin(request: FastifyRequest): SessionUser {
  const user = requireUser(request);
  if (user.role !== 'admin') throw new AppError('FORBIDDEN');
  return user;
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  opts: { ttlMs: number; secure: boolean },
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: opts.secure,
    path: '/',
    maxAge: Math.floor(opts.ttlMs / 1000),
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}
