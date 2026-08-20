'use strict';

const { URL } = require('url');
const { Cam } = require('onvif');
const { createLogger } = require('../logger');

const log = createLogger('onvif');

/**
 * Connect to an ONVIF device. Resolves with a connected `Cam` instance.
 */
function connect(camera, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const options = {
      hostname: camera.host,
      port: parseInt(camera.onvif_port, 10) || 2020,
      username: camera.username || '',
      password: camera.password || '',
      timeout: timeoutMs || 10000,
      // Tapo (and most consumer cams) report their own internal address in the
      // service URLs; keep talking to the address the user configured.
      preserveAddress: true,
    };
    const cam = new Cam(options, (err) => {
      if (settled) return;
      settled = true;
      if (err) return reject(normaliseError(err, camera));
      resolve(cam);
    });
    cam.on('error', (err) => log.debug(`camera ${camera.host} socket error: ${err && err.message}`));
  });
}

function normaliseError(err, camera) {
  const message = (err && err.message) || String(err);
  if (/401|unauthor|not authorized|authentic/i.test(message)) {
    return new Error('Authentication failed – check the ONVIF username/password (Tapo: use the Camera Account, not your TP-Link account).');
  }
  if (/ECONNREFUSED/i.test(message)) {
    return new Error(`Connection refused on ${camera.host}:${camera.onvif_port} – is ONVIF enabled and the port correct (Tapo default 2020)?`);
  }
  if (/EHOSTUNREACH|ENETUNREACH|ENOTFOUND/i.test(message)) {
    return new Error(`Host ${camera.host} is unreachable from the server.`);
  }
  if (/timeout|ETIMEDOUT/i.test(message)) {
    return new Error(`Timed out talking to ${camera.host}:${camera.onvif_port}.`);
  }
  return new Error(message);
}

function promisify(cam, method, args) {
  return new Promise((resolve, reject) => {
    const callback = (err, result) => (err ? reject(normaliseError(err, { host: cam.hostname, onvif_port: cam.port })) : resolve(result));
    if (args === undefined) cam[method](callback);
    else cam[method](args, callback);
  });
}

/** Device information (manufacturer/model/firmware/serial). */
async function getDeviceInformation(cam) {
  try {
    return await promisify(cam, 'getDeviceInformation');
  } catch (err) {
    return null;
  }
}

/** Media profiles reduced to what the UI needs. */
async function getProfiles(cam) {
  const profiles = cam.profiles && cam.profiles.length ? cam.profiles : await promisify(cam, 'getProfiles');
  return (profiles || []).map((profile) => {
    const token = (profile.$ && profile.$.token) || profile.token || profile.name;
    const video = profile.videoEncoderConfiguration || {};
    const resolution = video.resolution || {};
    return {
      token,
      name: profile.name || token,
      encoding: video.encoding || null,
      width: resolution.width || null,
      height: resolution.height || null,
      fps: (video.rateControl && video.rateControl.frameRateLimit) || null,
      bitrate: (video.rateControl && video.rateControl.bitrateLimit) || null,
    };
  });
}

/**
 * Ask the camera for the RTSP URL of a profile and rewrite it so that it points
 * at the configured host and carries the credentials ffmpeg needs.
 */
async function getStreamUrl(cam, camera, profileToken) {
  const result = await promisify(cam, 'getStreamUri', {
    protocol: 'RTSP',
    profileToken,
  });
  const uri = result && (result.uri || (result.mediaUri && result.mediaUri.uri));
  if (!uri) throw new Error('Camera did not return an RTSP URL');
  return normaliseUri(uri, camera);
}

async function getSnapshotUrl(cam, camera, profileToken) {
  try {
    const result = await promisify(cam, 'getSnapshotUri', { profileToken });
    const uri = result && (result.uri || (result.mediaUri && result.mediaUri.uri));
    return uri ? normaliseUri(uri, camera) : null;
  } catch (err) {
    return null;
  }
}

/**
 * Force the configured hostname into a URL and strip any credentials the camera
 * may have embedded – URLs are persisted, passwords are not stored in them.
 */
function normaliseUri(rawUri, camera) {
  try {
    const url = new URL(rawUri);
    if (camera.host) url.hostname = camera.host;
    url.username = '';
    url.password = '';
    return url.toString();
  } catch (err) {
    return rawUri;
  }
}

/** Inject username/password just before handing a URL to ffmpeg. */
function withCredentials(rawUri, camera) {
  if (!rawUri) return rawUri;
  try {
    const url = new URL(rawUri);
    if (camera.username) {
      url.username = encodeURIComponent(camera.username);
      url.password = encodeURIComponent(camera.password || '');
    }
    return url.toString();
  } catch (err) {
    return rawUri;
  }
}

/**
 * Discover everything we need for a camera in one round trip:
 * device info, profiles and the RTSP URLs for the chosen live/record profiles.
 * The highest resolution profile is used for recording, the lowest for live
 * view (cheaper to pull and decode, and keeps the camera's connection budget
 * free for the recorder).
 */
async function inspect(camera, options) {
  const opts = options || {};
  const cam = opts.cam || (await connect(camera, opts.timeoutMs));
  try {
    const [info, profiles] = await Promise.all([getDeviceInformation(cam), getProfiles(cam)]);
    if (!profiles.length) throw new Error('Camera exposes no media profiles');

    const sorted = profiles.slice().sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
    const best = sorted[0];
    const smallest = sorted[sorted.length - 1];

    const recordToken = pickToken(camera.record_profile_token, profiles, best.token);
    const liveToken = pickToken(camera.live_profile_token, profiles, smallest.token);

    const [recordUrl, liveUrl, snapshotUrl] = await Promise.all([
      getStreamUrl(cam, camera, recordToken),
      recordToken === liveToken
        ? Promise.resolve(null)
        : getStreamUrl(cam, camera, liveToken).catch(() => null),
      getSnapshotUrl(cam, camera, recordToken),
    ]);

    return {
      cam,
      device: info,
      profiles,
      live_profile_token: liveToken,
      record_profile_token: recordToken,
      live_stream_url: liveUrl || recordUrl,
      record_stream_url: recordUrl,
      snapshot_url: snapshotUrl,
    };
  } finally {
    if (!opts.keepOpen && !opts.cam) {
      // `Cam` has no explicit close; dropping the reference is enough because
      // ONVIF requests are stateless HTTP calls.
    }
  }
}

function pickToken(preferred, profiles, fallback) {
  if (preferred && profiles.some((p) => p.token === preferred)) return preferred;
  return fallback;
}

/* ------------------------------------------------------------------ events */

const TYPE_RULES = [
  { re: /(peopledetect|persondetect|human|people|person)/i, type: 'person', label: 'Person detected' },
  { re: /(vehicledetect|vehicle|car)/i, type: 'vehicle', label: 'Vehicle detected' },
  { re: /(petdetect|animal|pet)/i, type: 'pet', label: 'Pet detected' },
  { re: /(linedetector|linecross|crossline)/i, type: 'line_crossing', label: 'Line crossing' },
  { re: /(fielddetector|intrusion|areadetect)/i, type: 'intrusion', label: 'Intrusion' },
  { re: /(tamper|tamperdetect)/i, type: 'tamper', label: 'Tampering' },
  { re: /(audio|sound|noise)/i, type: 'sound', label: 'Sound detected' },
  { re: /(babycry|cry)/i, type: 'baby_cry', label: 'Baby crying' },
  { re: /(motion|cellmotion)/i, type: 'motion', label: 'Motion detected' },
  { re: /(digitalinput|trigger)/i, type: 'input', label: 'Digital input' },
];

/**
 * Turn an ONVIF notification into a flat record we can store and display.
 * Returns null for messages that carry no usable topic.
 */
function parseEvent(message) {
  if (!message) return null;
  const topic = extractTopic(message);
  if (!topic) return null;

  const body = (message.message && message.message.message) || message.message || {};
  const receivedAt = toIso(body.$ && body.$.UtcTime) || new Date().toISOString();
  const dataItems = simpleItems(body.data);
  const sourceItems = simpleItems(body.source);

  let state = null;
  for (const item of dataItems) {
    const value = item.value;
    if (typeof value === 'boolean') {
      state = value;
      break;
    }
    if (typeof value === 'string' && /^(true|false)$/i.test(value)) {
      state = /^true$/i.test(value);
      break;
    }
    if (/^(active|inactive)$/i.test(String(value))) {
      state = /^active$/i.test(String(value));
      break;
    }
  }

  const haystack = topic + ' ' + dataItems.map((i) => i.name).join(' ');
  let matched = null;
  for (const rule of TYPE_RULES) {
    if (rule.re.test(haystack)) {
      matched = rule;
      break;
    }
  }
  const lastSegment = topic.split('/').pop().replace(/^[a-z0-9]+:/i, '');

  return {
    topic,
    type: matched ? matched.type : lastSegment.toLowerCase() || 'unknown',
    label: matched ? matched.label : humanise(lastSegment),
    state,
    source: sourceItems.map((i) => `${i.name}=${i.value}`).join(', ') || null,
    received_at: receivedAt,
    raw: {
      topic,
      data: dataItems,
      source: sourceItems,
      propertyOperation: (body.$ && body.$.PropertyOperation) || null,
    },
  };
}

function extractTopic(message) {
  const topic = message.topic;
  if (!topic) return null;
  if (typeof topic === 'string') return topic;
  if (typeof topic._ === 'string') return topic._;
  if (topic.$ && typeof topic.$._ === 'string') return topic.$._;
  return null;
}

function simpleItems(node) {
  if (!node) return [];
  const raw = node.simpleItem !== undefined ? node.simpleItem : node;
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const item of list) {
    if (!item) continue;
    const attrs = item.$ || item;
    if (attrs && attrs.Name !== undefined) {
      out.push({ name: String(attrs.Name), value: attrs.Value });
    }
  }
  return out;
}

function toIso(value) {
  if (!value) return null;
  try {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  } catch (err) {
    return null;
  }
}

function humanise(text) {
  return String(text)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = {
  connect,
  inspect,
  getProfiles,
  getDeviceInformation,
  getStreamUrl,
  getSnapshotUrl,
  normaliseUri,
  withCredentials,
  parseEvent,
};
