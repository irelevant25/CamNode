# camera-recordings (CamNode)

Self-hosted ONVIF camera recorder: Node.js 20+ (Express, ws, better-sqlite3,
onvif), ffmpeg child processes, plain HTML/CSS/JS frontend. One process, one
SQLite file, one Docker volume. Built around a TP-Link Tapo C325WB.

## Commands

```bash
npm start              # http://localhost:8080
npm run dev            # node --watch
npm test               # five plain-assert scripts; no camera, no ffmpeg needed
node test/recorder.test.js                          # a single suite
npm run reset-password -- <new-password> [username]
```

Local run on Windows (PowerShell): `$env:DATA_DIR="$PWD\data"; $env:APP_SECRET="dev-secret"; npm start`
– default login is `admin` / `admin`. `ffmpeg.exe`/`ffprobe.exe` are picked up
from the project folder or `./bin` (gitignored).

There is no linter, formatter, bundler or TypeScript. CI
(`.github/workflows/publish-image.yml`) runs `npm test`, then publishes
`ghcr.io/irelevant25/camnode` on every push to `master`.

## Knowledge base – read before changing the matching area

`docs/knowledge/`: [architecture](docs/knowledge/architecture.md) ·
[onvif-events](docs/knowledge/onvif-events.md) ·
[media-pipeline](docs/knowledge/media-pipeline.md) ·
[data-model](docs/knowledge/data-model.md) ·
[frontend](docs/knowledge/frontend.md) ·
[known-issues](docs/knowledge/known-issues.md)

Update the relevant file in the same change when you invalidate something in it.

## Rules that are easy to break

- **Timestamps are ISO UTC strings compared as text.** Never compare them with
  SQLite's `datetime('now')` (space instead of `T` – sorts wrong, and JS parses
  it as local time). Use `SQL_NOW_ISO` in `src/db/repo.js`.
- **"A day" is a local day** (`timeline.dayRange`, `date(x, 'localtime')`).
- **SQL lives in `src/db/repo.js`**, parameterised. New columns need both the
  `SCHEMA` entry and an `ADDITIONS` entry in `migrate()`.
- **Secrets stay server-side.** `repo.cameras.get()` is safe to return;
  `getWithSecret()` (password, notify token) and `withCredentials()` URLs are
  not. Log URLs through `maskUrl`.
- **Spawn ffmpeg only via `spawnFfmpeg`, stop it via `stopFfmpeg`.** One
  recording session per camera; `recorder.start()` on a running session reuses it.
- **Every timer in `CameraRuntime` is cleared in `stopPushRenew()` /
  `teardownConnection()`** and its callback re-checks `this.stopped` / `this.cam`.
- **`async` route without its own try/catch ⇒ wrap in `asyncHandler`.** Express 4.
- **Stream files with `stream.pipeline`, never `.pipe(res)`** (leaks the fd when
  the browser aborts, which a seeking video does constantly).
- **Stored `rel_path`s reach the disk only through `storage.*Path()`**
  (`resolveWithin` is the traversal guard).
- **Frontend: every interpolated value goes through `esc()`**, camera-derived
  "numbers" included. Loaders use `beginLoad()` tickets. No build step – a new
  script is a new `<script>` tag in `index.html`, in dependency order.
- The `/onvif/notify` endpoint answers 200 before doing any work. Keep it so.

## Style

CommonJS, `'use strict'`, 2 spaces, single quotes, semicolons, ~120 columns.
`createLogger('scope')` instead of `console`. Comments explain *why* – usually
the camera or browser behaviour that forced the code – and en dashes ( – ) are
the house style in prose. Commit subjects are full sentences in the imperative
("Account for every pushed notification, and stop trusting Renew").

## Tests

Each `test/*.test.js` sets `DATA_DIR` (temp dir), `APP_SECRET`, `LOG_LEVEL` and
`TZ` **before** requiring anything from `src/`, asserts with `node:assert`, and
prints `OK  <what holds>` per check. A new suite must be added to the `test`
script in `package.json`. Fixed bugs get a case in `test/regressions.test.js`.
The recorder suite runs against a stubbed ffmpeg – copy that pattern rather than
requiring the binary.

## Agents and skills (`.claude/`)

- Agents: `camnode-reviewer` (review a change against the rules above),
  `onvif-event-debugger` (events not arriving / not recording),
  `media-pipeline-debugger` (live view, recordings, ffmpeg).
- Skills: `/run-local`, `/add-db-column`, `/add-api-endpoint`,
  `/diagnose-events`, `/release`.
