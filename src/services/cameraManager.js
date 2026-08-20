'use strict';

const net = require('net');
const repo = require('../db/repo');
const { config } = require('../config');
const onvif = require('./onvifClient');
const recorder = require('./recorder');
const streamHub = require('./streamHub');
const { publish } = require('./bus');
const { createLogger } = require('../logger');

const log = createLogger('cameras');

const RECONNECT_BASE_MS = 15000;
const RECONNECT_MAX_MS = 300000;
const HEALTH_INTERVAL_MS = 60000;
/** Subscriptions are created with a 2 minute lifetime; renew well before that. */
const PUSH_RENEW_MS = 45000;
/** A pull-point that dies this fast has never worked – fall back to push. */
const PULL_GRACE_MS = 30000;

/** Which local address do packets to this camera leave from? */
function localAddressFor(host, port) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const socket = net.connect({ host, port: port || 80 }, () => {
      const address = socket.localAddress;
      socket.destroy();
      done(address);
    });
    socket.setTimeout(5000, () => {
      socket.destroy();
      done(null);
    });
    socket.on('error', () => done(null));
  });
}

function formatHost(address) {
  const clean = String(address || '').replace(/^::ffff:/, '');
  return clean.indexOf(':') !== -1 ? `[${clean}]` : clean;
}

/**
 * URL a camera should POST its notifications to. `PUBLIC_URL` wins; otherwise
 * we use the address our own traffic to that camera comes from, which is right
 * on a flat LAN but not inside a bridged Docker network.
 */
async function consumerUrlFor(camera) {
  const token = repo.cameras.ensureNotifyToken(camera.id);
  let base = config.publicUrl;
  if (!base) {
    const address = await localAddressFor(camera.host, camera.onvif_port);
    if (!address) throw new Error('could not work out a local address the camera can reach – set PUBLIC_URL');
    base = `http://${formatHost(address)}:${config.port}`;
  }
  return `${base.replace(/\/+$/, '')}/onvif/notify/${camera.id}/${token}`;
}

/** cameraId -> CameraRuntime */
const runtimes = new Map();

/** Copy of a camera row with credentials injected into the stream URLs. */
function withCredentials(camera) {
  if (!camera) return null;
  const ready = Object.assign({}, camera);
  ready.live_stream_url = onvif.withCredentials(camera.live_stream_url, camera);
  ready.record_stream_url = onvif.withCredentials(camera.record_stream_url, camera);
  ready.snapshot_url = onvif.withCredentials(camera.snapshot_url, camera);
  return ready;
}

/**
 * Return a camera ready to be handed to ffmpeg. Stream URLs are discovered over
 * ONVIF on first use (or when `force` is set) and cached in the database.
 */
async function getReadyCamera(id, options) {
  const opts = options || {};
  const stored = repo.cameras.getWithSecret(id);
  if (!stored) return null;
  if (!opts.force && stored.record_stream_url) return withCredentials(stored);

  const info = await onvif.inspect(stored);
  repo.cameras.setStreamInfo(id, {
    live_stream_url: info.live_stream_url,
    record_stream_url: info.record_stream_url,
    snapshot_url: info.snapshot_url,
    profiles: info.profiles,
    live_profile_token: info.live_profile_token,
    record_profile_token: info.record_profile_token,
  });
  repo.cameras.setStatus(id, 'online', null);
  publish('camera:status', { camera_id: id, status: 'online', message: null });
  return withCredentials(repo.cameras.getWithSecret(id));
}

/** Probe a camera without persisting anything (used by the "Test" button). */
async function probe(input) {
  let password = input.password || '';
  if (!password && input.camera_id) {
    // Editing an existing camera and the password field was left untouched.
    const stored = repo.cameras.getWithSecret(Number(input.camera_id));
    if (stored) password = stored.password;
  }
  const camera = {
    host: String(input.host || '').trim(),
    onvif_port: parseInt(input.onvif_port, 10) || 2020,
    username: input.username || '',
    password,
    live_profile_token: input.live_profile_token || null,
    record_profile_token: input.record_profile_token || null,
  };
  if (!camera.host) throw new Error('Host is required');
  const info = await onvif.inspect(camera);
  return {
    device: info.device,
    profiles: info.profiles,
    live_profile_token: info.live_profile_token,
    record_profile_token: info.record_profile_token,
    live_stream_url: info.live_stream_url,
    record_stream_url: info.record_stream_url,
    snapshot_url: info.snapshot_url,
  };
}

class CameraRuntime {
  constructor(cameraId) {
    this.cameraId = cameraId;
    this.cam = null;
    this.stopped = false;
    this.attempts = 0;
    this.reconnectTimer = null;
    this.healthTimer = null;
    this.eventHandler = null;
    this.eventsErrorHandler = null;
    this.lastEventAt = null;
    /** 'pull' | 'push' | 'off' | null while starting up */
    this.eventChannel = null;
    this.eventChannelError = null;
    this.pullStartedAt = null;
    this.pullEventSeen = false;
    this.pushRenewTimer = null;
    this.consumerUrl = null;
    this.pushCount = 0;
    this.lastPushAt = null;
  }

  async start() {
    if (this.stopped) return;
    const camera = repo.cameras.getWithSecret(this.cameraId);
    if (!camera || !camera.enabled) return this.stop();

    try {
      const cam = await onvif.connect(camera, 12000);
      if (this.stopped) return;
      const info = await onvif.inspect(camera, { cam, keepOpen: true });
      repo.cameras.setStreamInfo(this.cameraId, {
        live_stream_url: info.live_stream_url,
        record_stream_url: info.record_stream_url,
        snapshot_url: info.snapshot_url,
        profiles: info.profiles,
        live_profile_token: info.live_profile_token,
        record_profile_token: info.record_profile_token,
      });
      this.cam = cam;
      this.attempts = 0;
      this.setStatus('online', null);
      this.startEvents(camera, cam);
      this.startHealthChecks();
      log.info(`camera ${this.cameraId} (${camera.name}) connected`);
    } catch (err) {
      this.setStatus('offline', err.message);
      log.warn(`camera ${this.cameraId} connect failed: ${err.message}`);
      this.scheduleReconnect();
    }
  }

  /* ------------------------------------------------------------- events */

  startEvents(camera, cam) {
    const mode = camera.event_mode || 'auto';
    if (mode === 'off') {
      this.eventChannel = 'off';
      log.info(`camera ${this.cameraId}: event notifications disabled`);
      return;
    }
    if (mode === 'push') return this.startPush();
    this.startPull();
  }

  /**
   * PullPoint: the onvif client creates the subscription as soon as an 'event'
   * listener exists and keeps polling by itself.
   */
  startPull() {
    const cam = this.cam;
    if (!cam || this.eventHandler) return;
    this.eventChannel = 'pull';
    this.pullStartedAt = Date.now();
    this.pullEventSeen = false;

    this.eventHandler = (message) => {
      this.pullEventSeen = true;
      this.eventChannelError = null;
      try {
        this.handleEvent(message);
      } catch (err) {
        log.error(`camera ${this.cameraId}: failed to handle event: ${err.message}`);
      }
    };
    this.eventsErrorHandler = (err) => this.onPullError(err);
    cam.on('event', this.eventHandler);
    cam.on('eventsError', this.eventsErrorHandler);
    log.debug(`camera ${this.cameraId}: listening for events via pull point`);
  }

  stopPull() {
    if (this.cam) {
      if (this.eventHandler) this.cam.removeListener('event', this.eventHandler);
      if (this.eventsErrorHandler) this.cam.removeListener('eventsError', this.eventsErrorHandler);
    }
    this.eventHandler = null;
    this.eventsErrorHandler = null;
  }

  /**
   * The onvif client retries pull failures on its own, so a single error is not
   * fatal and must not tear the connection down. What it cannot do is notice
   * that a camera never supports PullMessages at all – that is what the
   * fallback below is for (Tapo resets the connection on every pull).
   */
  onPullError(err) {
    const message = (err && err.message) || String(err);
    this.eventChannelError = message;
    const camera = repo.cameras.get(this.cameraId);
    const mode = (camera && camera.event_mode) || 'auto';
    const young = Date.now() - this.pullStartedAt < PULL_GRACE_MS;

    if (mode === 'auto' && !this.pullEventSeen && young) {
      log.info(
        `camera ${this.cameraId}: pull point not usable (${message}), switching to push notifications`
      );
      this.stopPull();
      this.startPush();
      return;
    }
    log.warn(`camera ${this.cameraId}: ONVIF event error: ${message}`);
    this.setStatus('degraded', `Event subscription problem: ${message}`);
  }

  /**
   * WS-BaseNotification: we hand the camera a URL and it POSTs events to us.
   */
  async startPush() {
    const cam = this.cam;
    if (!cam || this.stopped) return;
    this.eventChannel = 'push';
    try {
      const camera = repo.cameras.getWithSecret(this.cameraId);
      if (!camera) return;
      this.consumerUrl = await consumerUrlFor(camera);
      await onvif.subscribePush(cam, this.consumerUrl);
      if (this.stopped) return;
      this.eventChannelError = null;
      this.setStatus('online', null);
      log.info(`camera ${this.cameraId}: subscribed for push notifications to ${this.consumerUrl}`);
      this.schedulePushRenew();
      // Makes the camera report the current state of every property straight
      // away, so a working subscription shows up in the log immediately.
      onvif
        .setSynchronizationPoint(cam)
        .then(() => log.debug(`camera ${this.cameraId}: synchronization point requested`))
        .catch((err) => log.debug(`camera ${this.cameraId}: synchronization point failed: ${err.message}`));
    } catch (err) {
      this.eventChannelError = err.message;
      log.warn(`camera ${this.cameraId}: push subscription failed: ${err.message}`);
      this.setStatus('degraded', `Could not subscribe for events: ${err.message}`);
    }
  }

  schedulePushRenew() {
    this.stopPushRenew();
    this.pushRenewTimer = setInterval(() => {
      if (!this.cam || this.stopped) return;
      onvif.renewSubscription(this.cam).catch((err) => {
        log.warn(`camera ${this.cameraId}: renewing the subscription failed (${err.message}), resubscribing`);
        this.stopPushRenew();
        this.startPush();
      });
    }, PUSH_RENEW_MS);
  }

  stopPushRenew() {
    if (this.pushRenewTimer) clearInterval(this.pushRenewTimer);
    this.pushRenewTimer = null;
  }

  /** Called by the /onvif/notify endpoint for every pushed notification. */
  async handlePushBody(xml) {
    this.pushCount += 1;
    this.lastPushAt = new Date();
    const messages = await onvif.parseNotificationXml(xml);
    let handled = 0;
    for (const message of messages) {
      try {
        if (this.handleEvent(message)) handled += 1;
      } catch (err) {
        log.error(`camera ${this.cameraId}: failed to handle pushed event: ${err.message}`);
      }
    }
    return handled;
  }

  handleEvent(message) {
    const parsed = onvif.parseEvent(message);
    if (!parsed) return false;
    const camera = repo.cameras.getWithSecret(this.cameraId);
    if (!camera) return false;

    const incoming = {
      camera_id: this.cameraId,
      topic: parsed.topic,
      type: parsed.type,
      label: parsed.label,
      state: parsed.state,
      source: parsed.source,
      raw: parsed.raw,
      received_at: parsed.received_at,
    };

    // A camera replays its recent notifications whenever we re-subscribe.
    // Storing those again would also re-trigger a recording for old motion.
    if (repo.events.findDuplicate(incoming)) {
      log.debug(`camera ${this.cameraId}: ignoring repeated notification (${parsed.topic} @ ${parsed.received_at})`);
      return false;
    }

    this.lastEventAt = new Date();
    const stored = repo.events.create(incoming);
    log.debug(`camera ${this.cameraId}: ${parsed.label} (state=${parsed.state})`);
    publish('event:created', { camera_id: this.cameraId, event: stored });
    repo.cameras.setStatus(this.cameraId, 'online', null);

    if (!camera.record_on_event) return true;
    const initial = parsed.raw && parsed.raw.propertyOperation === 'Initialized';
    const isTrigger = parsed.state === true || (parsed.state === null && !initial);
    const active = recorder.getActive(this.cameraId);
    if (!isTrigger && !active) return true;

    try {
      const ready = withCredentials(camera);
      recorder.start(ready, {
        trigger: 'event',
        eventId: stored.id,
        stopAfterSeconds: camera.event_record_seconds,
      });
    } catch (err) {
      log.error(`camera ${this.cameraId}: could not start event recording: ${err.message}`);
    }
    return true;
  }

  /**
   * Prove the event path end to end: ask the camera to re-send the current
   * property state and see whether anything actually reaches us.
   */
  async testEvents() {
    if (!this.cam) throw new Error('Camera is not connected');
    if (this.eventChannel === 'off') throw new Error('Event notifications are disabled for this camera');

    const before = this.pushCount;
    const beforeEventAt = this.lastEventAt ? this.lastEventAt.getTime() : 0;
    await onvif.setSynchronizationPoint(this.cam);

    await new Promise((resolve) => setTimeout(resolve, 6000));
    const pushed = this.pushCount - before;
    const gotEvent = this.lastEventAt && this.lastEventAt.getTime() > beforeEventAt;
    return {
      channel: this.eventChannel,
      consumer_url: this.consumerUrl,
      notifications_received: pushed,
      event_stored: !!gotEvent,
      ok: pushed > 0 || !!gotEvent,
    };
  }

  startHealthChecks() {
    this.stopHealthChecks();
    this.healthTimer = setInterval(() => {
      if (!this.cam) return;
      this.cam.getSystemDateAndTime((err) => {
        if (this.stopped) return;
        if (err) {
          log.warn(`camera ${this.cameraId}: health check failed: ${err.message}`);
          this.setStatus('offline', err.message);
          this.teardownConnection();
          this.scheduleReconnect();
        } else {
          repo.cameras.setStatus(this.cameraId, 'online', null);
        }
      });
    }, HEALTH_INTERVAL_MS);
  }

  stopHealthChecks() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.attempts += 1;
    const delay = Math.min(RECONNECT_BASE_MS * this.attempts, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start().catch((err) => log.error(`reconnect failed: ${err.message}`));
    }, delay);
    log.debug(`camera ${this.cameraId}: reconnecting in ${Math.round(delay / 1000)}s`);
  }

  teardownConnection(options) {
    const opts = options || {};
    this.stopHealthChecks();
    this.stopPushRenew();
    const cam = this.cam;
    if (cam) {
      // Tell the camera to drop a push subscription so it stops posting to a
      // URL we no longer serve.
      if (opts.unsubscribe && this.eventChannel === 'push') {
        onvif.unsubscribeEvents(cam).catch(() => null);
      }
      try {
        this.stopPull();
        cam.removeAllListeners('error');
      } catch (err) {
        /* ignore */
      }
    }
    this.cam = null;
    this.eventHandler = null;
    this.eventsErrorHandler = null;
  }

  setStatus(status, message) {
    repo.cameras.setStatus(this.cameraId, status, message);
    publish('camera:status', { camera_id: this.cameraId, status, message: message || null });
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.teardownConnection({ unsubscribe: true });
    runtimes.delete(this.cameraId);
  }

  info() {
    return {
      camera_id: this.cameraId,
      connected: !!this.cam,
      last_event_at: this.lastEventAt ? this.lastEventAt.toISOString() : null,
      reconnect_attempts: this.attempts,
      event_channel: this.eventChannel,
      event_channel_error: this.eventChannelError,
      consumer_url: this.consumerUrl,
      notifications_received: this.pushCount,
      last_notification_at: this.lastPushAt ? this.lastPushAt.toISOString() : null,
    };
  }
}

function startRuntime(cameraId) {
  stopRuntime(cameraId);
  const runtime = new CameraRuntime(cameraId);
  runtimes.set(cameraId, runtime);
  runtime.start().catch((err) => log.error(`camera ${cameraId}: ${err.message}`));
  return runtime;
}

function stopRuntime(cameraId) {
  const runtime = runtimes.get(cameraId);
  if (runtime) runtime.stop();
}

/** (Re)start the ONVIF connection for a camera after it was added or edited. */
function reload(cameraId) {
  const camera = repo.cameras.get(cameraId);
  streamHub.stopCamera(cameraId);
  if (!camera) {
    stopRuntime(cameraId);
    return;
  }
  if (camera.enabled) startRuntime(cameraId);
  else {
    stopRuntime(cameraId);
    repo.cameras.setStatus(cameraId, 'disabled', null);
    publish('camera:status', { camera_id: cameraId, status: 'disabled', message: null });
  }
}

/**
 * Entry point for the unauthenticated /onvif/notify endpoint. The token in the
 * URL is what proves the notification belongs to that camera's subscription.
 */
async function handlePushNotification(cameraId, token, xml, remoteAddress) {
  const camera = repo.cameras.getWithSecret(cameraId);
  if (!camera || !camera.notify_token || !safeEqual(camera.notify_token, token)) {
    return { ok: false, reason: 'unknown subscription' };
  }
  if (remoteAddress && camera.host && formatHost(remoteAddress) !== camera.host) {
    log.debug(
      `camera ${cameraId}: notification came from ${formatHost(remoteAddress)} but the camera is ${camera.host}`
    );
  }
  const runtime = runtimes.get(cameraId);
  if (!runtime) return { ok: false, reason: 'camera is not being monitored' };
  const handled = await runtime.handlePushBody(xml);
  return { ok: true, handled };
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length || !left.length) return false;
  return require('crypto').timingSafeEqual(left, right);
}

async function testEvents(cameraId) {
  const runtime = runtimes.get(cameraId);
  if (!runtime) throw new Error('Camera is not being monitored – enable it first');
  return runtime.testEvents();
}

function runtimeInfo() {
  const out = {};
  for (const [id, runtime] of runtimes) out[id] = runtime.info();
  return out;
}

function init() {
  const cameras = repo.cameras.list();
  for (const camera of cameras) {
    if (camera.enabled) startRuntime(camera.id);
    else repo.cameras.setStatus(camera.id, 'disabled', null);
  }
  log.info(`monitoring ${cameras.filter((c) => c.enabled).length} camera(s)`);
}

async function shutdown() {
  for (const id of Array.from(runtimes.keys())) stopRuntime(id);
}

module.exports = {
  init,
  shutdown,
  reload,
  startRuntime,
  stopRuntime,
  getReadyCamera,
  withCredentials,
  probe,
  runtimeInfo,
  handlePushNotification,
  consumerUrlFor,
  testEvents,
};
