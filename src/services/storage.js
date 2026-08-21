'use strict';

const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const { createLogger } = require('../logger');

const log = createLogger('storage');

function pad(value) {
  return String(value).padStart(2, '0');
}

/** Local-time date folder, e.g. 2026-08-20 */
function dateFolder(date) {
  const d = date || new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local-time file stamp, e.g. 2026-08-20_18-42-07 */
function timeStamp(date) {
  const d = date || new Date();
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

function slug(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'camera';
}

/**
 * Build the on-disk target for a new recording.
 * rel_path is what we persist in the DB so the data directory stays movable.
 */
function recordingTarget(camera, trigger, date) {
  const when = date || new Date();
  const filename = `${timeStamp(when)}_${slug(camera.name)}_${trigger}.mp4`;
  const relPath = path.posix.join(String(camera.id), dateFolder(when), filename);
  const absPath = path.join(config.recordingsDir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  return { filename, relPath, absPath };
}

function thumbnailTarget(relPath) {
  const rel = relPath.replace(/\.mp4$/i, '.jpg');
  const absPath = path.join(config.thumbnailsDir, rel);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  return { relPath: rel, absPath };
}

function waveformTarget(relPath) {
  const rel = relPath.replace(/\.mp4$/i, '.json');
  const absPath = path.join(config.waveformsDir, rel);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  return { relPath: rel, absPath };
}

function snapshotTarget(camera, date) {
  const when = date || new Date();
  const filename = `${timeStamp(when)}_${slug(camera.name)}.jpg`;
  const relPath = path.posix.join(String(camera.id), dateFolder(when), filename);
  const absPath = path.join(config.snapshotsDir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  return { filename, relPath, absPath };
}

/** Resolve a stored rel_path against a base directory, refusing traversal. */
function resolveWithin(baseDir, relPath) {
  if (!relPath) return null;
  const abs = path.resolve(baseDir, relPath);
  const base = path.resolve(baseDir);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

function recordingPath(relPath) {
  return resolveWithin(config.recordingsDir, relPath);
}

function thumbnailPath(relPath) {
  return resolveWithin(config.thumbnailsDir, relPath);
}

function waveformPath(relPath) {
  return resolveWithin(config.waveformsDir, relPath);
}

function snapshotPath(relPath) {
  return resolveWithin(config.snapshotsDir, relPath);
}

function fileSize(absPath) {
  try {
    return fs.statSync(absPath).size;
  } catch (err) {
    return 0;
  }
}

function removeFile(absPath) {
  if (!absPath) return false;
  try {
    fs.unlinkSync(absPath);
    pruneEmptyDirs(path.dirname(absPath));
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`could not delete ${absPath}: ${err.message}`);
    return false;
  }
}

/** Remove now-empty date/camera folders, but never the configured roots. */
function pruneEmptyDirs(dir) {
  const roots = [config.recordingsDir, config.snapshotsDir, config.thumbnailsDir, config.waveformsDir].map((d) =>
    path.resolve(d)
  );
  let current = path.resolve(dir);
  for (let i = 0; i < 3; i += 1) {
    if (roots.indexOf(current) !== -1) return;
    try {
      if (fs.readdirSync(current).length > 0) return;
      fs.rmdirSync(current);
    } catch (err) {
      return;
    }
    current = path.dirname(current);
  }
}

/** Recursively delete everything belonging to a camera (after deletion). */
function removeCameraFiles(cameraId) {
  for (const base of [config.recordingsDir, config.snapshotsDir, config.thumbnailsDir, config.waveformsDir]) {
    const dir = path.join(base, String(cameraId));
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      log.warn(`could not remove ${dir}: ${err.message}`);
    }
  }
}

function directorySize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else total += fileSize(full);
    }
  }
  return total;
}

module.exports = {
  dateFolder,
  timeStamp,
  recordingTarget,
  thumbnailTarget,
  waveformTarget,
  snapshotTarget,
  recordingPath,
  thumbnailPath,
  waveformPath,
  snapshotPath,
  fileSize,
  removeFile,
  removeCameraFiles,
  directorySize,
};
