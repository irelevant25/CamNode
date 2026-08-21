'use strict';

const path = require('path');
const fs = require('fs');

// Load a .env file next to package.json when running outside Docker. Real
// environment variables (what Portainer sets) always win over the file.
(function loadDotEnv() {
  const envFile = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envFile) || typeof process.loadEnvFile !== 'function') return;
  const before = Object.assign({}, process.env);
  try {
    process.loadEnvFile(envFile);
    for (const key of Object.keys(before)) {
      if (before[key] !== undefined) process.env[key] = before[key];
    }
  } catch (err) {
    console.warn(`could not read .env: ${err.message}`);
  }
})();

function env(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return fallback;
  return value;
}

function int(name, fallback) {
  const value = parseInt(env(name, ''), 10);
  return Number.isFinite(value) ? value : fallback;
}

const dataDir = path.resolve(env('DATA_DIR', path.join(__dirname, '..', 'data')));

const config = {
  port: int('PORT', 8080),
  host: env('HOST', '0.0.0.0'),
  dataDir,
  dbFile: path.join(dataDir, 'camera-recordings.sqlite'),
  recordingsDir: path.join(dataDir, 'recordings'),
  snapshotsDir: path.join(dataDir, 'snapshots'),
  thumbnailsDir: path.join(dataDir, 'thumbnails'),
  waveformsDir: path.join(dataDir, 'waveforms'),
  secret: env('APP_SECRET', 'insecure-development-secret-change-me'),
  admin: {
    username: env('ADMIN_USERNAME', 'admin'),
    password: env('ADMIN_PASSWORD', 'admin'),
    isDefaultPassword: !env('ADMIN_PASSWORD', ''),
  },
  sessionHours: int('SESSION_HOURS', 72),
  ffmpegPath: env('FFMPEG_PATH', 'ffmpeg'),
  ffprobePath: env('FFPROBE_PATH', 'ffprobe'),
  logLevel: env('LOG_LEVEL', 'info'),
  cookieName: 'cr_session',
  // Base URL the cameras use to POST event notifications back to us (push
  // mode). Leave empty to auto-detect the local address facing each camera –
  // that works on a LAN but not from a bridged Docker network, where you have
  // to point this at the host, e.g. http://192.168.4.102:8080
  publicUrl: env('PUBLIC_URL', ''),
  // live stream tuning
  live: {
    idleShutdownMs: int('LIVE_IDLE_SHUTDOWN_MS', 10000),
    watchdogMs: int('LIVE_WATCHDOG_MS', 20000),
    restartDelayMs: int('LIVE_RESTART_DELAY_MS', 2000),
  },
};

config.isDefaultSecret = config.secret === 'insecure-development-secret-change-me';

function ensureDirs() {
  for (const dir of [
    config.dataDir,
    config.recordingsDir,
    config.snapshotsDir,
    config.thumbnailsDir,
    config.waveformsDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = { config, ensureDirs };
