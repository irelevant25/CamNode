# Architecture

One Node.js process, one SQLite file, ffmpeg child processes. No build step, no
framework on the frontend, CommonJS throughout, Node >= 20.

## Module map

| Path | Role |
| --- | --- |
| `src/index.js` | Entry point. Start order: `db.init()` → `ffmpeg.checkTools()` → `cameraManager.init()` → `retention.start()` → HTTP listen. Shutdown order: close server → retention → live streams → camera runtimes → `recorder.stopAll()` (15 s hard limit). |
| `src/config.js` | The only place that reads `process.env`. Loads `.env` when present, real environment wins. Also computes `isDefaultSecret` and `buildInfo`. |
| `src/server.js` | Express app + the two WebSocket servers (`/ws/live`, `/ws/updates`). Upgrades are authenticated by hand in `auth.authenticateUpgrade`. |
| `src/db/index.js` | Schema, `migrate()`, first-run admin, `recoverInterruptedRecordings()`, settings helpers. |
| `src/db/repo.js` | **All SQL lives here** (plus a few counts in `routes/system.js` and one delete in `retention.js`). Grouped as `users`, `cameras`, `events`, `recordings`, `snapshots`. |
| `src/db/crypto.js` | AES-256-GCM for camera passwords, key = sha256(`APP_SECRET`). Decrypt failure returns `''`, never throws. |
| `src/middleware/auth.js` | JWT in an httpOnly cookie (`cr_session`). The token carries a stamp of the password hash, so a password change ends every other session. |
| `src/middleware/asyncHandler.js` | Wrap every `async` route that has no try/catch of its own – Express 4 ignores rejected promises. |
| `src/services/cameraManager.js` | One `CameraRuntime` per enabled camera: ONVIF connection, event subscription (pull/push), health check, reconnect backoff. Owns the decision to start an event recording. See [onvif-events.md](onvif-events.md). |
| `src/services/onvifClient.js` | Thin promise layer over the `onvif` package, raw SOAP where the package is wrong, notification parsing, topic → type rules. |
| `src/services/recorder.js` | One recording session per camera. See [media-pipeline.md](media-pipeline.md). |
| `src/services/streamHub.js` | One ffmpeg per camera+quality for live view, fanned out to all viewers. |
| `src/services/mp4.js` | Splits ffmpeg's fMP4 byte stream into `init` and `fragment` chunks. |
| `src/services/ffmpeg.js` | Binary lookup, `spawnFfmpeg`, `stopFfmpeg` (writes `q`, then SIGKILL), `probe`, `maskUrl`. |
| `src/services/storage.js` | Paths and file names. `resolveWithin` is the traversal guard – every stored `rel_path` goes through it before touching disk. |
| `src/services/library.js` | Deleting recordings/snapshots: files, derived files, row, bus message – in that order. |
| `src/services/retention.js` | Every 30 min: by age, by total size, old events. |
| `src/services/timeline.js` / `waveform.js` / `snapshots.js` | Day layout, audio loudness buckets (cached as JSON), JPEG grabs. |
| `src/services/bus.js` | `publish(type, payload)` → every `/ws/updates` client. The UI's only push channel. |
| `src/routes/*.js` | One router per resource; everything under `/api` except `/api/auth/login` and `/api/health` needs the session. `/onvif/notify/:cameraId/:token` is the one unauthenticated write path (token compared with `timingSafeEqual`). |
| `public/` | Static frontend, see [frontend.md](frontend.md). |
| `test/*.test.js` | Plain `assert` scripts run in sequence by `npm test`; each sets `DATA_DIR` to a temp dir *before* requiring anything from `src/`. |

## Data flow

```
camera ──ONVIF notification──► cameraManager.handleEvent ──► events row ──► bus 'event:created'
                                     │  (dedupe, trigger rules)
                                     └─► recorder.start(trigger:'event') ─► ffmpeg -c:v copy ─► /data/recordings
browser ◄─ /ws/live ◄─ streamHub ◄─ Mp4Splitter ◄─ ffmpeg (separate RTSP pull)
browser ◄─ /ws/updates ◄─ bus
```

## Things that are deliberately the way they are

- **Credentials never sit in stored URLs.** `normaliseUri` strips them before
  persisting; `withCredentials` re-adds them on the way to ffmpeg; `maskUrl`
  hides them in logs. `repo.cameras.get()` never returns the password or the
  notify token – only `getWithSecret()` does, and its result must not reach a
  response.
- **The camera's self-reported address is ignored** (`preserveAddress: true`,
  hostname forced in `normaliseUri`): consumer cameras report internal addresses.
- **The notify endpoint always answers 200** with an empty SOAP envelope before
  doing any work; some firmware drops the subscription on anything else.
- **Recording and live view use separate RTSP connections.** Cameras have a
  small connection budget, which is why live defaults to the sub stream.
- **`trust proxy` is off unless `TRUST_PROXY=1`.** The login rate limit keys on
  `req.ip`; trusting `X-Forwarded-For` without a proxy lets a client choose it.
