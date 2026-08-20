'use strict';

const path = require('path');
const fs = require('fs');

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
  secret: env('APP_SECRET', 'insecure-development-secret-change-me'),
  admin: {
    username: env('ADMIN_USERNAME', 'admin'),
    password: env('ADMIN_PASSWORD', 'admin'),
  },
  sessionHours: int('SESSION_HOURS', 72),
  ffmpegPath: env('FFMPEG_PATH', 'ffmpeg'),
  ffprobePath: env('FFPROBE_PATH', 'ffprobe'),
  logLevel: env('LOG_LEVEL', 'info'),
  cookieName: 'cr_session',
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
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = { config, ensureDirs };
