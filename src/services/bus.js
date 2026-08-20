'use strict';

const { EventEmitter } = require('events');

/**
 * Application wide pub/sub used to push live updates (events, recording state,
 * camera status) to connected browsers over the /ws/updates socket.
 */
const bus = new EventEmitter();
bus.setMaxListeners(0);

function publish(type, payload) {
  bus.emit('update', { type, payload, at: new Date().toISOString() });
}

module.exports = { bus, publish };
