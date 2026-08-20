'use strict';

const { config } = require('./config');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[config.logLevel] === undefined ? LEVELS.info : LEVELS[config.logLevel];

function write(level, scope, args) {
  if (LEVELS[level] > threshold) return;
  const stamp = new Date().toISOString();
  const prefix = `${stamp} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  if (level === 'error') console.error(prefix, ...args);
  else if (level === 'warn') console.warn(prefix, ...args);
  else console.log(prefix, ...args);
}

function createLogger(scope) {
  return {
    error: (...args) => write('error', scope, args),
    warn: (...args) => write('warn', scope, args),
    info: (...args) => write('info', scope, args),
    debug: (...args) => write('debug', scope, args),
  };
}

module.exports = { createLogger };
