# Media pipeline

## ffmpeg invocations

| Use | Where | Shape |
| --- | --- | --- |
| Recording | `recorder.buildArgs` | RTSP in → `-map 0:v:0 -c:v copy` (+ `-map 0:a:0? -c:a aac` when `record_audio`) → fragmented MP4 file |
| Live | `streamHub.LiveStream.start` | same input → video copy + AAC mono → fMP4 on `pipe:1` |
| Snapshot | `snapshots.grab` | one frame, `-q:v 2`, 20 s timeout then SIGKILL |
| Thumbnail | `recorder.makeThumbnail` | `-ss 1`, falls back to the first frame for files shorter than that |
| Clip export | `routes/recordings.js` `/clip` | `-ss` before `-i`, `-c copy`, fMP4 to the response; killed when the client goes away |
| Waveform | `waveform.analyse` | decode to 4 kHz mono s16le, folded into 600 RMS buckets as it streams, dBFS with a −60 dB floor |

`rtspInputArgs` is shared by everything that reads a camera. Audio is re-encoded
because cameras speak G.711, which MP4/MSE cannot carry. Video is never
transcoded – which is also why live view is H.264 only (MSE cannot play H.265).

All output is `+frag_keyframe+empty_moov+default_base_moof`: a file stays
playable if the process dies, and the live stream can be cut into self-contained
chunks.

Always spawn through `spawnFfmpeg` (it attaches the `'error'` listener that keeps
an ENOENT from becoming an uncaught exception) and stop through `stopFfmpeg`
(`q` on stdin so the file is closed properly; SIGKILL after the timeout).

## Recorder lifecycle (`src/services/recorder.js`)

- `sessions`: cameraId → session. **One recording per camera.**
- `start()` on an existing session never starts a second ffmpeg:
  manual-over-event promotes it (clears the auto-stop), event-over-event links
  the event and re-arms the auto-stop, event-over-manual only links.
- `stop()` sets `stopping`, waits for ffmpeg to close, then returns
  `session.finalisePromise` – created by `onProcessClosed`, which runs first on
  the same `'close'` event.
- `finalise()`: under 1 KiB ⇒ `failed` and the file is removed; otherwise
  duration from ffprobe (wall clock as fallback) and a thumbnail.
- Unexpected exit: restarted up to `MAX_RESTARTS` (3) **only if** the file that
  just ended was `completed` – an instant failure means bad credentials/URL and
  retrying would only pile up failed rows.
- Rotation at `max_record_seconds`: stop, then start a new file carrying the
  remaining event window. A few seconds are lost between the two files.
- Rows left in `recording` by a crash are marked `interrupted` by
  `db.init()` on the next start. Tools that open the DB beside a running server
  must call `init({ recover: false })`.
- File names are stamped to the second; `storage.uniqueName` appends `-2`, `-3`…
  so a quick stop/start cannot make ffmpeg's `-y` overwrite the previous file.

## Live view

`LiveStream` keeps the last `init` segment and sends it to every new viewer
before fragments. Slow viewers (`bufferedAmount` > 4 MiB) skip fragments rather
than stall the others. Watchdog: no bytes for 20 s ⇒ restart with backoff
(2 s × attempts, max 10 s). Ten seconds after the last viewer leaves, the
process is stopped and the stream removed from the hub. A replaced process may
still flush output while it dies – the splitter callback checks
`this.proc === proc` so those fragments never reach viewers.

`Mp4Splitter` emits `init` = `ftyp+moov` once, then `fragment` =
`[styp|sidx] moof mdat`. A SourceBuffer only accepts whole boxes.

## Serving files

`routes/media.js sendFile` does Range requests by hand and streams with
`stream.pipeline`, not `.pipe()` – a seeking `<video>` aborts requests
constantly and `.pipe()` leaves the file descriptor open when it does.
