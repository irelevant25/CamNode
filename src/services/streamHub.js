'use strict';

const { config } = require('../config');
const { createLogger } = require('../logger');
const { rtspInputArgs, spawnFfmpeg, stopFfmpeg, maskUrl } = require('./ffmpeg');
const { Mp4Splitter } = require('./mp4');

const log = createLogger('live');

/** Drop fragments for a viewer whose socket is this far behind (bytes). */
const BACKPRESSURE_LIMIT = 4 * 1024 * 1024;

/**
 * One ffmpeg process per camera+quality, fanned out to every viewer.
 * ffmpeg only remuxes (`-c:v copy`) so CPU cost stays negligible.
 */
class LiveStream {
  constructor(key, camera, quality) {
    this.key = key;
    this.camera = camera;
    this.quality = quality;
    this.clients = new Set();
    this.proc = null;
    this.splitter = null;
    this.initSegment = null;
    this.watchdog = null;
    this.idleTimer = null;
    this.restartTimer = null;
    this.attempts = 0;
    this.bytes = 0;
    this.startedAt = null;
    this.stopped = false;
    this.state = 'idle';
  }

  get url() {
    return this.quality === 'main'
      ? this.camera.record_stream_url || this.camera.live_stream_url
      : this.camera.live_stream_url || this.camera.record_stream_url;
  }

  addClient(client) {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.clients.add(client);
    this.sendControl(client, { type: 'status', state: this.state, quality: this.quality });
    if (this.initSegment) this.sendBinary(client, this.initSegment, true);
    if (!this.proc && !this.restartTimer) this.start();
  }

  removeClient(client) {
    this.clients.delete(client);
    if (this.clients.size === 0 && !this.idleTimer) {
      this.idleTimer = setTimeout(() => {
        this.idleTimer = null;
        if (this.clients.size === 0) {
          log.info(`camera ${this.camera.id}: no viewers left, stopping live stream`);
          this.stop();
        }
      }, config.live.idleShutdownMs);
    }
  }

  start() {
    const url = this.url;
    if (!url) {
      this.setState('error', 'No RTSP URL known for this camera');
      return;
    }
    this.stopped = false;
    this.initSegment = null;
    this.setState('connecting');

    const args = rtspInputArgs(this.camera, url).concat([
      '-an',
      '-c:v',
      'copy',
      '-movflags',
      '+frag_keyframe+empty_moov+default_base_moof',
      '-f',
      'mp4',
      'pipe:1',
    ]);

    const proc = spawnFfmpeg(args);
    this.proc = proc;
    this.startedAt = new Date();

    this.splitter = new Mp4Splitter((kind, buffer) => this.onChunk(kind, buffer));
    this.splitter.on('error', (err) => {
      log.warn(`camera ${this.camera.id}: mp4 parse error: ${err.message}`);
      this.restart();
    });
    proc.stdout.pipe(this.splitter);

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    proc.on('close', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.clearWatchdog();
      if (this.stopped) return;
      const detail = lastLine(stderr);
      log.warn(`camera ${this.camera.id}: live ffmpeg exited (code ${code})${detail ? ': ' + detail : ''}`);
      this.setState('error', detail || `stream ended (code ${code})`);
      this.restart();
    });

    this.armWatchdog();
    log.info(`camera ${this.camera.id}: live stream started (${this.quality}) ${maskUrl(url)}`);
  }

  onChunk(kind, buffer) {
    this.bytes += buffer.length;
    this.armWatchdog();
    if (kind === 'init') {
      this.initSegment = buffer;
      this.attempts = 0;
      this.setState('live');
      for (const client of this.clients) this.sendBinary(client, buffer, true);
      return;
    }
    for (const client of this.clients) this.sendBinary(client, buffer, false);
  }

  armWatchdog() {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      log.warn(`camera ${this.camera.id}: no video data for ${config.live.watchdogMs}ms, restarting`);
      this.setState('error', 'stream stalled');
      this.restart();
    }, config.live.watchdogMs);
  }

  clearWatchdog() {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  restart() {
    if (this.stopped || this.restartTimer) return;
    this.clearWatchdog();
    const proc = this.proc;
    this.proc = null;
    if (proc) stopFfmpeg(proc, 2000);
    if (this.clients.size === 0) return;
    this.attempts += 1;
    const delay = config.live.restartDelayMs * Math.min(this.attempts, 5);
    this.setState('reconnecting');
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopped && this.clients.size > 0) this.start();
    }, delay);
  }

  stop() {
    this.stopped = true;
    this.clearWatchdog();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const proc = this.proc;
    this.proc = null;
    this.state = 'idle';
    if (proc) stopFfmpeg(proc, 2000);
    hub.streams.delete(this.key);
  }

  setState(state, message) {
    this.state = state;
    this.stateMessage = message || null;
    for (const client of this.clients) {
      this.sendControl(client, { type: 'status', state, message: message || null, quality: this.quality });
    }
  }

  sendControl(client, payload) {
    try {
      if (client.readyState === 1) client.send(JSON.stringify(payload));
    } catch (err) {
      /* client is going away */
    }
  }

  sendBinary(client, buffer, force) {
    try {
      if (client.readyState !== 1) return;
      if (!force && client.bufferedAmount > BACKPRESSURE_LIMIT) return; // viewer too slow, skip
      client.send(buffer, { binary: true });
    } catch (err) {
      /* client is going away */
    }
  }

  stats() {
    return {
      camera_id: this.camera.id,
      quality: this.quality,
      state: this.state,
      message: this.stateMessage || null,
      viewers: this.clients.size,
      bytes: this.bytes,
      started_at: this.startedAt ? this.startedAt.toISOString() : null,
    };
  }
}

function lastLine(text) {
  if (!text) return '';
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  return lines.length ? maskUrl(lines[lines.length - 1]).slice(0, 200) : '';
}

const hub = {
  streams: new Map(),

  subscribe(camera, client, quality) {
    const q = quality === 'main' ? 'main' : 'sub';
    const key = `${camera.id}:${q}`;
    let stream = hub.streams.get(key);
    if (!stream) {
      stream = new LiveStream(key, camera, q);
      hub.streams.set(key, stream);
    } else {
      stream.camera = camera; // refresh credentials/urls
    }
    stream.addClient(client);
    return stream;
  },

  unsubscribe(stream, client) {
    if (stream) stream.removeClient(client);
  },

  /** Drop every stream of a camera (settings changed / camera deleted). */
  stopCamera(cameraId) {
    for (const stream of Array.from(hub.streams.values())) {
      if (stream.camera.id === cameraId) {
        for (const client of stream.clients) {
          stream.sendControl(client, { type: 'status', state: 'closed', message: 'camera changed' });
          try {
            client.close(1000, 'camera changed');
          } catch (err) {
            /* ignore */
          }
        }
        stream.clients.clear();
        stream.stop();
      }
    }
  },

  stats() {
    return Array.from(hub.streams.values()).map((s) => s.stats());
  },

  stopAll() {
    for (const stream of Array.from(hub.streams.values())) stream.stop();
  },
};

module.exports = hub;
