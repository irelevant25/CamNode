# ONVIF events

Everything here is in `src/services/cameraManager.js` (lifecycle) and
`src/services/onvifClient.js` (protocol).

## Delivery modes (`cameras.event_mode`)

| Mode | What happens |
| --- | --- |
| `auto` | Start a pull point. If it errors within `PULL_GRACE_MS` (30 s) and no event was ever seen, switch to push. |
| `pull` | Pull point only. The `onvif` package creates the subscription as soon as an `'event'` listener exists and polls on its own; removing the last listener makes it unsubscribe. |
| `push` | WS-BaseNotification: we `Subscribe` with a consumer URL and the camera POSTs to `/onvif/notify/:cameraId/:token`. |
| `off` | Nothing. |

**Tapo (verified C325WB V2, fw 1.3.2)** accepts `CreatePullPointSubscription`
and then resets the TCP connection on every `PullMessages` – the `socket hang up`
in the log. Expected once per connect in `auto`; push is what works.

## Push subscription upkeep

Subscriptions are created with `PT2M` (hard-coded in the `onvif` package).

| Timer | Interval | Purpose |
| --- | --- | --- |
| `pushRenewTimer` | 45 s | `Renew`. On failure: drop timers, `startPush()` again. |
| `resubscribeTimer` | 9 min | Unsubscribe + fresh `Subscribe` regardless. Some firmware answers `Renew` and expires the subscription anyway – silence, no error. |
| `pushRetryTimer` | 30 s | Only after `startPush()` itself failed. Without it nothing retries: the renew timers exist only after a success and the health check keeps passing. |
| `healthTimer` | 60 s | `GetSystemDateAndTime`; failure → teardown + reconnect with linear backoff (15 s × attempts, max 5 min). |

The three push timers are cleared by `stopPushRenew()`, which
`teardownConnection()` calls. Any new timer must be cleared there too, and its
callback must re-check `this.stopped` and `this.cam` – runtimes are replaced
wholesale on `reload()`.

## Consumer URL

`Settings → public_url` beats `PUBLIC_URL` beats auto-detection (the local
address of a TCP connection opened to the camera). Auto-detection is wrong inside
a bridged Docker network. The URL must carry the **published** port.

## From notification to recording (`handleEvent`)

1. `parseNotificationXml` (the package's SOAP parser); on rejection
   `parseNotificationXmlLoosely` (regex) – counted as `recovered`, or
   `unparsable` if that finds nothing either.
2. `parseEvent` flattens to `{topic, type, label, state, source, received_at, raw}`.
   `type` comes from `TYPE_RULES`, **first match wins** – order matters
   (`person` before `motion`). `state` is the first boolean-ish data item;
   `null` when the topic carries none. `received_at` is the camera's `UtcTime`
   when present.
3. `repo.events.findDuplicate` – same camera, `received_at`, topic, state.
   Cameras replay recent notifications after every re-subscribe (so every
   9 minutes); without this each replay would re-record old motion.
4. Trigger rule: `state === true`, or `state === null` unless the message is a
   `PropertyOperation="Initialized"` replay.
5. A non-trigger event (`state === false`) still extends a running event
   recording – the window is "N seconds after the *last* event".

## Counters (Cameras page, `logDelivery`)

`received` (HTTP bodies) · `stored` · `duplicates` (shown as *repeated*) ·
`recovered` · `unparsable` (*unreadable*) · `empty` · `ignored` (no topic) ·
`subscriptions`. They reset when the runtime is rebuilt.

## Debugging checklist

1. Cameras page → **Test events** (`SetSynchronizationPoint`, waits 6 s).
   Nothing received ⇒ the consumer URL is unreachable from the camera.
2. `received ≈ stored` but low ⇒ the camera is not sending: detection off or
   scheduled in the Tapo app, or the subscription silently expired (compare
   *last notification* with *subscribed*).
3. `received` high, `stored` low ⇒ duplicates; normal.
4. `LOG_LEVEL=debug` logs unparsable bodies (first 400 chars) and every ffmpeg
   command line (credentials masked).
