'use strict';

const express = require('express');
const cameraManager = require('../services/cameraManager');
const { createLogger } = require('../logger');

const log = createLogger('notify');
const router = express.Router();

/**
 * Cameras POST their ONVIF notifications here in push mode. This endpoint has
 * no session: a camera cannot log in. The random token in the path is what
 * links a request to a camera, and it is only ever handed to that one camera.
 */
router.post(
  '/notify/:cameraId/:token',
  express.text({ type: () => true, limit: '1mb' }),
  async (req, res) => {
    const cameraId = Number(req.params.cameraId);
    const xml = typeof req.body === 'string' ? req.body : '';

    // The camera does not care about our answer, so always reply 200 with an
    // empty SOAP envelope – anything else makes some firmwares drop the
    // subscription.
    res.set('Content-Type', 'application/soap+xml; charset=utf-8');
    res.send(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body/></s:Envelope>'
    );

    if (!cameraId || !xml) return;
    try {
      const result = await cameraManager.handlePushNotification(
        cameraId,
        req.params.token,
        xml,
        req.socket.remoteAddress
      );
      if (!result.ok) log.warn(`rejected notification for camera ${cameraId}: ${result.reason}`);
      else if (!result.handled) log.debug(`camera ${cameraId}: notification carried no usable event`);
    } catch (err) {
      log.warn(`camera ${cameraId}: could not parse notification: ${err.message}`);
    }
  }
);

module.exports = router;
