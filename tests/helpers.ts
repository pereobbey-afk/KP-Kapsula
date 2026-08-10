import type { Db } from '../src/db/index.js';
import { openTestDatabase } from '../src/db/index.js';
import { newId } from '../src/shared/crypto.js';

export function makeDb(): Db {
  return openTestDatabase();
}

export function seedUser(db: Db, email = 'smetchik@kapsula.test'): string {
  const id = newId('usr');
  db.prepare(
    `INSERT INTO users (id, email, password_hash, role, created_at) VALUES (?, ?, ?, 'user', ?)`,
  ).run(id, email, 'scrypt$00$00', Date.now());
  return id;
}

export function seedProject(
  db: Db,
  userId: string,
  overrides: { name?: string; areaMilli?: number; rooms?: number; initialState?: string } = {},
): string {
  const id = newId('prj');
  const now = Date.now();
  db.prepare(
    `INSERT INTO projects (id, user_id, name, area_milli, rooms, initial_state, scope_level, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    overrides.name ?? 'Тестовый объект',
    overrides.areaMilli ?? 50_000,
    overrides.rooms ?? 2,
    overrides.initialState ?? 'concrete',
    'Полный ремонт',
    now,
    now,
  );
  return id;
}

/** Активная версия прайса с заданными позициями. */
export function seedPriceList(
  db: Db,
  items: Array<{
    code: string;
    name: string;
    unit: string;
    priceKopecks: number;
    section?: string;
    sectionNo?: number;
  }>,
  label = 'Тестовый прайс 05.08.2026',
): { versionId: string; itemIds: Record<string, string> } {
  const versionId = newId('plv');
  const now = Date.now();

  db.prepare(
    `INSERT INTO price_list_versions
       (id, label, source_note, effective_date, is_active, items_count, sections_count, created_at)
     VALUES (?, ?, 'тестовые данные', '2026-08-05', 1, ?, ?, ?)`,
  ).run(versionId, label, items.length, new Set(items.map((i) => i.section ?? 'Общие')).size, now);

  const itemIds: Record<string, string> = {};
  const insert = db.prepare(
    `INSERT INTO price_items
       (id, version_id, code, section_no, section, name, unit, price_kopecks, source_edition, match_key, search_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '05.08.2026', ?, ?)`,
  );

  for (const item of items) {
    const id = newId('pit');
    itemIds[item.code] = id;
    insert.run(
      id,
      versionId,
      item.code,
      item.sectionNo ?? 1,
      item.section ?? 'Общие',
      item.name,
      item.unit,
      item.priceKopecks,
      `${item.name}|${item.unit}`.toLowerCase(),
      item.name.toLowerCase(),
    );
  }

  return { versionId, itemIds };
}
