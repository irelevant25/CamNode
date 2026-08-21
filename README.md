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

## Getting the image onto a NAS or server

A **git URL is not a docker repository URL**. Synology's Container Manager (and
any "pull image" screen) expects a registry reference such as
`ghcr.io/owner/name:tag`; it cannot build from source. Only Portainer's
*Stacks → Add stack → Repository* screen accepts a git URL, and even then it is
Portainer doing the build.

### A. Let GitHub build it (recommended for a NAS)

`.github/workflows/publish-image.yml` builds on every push to the default branch
and publishes to the GitHub Container Registry. After the first successful run:

1. GitHub → your profile → **Packages** → the package → **Package settings**
2. **Change visibility → Public** (otherwise the NAS needs to log in to
   `ghcr.io` with a personal access token that has `read:packages`)

The NAS can then pull it like any public image:

```
ghcr.io/irelevant25/camnode:latest
```

In Synology **Container Manager → Registry**, search or use *Add → From URL* with
that address, or skip the image screen entirely and create a **Project** with
`docker-compose.portainer.yml`, which already points at it.

### B. Build it on the host over SSH

No CI involved. Enable SSH on the NAS, then:

```bash
ssh user@192.168.4.104
git clone https://github.com/irelevant25/CamNode.git
cd CamNode
sudo docker build -t camera-recordings:latest .
```

Then use `docker-compose.portainer.yml` with `IMAGE=camera-recordings:latest`
and `pull_policy: never` uncommented.

### C. Build elsewhere and move the image as a file

```bash
docker save camera-recordings:latest | gzip > camnode.tar.gz
# copy it across, then on the host:
gunzip -c camnode.tar.gz | docker load
```

The first build takes a few minutes: it installs ffmpeg and, where there is no
prebuilt binary for the architecture, compiles better-sqlite3.

### D. Build on the host from your PC, over SSH

The Docker CLI works even when the daemon is elsewhere: point it at the host and
it ships the build context for you. Needs SSH key access, which Synology allows
for administrators once SSH is enabled.

```powershell
$env:DOCKER_HOST = "ssh://user@192.168.4.104"
docker build -t camera-recordings:latest .
docker images camera-recordings          # confirm it landed on the host
Remove-Item Env:\DOCKER_HOST
```

`.dockerignore` keeps `node_modules`, `data` and the `*.exe` files out of what
gets sent, so the context is about 0.4 MB rather than 600 MB.

## Deploy with Portainer

### Repository stack (recommended, now that the code is on GitHub)

Portainer clones the repo and builds the image itself, so nothing has to be
copied to the host by hand and updating is a single click.

1. Portainer → **Stacks** → **Add stack** → **Repository**.
2. Repository URL: your remote. For a private repo, tick authentication and use
   a personal access token.
3. Compose path: `docker-compose.yml` (the one with `build:`).
4. Add the environment variables below — `APP_SECRET`, `ADMIN_PASSWORD` and
   `PUBLIC_URL` are required; the stack refuses to deploy without the first two.
5. **Deploy the stack.** The first build takes a few minutes.

To update: push, then **Pull and redeploy** in Portainer. `/data` is a named
volume, so the database and recordings survive a rebuild.

### Ready-made image (Synology Container Manager, or Portainer's web editor)

Use **`docker-compose.portainer.yml`**. It has no `build:` section and pulls the
published image by default, which is what Synology's *Container Manager →
Project* needs. Point `IMAGE` at a locally built image instead if you built one
yourself, and uncomment `pull_policy: never` so Docker does not try to fetch it.

### Environment variables

| Variable         | Default            | Meaning                                                        |
| ---------------- | ------------------ | -------------------------------------------------------------- |
| `APP_SECRET`     | **required**       | Signs sessions and derives the key encrypting stored camera passwords. The stack refuses to deploy without it. |
| `ADMIN_USERNAME` | `admin`            | Created on first start only                                     |
| `ADMIN_PASSWORD` | **required**       | Created on first start only. Also refuses to deploy without it. |
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
/data/waveforms/<cameraId>/<date>/…json    cached sound intensity per recording
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
| Info          | Overlay with what the stream is really delivering: codec, resolution, measured frame rate and bitrate, buffer and dropped frames |
| 🔊 + slider   | Live sound. Starts muted because browsers block audio until you interact with the page |
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

**Timeline** – one local day per screen for a camera (or all of them). Recordings
appear as blocks along a 24 hour band, detection events as marks underneath, and
a red line shows "now" while you are looking at today. Click a block to play it.
Step days with the arrows, jump with the date picker, or click a bar in the
*events per day* chart to open that day. Underneath are two charts: events per
hour for the selected day, and events per day over the last 14/30/90 days, which
is how you spot a camera that has started over-triggering.

**Recordings** – filter by camera, trigger, status and time; play in place,
download, delete one or many.

Playback shows the **wall clock time of the frame you are watching**, not just a
position, so "1:30 into the file" is answered as an actual time of day. Under the
video are two aligned bars: a timeline labelled with real times, and a **sound
intensity bar** built from the recording's audio, so you can see at a glance
where something was audible. Both bars are clickable and draggable to seek.

The intensity bar is computed on first playback (ffmpeg decodes the audio to low
rate mono, reduced to RMS per bucket and converted to dBFS so ordinary sound is
visible rather than a flat line) and cached in `/data/waveforms`.

**Clip export.** Play to the start of the interesting part, press *Set start*,
play on, press *Set end*, then *Export clip*. The marked range is highlighted on
the timeline and downloaded as its own MP4. The cut is a stream copy, so it is
instant and lossless, which also means the start snaps back to the nearest
keyframe before your mark – expect a second or two of lead-in.

**Events** – every ONVIF notification with its topic, state and the recording it
triggered. Enabling *Save a snapshot when a detection happens* on a camera (off
by default) adds a still to each detection, shown as a thumbnail in this list so
it can be scanned by eye. Each snapshot costs a short RTSP connection, and
repeats within 15 seconds are skipped, since cameras fire the same detection on
several topics at once.

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
  shut down ten seconds after the last one leaves. Video is copied; audio is
  re-encoded to AAC only because cameras usually speak G.711, which neither MP4
  nor MediaSource can carry.
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
GET    /api/recordings/:id/stream | download | thumbnail | waveform | clip
GET    /api/timeline?camera_id=&date=       GET    /api/timeline/activity?days=
DELETE /api/recordings/:id                        POST   /api/recordings/delete
GET    /api/events | /api/events/types            DELETE /api/events/:id
POST   /api/events/delete
GET    /api/snapshots                             POST   /api/snapshots?camera_id=
GET    /api/snapshots/:id/file                    DELETE /api/snapshots/:id
GET    /api/system/stats | settings               PUT    /api/system/settings
WS     /ws/live?camera_id=&quality=sub|main       WS     /ws/updates
```

---

## Loose ends worth revisiting

Known and accepted for now, kept here so they are not forgotten.

| Item | State | Why it matters later |
| --- | --- | --- |
| `APP_SECRET` is the default *when run locally* | Accepted for local use | It signs sessions and derives the key encrypting the camera password in SQLite, so anyone who can read the database can recover that password. The UI shows a banner while the value is weak or shorter than 16 characters. The Docker stacks refuse to deploy without a real one, so this only applies to `npm start` on your PC — changing it later invalidates stored camera passwords, so re-enter them afterwards. |
| Admin password is `admin` *when run locally* | Accepted for local use | Same reasoning; the banner stays until it is changed. Both compose files require `ADMIN_PASSWORD` to be set, so a deployed stack cannot come up with it. |
| Portainer deployment unverified | To test | The image and stack are written but never built — Docker was not running. Expect the first build to take a few minutes (it compiles better-sqlite3 and installs ffmpeg). |
| `PUBLIC_URL` in Docker | Watch | Event push works today because the callback URL is auto-detected on a flat LAN. A bridged container's IP is *not* reachable from the camera, so this must be set to the host address when moving to Portainer, or events will silently stop arriving. |
| Live view is H.264 only | Accepted | MediaSource cannot play H.265. Fine for the C325WB; relevant if a future camera defaults to H.265. Recording is unaffected — it copies whatever the camera sends. |
| Main stream delivers ~10 fps | Watch | The camera reports 20 fps in its profile. Probably the link rather than the camera. Only worth chasing if playback looks choppy. |
| No HTTPS | Accepted | Fine on a LAN. Put it behind a reverse proxy with TLS before exposing it to the internet — the login cookie is not encrypted in transit otherwise. |
| ffmpeg lives in the project folder | Accepted | Works because the binary is resolved from the app directory as well as `PATH`. The Docker image installs ffmpeg properly, so this only applies to running it locally on Windows. |

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
