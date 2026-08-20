'use strict';

const { getSetting, getDb } = require('../db/index');
const repo = require('../db/repo');
const library = require('./library');
const { createLogger } = require('../logger');

const log = createLogger('retention');

const INTERVAL_MS = 30 * 60 * 1000;
let timer = null;

function num(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

async function runOnce() {
  try {
    await pruneByAge();
    await pruneBySize();
    pruneEvents();
  } catch (err) {
    log.error(`retention run failed: ${err.message}`);
  }
}

async function pruneByAge() {
  const days = num(getSetting('retention_days', '0'));
  if (!days) return;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const old = repo.recordings.olderThan(cutoff);
  if (!old.length) return;
  const result = await library.deleteRecordings(old.map((r) => r.id));
  log.info(`deleted ${result.deleted} recording(s) older than ${days} day(s)`);
}

async function pruneBySize() {
  const maxGb = num(getSetting('retention_max_gb', '0'));
  if (!maxGb) return;
  const limit = maxGb * 1024 * 1024 * 1024;
  let total = repo.recordings.totalBytes();
  if (total <= limit) return;
  const oldest = repo.recordings.oldestFirst();
  const doomed = [];
  for (const recording of oldest) {
    if (total <= limit) break;
    doomed.push(recording.id);
    total -= recording.size_bytes || 0;
  }
  if (!doomed.length) return;
  const result = await library.deleteRecordings(doomed);
  log.info(`deleted ${result.deleted} recording(s) to stay under ${maxGb} GB`);
}

function pruneEvents() {
  const days = num(getSetting('event_retention_days', '0'));
  if (!days) return;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const info = getDb()
    .prepare('DELETE FROM events WHERE received_at < ? AND (recording_id IS NULL OR recording_id NOT IN (SELECT id FROM recordings))')
    .run(cutoff);
  if (info.changes) log.info(`deleted ${info.changes} event(s) older than ${days} day(s)`);
}

function start() {
  if (timer) return;
  timer = setInterval(runOnce, INTERVAL_MS);
  if (timer.unref) timer.unref();
  setTimeout(runOnce, 30000).unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, runOnce };
