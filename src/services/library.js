'use strict';

const repo = require('../db/repo');
const storage = require('./storage');
const recorder = require('./recorder');
const { publish } = require('./bus');
const { createLogger } = require('../logger');

const log = createLogger('library');

/** Delete a recording: file, thumbnail and row. Refuses while still recording. */
async function deleteRecording(id, options) {
  const opts = options || {};
  const recording = repo.recordings.get(id);
  if (!recording) return { ok: false, reason: 'not found' };
  if (recording.status === 'recording') {
    if (!opts.stopFirst) return { ok: false, reason: 'recording in progress' };
    await recorder.stop(recording.camera_id, 'deleted by user');
  }
  storage.removeFile(storage.recordingPath(recording.rel_path));
  if (recording.thumbnail_path) storage.removeFile(storage.thumbnailPath(recording.thumbnail_path));
  storage.removeFile(storage.waveformTarget(recording.rel_path).absPath);
  repo.recordings.remove(id);
  publish('recording:deleted', { camera_id: recording.camera_id, recording_id: id });
  return { ok: true, recording };
}

async function deleteRecordings(ids, options) {
  let deleted = 0;
  const failed = [];
  for (const id of ids) {
    /* eslint-disable no-await-in-loop */
    const result = await deleteRecording(id, options);
    if (result.ok) deleted += 1;
    else failed.push({ id, reason: result.reason });
  }
  return { deleted, failed };
}

function deleteSnapshot(id) {
  const snapshot = repo.snapshots.get(id);
  if (!snapshot) return false;
  storage.removeFile(storage.snapshotPath(snapshot.rel_path));
  repo.snapshots.remove(id);
  publish('snapshot:deleted', { camera_id: snapshot.camera_id, snapshot_id: id });
  return true;
}

/** Everything a camera owns – called before the camera row itself is removed. */
function purgeCamera(cameraId) {
  storage.removeCameraFiles(cameraId);
  log.info(`purged stored media of camera ${cameraId}`);
}

module.exports = { deleteRecording, deleteRecordings, deleteSnapshot, purgeCamera };
