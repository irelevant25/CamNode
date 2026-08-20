'use strict';

const express = require('express');
const repo = require('../db/repo');

const router = express.Router();

router.get('/', (req, res) => {
  const filters = {
    cameraId: req.query.camera_id ? Number(req.query.camera_id) : null,
    type: req.query.type || null,
    from: req.query.from || null,
    to: req.query.to || null,
    onlyStarts: req.query.only_starts === '1',
    limit: Math.min(parseInt(req.query.limit, 10) || 100, 1000),
    offset: parseInt(req.query.offset, 10) || 0,
  };
  const result = repo.events.query(filters);
  res.json({
    events: result.rows,
    total: result.total,
    limit: filters.limit,
    offset: filters.offset,
  });
});

router.get('/types', (req, res) => {
  res.json({ types: repo.events.types() });
});

router.post('/delete', (req, res) => {
  const body = req.body || {};
  if (body.all) {
    const deleted = repo.events.removeAll(body.camera_id ? Number(body.camera_id) : null);
    return res.json({ deleted });
  }
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: 'No events selected' });
  res.json({ deleted: repo.events.removeMany(ids) });
});

router.get('/:id', (req, res) => {
  const event = repo.events.get(Number(req.params.id));
  if (!event) return res.status(404).json({ error: 'Event not found' });
  res.json({ event });
});

router.delete('/:id', (req, res) => {
  if (!repo.events.remove(Number(req.params.id))) {
    return res.status(404).json({ error: 'Event not found' });
  }
  res.json({ ok: true });
});

module.exports = router;
