'use strict';
process.env.DATA_DIR = process.env.DATA_DIR || require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'cr-unit-'));
const assert = require('assert');
const SRC = require('path').join(__dirname, '..', 'src') + '/';
const { Mp4Splitter } = require(SRC + 'services/mp4');
const onvif = require(SRC + 'services/onvifClient');

/* ---------------------------------------------------------- mp4 splitter */
function box(type, payloadLength) {
  const size = 8 + payloadLength;
  const buf = Buffer.alloc(size);
  buf.writeUInt32BE(size, 0);
  buf.write(type, 4, 'ascii');
  buf.fill(0xaa, 8);
  return buf;
}

const stream = Buffer.concat([
  box('ftyp', 8),
  box('moov', 40),
  box('moof', 16),
  box('mdat', 100),
  box('moof', 16),
  box('mdat', 60),
]);

for (const chunkSize of [1, 3, 7, 64, 1000]) {
  const seen = [];
  const splitter = new Mp4Splitter((kind, buffer) => seen.push([kind, buffer.length]));
  for (let i = 0; i < stream.length; i += chunkSize) {
    splitter.write(stream.subarray(i, Math.min(i + chunkSize, stream.length)));
  }
  assert.deepStrictEqual(
    seen,
    [
      ['init', 16 + 48],
      ['fragment', 24 + 108],
      ['fragment', 24 + 68],
    ],
    `chunkSize ${chunkSize} -> ${JSON.stringify(seen)}`
  );
}
console.log('OK  Mp4Splitter groups boxes correctly at every chunk boundary');

// 64-bit largesize box
const large = Buffer.alloc(16 + 8);
large.writeUInt32BE(1, 0);
large.write('mdat', 4, 'ascii');
large.writeUInt32BE(0, 8);
large.writeUInt32BE(24, 12);
const seen2 = [];
const splitter2 = new Mp4Splitter((kind, buffer) => seen2.push([kind, buffer.length]));
splitter2.write(Buffer.concat([box('ftyp', 8), box('moov', 8), box('moof', 8), large]));
assert.deepStrictEqual(seen2, [['init', 32], ['fragment', 16 + 24]]);
console.log('OK  Mp4Splitter handles 64-bit box sizes');

/* ------------------------------------------------------------ onvif events */
const motion = {
  topic: { _: 'tns1:RuleEngine/CellMotionDetector/Motion' },
  message: {
    message: {
      $: { UtcTime: new Date('2026-08-20T10:00:00Z'), PropertyOperation: 'Changed' },
      source: { simpleItem: { $: { Name: 'VideoSourceConfigurationToken', Value: 'vsconf' } } },
      data: { simpleItem: { $: { Name: 'IsMotion', Value: true } } },
    },
  },
};
let parsed = onvif.parseEvent(motion);
assert.strictEqual(parsed.type, 'motion');
assert.strictEqual(parsed.label, 'Motion detected');
assert.strictEqual(parsed.state, true);
assert.strictEqual(parsed.received_at, '2026-08-20T10:00:00.000Z');
assert.strictEqual(parsed.source, 'VideoSourceConfigurationToken=vsconf');

const person = {
  topic: { _: 'tns1:RuleEngine/MyRuleDetector/PeopleDetect' },
  message: { message: { data: { simpleItem: { $: { Name: 'IsPeople', Value: 'false' } } } } },
};
parsed = onvif.parseEvent(person);
assert.strictEqual(parsed.type, 'person');
assert.strictEqual(parsed.state, false);

const unknown = {
  topic: { _: 'tns1:VideoSource/ImageTooDark' },
  message: { message: { data: { simpleItem: [{ $: { Name: 'State', Value: 'true' } }] } } },
};
parsed = onvif.parseEvent(unknown);
assert.strictEqual(parsed.type, 'imagetoodark');
assert.strictEqual(parsed.label, 'Image Too Dark');
assert.strictEqual(parsed.state, true);
assert.strictEqual(onvif.parseEvent({ message: {} }), null);
console.log('OK  ONVIF event parsing (motion / person / generic / malformed)');

/* --------------------------------------------------------- url handling */
const cam = { host: '10.0.0.5', username: 'user name', password: 'p@ss:word' };
const normalised = onvif.normaliseUri('rtsp://192.168.1.99:554/stream1', cam);
assert.strictEqual(normalised, 'rtsp://10.0.0.5:554/stream1');
const withCreds = onvif.withCredentials(normalised, cam);
assert.strictEqual(withCreds, 'rtsp://user%20name:p%40ss%3Aword@10.0.0.5:554/stream1');
assert.strictEqual(onvif.normaliseUri('rtsp://a:b@192.168.1.99/live', cam), 'rtsp://10.0.0.5/live');
console.log('OK  RTSP URL normalisation and credential injection');

/* ------------------------------------------------------------- crypto */
process.env.APP_SECRET = 'unit-test-secret';
const crypto = require(SRC + 'db/crypto');
const secret = 'Tapo!Pass 123';
const enc = crypto.encrypt(secret);
assert.notStrictEqual(enc, secret);
assert.strictEqual(crypto.decrypt(enc), secret);
assert.strictEqual(crypto.decrypt(null), '');
assert.strictEqual(crypto.decrypt('enc:v1:garbage'), '');
console.log('OK  camera password encryption round-trip');

/* ----------------------------------------------------------- ffmpeg args */
const ff = require(SRC + 'services/ffmpeg');
assert.strictEqual(
  ff.maskUrl('rtsp://user:secret@10.0.0.5:554/stream1'),
  'rtsp://user:****@10.0.0.5:554/stream1'
);
const args = ff.rtspInputArgs({ rtsp_transport: 'udp' }, 'rtsp://x/y');
assert.strictEqual(args[args.indexOf('-rtsp_transport') + 1], 'udp');
assert.strictEqual(args[args.length - 1], 'rtsp://x/y');
console.log('OK  ffmpeg argument building and credential masking');

console.log('\nAll self-tests passed.');
