'use strict';
/* Bugs that were fixed once and should stay fixed. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-regress-'));
process.env.APP_SECRET = 'test';
process.env.LOG_LEVEL = 'error';
process.env.TZ = 'Europe/Bratislava';

const SRC = path.join(__dirname, '..', 'src') + '/';
const db = require(SRC + 'db/index');
const repo = require(SRC + 'db/repo');
const storage = require(SRC + 'services/storage');
const auth = require(SRC + 'middleware/auth');

db.init();
const handle = db.getDb();
const camera = repo.cameras.create({ name: 'Yard', host: '10.0.0.4' });

/* ------------------------------------------- "now" in the stored format */

// A recording still in progress has no ended_at, so the query compares against
// SQLite's idea of "now". With datetime('now') that is "YYYY-MM-DD HH:MM:SS",
// which sorts below an ISO string of the same date – the recording vanished
// from a range starting earlier the same UTC day.
const started = new Date(Date.now() - 60000);
const active = repo.recordings.create({
  camera_id: camera.id,
  filename: 'a.mp4',
  rel_path: `${camera.id}/a.mp4`,
  trigger_type: 'manual',
  started_at: started.toISOString(),
});
const from = new Date(started.getTime() - 1000).toISOString();
const to = new Date(Date.now() + 3600000).toISOString();
const found = repo.recordings.inRange(camera.id, from, to);
assert.deepStrictEqual(found.map((r) => r.id), [active.id], 'an active recording is inside a range that contains now');
console.log('OK  an active recording shows up in a range starting the same UTC day');

// Interrupted recordings get their end stamped by SQLite; it has to parse as UTC.
db.init();
const recovered = repo.recordings.get(active.id);
assert.strictEqual(recovered.status, 'interrupted');
assert.ok(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(recovered.ended_at), `ISO end time, got ${recovered.ended_at}`);
assert.ok(Math.abs(new Date(recovered.ended_at).getTime() - Date.now()) < 5000, 'and it means now, not now ± the UTC offset');
console.log('OK  recovered recordings end at an ISO timestamp');

// A maintenance tool opening the database must leave live recordings alone.
handle.prepare("UPDATE recordings SET status='recording', ended_at=NULL WHERE id=?").run(active.id);
db.init({ recover: false });
assert.strictEqual(repo.recordings.get(active.id).status, 'recording');
console.log('OK  init({ recover: false }) does not touch recordings in progress');

/* ------------------------------------------------------ unique filenames */

const when = new Date(2026, 4, 10, 12, 0, 0);
const first = storage.recordingTarget(camera, 'manual', when);
fs.writeFileSync(first.absPath, 'x');
const second = storage.recordingTarget(camera, 'manual', when);
assert.notStrictEqual(second.absPath, first.absPath, 'same second, different file');
assert.ok(/-2\.mp4$/.test(second.filename));
console.log('OK  two recordings started in the same second get different files');

/* ------------------------------------------- sessions die with a password */

const user = repo.users.findByUsername('admin');
const token = auth.createToken(user);
function check(value) {
  let status = 200;
  const req = { cookies: { cr_session: value }, headers: {} };
  const res = { status: (code) => ((status = code), res), json: () => res };
  auth.requireAuth(req, res, () => {});
  return status;
}
assert.strictEqual(check(token), 200);
repo.users.updatePassword(user.id, require('bcryptjs').hashSync('another-password', 4));
assert.strictEqual(check(token), 401, 'the old session stops working');
assert.strictEqual(check(auth.createToken(repo.users.findByUsername('admin'))), 200);
console.log('OK  changing the password invalidates existing sessions');

console.log('\nAll regression tests passed.');
