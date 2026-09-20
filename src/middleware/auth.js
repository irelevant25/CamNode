'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const cookie = require('cookie-parser');
const { config } = require('../config');
const repo = require('../db/repo');

/**
 * Ties a session to the password it was opened with, so changing or resetting
 * the password signs every other browser out instead of leaving a stolen
 * cookie valid until it expires.
 */
function passwordStamp(user) {
  return crypto.createHash('sha256').update(String(user.password_hash)).digest('hex').slice(0, 16);
}

function createToken(user) {
  return jwt.sign({ sub: user.id, username: user.username, pwd: passwordStamp(user) }, config.secret, {
    expiresIn: `${config.sessionHours}h`,
  });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, config.secret);
  } catch (err) {
    return null;
  }
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: config.sessionHours * 3600 * 1000,
    path: '/',
  };
}

/** The user a verified token belongs to, or null when it no longer applies. */
function userFor(payload) {
  if (!payload) return null;
  const user = repo.users.findById(payload.sub);
  if (!user) return null;
  // Tokens issued before the stamp existed carry none; let those run out.
  if (payload.pwd !== undefined && payload.pwd !== passwordStamp(user)) return null;
  return { id: user.id, username: user.username };
}

function readToken(req) {
  if (req.cookies && req.cookies[config.cookieName]) return req.cookies[config.cookieName];
  const header = req.headers.authorization;
  if (header && header.indexOf('Bearer ') === 0) return header.slice(7);
  return null;
}

/** Express guard for /api routes. */
function requireAuth(req, res, next) {
  const user = userFor(verifyToken(readToken(req)));
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  next();
}

/** Guard for WebSocket upgrades – reads the same session cookie. */
function authenticateUpgrade(req) {
  const header = req.headers.cookie || '';
  const jar = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    try {
      jar[key] = decodeURIComponent(value);
    } catch (err) {
      jar[key] = value;
    }
  }
  let token = jar[config.cookieName];
  if (!token) {
    try {
      token = new URL(req.url, 'http://localhost').searchParams.get('token');
    } catch (err) {
      token = null;
    }
  }
  return userFor(verifyToken(token));
}

module.exports = {
  cookieParser: cookie,
  createToken,
  verifyToken,
  cookieOptions,
  requireAuth,
  authenticateUpgrade,
};
