'use strict';

const jwt = require('jsonwebtoken');
const cookie = require('cookie-parser');
const { config } = require('../config');
const repo = require('../db/repo');

function createToken(user) {
  return jwt.sign({ sub: user.id, username: user.username }, config.secret, {
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

function readToken(req) {
  if (req.cookies && req.cookies[config.cookieName]) return req.cookies[config.cookieName];
  const header = req.headers.authorization;
  if (header && header.indexOf('Bearer ') === 0) return header.slice(7);
  return null;
}

/** Express guard for /api routes. */
function requireAuth(req, res, next) {
  const payload = verifyToken(readToken(req));
  if (!payload) return res.status(401).json({ error: 'Not authenticated' });
  const user = repo.users.findById(payload.sub);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = { id: user.id, username: user.username };
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
  const payload = verifyToken(token);
  if (!payload) return null;
  const user = repo.users.findById(payload.sub);
  return user ? { id: user.id, username: user.username } : null;
}

module.exports = {
  cookieParser: cookie,
  createToken,
  verifyToken,
  cookieOptions,
  requireAuth,
  authenticateUpgrade,
};
