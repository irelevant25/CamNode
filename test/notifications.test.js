'use strict';
process.env.DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(),'cr-loose-'));
const assert = require('assert');
const onvif = require(require('path').join(__dirname,'..','src','services','onvifClient'));

function body(quote) {
  const q = quote;
  return `<?xml version="1.0"?>
<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope" xmlns:wsnt="http://docs.oasis-open.org/wsn/b-2" xmlns:tt="http://www.onvif.org/ver10/schema">
 <env:Body><wsnt:Notify>
  <wsnt:NotificationMessage>
   <wsnt:Topic Dialect=${q}x${q}>tns1:RuleEngine/CellMotionDetector/Motion</wsnt:Topic>
   <wsnt:Message><tt:Message UtcTime=${q}2026-08-25T09:12:33Z${q} PropertyOperation=${q}Changed${q}>
    <tt:Source><tt:SimpleItem Name=${q}VideoSourceConfigurationToken${q} Value=${q}vsconf${q}/></tt:Source>
    <tt:Data><tt:SimpleItem Name=${q}IsMotion${q} Value=${q}true${q}/></tt:Data>
   </tt:Message></wsnt:Message>
  </wsnt:NotificationMessage>
  <wsnt:NotificationMessage>
   <wsnt:Topic Dialect=${q}x${q}>tns1:VideoSource/MotionAlarm</wsnt:Topic>
   <wsnt:Message><tt:Message UtcTime=${q}2026-08-25T09:12:35Z${q}>
    <tt:Source><tt:SimpleItem Name=${q}Source${q} Value=${q}raw_vs1${q}/></tt:Source>
    <tt:Data><tt:SimpleItem Name=${q}State${q} Value=${q}false${q}/></tt:Data>
   </tt:Message></wsnt:Message>
  </wsnt:NotificationMessage>
 </wsnt:Notify></env:Body></env:Envelope>`;
}

for (const [label, quote] of [['double quotes', '"'], ['single quotes', "'"]]) {
  const messages = onvif.parseNotificationXmlLoosely(body(quote));
  assert.strictEqual(messages.length, 2, label + ': both messages');
  const events = messages.map((m) => onvif.parseEvent(m));

  assert.strictEqual(events[0].type, 'motion');
  assert.strictEqual(events[0].state, true, label + ': IsMotion=true read');
  assert.strictEqual(events[0].received_at, '2026-08-25T09:12:33.000Z', label + ': UtcTime read');
  assert.ok(/vsconf/.test(events[0].source), label + ': source item read');

  assert.strictEqual(events[1].state, false, label + ': State=false read');
  assert.strictEqual(events[1].received_at, '2026-08-25T09:12:35.000Z');
  console.log(`OK  loose parser with ${label}: 2 messages, states ${events[0].state}/${events[1].state}`);
}

// A body with nothing usable must yield nothing rather than a bogus event.
assert.strictEqual(onvif.parseNotificationXmlLoosely('<html>not soap</html>').length, 0);
assert.strictEqual(onvif.parseNotificationXmlLoosely('').length, 0);
assert.strictEqual(onvif.parseNotificationXmlLoosely(null).length, 0);
console.log('OK  unusable bodies produce no events');

// A single message with no NotificationMessage wrapper still works.
const bare =
  '<Envelope><Topic>tns1:RuleEngine/MyRuleDetector/PeopleDetect</Topic>' +
  '<Message UtcTime="2026-08-25T10:00:00Z"><Data><SimpleItem Name="IsPeople" Value="true"/></Data></Message></Envelope>';
const single = onvif.parseNotificationXmlLoosely(bare).map((m) => onvif.parseEvent(m));
assert.strictEqual(single.length, 1);
assert.strictEqual(single[0].type, 'person');
assert.strictEqual(single[0].state, true);
console.log('OK  loose parser handles an unwrapped single message');

console.log('\nAll loose-parser checks passed.');
