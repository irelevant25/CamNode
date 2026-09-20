'use strict';

/**
 * Express 4 does not look at the promise an async handler returns, so a
 * rejection would leave the request hanging. Route it to the error handler.
 */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { asyncHandler };
