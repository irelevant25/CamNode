# Knowledge base

What the code does not say on its own: why things are the way they are, the
rules that keep them working, and what is known to be wrong. The top-level
`README.md` is for someone deploying the app; this is for someone changing it.

| File | Read it when |
| --- | --- |
| [architecture.md](architecture.md) | First. Module map, data flow, deliberate design decisions. |
| [onvif-events.md](onvif-events.md) | Touching `cameraManager.js` / `onvifClient.js`, or debugging "events do not arrive". |
| [media-pipeline.md](media-pipeline.md) | Touching anything that spawns ffmpeg: recorder, live view, snapshots, clips, waveform, file serving. |
| [data-model.md](data-model.md) | Writing SQL or adding a column. **Contains the timestamp rule.** |
| [frontend.md](frontend.md) | Touching `public/`. |
| [known-issues.md](known-issues.md) | Looking for something to fix, or wondering whether a quirk is known. |

Keep these current: a change that invalidates a statement here updates the
statement in the same commit.
