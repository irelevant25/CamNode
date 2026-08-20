'use strict';
/* Exercises recorder.js against a stubbed ffmpeg so the whole
   start -> auto-stop -> finalise -> database path can be verified. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { EventEmitter, Writable } = require('stream');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-test-'));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET = 'test';
process.env.LOG_LEVEL = 'error';

/* --- stub child_process.spawn before anything requires it ---------------- */
const child = require('child_process');
const spawned = [];
child.spawn = function fakeSpawn(cmd, args) {
  const proc = new EventEmitter();
  proc.exitCode = null;
  proc.signalCode = null;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => {
    proc.exitCode = 137;
    proc.emit('close', 137);
  };
  proc.stdin = new Writable({
    write(chunk, enc, cb) {
      if (chunk.toString().indexOf('q') !== -1) {
        setTimeout(() => {
          proc.exitCode = 0;
          proc.emit('close', 0);
        }, 10);
      }
      cb();
    },
  });
  const output = args[args.length - 1];
  // Only the recording invocation carries -movflags; ffprobe/thumbnail runs
  // also end in a path, so match on the flag instead of the extension.
  const isRecording = args.indexOf('-movflags') !== -1 && /\.mp4$/.test(output);
  spawned.push({ cmd, args, output });
  if (isRecording) {
    fs.writeFileSync(output, Buffer.alloc(4096, 1)); // pretend ffmpeg wrote video
  } else {
    // ffprobe / thumbnail: exit immediately without producing anything usable
    setTimeout(() => {
      proc.exitCode = 1;
      proc.emit('close', 1);
    }, 5);
  }
  return proc;
};

const SRC = require('path').join(__dirname, '..', 'src') + '/';
const db = require(SRC + 'db/index');
const repo = require(SRC + 'db/repo');
const recorder = require(SRC + 'services/recorder');
const { bus } = require(SRC + 'services/bus');

const seenBusEvents = [];
bus.on('update', (update) => seenBusEvents.push(update.type));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  db.init();
  const camera = repo.cameras.create({
    name: 'Test Cam',
    host: '10.0.0.9',
    username: 'u',
    password: 'p',
    event_record_seconds: 2,
    max_record_seconds: 30,
  });
  const ready = Object.assign({}, camera, { record_stream_url: 'rtsp://u:p@10.0.0.9/stream1' });

  /* 1. an ONVIF event starts a recording that stops itself -------------- */
  const event = repo.events.create({
    camera_id: camera.id,
    topic: 'tns1:RuleEngine/CellMotionDetector/Motion',
    type: 'motion',
    label: 'Motion detected',
    state: true,
    received_at: new Date().toISOString(),
  });
  const started = recorder.start(ready, { trigger: 'event', eventId: event.id, stopAfterSeconds: 2 });
  assert.strictEqual(started.status, 'recording');
  assert.strictEqual(started.trigger_type, 'event');
  assert.strictEqual(repo.events.get(event.id).recording_id, started.id, 'event links to recording');
  assert.ok(recorder.getActive(camera.id), 'camera reports an active recording');
  assert.ok(/-c:v\s*$/.test('') || spawned[0].args.indexOf('copy') !== -1, 'stream is copied, not re-encoded');
  console.log('OK  ONVIF event starts a recording and links the event row');

  /* 2. repeated events extend the window instead of stacking files ------ */
  await sleep(700);
  const again = recorder.start(ready, { trigger: 'event', stopAfterSeconds: 2 });
  assert.strictEqual(again.id, started.id, 'second event reuses the running recording');
  const recordingSpawns = spawned.filter((s) => /\.mp4$/.test(s.output)).length;
  assert.strictEqual(recordingSpawns, 1, 'no second ffmpeg for the same camera');
  console.log('OK  a follow-up event extends the running recording');

  /* 3. the auto-stop timer finalises the row ---------------------------- */
  await sleep(2600);
  const finished = repo.recordings.get(started.id);
  assert.strictEqual(finished.status, 'completed', `status was ${finished.status} (${finished.error})`);
  assert.strictEqual(finished.size_bytes, 4096);
  assert.ok(finished.duration_seconds >= 2, `duration ${finished.duration_seconds}`);
  assert.ok(finished.ended_at, 'ended_at is set');
  assert.strictEqual(recorder.getActive(camera.id), null, 'no active recording left');
  assert.ok(fs.existsSync(path.join(dataDir, 'recordings', finished.rel_path)), 'file on disk');
  console.log('OK  auto-stop finalises the recording (status, size, duration, file)');

  /* 4. manual start/stop ------------------------------------------------ */
  const manual = recorder.start(ready, { trigger: 'manual' });
  assert.strictEqual(manual.trigger_type, 'manual');
  await sleep(300);
  const stopped = await recorder.stop(camera.id, 'stopped by user');
  assert.strictEqual(stopped.status, 'completed', 'manual recording completes on stop()');
  assert.strictEqual(recorder.getActive(camera.id), null);
  console.log('OK  manual start/stop returns the finalised recording');

  /* 5. a manual start on top of an event recording disables auto-stop --- */
  recorder.start(ready, { trigger: 'event', stopAfterSeconds: 1 });
  const promoted = recorder.start(ready, { trigger: 'manual' });
  assert.strictEqual(promoted.trigger_type, 'manual', 'event recording is promoted to manual');
  await sleep(1600);
  assert.ok(recorder.getActive(camera.id), 'still recording after the event window elapsed');
  await recorder.stopAll();
  assert.strictEqual(recorder.getActive(camera.id), null);
  console.log('OK  manual override keeps recording past the event window');

  /* 6. bus notifications ------------------------------------------------ */
  ['recording:started', 'recording:stopped', 'recording:state'].forEach((type) => {
    assert.ok(seenBusEvents.indexOf(type) !== -1, `bus published ${type}`);
  });
  console.log('OK  recording lifecycle is published to the UI bus');

  /* 7. deleting a recording removes its file ---------------------------- */
  const library = require(SRC + 'services/library');
  const absPath = path.join(dataDir, 'recordings', finished.rel_path);
  const result = await library.deleteRecording(finished.id);
  assert.ok(result.ok);
  assert.ok(!fs.existsSync(absPath), 'file removed from disk');
  assert.strictEqual(repo.recordings.get(finished.id), undefined, 'row removed');
  console.log('OK  deleting a recording removes both the row and the file');

  console.log('\nAll recorder tests passed.');
  process.exit(0);
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
