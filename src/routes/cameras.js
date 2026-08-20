'use strict';

const express = require('express');
const repo = require('../db/repo');
const cameraManager = require('../services/cameraManager');
const recorder = require('../services/recorder');
const snapshots = require('../services/snapshots');
const streamHub = require('../services/streamHub');
const library = require('../services/library');
const { createLogger } = require('../logger');

const log = createLogger('api:cameras');
const router = express.Router();

function decorate(camera) {
  const runtime = cameraManager.runtimeInfo()[camera.id];
  return Object.assign({}, camera, {
    connected: runtime ? runtime.connected : false,
    last_event_at: runtime ? runtime.last_event_at : null,
    active_recording: recorder.getActive(camera.id),
    live_viewers: streamHub
      .stats()
      .filter((s) => s.camera_id === camera.id)
      .reduce((sum, s) => sum + s.viewers, 0),
  });
}

router.get('/', (req, res) => {
  res.json({ cameras: repo.cameras.list().map(decorate) });
});

/** Try an ONVIF connection with ad-hoc credentials, without saving anything. */
router.post('/probe', async (req, res) => {
  try {
    const result = await cameraManager.probe(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  const body = req.body || {};
  if (!body.name || !body.host) return res.status(400).json({ error: 'Name and host are required' });
  const camera = repo.cameras.create(body);
  cameraManager.reload(camera.id);
  log.info(`camera ${camera.id} (${camera.name}) added`);
  res.status(201).json({ camera: decorate(camera) });
});

router.get('/:id', (req, res) => {
  const camera = repo.cameras.get(Number(req.params.id));
  if (!camera) return res.status(404).json({ error: 'Camera not found' });
  res.json({ camera: decorate(camera) });
});

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = repo.cameras.get(id);
  if (!existing) return res.status(404).json({ error: 'Camera not found' });
  const body = Object.assign({}, req.body);

  // Anything that changes how we reach the camera invalidates the cached URLs.
  const connectionChanged =
    (body.host !== undefined && body.host !== existing.host) ||
    (body.onvif_port !== undefined && Number(body.onvif_port) !== existing.onvif_port) ||
    (body.username !== undefined && body.username !== existing.username) ||
    (body.password !== undefined && body.password !== '') ||
    (body.live_profile_token !== undefined && body.live_profile_token !== existing.live_profile_token) ||
    (body.record_profile_token !== undefined && body.record_profile_token !== existing.record_profile_token);

  if (connectionChanged) {
    body.live_stream_url = null;
    body.record_stream_url = null;
    body.snapshot_url = null;
  }

  const camera = repo.cameras.update(id, body);
  cameraManager.reload(id);
  res.json({ camera: decorate(camera) });
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const camera = repo.cameras.get(id);
  if (!camera) return res.status(404).json({ error: 'Camera not found' });
  await recorder.stop(id, 'camera deleted').catch(() => null);
  cameraManager.stopRuntime(id);
  streamHub.stopCamera(id);
  repo.cameras.remove(id);
  library.purgeCamera(id);
  log.info(`camera ${id} (${camera.name}) deleted`);
  res.json({ ok: true });
});

/** Re-run ONVIF discovery for a stored camera. */
router.post('/:id/refresh', async (req, res) => {
  const id = Number(req.params.id);
  if (!repo.cameras.get(id)) return res.status(404).json({ error: 'Camera not found' });
  try {
    await cameraManager.getReadyCamera(id, { force: true });
    cameraManager.reload(id);
    res.json({ camera: decorate(repo.cameras.get(id)) });
  } catch (err) {
    repo.cameras.setStatus(id, 'offline', err.message);
    res.status(400).json({ error: err.message });
  }
});

/** Single JPEG frame, not stored – used for camera tiles and quick checks. */
router.get('/:id/snapshot', async (req, res) => {
  try {
    const camera = await cameraManager.getReadyCamera(Number(req.params.id));
    if (!camera) return res.status(404).json({ error: 'Camera not found' });
    const buffer = await snapshots.captureBuffer(camera);
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/** Capture a snapshot and keep it in the library. */
router.post('/:id/snapshot', async (req, res) => {
  try {
    const camera = await cameraManager.getReadyCamera(Number(req.params.id));
    if (!camera) return res.status(404).json({ error: 'Camera not found' });
    const snapshot = await snapshots.capture(camera, { source: 'manual' });
    res.status(201).json({ snapshot });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/:id/recording/start', async (req, res) => {
  try {
    const camera = await cameraManager.getReadyCamera(Number(req.params.id));
    if (!camera) return res.status(404).json({ error: 'Camera not found' });
    const recording = recorder.start(camera, { trigger: 'manual' });
    res.json({ recording, active: recorder.getActive(camera.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/recording/stop', async (req, res) => {
  const id = Number(req.params.id);
  if (!repo.cameras.get(id)) return res.status(404).json({ error: 'Camera not found' });
  const recording = await recorder.stop(id, 'stopped by user');
  if (!recording) return res.status(409).json({ error: 'This camera is not recording' });
  res.json({ recording, active: null });
});

router.get('/:id/status', (req, res) => {
  const camera = repo.cameras.get(Number(req.params.id));
  if (!camera) return res.status(404).json({ error: 'Camera not found' });
  res.json({
    camera: decorate(camera),
    streams: streamHub.stats().filter((s) => s.camera_id === camera.id),
  });
});

module.exports = router;
