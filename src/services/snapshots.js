'use strict';

const fs = require('fs');
const repo = require('../db/repo');
const storage = require('./storage');
const { publish } = require('./bus');
const { createLogger } = require('../logger');
const { rtspInputArgs, spawnFfmpeg } = require('./ffmpeg');

const log = createLogger('snapshot');
const TIMEOUT_MS = 20000;

function grab(camera, outputArgs) {
  const url = camera.record_stream_url || camera.live_stream_url;
  if (!url) throw new Error('No RTSP URL known for this camera – run "Test / discover" first.');
  const args = rtspInputArgs(camera, url).concat(['-an', '-frames:v', '1', '-q:v', '2']).concat(outputArgs);

  return new Promise((resolve, reject) => {
    const proc = spawnFfmpeg(args);
    const chunks = [];
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch (err) {
        /* ignore */
      }
      reject(new Error('Timed out while grabbing a frame from the camera'));
    }, TIMEOUT_MS);

    proc.stdout.on('data', (chunk) => chunks.push(chunk));
    proc.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-1000);
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(Buffer.concat(chunks));
      reject(new Error(stderr.split(/\r?\n/).filter(Boolean).pop() || `ffmpeg exited with code ${code}`));
    });
  });
}

/** Live preview frame, returned as a JPEG buffer (not persisted). */
function captureBuffer(camera) {
  return grab(camera, ['-f', 'mjpeg', 'pipe:1']);
}

/** Capture and store a snapshot, returning the database row. */
async function capture(camera, options) {
  const opts = options || {};
  const target = storage.snapshotTarget(camera);
  await grab(camera, ['-y', target.absPath]);
  const size = storage.fileSize(target.absPath);
  if (!size) throw new Error('Snapshot file is empty');
  const snapshot = repo.snapshots.create({
    camera_id: camera.id,
    filename: target.filename,
    rel_path: target.relPath,
    size_bytes: size,
    source: opts.source || 'manual',
  });
  log.info(`camera ${camera.id}: snapshot saved -> ${target.relPath}`);
  publish('snapshot:created', { camera_id: camera.id, snapshot });
  return snapshot;
}

/** Store a JPEG produced by the browser (frame grab from the live player). */
function store(camera, buffer, options) {
  const opts = options || {};
  const target = storage.snapshotTarget(camera);
  fs.writeFileSync(target.absPath, buffer);
  const snapshot = repo.snapshots.create({
    camera_id: camera.id,
    filename: target.filename,
    rel_path: target.relPath,
    size_bytes: buffer.length,
    source: opts.source || 'live',
  });
  publish('snapshot:created', { camera_id: camera.id, snapshot });
  return snapshot;
}

module.exports = { capture, captureBuffer, store };
