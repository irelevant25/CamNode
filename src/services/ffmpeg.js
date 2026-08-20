'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { config } = require('../config');
const { createLogger } = require('../logger');

const log = createLogger('ffmpeg');

const EXEC_EXTENSIONS = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch (err) {
    return false;
  }
}

/**
 * Find an ffmpeg/ffprobe binary.
 *
 * `spawn` only searches PATH, never the working directory, so a binary dropped
 * next to the app would otherwise fail with ENOENT. We therefore look in the
 * project folder and a ./bin folder as well, which is where people normally put
 * a downloaded build on Windows.
 */
function resolveBinary(name, configured) {
  const candidates = [];
  const projectRoot = path.join(__dirname, '..', '..');

  if (configured && /[\\/]/.test(configured)) {
    // An explicit path was given – trust it, but still fall through if missing.
    candidates.push(path.resolve(configured));
  }
  const bare = configured && !/[\\/]/.test(configured) ? configured : name;

  for (const dir of [projectRoot, path.join(projectRoot, 'bin'), path.join(config.dataDir, 'bin')]) {
    for (const ext of EXEC_EXTENSIONS) candidates.push(path.join(dir, bare + ext));
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of EXEC_EXTENSIONS) candidates.push(path.join(dir, bare + ext));
  }

  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  return bare; // let spawn try anyway so the error message stays familiar
}

const binaries = {
  ffmpeg: resolveBinary('ffmpeg', config.ffmpegPath),
  ffprobe: resolveBinary('ffprobe', config.ffprobePath),
};

const toolStatus = { ffmpeg: null, ffprobe: null };

/** Run `<binary> -version` once at startup so problems surface immediately. */
function checkTool(key) {
  return new Promise((resolve) => {
    const proc = spawn(binaries[key], ['-version'], { windowsHide: true });
    let out = '';
    proc.stdout.on('data', (chunk) => {
      out += chunk.toString();
    });
    proc.on('error', (err) => resolve({ ok: false, path: binaries[key], error: err.code || err.message }));
    proc.on('close', (code) => {
      const first = out.split(/\r?\n/)[0] || '';
      resolve({
        ok: code === 0,
        path: binaries[key],
        version: first.replace(/^ff(mpeg|probe) version /, '').split(' ')[0] || null,
        error: code === 0 ? null : `exited with code ${code}`,
      });
    });
  });
}

async function checkTools() {
  toolStatus.ffmpeg = await checkTool('ffmpeg');
  toolStatus.ffprobe = await checkTool('ffprobe');

  if (toolStatus.ffmpeg.ok) log.info(`using ffmpeg ${toolStatus.ffmpeg.version} (${toolStatus.ffmpeg.path})`);
  else {
    log.error(
      `ffmpeg is not usable (${toolStatus.ffmpeg.error}) – live view, recording and snapshots will fail. ` +
        'Install ffmpeg, put the binary next to the app or in ./bin, or set FFMPEG_PATH.'
    );
  }
  if (toolStatus.ffprobe.ok) log.debug(`using ffprobe ${toolStatus.ffprobe.version} (${toolStatus.ffprobe.path})`);
  else {
    log.warn(
      `ffprobe is not usable (${toolStatus.ffprobe.error}) – recording durations will be estimated from wall clock. ` +
        'It ships in the same archive as ffmpeg.'
    );
  }
  return toolStatus;
}

function getToolStatus() {
  return toolStatus;
}

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
  const proc = spawn(binaries.ffmpeg, args, Object.assign({ windowsHide: true }, options));
  proc.on('error', (err) => log.error(`failed to start ffmpeg (${binaries.ffmpeg}): ${err.message}`));
  return proc;
}

function spawnFfprobe(args) {
  return spawn(binaries.ffprobe, args, { windowsHide: true });
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

module.exports = {
  rtspInputArgs,
  spawnFfmpeg,
  spawnFfprobe,
  stopFfmpeg,
  probe,
  maskUrl,
  checkTools,
  getToolStatus,
  binaries,
};
