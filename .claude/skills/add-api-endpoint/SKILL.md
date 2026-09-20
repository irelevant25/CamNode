---
name: add-api-endpoint
description: Add or change a REST endpoint in camera-recordings following the project's conventions – router placement, auth, error handling, response shapes, SQL in repo.js, bus messages, the frontend call and the README API table. Use when asked to add an endpoint, expose something over the API, or add a button/feature that needs a new server call.
---

# Add an API endpoint

## Where it goes

One router per resource in `src/routes/`, mounted in `src/server.js` behind
`auth.requireAuth`. A new router is mounted the same way, **before** the
`express.static` and the `/api` 404 catch-all. Only `/api/health`,
`/api/auth/login` and `/onvif/notify` are reachable without a session – do not
add to that list.

Declare fixed paths before parameterised ones in the same router
(`POST /delete` before `DELETE /:id`), or `"delete"` is read as an id.

## Shape of a handler

```js
router.get('/:id/thing', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const camera = repo.cameras.get(id);
  if (!camera) return res.status(404).json({ error: 'Camera not found' });
  res.json({ thing: await service.thing(camera) });
}));
```

- **Errors are `{ error: "human sentence" }`** – the frontend toasts
  `payload.error` verbatim. 400 bad input, 404 missing, 409 wrong state
  ("recording in progress"), 502 when the *camera* failed, 500 only by accident.
- An `async` handler either has its own try/catch (when it maps failures to a
  specific status, like the 502s in `cameras.js`) or is wrapped in
  `asyncHandler` from `src/middleware/asyncHandler.js`. Never neither.
- **Validate and coerce at the edge**: `Number(req.params.id)`,
  `Math.min(parseInt(limit) || 50, 500)`, whitelists for enums. Values that end
  up in ffmpeg arguments must be numbers you computed, never request strings.
- **Lists** return `{ <plural>: rows, total, limit, offset }`.
- **SQL goes in `src/db/repo.js`**, parameterised. Routes call `repo.*`.
- **Never return** `getWithSecret()` objects, `withCredentials()` URLs,
  `notify_token` or `password_enc`. `repo.cameras.get()` is the safe shape;
  `decorate()` in `cameras.js` adds runtime info.
- **Files** are sent with `sendFile` from `routes/media.js` (Range support,
  `stream.pipeline`) after resolving the stored `rel_path` with
  `storage.*Path()`, which returns `null` on traversal.
- **Deleting media** goes through `services/library.js` so file, derived files,
  row and bus message stay in step.
- **State the UI should see without reloading** is published with
  `publish('<noun>:<verb>', payload)` from `services/bus.js`, and handled in the
  `switch` in `connectUpdates()` in `public/js/app.js`.

## Frontend side

Call it through `window.api` (`api.get/post/put/del`) – it sets JSON headers,
throws `Error(payload.error)` and redirects to the login page on 401. Wrap user
actions in try/catch and `ui.toast(err.message, 'error')`. Loaders use a
`beginLoad()` ticket. See `docs/knowledge/frontend.md`.

## Finish

1. A test when there is logic worth one: repo/service level like
   `test/timeline.test.js`; routes can be exercised by starting
   `createServer()` on a scratch `DATA_DIR` and using `fetch`.
2. `npm test`, then `/run-local` and call the endpoint with `curl -b jar`.
3. Add the endpoint to the API block in `README.md`.
