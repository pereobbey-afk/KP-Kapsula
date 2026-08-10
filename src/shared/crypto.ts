import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

/** Криптостойкий токен для сессий и восстановления задач. */
export function newToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** Сравнение без утечки времени — для токенов и хешей. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Хеш пароля: scrypt из стандартной библиотеки, без внешних зависимостей. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const saltHex = parts[1];
  const expectedHex = parts[2];
  if (!saltHex || !expectedHex) return false;

  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  const derived = await scrypt(password, salt, expected.length);
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}
