import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './migrations.js';

export type Db = Database.Database;

/**
 * Открывает БД и приводит её в рабочее состояние.
 *
 * WAL обязателен: сервер и воркер — разные процессы, они пишут в один файл.
 * Без WAL воркер блокировал бы чтение статуса из API.
 */
export function openDatabase(databasePath: string): Db {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  const db = new Database(databasePath);

  db.pragma('journal_mode = WAL');
  // NORMAL безопасен при WAL и заметно быстрее FULL.
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  // Ждать освобождения блокировки вместо мгновенной ошибки SQLITE_BUSY.
  db.pragma('busy_timeout = 10000');

  migrate(db);
  return db;
}

export function migrate(db: Db): { applied: number[] } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);

  const known = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((r) => (r as { version: number }).version),
  );

  const applied: number[] = [];
  const record = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');

  for (const migration of MIGRATIONS) {
    if (known.has(migration.version)) continue;

    // Каждая миграция целиком в транзакции: либо применилась, либо нет.
    const run = db.transaction(() => {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, Date.now());
    });
    run();
    applied.push(migration.version);
  }

  return { applied };
}

/** БД в памяти с применёнными миграциями — для тестов. */
export function openTestDatabase(): Db {
  return openDatabase(':memory:');
}
