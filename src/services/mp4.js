'use strict';

const { Writable } = require('stream');

/**
 * Splits a raw fragmented-MP4 byte stream (as produced by
 * `ffmpeg -f mp4 -movflags +frag_keyframe+empty_moov+default_base_moof pipe:1`)
 * into two kinds of complete, self-contained chunks:
 *
 *   - "init"     : ftyp + moov            (must be appended first by MSE)
 *   - "fragment" : (styp) + moof + mdat   (one media fragment)
 *
 * Emitting whole chunks matters because a browser SourceBuffer can only be fed
 * complete boxes, while ffmpeg's stdout arrives in arbitrary sized pieces.
 */
class Mp4Splitter extends Writable {
  constructor(onChunk) {
    super();
    this.onChunk = onChunk;
    this.buffer = Buffer.alloc(0);
    this.initBoxes = [];
    this.pendingFragment = [];
    this.initSent = false;
  }

  _write(chunk, encoding, callback) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    try {
      this._drain();
    } catch (err) {
      return callback(err);
    }
    callback();
  }

  _drain() {
    for (;;) {
      if (this.buffer.length < 8) return;
      let size = this.buffer.readUInt32BE(0);
      const type = this.buffer.toString('ascii', 4, 8);
      let headerSize = 8;
      if (size === 1) {
        // 64-bit "largesize" box
        if (this.buffer.length < 16) return;
        const high = this.buffer.readUInt32BE(8);
        const low = this.buffer.readUInt32BE(12);
        size = high * 4294967296 + low;
        headerSize = 16;
      } else if (size === 0) {
        // box extends to end of stream – cannot happen mid-stream, bail out
        return;
      }
      if (size < headerSize) throw new Error(`invalid mp4 box size ${size} for type ${type}`);
      if (this.buffer.length < size) return;

      const box = this.buffer.subarray(0, size);
      this.buffer = this.buffer.subarray(size);
      this._handleBox(type, box);
    }
  }

  _handleBox(type, box) {
    if (!this.initSent) {
      if (type === 'ftyp' || type === 'moov') {
        this.initBoxes.push(box);
        if (type === 'moov') {
          this.initSent = true;
          this.onChunk('init', Buffer.concat(this.initBoxes));
          this.initBoxes = [];
        }
        return;
      }
      // Unexpected box before moov – ignore it.
      return;
    }

    if (type === 'moof' || type === 'styp' || type === 'sidx') {
      if (type === 'moof' && this.pendingFragment.length) {
        // previous fragment had no mdat (shouldn't happen) – flush it
        this.onChunk('fragment', Buffer.concat(this.pendingFragment));
        this.pendingFragment = [];
      }
      this.pendingFragment.push(box);
      return;
    }

    if (type === 'mdat') {
      this.pendingFragment.push(box);
      this.onChunk('fragment', Buffer.concat(this.pendingFragment));
      this.pendingFragment = [];
      return;
    }
    // mfra / free / anything else at the end of the stream: ignore
  }
}

module.exports = { Mp4Splitter };
