'use strict';

const repo = require('../db/repo');
const onvif = require('./onvifClient');
const recorder = require('./recorder');
const streamHub = require('./streamHub');
const { publish } = require('./bus');
const { createLogger } = require('../logger');

const log = createLogger('cameras');

const RECONNECT_BASE_MS = 15000;
const RECONNECT_MAX_MS = 300000;
const HEALTH_INTERVAL_MS = 60000;

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
      this.subscribeEvents(cam);
      this.startHealthChecks();
      log.info(`camera ${this.cameraId} (${camera.name}) connected`);
    } catch (err) {
      this.setStatus('offline', err.message);
      log.warn(`camera ${this.cameraId} connect failed: ${err.message}`);
      this.scheduleReconnect();
    }
  }

  subscribeEvents(cam) {
    this.eventHandler = (message) => {
      try {
        this.handleEvent(message);
      } catch (err) {
        log.error(`camera ${this.cameraId}: failed to handle event: ${err.message}`);
      }
    };
    this.eventsErrorHandler = (err) => {
      log.warn(`camera ${this.cameraId}: ONVIF event error: ${(err && err.message) || err}`);
      this.setStatus('degraded', `Event subscription failed: ${(err && err.message) || err}`);
      this.teardownConnection();
      this.scheduleReconnect();
    };
    // Adding an 'event' listener makes the onvif client create (and renew) a
    // PullPoint subscription on the camera.
    cam.on('event', this.eventHandler);
    cam.on('eventsError', this.eventsErrorHandler);
  }

  handleEvent(message) {
    const parsed = onvif.parseEvent(message);
    if (!parsed) return;
    const camera = repo.cameras.getWithSecret(this.cameraId);
    if (!camera) return;

    this.lastEventAt = new Date();
    const stored = repo.events.create({
      camera_id: this.cameraId,
      topic: parsed.topic,
      type: parsed.type,
      label: parsed.label,
      state: parsed.state,
      source: parsed.source,
      raw: parsed.raw,
      received_at: parsed.received_at,
    });
    log.debug(`camera ${this.cameraId}: ${parsed.label} (state=${parsed.state})`);
    publish('event:created', { camera_id: this.cameraId, event: stored });
    repo.cameras.setStatus(this.cameraId, 'online', null);

    if (!camera.record_on_event) return;
    const initial = parsed.raw && parsed.raw.propertyOperation === 'Initialized';
    const isTrigger = parsed.state === true || (parsed.state === null && !initial);
    const active = recorder.getActive(this.cameraId);
    if (!isTrigger && !active) return;

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

  teardownConnection() {
    this.stopHealthChecks();
    if (this.cam) {
      try {
        if (this.eventHandler) this.cam.removeListener('event', this.eventHandler);
        if (this.eventsErrorHandler) this.cam.removeListener('eventsError', this.eventsErrorHandler);
        this.cam.removeAllListeners('error');
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
    this.teardownConnection();
    runtimes.delete(this.cameraId);
  }

  info() {
    return {
      camera_id: this.cameraId,
      connected: !!this.cam,
      last_event_at: this.lastEventAt ? this.lastEventAt.toISOString() : null,
      reconnect_attempts: this.attempts,
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
};
