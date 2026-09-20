---
name: diagnose-events
description: Walk through why a camera's ONVIF events are not arriving, not being stored, or not starting recordings in camera-recordings, using the log and the counters on the Cameras page. Use when the user says events/motion/detections are missing, recordings are not triggered, the camera shows "degraded", or pastes log lines mentioning subscription, notification, push, pull or "socket hang up".
---

# Diagnose missing events

Background: `docs/knowledge/onvif-events.md`. For anything beyond this
checklist – parser changes, new firmware quirks, code fixes – hand over to the
`onvif-event-debugger` agent with everything gathered here.

## 1. Gather (ask for what is missing, do not guess)

- Log lines for the camera since its last `connected` line. With Docker:
  `docker logs --since 30m camera-recordings 2>&1 | grep "camera <id>"`.
- Cameras page: event channel (`pull`/`push`), *received / stored / repeated /
  recovered / unreadable*, *last notification*, *subscribed*, status message.
- Deployment: Docker or bare? `HTTP_PORT`, `PUBLIC_URL`, Settings → callback
  address. Camera model and firmware.
- The result of **Test events** on the Cameras page.

## 2. Read the evidence

| You see | It means | Do |
| --- | --- | --- |
| `pull point not usable (socket hang up), switching to push` once per connect | Normal on Tapo. | Nothing. Set *Event delivery* to `push` to skip the attempt. |
| `push subscription failed: …`, status *degraded* | The camera refused `Subscribe`, or no callback address could be worked out. Retried every 30 s. | Read the error. Too many subscriptions → wait 2 minutes (they expire) or reboot the camera. |
| Test events: `notifications_received: 0` | The camera cannot reach `consumer_url`. | Compare the URL with how the camera would reach this host: **published** port, host IP not container IP, no firewall between the VLANs. Fix in Settings → callback address (re-subscribes at once). |
| Test works, but nothing on real motion | The camera is not detecting. | Tapo app: Motion/Person detection enabled, no schedule, no privacy mode. |
| Worked, then silence; *last notification* much older than *subscribed* | Subscription dropped despite `Renew` succeeding. | Recovers at the 9-minute resubscribe. If it never recovers, look for `renewing the subscription failed` / `push subscription failed`. |
| `received` high, `stored` low, `repeated` high | Replays after resubscribes, de-duplicated. | Nothing. |
| `unreadable` > 0 | A body neither parser understands. | `LOG_LEVEL=debug`, capture the body → `onvif-event-debugger`. |
| `rejected notification …: unknown subscription` | A subscription from before the database was reset still posting. | Stops by itself within 2 minutes. |
| Events stored, no recording | `record_on_event` off; events all `state=false`; or the recorder failed. | Look for `could not start event recording` and for `failed` rows on the Recordings page – their tooltip holds ffmpeg's last line. `No RTSP URL known` → *Re-discover*. |
| Events stored with an odd type/label | `TYPE_RULES` order in `onvifClient.js`. | `onvif-event-debugger`. |
| `address already in use` at start | Port clash on the host. | Change **both** `HTTP_PORT` and the port in `PUBLIC_URL`. |

## 3. Answer

State which stage fails and the evidence for it, the one change to make, and how
the user confirms it worked (normally: **Test events** reports notifications,
then walk past the camera and check the Events page). If the evidence does not
single out a stage, say which piece is missing rather than listing every
possibility.
