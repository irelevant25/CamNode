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
    recordingTimer: null,
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
    setupRecordings();
    setupEvents();
    setupSnapshots();
    setupCameras();
    setupSettings();

    await loadCameras();
    connectUpdates();

    const initial = (location.hash || '#live').slice(1);
    showView(['live', 'recordings', 'events', 'snapshots', 'cameras', 'settings'].indexOf(initial) >= 0 ? initial : 'live');

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
          <div class="camera-rail-item ${camera.id === state.activeCameraId ? 'active' : ''}" data-camera="${camera.id}">
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
            <button class="btn sm" data-action="view" data-id="${camera.id}">Live</button>
            <button class="btn sm" data-action="edit" data-id="${camera.id}">Edit</button>
            <button class="btn sm" data-action="refresh" data-id="${camera.id}">Re-discover</button>
            <button class="btn sm" data-action="test-events" data-id="${camera.id}">Test events</button>
            <button class="btn sm danger" data-action="delete" data-id="${camera.id}">Delete</button>
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
        <div class="field"><label>Name</label><input type="text" id="cam-name" value="${esc(values.name)}" placeholder="Front door" /></div>
        <div class="field"><label>Host / IP</label><input type="text" id="cam-host" value="${esc(values.host)}" placeholder="192.168.1.50" /></div>
      </div>
      <div class="grid-2">
        <div class="field"><label>ONVIF port</label><input type="number" id="cam-port" value="${values.onvif_port}" /></div>
        <div class="field"><label>RTSP transport</label>
          <select id="cam-transport">
            <option value="tcp" ${values.rtsp_transport === 'tcp' ? 'selected' : ''}>TCP (recommended)</option>
            <option value="udp" ${values.rtsp_transport === 'udp' ? 'selected' : ''}>UDP</option>
          </select>
        </div>
      </div>
      <div class="grid-2">
        <div class="field"><label>Username</label><input type="text" id="cam-user" value="${esc(values.username || '')}" autocomplete="off" /></div>
        <div class="field"><label>Password</label><input type="password" id="cam-pass" placeholder="${isEdit ? 'unchanged' : ''}" autocomplete="new-password" /></div>
      </div>
      <p class="hint">Tapo cameras: enable ONVIF and create a <strong>Camera Account</strong> in the Tapo app (Settings → Advanced → Camera Account). Default ONVIF port is 2020.</p>

      <div class="field" style="margin-top:14px">
        <button class="btn" id="cam-test" type="button">Test connection &amp; load profiles</button>
        <span id="cam-test-result" class="hint"></span>
      </div>

      <div class="grid-2">
        <div class="field"><label>Live view profile</label><select id="cam-live-profile"><option value="">Auto (lowest)</option>${profileOptions(values.live_profile_token)}</select></div>
        <div class="field"><label>Recording profile</label><select id="cam-record-profile"><option value="">Auto (highest)</option>${profileOptions(values.record_profile_token)}</select></div>
      </div>

      <div class="grid-2">
        <div class="field"><label>Stop event recording after (s)</label><input type="number" id="cam-event-seconds" min="5" max="3600" value="${values.event_record_seconds}" /></div>
        <div class="field"><label>Max file length (s)</label><input type="number" id="cam-max-seconds" min="30" max="21600" value="${values.max_record_seconds}" /></div>
      </div>
      <div class="field"><label class="checkbox"><input type="checkbox" id="cam-on-event" ${values.record_on_event ? 'checked' : ''} /> Record automatically on ONVIF detection events</label></div>
      <div class="field">
        <label>Event delivery</label>
        <select id="cam-event-mode">
          <option value="auto" ${values.event_mode === 'auto' ? 'selected' : ''}>Automatic - pull point, fall back to push</option>
          <option value="pull" ${values.event_mode === 'pull' ? 'selected' : ''}>Pull point only</option>
          <option value="push" ${values.event_mode === 'push' ? 'selected' : ''}>Push notifications only</option>
          <option value="off" ${values.event_mode === 'off' ? 'selected' : ''}>Do not subscribe to events</option>
        </select>
        <p class="hint">Tapo cameras accept a pull-point subscription but reset every poll, so they need push. In push mode the camera posts events back to this server, so set <code>PUBLIC_URL</code> when running in Docker.</p>
      </div>
      <div class="field"><label class="checkbox"><input type="checkbox" id="cam-audio" ${values.record_audio ? 'checked' : ''} /> Record audio (when the camera provides it)</label></div>
      <div class="field"><label class="checkbox"><input type="checkbox" id="cam-enabled" ${values.enabled ? 'checked' : ''} /> Enabled (connect and listen for events)</label></div>
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
    player.open(id, $('quality').value);
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
            ? `<img class="thumb" src="/api/recordings/${rec.id}/thumbnail" data-play="${rec.id}" alt="" loading="lazy" />`
            : '<div class="thumb"></div>';
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
              <button class="btn sm" data-play="${rec.id}">Play</button>
              <a class="btn sm" href="/api/recordings/${rec.id}/download">Download</a>
              <button class="btn sm danger" data-delete="${rec.id}">Delete</button>
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
      .then(({ recording }) => {
        ui.openModal({
          title: `${recording.camera_name || 'Recording'} · ${ui.formatDateTime(recording.started_at)}`,
          wide: true,
          body: `
            <video controls autoplay playsinline src="/api/recordings/${id}/stream"></video>
            <div class="pager">
              <span class="muted">${esc(ui.formatDuration(recording.duration_seconds))} · ${esc(ui.formatBytes(recording.size_bytes))} · ${esc(recording.trigger_type)}</span>
              <a class="btn sm" href="/api/recordings/${id}/download">Download</a>
            </div>`,
        });
      })
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
          return `
          <tr>
            <td><input type="checkbox" data-id="${event.id}" ${state.ev.selected.has(event.id) ? 'checked' : ''} /></td>
            <td class="mono">${esc(ui.formatDateTime(event.received_at))}</td>
            <td>${esc(event.camera_name || '—')}</td>
            <td>${esc(event.label || event.type || '—')}</td>
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
                <a class="btn sm" href="/api/snapshots/${snap.id}/file?download=1">↓</a>
                <button class="btn sm danger" data-delete="${snap.id}">×</button>
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
