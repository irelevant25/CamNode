'use strict';

const { spawn } = require('child_process');
const { config } = require('../config');
const { createLogger } = require('../logger');

const log = createLogger('ffmpeg');

/** Common input arguments for pulling an RTSP stream. */
function rtspInputArgs(camera, url) {
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-rtsp_transport',
    camera && camera.rtsp_transport === 'udp' ? 'udp' : 'tcp',
    '-rtsp_flags',
    'prefer_tcp',
    '-fflags',
    '+genpts',
    '-avoid_negative_ts',
    'make_zero',
    '-i',
    url,
  ];
}

function spawnFfmpeg(args, options) {
  log.debug('ffmpeg', args.map(maskUrl).join(' '));
  const proc = spawn(config.ffmpegPath, args, Object.assign({ windowsHide: true }, options));
  proc.on('error', (err) => log.error(`failed to start ffmpeg (${config.ffmpegPath}): ${err.message}`));
  return proc;
}

function spawnFfprobe(args) {
  return spawn(config.ffprobePath, args, { windowsHide: true });
}

/** Hide rtsp credentials in log output. */
function maskUrl(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/(rtsp:\/\/)([^:/@]+):([^@]*)@/gi, '$1$2:****@');
}

/** Politely ask ffmpeg to finish (writes the moov atom), then kill if needed. */
function stopFfmpeg(proc, timeoutMs) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null || proc.signalCode) return resolve();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    proc.once('close', finish);
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch (err) {
        /* already gone */
      }
      finish();
    }, timeoutMs || 6000);
    try {
      proc.stdin.write('q');
      proc.stdin.end();
    } catch (err) {
      try {
        proc.kill('SIGTERM');
      } catch (err2) {
        /* ignore */
      }
    }
  });
}

/** Run ffprobe and return the parsed JSON output. */
function probe(file) {
  return new Promise((resolve) => {
    const proc = spawnFfprobe([
      '-v',
      'error',
      '-show_format',
      '-show_streams',
      '-of',
      'json',
      file,
    ]);
    let out = '';
    proc.stdout.on('data', (chunk) => {
      out += chunk.toString();
    });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      try {
        resolve(JSON.parse(out));
      } catch (err) {
        resolve(null);
      }
    });
  });
}

module.exports = { rtspInputArgs, spawnFfmpeg, spawnFfprobe, stopFfmpeg, probe, maskUrl };
