'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const { config } = require('./config');
const { createLogger } = require('./logger');
const auth = require('./middleware/auth');
const { bus } = require('./services/bus');
const streamHub = require('./services/streamHub');
const recorder = require('./services/recorder');
const cameraManager = require('./services/cameraManager');

const log = createLogger('http');

function createServer() {
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use(auth.cookieParser());

  app.get('/api/health', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));

  // Cameras push ONVIF notifications here – authenticated by a per-camera token
  // in the URL, not by a session.
  app.use('/onvif', require('./routes/notify'));

  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/cameras', auth.requireAuth, require('./routes/cameras'));
  app.use('/api/recordings', auth.requireAuth, require('./routes/recordings'));
  app.use('/api/events', auth.requireAuth, require('./routes/events'));
  app.use('/api/snapshots', auth.requireAuth, require('./routes/snapshots'));
  app.use('/api/system', auth.requireAuth, require('./routes/system'));

  app.use(
    express.static(path.join(__dirname, '..', 'public'), {
      index: 'index.html',
      maxAge: '5m',
      setHeaders(res, filePath) {
        if (/\.html$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
      },
    })
  );

  app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown endpoint' }));
  app.use((req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    log.error(`${req.method} ${req.originalUrl}: ${err.stack || err.message}`);
    if (res.headersSent) return;
    res.status(500).json({ error: err.message || 'Internal server error' });
  });

  const server = http.createServer(app);
  attachWebSockets(server);
  return server;
}

function attachWebSockets(server) {
  const liveWss = new WebSocketServer({ noServer: true });
  const updatesWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch (err) {
      return socket.destroy();
    }
    if (pathname !== '/ws/live' && pathname !== '/ws/updates') return socket.destroy();

    const user = auth.authenticateUpgrade(req);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    const wss = pathname === '/ws/live' ? liveWss : updatesWss;
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.user = user;
      wss.emit('connection', ws, req);
    });
  });

  /* --------------------------------------------------------- live video */
  liveWss.on('connection', async (ws, req) => {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const cameraId = Number(params.get('camera_id'));
    const quality = params.get('quality') === 'main' ? 'main' : 'sub';
    let stream = null;

    const fail = (message) => {
      try {
        ws.send(JSON.stringify({ type: 'status', state: 'error', message }));
        ws.close(1011, 'stream unavailable');
      } catch (err) {
        /* ignore */
      }
    };

    ws.on('close', () => {
      if (stream) streamHub.unsubscribe(stream, ws);
    });
    ws.on('error', () => {
      if (stream) streamHub.unsubscribe(stream, ws);
    });

    if (!cameraId) return fail('camera_id is required');
    try {
      ws.send(JSON.stringify({ type: 'status', state: 'connecting', quality }));
      const camera = await cameraManager.getReadyCamera(cameraId);
      if (!camera) return fail('Camera not found');
      if (ws.readyState !== 1) return; // client gave up while we were discovering
      stream = streamHub.subscribe(camera, ws, quality);
      log.debug(`live viewer connected: camera ${cameraId} (${quality}) as ${ws.user.username}`);
    } catch (err) {
      fail(err.message);
    }
  });

  /* ------------------------------------------------------- ui push feed */
  updatesWss.on('connection', (ws) => {
    const send = (payload) => {
      if (ws.readyState !== 1) return;
      try {
        ws.send(JSON.stringify(payload));
      } catch (err) {
        /* ignore */
      }
    };
    const listener = (update) => send(update);
    bus.on('update', listener);
    send({ type: 'hello', payload: { active_recordings: recorder.listActive() } });

    const ping = setInterval(() => {
      if (ws.readyState === 1) ws.ping();
    }, 30000);

    const cleanup = () => {
      bus.removeListener('update', listener);
      clearInterval(ping);
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  return { liveWss, updatesWss };
}

module.exports = { createServer };
