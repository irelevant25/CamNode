'use strict';

const express = require('express');
const repo = require('../db/repo');
const storage = require('../services/storage');
const library = require('../services/library');
const waveform = require('../services/waveform');
const { spawnFfmpeg } = require('../services/ffmpeg');
const { createLogger } = require('../logger');
const { sendFile } = require('./media');

const log = createLogger('api:recordings');
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

/**
 * Export part of a recording. Streams a re-muxed copy, so it is quick and
 * lossless; cuts land on the nearest keyframe before `start`, which is what
 * `-c copy` can do without re-encoding.
 */
router.get('/:id/clip', (req, res) => {
  const recording = repo.recordings.get(Number(req.params.id));
  if (!recording) return res.status(404).json({ error: 'Recording not found' });
  const absPath = storage.recordingPath(recording.rel_path);
  if (!absPath) return res.status(404).json({ error: 'Recording not found' });

  const total = Number(recording.duration_seconds) || 0;
  let start = Math.max(0, parseFloat(req.query.start) || 0);
  let end = parseFloat(req.query.end);
  if (!Number.isFinite(end) || end <= start) end = total || start + 30;
  if (total) {
    start = Math.min(start, Math.max(0, total - 1));
    end = Math.min(end, total);
  }
  const seconds = Math.max(1, end - start);

  const name = recording.filename.replace(/\.mp4$/i, '') + `_clip_${Math.round(start)}-${Math.round(end)}s.mp4`;
  res.set('Content-Type', 'video/mp4');
  res.set('Content-Disposition', `attachment; filename="${name.replace(/["\\\r\n]/g, '_')}"`);

  const proc = spawnFfmpeg([
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(start),
    '-i',
    absPath,
    '-t',
    String(seconds),
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-c',
    'copy',
    // Fragmented, because the length is not known until the pipe ends.
    '-movflags',
    '+frag_keyframe+empty_moov+default_base_moof',
    '-f',
    'mp4',
    'pipe:1',
  ]);

  let failed = '';
  proc.stderr.on('data', (chunk) => {
    failed = (failed + chunk.toString()).slice(-300);
  });
  proc.on('error', () => {
    if (!res.headersSent) res.status(500).json({ error: 'Could not start ffmpeg' });
    else res.end();
  });
  proc.on('close', (code) => {
    if (code !== 0) log.warn(`clip export failed for recording ${recording.id}: ${failed.split(/\r?\n/)[0] || code}`);
    res.end();
  });
  res.on('close', () => {
    if (proc.exitCode === null) proc.kill('SIGKILL');
  });
  proc.stdout.pipe(res);
});

/** Sound intensity over the recording, so the UI can show where audio happens. */
router.get('/:id/waveform', async (req, res) => {
  const recording = repo.recordings.get(Number(req.params.id));
  if (!recording) return res.status(404).json({ error: 'Recording not found' });
  try {
    const result = await waveform.get(recording);
    res.set('Cache-Control', 'private, max-age=3600');
    res.json(result || { peaks: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
