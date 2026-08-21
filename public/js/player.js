/*
 * Live player: fragmented MP4 arrives over a WebSocket and is fed into a
 * MediaSource. The server sends one message per box group, so every message can
 * be appended to the SourceBuffer as-is.
 */
(function () {
  'use strict';

  function boxType(bytes) {
    if (bytes.length < 8) return '';
    return String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
  }

  function findAscii(bytes, needle) {
    const codes = [];
    for (let i = 0; i < needle.length; i += 1) codes.push(needle.charCodeAt(i));
    const limit = bytes.length - codes.length;
    for (let i = 0; i <= limit; i += 1) {
      let hit = true;
      for (let j = 0; j < codes.length; j += 1) {
        if (bytes[i + j] !== codes[j]) {
          hit = false;
          break;
        }
      }
      if (hit) return i;
    }
    return -1;
  }

  const hex = (value) => value.toString(16).padStart(2, '0');

  /**
   * Derive the MSE codec string from the init segment. Both tracks have to be
   * listed: a SourceBuffer created for video only rejects a stream that also
   * carries audio.
   */
  function codecFromInit(bytes) {
    let video = 'avc1.640028';
    const avc = findAscii(bytes, 'avcC');
    if (avc >= 0 && bytes.length > avc + 7) {
      video = `avc1.${hex(bytes[avc + 5])}${hex(bytes[avc + 6])}${hex(bytes[avc + 7])}`;
    } else if (findAscii(bytes, 'hvcC') >= 0) {
      video = 'hvc1.1.6.L93.B0';
    }
    // The server re-encodes camera audio to AAC-LC when there is any.
    const hasAudio = findAscii(bytes, 'mp4a') >= 0;
    return hasAudio ? `${video}, mp4a.40.2` : video;
  }

  class LivePlayer {
    constructor(video, handlers) {
      this.video = video;
      this.handlers = handlers || {};
      this.ws = null;
      this.mediaSource = null;
      this.sourceBuffer = null;
      this.objectUrl = null;
      this.queue = [];
      this.initSegment = null;
      this.codec = null;
      this.paused = false;
      this.closed = true;
      this.cameraId = null;
      this.quality = 'sub';
      this.retries = 0;
      this.retryTimer = null;
      // Rolling window of received chunks, used to measure the real bitrate.
      this.traffic = [];
      this.totalBytes = 0;
      this.lastQuality = null;
      this.fps = 0;
      this.onUpdateEnd = () => {
        this.afterAppend();
        this.pump();
      };
    }

    /* ------------------------------------------------------- connection */

    open(cameraId, quality) {
      this.close();
      this.closed = false;
      this.paused = false;
      this.cameraId = cameraId;
      this.quality = quality || 'sub';
      this.connect();
    }

    connect() {
      if (this.closed) return;
      this.status('connecting');
      const url = window.api.wsUrl('/ws/live', { camera_id: this.cameraId, quality: this.quality });
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          let payload = null;
          try {
            payload = JSON.parse(event.data);
          } catch (err) {
            return;
          }
          if (payload && payload.type === 'status') this.status(payload.state, payload.message);
          return;
        }
        this.onBinary(new Uint8Array(event.data));
      };

      ws.onclose = () => {
        if (this.closed || this.ws !== ws) return;
        this.status('disconnected');
        this.scheduleReconnect();
      };
      ws.onerror = () => {
        /* onclose follows */
      };
    }

    scheduleReconnect() {
      if (this.closed || this.retryTimer) return;
      this.retries += 1;
      const delay = Math.min(2000 * this.retries, 15000);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.connect();
      }, delay);
    }

    close() {
      this.closed = true;
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.retries = 0;
      if (this.ws) {
        const ws = this.ws;
        this.ws = null;
        ws.onmessage = null;
        ws.onclose = null;
        try {
          ws.close();
        } catch (err) {
          /* ignore */
        }
      }
      this.teardownMedia();
      this.initSegment = null;
      this.paused = false;
      this.status('idle');
    }

    /* ------------------------------------------------------------ media */

    onBinary(bytes) {
      const now = performance.now();
      this.totalBytes += bytes.length;
      this.traffic.push({ at: now, bytes: bytes.length });
      while (this.traffic.length && now - this.traffic[0].at > 5000) this.traffic.shift();

      const type = boxType(bytes);
      if (type === 'ftyp') {
        // New init segment: the encoder (re)started, rebuild the pipeline.
        this.initSegment = bytes;
        this.codec = codecFromInit(bytes);
        this.retries = 0;
        this.buildPipeline();
        return;
      }
      if (this.paused || !this.sourceBuffer) return;
      this.queue.push(bytes);
      if (this.queue.length > 60) this.queue.splice(0, this.queue.length - 30);
      this.pump();
    }

    buildPipeline() {
      this.teardownMedia();
      if (!window.MediaSource) {
        this.status('error', 'This browser does not support MediaSource playback');
        return;
      }
      const mime = `video/mp4; codecs="${this.codec}"`;
      if (!window.MediaSource.isTypeSupported(mime)) {
        this.status('error', `Browser cannot play this stream (${this.codec}). Set the camera to H.264.`);
        return;
      }

      const mediaSource = new MediaSource();
      this.mediaSource = mediaSource;
      this.objectUrl = URL.createObjectURL(mediaSource);
      this.video.src = this.objectUrl;

      mediaSource.addEventListener(
        'sourceopen',
        () => {
          if (this.mediaSource !== mediaSource) return;
          try {
            const sourceBuffer = mediaSource.addSourceBuffer(mime);
            sourceBuffer.mode = 'segments';
            sourceBuffer.addEventListener('updateend', this.onUpdateEnd);
            this.sourceBuffer = sourceBuffer;
            this.queue = this.initSegment ? [this.initSegment] : [];
            this.pump();
            const playing = this.video.play();
            if (playing && playing.catch) playing.catch(() => {});
          } catch (err) {
            this.status('error', err.message);
          }
        },
        { once: true }
      );
    }

    pump() {
      const sourceBuffer = this.sourceBuffer;
      if (!sourceBuffer || sourceBuffer.updating || !this.queue.length) return;
      if (!this.mediaSource || this.mediaSource.readyState !== 'open') return;
      const chunk = this.queue.shift();
      try {
        sourceBuffer.appendBuffer(chunk);
      } catch (err) {
        if (err && err.name === 'QuotaExceededError') {
          this.trim(true);
          this.queue.unshift(chunk);
        } else {
          this.status('error', err.message);
        }
      }
    }

    afterAppend() {
      const buffered = this.video.buffered;
      if (!buffered.length) return;
      const start = buffered.start(0);
      const end = buffered.end(buffered.length - 1);

      if (this.video.currentTime < start) this.video.currentTime = start;
      if (!this.paused) {
        const drift = end - this.video.currentTime;
        if (drift > 6) {
          this.video.currentTime = Math.max(start, end - 0.6);
          this.video.playbackRate = 1;
        } else if (drift > 1.6) {
          this.video.playbackRate = 1.12; // ease back to the live edge
        } else {
          this.video.playbackRate = 1;
        }
        if (this.video.paused) {
          const playing = this.video.play();
          if (playing && playing.catch) playing.catch(() => {});
        }
      }
      this.trim(false);
    }

    trim(aggressive) {
      const sourceBuffer = this.sourceBuffer;
      if (!sourceBuffer || sourceBuffer.updating) return;
      const buffered = this.video.buffered;
      if (!buffered.length) return;
      const start = buffered.start(0);
      const keep = aggressive ? 5 : 30;
      const cutoff = this.video.currentTime - keep;
      if (cutoff > start + 1) {
        try {
          sourceBuffer.remove(start, cutoff);
        } catch (err) {
          /* ignore */
        }
      }
    }

    teardownMedia() {
      if (this.sourceBuffer) {
        try {
          this.sourceBuffer.removeEventListener('updateend', this.onUpdateEnd);
        } catch (err) {
          /* ignore */
        }
      }
      this.sourceBuffer = null;
      if (this.mediaSource && this.mediaSource.readyState === 'open') {
        try {
          this.mediaSource.endOfStream();
        } catch (err) {
          /* ignore */
        }
      }
      this.mediaSource = null;
      this.queue = [];
      if (this.objectUrl) {
        URL.revokeObjectURL(this.objectUrl);
        this.objectUrl = null;
      }
      try {
        this.video.removeAttribute('src');
        this.video.load();
      } catch (err) {
        /* ignore */
      }
    }

    /* -------------------------------------------------------- controls */

    /** Freeze on the current frame; incoming video is discarded meanwhile. */
    pause() {
      if (this.paused) return;
      this.paused = true;
      this.video.pause();
      this.status('paused');
    }

    /** Rebuild the buffer from the live edge and start playing again. */
    resume() {
      if (!this.paused) return;
      this.paused = false;
      if (this.initSegment) this.buildPipeline();
      const playing = this.video.play();
      if (playing && playing.catch) playing.catch(() => {});
      this.status('live');
    }

    togglePause() {
      if (this.paused) this.resume();
      else this.pause();
    }

    /** Volume between 0 and 1. Anything at or below 0 mutes the element. */
    setVolume(value) {
      const level = Math.min(1, Math.max(0, Number(value) || 0));
      this.video.volume = level;
      this.video.muted = level <= 0;
      return level;
    }

    /**
     * Live measurements for the info overlay: nothing here is taken from a
     * stored setting, it is all what the browser is actually receiving now.
     */
    getStats() {
      const now = performance.now();

      let bitrate = 0;
      if (this.traffic.length > 1) {
        const span = (now - this.traffic[0].at) / 1000;
        if (span > 0.2) {
          const bytes = this.traffic.reduce((sum, item) => sum + item.bytes, 0);
          bitrate = (bytes * 8) / span;
        }
      }

      // Decoded frame counters give a real measured frame rate.
      let dropped = null;
      if (typeof this.video.getVideoPlaybackQuality === 'function') {
        const quality = this.video.getVideoPlaybackQuality();
        dropped = quality.droppedVideoFrames;
        if (this.lastQuality) {
          const frames = quality.totalVideoFrames - this.lastQuality.frames;
          const seconds = (now - this.lastQuality.at) / 1000;
          if (seconds >= 0.5 && frames >= 0) this.fps = frames / seconds;
        }
        this.lastQuality = { frames: quality.totalVideoFrames, at: now };
      }

      const buffered = this.video.buffered;
      const ahead = buffered.length ? buffered.end(buffered.length - 1) - this.video.currentTime : 0;

      return {
        state: this.state,
        codec: this.codec,
        width: this.video.videoWidth,
        height: this.video.videoHeight,
        fps: this.fps,
        bitrate,
        dropped,
        buffered: ahead,
        totalBytes: this.totalBytes,
        quality: this.quality,
        hasAudio: !!(this.codec && this.codec.indexOf('mp4a') !== -1),
        volume: this.video.muted ? 0 : this.video.volume,
      };
    }

    /** Grab the currently displayed frame as a JPEG blob. */
    captureFrame() {
      return new Promise((resolve) => {
        const width = this.video.videoWidth;
        const height = this.video.videoHeight;
        if (!width || !height) return resolve(null);
        try {
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          canvas.getContext('2d').drawImage(this.video, 0, 0, width, height);
          canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.92);
        } catch (err) {
          resolve(null);
        }
      });
    }

    status(state, message) {
      this.state = state;
      if (this.handlers.onStatus) this.handlers.onStatus(state, message, this.paused);
    }
  }

  window.LivePlayer = LivePlayer;
})();
