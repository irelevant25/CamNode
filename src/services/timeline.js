'use strict';

const repo = require('../db/repo');

function pad(value) {
  return String(value).padStart(2, '0');
}

function dayKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local-time day boundaries for a YYYY-MM-DD string (today when missing). */
function dayRange(dateText) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateText || ''));
  const now = new Date();
  const start = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + 1);
  return { start, end };
}

/**
 * Everything that happened on one local day for one camera, laid out for the
 * timeline: recordings as blocks, events as marks, and per-hour totals.
 */
function buildDay(cameraId, dateText) {
  const { start, end } = dayRange(dateText);
  const fromIso = start.toISOString();
  const toIso = end.toISOString();

  const recordings = repo.recordings.inRange(cameraId, fromIso, toIso);
  const events = repo.events.inRange(cameraId, fromIso, toIso);

  const hours = [];
  for (let hour = 0; hour < 24; hour += 1) hours.push({ hour, events: 0, recorded_seconds: 0 });

  for (const event of events) {
    const at = new Date(event.received_at);
    if (Number.isNaN(at.getTime())) continue;
    const hour = Math.floor((at - start) / 3600000);
    if (hour >= 0 && hour < 24) hours[hour].events += 1;
  }

  // A recording can span several hours, so spread its seconds across them.
  const now = Date.now();
  for (const recording of recordings) {
    const began = new Date(recording.started_at).getTime();
    const finished = recording.ended_at ? new Date(recording.ended_at).getTime() : now;
    if (Number.isNaN(began) || Number.isNaN(finished)) continue;
    for (let hour = 0; hour < 24; hour += 1) {
      const hourStart = start.getTime() + hour * 3600000;
      const overlap = Math.min(finished, hourStart + 3600000) - Math.max(began, hourStart);
      if (overlap > 0) hours[hour].recorded_seconds += Math.round(overlap / 1000);
    }
  }

  return {
    date: dayKey(start),
    from: fromIso,
    to: toIso,
    recordings,
    events,
    hours,
    totals: {
      recordings: recordings.length,
      events: events.length,
      recorded_seconds: hours.reduce((sum, entry) => sum + entry.recorded_seconds, 0),
    },
  };
}

/** Event counts per day, zero-filled, so an over-triggering camera stands out. */
function activity(cameraId, days) {
  const span = Math.min(90, Math.max(1, days || 14));
  const byDay = {};
  for (const row of repo.events.dailyCounts(cameraId, span)) byDay[row.day] = row.count;

  const series = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() - (span - 1));
  for (let i = 0; i < span; i += 1) {
    const key = dayKey(cursor);
    series.push({ day: key, count: byDay[key] || 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  return { days: span, series };
}

module.exports = { buildDay, activity, dayRange, dayKey };
