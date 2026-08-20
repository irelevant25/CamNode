'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const repo = require('../db/repo');
const { getSetting, setSetting } = require('../db/index');
const { config } = require('../config');
const { createToken, cookieOptions, requireAuth } = require('../middleware/auth');
const { createLogger } = require('../logger');

const log = createLogger('auth');
const router = express.Router();

/** Very small brute-force guard: 10 failures per IP per 5 minutes. */
const attempts = new Map();
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function tooManyAttempts(ip) {
  const entry = attempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.first > WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function noteFailure(ip) {
  const entry = attempts.get(ip);
  if (!entry || Date.now() - entry.first > WINDOW_MS) attempts.set(ip, { first: Date.now(), count: 1 });
  else entry.count += 1;
}

router.post('/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (tooManyAttempts(ip)) {
    return res.status(429).json({ error: 'Too many failed attempts, try again in a few minutes' });
  }
  const username = String((req.body && req.body.username) || '').trim();
  const password = String((req.body && req.body.password) || '');
  const user = repo.users.findByUsername(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    noteFailure(ip);
    log.warn(`failed login for "${username}" from ${ip}`);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  attempts.delete(ip);
  res.cookie(config.cookieName, createToken(user), cookieOptions());
  res.json({ user: { id: user.id, username: user.username } });
});

router.post('/logout', (req, res) => {
  res.clearCookie(config.cookieName, { path: '/' });
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user, warnings: warnings() });
});

router.post('/password', requireAuth, (req, res) => {
  const current = String((req.body && req.body.current_password) || '');
  const next = String((req.body && req.body.new_password) || '');
  if (next.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  const user = repo.users.findById(req.user.id);
  if (!bcrypt.compareSync(current, user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  repo.users.updatePassword(user.id, bcrypt.hashSync(next, 10));
  setSetting('default_admin_password', '0');
  res.cookie(config.cookieName, createToken(user), cookieOptions());
  res.json({ ok: true });
});

function warnings() {
  const list = [];
  if (config.isDefaultSecret) {
    list.push('APP_SECRET is still the default value – set it in your stack environment.');
  }
  if (getSetting('default_admin_password', '0') === '1') {
    list.push('This account still uses the default password – change it below in Settings.');
  }
  const tools = require('../services/ffmpeg').getToolStatus();
  if (tools.ffmpeg && !tools.ffmpeg.ok) {
    list.push(
      `ffmpeg could not be started (${tools.ffmpeg.error}) – live view, recording and snapshots will not work. ` +
        'Put the binary next to the app, in ./bin, or set FFMPEG_PATH.'
    );
  }
  if (tools.ffprobe && !tools.ffprobe.ok) {
    list.push('ffprobe was not found – recording durations are estimated. It ships with ffmpeg.');
  }
  return list;
}

module.exports = router;
