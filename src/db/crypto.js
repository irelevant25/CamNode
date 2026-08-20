'use strict';

const crypto = require('crypto');
const { config } = require('../config');

const KEY = crypto.createHash('sha256').update(String(config.secret)).digest();
const PREFIX = 'enc:v1:';

/**
 * Camera passwords must be recoverable (we have to send them to the camera),
 * so they are encrypted with AES-256-GCM using a key derived from APP_SECRET
 * rather than hashed.
 */
function encrypt(plain) {
  if (plain === undefined || plain === null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(stored) {
  if (!stored) return '';
  if (typeof stored !== 'string' || stored.indexOf(PREFIX) !== 0) return String(stored);
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const enc = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch (err) {
    // Happens when APP_SECRET changed after the password was stored.
    return '';
  }
}

module.exports = { encrypt, decrypt };
