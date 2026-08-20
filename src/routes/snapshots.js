'use strict';

const express = require('express');
const repo = require('../db/repo');
const storage = require('../services/storage');
const library = require('../services/library');
const cameraManager = require('../services/cameraManager');
const snapshots = require('../services/snapshots');
const { sendFile } = require('./media');

const router = express.Router();

router.get('/', (req, res) => {
  const filters = {
    cameraId: req.query.camera_id ? Number(req.query.camera_id) : null,
    limit: Math.min(parseInt(req.query.limit, 10) || 60, 500),
    offset: parseInt(req.query.offset, 10) || 0,
  };
  const result = repo.snapshots.query(filters);
  res.json({ snapshots: result.rows, total: result.total, limit: filters.limit, offset: filters.offset });
});

/** Store a frame grabbed in the browser (keeps the exact picture the user saw). */
router.post('/', express.raw({ type: 'image/jpeg', limit: '12mb' }), async (req, res) => {
  const cameraId = Number(req.query.camera_id);
  const camera = repo.cameras.get(cameraId);
  if (!camera) return res.status(404).json({ error: 'Camera not found' });
  try {
    if (req.body && req.body.length > 1000) {
      const snapshot = snapshots.store(camera, req.body, { source: 'live' });
      return res.status(201).json({ snapshot });
    }
    // No usable frame from the browser – fall back to a server side grab.
    const ready = await cameraManager.getReadyCamera(cameraId);
    const snapshot = await snapshots.capture(ready, { source: 'manual' });
    res.status(201).json({ snapshot });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/delete', (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'No snapshots selected' });
  let deleted = 0;
  for (const id of ids) if (library.deleteSnapshot(id)) deleted += 1;
  res.json({ deleted });
});

router.get('/:id/file', (req, res) => {
  const snapshot = repo.snapshots.get(Number(req.params.id));
  if (!snapshot) return res.status(404).json({ error: 'Snapshot not found' });
  const absPath = storage.snapshotPath(snapshot.rel_path);
  if (!absPath) return res.status(404).json({ error: 'Snapshot not found' });
  sendFile(req, res, absPath, {
    contentType: 'image/jpeg',
    filename: snapshot.filename,
    download: req.query.download === '1',
  });
});

router.delete('/:id', (req, res) => {
  if (!library.deleteSnapshot(Number(req.params.id))) {
    return res.status(404).json({ error: 'Snapshot not found' });
  }
  res.json({ ok: true });
});

module.exports = router;
