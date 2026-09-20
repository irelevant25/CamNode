# Data model

SQLite via `better-sqlite3` (synchronous – no `await` on queries), WAL mode,
foreign keys on. Schema is the `SCHEMA` string in `src/db/index.js`.

## Tables

| Table | Notes |
| --- | --- |
| `users` | bcrypt hash. Created once from `ADMIN_USERNAME`/`ADMIN_PASSWORD`; those variables do nothing afterwards. |
| `cameras` | `password_enc` (AES-GCM, `enc:v1:` prefix), `notify_token` (random, path secret of the push endpoint), cached `*_stream_url` without credentials, `profiles_json`, `status`/`status_message`/`last_seen_at`. |
| `events` | One row per stored notification. `state` is `1`/`0`/`NULL`. `raw` is JSON. `recording_id` is a soft link (no FK). |
| `recordings` | `status`: `recording` → `completed` \| `failed` \| `interrupted`. `rel_path` is relative to `/data/recordings`; the thumbnail and waveform paths are derived from it by swapping the extension. |
| `snapshots` | `source`: `manual` \| `live` (frame sent by the browser) \| `event`. |
| `settings` | key/value strings: `retention_days`, `retention_max_gb`, `event_retention_days`, `public_url`, `default_admin_password`. |

`events`, `recordings` and `snapshots` cascade when a camera is deleted; the
files are removed separately by `library.purgeCamera`.

## Timestamps – the rule

**Application timestamps are ISO-8601 UTC strings written by JavaScript**
(`new Date().toISOString()` → `2026-08-20T18:42:07.000Z`) and are compared *as
text* in SQL. SQLite's own `datetime('now')` produces `2026-08-20 18:42:07`: a
space sorts below `T`, so mixing the two breaks every comparison that lands on
the same date, and JavaScript parses the space form as *local* time.

- Comparing against "now" in SQL: `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
  (`SQL_NOW_ISO` in `repo.js`), never `datetime('now')`.
- `datetime('now')` is fine only for the bookkeeping columns that are never
  compared or shown as instants (`created_at`, `updated_at`, `last_seen_at`).
- "A day" always means a **local** day: `timeline.dayRange` builds local
  midnight boundaries and converts to ISO; SQL grouping uses
  `date(received_at, 'localtime')`, which depends on `TZ` (the image installs
  `tzdata`).

## Adding a column

1. Add it to the `CREATE TABLE` in `SCHEMA` (fresh databases).
2. Add it to `ADDITIONS` in `migrate()` (existing databases). Only
   `ADD COLUMN` is supported, so it needs a default or must be nullable.
   Indexes on migrated columns go in `migrate()`, after the loop.
3. Cameras only: add it to `CAMERA_FIELDS`, normalise it in
   `normaliseCameraInput`, convert in `mapCamera` if it is a boolean.
4. Surface it in the route and in the form in `public/js/app.js`.

## Queries

All in `src/db/repo.js`, always parameterised; the only interpolation is fixed
column lists and optional `AND camera_id = ?` clauses. List endpoints return
`{ rows, total }` and clamp `limit` in the route.
