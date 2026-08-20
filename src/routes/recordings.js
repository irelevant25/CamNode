'use strict';

const express = require('express');
const repo = require('../db/repo');
const storage = require('../services/storage');
const library = require('../services/library');
const { sendFile } = require('./media');

const router = express.Router();

function parseFilters(query) {
  return {
    cameraId: query.camera_id ? Number(query.camera_id) : null,
    trigger: query.trigger || null,
    status: query.status || null,
    from: query.from || null,
    to: query.to || null,
    limit: Math.min(parseInt(query.limit, 10) || 50, 500),
    offset: parseInt(query.offset, 10) || 0,
  };
}

router.get('/', (req, res) => {
  const filters = parseFilters(req.query);
  const result = repo.recordings.query(filters);
  res.json({
    recordings: result.rows,
    total: result.total,
    bytes: result.bytes,
    limit: filters.limit,
    offset: filters.offset,
  });
});

router.get('/:id', (req, res) => {
  const recording = repo.recordings.get(Number(req.params.id));
  if (!recording) return res.status(404).json({ error: 'Recording not found' });
  res.json({ recording });
});

router.get('/:id/stream', (req, res) => {
  const recording = repo.recordings.get(Number(req.params.id));
  if (!recording) return res.status(404).json({ error: 'Recording not found' });
  const absPath = storage.recordingPath(recording.rel_path);
  if (!absPath) return res.status(404).json({ error: 'Recording not found' });
  sendFile(req, res, absPath, { contentType: 'video/mp4', filename: recording.filename });
});

router.get('/:id/download', (req, res) => {
  const recording = repo.recordings.get(Number(req.params.id));
  if (!recording) return res.status(404).json({ error: 'Recording not found' });
  const absPath = storage.recordingPath(recording.rel_path);
  if (!absPath) return res.status(404).json({ error: 'Recording not found' });
  sendFile(req, res, absPath, {
    contentType: 'video/mp4',
    filename: recording.filename,
    download: true,
  });
});

router.get('/:id/thumbnail', (req, res) => {
  const recording = repo.recordings.get(Number(req.params.id));
  if (!recording || !recording.thumbnail_path) return res.status(404).end();
  const absPath = storage.thumbnailPath(recording.thumbnail_path);
  if (!absPath) return res.status(404).end();
  sendFile(req, res, absPath, { contentType: 'image/jpeg' });
});

/** Bulk delete – declared before /:id so "delete" is not read as an id. */
router.post('/delete', async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'No recordings selected' });
  const result = await library.deleteRecordings(ids, { stopFirst: !!(req.body && req.body.stop_active) });
  res.json(result);
});

router.delete('/:id', async (req, res) => {
  const result = await library.deleteRecording(Number(req.params.id), {
    stopFirst: req.query.stop === '1',
  });
  if (!result.ok) {
    const code = result.reason === 'not found' ? 404 : 409;
    return res.status(code).json({ error: result.reason });
  }
  res.json({ ok: true });
});

module.exports = router;
