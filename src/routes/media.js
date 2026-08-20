'use strict';

const fs = require('fs');

/**
 * Serve a file with HTTP range support so the browser can seek inside
 * recordings instead of downloading them from the start every time.
 */
function sendFile(req, res, absPath, options) {
  const opts = options || {};
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch (err) {
    return res.status(404).json({ error: 'File is missing on disk' });
  }

  res.set('Content-Type', opts.contentType || 'application/octet-stream');
  res.set('Accept-Ranges', 'bytes');
  res.set('Cache-Control', 'private, max-age=300');
  if (opts.filename) {
    const disposition = opts.download ? 'attachment' : 'inline';
    res.set('Content-Disposition', `${disposition}; filename="${sanitise(opts.filename)}"`);
  }

  const range = req.headers.range;
  if (!range) {
    res.set('Content-Length', String(stat.size));
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(absPath).pipe(res);
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  if (!match) {
    res.set('Content-Range', `bytes */${stat.size}`);
    return res.status(416).end();
  }
  let start = match[1] === '' ? null : parseInt(match[1], 10);
  let end = match[2] === '' ? null : parseInt(match[2], 10);
  if (start === null) {
    // suffix range: last N bytes
    const length = end === null ? 0 : end;
    start = Math.max(0, stat.size - length);
    end = stat.size - 1;
  } else if (end === null || end >= stat.size) {
    end = stat.size - 1;
  }
  if (start > end || start >= stat.size) {
    res.set('Content-Range', `bytes */${stat.size}`);
    return res.status(416).end();
  }

  res.status(206);
  res.set('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  res.set('Content-Length', String(end - start + 1));
  if (req.method === 'HEAD') return res.end();
  return fs.createReadStream(absPath, { start, end }).pipe(res);
}

function sanitise(name) {
  return String(name).replace(/["\\\r\n]/g, '_');
}

module.exports = { sendFile };
