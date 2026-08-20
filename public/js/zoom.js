/*
 * Zoom and pan for the live picture.
 *
 * The video keeps its normal layout box; only a CSS transform is changed, so
 * playback is untouched. `transform-origin: 0 0` keeps the maths simple:
 *
 *     screen = elementPoint * scale + translate
 */
(function () {
  'use strict';

  const MIN_SCALE = 1;
  const MAX_SCALE = 8;
  const WHEEL_STEP = 1.15;

  class ZoomPan {
    constructor(container, target, onChange) {
      this.container = container;
      this.target = target;
      this.onChange = onChange || function () {};
      this.scale = 1;
      this.x = 0;
      this.y = 0;
      this.dragging = false;
      this.pointers = new Map();
      this.pinchDistance = 0;
      this.moved = false;

      this.target.style.transformOrigin = '0 0';
      this.target.style.willChange = 'transform';
      this.bind();
    }

    bind() {
      const container = this.container;

      container.addEventListener('wheel', (event) => {
        event.preventDefault();
        const rect = container.getBoundingClientRect();
        const factor = event.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP;
        this.zoomAt(factor, event.clientX - rect.left, event.clientY - rect.top);
      }, { passive: false });

      container.addEventListener('dblclick', (event) => {
        event.preventDefault();
        if (this.scale > 1) return this.reset();
        const rect = container.getBoundingClientRect();
        this.zoomAt(2, event.clientX - rect.left, event.clientY - rect.top);
      });

      container.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        container.setPointerCapture(event.pointerId);
        this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        this.moved = false;
        if (this.pointers.size === 2) {
          this.pinchDistance = this.distance();
        } else if (this.scale > 1) {
          this.dragging = true;
          this.updateCursor();
        }
      });

      container.addEventListener('pointermove', (event) => {
        const previous = this.pointers.get(event.pointerId);
        if (!previous) return;
        const dx = event.clientX - previous.x;
        const dy = event.clientY - previous.y;
        this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this.moved = true;

        if (this.pointers.size === 2) {
          // Pinch: scale around the midpoint between both fingers.
          const distance = this.distance();
          if (this.pinchDistance > 0 && distance > 0) {
            const rect = container.getBoundingClientRect();
            const mid = this.midpoint();
            this.zoomAt(distance / this.pinchDistance, mid.x - rect.left, mid.y - rect.top);
          }
          this.pinchDistance = distance;
          return;
        }
        if (!this.dragging) return;
        this.x += dx;
        this.y += dy;
        this.apply();
      });

      const release = (event) => {
        this.pointers.delete(event.pointerId);
        if (this.pointers.size < 2) this.pinchDistance = 0;
        if (this.pointers.size === 0) {
          this.dragging = false;
          this.updateCursor();
        }
      };
      container.addEventListener('pointerup', release);
      container.addEventListener('pointercancel', release);
      container.addEventListener('pointerleave', release);

      window.addEventListener('resize', () => this.apply());
      document.addEventListener('fullscreenchange', () => this.apply());
    }

    distance() {
      const points = Array.from(this.pointers.values());
      if (points.length < 2) return 0;
      return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    }

    midpoint() {
      const points = Array.from(this.pointers.values());
      return { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
    }

    /** Zoom by `factor`, keeping the point under the cursor in place. */
    zoomAt(factor, cx, cy) {
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
      if (next === this.scale) return;
      const ratio = next / this.scale;
      this.x = cx - (cx - this.x) * ratio;
      this.y = cy - (cy - this.y) * ratio;
      this.scale = next;
      this.apply();
    }

    zoomBy(factor) {
      this.zoomAt(factor, this.container.clientWidth / 2, this.container.clientHeight / 2);
    }

    reset() {
      this.scale = 1;
      this.x = 0;
      this.y = 0;
      this.apply();
    }

    /** Keep the picture covering the frame – no empty edges. */
    clamp() {
      const width = this.container.clientWidth;
      const height = this.container.clientHeight;
      const minX = width * (1 - this.scale);
      const minY = height * (1 - this.scale);
      this.x = Math.min(0, Math.max(minX, this.x));
      this.y = Math.min(0, Math.max(minY, this.y));
    }

    apply() {
      this.clamp();
      this.target.style.transform =
        this.scale === 1 ? '' : `translate(${this.x}px, ${this.y}px) scale(${this.scale})`;
      this.updateCursor();
      this.onChange(this.scale);
    }

    updateCursor() {
      if (this.scale <= 1) this.container.style.cursor = '';
      else this.container.style.cursor = this.dragging ? 'grabbing' : 'grab';
    }
  }

  window.ZoomPan = ZoomPan;
})();
