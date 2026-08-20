'use strict';

const { getDb } = require('./index');
const { encrypt, decrypt } = require('./crypto');

/* ------------------------------------------------------------------ users */

const users = {
  findByUsername(username) {
    return getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
  },
  findById(id) {
    return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
  },
  updatePassword(id, hash) {
    getDb()
      .prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
      .run(hash, id);
  },
};

/* ---------------------------------------------------------------- cameras */

const CAMERA_FIELDS = [
  'name',
  'host',
  'onvif_port',
  'username',
  'password_enc',
  'enabled',
  'rtsp_transport',
  'live_profile_token',
  'record_profile_token',
  'live_stream_url',
  'record_stream_url',
  'snapshot_url',
  'profiles_json',
  'record_on_event',
  'event_mode',
  'notify_token',
  'event_record_seconds',
  'max_record_seconds',
  'record_audio',
];

function mapCamera(row) {
  if (!row) return null;
  const camera = Object.assign({}, row);
  camera.enabled = !!row.enabled;
  camera.record_on_event = !!row.record_on_event;
  camera.record_audio = !!row.record_audio;
  camera.profiles = row.profiles_json ? safeJson(row.profiles_json, []) : [];
  camera.has_password = !!row.password_enc;
  delete camera.profiles_json;
  // Neither the encrypted password nor the notification token leaves the server.
  delete camera.password_enc;
  delete camera.notify_token;
  return camera;
}

function safeJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch (err) {
    return fallback;
  }
}

const cameras = {
  list() {
    return getDb().prepare('SELECT * FROM cameras ORDER BY name COLLATE NOCASE').all().map(mapCamera);
  },
  get(id) {
    return mapCamera(getDb().prepare('SELECT * FROM cameras WHERE id = ?').get(id));
  },
  /** Row including the decrypted password – never send this to the browser. */
  getWithSecret(id) {
    const row = getDb().prepare('SELECT * FROM cameras WHERE id = ?').get(id);
    if (!row) return null;
    const camera = mapCamera(row);
    camera.password = decrypt(row.password_enc);
    camera.notify_token = row.notify_token;
    return camera;
  },

  /** Secret used in the push-notification URL the camera posts events to. */
  ensureNotifyToken(id) {
    const row = getDb().prepare('SELECT notify_token FROM cameras WHERE id = ?').get(id);
    if (!row) return null;
    if (row.notify_token) return row.notify_token;
    const token = require('crypto').randomBytes(16).toString('hex');
    getDb().prepare('UPDATE cameras SET notify_token = ? WHERE id = ?').run(token, id);
    return token;
  },

  findByNotifyToken(token) {
    const row = getDb().prepare('SELECT * FROM cameras WHERE notify_token = ?').get(token);
    if (!row) return null;
    const camera = mapCamera(row);
    camera.password = decrypt(row.password_enc);
    camera.notify_token = row.notify_token;
    return camera;
  },
  listWithSecret() {
    return getDb()
      .prepare('SELECT * FROM cameras ORDER BY id')
      .all()
      .map((row) => {
        const camera = mapCamera(row);
        camera.password = decrypt(row.password_enc);
        camera.notify_token = row.notify_token;
        return camera;
      });
  },
  create(input) {
    const data = normaliseCameraInput(input, {});
    const cols = CAMERA_FIELDS.filter((f) => data[f] !== undefined);
    const sql = `INSERT INTO cameras (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    const info = getDb()
      .prepare(sql)
      .run(cols.map((c) => data[c]));
    return cameras.get(info.lastInsertRowid);
  },
  update(id, input) {
    const existing = getDb().prepare('SELECT * FROM cameras WHERE id = ?').get(id);
    if (!existing) return null;
    const data = normaliseCameraInput(input, existing);
    const cols = CAMERA_FIELDS.filter((f) => data[f] !== undefined);
    if (cols.length) {
      const sql = `UPDATE cameras SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`;
      getDb()
        .prepare(sql)
        .run(cols.map((c) => data[c]).concat([id]));
    }
    return cameras.get(id);
  },
  remove(id) {
    return getDb().prepare('DELETE FROM cameras WHERE id = ?').run(id).changes > 0;
  },
  setStatus(id, status, message) {
    getDb()
      .prepare(
        `UPDATE cameras
            SET status = ?,
                status_message = ?,
                last_seen_at = CASE WHEN ? = 'online' THEN datetime('now') ELSE last_seen_at END
          WHERE id = ?`
      )
      .run(status, message || null, status, id);
  },
  setStreamInfo(id, info) {
    getDb()
      .prepare(
        `UPDATE cameras
            SET live_stream_url = COALESCE(?, live_stream_url),
                record_stream_url = COALESCE(?, record_stream_url),
                snapshot_url = COALESCE(?, snapshot_url),
                profiles_json = COALESCE(?, profiles_json),
                live_profile_token = COALESCE(?, live_profile_token),
                record_profile_token = COALESCE(?, record_profile_token),
                updated_at = datetime('now')
          WHERE id = ?`
      )
      .run(
        info.live_stream_url || null,
        info.record_stream_url || null,
        info.snapshot_url || null,
        info.profiles ? JSON.stringify(info.profiles) : null,
        info.live_profile_token || null,
        info.record_profile_token || null,
        id
      );
  },
};

function boolInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === 'true' || value === '1' || value === 1) return 1;
  if (value === 'false' || value === '0' || value === 0) return 0;
  return fallback;
}

function normaliseCameraInput(input, existing) {
  const data = {};
  if (input.name !== undefined) data.name = String(input.name).trim();
  if (input.host !== undefined) data.host = String(input.host).trim();
  if (input.onvif_port !== undefined) data.onvif_port = parseInt(input.onvif_port, 10) || 2020;
  if (input.username !== undefined) data.username = String(input.username || '').trim();
  // An empty password on update means "keep the stored one".
  if (input.password !== undefined && input.password !== '') {
    data.password_enc = encrypt(input.password);
  } else if (input.password === '' && existing.id === undefined) {
    data.password_enc = null;
  }
  if (input.enabled !== undefined) data.enabled = boolInt(input.enabled, 1);
  if (input.rtsp_transport !== undefined) {
    data.rtsp_transport = input.rtsp_transport === 'udp' ? 'udp' : 'tcp';
  }
  if (input.live_profile_token !== undefined) data.live_profile_token = input.live_profile_token || null;
  if (input.record_profile_token !== undefined) {
    data.record_profile_token = input.record_profile_token || null;
  }
  if (input.live_stream_url !== undefined) data.live_stream_url = input.live_stream_url || null;
  if (input.record_stream_url !== undefined) data.record_stream_url = input.record_stream_url || null;
  if (input.snapshot_url !== undefined) data.snapshot_url = input.snapshot_url || null;
  if (input.profiles !== undefined) data.profiles_json = JSON.stringify(input.profiles || []);
  if (input.record_on_event !== undefined) data.record_on_event = boolInt(input.record_on_event, 1);
  if (input.event_mode !== undefined) {
    const mode = String(input.event_mode || 'auto');
    data.event_mode = ['auto', 'pull', 'push', 'off'].indexOf(mode) !== -1 ? mode : 'auto';
  }
  if (input.event_record_seconds !== undefined) {
    data.event_record_seconds = clamp(parseInt(input.event_record_seconds, 10) || 30, 5, 3600);
  }
  if (input.max_record_seconds !== undefined) {
    data.max_record_seconds = clamp(parseInt(input.max_record_seconds, 10) || 900, 30, 21600);
  }
  if (input.record_audio !== undefined) data.record_audio = boolInt(input.record_audio, 1);
  return data;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/* ----------------------------------------------------------------- events */

const events = {
  create(event) {
    const info = getDb()
      .prepare(
        `INSERT INTO events (camera_id, topic, type, label, state, source, raw, recording_id, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.camera_id,
        event.topic || null,
        event.type || null,
        event.label || null,
        event.state === null || event.state === undefined ? null : event.state ? 1 : 0,
        event.source || null,
        event.raw ? JSON.stringify(event.raw) : null,
        event.recording_id || null,
        event.received_at || new Date().toISOString()
      );
    return events.get(info.lastInsertRowid);
  },
  get(id) {
    return getDb()
      .prepare(
        `SELECT e.*, c.name AS camera_name
           FROM events e LEFT JOIN cameras c ON c.id = e.camera_id
          WHERE e.id = ?`
      )
      .get(id);
  },
  /**
   * Cameras re-deliver notifications after a re-subscription, so the same
   * detection would otherwise be stored (and re-recorded) on every restart.
   */
  findDuplicate(event) {
    return getDb()
      .prepare(
        `SELECT * FROM events
          WHERE camera_id = ?
            AND received_at = ?
            AND IFNULL(topic, '') = IFNULL(?, '')
            AND IFNULL(state, -1) = IFNULL(?, -1)
          LIMIT 1`
      )
      .get(
        event.camera_id,
        event.received_at,
        event.topic || null,
        event.state === null || event.state === undefined ? null : event.state ? 1 : 0
      );
  },
  linkRecording(eventId, recordingId) {
    getDb().prepare('UPDATE events SET recording_id = ? WHERE id = ?').run(recordingId, eventId);
  },
  query(filters) {
    const where = [];
    const params = [];
    if (filters.cameraId) {
      where.push('e.camera_id = ?');
      params.push(filters.cameraId);
    }
    if (filters.type) {
      where.push('e.type = ?');
      params.push(filters.type);
    }
    if (filters.from) {
      where.push('e.received_at >= ?');
      params.push(filters.from);
    }
    if (filters.to) {
      where.push('e.received_at <= ?');
      params.push(filters.to);
    }
    if (filters.onlyStarts) where.push('(e.state IS NULL OR e.state = 1)');
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = getDb()
      .prepare(`SELECT COUNT(*) AS c FROM events e ${clause}`)
      .get(params).c;
    const rows = getDb()
      .prepare(
        `SELECT e.*, c.name AS camera_name
           FROM events e LEFT JOIN cameras c ON c.id = e.camera_id
           ${clause}
          ORDER BY e.received_at DESC, e.id DESC
          LIMIT ? OFFSET ?`
      )
      .all(params.concat([filters.limit || 100, filters.offset || 0]));
    return { total, rows };
  },
  remove(id) {
    return getDb().prepare('DELETE FROM events WHERE id = ?').run(id).changes > 0;
  },
  removeMany(ids) {
    const stmt = getDb().prepare('DELETE FROM events WHERE id = ?');
    const tx = getDb().transaction((list) => list.forEach((id) => stmt.run(id)));
    tx(ids);
    return ids.length;
  },
  removeAll(cameraId) {
    if (cameraId) return getDb().prepare('DELETE FROM events WHERE camera_id = ?').run(cameraId).changes;
    return getDb().prepare('DELETE FROM events').run().changes;
  },
  types() {
    return getDb()
      .prepare('SELECT DISTINCT type FROM events WHERE type IS NOT NULL ORDER BY type')
      .all()
      .map((r) => r.type);
  },
};

/* ------------------------------------------------------------- recordings */

const recordings = {
  create(rec) {
    const info = getDb()
      .prepare(
        `INSERT INTO recordings (camera_id, filename, rel_path, trigger_type, status, started_at, event_id)
         VALUES (?, ?, ?, ?, 'recording', ?, ?)`
      )
      .run(rec.camera_id, rec.filename, rec.rel_path, rec.trigger_type, rec.started_at, rec.event_id || null);
    return recordings.get(info.lastInsertRowid);
  },
  get(id) {
    return getDb()
      .prepare(
        `SELECT r.*, c.name AS camera_name
           FROM recordings r LEFT JOIN cameras c ON c.id = r.camera_id
          WHERE r.id = ?`
      )
      .get(id);
  },
  finish(id, patch) {
    getDb()
      .prepare(
        `UPDATE recordings
            SET status = ?, ended_at = ?, duration_seconds = ?, size_bytes = ?,
                thumbnail_path = COALESCE(?, thumbnail_path), error = ?
          WHERE id = ?`
      )
      .run(
        patch.status,
        patch.ended_at || new Date().toISOString(),
        patch.duration_seconds || null,
        patch.size_bytes || null,
        patch.thumbnail_path || null,
        patch.error || null,
        id
      );
    return recordings.get(id);
  },
  setTrigger(id, trigger) {
    getDb().prepare('UPDATE recordings SET trigger_type = ? WHERE id = ?').run(trigger, id);
  },
  query(filters) {
    const where = [];
    const params = [];
    if (filters.cameraId) {
      where.push('r.camera_id = ?');
      params.push(filters.cameraId);
    }
    if (filters.trigger) {
      where.push('r.trigger_type = ?');
      params.push(filters.trigger);
    }
    if (filters.status) {
      where.push('r.status = ?');
      params.push(filters.status);
    }
    if (filters.from) {
      where.push('r.started_at >= ?');
      params.push(filters.from);
    }
    if (filters.to) {
      where.push('r.started_at <= ?');
      params.push(filters.to);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = getDb().prepare(`SELECT COUNT(*) AS c FROM recordings r ${clause}`).get(params).c;
    const bytes = getDb()
      .prepare(`SELECT COALESCE(SUM(r.size_bytes), 0) AS b FROM recordings r ${clause}`)
      .get(params).b;
    const rows = getDb()
      .prepare(
        `SELECT r.*, c.name AS camera_name
           FROM recordings r LEFT JOIN cameras c ON c.id = r.camera_id
           ${clause}
          ORDER BY r.started_at DESC, r.id DESC
          LIMIT ? OFFSET ?`
      )
      .all(params.concat([filters.limit || 50, filters.offset || 0]));
    return { total, bytes, rows };
  },
  remove(id) {
    return getDb().prepare('DELETE FROM recordings WHERE id = ?').run(id).changes > 0;
  },
  activeForCamera(cameraId) {
    return getDb()
      .prepare("SELECT * FROM recordings WHERE camera_id = ? AND status = 'recording' ORDER BY id DESC")
      .get(cameraId);
  },
  olderThan(isoDate) {
    return getDb()
      .prepare("SELECT * FROM recordings WHERE status != 'recording' AND started_at < ? ORDER BY started_at")
      .all(isoDate);
  },
  oldestFirst() {
    return getDb()
      .prepare("SELECT * FROM recordings WHERE status != 'recording' ORDER BY started_at ASC")
      .all();
  },
  totalBytes() {
    return getDb().prepare('SELECT COALESCE(SUM(size_bytes), 0) AS b FROM recordings').get().b;
  },
};

/* -------------------------------------------------------------- snapshots */

const snapshots = {
  create(snap) {
    const info = getDb()
      .prepare(
        'INSERT INTO snapshots (camera_id, filename, rel_path, size_bytes, source) VALUES (?, ?, ?, ?, ?)'
      )
      .run(snap.camera_id, snap.filename, snap.rel_path, snap.size_bytes || null, snap.source || 'manual');
    return snapshots.get(info.lastInsertRowid);
  },
  get(id) {
    return getDb()
      .prepare(
        `SELECT s.*, c.name AS camera_name
           FROM snapshots s LEFT JOIN cameras c ON c.id = s.camera_id
          WHERE s.id = ?`
      )
      .get(id);
  },
  query(filters) {
    const where = [];
    const params = [];
    if (filters.cameraId) {
      where.push('s.camera_id = ?');
      params.push(filters.cameraId);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = getDb().prepare(`SELECT COUNT(*) AS c FROM snapshots s ${clause}`).get(params).c;
    const rows = getDb()
      .prepare(
        `SELECT s.*, c.name AS camera_name
           FROM snapshots s LEFT JOIN cameras c ON c.id = s.camera_id
           ${clause}
          ORDER BY s.created_at DESC, s.id DESC
          LIMIT ? OFFSET ?`
      )
      .all(params.concat([filters.limit || 50, filters.offset || 0]));
    return { total, rows };
  },
  remove(id) {
    return getDb().prepare('DELETE FROM snapshots WHERE id = ?').run(id).changes > 0;
  },
  totalBytes() {
    return getDb().prepare('SELECT COALESCE(SUM(size_bytes), 0) AS b FROM snapshots').get().b;
  },
};

module.exports = { users, cameras, events, recordings, snapshots };
