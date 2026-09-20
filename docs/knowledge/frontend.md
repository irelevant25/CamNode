# Frontend

Plain HTML/CSS/JS in `public/`, served statically. **No build step, no modules,
no dependencies.** `index.html` loads six classic scripts in this order; each is
a `'use strict'` IIFE that exports through `window`:

| File | Exports | Role |
| --- | --- | --- |
| `api.js` | `window.api` | `get/post/put/del/postBlob`, `wsUrl`. JSON in and out; non-2xx throws `Error(payload.error)`; **401 redirects to `/login.html?next=…`**. |
| `player.js` | `window.LivePlayer` | `/ws/live` → MediaSource. |
| `zoom.js` | `window.ZoomPan` | CSS-transform zoom/pan (wheel, pinch, drag, double click), 1×–8×. |
| `ui.js` | `window.ui` | `escapeHtml`, formatters, `parseDate`, `localInputToIso`, `toast`, `openModal`, `confirmModal`. |
| `recording-player.js` | `window.openRecordingPlayer` | Modal `<video>` with wall-clock readout, scrub bar, waveform canvas, clip marks. |
| `app.js` | – | The shell: one `state` object, the `player`/`zoom` singletons, one `setup*` + `load*` pair per view. |

`login.html` is standalone with an inline script.

## Conventions

- **Rendering is template strings into `innerHTML`, and every value goes through
  `esc()`** – including values that "should" be numbers when they originate from
  a camera (profile width/height once did not, and ONVIF is plain HTTP on the
  LAN: a rogue device controls those strings). Numeric database ids are the only
  thing interpolated raw. Toasts use `textContent`.
- **Events are delegated** from container elements via
  `event.target.closest('[data-…]')` – `data-camera`, `data-action`+`data-id`,
  `data-play`, `data-delete`, `data-day`, … Rows are re-rendered wholesale, so
  never attach listeners to rows.
- **Views** are `<section class="view" id="view-NAME">`; `showView(name)` toggles
  `.active`, sets `location.hash` and calls the view's loader. Valid names are
  the `VIEWS` list – the `hashchange` handler checks it too.
- **Loaders take a ticket**: `const stale = beginLoad('name')` before the
  request, `if (stale()) return;` after it. Responses arrive out of order, and
  `/ws/updates` can trigger several reloads at once (a bulk delete publishes one
  `recording:deleted` per file).
- **List views** paginate server-side (`limit`/`offset`, response
  `{rows…, total}`). After each load call `steppedBack()` (empty page after a
  delete) and `keepVisibleSelection()` (a selection only ever holds rows that
  are on screen, so *Delete selected* cannot reach rows behind a changed filter).
- **Dates**: the API speaks ISO UTC. `ui.parseDate` also accepts SQLite's
  `YYYY-MM-DD HH:MM:SS` (as UTC) because `created_at`/`last_seen_at` use it.
  `datetime-local` inputs go through `ui.localInputToIso`. Display is always
  `dd.MM.yyyy HH:mm:ss` local.
- Per-camera preview filters, `showInfo` and `volume` live in `localStorage`
  (`preview:<cameraId>`).

## Live player (`player.js`)

- Text frames: `{type:'status', state, message}`; states `connecting`, `live`,
  `reconnecting`, `error`, `closed` from the server plus `idle`, `paused`,
  `disconnected` locally. `onPlayerStatus` in `app.js` maps them to the overlay.
- Binary frames are whole fMP4 chunks. A chunk starting with `ftyp` is an init
  segment: the codec string is sniffed from `avcC`/`hvcC`/`mp4a` and the
  MediaSource is rebuilt – **unless paused**, where the frozen frame is kept and
  `resume()` rebuilds from the cached segment.
- Queue capped at 60 → 30 chunks. After each append: jump to the live edge when
  > 6 s behind, play at 1.12× when > 1.6 s behind, trim to 30 s behind
  `currentTime` (5 s on `QuotaExceededError`).
- A `<video>` error or a failed append ends a MediaSource permanently while the
  socket stays healthy, so `recoverMedia()` rebuilds from the init segment.
- When the server refuses a stream it sends `state:'error'` and then closes;
  `onclose` leaves that message on screen and keeps retrying in the background.

## `/ws/updates`

JSON `{type, payload, at}`: `hello` (active recordings), `event:created`,
`recording:state|started|stopped|deleted`, `snapshot:created|deleted`,
`camera:status`. Handlers patch `state`, re-render rail/cards/controls, and
reload a list only when it is the visible view. Reconnect backoff 2 s × n, max 15 s.
