/* Application shell: navigation, live view, library views and live updates. */
(function () {
  'use strict';

  const esc = ui.escapeHtml;
  const $ = (id) => document.getElementById(id);

  const state = {
    user: null,
    cameras: [],
    activeCameraId: null,
    activeRecordings: {},
    view: 'live',
    showInfo: false,
    lastVolume: 60,
    userInteracted: false,
    recordingTimer: null,
    timeline: null,
    rec: { offset: 0, limit: 25, total: 0, selected: new Set() },
    ev: { offset: 0, limit: 50, total: 0, selected: new Set() },
    snap: { offset: 0, limit: 24, total: 0 },
  };

  let player = null;
  let zoom = null;

  /* ------------------------------------------------------------- boot */

  async function boot() {
    const me = await api.get('/api/auth/me');
    state.user = me.user;
    $('user-name').textContent = me.user.username;
    renderWarnings(me.warnings || []);

    player = new LivePlayer($('live-video'), { onStatus: onPlayerStatus });

    setupNav();
    setupLive();
    setupTimeline();
    setupRecordings();
    setupEvents();
    setupSnapshots();
    setupCameras();
    setupSettings();

    await loadCameras();
    connectUpdates();

    const views = ['live', 'timeline', 'recordings', 'events', 'snapshots', 'cameras', 'settings'];
    const initial = (location.hash || '#live').slice(1);
    showView(views.indexOf(initial) >= 0 ? initial : 'live');

    state.recordingTimer = setInterval(updateRecordingBadges, 1000);
  }

  function renderWarnings(warnings) {
    $('warnings').innerHTML = warnings
      .map((text) => `<div class="notice">${esc(text)}</div>`)
      .join('');
  }

  /* ------------------------------------------------------- navigation */

  function setupNav() {
    $('nav').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-view]');
      if (button) showView(button.dataset.view);
    });
    $('logout').addEventListener('click', async () => {
      await api.post('/api/auth/logout', {});
      location.href = '/login.html';
    });
    window.addEventListener('hashchange', () => {
      const view = location.hash.slice(1);
      if (view && view !== state.view) showView(view);
    });
  }

  function showView(view) {
    state.view = view;
    location.hash = view;
    document.querySelectorAll('.view').forEach((node) => node.classList.remove('active'));
    const section = $(`view-${view}`);
    if (section) section.classList.add('active');
    document.querySelectorAll('#nav button').forEach((button) => {
      button.classList.toggle('active', button.dataset.view === view);
    });

    if (view === 'timeline') {
      loadTimeline();
      loadActivity();
    }
    if (view === 'recordings') loadRecordings();
    if (view === 'events') loadEvents();
    if (view === 'snapshots') loadSnapshots();
    if (view === 'cameras') renderCameraCards();
    if (view === 'settings') loadSettings();
  }

  /* ---------------------------------------------------------- cameras */

  async function loadCameras() {
    const data = await api.get('/api/cameras');
    state.cameras = data.cameras;
    state.activeRecordings = {};
    data.cameras.forEach((camera) => {
      if (camera.active_recording) state.activeRecordings[camera.id] = camera.active_recording;
    });
    renderRail();
    renderCameraCards();
    fillCameraSelects();
    fillTimelineCameras();
    if (!state.activeCameraId && state.cameras.length) selectCamera(state.cameras[0].id);
    if (state.activeCameraId && !state.cameras.some((c) => c.id === state.activeCameraId)) {
      stopLive();
    }
  }

  function cameraById(id) {
    return state.cameras.filter((camera) => camera.id === Number(id))[0] || null;
  }

  function fillCameraSelects() {
    const options = state.cameras.map((camera) => `<option value="${camera.id}">${esc(camera.name)}</option>`).join('');
    ['rec-filter-camera', 'ev-filter-camera', 'snap-filter-camera'].forEach((id) => {
      const select = $(id);
      const current = select.value;
      const label = id === 'snap-filter-camera' ? 'All cameras' : 'All cameras';
      select.innerHTML = `<option value="">${label}</option>${options}`;
      select.value = current;
    });
  }

  function statusOf(camera) {
    if (!camera.enabled) return 'disabled';
    if (camera.status === 'online') return 'online';
    if (camera.status === 'degraded') return 'degraded';
    if (camera.status === 'offline' || camera.status === 'error') return 'offline';
    return '';
  }

  function renderRail() {
    const rail = $('camera-rail');
    if (!state.cameras.length) {
      rail.innerHTML = '<div class="empty">No cameras yet.<br /><br /><button class="btn primary sm" data-add-camera>Add camera</button></div>';
      return;
    }
    rail.innerHTML = state.cameras
      .map((camera) => {
        const recording = !!state.activeRecordings[camera.id];
        const dot = recording ? 'rec' : statusOf(camera);
        const sub = recording ? 'Recording…' : camera.status_message || camera.host;
        return `
          <div class="camera-rail-item ${camera.id === state.activeCameraId ? 'active' : ''}" data-camera="${camera.id}" title="Show ${esc(camera.name)} in the player (${esc(camera.host)})">
            <span class="status-dot ${dot}" title="${esc(camera.status)}"></span>
            <span class="meta">
              <div class="name">${esc(camera.name)}</div>
              <div class="sub">${esc(sub)}</div>
            </span>
          </div>`;
      })
      .join('');
  }

  /** How events are currently reaching us for this camera. */
  function eventChannelLabel(camera) {
    const labels = {
      pull: 'Pull point',
      push: 'Push notifications',
      off: 'Disabled',
    };
    const active = camera.event_channel;
    if (!active) return '<span class="muted">not connected</span>';
    const label = labels[active] || active;
    if (camera.event_channel_error) {
      return `<span class="pill off" title="${esc(camera.event_channel_error)}">${esc(label)} · problem</span>`;
    }
    return `<span class="pill ${active === 'off' ? 'off' : 'on'}">${esc(label)}</span>`;
  }

  function renderCameraCards() {
    const grid = $('camera-grid');
    if (!state.cameras.length) {
      grid.innerHTML = '<div class="empty">No cameras configured yet. Click “Add camera” to connect your first ONVIF camera.</div>';
      return;
    }
    grid.innerHTML = state.cameras
      .map((camera) => {
        const profile = (camera.profiles || []).filter((p) => p.token === camera.record_profile_token)[0];
        const resolution = profile && profile.width ? `${profile.width}×${profile.height} ${profile.encoding || ''}` : '—';
        return `
        <div class="card camera-card" data-camera-card="${camera.id}">
          <div class="card-head">
            <h3 style="display:flex;align-items:center;gap:8px;margin:0">
              <span class="status-dot ${statusOf(camera)}"></span>${esc(camera.name)}
            </h3>
            <span class="pill ${camera.enabled ? 'on' : 'off'}">${camera.enabled ? 'Enabled' : 'Disabled'}</span>
          </div>
          <div class="row"><span>Address</span><span class="mono">${esc(camera.host)}:${camera.onvif_port}</span></div>
          <div class="row"><span>Status</span><span>${esc(camera.status_message || camera.status)}</span></div>
          <div class="row"><span>Recording profile</span><span>${esc(resolution)}</span></div>
          <div class="row"><span>Record on event</span><span>${camera.record_on_event ? `Yes · ${camera.event_record_seconds}s` : 'No'}</span></div>
          <div class="row"><span>Events</span><span>${eventChannelLabel(camera)}</span></div>
          <div class="row"><span>Live viewers</span><span>${camera.live_viewers || 0}</span></div>
          <div class="row"><span>Last seen</span><span>${esc(ui.formatRelative(camera.last_seen_at))}</span></div>
          <div class="card-actions">
            <button class="btn sm" data-action="view" data-id="${camera.id}" title="Open this camera in the live view">Live</button>
            <button class="btn sm" data-action="edit" data-id="${camera.id}" title="Change address, credentials, recording and event settings">Edit</button>
            <button class="btn sm" data-action="refresh" data-id="${camera.id}" title="Ask the camera again for its profiles and stream URLs. Use this after changing settings on the camera itself.">Re-discover</button>
            <button class="btn sm" data-action="test-events" data-id="${camera.id}" title="Ask the camera to re-send its current detection state and report whether it reached us. Checks the event path without waiting for real motion.">Test events</button>
            <button class="btn sm danger" data-action="delete" data-id="${camera.id}" title="Remove this camera together with all of its recordings, snapshots and events">Delete</button>
          </div>
        </div>`;
      })
      .join('');
  }

  function setupCameras() {
    $('camera-add').addEventListener('click', () => openCameraModal(null));
    document.body.addEventListener('click', (event) => {
      if (event.target.closest('[data-add-camera]')) openCameraModal(null);
    });

    $('camera-grid').addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const id = Number(button.dataset.id);
      const camera = cameraById(id);
      if (!camera) return;

      if (button.dataset.action === 'view') {
        showView('live');
        selectCamera(id);
        return;
      }
      if (button.dataset.action === 'edit') return openCameraModal(camera);
      if (button.dataset.action === 'refresh') {
        button.disabled = true;
        try {
          await api.post(`/api/cameras/${id}/refresh`, {});
          ui.toast('Camera re-discovered', 'success');
          await loadCameras();
        } catch (err) {
          ui.toast(err.message, 'error');
        } finally {
          button.disabled = false;
        }
        return;
      }
      if (button.dataset.action === 'test-events') {
        const original = button.textContent;
        button.disabled = true;
        button.textContent = 'Testing…';
        try {
          const result = await api.post(`/api/cameras/${id}/events/test`, {});
          if (result.ok) {
            ui.toast(`Events work: ${result.notifications_received} notification(s) via ${result.channel}`, 'success');
          } else {
            ui.openModal({
              title: 'No notifications received',
              body: `<p>The camera accepted the request but nothing arrived within 6 seconds.</p>
                     <p class="hint">Channel: <strong>${esc(result.channel || 'unknown')}</strong><br />
                     ${result.consumer_url ? `Callback URL the camera was given:<br /><span class="mono">${esc(result.consumer_url)}</span>` : ''}</p>
                     <p>In push mode the camera has to open a connection back to this server. Check that
                     the address above is reachable from the camera's network, that detection is enabled
                     in the Tapo app, and set <span class="mono">PUBLIC_URL</span> if this server sits
                     behind Docker or NAT.</p>`,
              buttons: [{ label: 'Close' }],
            });
          }
          await loadCameras();
        } catch (err) {
          ui.toast(err.message, 'error');
        } finally {
          button.disabled = false;
          button.textContent = original;
        }
        return;
      }
      if (button.dataset.action === 'delete') {
        const ok = await ui.confirmModal(
          'Delete camera',
          `Delete “${camera.name}” together with all of its recordings, snapshots and events? This cannot be undone.`
        );
        if (!ok) return;
        try {
          await api.del(`/api/cameras/${id}`);
          if (state.activeCameraId === id) stopLive();
          ui.toast('Camera deleted', 'success');
          await loadCameras();
        } catch (err) {
          ui.toast(err.message, 'error');
        }
      }
    });
  }

  function openCameraModal(camera) {
    const isEdit = !!camera;
    const values = camera || {
      name: '',
      host: '',
      onvif_port: 2020,
      username: '',
      rtsp_transport: 'tcp',
      enabled: true,
      record_on_event: true,
      snapshot_on_event: false,
      event_mode: 'auto',
      event_record_seconds: 30,
      max_record_seconds: 900,
      record_audio: true,
      profiles: [],
      live_profile_token: '',
      record_profile_token: '',
    };

    const profileOptions = (selected) =>
      (values.profiles || [])
        .map(
          (p) =>
            `<option value="${esc(p.token)}" ${p.token === selected ? 'selected' : ''}>${esc(p.name)} · ${p.width || '?'}×${p.height || '?'} ${esc(p.encoding || '')}</option>`
        )
        .join('');

    const body = `
      <div class="grid-2">
        <div class="field"><label>Name</label><input type="text" id="cam-name" value="${esc(values.name)}" placeholder="Front door" title="Any label you like. It is used in the camera list and in recording file names." /></div>
        <div class="field"><label>Host / IP</label><input type="text" id="cam-host" value="${esc(values.host)}" placeholder="192.168.1.50" title="The camera's address on your network. Give it a fixed or reserved IP so it does not move." /></div>
      </div>
      <div class="grid-2">
        <div class="field"><label>ONVIF port</label><input type="number" id="cam-port" value="${values.onvif_port}" title="Port the camera serves ONVIF on. Tapo uses 2020; most other brands use 80 or 8000." /></div>
        <div class="field"><label>RTSP transport</label>
          <select id="cam-transport" title="How the video is carried. TCP is reliable and works through most networks; UDP has slightly lower latency but drops frames on a busy or distant link.">
            <option value="tcp" ${values.rtsp_transport === 'tcp' ? 'selected' : ''}>TCP (recommended)</option>
            <option value="udp" ${values.rtsp_transport === 'udp' ? 'selected' : ''}>UDP</option>
          </select>
        </div>
      </div>
      <div class="grid-2">
        <div class="field"><label>Username</label><input type="text" id="cam-user" value="${esc(values.username || '')}" autocomplete="off" title="The camera account used for ONVIF and RTSP. On Tapo this is the Camera Account, not your TP-Link login." /></div>
        <div class="field"><label>Password</label><input type="password" id="cam-pass" placeholder="${isEdit ? 'unchanged' : ''}" autocomplete="new-password" title="${isEdit ? 'Leave empty to keep the stored password. It is encrypted in the database.' : 'Stored encrypted in the database.'}" /></div>
      </div>
      <p class="hint">Tapo cameras: enable ONVIF and create a <strong>Camera Account</strong> in the Tapo app (Settings → Advanced → Camera Account). Default ONVIF port is 2020.</p>

      <div class="field" style="margin-top:14px">
        <button class="btn" id="cam-test" type="button" title="Connect right now with the details above and list the camera's video profiles. Nothing is saved until you press Save.">Test connection &amp; load profiles</button>
        <span id="cam-test-result" class="hint"></span>
      </div>

      <div class="grid-2">
        <div class="field"><label>Live view profile</label><select id="cam-live-profile" title="Stream shown in the live view. Auto picks the smallest one, which is easier on the network and leaves the camera free for recording."><option value="">Auto (lowest)</option>${profileOptions(values.live_profile_token)}</select></div>
        <div class="field"><label>Recording profile</label><select id="cam-record-profile" title="Stream written to disk. Auto picks the highest resolution the camera offers."><option value="">Auto (highest)</option>${profileOptions(values.record_profile_token)}</select></div>
      </div>

      <div class="grid-2">
        <div class="field"><label>Stop event recording after (s)</label><input type="number" id="cam-event-seconds" min="5" max="3600" value="${values.event_record_seconds}" title="How long to keep recording after the last detection. Each new event restarts this countdown, so continuous motion keeps one recording going." /></div>
        <div class="field"><label>Max file length (s)</label><input type="number" id="cam-max-seconds" min="30" max="21600" value="${values.max_record_seconds}" title="A recording is rolled over into a new file once it reaches this length, so single files stay manageable. Recording itself is not interrupted." /></div>
      </div>
      <div class="field"><label class="checkbox" title="When the camera reports motion or a person, start recording on its own and stop again after the delay above."><input type="checkbox" id="cam-on-event" ${values.record_on_event ? 'checked' : ''} /> Record automatically on ONVIF detection events</label></div>
      <div class="field">
        <label>Event delivery</label>
        <select id="cam-event-mode" title="How detection events reach this app. Pull point means we poll the camera; push means the camera posts events to us. Tapo firmware accepts a pull point but resets every poll, so it needs push.">
          <option value="auto" ${values.event_mode === 'auto' ? 'selected' : ''}>Automatic - pull point, fall back to push</option>
          <option value="pull" ${values.event_mode === 'pull' ? 'selected' : ''}>Pull point only</option>
          <option value="push" ${values.event_mode === 'push' ? 'selected' : ''}>Push notifications only</option>
          <option value="off" ${values.event_mode === 'off' ? 'selected' : ''}>Do not subscribe to events</option>
        </select>
        <p class="hint">Tapo cameras accept a pull-point subscription but reset every poll, so they need push. In push mode the camera posts events back to this server, so set <code>PUBLIC_URL</code> when running in Docker.</p>
      </div>
      <div class="field"><label class="checkbox" title="Save a still image with each detection, so the Events list can be scanned by eye. Each one opens a short connection to the camera, and repeats within 15 seconds are skipped."><input type="checkbox" id="cam-snapshot-event" ${values.snapshot_on_event ? 'checked' : ''} /> Save a snapshot when a detection happens</label></div>
      <div class="field"><label class="checkbox" title="Include the camera's microphone in recordings, re-encoded to AAC. Ignored if the stream carries no audio. The live view is always silent."><input type="checkbox" id="cam-audio" ${values.record_audio ? 'checked' : ''} /> Record audio (when the camera provides it)</label></div>
      <div class="field"><label class="checkbox" title="Untick to leave the camera configured but stop connecting to it: no events, no automatic recording. Stored recordings are kept."><input type="checkbox" id="cam-enabled" ${values.enabled ? 'checked' : ''} /> Enabled (connect and listen for events)</label></div>
    `;

    const modal = ui.openModal({
      title: isEdit ? `Edit ${camera.name}` : 'Add camera',
      body,
      buttons: [
        { label: 'Cancel' },
        {
          label: isEdit ? 'Save' : 'Add camera',
          className: 'primary',
          onClick: async () => {
            const payload = collect();
            if (!payload.name || !payload.host) {
              ui.toast('Name and host are required', 'error');
              return false;
            }
            if (isEdit) await api.put(`/api/cameras/${camera.id}`, payload);
            else await api.post('/api/cameras', payload);
            ui.toast(isEdit ? 'Camera saved' : 'Camera added', 'success');
            await loadCameras();
            return true;
          },
        },
      ],
    });

    function collect() {
      return {
        name: modal.querySelector('#cam-name').value.trim(),
        host: modal.querySelector('#cam-host').value.trim(),
        onvif_port: Number(modal.querySelector('#cam-port').value) || 2020,
        username: modal.querySelector('#cam-user').value.trim(),
        password: modal.querySelector('#cam-pass').value,
        rtsp_transport: modal.querySelector('#cam-transport').value,
        live_profile_token: modal.querySelector('#cam-live-profile').value,
        record_profile_token: modal.querySelector('#cam-record-profile').value,
        event_record_seconds: Number(modal.querySelector('#cam-event-seconds').value) || 30,
        max_record_seconds: Number(modal.querySelector('#cam-max-seconds').value) || 900,
        record_on_event: modal.querySelector('#cam-on-event').checked,
        snapshot_on_event: modal.querySelector('#cam-snapshot-event').checked,
        event_mode: modal.querySelector('#cam-event-mode').value,
        record_audio: modal.querySelector('#cam-audio').checked,
        enabled: modal.querySelector('#cam-enabled').checked,
      };
    }

    modal.querySelector('#cam-test').addEventListener('click', async () => {
      const result = modal.querySelector('#cam-test-result');
      const button = modal.querySelector('#cam-test');
      result.textContent = 'Connecting…';
      button.disabled = true;
      try {
        const payload = collect();
        if (isEdit) payload.camera_id = camera.id;
        const info = await api.post('/api/cameras/probe', payload);
        const device = info.device || {};
        result.innerHTML =
          `<span style="color:var(--success)">Connected</span> · ` +
          esc([device.manufacturer, device.model, device.firmwareVersion].filter(Boolean).join(' ') || 'ONVIF device') +
          ` · ${info.profiles.length} profile(s)`;
        const fill = (select, selected) => {
          select.innerHTML =
            `<option value="">Auto</option>` +
            info.profiles
              .map(
                (p) =>
                  `<option value="${esc(p.token)}" ${p.token === selected ? 'selected' : ''}>${esc(p.name)} · ${p.width || '?'}×${p.height || '?'} ${esc(p.encoding || '')}</option>`
              )
              .join('');
        };
        fill(modal.querySelector('#cam-live-profile'), info.live_profile_token);
        fill(modal.querySelector('#cam-record-profile'), info.record_profile_token);
      } catch (err) {
        result.innerHTML = `<span style="color:#fca5a5">${esc(err.message)}</span>`;
      } finally {
        button.disabled = false;
      }
    });
  }

  /* ------------------------------------------------------------- live */

  function setupLive() {
    $('camera-rail').addEventListener('click', (event) => {
      const item = event.target.closest('[data-camera]');
      if (item) selectCamera(Number(item.dataset.camera));
    });

    $('btn-pause').addEventListener('click', () => {
      player.togglePause();
      updateLiveControls();
    });

    $('btn-golive').addEventListener('click', () => {
      if (player.paused) player.resume();
      else player.open(state.activeCameraId, $('quality').value);
      updateLiveControls();
    });

    $('quality').addEventListener('change', () => {
      if (state.activeCameraId) player.open(state.activeCameraId, $('quality').value);
    });

    $('btn-snapshot').addEventListener('click', takeSnapshot);
    $('btn-record').addEventListener('click', toggleRecording);

    $('btn-fullscreen').addEventListener('click', () => {
      const stage = $('player-stage');
      if (document.fullscreenElement) document.exitFullscreen();
      else if (stage.requestFullscreen) stage.requestFullscreen();
    });

    // Scroll wheel / pinch to zoom, drag to move, double click to reset.
    zoom = new ZoomPan($('player-stage'), $('live-video'), onZoomChange);
    $('btn-zoom-in').addEventListener('click', () => zoom.zoomBy(1.4));
    $('btn-zoom-out').addEventListener('click', () => zoom.zoomBy(1 / 1.4));
    $('btn-zoom-reset').addEventListener('click', () => zoom.reset());
    onZoomChange(zoom.scale);

    $('btn-image').addEventListener('click', openImageModal);

    $('btn-info').addEventListener('click', () => {
      state.showInfo = !state.showInfo;
      $('stream-info').classList.toggle('on', state.showInfo);
      $('btn-info').classList.toggle('primary', state.showInfo);
      try {
        localStorage.setItem('showInfo', state.showInfo ? '1' : '0');
      } catch (err) {
        /* ignore */
      }
      renderStreamInfo();
    });

    try {
      state.showInfo = localStorage.getItem('showInfo') === '1';
      $('stream-info').classList.toggle('on', state.showInfo);
      $('btn-info').classList.toggle('primary', state.showInfo);
      const storedVolume = Number(localStorage.getItem('volume'));
      if (Number.isFinite(storedVolume) && storedVolume > 0) $('volume').value = storedVolume;
    } catch (err) {
      /* ignore */
    }

    $('volume').addEventListener('input', () => applyVolume(Number($('volume').value)));
    $('btn-mute').addEventListener('click', () => {
      const current = Number($('volume').value);
      if (current > 0) {
        state.lastVolume = current;
        $('volume').value = 0;
        applyVolume(0);
      } else {
        const restored = state.lastVolume || 60;
        $('volume').value = restored;
        applyVolume(restored);
      }
    });

    document.addEventListener('pointerdown', noteInteraction, { once: true });
    document.addEventListener('keydown', noteInteraction, { once: true });

    setInterval(renderStreamInfo, 1000);
  }

  /**
   * Browsers refuse to autoplay a stream with sound until the user has
   * interacted with the page, and a blocked play() leaves a black picture. So a
   * remembered volume is shown on the slider but only applied once we have a
   * genuine interaction.
   */
  function applyVolume(percent) {
    const effective = state.userInteracted ? percent : 0;
    if (player) player.setVolume(effective / 100);
    $('btn-mute').textContent = effective > 0 ? '🔊' : '🔇';
    $('btn-mute').title = state.userInteracted
      ? 'Mute or unmute the live sound'
      : 'Click anywhere first – browsers only allow sound after you interact with the page';
    try {
      localStorage.setItem('volume', String(percent));
    } catch (err) {
      /* ignore */
    }
  }

  function noteInteraction() {
    if (state.userInteracted) return;
    state.userInteracted = true;
    applyVolume(Number($('volume').value));
  }

  /** Live measurements of the stream currently on screen. */
  function renderStreamInfo() {
    if (!state.showInfo) return;
    const box = $('stream-info');
    if (!state.activeCameraId || !player) {
      box.textContent = '';
      return;
    }
    const stats = player.getStats();
    const rows = [
      ['Stream', stats.quality === 'main' ? 'main (full resolution)' : 'sub (low resolution)'],
      ['Codec', stats.codec || '—'],
      ['Resolution', stats.width ? `${stats.width}×${stats.height}` : '—'],
      ['Frame rate', stats.fps ? `${stats.fps.toFixed(1)} fps` : '—'],
      ['Bitrate', stats.bitrate ? formatBits(stats.bitrate) : '—'],
      ['Audio', stats.hasAudio ? (stats.volume > 0 ? `on, ${Math.round(stats.volume * 100)}%` : 'muted') : 'none'],
      ['Buffer', `${stats.buffered.toFixed(1)} s`],
      ['Received', ui.formatBytes(stats.totalBytes)],
    ];
    if (stats.dropped !== null) rows.push(['Dropped', `${stats.dropped} frames`]);
    box.innerHTML = rows.map(([key, value]) => `<div><b>${esc(key)}</b>${esc(value)}</div>`).join('');
  }

  function formatBits(bitsPerSecond) {
    if (bitsPerSecond >= 1000000) return `${(bitsPerSecond / 1000000).toFixed(2)} Mbit/s`;
    return `${Math.round(bitsPerSecond / 1000)} kbit/s`;
  }

  /* ------------------------------------------------ picture adjustments */

  const PREVIEW_NEUTRAL = { brightness: 100, contrast: 100, saturation: 100, gamma: 100 };

  /** Preview tweaks are per camera and per browser – nothing is sent anywhere. */
  function previewSettings(cameraId) {
    try {
      const raw = localStorage.getItem(`preview:${cameraId}`);
      return Object.assign({}, PREVIEW_NEUTRAL, raw ? JSON.parse(raw) : {});
    } catch (err) {
      return Object.assign({}, PREVIEW_NEUTRAL);
    }
  }

  function savePreviewSettings(cameraId, values) {
    try {
      const isNeutral = Object.keys(PREVIEW_NEUTRAL).every((key) => Number(values[key]) === PREVIEW_NEUTRAL[key]);
      if (isNeutral) localStorage.removeItem(`preview:${cameraId}`);
      else localStorage.setItem(`preview:${cameraId}`, JSON.stringify(values));
    } catch (err) {
      /* private mode – adjustments simply will not persist */
    }
  }

  function applyPreviewSettings(values) {
    const parts = [];
    const gamma = Number(values.gamma) / 100;
    if (Math.abs(gamma - 1) > 0.001) {
      document.querySelectorAll('#cr-gamma feFuncR, #cr-gamma feFuncG, #cr-gamma feFuncB').forEach((node) => {
        node.setAttribute('exponent', String(gamma));
      });
      parts.push('url(#cr-gamma)');
    }
    if (Number(values.brightness) !== 100) parts.push(`brightness(${Number(values.brightness) / 100})`);
    if (Number(values.contrast) !== 100) parts.push(`contrast(${Number(values.contrast) / 100})`);
    if (Number(values.saturation) !== 100) parts.push(`saturate(${Number(values.saturation) / 100})`);
    $('live-video').style.filter = parts.join(' ');
  }

  function slider(id, label, value, min, max, step, suffix, tooltip) {
    return `
      <div class="slider-row">
        <label for="${id}" title="${esc(tooltip)}">${esc(label)}</label>
        <input type="range" id="${id}" min="${min}" max="${max}" step="${step || 1}" value="${value}" title="${esc(tooltip)}" />
        <output for="${id}">${esc(String(value))}${esc(suffix || '')}</output>
      </div>`;
  }

  async function openImageModal() {
    const cameraId = state.activeCameraId;
    if (!cameraId) return;
    const camera = cameraById(cameraId);
    const preview = previewSettings(cameraId);

    const body = document.createElement('div');
    body.innerHTML = `
      <div class="modal-section">
        <h3>This preview only</h3>
        <p class="section-note">Applied in your browser to what you see now. Recordings and snapshots keep the
          camera's original picture, and other devices are unaffected.</p>
        ${slider('pv-brightness', 'Brightness', preview.brightness, 20, 250, 1, '%', 'Lightens or darkens the whole picture. 100% is untouched.')}
        ${slider('pv-contrast', 'Contrast', preview.contrast, 20, 250, 1, '%', 'Spreads light and dark further apart. 100% is untouched.')}
        ${slider('pv-saturation', 'Saturation', preview.saturation, 0, 250, 1, '%', 'Colour intensity. 0% is black and white, 100% is untouched.')}
        ${slider('pv-gamma', 'Gamma', preview.gamma, 40, 250, 1, '%', 'Brightens mid tones without blowing out highlights. Below 100% lifts shadows, above 100% deepens them. Useful for a dark garden at night.')}
        <button class="btn sm" id="pv-reset" title="Put every preview slider back to neutral">Reset preview</button>
      </div>
      <div class="modal-section" id="cam-imaging">
        <h3>Camera settings</h3>
        <p class="section-note">Stored in the camera itself, so these change the recordings too and apply to every
          viewer. <span id="imaging-state">Loading…</span></p>
      </div>`;

    const modal = ui.openModal({
      title: `Image · ${camera ? camera.name : ''}`,
      body,
      buttons: [{ label: 'Close' }],
      onClose: () => savePreviewSettings(cameraId, current()),
    });

    function current() {
      return {
        brightness: Number(modal.querySelector('#pv-brightness').value),
        contrast: Number(modal.querySelector('#pv-contrast').value),
        saturation: Number(modal.querySelector('#pv-saturation').value),
        gamma: Number(modal.querySelector('#pv-gamma').value),
      };
    }

    modal.querySelectorAll('#pv-brightness, #pv-contrast, #pv-saturation, #pv-gamma').forEach((input) => {
      input.addEventListener('input', () => {
        modal.querySelector(`output[for="${input.id}"]`).textContent = `${input.value}%`;
        applyPreviewSettings(current());
      });
    });

    modal.querySelector('#pv-reset').addEventListener('click', () => {
      Object.keys(PREVIEW_NEUTRAL).forEach((key) => {
        const input = modal.querySelector(`#pv-${key}`);
        input.value = PREVIEW_NEUTRAL[key];
        modal.querySelector(`output[for="${input.id}"]`).textContent = `${PREVIEW_NEUTRAL[key]}%`;
      });
      applyPreviewSettings(PREVIEW_NEUTRAL);
    });

    /* --- camera side, loaded separately so a failure stays contained --- */
    const section = modal.querySelector('#cam-imaging');
    try {
      const imaging = await api.get(`/api/cameras/${cameraId}/imaging`);
      if (!imaging.fields.length) {
        modal.querySelector('#imaging-state').textContent = 'This camera does not expose any adjustable image settings.';
        return;
      }
      const tips = {
        brightness: 'Sensor brightness. Raising it also raises noise in the dark.',
        contrast: 'Difference between light and dark areas as the camera encodes it.',
        colorSaturation: 'Colour intensity in the encoded stream.',
        sharpness: 'Edge sharpening applied by the camera. Too much adds halos.',
      };
      section.innerHTML =
        `<h3>Camera settings</h3>
         <p class="section-note">Stored in the camera itself, so these change the recordings too and apply to
           every viewer.</p>` +
        imaging.fields
          .map((field) =>
            slider(`im-${field.key}`, field.label, field.value, field.min, field.max, 1, '', tips[field.key] || `Range ${field.min}–${field.max}`)
          )
          .join('') +
        `<button class="btn primary" id="im-apply" title="Send these values to the camera and keep them there">Apply to camera</button>
         <button class="btn" id="im-revert" title="Put the sliders back to the values the camera currently has">Undo changes</button>`;

      const readImaging = () => {
        const values = {};
        imaging.fields.forEach((field) => {
          values[field.key] = Number(section.querySelector(`#im-${field.key}`).value);
        });
        return values;
      };
      section.querySelectorAll('input[type=range]').forEach((input) => {
        input.addEventListener('input', () => {
          section.querySelector(`output[for="${input.id}"]`).textContent = input.value;
        });
      });
      section.querySelector('#im-revert').addEventListener('click', () => {
        imaging.fields.forEach((field) => {
          const input = section.querySelector(`#im-${field.key}`);
          input.value = field.value;
          section.querySelector(`output[for="${input.id}"]`).textContent = String(field.value);
        });
      });
      section.querySelector('#im-apply').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          const updated = await api.put(`/api/cameras/${cameraId}/imaging`, readImaging());
          updated.fields.forEach((field) => {
            const original = imaging.fields.filter((f) => f.key === field.key)[0];
            if (original) original.value = field.value;
          });
          ui.toast('Camera image settings applied', 'success');
        } catch (err) {
          ui.toast(err.message, 'error');
        } finally {
          button.disabled = false;
        }
      });
    } catch (err) {
      const stateNode = modal.querySelector('#imaging-state');
      if (stateNode) stateNode.textContent = `Not available: ${err.message}`;
    }
  }

  function onZoomChange(scale) {
    $('zoom-level').textContent = `${scale.toFixed(1)}×`;
    $('btn-zoom-out').disabled = scale <= 1;
    $('btn-zoom-reset').disabled = scale <= 1;
    $('btn-zoom-in').disabled = scale >= 8;
  }

  function selectCamera(id) {
    const camera = cameraById(id);
    if (!camera) return;
    state.activeCameraId = id;
    renderRail();
    if (zoom) zoom.reset();
    applyPreviewSettings(previewSettings(id));
    player.open(id, $('quality').value);
    applyVolume(Number($('volume').value));
    updateLiveControls();
    loadLiveSidePanels();
  }

  function stopLive() {
    state.activeCameraId = null;
    if (player) player.close();
    updateLiveControls();
  }

  function onPlayerStatus(stateName, message) {
    const overlay = $('live-overlay');
    const texts = {
      connecting: 'Connecting to camera…',
      reconnecting: 'Reconnecting…',
      disconnected: 'Connection lost, retrying…',
      idle: state.activeCameraId ? 'Stopped' : 'Select a camera to start the live view',
      paused: '',
      live: '',
      error: message || 'Stream error',
    };
    const text = texts[stateName] !== undefined ? texts[stateName] : stateName;
    overlay.textContent = message && stateName === 'error' ? message : text;
    overlay.style.display = text || message ? 'flex' : 'none';
    updateLiveControls();
  }

  function updateLiveControls() {
    const hasCamera = !!state.activeCameraId;
    const recording = hasCamera && !!state.activeRecordings[state.activeCameraId];
    $('btn-pause').disabled = !hasCamera;
    $('btn-golive').disabled = !hasCamera;
    $('btn-snapshot').disabled = !hasCamera;
    $('btn-record').disabled = !hasCamera;
    $('btn-image').disabled = !hasCamera;
    $('btn-info').disabled = !hasCamera;
    $('btn-mute').disabled = !hasCamera;
    $('volume').disabled = !hasCamera;
    $('btn-pause').textContent = player && player.paused ? 'Play' : 'Pause';
    $('btn-record').textContent = recording ? 'Stop recording' : 'Record';
    $('btn-record').classList.toggle('rec', !recording);
    $('btn-record').classList.toggle('danger', recording);
    renderBadges();
  }

  function renderBadges() {
    const badges = [];
    if (state.activeCameraId) {
      if (player && player.paused) badges.push('<span class="badge paused">PAUSED</span>');
      else if (player && player.state === 'live') badges.push('<span class="badge live">LIVE</span>');
      const active = state.activeRecordings[state.activeCameraId];
      if (active) {
        badges.push(`<span class="badge recording">REC ${esc(elapsed(active.started_at))}</span>`);
      }
    }
    $('live-badges').innerHTML = badges.join('');
  }

  function elapsed(startedAt) {
    const date = ui.parseDate(startedAt);
    if (!date) return '';
    return ui.formatDuration((Date.now() - date.getTime()) / 1000);
  }

  function updateRecordingBadges() {
    if (state.activeCameraId && state.activeRecordings[state.activeCameraId]) renderBadges();
  }

  async function takeSnapshot() {
    const cameraId = state.activeCameraId;
    if (!cameraId) return;
    const button = $('btn-snapshot');
    button.disabled = true;
    try {
      const blob = await player.captureFrame();
      let result;
      if (blob) result = await api.postBlob(`/api/snapshots?camera_id=${cameraId}`, blob, 'image/jpeg');
      else result = await api.post(`/api/cameras/${cameraId}/snapshot`, {});
      ui.toast(`Snapshot saved (${ui.formatBytes(result.snapshot.size_bytes)})`, 'success');
      if (state.view === 'snapshots') loadSnapshots();
    } catch (err) {
      ui.toast(err.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function toggleRecording() {
    const cameraId = state.activeCameraId;
    if (!cameraId) return;
    const button = $('btn-record');
    const recording = !!state.activeRecordings[cameraId];
    button.disabled = true;
    try {
      if (recording) {
        await api.post(`/api/cameras/${cameraId}/recording/stop`, {});
        delete state.activeRecordings[cameraId];
        ui.toast('Recording stopped', 'success');
      } else {
        const result = await api.post(`/api/cameras/${cameraId}/recording/start`, {});
        state.activeRecordings[cameraId] = result.active;
        ui.toast('Recording started', 'success');
      }
      renderRail();
      loadLiveSidePanels();
    } catch (err) {
      ui.toast(err.message, 'error');
    } finally {
      button.disabled = false;
      updateLiveControls();
    }
  }

  async function loadLiveSidePanels() {
    const cameraId = state.activeCameraId;
    if (!cameraId) return;
    try {
      const [events, recordings] = await Promise.all([
        api.get(`/api/events?camera_id=${cameraId}&limit=8`),
        api.get(`/api/recordings?camera_id=${cameraId}&limit=6`),
      ]);
      $('live-events-count').textContent = `${events.total} total`;
      $('live-events').innerHTML = events.events.length
        ? events.events
            .map(
              (event) => `
              <div class="row" style="display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid var(--border)">
                <span>${esc(event.label || event.type)} ${event.state === 0 ? '<span class="muted">(ended)</span>' : ''}</span>
                <span class="muted mono" style="white-space:nowrap">${esc(ui.formatDateTime(event.received_at))}
                  <span style="opacity:.65">· ${esc(ui.formatAgo(event.received_at))}</span>
                </span>
              </div>`
            )
            .join('')
        : '<div class="empty">No events yet</div>';

      $('live-recordings').innerHTML = recordings.recordings.length
        ? recordings.recordings
            .map(
              (rec) => `
              <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border)">
                <span>
                  <a href="#" data-play-recording="${rec.id}">${esc(ui.formatDateTime(rec.started_at))}</a>
                  <span class="pill ${esc(rec.trigger_type)}" style="margin-left:6px">${esc(rec.trigger_type)}</span>
                </span>
                <span class="muted">${rec.status === 'recording' ? 'recording…' : ui.formatDuration(rec.duration_seconds)}</span>
              </div>`
            )
            .join('')
        : '<div class="empty">No recordings yet</div>';
    } catch (err) {
      /* the toast would be noise here */
    }
  }

  document.body.addEventListener('click', (event) => {
    const link = event.target.closest('[data-play-recording]');
    if (link) {
      event.preventDefault();
      playRecording(Number(link.dataset.playRecording));
    }
  });

  /* --------------------------------------------------------- timeline */

  function setupTimeline() {
    $('tl-date').value = todayKey();

    $('tl-prev').addEventListener('click', () => shiftDay(-1));
    $('tl-next').addEventListener('click', () => shiftDay(1));
    $('tl-today').addEventListener('click', () => {
      $('tl-date').value = todayKey();
      loadTimeline();
    });
    $('tl-date').addEventListener('change', loadTimeline);
    $('tl-camera').addEventListener('change', () => {
      loadTimeline();
      loadActivity();
    });
    $('tl-activity-days').addEventListener('change', loadActivity);

    const track = $('tl-track');

    track.addEventListener('click', (event) => {
      const block = event.target.closest('[data-recording]');
      if (block) return playRecording(Number(block.dataset.recording));
      const mark = event.target.closest('[data-event-recording]');
      if (mark) return playRecording(Number(mark.dataset.eventRecording));
      // A short recording is only a couple of pixels wide, so treat a click
      // near one as a click on it.
      const nearest = nearestRecording(trackFraction(event, track));
      if (nearest) playRecording(nearest.id);
    });

    track.addEventListener('pointermove', (event) => {
      const day = state.timeline;
      if (!day) return;
      const fraction = trackFraction(event, track);
      const hover = $('tl-hover');
      hover.style.left = `${fraction * 100}%`;
      const at = new Date(day.start + fraction * day.length);
      const pad = (value) => String(value).padStart(2, '0');
      const nearest = nearestRecording(fraction);
      hover.querySelector('span').textContent =
        `${pad(at.getHours())}:${pad(at.getMinutes())}` + (nearest ? ` · ${nearest.hint}` : '');
      hover.classList.toggle('flip', fraction > 0.88);
      hover.classList.toggle('flip-start', fraction < 0.12);
    });

    $('tl-day-chart').addEventListener('click', (event) => {
      const bar = event.target.closest('[data-day]');
      if (!bar) return;
      $('tl-date').value = bar.dataset.day;
      loadTimeline();
    });
  }

  function trackFraction(event, element) {
    const rect = element.getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  }

  /**
   * Recording under (or closest to) a point on the day track. Blocks for short
   * recordings are too thin to hit reliably, so anything within a few minutes
   * counts as a hit.
   */
  function nearestRecording(fraction) {
    const day = state.timeline;
    if (!day || !day.blocks.length) return null;
    const at = day.start + fraction * day.length;
    const tolerance = day.length * 0.02; // ~29 minutes on a 24 hour band

    let best = null;
    let bestDistance = Infinity;
    for (const block of day.blocks) {
      const distance = at < block.from ? block.from - at : at > block.to ? at - block.to : 0;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = block;
      }
    }
    return best && bestDistance <= tolerance ? best : null;
  }

  function todayKey() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  function shiftDay(days) {
    const parts = ($('tl-date').value || todayKey()).split('-');
    const date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    date.setDate(date.getDate() + days);
    const pad = (value) => String(value).padStart(2, '0');
    $('tl-date').value = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    loadTimeline();
  }

  function fillTimelineCameras() {
    const select = $('tl-camera');
    const current = select.value;
    select.innerHTML =
      '<option value="">All cameras</option>' +
      state.cameras.map((camera) => `<option value="${camera.id}">${esc(camera.name)}</option>`).join('');
    if (current) select.value = current;
    else if (state.activeCameraId) select.value = String(state.activeCameraId);
  }

  async function loadTimeline() {
    const params = new URLSearchParams();
    if ($('tl-camera').value) params.set('camera_id', $('tl-camera').value);
    params.set('date', $('tl-date').value || todayKey());

    let data;
    try {
      data = await api.get(`/api/timeline?${params.toString()}`);
    } catch (err) {
      return ui.toast(err.message, 'error');
    }

    const dayStart = new Date(data.from).getTime();
    const dayLength = new Date(data.to).getTime() - dayStart;
    const position = (iso) => ((new Date(iso).getTime() - dayStart) / dayLength) * 100;

    // Kept so hovering and clicking the track can work in real time.
    state.timeline = {
      start: dayStart,
      length: dayLength,
      blocks: data.recordings.map((rec) => ({
        id: rec.id,
        from: new Date(rec.started_at).getTime(),
        to: new Date(rec.ended_at || new Date().toISOString()).getTime(),
        hint: `${rec.trigger_type} ${rec.status === 'recording' ? 'recording now' : ui.formatDuration(rec.duration_seconds)}`,
      })),
    };

    const dayDate = new Date(dayStart);
    const dayText = ui.formatDateTime(dayDate.toISOString()).split(' ')[0];
    const weekday = dayDate.toLocaleDateString(undefined, { weekday: 'long' });
    const isToday = ui.formatDateTime(new Date().toISOString()).split(' ')[0] === dayText;
    $('tl-day-title').textContent = `Day at a glance · ${weekday} ${dayText}${isToday ? ' (today)' : ''}`;
    $('tl-hour-title').textContent = `Events per hour · ${dayText}`;

    $('tl-grid').innerHTML = new Array(24).fill('<span></span>').join('');
    $('tl-hours').innerHTML = new Array(12)
      .fill(0)
      .map((_, i) => `<span>${String(i * 2).padStart(2, '0')}:00</span>`)
      .join('');

    $('tl-blocks').innerHTML = data.recordings
      .map((rec) => {
        const left = Math.max(0, position(rec.started_at));
        const endIso = rec.ended_at || new Date().toISOString();
        const width = Math.max(0.25, Math.min(100 - left, position(endIso) - left));
        const label =
          `${rec.camera_name || ''} ${ui.formatDateTime(rec.started_at)} · ` +
          `${rec.status === 'recording' ? 'still recording' : ui.formatDuration(rec.duration_seconds)} · ` +
          `${rec.trigger_type} · ${ui.formatBytes(rec.size_bytes)}`;
        const classes = ['day-block', rec.trigger_type === 'event' ? 'event' : '', rec.status].filter(Boolean).join(' ');
        return `<div class="${esc(classes)}" style="left:${left}%;width:${width}%" data-recording="${rec.id}" title="${esc(label)}"></div>`;
      })
      .join('');

    $('tl-events').innerHTML = data.events
      .map((event) => {
        const left = Math.max(0, Math.min(100, position(event.received_at)));
        const label = `${ui.formatDateTime(event.received_at)} · ${event.label || event.type}${event.state === 0 ? ' (ended)' : ''}`;
        const attr = event.recording_id ? ` data-event-recording="${event.recording_id}"` : '';
        return `<div class="day-mark ${event.state === 0 ? 'ended' : ''}" style="left:${left}%"${attr} title="${esc(label)}"></div>`;
      })
      .join('');

    // Red "now" line, only while looking at today.
    const now = Date.now();
    const nowLine = $('tl-now');
    if (now >= dayStart && now <= dayStart + dayLength) {
      nowLine.style.display = 'block';
      nowLine.style.left = `${((now - dayStart) / dayLength) * 100}%`;
    } else {
      nowLine.style.display = 'none';
    }

    $('tl-summary').textContent =
      `${data.totals.recordings} recording(s) · ${ui.formatDuration(data.totals.recorded_seconds)} recorded · ` +
      `${data.totals.events} event(s)`;

    const busiest = data.hours.reduce((best, entry) => (entry.events > best.events ? entry : best), data.hours[0]);
    $('tl-hour-note').textContent = busiest && busiest.events ? `busiest ${String(busiest.hour).padStart(2, '0')}:00` : '';
    renderBars(
      $('tl-hour-chart'),
      data.hours.map((entry) => ({
        value: entry.events,
        label: String(entry.hour).padStart(2, '0'),
        title: `${String(entry.hour).padStart(2, '0')}:00 – ${entry.events} event(s), ${ui.formatDuration(entry.recorded_seconds)} recorded`,
      })),
      6
    );
  }

  async function loadActivity() {
    const params = new URLSearchParams();
    if ($('tl-camera').value) params.set('camera_id', $('tl-camera').value);
    params.set('days', $('tl-activity-days').value);
    let data;
    try {
      data = await api.get(`/api/timeline/activity?${params.toString()}`);
    } catch (err) {
      return;
    }
    const step = data.series.length > 30 ? 10 : data.series.length > 14 ? 5 : 2;
    renderBars(
      $('tl-day-chart'),
      data.series.map((entry) => {
        const parts = entry.day.split('-');
        return {
          value: entry.count,
          label: `${parts[2]}.${parts[1]}`,
          title: `${parts[2]}.${parts[1]}.${parts[0]} – ${entry.count} event(s). Click to open this day.`,
          day: entry.day,
        };
      }),
      step
    );
  }

  /** Simple bar chart: `labelEvery` keeps the axis readable. */
  function renderBars(container, items, labelEvery) {
    const max = items.reduce((best, item) => Math.max(best, item.value), 0);
    const bars = items
      .map((item) => {
        const height = max ? Math.max(item.value ? 4 : 2, (item.value / max) * 100) : 2;
        const classes = ['bar', item.value ? '' : 'empty', item.day ? 'clickable' : ''].filter(Boolean).join(' ');
        const attr = item.day ? ` data-day="${esc(item.day)}"` : '';
        return `<div class="${classes}" style="height:${height}%" title="${esc(item.title)}"${attr}></div>`;
      })
      .join('');
    container.innerHTML = bars;

    // The label row lives next to the chart so the bars stay flex children.
    let labelRow = container.nextElementSibling;
    if (!labelRow || !labelRow.classList.contains('bar-labels')) {
      labelRow = document.createElement('div');
      labelRow.className = 'bar-labels';
      container.parentNode.insertBefore(labelRow, container.nextSibling);
    }
    labelRow.innerHTML = items
      .map((item, index) => `<span>${index % labelEvery === 0 ? esc(item.label) : ''}</span>`)
      .join('');
  }

  /* ------------------------------------------------------- recordings */

  function setupRecordings() {
    $('rec-apply').addEventListener('click', () => {
      state.rec.offset = 0;
      loadRecordings();
    });
    $('rec-reset').addEventListener('click', () => {
      ['rec-filter-camera', 'rec-filter-trigger', 'rec-filter-status', 'rec-filter-from', 'rec-filter-to'].forEach(
        (id) => {
          $(id).value = '';
        }
      );
      state.rec.offset = 0;
      loadRecordings();
    });
    $('rec-prev').addEventListener('click', () => {
      state.rec.offset = Math.max(0, state.rec.offset - state.rec.limit);
      loadRecordings();
    });
    $('rec-next').addEventListener('click', () => {
      if (state.rec.offset + state.rec.limit < state.rec.total) {
        state.rec.offset += state.rec.limit;
        loadRecordings();
      }
    });
    $('rec-select-all').addEventListener('change', (event) => {
      document.querySelectorAll('#rec-body input[type=checkbox]').forEach((box) => {
        box.checked = event.target.checked;
        const id = Number(box.dataset.id);
        if (event.target.checked) state.rec.selected.add(id);
        else state.rec.selected.delete(id);
      });
      updateRecSelection();
    });
    $('rec-delete-selected').addEventListener('click', async () => {
      const ids = Array.from(state.rec.selected);
      if (!ids.length) return;
      const ok = await ui.confirmModal('Delete recordings', `Delete ${ids.length} recording(s) permanently?`);
      if (!ok) return;
      try {
        const result = await api.post('/api/recordings/delete', { ids, stop_active: true });
        ui.toast(`Deleted ${result.deleted} recording(s)`, 'success');
        state.rec.selected.clear();
        loadRecordings();
      } catch (err) {
        ui.toast(err.message, 'error');
      }
    });

    $('rec-body').addEventListener('click', async (event) => {
      const play = event.target.closest('[data-play]');
      if (play) return playRecording(Number(play.dataset.play));
      const del = event.target.closest('[data-delete]');
      if (del) {
        const id = Number(del.dataset.delete);
        const ok = await ui.confirmModal('Delete recording', 'Delete this recording permanently?');
        if (!ok) return;
        try {
          await api.del(`/api/recordings/${id}?stop=1`);
          ui.toast('Recording deleted', 'success');
          loadRecordings();
        } catch (err) {
          ui.toast(err.message, 'error');
        }
      }
    });

    $('rec-body').addEventListener('change', (event) => {
      const box = event.target.closest('input[type=checkbox]');
      if (!box) return;
      const id = Number(box.dataset.id);
      if (box.checked) state.rec.selected.add(id);
      else state.rec.selected.delete(id);
      updateRecSelection();
    });
  }

  function updateRecSelection() {
    $('rec-delete-selected').disabled = state.rec.selected.size === 0;
    $('rec-delete-selected').textContent = state.rec.selected.size
      ? `Delete selected (${state.rec.selected.size})`
      : 'Delete selected';
  }

  async function loadRecordings() {
    const params = new URLSearchParams();
    const camera = $('rec-filter-camera').value;
    const trigger = $('rec-filter-trigger').value;
    const status = $('rec-filter-status').value;
    const from = ui.localInputToIso($('rec-filter-from').value);
    const to = ui.localInputToIso($('rec-filter-to').value);
    if (camera) params.set('camera_id', camera);
    if (trigger) params.set('trigger', trigger);
    if (status) params.set('status', status);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    params.set('limit', state.rec.limit);
    params.set('offset', state.rec.offset);

    const data = await api.get(`/api/recordings?${params.toString()}`);
    state.rec.total = data.total;
    const body = $('rec-body');
    if (!data.recordings.length) {
      body.innerHTML = '<tr><td colspan="9"><div class="empty">No recordings found</div></td></tr>';
    } else {
      body.innerHTML = data.recordings
        .map((rec) => {
          const thumb = rec.thumbnail_path
            ? `<img class="thumb" src="/api/recordings/${rec.id}/thumbnail" data-play="${rec.id}" alt="" loading="lazy" title="Click to play" />`
            : '<div class="thumb" title="No preview image was generated for this recording"></div>';
          return `
          <tr>
            <td><input type="checkbox" data-id="${rec.id}" ${state.rec.selected.has(rec.id) ? 'checked' : ''} /></td>
            <td>${thumb}</td>
            <td>${esc(rec.camera_name || '—')}</td>
            <td class="mono">${esc(ui.formatDateTime(rec.started_at))}</td>
            <td>${rec.status === 'recording' ? '<span class="muted">running…</span>' : esc(ui.formatDuration(rec.duration_seconds))}</td>
            <td>${esc(ui.formatBytes(rec.size_bytes))}</td>
            <td><span class="pill ${esc(rec.trigger_type)}">${esc(rec.trigger_type)}</span></td>
            <td><span class="pill ${esc(rec.status)}" title="${esc(rec.error || '')}">${esc(rec.status)}</span></td>
            <td class="actions">
              <button class="btn sm" data-play="${rec.id}" title="Play this recording in a window">Play</button>
              <a class="btn sm" href="/api/recordings/${rec.id}/download" title="Save the MP4 file to this computer">Download</a>
              <button class="btn sm danger" data-delete="${rec.id}" title="Delete this recording and its file for good">Delete</button>
            </td>
          </tr>`;
        })
        .join('');
    }
    const shown = data.recordings.length ? `${state.rec.offset + 1}–${state.rec.offset + data.recordings.length}` : '0';
    $('rec-summary').textContent = `${shown} of ${data.total} recordings · ${ui.formatBytes(data.bytes)}`;
    $('rec-prev').disabled = state.rec.offset === 0;
    $('rec-next').disabled = state.rec.offset + state.rec.limit >= data.total;
    updateRecSelection();
  }

  function playRecording(id) {
    api
      .get(`/api/recordings/${id}`)
      .then(({ recording }) => openRecordingPlayer(recording))
      .catch((err) => ui.toast(err.message, 'error'));
  }

  /* ----------------------------------------------------------- events */

  function setupEvents() {
    $('ev-apply').addEventListener('click', () => {
      state.ev.offset = 0;
      loadEvents();
    });
    $('ev-reset').addEventListener('click', () => {
      ['ev-filter-camera', 'ev-filter-type', 'ev-filter-from', 'ev-filter-to'].forEach((id) => {
        $(id).value = '';
      });
      $('ev-only-starts').checked = false;
      state.ev.offset = 0;
      loadEvents();
    });
    $('ev-prev').addEventListener('click', () => {
      state.ev.offset = Math.max(0, state.ev.offset - state.ev.limit);
      loadEvents();
    });
    $('ev-next').addEventListener('click', () => {
      if (state.ev.offset + state.ev.limit < state.ev.total) {
        state.ev.offset += state.ev.limit;
        loadEvents();
      }
    });
    $('ev-select-all').addEventListener('change', (event) => {
      document.querySelectorAll('#ev-body input[type=checkbox]').forEach((box) => {
        box.checked = event.target.checked;
        const id = Number(box.dataset.id);
        if (event.target.checked) state.ev.selected.add(id);
        else state.ev.selected.delete(id);
      });
      updateEvSelection();
    });
    $('ev-body').addEventListener('change', (event) => {
      const box = event.target.closest('input[type=checkbox]');
      if (!box) return;
      const id = Number(box.dataset.id);
      if (box.checked) state.ev.selected.add(id);
      else state.ev.selected.delete(id);
      updateEvSelection();
    });
    $('ev-body').addEventListener('click', async (event) => {
      const shot = event.target.closest('[data-snapshot]');
      if (shot) {
        return ui.openModal({
          title: 'Event snapshot',
          wide: true,
          body: `<img src="/api/snapshots/${Number(shot.dataset.snapshot)}/file" style="width:100%;border-radius:6px" alt="" />`,
        });
      }
      const play = event.target.closest('[data-play]');
      if (play) return playRecording(Number(play.dataset.play));
      const del = event.target.closest('[data-delete]');
      if (!del) return;
      try {
        await api.del(`/api/events/${Number(del.dataset.delete)}`);
        loadEvents();
      } catch (err) {
        ui.toast(err.message, 'error');
      }
    });
    $('ev-delete-selected').addEventListener('click', async () => {
      const ids = Array.from(state.ev.selected);
      if (!ids.length) return;
      const ok = await ui.confirmModal('Delete events', `Delete ${ids.length} event(s)?`);
      if (!ok) return;
      const result = await api.post('/api/events/delete', { ids });
      ui.toast(`Deleted ${result.deleted} event(s)`, 'success');
      state.ev.selected.clear();
      loadEvents();
    });
    $('ev-clear').addEventListener('click', async () => {
      const cameraId = $('ev-filter-camera').value;
      const ok = await ui.confirmModal(
        'Clear events',
        cameraId ? 'Delete every event of the selected camera?' : 'Delete every stored event?'
      );
      if (!ok) return;
      const result = await api.post('/api/events/delete', { all: true, camera_id: cameraId || null });
      ui.toast(`Deleted ${result.deleted} event(s)`, 'success');
      loadEvents();
    });
  }

  function updateEvSelection() {
    $('ev-delete-selected').disabled = state.ev.selected.size === 0;
    $('ev-delete-selected').textContent = state.ev.selected.size
      ? `Delete selected (${state.ev.selected.size})`
      : 'Delete selected';
  }

  async function loadEvents() {
    const params = new URLSearchParams();
    const camera = $('ev-filter-camera').value;
    const type = $('ev-filter-type').value;
    const from = ui.localInputToIso($('ev-filter-from').value);
    const to = ui.localInputToIso($('ev-filter-to').value);
    if (camera) params.set('camera_id', camera);
    if (type) params.set('type', type);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if ($('ev-only-starts').checked) params.set('only_starts', '1');
    params.set('limit', state.ev.limit);
    params.set('offset', state.ev.offset);

    const [data, types] = await Promise.all([
      api.get(`/api/events?${params.toString()}`),
      api.get('/api/events/types'),
    ]);

    const typeSelect = $('ev-filter-type');
    const currentType = typeSelect.value;
    typeSelect.innerHTML =
      '<option value="">All types</option>' +
      types.types.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
    typeSelect.value = currentType;

    state.ev.total = data.total;
    const body = $('ev-body');
    if (!data.events.length) {
      body.innerHTML = '<tr><td colspan="8"><div class="empty">No events found</div></td></tr>';
    } else {
      body.innerHTML = data.events
        .map((event) => {
          const stateLabel =
            event.state === 1 ? '<span class="pill on">triggered</span>' : event.state === 0 ? '<span class="pill off">ended</span>' : '<span class="pill">—</span>';
          const recording = event.recording_id
            ? `<button class="btn sm" data-play="${event.recording_id}">Play</button>`
            : '<span class="muted">—</span>';
          const shot = event.snapshot_id
            ? `<img class="thumb event-thumb" src="/api/snapshots/${event.snapshot_id}/file" data-snapshot="${event.snapshot_id}" loading="lazy" alt="" title="Snapshot taken for this event – click to enlarge" />`
            : '';
          return `
          <tr>
            <td><input type="checkbox" data-id="${event.id}" ${state.ev.selected.has(event.id) ? 'checked' : ''} /></td>
            <td class="mono">${esc(ui.formatDateTime(event.received_at))}</td>
            <td>${esc(event.camera_name || '—')}</td>
            <td>${shot}${esc(event.label || event.type || '—')}</td>
            <td>${stateLabel}</td>
            <td class="mono muted" title="${esc(event.topic)}">${esc((event.topic || '').split('/').slice(-2).join('/'))}</td>
            <td>${recording}</td>
            <td class="actions"><button class="btn sm danger" data-delete="${event.id}">Delete</button></td>
          </tr>`;
        })
        .join('');
    }
    const shown = data.events.length ? `${state.ev.offset + 1}–${state.ev.offset + data.events.length}` : '0';
    $('ev-summary').textContent = `${shown} of ${data.total} events`;
    $('ev-prev').disabled = state.ev.offset === 0;
    $('ev-next').disabled = state.ev.offset + state.ev.limit >= data.total;
    updateEvSelection();
  }

  /* -------------------------------------------------------- snapshots */

  function setupSnapshots() {
    $('snap-filter-camera').addEventListener('change', () => {
      state.snap.offset = 0;
      loadSnapshots();
    });
    $('snap-prev').addEventListener('click', () => {
      state.snap.offset = Math.max(0, state.snap.offset - state.snap.limit);
      loadSnapshots();
    });
    $('snap-next').addEventListener('click', () => {
      if (state.snap.offset + state.snap.limit < state.snap.total) {
        state.snap.offset += state.snap.limit;
        loadSnapshots();
      }
    });
    $('snap-grid').addEventListener('click', async (event) => {
      const del = event.target.closest('[data-delete]');
      if (del) {
        const ok = await ui.confirmModal('Delete snapshot', 'Delete this snapshot?');
        if (!ok) return;
        await api.del(`/api/snapshots/${Number(del.dataset.delete)}`);
        loadSnapshots();
        return;
      }
      const image = event.target.closest('img[data-id]');
      if (image) {
        ui.openModal({
          title: image.dataset.title || 'Snapshot',
          wide: true,
          body: `<img src="/api/snapshots/${image.dataset.id}/file" style="width:100%;border-radius:6px" alt="" />`,
        });
      }
    });
  }

  async function loadSnapshots() {
    const params = new URLSearchParams();
    const camera = $('snap-filter-camera').value;
    if (camera) params.set('camera_id', camera);
    params.set('limit', state.snap.limit);
    params.set('offset', state.snap.offset);
    const data = await api.get(`/api/snapshots?${params.toString()}`);
    state.snap.total = data.total;

    $('snap-grid').innerHTML = data.snapshots.length
      ? data.snapshots
          .map(
            (snap) => `
          <div class="snapshot-card">
            <img src="/api/snapshots/${snap.id}/file" data-id="${snap.id}" data-title="${esc(snap.camera_name || '')} · ${esc(ui.formatDateTime(snap.created_at))}" loading="lazy" alt="" />
            <div class="info">
              <span>${esc(snap.camera_name || '—')}<br /><span class="muted">${esc(ui.formatDateTime(snap.created_at))}</span></span>
              <span>
                <a class="btn sm" href="/api/snapshots/${snap.id}/file?download=1" title="Download this snapshot">↓</a>
                <button class="btn sm danger" data-delete="${snap.id}" title="Delete this snapshot">×</button>
              </span>
            </div>
          </div>`
          )
          .join('')
      : '<div class="empty">No snapshots yet</div>';

    const shown = data.snapshots.length ? `${state.snap.offset + 1}–${state.snap.offset + data.snapshots.length}` : '0';
    $('snap-summary').textContent = `${shown} of ${data.total} snapshots`;
    $('snap-prev').disabled = state.snap.offset === 0;
    $('snap-next').disabled = state.snap.offset + state.snap.limit >= data.total;
  }

  /* --------------------------------------------------------- settings */

  function setupSettings() {
    $('set-save').addEventListener('click', async () => {
      try {
        await api.put('/api/system/settings', {
          retention_days: $('set-retention-days').value,
          retention_max_gb: $('set-retention-gb').value,
          event_retention_days: $('set-event-days').value,
        });
        ui.toast('Settings saved', 'success');
      } catch (err) {
        ui.toast(err.message, 'error');
      }
    });
    $('set-run-now').addEventListener('click', async () => {
      try {
        await api.post('/api/system/retention/run', {});
        ui.toast('Cleanup finished', 'success');
        loadSettings();
      } catch (err) {
        ui.toast(err.message, 'error');
      }
    });
    $('set-public-url-save').addEventListener('click', async () => {
      try {
        const result = await api.put('/api/system/settings', { public_url: $('set-public-url').value });
        ui.toast(
          result.effective_public_url
            ? `Cameras will now report to ${result.effective_public_url}`
            : 'Callback address cleared, it will be detected per camera',
          'success'
        );
        loadSettings();
      } catch (err) {
        ui.toast(err.message, 'error');
      }
    });

    $('pw-save').addEventListener('click', async () => {
      const next = $('pw-new').value;
      if (next !== $('pw-repeat').value) return ui.toast('New passwords do not match', 'error');
      try {
        await api.post('/api/auth/password', { current_password: $('pw-current').value, new_password: next });
        ['pw-current', 'pw-new', 'pw-repeat'].forEach((id) => {
          $(id).value = '';
        });
        ui.toast('Password updated', 'success');
      } catch (err) {
        ui.toast(err.message, 'error');
      }
    });
  }

  async function loadSettings() {
    const [stats, settings] = await Promise.all([api.get('/api/system/stats'), api.get('/api/system/settings')]);
    $('set-retention-days').value = settings.settings.retention_days || 0;
    $('set-retention-gb').value = settings.settings.retention_max_gb || 0;
    $('set-event-days').value = settings.settings.event_retention_days || 0;
    $('set-public-url').value = settings.settings.public_url || '';

    const notes = {
      settings: 'In use: the address saved here.',
      environment: `In use: the PUBLIC_URL environment variable (${settings.effective_public_url}). Anything typed here overrides it.`,
      auto: 'Not set, so each camera is told the local address this server reaches it from. That works on a flat LAN but not from Docker.',
    };
    $('set-public-url-note').textContent = notes[settings.public_url_source] || '';

    const disk = stats.disk || {};
    const tiles = [
      { label: 'Cameras online', value: `${stats.counts.cameras_online}/${stats.counts.cameras}` },
      { label: 'Recordings', value: stats.counts.recordings },
      { label: 'Recording storage', value: ui.formatBytes(disk.recordings_bytes) },
      { label: 'Snapshots', value: stats.counts.snapshots },
      { label: 'Events (24 h)', value: `${stats.counts.events_today} / ${stats.counts.events}` },
      { label: 'Free disk space', value: disk.free_bytes ? ui.formatBytes(disk.free_bytes) : 'n/a' },
      { label: 'Live streams', value: (stats.live_streams || []).length },
      { label: 'Uptime', value: ui.formatDuration(stats.uptime_seconds) },
    ];
    $('stat-grid').innerHTML = tiles
      .map((tile) => `<div class="stat"><div class="value">${esc(tile.value)}</div><div class="label">${esc(tile.label)}</div></div>`)
      .join('');
  }

  /* --------------------------------------------------- live updates */

  function connectUpdates() {
    let socket = null;
    let retry = 0;

    const connect = () => {
      socket = new WebSocket(api.wsUrl('/ws/updates'));
      socket.onopen = () => {
        retry = 0;
        $('ws-dot').classList.add('on');
      };
      socket.onclose = () => {
        $('ws-dot').classList.remove('on');
        retry += 1;
        setTimeout(connect, Math.min(2000 * retry, 15000));
      };
      socket.onmessage = (event) => {
        let update = null;
        try {
          update = JSON.parse(event.data);
        } catch (err) {
          return;
        }
        handleUpdate(update);
      };
    };
    connect();
  }

  function handleUpdate(update) {
    const payload = update.payload || {};
    switch (update.type) {
      case 'hello':
        state.activeRecordings = payload.active_recordings || {};
        renderRail();
        updateLiveControls();
        break;

      case 'event:created': {
        const camera = cameraById(payload.camera_id);
        const label = payload.event.label || payload.event.type;
        if (payload.event.state !== 0) {
          ui.toast(`${camera ? camera.name : 'Camera'}: ${label}`);
        }
        if (state.view === 'events') loadEvents();
        if (payload.camera_id === state.activeCameraId) loadLiveSidePanels();
        break;
      }

      case 'recording:state':
        if (payload.active) state.activeRecordings[payload.camera_id] = payload.active;
        else delete state.activeRecordings[payload.camera_id];
        renderRail();
        updateLiveControls();
        break;

      case 'recording:started':
        state.activeRecordings[payload.camera_id] = {
          camera_id: payload.camera_id,
          recording_id: payload.recording.id,
          started_at: payload.recording.started_at,
          trigger: payload.recording.trigger_type,
        };
        renderRail();
        updateLiveControls();
        if (state.view === 'recordings') loadRecordings();
        if (payload.camera_id === state.activeCameraId) loadLiveSidePanels();
        break;

      case 'recording:stopped':
        delete state.activeRecordings[payload.camera_id];
        renderRail();
        updateLiveControls();
        if (state.view === 'recordings') loadRecordings();
        if (payload.camera_id === state.activeCameraId) loadLiveSidePanels();
        break;

      case 'recording:deleted':
        if (state.view === 'recordings') loadRecordings();
        break;

      case 'snapshot:created':
      case 'snapshot:deleted':
        if (state.view === 'snapshots') loadSnapshots();
        break;

      case 'camera:status': {
        const camera = cameraById(payload.camera_id);
        if (camera) {
          camera.status = payload.status;
          camera.status_message = payload.message;
          renderRail();
          if (state.view === 'cameras') renderCameraCards();
        }
        break;
      }
      default:
        break;
    }
  }

  boot().catch((err) => {
    if (err.message !== 'Session expired') ui.toast(err.message, 'error');
  });
})();
