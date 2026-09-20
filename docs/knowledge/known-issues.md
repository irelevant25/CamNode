# Known issues

Found during the September 2026 audit and **not fixed** – either low impact or a
behaviour change that deserves a decision. Remove an entry when it is dealt with.
The README's *Loose ends* table covers deployment-level items.

## Backend

| Where | Issue | Notes |
| --- | --- | --- |
| `repo.cameras.setStreamInfo` | "Auto" profile selection does not survive discovery: the token ONVIF picked is written back with `COALESCE`, so the form shows an explicit profile afterwards. | Harmless while the camera's profiles do not change (`pickToken` falls back), but "Auto" is not really a stored choice. |
| `services/timeline.js` `buildDay` | Hours are 24 fixed buckets from local midnight. On a 25-hour DST day the last hour's events are dropped from the per-hour chart; on a 23-hour day the last bucket is empty. | The recordings/events lists for the day are correct – only `hours[]`. |
| `services/waveform.js` `get` | Two requests for the same uncached recording decode it twice. | Add an in-flight map if it ever matters. |
| `services/snapshots.js` `capture` | `uniqueName` checks the disk when the name is chosen, but ffmpeg writes the file later – two captures started in the same second can still share a name. | Event snapshots have a 15 s cooldown; needs two manual clicks within a second. |
| `services/recorder.js` `rotate` | A few seconds are lost between the old and the new file. | Would need overlapping ffmpeg processes and a second RTSP connection. |
| `services/recorder.js` restart | A restarted event recording gets a full `event_record_seconds` window instead of the remainder. | |
| `middleware/auth.js` | The session cookie has no `Secure` flag, and `/ws/*` accepts `?token=` in the URL. | Accepted: the app is HTTP on a LAN. Set `Secure` when `TRUST_PROXY` is on if it is ever put behind TLS. |
| `routes/auth.js` | The `attempts` map is only pruned per address on its next request. | Bounded by real client addresses now that `X-Forwarded-For` is not trusted by default. |
| `src/index.js` | `uncaughtException` is logged and the process carries on. | Deliberate (a recorder should keep recording), but state may be inconsistent afterwards. |

## Frontend

| Where | Issue |
| --- | --- |
| `app.js` `/ws/updates` | After a reconnect only `active_recordings` is restored; camera status and the open list are not refreshed. A 401 on the upgrade (session ended elsewhere) loops forever instead of reaching the login page – probe `/api/auth/me` after repeated failures. |
| `player.js` `pump` | If `trim(true)` can remove nothing, a `QuotaExceededError` repeats on every message. Fall back to `recoverMedia()`. |
| `player.js` `resume` | Sets status `live` even when the socket is down. |
| `app.js` `showView` | The live stream (and the server's ffmpeg) keeps running while other views are open; no `visibilitychange` handling. |
| `app.js` test-events toast | Reports the push counter, so a pull-point camera reads "0 notification(s) via pull" on success. |
| `app.js` timeline selector | `loadCameras()` forces the active camera back in when the user had chosen "All cameras". |
| `app.js` timeline axis | Hard-coded 24 equal cells in the viewer's timezone; off on DST days and when the browser's timezone differs from the server's `TZ`. |
| `app.js` camera cards | A `camera:status` message re-renders the cards mid-request, re-enabling a disabled "Testing…" button. |
| `app.js` settings | The default-password banner stays until reload after a successful password change. |
| `recording-player.js` | Download / Export clip navigate the tab; a 404 (recording deleted meanwhile) replaces the app with a JSON error. |
| list filters | `datetime-local` has minute precision and the server compares `<=`, so "to 10:30" excludes 10:30:15. |
