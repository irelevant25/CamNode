'use strict';

const fs = require('fs');
const express = require('express');
const { config } = require('../config');
const { getDb, allSettings, getSetting, setSetting } = require('../db/index');
const cameraManager = require('../services/cameraManager');
const repo = require('../db/repo');
const storage = require('../services/storage');
const streamHub = require('../services/streamHub');
const recorder = require('../services/recorder');
const retention = require('../services/retention');

const router = express.Router();

const NUMERIC_SETTINGS = ['retention_days', 'retention_max_gb', 'event_retention_days'];

/** Directory scans are not free, so keep the result around for a minute. */
let diskCache = { at: 0, value: null };

function diskUsage() {
  if (Date.now() - diskCache.at < 60000 && diskCache.value) return diskCache.value;
  const value = {
    recordings_bytes: storage.directorySize(config.recordingsDir),
    snapshots_bytes: storage.directorySize(config.snapshotsDir),
    thumbnails_bytes: storage.directorySize(config.thumbnailsDir),
    free_bytes: null,
    total_bytes: null,
  };
  try {
    if (typeof fs.statfsSync === 'function') {
      const stats = fs.statfsSync(config.dataDir);
      value.free_bytes = stats.bavail * stats.bsize;
      value.total_bytes = stats.blocks * stats.bsize;
    }
  } catch (err) {
    /* not available on this platform */
  }
  diskCache = { at: Date.now(), value };
  return value;
}

router.get('/stats', (req, res) => {
  const db = getDb();
  const counts = {
    cameras: db.prepare('SELECT COUNT(*) AS c FROM cameras').get().c,
    cameras_online: db.prepare("SELECT COUNT(*) AS c FROM cameras WHERE status = 'online'").get().c,
    events: db.prepare('SELECT COUNT(*) AS c FROM events').get().c,
    events_today: db
      .prepare("SELECT COUNT(*) AS c FROM events WHERE received_at >= datetime('now', '-1 day')")
      .get().c,
    recordings: db.prepare('SELECT COUNT(*) AS c FROM recordings').get().c,
    snapshots: db.prepare('SELECT COUNT(*) AS c FROM snapshots').get().c,
  };
  res.json({
    counts,
    disk: diskUsage(),
    recording_bytes: repo.recordings.totalBytes(),
    snapshot_bytes: repo.snapshots.totalBytes(),
    active_recordings: recorder.listActive(),
    live_streams: streamHub.stats(),
    data_dir: config.dataDir,
    tools: require('../services/ffmpeg').getToolStatus(),
    uptime_seconds: Math.round(process.uptime()),
    version: require('../../package.json').version,
  });
});

router.get('/settings', (req, res) => {
  res.json({
    settings: allSettings(),
    // What the cameras are actually told, once the env variable and the
    // auto-detected address are taken into account.
    effective_public_url: cameraManager.effectivePublicUrl(),
    public_url_source: cameraManager.publicUrlSource(),
  });
});

router.put('/settings', (req, res) => {
  const body = req.body || {};
  for (const key of NUMERIC_SETTINGS) {
    if (body[key] !== undefined) {
      const value = Math.max(0, parseFloat(body[key]) || 0);
      setSetting(key, value);
    }
  }

  // The address cameras post their events back to. Settable here so a wrong
  // one can be corrected without redeploying the container.
  if (body.public_url !== undefined) {
    const raw = String(body.public_url || '').trim().replace(/\/+$/, '');
    if (raw) {
      let parsed;
      try {
        parsed = new URL(raw);
      } catch (err) {
        return res.status(400).json({ error: 'Callback address must be a URL, e.g. http://192.168.1.10:8080' });
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return res.status(400).json({ error: 'Callback address must start with http:// or https://' });
      }
    }
    const changed = getSetting('public_url', '') !== raw;
    setSetting('public_url', raw);
    // Push subscriptions carry the old address until the cameras are told again.
    if (changed) cameraManager.reloadAll();
  }

  res.json({ settings: allSettings(), effective_public_url: cameraManager.effectivePublicUrl() });
});

router.post('/retention/run', async (req, res) => {
  await retention.runOnce();
  res.json({ ok: true });
});

module.exports = router;
