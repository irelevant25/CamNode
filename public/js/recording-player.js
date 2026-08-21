/*
 * Playback window for a stored recording.
 *
 * On top of the plain video element it answers the two questions the native
 * controls cannot: what time of day am I looking at, and was there any sound?
 */
(function () {
  'use strict';

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  function clockOf(date) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  function open(recording) {
    const started = ui.parseDate(recording.started_at) || new Date();
    // The stored duration comes from ffprobe; a fragmented MP4 often reports
    // Infinity through the media element until it is fully buffered.
    let duration = Number(recording.duration_seconds) || 0;

    const body = document.createElement('div');
    body.className = 'playback';
    body.innerHTML = `
      <video controls autoplay playsinline src="/api/recordings/${recording.id}/stream"></video>

      <div class="playback-readout">
        <span class="playback-clock" title="Wall clock time of the frame you are watching">--:--:--</span>
        <span class="playback-date" title="Date of the frame you are watching"></span>
        <span class="spacer"></span>
        <span class="playback-position mono" title="Position in the recording and its total length">0:00 / 0:00</span>
      </div>

      <div class="track" data-role="timeline" title="Time of day across the recording. Click or drag to jump there.">
        <div class="track-fill"></div>
        <div class="track-head"></div>
      </div>
      <div class="track-labels" data-role="labels"></div>

      <div class="track waveform-track" data-role="waveform" title="Sound intensity across the recording. Taller means louder, so you can spot where something was audible. Click or drag to jump there.">
        <canvas></canvas>
        <div class="track-head"></div>
        <div class="track-note">analysing audio…</div>
      </div>

      <div class="playback-meta muted"></div>`;

    const modal = ui.openModal({
      title: `${recording.camera_name || 'Recording'} · ${ui.formatDateTime(recording.started_at)}`,
      wide: true,
      body,
      buttons: [
        {
          label: 'Download',
          onClick: () => {
            window.location.href = `/api/recordings/${recording.id}/download`;
            return false;
          },
        },
        { label: 'Close' },
      ],
    });

    const video = body.querySelector('video');
    const timeline = body.querySelector('[data-role="timeline"]');
    const waveTrack = body.querySelector('[data-role="waveform"]');
    const canvas = waveTrack.querySelector('canvas');
    const note = waveTrack.querySelector('.track-note');
    const labels = body.querySelector('[data-role="labels"]');
    const clock = body.querySelector('.playback-clock');
    const dateLabel = body.querySelector('.playback-date');
    const position = body.querySelector('.playback-position');
    const meta = body.querySelector('.playback-meta');

    meta.textContent =
      `${ui.formatBytes(recording.size_bytes)} · ${recording.trigger_type} · ` +
      `started ${ui.formatDateTime(recording.started_at)}`;

    let peaks = null;

    /* ----------------------------------------------------------- labels */

    function drawLabels() {
      if (!duration) return;
      const count = 5;
      const parts = [];
      for (let i = 0; i < count; i += 1) {
        const at = new Date(started.getTime() + (duration * 1000 * i) / (count - 1));
        const align = i === 0 ? 'flex-start' : i === count - 1 ? 'flex-end' : 'center';
        parts.push(`<span style="flex:1;text-align:${align === 'flex-start' ? 'left' : align === 'flex-end' ? 'right' : 'center'}">${clockOf(at)}</span>`);
      }
      labels.innerHTML = parts.join('');
    }

    /* --------------------------------------------------------- waveform */

    function drawWave() {
      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth || waveTrack.clientWidth;
      const height = canvas.clientHeight || 40;
      if (!width) return;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      const ctx = canvas.getContext('2d');
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (!peaks || !peaks.length) return;

      const played = duration ? (video.currentTime / duration) * width : 0;
      const barWidth = Math.max(1, width / peaks.length);
      for (let i = 0; i < peaks.length; i += 1) {
        const x = (i / peaks.length) * width;
        const value = peaks[i];
        const barHeight = Math.max(value > 0 ? 1 : 0, value * (height - 2));
        ctx.fillStyle = x + barWidth <= played ? 'rgba(59,130,246,.95)' : 'rgba(154,163,178,.55)';
        ctx.fillRect(x, (height - barHeight) / 2, Math.max(0.7, barWidth - 0.4), barHeight);
      }
    }

    async function loadWave() {
      try {
        const data = await api.get(`/api/recordings/${recording.id}/waveform`);
        if (data && Array.isArray(data.peaks) && data.peaks.length) {
          peaks = data.peaks;
          const loudest = Math.max.apply(null, peaks);
          note.textContent = loudest > 0.02 ? '' : 'silent throughout';
          note.style.display = loudest > 0.02 ? 'none' : '';
        } else {
          note.textContent = 'this recording has no audio track';
        }
      } catch (err) {
        note.textContent = `audio could not be analysed (${err.message})`;
      }
      drawWave();
    }

    /* ----------------------------------------------------------- timing */

    function render() {
      const current = video.currentTime || 0;
      const at = new Date(started.getTime() + current * 1000);
      clock.textContent = clockOf(at);
      dateLabel.textContent = ui.formatDateTime(at.toISOString()).split(' ')[0];
      position.textContent = `${ui.formatDuration(current)} / ${ui.formatDuration(duration)}`;

      const fraction = duration ? Math.min(1, current / duration) : 0;
      timeline.querySelector('.track-fill').style.width = `${fraction * 100}%`;
      timeline.querySelector('.track-head').style.left = `${fraction * 100}%`;
      waveTrack.querySelector('.track-head').style.left = `${fraction * 100}%`;
      drawWave();
    }

    function seekFromEvent(event, element) {
      if (!duration) return;
      const rect = element.getBoundingClientRect();
      const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      video.currentTime = fraction * duration;
      render();
    }

    [timeline, waveTrack].forEach((element) => {
      let scrubbing = false;
      element.addEventListener('pointerdown', (event) => {
        scrubbing = true;
        element.setPointerCapture(event.pointerId);
        seekFromEvent(event, element);
      });
      element.addEventListener('pointermove', (event) => {
        if (scrubbing) seekFromEvent(event, element);
      });
      const stop = () => {
        scrubbing = false;
      };
      element.addEventListener('pointerup', stop);
      element.addEventListener('pointercancel', stop);
    });

    video.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(video.duration) && video.duration > 0) duration = video.duration;
      drawLabels();
      render();
    });
    video.addEventListener('timeupdate', render);
    video.addEventListener('seeked', render);
    window.addEventListener('resize', drawWave);

    drawLabels();
    render();
    loadWave();
  }

  window.openRecordingPlayer = open;
})();
