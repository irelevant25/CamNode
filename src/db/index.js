'use strict';

const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { config, ensureDirs } = require('../config');
const { createLogger } = require('../logger');

const log = createLogger('db');

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT
);

CREATE TABLE IF NOT EXISTS cameras (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT NOT NULL,
  host                 TEXT NOT NULL,
  onvif_port           INTEGER NOT NULL DEFAULT 2020,
  username             TEXT,
  password_enc         TEXT,
  enabled              INTEGER NOT NULL DEFAULT 1,
  rtsp_transport       TEXT NOT NULL DEFAULT 'tcp',
  live_profile_token   TEXT,
  record_profile_token TEXT,
  live_stream_url      TEXT,
  record_stream_url    TEXT,
  snapshot_url         TEXT,
  profiles_json        TEXT,
  record_on_event      INTEGER NOT NULL DEFAULT 1,
  snapshot_on_event    INTEGER NOT NULL DEFAULT 0,
  event_mode           TEXT NOT NULL DEFAULT 'auto',
  notify_token         TEXT,
  event_record_seconds INTEGER NOT NULL DEFAULT 30,
  max_record_seconds   INTEGER NOT NULL DEFAULT 900,
  record_audio         INTEGER NOT NULL DEFAULT 1,
  status               TEXT NOT NULL DEFAULT 'unknown',
  status_message       TEXT,
  last_seen_at         TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  camera_id    INTEGER NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  topic        TEXT,
  type         TEXT,
  label        TEXT,
  state        INTEGER,
  source       TEXT,
  raw          TEXT,
  recording_id INTEGER,
  received_at  TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_camera_time ON events(camera_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(received_at DESC);

CREATE TABLE IF NOT EXISTS recordings (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  camera_id        INTEGER NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  filename         TEXT NOT NULL,
  rel_path         TEXT NOT NULL,
  trigger_type     TEXT NOT NULL DEFAULT 'manual',
  status           TEXT NOT NULL DEFAULT 'recording',
  started_at       TEXT NOT NULL,
  ended_at         TEXT,
  duration_seconds REAL,
  size_bytes       INTEGER,
  thumbnail_path   TEXT,
  event_id         INTEGER,
  error            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_recordings_camera_time ON recordings(camera_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_recordings_time ON recordings(started_at DESC);

CREATE TABLE IF NOT EXISTS snapshots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  camera_id  INTEGER NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,
  rel_path   TEXT NOT NULL,
  size_bytes INTEGER,
  source     TEXT NOT NULL DEFAULT 'manual',
  event_id   INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_snapshots_camera_time ON snapshots(camera_id, created_at DESC);
-- idx_snapshots_event is created in migrate(), after the column exists on
-- databases that predate it.

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

const DEFAULT_SETTINGS = {
  retention_days: '0', // 0 = keep forever
  retention_max_gb: '0', // 0 = unlimited
  event_retention_days: '0',
  // Empty = use PUBLIC_URL, or auto-detect per camera.
  public_url: '',
};

function init() {
  ensureDirs();
  db = new Database(config.dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);

  const insertSetting = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING'
  );
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    insertSetting.run(key, DEFAULT_SETTINGS[key]);
  }

  migrate();
  bootstrapAdmin();
  recoverInterruptedRecordings();
  log.info(`database ready at ${config.dbFile}`);
  return db;
}

/**
 * Add columns introduced after a database was first created. SQLite only
 * supports ADD COLUMN, which is all we need so far.
 */
function migrate() {
  const ADDITIONS = {
    cameras: [
      ['event_mode', "TEXT NOT NULL DEFAULT 'auto'"],
      ['notify_token', 'TEXT'],
      ['snapshot_on_event', 'INTEGER NOT NULL DEFAULT 0'],
    ],
    snapshots: [['event_id', 'INTEGER']],
  };
  for (const table of Object.keys(ADDITIONS)) {
    const existing = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((column) => column.name);
    for (const [name, definition] of ADDITIONS[table]) {
      if (existing.indexOf(name) !== -1) continue;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      log.info(`migrated: added ${table}.${name}`);
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_snapshots_event ON snapshots(event_id)');
}

function bootstrapAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return;
  const hash = bcrypt.hashSync(config.admin.password, 10);
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(
    config.admin.username,
    hash
  );
  if (config.admin.isDefaultPassword) {
    setSetting('default_admin_password', '1');
    log.warn(
      `created initial user "${config.admin.username}" with the default password "${config.admin.password}" ` +
        '– ADMIN_PASSWORD was not set. Sign in and change it under Settings.'
    );
  } else {
    log.warn(
      `created initial user "${config.admin.username}" with the password from ADMIN_PASSWORD ` +
        '– change it after the first login'
    );
  }
}

/**
 * A container restart while recording leaves rows stuck in "recording" state.
 * The mp4 files are fragmented so they are still playable; mark them completed
 * (best effort) so they are not shown as active forever.
 */
function recoverInterruptedRecordings() {
  const stuck = db.prepare("SELECT id FROM recordings WHERE status = 'recording'").all();
  if (!stuck.length) return;
  db.prepare(
    `UPDATE recordings
       SET status = 'interrupted',
           ended_at = COALESCE(ended_at, datetime('now')),
           error = COALESCE(error, 'process stopped unexpectedly')
     WHERE status = 'recording'`
  ).run();
  log.warn(`marked ${stuck.length} interrupted recording(s) after restart`);
}

function getDb() {
  if (!db) throw new Error('database not initialised');
  return db;
}

function getSetting(key, fallback) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function allSettings() {
  const rows = getDb().prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

module.exports = { init, getDb, getSetting, setSetting, allSettings };
