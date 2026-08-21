'use strict';

const fs = require('fs');
const storage = require('./storage');
const { createLogger } = require('../logger');
const { spawnFfmpeg, probe } = require('./ffmpeg');

const log = createLogger('waveform');

/** Buckets across the whole recording – enough detail for a wide bar. */
const BUCKETS = 600;
/** Decoded mono sample rate; low on purpose, we only need loudness. */
const SAMPLE_RATE = 4000;
/** Quietest level drawn; anything below counts as silence. */
const FLOOR_DB = -60;

/**
 * Loudness of a recording as `BUCKETS` values between 0 and 1, so the UI can
 * show at a glance where there was sound.
 *
 * Samples are folded into the buckets as they arrive – a long recording would
 * otherwise mean holding millions of samples in memory. RMS is converted to
 * dBFS because a linear amplitude bar makes ordinary speech look like silence.
 */
function analyse(videoPath, durationSeconds) {
  return new Promise((resolve) => {
    const expectedSamples = Math.max(1, Math.round((durationSeconds || 0) * SAMPLE_RATE));
    const perBucket = Math.max(1, expectedSamples / BUCKETS);

    const proc = spawnFfmpeg([
      '-v',
      'error',
      '-i',
      videoPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      String(SAMPLE_RATE),
      '-f',
      's16le',
      'pipe:1',
    ]);

    const sums = new Float64Array(BUCKETS);
    const counts = new Float64Array(BUCKETS);
    let leftover = null;
    let index = 0;
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      let buffer = chunk;
      if (leftover) {
        buffer = Buffer.concat([leftover, chunk]);
        leftover = null;
      }
      const usable = buffer.length - (buffer.length % 2);
      for (let i = 0; i < usable; i += 2) {
        const sample = buffer.readInt16LE(i);
        // Clamp rather than drop, so a longer-than-expected file still fits.
        const bucket = Math.min(BUCKETS - 1, Math.floor(index / perBucket));
        sums[bucket] += sample * sample;
        counts[bucket] += 1;
        index += 1;
      }
      if (usable !== buffer.length) leftover = buffer.subarray(usable);
    });

    proc.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-500);
    });
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => {
      if (code !== 0 || !index) {
        log.debug(`no audio in ${videoPath}${stderr ? ': ' + stderr.split(/\r?\n/)[0] : ''}`);
        return resolve(null);
      }
      const peaks = [];
      for (let i = 0; i < BUCKETS; i += 1) {
        if (!counts[i]) {
          peaks.push(0);
          continue;
        }
        const rms = Math.sqrt(sums[i] / counts[i]);
        if (rms <= 0) {
          peaks.push(0);
          continue;
        }
        const db = 20 * Math.log10(rms / 32768);
        const value = (db - FLOOR_DB) / -FLOOR_DB;
        peaks.push(Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000);
      }
      resolve({ peaks, buckets: BUCKETS, seconds: index / SAMPLE_RATE });
    });
  });
}

/** Cached on disk next to the thumbnails – analysing is not free. */
async function get(recording) {
  const videoPath = storage.recordingPath(recording.rel_path);
  if (!videoPath || !fs.existsSync(videoPath)) return null;

  const target = storage.waveformTarget(recording.rel_path);
  try {
    const cached = JSON.parse(fs.readFileSync(target.absPath, 'utf8'));
    return cached && Array.isArray(cached.peaks) ? cached : null;
  } catch (err) {
    /* not analysed yet */
  }

  let duration = Number(recording.duration_seconds);
  if (!Number.isFinite(duration) || duration <= 0) {
    const info = await probe(videoPath);
    duration = (info && info.format && parseFloat(info.format.duration)) || 0;
  }

  const result = await analyse(videoPath, duration);
  try {
    // Cache the "no audio" answer too, so we do not re-decode every time.
    fs.writeFileSync(target.absPath, JSON.stringify(result || { peaks: null }));
  } catch (err) {
    log.debug(`could not cache waveform: ${err.message}`);
  }
  return result;
}

module.exports = { get, analyse, BUCKETS };
