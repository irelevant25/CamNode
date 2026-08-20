'use strict';

const { config } = require('./config');
const { createLogger } = require('./logger');
const db = require('./db/index');
const { createServer } = require('./server');
const cameraManager = require('./services/cameraManager');
const recorder = require('./services/recorder');
const streamHub = require('./services/streamHub');
const retention = require('./services/retention');

const log = createLogger('app');

function main() {
  db.init();
  cameraManager.init();
  retention.start();

  const server = createServer();
  server.listen(config.port, config.host, () => {
    log.info(`camera-recordings listening on http://${config.host}:${config.port}`);
    log.info(`data directory: ${config.dataDir}`);
    if (config.isDefaultSecret) {
      log.warn('APP_SECRET is not set – sessions and stored camera passwords use a default key');
    }
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);
    const timeout = setTimeout(() => {
      log.warn('forced exit after shutdown timeout');
      process.exit(1);
    }, 15000);
    timeout.unref();

    server.close();
    retention.stop();
    streamHub.stopAll();
    await cameraManager.shutdown();
    // Finish in-flight recordings so their mp4 files are closed cleanly.
    await recorder.stopAll();
    log.info('bye');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    log.error(`unhandled rejection: ${(err && err.stack) || err}`);
  });
  process.on('uncaughtException', (err) => {
    log.error(`uncaught exception: ${(err && err.stack) || err}`);
  });
}

main();
