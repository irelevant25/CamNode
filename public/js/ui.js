/* Small DOM / formatting helpers shared by every view. */
(function () {
  'use strict';

  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = value / 1024;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
      size /= 1024;
      index += 1;
    }
    return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  function parseDate(value) {
    if (!value) return null;
    // SQLite datetime('now') returns "YYYY-MM-DD HH:MM:SS" in UTC.
    const text = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') + 'Z' : value;
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const pad = (value) => String(value).padStart(2, '0');

  /** Always dd.MM.yyyy HH:mm:ss on a 24 hour clock, whatever the locale is. */
  function formatDateTime(value) {
    const date = parseDate(value);
    if (!date) return '—';
    return (
      `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ` +
      `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    );
  }

  /** Relative age only – never falls back to a date. */
  function formatAgo(value) {
    const date = parseDate(value);
    if (!date) return '—';
    const diff = (Date.now() - date.getTime()) / 1000;
    if (diff < 0) return 'just now';
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
    if (diff < 2592000) return `${Math.floor(diff / 86400)} d ago`;
    return `${Math.floor(diff / 2592000)} mo ago`;
  }

  function formatRelative(value) {
    const date = parseDate(value);
    if (!date) return '—';
    return (Date.now() - date.getTime()) / 1000 < 86400 ? formatAgo(value) : formatDateTime(value);
  }

  /** Convert a datetime-local input value to an ISO string for the API. */
  function localInputToIso(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  function toast(message, kind) {
    const root = document.getElementById('toasts');
    const node = document.createElement('div');
    node.className = `toast ${kind || ''}`;
    node.textContent = message;
    root.appendChild(node);
    setTimeout(() => {
      node.style.opacity = '0';
      node.style.transition = 'opacity .25s';
      setTimeout(() => node.remove(), 250);
    }, kind === 'error' ? 6000 : 3500);
  }

  let modalCloser = null;

  /**
   * Open a modal. `options.body` is an HTML string or a node; `options.buttons`
   * is a list of { label, className, onClick } – returning false keeps it open.
   */
  function openModal(options) {
    closeModal();
    const root = document.getElementById('modal-root');
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal ${options.wide ? 'wide' : ''}">
        <div class="modal-head">
          <h2>${escapeHtml(options.title || '')}</h2>
          <button class="close-x" data-close>&times;</button>
        </div>
        <div class="modal-body"></div>
        <div class="modal-foot"></div>
      </div>`;

    const body = backdrop.querySelector('.modal-body');
    if (typeof options.body === 'string') body.innerHTML = options.body;
    else if (options.body) body.appendChild(options.body);

    const foot = backdrop.querySelector('.modal-foot');
    (options.buttons || []).forEach((spec) => {
      const button = document.createElement('button');
      button.className = `btn ${spec.className || ''}`;
      button.textContent = spec.label;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const result = spec.onClick ? await spec.onClick(backdrop) : undefined;
          if (result !== false) closeModal();
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          button.disabled = false;
        }
      });
      foot.appendChild(button);
    });
    if (!foot.children.length) foot.remove();

    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop || event.target.hasAttribute('data-close')) closeModal();
    });
    root.appendChild(backdrop);
    modalCloser = () => {
      backdrop.remove();
      if (options.onClose) options.onClose();
    };
    document.addEventListener('keydown', escListener);
    return backdrop;
  }

  function escListener(event) {
    if (event.key === 'Escape') closeModal();
  }

  function closeModal() {
    if (!modalCloser) return;
    const close = modalCloser;
    modalCloser = null;
    document.removeEventListener('keydown', escListener);
    close();
  }

  function confirmModal(title, message, confirmLabel) {
    return new Promise((resolve) => {
      openModal({
        title,
        body: `<p>${escapeHtml(message)}</p>`,
        buttons: [
          { label: 'Cancel', onClick: () => resolve(false) },
          {
            label: confirmLabel || 'Delete',
            className: 'danger',
            onClick: () => resolve(true),
          },
        ],
        onClose: () => resolve(false),
      });
    });
  }

  window.ui = {
    escapeHtml,
    formatBytes,
    formatDuration,
    formatDateTime,
    formatRelative,
    formatAgo,
    localInputToIso,
    parseDate,
    toast,
    openModal,
    closeModal,
    confirmModal,
  };
})();
