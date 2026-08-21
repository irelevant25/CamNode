'use strict';
/* Timeline day layout: range selection, hour bucketing and the activity series. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-timeline-'));
process.env.APP_SECRET = 'test';
process.env.LOG_LEVEL = 'error';
process.env.TZ = 'Europe/Bratislava';

const SRC = path.join(__dirname, '..', 'src') + '/';
const db = require(SRC + 'db/index');
const repo = require(SRC + 'db/repo');
const timeline = require(SRC + 'services/timeline');

db.init();
const handle = db.getDb();

const camera = repo.cameras.create({ name: 'Yard', host: '10.0.0.4' });
const other = repo.cameras.create({ name: 'Gate', host: '10.0.0.5' });

/** Local time on the test day -> ISO, so expectations do not depend on the box. */
function at(hour, minute, second) {
  return new Date(2026, 4, 10, hour, minute || 0, second || 0).toISOString();
}

/* Events: two inside the day, one just before midnight the day before. */
repo.events.create({ camera_id: camera.id, topic: 'a', type: 'motion', state: true, received_at: at(9, 15) });
repo.events.create({ camera_id: camera.id, topic: 'b', type: 'person', state: true, received_at: at(9, 45) });
repo.events.create({ camera_id: camera.id, topic: 'c', type: 'motion', state: true, received_at: at(21, 5) });
repo.events.create({
  camera_id: camera.id,
  topic: 'd',
  type: 'motion',
  state: true,
  received_at: new Date(2026, 4, 9, 23, 59).toISOString(),
});
repo.events.create({ camera_id: other.id, topic: 'e', type: 'motion', state: true, received_at: at(9, 30) });

/* A recording that straddles two hours, and one on the previous day. */
function addRecording(cameraId, startIso, endIso, seconds) {
  const row = repo.recordings.create({
    camera_id: cameraId,
    filename: 'x.mp4',
    rel_path: `${cameraId}/x-${startIso}.mp4`,
    trigger_type: 'event',
    started_at: startIso,
  });
  handle
    .prepare("UPDATE recordings SET status='completed', ended_at=?, duration_seconds=? WHERE id=?")
    .run(endIso, seconds, row.id);
  return row.id;
}

const spanning = addRecording(camera.id, at(10, 45), at(11, 15), 1800);
addRecording(camera.id, new Date(2026, 4, 9, 8, 0).toISOString(), new Date(2026, 4, 9, 8, 10).toISOString(), 600);
addRecording(other.id, at(10, 0), at(10, 5), 300);

/* ------------------------------------------------------------- the day */

const day = timeline.buildDay(camera.id, '2026-05-10');
assert.strictEqual(day.date, '2026-05-10');
assert.strictEqual(day.totals.events, 3, 'only that camera, only that day');
assert.strictEqual(day.totals.recordings, 1, 'the previous day and the other camera are excluded');
assert.strictEqual(day.recordings[0].id, spanning);
console.log('OK  a day contains only that camera and that local day');

assert.strictEqual(day.hours.length, 24);
assert.strictEqual(day.hours[9].events, 2, 'both 09:xx events land in hour 9');
assert.strictEqual(day.hours[21].events, 1);
assert.strictEqual(day.hours[10].events, 0);
console.log('OK  events fall into the right hour');

// 10:45 -> 11:15 is 900 s in hour 10 and 900 s in hour 11.
assert.strictEqual(day.hours[10].recorded_seconds, 900);
assert.strictEqual(day.hours[11].recorded_seconds, 900);
assert.strictEqual(day.hours[12].recorded_seconds, 0);
assert.strictEqual(day.totals.recorded_seconds, 1800);
console.log('OK  a recording spanning two hours is split across them');

/* Day boundaries are local, not UTC: the range must cover local midnight. */
const range = timeline.dayRange('2026-05-10');
assert.strictEqual(range.start.getHours(), 0);
assert.strictEqual(range.end.getTime() - range.start.getTime(), 86400000);
assert.strictEqual(timeline.dayKey(range.start), '2026-05-10');
console.log('OK  day boundaries follow local time');

/* All cameras together. */
const allCameras = timeline.buildDay(null, '2026-05-10');
assert.strictEqual(allCameras.totals.events, 4);
assert.strictEqual(allCameras.totals.recordings, 2);
console.log('OK  "all cameras" merges every camera');

/* An empty day answers with a full, zeroed structure rather than nothing. */
const quiet = timeline.buildDay(camera.id, '2026-05-11');
assert.strictEqual(quiet.totals.events, 0);
assert.strictEqual(quiet.hours.length, 24);
assert.ok(quiet.hours.every((h) => h.events === 0 && h.recorded_seconds === 0));
console.log('OK  a day with nothing on it still returns 24 empty hours');

/* --------------------------------------------------------- activity */

repo.events.create({
  camera_id: camera.id,
  topic: 'today',
  type: 'motion',
  state: true,
  received_at: new Date().toISOString(),
});
const activity = timeline.activity(camera.id, 7);
assert.strictEqual(activity.series.length, 7, 'zero filled, one entry per day');
assert.strictEqual(activity.series[activity.series.length - 1].count, 1, 'today counted');
assert.ok(activity.series.every((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry.day)));
assert.strictEqual(timeline.activity(camera.id, 500).days, 90, 'range is capped');
console.log('OK  activity series is zero filled and capped');

console.log('\nAll timeline tests passed.');
