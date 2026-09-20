---
name: run-local
description: Start camera-recordings locally and check that a change works in the real app – boot the server on a scratch data directory, log in, call the API, open the UI. Use when asked to run, start, smoke-test or "see it working", or after a change that npm test cannot cover (routes, auth, file serving, WebSockets, frontend).
---

# Run the app locally

The app needs no camera to start; without ffmpeg it starts too and shows a
banner. Use a **scratch data directory** so the user's real `./data` (their
database and recordings) is never touched by a test run.

## Start

PowerShell (the primary shell here):

```powershell
$env:DATA_DIR = "$env:TEMP\camnode-dev"; $env:APP_SECRET = "dev-secret-0123456789"
$env:ADMIN_PASSWORD = "dev-password"; $env:PORT = "18080"; $env:LOG_LEVEL = "debug"
npm start
```

Bash: `DATA_DIR=/tmp/camnode-dev APP_SECRET=dev-secret-0123456789 ADMIN_PASSWORD=dev-password PORT=18080 LOG_LEVEL=debug npm start`

Run it in the background and wait for `camera-recordings listening on`. Use a
port other than 8080 – the user may have the real instance running. `ADMIN_*`
only applies when the database is created, so a reused scratch directory keeps
its old password; delete the directory for a clean start.

To run against the user's real data instead (`DATA_DIR=./data`), ask first.

## Drive it

```bash
curl -s -c jar -X POST localhost:18080/api/auth/login -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"dev-password"}'
curl -s -b jar localhost:18080/api/auth/me          # user, warnings, build
curl -s -b jar localhost:18080/api/system/stats     # ffmpeg status, counts, streams
curl -s -b jar localhost:18080/api/cameras
```

Ten failed logins per address in five minutes returns 429 – restart the server
to clear it (the counter is in memory).

Without a camera you can still exercise most of the app by inserting rows
through `src/db/repo.js` from a small Node script that sets the same `DATA_DIR`
(see how `test/timeline.test.js` seeds events and recordings), and by POSTing a
notification to `/onvif/notify/<id>/<token>` (see the `onvif-event-debugger`
agent). Recording, live view and snapshots need a real RTSP source; any RTSP
URL works if you set `record_stream_url` on the camera row, e.g. a local
`mediamtx` fed by `ffmpeg -re -f lavfi -i testsrc …`.

For frontend changes open `http://localhost:18080` in a browser; static files
are served with `Cache-Control: max-age=5m` for JS/CSS, so hard-reload.

## Finish

Stop the server (it handles SIGINT: closes streams, finalises recordings).
Report what you actually exercised and what you could not (usually: anything
that needs a camera).
