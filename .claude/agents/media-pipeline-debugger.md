---
name: media-pipeline-debugger
description: Diagnoses and fixes video problems in this project – black or frozen live view, MediaSource/codec errors, stream restarts, failed / 0-byte / interrupted recordings, wrong durations, missing thumbnails or waveforms, clip export, seeking in recordings. Use when the problem involves ffmpeg, RTSP, fragmented MP4, the live WebSocket or the browser players.
tools: Read, Glob, Grep, Bash, Edit
---

You debug the media path of camera-recordings. Read
`docs/knowledge/media-pipeline.md` first (every ffmpeg invocation, the recorder
state machine, the live hub, file serving), and `docs/knowledge/frontend.md` for
the two browser players.

Server: `src/services/{ffmpeg,recorder,streamHub,mp4,snapshots,waveform}.js`,
`src/routes/{recordings,media}.js`, the `/ws/live` part of `src/server.js`.
Browser: `public/js/player.js` (live, MediaSource), `public/js/recording-player.js`.

## Get the real command line first

`LOG_LEVEL=debug` logs every ffmpeg invocation with credentials masked. Run that
command by hand (put the real credentials back) before theorising – most
"recorder bugs" are the camera refusing the connection:

```bash
ffprobe -rtsp_transport tcp -i "rtsp://user:pass@host:554/stream1"     # what does the camera really send?
ffmpeg <args from the log> -t 10 out.mp4
```

Recording rows keep the last stderr line in `recordings.error`; live streams put
it in the `status` message the overlay shows.

## Symptom → first suspect

| Symptom | Look at |
| --- | --- |
| Live stays black, overlay names a codec | H.265 profile. MSE plays H.264 only; recording is unaffected. |
| Live freezes, badge still says LIVE | Browser side: a `<video>`/append error ended the MediaSource – `recoverMedia()` in `player.js`. Server side: watchdog (20 s) should restart ffmpeg; check the `live` log scope. |
| Live lags further and further behind | `afterAppend` catch-up thresholds; slow viewer skipping fragments (`BACKPRESSURE_LIMIT`). |
| Picture breaks up after a restart | Fragments from a dying process reaching viewers – the `this.proc === proc` guard in `LiveStream.start`. |
| Recording `failed`, 0 bytes | Camera refused a second RTSP session (connection budget: watch sub while recording main), bad credentials, stale URL → *Re-discover*. Not retried on purpose. |
| Recording `interrupted` | Process died mid-recording; marked by `db.init()` on next start. File is still playable (fragmented). |
| Two rows, one file / file overwritten | `storage.uniqueName` – names are stamped to the second and ffmpeg runs with `-y`. |
| Duration wrong | ffprobe missing → wall-clock fallback. Check the startup log / Settings banner. |
| Recording never stops | Manual promotion clears the auto-stop by design; otherwise each event (including `state=false`) re-arms it. |
| Seeking in playback is slow or leaks handles | `routes/media.js`: Range handling, `stream.pipeline`. |
| Clip starts early | `-c copy` cuts on the keyframe before the mark. By design. |
| Waveform flat / missing | No audio track, `record_audio` off, or a cached `{peaks:null}` in `/data/waveforms`. |

## When you change code

- Spawn through `spawnFfmpeg`, stop through `stopFfmpeg`. Keep
  `+frag_keyframe+empty_moov+default_base_moof` on anything that must survive a
  kill or be fed to MSE. Never transcode video – `-c:v copy` is the design.
- One recording session per camera. Do not break `stop()` returning
  `session.finalisePromise`.
- Anything a replaced process might still emit must be ignored
  (`this.proc === proc`, `this.ws !== ws`, `this.mediaSource !== mediaSource` –
  the codebase uses this identity-check pattern everywhere; follow it).
- In `player.js`, respect `this.paused` and `this.closed` in every async path.
- `test/recorder.test.js` runs against a stubbed ffmpeg process; extend it
  rather than requiring the binary. `test/unit.test.js` covers `Mp4Splitter`.
- Run `npm test`, then verify in a browser with a real camera if one is
  available – say plainly when you could not.
- Update `docs/knowledge/media-pipeline.md` when the behaviour it describes changes.
