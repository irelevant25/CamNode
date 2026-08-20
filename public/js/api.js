/* Thin fetch wrapper: JSON in, JSON out, session handling in one place. */
(function () {
  'use strict';

  function toLogin() {
    if (location.pathname === '/login.html') return;
    location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search);
  }

  async function request(path, options) {
    const opts = Object.assign({ method: 'GET', headers: {} }, options || {});
    if (opts.body !== undefined && !(opts.body instanceof Blob) && typeof opts.body !== 'string') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    const response = await fetch(path, opts);
    if (response.status === 401) {
      toLogin();
      throw new Error('Session expired');
    }
    const isJson = (response.headers.get('content-type') || '').indexOf('application/json') !== -1;
    const payload = isJson ? await response.json().catch(() => ({})) : null;
    if (!response.ok) {
      throw new Error((payload && payload.error) || `Request failed (${response.status})`);
    }
    return payload;
  }

  window.api = {
    request,
    get: (path) => request(path),
    post: (path, body) => request(path, { method: 'POST', body }),
    put: (path, body) => request(path, { method: 'PUT', body }),
    del: (path) => request(path, { method: 'DELETE' }),

    postBlob: (path, blob, type) =>
      request(path, { method: 'POST', body: blob, headers: { 'Content-Type': type } }),

    /** WebSocket URL on the same origin. */
    wsUrl(path, params) {
      const url = new URL(path, location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      if (params) {
        Object.keys(params).forEach((key) => {
          if (params[key] !== undefined && params[key] !== null) url.searchParams.set(key, params[key]);
        });
      }
      return url.toString();
    },
  };
})();
