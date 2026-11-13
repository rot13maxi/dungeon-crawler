export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.justPressed = new Set();
    this.justReleased = new Set();
    this.mouse = { x: 0, y: 0, ndcX: 0, ndcY: 0, left: false, right: false };
    this.justDown = new Set();
    this.justUp = new Set();
    this.enabled = true;
    this.wheel = 0;
    this._bind();
  }

  _bind() {
    this._onKeyDown = (e) => {
      if (!this.enabled) return;
      const code = e.code;
      if (['Tab', 'Space', 'KeyT', 'Escape'].includes(code)) e.preventDefault();
      if (!this.keys.has(code)) this.justPressed.add(code);
      this.keys.add(code);
    };
    this._onKeyUp = (e) => {
      if (!this.enabled) return;
      this.keys.delete(e.code);
      this.justReleased.add(e.code);
    };
    this._onMouseMove = (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
      const rect = this.canvas.getBoundingClientRect();
      this.mouse.ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.mouse.ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    };
    this._onMouseDown = (e) => {
      if (!this.enabled) return;
      if (e.target !== this.canvas) return;
      if (e.button === 0) this.mouse.left = true;
      if (e.button === 2) this.mouse.right = true;
      this.justDown.add(e.button);
    };
    this._onMouseUp = (e) => {
      if (e.button === 0) this.mouse.left = false;
      if (e.button === 2) this.mouse.right = false;
      this.justUp.add(e.button);
    };
    this._onContext = (e) => e.preventDefault();
    this._onWheel = (e) => {
      if (!this.enabled) return;
      this.wheel += Math.sign(e.deltaY);
    };
    this._onBlur = () => {
      this.keys.clear();
      this.mouse.left = false;
      this.mouse.right = false;
    };
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('contextmenu', this._onContext);
    window.addEventListener('wheel', this._onWheel, { passive: true });
    window.addEventListener('blur', this._onBlur);
  }

  getMouseNDC() {
    return { x: this.mouse.ndcX, y: this.mouse.ndcY };
  }

  isDown(code) {
    return this.keys.has(code);
  }

  pressed(code) {
    return this.justPressed.has(code);
  }

  consumePress(code) {
    if (!this.justPressed.has(code)) return false;
    this.justPressed.delete(code);
    return true;
  }

  consumeDown(button) {
    if (!this.justDown.has(button)) return false;
    this.justDown.delete(button);
    return true;
  }

  getMoveVector() {
    let x = 0;
    let z = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) z -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) z += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    const len = Math.hypot(x, z);
    if (len > 1) { x /= len; z /= len; }
    return { x, z };
  }

  endFrame() {
    this.justPressed.clear();
    this.justReleased.clear();
    this.justDown.clear();
    this.justUp.clear();
    this.wheel = 0;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('contextmenu', this._onContext);
    window.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('blur', this._onBlur);
  }
}
