'use strict';

const express = require('express');
const timeline = require('../services/timeline');

const router = express.Router();

/** One day of recordings, events and per-hour totals for the timeline view. */
router.get('/', (req, res) => {
  const cameraId = req.query.camera_id ? Number(req.query.camera_id) : null;
  res.json(timeline.buildDay(cameraId, req.query.date));
});

/** Event counts per day, for the activity chart. */
router.get('/activity', (req, res) => {
  const cameraId = req.query.camera_id ? Number(req.query.camera_id) : null;
  res.json(timeline.activity(cameraId, parseInt(req.query.days, 10)));
});

module.exports = router;
