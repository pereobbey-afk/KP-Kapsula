/**
 * Миграции. Применяются по порядку, каждая — один раз, в транзакции.
 * Номер миграции фиксируется в таблице schema_migrations.
 *
 * Все временные метки — INTEGER, миллисекунды Unix.
 * Все деньги — INTEGER, копейки. Все объёмы — INTEGER, тысячные доли.
 */

export type Migration = {
  version: number;
  name: string;
  sql: string;
};

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
--------------------------------------------------------------------
-- Пользователи и сессии
--------------------------------------------------------------------
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_users_email ON users(lower(email));

-- Сессия интерфейса намеренно короткая. Задача расчёта её переживает,
-- поэтому срок сессии нигде не влияет на жизненный цикл job.
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,          -- sha256 от токена, сам токен не хранится
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

--------------------------------------------------------------------
-- Прайс-лист: версии и позиции
--------------------------------------------------------------------
CREATE TABLE price_list_versions (
  id             TEXT PRIMARY KEY,
  label          TEXT NOT NULL,
  source_note    TEXT,
  effective_date TEXT,
  is_active      INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0,1)),
  items_count    INTEGER NOT NULL DEFAULT 0,
  sections_count INTEGER NOT NULL DEFAULT 0,
  import_report  TEXT,
  created_at     INTEGER NOT NULL,
  created_by     TEXT
);
-- Активная версия ровно одна.
CREATE UNIQUE INDEX idx_price_versions_single_active
  ON price_list_versions(is_active) WHERE is_active = 1;

CREATE TABLE price_items (
  id             TEXT PRIMARY KEY,
  version_id     TEXT NOT NULL REFERENCES price_list_versions(id) ON DELETE CASCADE,
  code           TEXT NOT NULL,
  section_no     INTEGER,
  section        TEXT NOT NULL,
  name           TEXT NOT NULL,
  unit           TEXT NOT NULL,
  price_kopecks  INTEGER NOT NULL CHECK (price_kopecks >= 0),
  source_edition TEXT,
  source_row     TEXT,
  match_key      TEXT NOT NULL,          -- нормализованный ключ для дедупликации
  search_text    TEXT NOT NULL,          -- нормализованный текст для сопоставления
  UNIQUE (version_id, code)
);
CREATE INDEX idx_price_items_version ON price_items(version_id);
CREATE INDEX idx_price_items_section ON price_items(version_id, section_no);
CREATE INDEX idx_price_items_match ON price_items(version_id, match_key);

--------------------------------------------------------------------
-- Проекты
--------------------------------------------------------------------
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  name          TEXT NOT NULL,
  area_milli    INTEGER,
  rooms         INTEGER,
  initial_state TEXT CHECK (initial_state IN ('concrete','white_box','secondary')),
  scope_level   TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  archived_at   INTEGER
);
CREATE INDEX idx_projects_user ON projects(user_id, created_at DESC);

--------------------------------------------------------------------
-- Поэтапная загрузка файлов
--------------------------------------------------------------------
CREATE TABLE uploads (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  filename          TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  mime              TEXT NOT NULL,
  declared_size     INTEGER NOT NULL,
  received_size     INTEGER NOT NULL DEFAULT 0,
  chunk_size        INTEGER NOT NULL,
  total_chunks      INTEGER NOT NULL,
  storage_path      TEXT NOT NULL,
  sha256            TEXT,
  status            TEXT NOT NULL CHECK (status IN ('pending','complete','failed','expired')),
  error_code        TEXT,
  created_at        INTEGER NOT NULL,
  completed_at      INTEGER,
  expires_at        INTEGER NOT NULL
);
CREATE INDEX idx_uploads_user ON uploads(user_id, created_at DESC);
CREATE INDEX idx_uploads_expires ON uploads(expires_at);

CREATE TABLE upload_chunks (
  upload_id   TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (upload_id, chunk_index)
) WITHOUT ROWID;

--------------------------------------------------------------------
-- Задачи расчёта (durable-очередь)
--------------------------------------------------------------------
CREATE TABLE jobs (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL REFERENCES users(id),
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idempotency_key       TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN (
                          'queued','uploading','classifying','extracting',
                          'validating','calculating','completed','failed'
                        )),
  stage_message         TEXT,
  progress              INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  attempts              INTEGER NOT NULL DEFAULT 0,
  max_attempts          INTEGER NOT NULL,
  -- Аренда: воркер держит задачу до lease_until. Умер — задача вернётся в очередь.
  lease_until           INTEGER,
  worker_id             TEXT,
  -- Токен восстановления: доступ к задаче не зависит от cookie-сессии.
  recovery_token_hash   TEXT NOT NULL,
  error_code            TEXT,
  error_message         TEXT,
  price_list_version_id TEXT REFERENCES price_list_versions(id),
  estimate_id           TEXT,
  deadline_at           INTEGER NOT NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  started_at            INTEGER,
  finished_at           INTEGER
);
-- Повторное нажатие кнопки с тем же ключом не создаёт вторую смету.
CREATE UNIQUE INDEX idx_jobs_idempotency ON jobs(user_id, idempotency_key);
-- Индекс под запрос захвата задачи воркером.
CREATE INDEX idx_jobs_claim ON jobs(status, lease_until);
CREATE INDEX idx_jobs_user ON jobs(user_id, created_at DESC);
CREATE INDEX idx_jobs_project ON jobs(project_id, created_at DESC);

CREATE TABLE job_files (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  upload_id    TEXT NOT NULL REFERENCES uploads(id),
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  page_count   INTEGER,
  position     INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_job_files_job ON job_files(job_id, position);

-- Журнал этапов: длительность каждого этапа для наблюдаемости.
CREATE TABLE job_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  message     TEXT,
  duration_ms INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_job_events_job ON job_events(job_id, id);

--------------------------------------------------------------------
-- Результат распознавания
--------------------------------------------------------------------
CREATE TABLE extractions (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('full_project','partial_project','layout_only')),
  completeness  TEXT NOT NULL,
  model         TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_extractions_job ON extractions(job_id);

--------------------------------------------------------------------
-- Сметы
--------------------------------------------------------------------
CREATE TABLE estimates (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_id                TEXT REFERENCES jobs(id),
  user_id               TEXT NOT NULL REFERENCES users(id),
  price_list_version_id TEXT NOT NULL REFERENCES price_list_versions(id),
  price_list_label      TEXT NOT NULL,
  document_type         TEXT NOT NULL,
  completeness          TEXT NOT NULL,
  is_preliminary        INTEGER NOT NULL DEFAULT 0 CHECK (is_preliminary IN (0,1)),
  area_milli            INTEGER,
  total_kopecks         INTEGER NOT NULL,
  price_per_m2_kopecks  INTEGER,
  revision              INTEGER NOT NULL DEFAULT 1,
  created_at            INTEGER NOT NULL
);
CREATE INDEX idx_estimates_project ON estimates(project_id, revision DESC);
CREATE INDEX idx_estimates_user ON estimates(user_id, created_at DESC);

CREATE TABLE estimate_lines (
  id             TEXT PRIMARY KEY,
  estimate_id    TEXT NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  price_item_id  TEXT NOT NULL REFERENCES price_items(id),
  code           TEXT NOT NULL,
  section_no     INTEGER,
  section        TEXT NOT NULL,
  name           TEXT NOT NULL,
  unit           TEXT NOT NULL,
  quantity_milli INTEGER NOT NULL CHECK (quantity_milli >= 0),
  price_kopecks  INTEGER NOT NULL CHECK (price_kopecks >= 0),
  amount_kopecks INTEGER NOT NULL CHECK (amount_kopecks >= 0),
  -- confirmed  — подтверждён документом
  -- derived    — рассчитан из подтверждённой геометрии
  -- assumption — предварительное допущение
  confidence     TEXT NOT NULL CHECK (confidence IN ('confirmed','derived','assumption')),
  is_manual      INTEGER NOT NULL DEFAULT 0 CHECK (is_manual IN (0,1)),
  source_file_id TEXT,
  source_page    INTEGER,
  source_ref     TEXT,
  note           TEXT
);
CREATE INDEX idx_lines_estimate ON estimate_lines(estimate_id, position);

-- Допущения, уточнения, потенциальные пропуски и «данных нет — не включено».
CREATE TABLE estimate_notes (
  id          TEXT PRIMARY KEY,
  estimate_id TEXT NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('assumption','clarification','omission','excluded')),
  severity    TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  title       TEXT NOT NULL,
  detail      TEXT,
  position    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_notes_estimate ON estimate_notes(estimate_id, position);

CREATE TABLE project_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  estimate_id  TEXT,
  user_id      TEXT,
  action       TEXT NOT NULL,
  payload_json TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_history_project ON project_history(project_id, id DESC);
`,
  },
];
