import { config } from '../shared/config.js';
import { openDatabase, migrate } from './index.js';

/** Применяет миграции: `npm run migrate`. */

const cfg = config();
const db = openDatabase(cfg.databasePath);
const { applied } = migrate(db);

if (applied.length === 0) {
  process.stdout.write(`Миграции уже применены. База: ${cfg.databasePath}\n`);
} else {
  process.stdout.write(`Применены миграции: ${applied.join(', ')}. База: ${cfg.databasePath}\n`);
}

db.close();
