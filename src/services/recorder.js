'use strict';

const fs = require('fs');
const repo = require('../db/repo');
const storage = require('./storage');
const { publish } = require('./bus');
const { createLogger } = require('../logger');
const { rtspInputArgs, spawnFfmpeg, stopFfmpeg, probe, maskUrl } = require('./ffmpeg');

const log = createLogger('recorder');

/** cameraId -> active session */
const sessions = new Map();

const MAX_RESTARTS = 3;
const RESTART_DELAY_MS = 3000;

function buildArgs(camera, url, outputPath) {
  const args = rtspInputArgs(camera, url);
  args.push('-map', '0:v:0');
  if (camera.record_audio) {
    args.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', '64k');
  } else {
    args.push('-an');
  }
  args.push(
    '-c:v',
    'copy',
    // Fragmented output: the file stays playable even if the container is
    // killed mid-recording (no trailing moov required).
    '-movflags',
    '+frag_keyframe+empty_moov+default_base_moof',
    '-f',
    'mp4',
    '-y',
    outputPath
  );
  return args;
}

/**
 * Start recording a camera. If a recording is already running the existing one
 * is reused; a manual start on top of an event recording "promotes" it so the
 * automatic stop timer no longer applies.
 */
function start(camera, options) {
  const opts = options || {};
  const trigger = opts.trigger === 'event' ? 'event' : 'manual';
  const existing = sessions.get(camera.id);

  if (existing) {
    if (trigger === 'manual' && existing.trigger === 'event') {
      existing.trigger = 'manual';
      clearAutoStop(existing);
      repo.recordings.setTrigger(existing.recordingId, 'manual');
      publishState(camera.id);
    } else if (trigger === 'event') {
      if (opts.eventId) repo.events.linkRecording(opts.eventId, existing.recordingId);
      if (existing.trigger === 'event') scheduleAutoStop(existing, opts.stopAfterSeconds);
    }
    return repo.recordings.get(existing.recordingId);
  }

  const url = camera.record_stream_url || camera.live_stream_url;
  if (!url) throw new Error('No RTSP URL known for this camera – run "Test / discover" first.');

  const target = storage.recordingTarget(camera, trigger);
  const startedAt = new Date();
  const recording = repo.recordings.create({
    camera_id: camera.id,
    filename: target.filename,
    rel_path: target.relPath,
    trigger_type: trigger,
    started_at: startedAt.toISOString(),
    event_id: opts.eventId || null,
  });
  if (opts.eventId) repo.events.linkRecording(opts.eventId, recording.id);

  const session = {
    cameraId: camera.id,
    camera,
    recordingId: recording.id,
    trigger,
    absPath: target.absPath,
    relPath: target.relPath,
    startedAt,
    stopping: false,
    rotating: false,
    restarts: opts.restarts || 0,
    stopTimer: null,
    maxTimer: null,
    proc: null,
    stderr: '',
  };
  sessions.set(camera.id, session);

  const proc = spawnFfmpeg(buildArgs(camera, url, target.absPath));
  session.proc = proc;
  proc.stderr.on('data', (chunk) => {
    session.stderr = (session.stderr + chunk.toString()).slice(-4000);
  });
  proc.on('close', (code) => onProcessClosed(session, code));

  if (trigger === 'event') scheduleAutoStop(session, opts.stopAfterSeconds);
  scheduleRotation(session);

  log.info(`camera ${camera.id}: recording started (${trigger}) -> ${target.relPath}`);
  publish('recording:started', { camera_id: camera.id, recording: repo.recordings.get(recording.id) });
  publishState(camera.id);
  return recording;
}

function scheduleAutoStop(session, seconds) {
  clearAutoStop(session);
  const wait = Math.max(1, seconds || session.camera.event_record_seconds || 30) * 1000;
  session.stopTimer = setTimeout(() => {
    session.stopTimer = null;
    stop(session.cameraId, 'event window elapsed').catch((err) =>
      log.error(`auto stop failed: ${err.message}`)
    );
  }, wait);
  session.autoStopAt = new Date(Date.now() + wait).toISOString();
}

function clearAutoStop(session) {
  if (session.stopTimer) clearTimeout(session.stopTimer);
  session.stopTimer = null;
  session.autoStopAt = null;
}

/** Cap file length; roll over into a fresh file instead of stopping. */
function scheduleRotation(session) {
  const max = Math.max(30, session.camera.max_record_seconds || 900) * 1000;
  session.maxTimer = setTimeout(() => {
    session.maxTimer = null;
    rotate(session).catch((err) => log.error(`rotation failed: ${err.message}`));
  }, max);
}

async function rotate(session) {
  if (session.stopping) return;
  const camera = session.camera;
  const trigger = session.trigger;
  const remainingMs = session.autoStopAt ? new Date(session.autoStopAt).getTime() - Date.now() : 0;
  session.rotating = true;
  log.info(`camera ${camera.id}: rotating recording after max duration`);
  await stop(camera.id, 'maximum duration reached');
  if (trigger === 'event' && remainingMs <= 0) return;
  start(camera, {
    trigger,
    stopAfterSeconds: trigger === 'event' ? Math.ceil(remainingMs / 1000) : undefined,
  });
}

/** Stop the active recording for a camera and finalise its database row. */
async function stop(cameraId, reason) {
  const session = sessions.get(cameraId);
  if (!session) return null;
  if (session.stopping) return repo.recordings.get(session.recordingId);
  session.stopping = true;
  session.stopReason = reason || 'stopped';
  clearAutoStop(session);
  if (session.maxTimer) clearTimeout(session.maxTimer);
  session.maxTimer = null;
  await stopFfmpeg(session.proc);
  // `onProcessClosed` runs first on the same 'close' event, so the promise is
  // already there and we can report the finalised row to the caller.
  if (session.finalisePromise) return session.finalisePromise.catch(() => null);
  return repo.recordings.get(session.recordingId);
}

function onProcessClosed(session, code) {
  const wasStopping = session.stopping;
  if (sessions.get(session.cameraId) === session) sessions.delete(session.cameraId);
  if (session.maxTimer) clearTimeout(session.maxTimer);
  clearAutoStop(session);

  session.finalisePromise = finalise(session, code, wasStopping);
  session.finalisePromise
    .then((recording) => {
      publish('recording:stopped', { camera_id: session.cameraId, recording });
      publishState(session.cameraId);

      // Only resume when the stream had actually been working: an instant exit
      // without data means a permanent problem (bad credentials, wrong URL),
      // and retrying it would just pile up failed rows.
      const wasWorking = recording && recording.status === 'completed';
      if (!wasStopping && wasWorking && session.restarts < MAX_RESTARTS) {
        log.warn(
          `camera ${session.cameraId}: ffmpeg exited unexpectedly (code ${code}), restarting recording ` +
            `(${session.restarts + 1}/${MAX_RESTARTS})`
        );
        setTimeout(() => {
          if (sessions.has(session.cameraId)) return;
          try {
            start(session.camera, { trigger: session.trigger, restarts: session.restarts + 1 });
          } catch (err) {
            log.error(`restart failed: ${err.message}`);
          }
        }, RESTART_DELAY_MS);
      }
    })
    .catch((err) => log.error(`finalising recording failed: ${err.message}`));
}

async function finalise(session, code, wasStopping) {
  const endedAt = new Date();
  const exists = fs.existsSync(session.absPath);
  const size = exists ? storage.fileSize(session.absPath) : 0;
  let duration = (endedAt - session.startedAt) / 1000;
  let status = 'completed';
  let error = null;

  if (!exists || size < 1024) {
    status = 'failed';
    error = firstErrorLine(session.stderr) || `ffmpeg exited with code ${code} and wrote no data`;
    if (exists) storage.removeFile(session.absPath);
  } else {
    const info = await probe(session.absPath);
    const probed = info && info.format && parseFloat(info.format.duration);
    if (Number.isFinite(probed) && probed > 0) duration = probed;
    if (!wasStopping && code !== 0) error = firstErrorLine(session.stderr);
  }

  let thumbnailRel = null;
  if (status === 'completed') {
    thumbnailRel = await makeThumbnail(session.absPath, session.relPath);
  }

  return repo.recordings.finish(session.recordingId, {
    status,
    ended_at: endedAt.toISOString(),
    duration_seconds: Math.max(0, Math.round(duration * 100) / 100),
    size_bytes: size,
    thumbnail_path: thumbnailRel,
    error,
  });
}

function firstErrorLine(stderr) {
  if (!stderr) return null;
  const lines = stderr.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return null;
  return maskUrl(lines[lines.length - 1]).slice(0, 300);
}

function makeThumbnail(videoPath, relPath) {
  const target = storage.thumbnailTarget(relPath);
  const run = (seekArgs) =>
    new Promise((resolve) => {
      const proc = spawnFfmpeg(
        ['-hide_banner', '-loglevel', 'error']
          .concat(seekArgs)
          .concat(['-i', videoPath, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '5', '-y', target.absPath])
      );
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0 && storage.fileSize(target.absPath) > 0));
    });

  return run(['-ss', '1'])
    .then((ok) => (ok ? true : run([])))
    .then((ok) => (ok ? target.relPath : null))
    .catch(() => null);
}

function getActive(cameraId) {
  const session = sessions.get(cameraId);
  if (!session) return null;
  return {
    camera_id: cameraId,
    recording_id: session.recordingId,
    trigger: session.trigger,
    started_at: session.startedAt.toISOString(),
    auto_stop_at: session.autoStopAt || null,
    stopping: session.stopping,
  };
}

function listActive() {
  const out = {};
  for (const cameraId of sessions.keys()) out[cameraId] = getActive(cameraId);
  return out;
}

function publishState(cameraId) {
  publish('recording:state', { camera_id: cameraId, active: getActive(cameraId) });
}

async function stopAll() {
  const ids = Array.from(sessions.keys());
  await Promise.all(ids.map((id) => stop(id, 'server shutting down').catch(() => null)));
}

module.exports = { start, stop, getActive, listActive, stopAll };
