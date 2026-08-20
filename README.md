# Camera Recordings

Self-hosted ONVIF camera recorder with a browser UI. Built for a TP-Link Tapo
C325WB but works with any ONVIF Profile S camera.

- **Multiple cameras** – added through the UI by IP + ONVIF port, with username
  and password. Stream URLs and profiles are discovered over ONVIF.
- **Live view** in the browser (fragmented MP4 over WebSocket → MediaSource), with
  **pause / play**, a **Go live** button to jump back to the live edge,
  **snapshot** and **manual start/stop recording**.
- **Automatic recording on ONVIF detection events** (motion, person, …). The
  camera's notification starts the recording; it stops a configurable number of
  seconds after the last event.
- **SQLite** stores every notification, recording and snapshot. Media files are
  written to the local data directory. Everything is deletable from the UI,
  individually or in bulk, plus optional age/size based retention.
- **Login** protects the UI, the API and the WebSocket streams. Camera passwords
  are encrypted at rest with a key derived from `APP_SECRET`.
- **Deployable as a Portainer stack** – one container, one volume.

Node.js 20+ backend (Express, ws, better-sqlite3, onvif), ffmpeg for the media
work, plain HTML/CSS/JS frontend with no build step.

---

## Deploy with Portainer

### Option A – stack from this git repository (recommended)

1. Portainer → **Stacks** → **Add stack** → **Repository**.
2. Repository URL: this repo. Compose path: `docker-compose.yml`.
3. Add the environment variables below.
4. **Deploy the stack.** The image is built from the `Dockerfile` on first
   deploy (a few minutes; it also installs ffmpeg).

### Option B – web editor

Paste `docker-compose.yml` into the web editor. If you build and push the image
yourself, replace `build: .` with your `image:` reference.

### Environment variables

| Variable         | Default            | Meaning                                                        |
| ---------------- | ------------------ | -------------------------------------------------------------- |
| `APP_SECRET`     | *(insecure)*       | **Set this.** Signs sessions and encrypts stored camera passwords |
| `ADMIN_USERNAME` | `admin`            | Created on first start only                                     |
| `ADMIN_PASSWORD` | `changeme`         | Created on first start only – change it after logging in        |
| `HTTP_PORT`      | `8080`             | Host port published by the stack                                |
| `TZ`             | `Europe/Bratislava`| Timezone for folder names and displayed times                   |
| `SESSION_HOURS`  | `72`               | Session cookie lifetime                                         |
| `PUBLIC_URL`     | auto-detected      | Address cameras POST events back to. **Required in Docker**, e.g. `http://192.168.1.10:8080` |
| `LOG_LEVEL`      | `info`             | `error` \| `warn` \| `info` \| `debug`                          |

Changing `APP_SECRET` later invalidates sessions and makes stored camera
passwords unreadable – re-enter them in the UI if you do.

### Storage

Everything lives in the `camera-data` volume mounted at `/data`:

```
/data/camera-recordings.sqlite     database (events, recordings, cameras, users)
/data/recordings/<cameraId>/<date>/<timestamp>_<camera>_<trigger>.mp4
/data/snapshots/<cameraId>/<date>/<timestamp>_<camera>.jpg
/data/thumbnails/<cameraId>/<date>/…jpg
```

To keep the files on a specific disk, replace the named volume with a bind mount
(there is a commented example at the bottom of `docker-compose.yml`).

Recordings are written as fragmented MP4, so a file stays playable even if the
container is killed mid-recording.

---

## Adding a Tapo C325WB

1. In the **Tapo app**: Device Settings → Advanced Settings → **Camera Account**,
   create a username and password. This account – *not* your TP-Link cloud
   login – is what ONVIF and RTSP use.
2. Make sure the camera has a static/reserved IP on your LAN.
3. In this app: **Cameras → Add camera**
   - Host: the camera's IP
   - ONVIF port: **2020** (Tapo default)
   - Username / password: the Camera Account credentials
   - Click **Test connection & load profiles** – you should see the model and
     two profiles (2K main stream, VGA sub stream)
   - Pick profiles or leave them on *Auto* (live view uses the low-resolution
     sub stream, recordings the high-resolution main stream)
   - Keep **Record automatically on ONVIF detection events** enabled
4. Detection has to be switched on in the Tapo app (Motion Detection / Person
   Detection), otherwise the camera never sends notifications.

The container needs network access to the camera on TCP **2020** (ONVIF) and
**554** (RTSP).

### Events on Tapo: push, not pull

Tapo firmware (verified on a **C325WB V2, firmware 1.3.2**) accepts a
`CreatePullPointSubscription` and then **resets the TCP connection on every
`PullMessages`** – that is the `socket hang up` you see with most ONVIF clients.
It is not an authentication or addressing problem: a `GetSystemDateAndTime` sent
to the very same subscription URL answers `HTTP 200`, while `PullMessages` is
reset on any path, with or without WS-Addressing headers.

What does work is the push mechanism (WS-BaseNotification): the camera POSTs
notifications to a URL we hand it. The *Event delivery* setting on each camera
controls this:

| Mode | Behaviour |
| --- | --- |
| `auto` (default) | Try the pull point; if it fails before any event arrives, switch to push |
| `pull` | Pull point only |
| `push` | Push only – skip straight to a subscription |
| `off` | Do not subscribe to events at all |

In push mode the camera opens a connection **back to this server**, so it must
be able to reach it:

- On a flat LAN nothing is needed – the callback URL is derived from the local
  address your traffic to that camera comes from.
- **Behind Docker or NAT you must set `PUBLIC_URL`** (e.g.
  `http://192.168.4.102:8080`) to an address the camera can reach, because a
  bridged container's own IP is not routable from the camera.

Use **Test events** on the Cameras page to check the whole path: it asks the
camera to re-send its current detection state and reports whether anything
arrived. Repeated notifications (cameras replay them after a re-subscription)
are de-duplicated so they never record the same motion twice.

---

## Using it

**Live** – pick a camera from the left rail.

| Control       | Behaviour                                                                     |
| ------------- | ----------------------------------------------------------------------------- |
| Pause / Play  | Freezes on the current frame and discards incoming video while paused          |
| Go live       | Rebuilds the buffer at the live edge (also reconnects a dropped stream)        |
| Snapshot      | Saves the displayed frame; falls back to a fresh grab from the camera if the player has no frame yet |
| Record        | Starts/stops a manual recording of the main stream                             |
| Image         | Picture adjustments – see below                                                |
| − / + / Reset | Zoom. The wheel (or a pinch) zooms around the cursor, dragging moves a zoomed picture, double click resets |
| Sub / Main    | Which of the camera's two streams to watch                                     |
| ⛶             | Fullscreen                                                                     |

Every control, filter and form field carries a tooltip explaining what it does
and what is expected – hover if something is unclear.

**Sub stream vs main stream.** ONVIF cameras publish the same scene as several
"profiles". The Tapo publishes two: a full resolution **main** stream (2560×1440)
and a small **sub** stream (VGA). Recordings always use main, so nothing is lost.
The live view defaults to sub because it is far lighter on the network and on the
camera's limited number of simultaneous connections – useful when watching over a
slow or remote link. Switch to main when you want full detail on screen. It only
changes what your browser receives, never what is recorded.

A manual recording started while an event recording is running takes over, so it
will not stop on the event timer.

### Picture adjustments

The **Image** button offers two independent sets of controls:

- **This preview only** – brightness, contrast, saturation and a real gamma
  curve, applied by your browser to the picture on screen. Nothing is sent to
  the camera, recordings keep the original image, and the values are remembered
  per camera in that browser. Gamma is the useful one for a dark scene: it lifts
  the shadows without blowing out the bright areas.
- **Camera settings** – the ONVIF imaging values stored in the camera itself
  (the C325WB exposes brightness, saturation, contrast and sharpness, 0–100).
  These change what the sensor produces, so they affect recordings and every
  viewer, and they persist across reboots. Cameras that expose no imaging
  service simply show a note instead.

**Recordings** – filter by camera, trigger, status and time; play in place,
download, delete one or many.

**Events** – every ONVIF notification with its topic, state and the recording it
triggered.

**Settings** – storage stats, retention (delete recordings older than N days
and/or keep the total under N GB, 0 disables), and the password change form.

---

## Local development

Requires Node.js 20+ and ffmpeg. The binary is looked up in `FFMPEG_PATH`, then
next to the app, then in `./bin`, then on `PATH` – dropping `ffmpeg.exe` (and
`ffprobe.exe`, which ships in the same archive) into the project folder is
enough on Windows. The resolved path and version are logged at startup, and a
missing binary is reported in the UI instead of failing silently later.

```bash
npm install
cp .env.example .env          # set DATA_DIR=./data for local runs
npm start                     # http://localhost:8080
npm test                      # mp4 splitting, ONVIF parsing, recorder lifecycle
```

`npm test` needs neither a camera nor ffmpeg – the recorder tests run against a
stubbed ffmpeg process.

Windows PowerShell:

```powershell
$env:DATA_DIR = "$PWD\data"; $env:APP_SECRET = "dev-secret"; npm start
```

---

## How it works

```
ONVIF PullPoint  ──►  cameraManager  ──►  events table
   (notifications)          │
                            └─► recorder ──► ffmpeg -c copy ──► /data/recordings/*.mp4
                                                                    │
browser  ◄── WebSocket /ws/live ◄── streamHub ◄── ffmpeg (fMP4) ◄────┘ (separate RTSP pull)
browser  ◄── WebSocket /ws/updates ◄── bus (events, recording state, camera status)
```

- One ffmpeg process per camera+quality for live view, shared by all viewers and
  shut down ten seconds after the last one leaves.
- Recording uses `-c:v copy`, so there is no transcoding cost and the original
  camera quality is preserved. Audio is re-encoded to AAC only when the camera
  provides an audio track and the option is enabled.
- Streams are watchdogged: no data for 20 s and the process is restarted with
  backoff. Interrupted recordings are finalised on the next start.

### API

All endpoints require the session cookie.

```
POST   /api/auth/login | logout | password        GET /api/auth/me
GET    /api/cameras                               POST   /api/cameras
GET    /api/cameras/:id                           PUT    /api/cameras/:id
DELETE /api/cameras/:id                           POST   /api/cameras/probe
POST   /api/cameras/:id/refresh
GET    /api/cameras/:id/snapshot                  POST   /api/cameras/:id/snapshot
POST   /api/cameras/:id/recording/start | stop
POST   /api/cameras/:id/events/test               POST   /onvif/notify/:id/:token  (cameras only)
GET    /api/cameras/:id/imaging                   PUT    /api/cameras/:id/imaging
GET    /api/recordings                            GET    /api/recordings/:id
GET    /api/recordings/:id/stream | download | thumbnail
DELETE /api/recordings/:id                        POST   /api/recordings/delete
GET    /api/events | /api/events/types            DELETE /api/events/:id
POST   /api/events/delete
GET    /api/snapshots                             POST   /api/snapshots?camera_id=
GET    /api/snapshots/:id/file                    DELETE /api/snapshots/:id
GET    /api/system/stats | settings               PUT    /api/system/settings
WS     /ws/live?camera_id=&quality=sub|main       WS     /ws/updates
```

---

## Troubleshooting

**"Authentication failed"** – use the Tapo *Camera Account*, not the TP-Link
account. Recreate it in the app if unsure.

**"Connection refused" / "unreachable"** – wrong ONVIF port (Tapo uses 2020, most
other cameras 80 or 8000), or the container cannot reach the camera's subnet.

**No events arrive** – detection must be enabled in the camera, and in push mode
the camera has to be able to reach this server (see *Events on Tapo* above). Hit
**Test events** on the Cameras page for a verdict; if it reports nothing
received, the callback URL it shows is not reachable from the camera – set
`PUBLIC_URL`. Set `LOG_LEVEL=debug` to log every notification.

**`socket hang up` in the log** – expected once per camera on Tapo firmware: the
pull point is unusable and the app falls back to push automatically (`switching
to push notifications`). Set *Event delivery* to `push` to skip the attempt.

**Live view stays black** – the browser can only play H.264 through MediaSource.
If the profile is H.265, switch the camera (or the selected profile) to H.264.
The player reports the codec it could not handle.

**Recordings are 0 bytes / failed** – usually the camera refusing a second RTSP
connection. Watch the sub stream instead of the main stream while recording, or
lower the number of simultaneous viewers.
