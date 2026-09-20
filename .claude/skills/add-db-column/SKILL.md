---
name: add-db-column
description: Add a column (or a per-camera setting) to the SQLite schema of camera-recordings so that both new and existing databases get it, and wire it through repo, route and UI. Use when asked to add a field, a camera option, a setting stored per camera/recording/event, or anything that says "store X".
---

# Add a database column

There is no migration framework: fresh databases are built from the `SCHEMA`
string, existing ones are patched by `migrate()` with `ALTER TABLE … ADD COLUMN`.
**Both must be updated**, or the app works on your machine and breaks on the
user's NAS (or the other way round).

Read `docs/knowledge/data-model.md` first – especially the timestamp rule if the
column holds a time.

## Steps

1. **`src/db/index.js` → `SCHEMA`**: add the column to its `CREATE TABLE`.
2. **`src/db/index.js` → `migrate()` → `ADDITIONS`**: add
   `['name', "TYPE NOT NULL DEFAULT …"]` under the table. SQLite can only add a
   column that is nullable or has a constant default. An index on it goes after
   the loop in `migrate()`, not in `SCHEMA` (see `idx_snapshots_event`).
3. **`src/db/repo.js`**
   - cameras: add to `CAMERA_FIELDS`; normalise and validate in
     `normaliseCameraInput` (`boolInt` for flags, `clamp` for ranges, whitelist
     for enums – follow `event_mode`); convert flags to booleans in `mapCamera`.
     Anything secret is deleted from the object in `mapCamera` and only returned
     by `getWithSecret()`.
   - other tables: add to the `INSERT` in `create()` and to whatever query needs it.
4. **Route** (`src/routes/*.js`): cameras need nothing – the body is passed to
   `repo.cameras.create/update`. If changing the value must restart something,
   note that `PUT /api/cameras/:id` already calls `cameraManager.reload(id)`;
   if it invalidates the discovered RTSP URLs, add it to `connectionChanged`.
5. **Use it** in the service that needs it. Camera rows are re-read from the
   database at the points that matter (`handleEvent`, `start`), so a new field is
   picked up without extra plumbing; a recorder session keeps the copy it
   started with.
6. **UI** (`public/js/app.js`): the camera form is built in the camera modal
   (search for `event_record_seconds` to find every place a field appears: the
   form HTML, reading the form back, and the card). Every control carries a
   `title` tooltip explaining it – keep that. Escape with `esc()`.
7. **Global settings** instead of a column: add the key to `DEFAULT_SETTINGS`,
   and to `NUMERIC_SETTINGS` in `src/routes/system.js` if it is a number.
8. **Test both paths**:
   ```bash
   npm test                       # fresh database
   ```
   and for the migration, start once on a copy of an *old* database (or create
   one by checking out the previous commit, running `npm start` briefly with a
   scratch `DATA_DIR`, then switching back) and look for
   `migrated: added <table>.<column>` in the log.
9. Update the table list in `docs/knowledge/data-model.md`, and the README if
   the option is user-visible.
