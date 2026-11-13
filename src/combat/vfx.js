// EMBERFALL — combat VFX. Pooled additive particle system + staged effects.
// All effects are self-cleaning; no per-frame allocations in hot loops.
import * as THREE from 'three';

const MAX_PARTICLES = 2500;

function srgb(c) { return Math.pow(c, 2.2); }

// Soft round additive sprite: radial falloff with a hot core.
const PARTICLE_VERT = /* glsl */ `
attribute float aSize;
attribute vec4 aColor;
varying vec4 vColor;
void main() {
  vColor = aColor;
  if (aSize <= 0.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // clipped behind camera: dead particle
    gl_PointSize = 0.0;
    return;
  }
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (300.0 / max(0.001, -mv.z));
  gl_Position = projectionMatrix * mv;
}`;

const PARTICLE_FRAG = /* glsl */ `
varying vec4 vColor;
void main() {
  vec2 uv = gl_PointCoord - 0.5;
  float d = length(uv);
  if (d > 0.5) discard;
  float falloff = 1.0 - d * 2.0;
  float alpha = vColor.a * falloff * falloff;
  gl_FragColor = vec4(vColor.rgb * falloff, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

function makeSoftSpriteTexture(size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeRuneTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  ctx.translate(S / 2, S / 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 5;
  // Outer circles
  ctx.beginPath(); ctx.arc(0, 0, S * 0.44, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, S * 0.40, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, S * 0.14, 0, Math.PI * 2); ctx.stroke();
  // Runes on the ring
  ctx.lineWidth = 4;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const x = Math.cos(a) * S * 0.42, y = Math.sin(a) * S * 0.42;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a + Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(0, -14); ctx.lineTo(-7, 8); ctx.lineTo(0, 3); ctx.lineTo(7, 8); ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }
  // Inner star
  ctx.lineWidth = 5;
  ctx.beginPath();
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 2;
    const x = Math.cos(a) * S * 0.38, y = Math.sin(a) * S * 0.38;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

let _lightBudgetWarned = false;

export class VFX {
  constructor(scene, game) {
    this.scene = scene;
    this.game = game;
    this.time = 0;

    // --- Pooled particle cloud ---
    this._count = MAX_PARTICLES;
    this._pos = new Float32Array(MAX_PARTICLES * 3);
    this._vel = new Float32Array(MAX_PARTICLES * 3);
    this._col = new Float32Array(MAX_PARTICLES * 4); // rgb + alpha (life)
    this._size = new Float32Array(MAX_PARTICLES);
    this._baseSize = new Float32Array(MAX_PARTICLES);
    this._life = new Float32Array(MAX_PARTICLES);   // remaining
    this._maxLife = new Float32Array(MAX_PARTICLES);
    this._grav = new Float32Array(MAX_PARTICLES);
    this._drag = new Float32Array(MAX_PARTICLES);
    this._shrink = new Float32Array(MAX_PARTICLES); // 0 none, 1 shrink, 2 grow
    this._alive = new Uint8Array(MAX_PARTICLES);
    this._free = [];
    this._live = []; // compact list of live particle indices
    this._frameEmitted = 0;
    this._frameBudget = 140; // max particles spawned per rendered frame
    for (let i = MAX_PARTICLES - 1; i >= 0; i--) this._free.push(i);
    this._liveCount = 0;

    const geo = new THREE.BufferGeometry();
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    geo.setAttribute('position', new THREE.BufferAttribute(this._pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this._col, 4));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this._size, 1));
    this._geo = geo;
    this._mat = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this._points = new THREE.Points(geo, this._mat);
    this._points.frustumCulled = false;
    this._points.renderOrder = 8;
    scene.add(this._points);

    // --- Staged effect pools ---
    this._timers = [];       // {obj, life, maxLife, update, dispose}
    this._lightPool = [];
    this._lightsCreated = 0;

    this._spriteTex = makeSoftSpriteTexture();
    this._runeTex = makeRuneTexture();
    this._sharedGeo = {
      ring: new THREE.RingGeometry(0.62, 0.72, 48),
      plane: new THREE.PlaneGeometry(1, 1),
      sphere: new THREE.SphereGeometry(1, 12, 8),
    };

    this._flashQuad = null;

    // Pooled one-shot meshes for ring / shockwave / runeCircle. Each effect used
    // to allocate a fresh material and dispose it on expiry; disposing releases
    // the shader program, so the next effect recompiled it (~90ms on a busy frame).
    this._fxPools = { ring: [], shock: [], rune: [] };
    for (let i = 0; i < 10; i++) {
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        depthWrite: false, fog: false,
      });
      const ring = new THREE.Mesh(this._sharedGeo.ring, ringMat);
      ring.visible = false;
      ring.frustumCulled = false;
      this.scene.add(ring);
      this._fxPools.ring.push(ring);

      const shockMat = ringMat.clone();
      const shock = new THREE.Mesh(this._sharedGeo.ring, shockMat);
      shock.visible = false;
      shock.frustumCulled = false;
      this.scene.add(shock);
      this._fxPools.shock.push(shock);

      const runeMat = new THREE.MeshBasicMaterial({
        map: this._runeTex, color: 0xffffff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        fog: false,
      });
      const rune = new THREE.Mesh(this._sharedGeo.plane, runeMat);
      rune.visible = false;
      rune.frustumCulled = false;
      this.scene.add(rune);
      this._fxPools.rune.push(rune);
    }

    // scratch
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._c1 = new THREE.Color();
  }

  // Public: raw particle emission for other systems (projectile trails).
  spawnParticle(x, y, z, vx, vy, vz, r, g, b, size, life, grav = 0, drag = 1, shrink = 1) {
    return this._spawnParticle(x, y, z, vx, vy, vz, r, g, b, size, life, grav, drag, shrink);
  }
  // ---------------------------------------------------------------- particles
  _spawnParticle(x, y, z, vx, vy, vz, r, g, b, size, life, grav, drag, shrink) {
    // Per-frame emission budget: a boss death previously dumped 600+ particles
    // into a single frame and stalled weaker GPUs ~90ms. Cap emissions per frame.
    if (this._frameEmitted >= this._frameBudget) return -1;
    this._frameEmitted++;
    if (this._free.length === 0) return -1;
    const i = this._free.pop();
    const p3 = i * 3, p4 = i * 4;
    this._pos[p3] = x; this._pos[p3 + 1] = y; this._pos[p3 + 2] = z;
    this._vel[p3] = vx; this._vel[p3 + 1] = vy; this._vel[p3 + 2] = vz;
    this._col[p4] = r; this._col[p4 + 1] = g; this._col[p4 + 2] = b; this._col[p4 + 3] = 1;
    this._baseSize[i] = size;
    this._size[i] = size;
    this._life[i] = life; this._maxLife[i] = life;
    this._grav[i] = grav; this._drag[i] = drag;
    this._shrink[i] = shrink;
    this._alive[i] = 1;
    this._live.push(i);
    return i;
  }

  burst(position, opts = {}) {
    const count = Math.min(opts.count ?? 24, 120);
    const color = new THREE.Color(opts.color ?? 0xff6b2b);
    const size = opts.size ?? 0.15;
    const speed = opts.speed ?? 6;
    const life = opts.life ?? 0.7;
    const spread = opts.spread ?? 1;
    const gravity = opts.gravity ?? 0;
    const drag = opts.drag ?? 1.4;
    const up = opts.up ?? 1;
    const px = position.x, py = position.y, pz = position.z;
    for (let n = 0; n < count; n++) {
      const a = Math.random() * Math.PI * 2;
      const e = (Math.random() * 2 - 1) * spread;
      const r = Math.sqrt(Math.max(0, 1 - e * e));
      const s = speed * (0.35 + Math.random() * 0.65);
      const hot = Math.random();
      const rr = Math.min(1.6, color.r * (0.9 + hot * 0.5));
      const gg = Math.min(1.5, color.g * (0.8 + hot * 0.5));
      const bb = Math.min(1.4, color.b * (0.8 + hot * 0.5));
      this._spawnParticle(
        px + Math.cos(a) * 0.08, py + Math.random() * 0.15, pz + Math.sin(a) * 0.08,
        Math.cos(a) * r * s, (Math.random() * 0.55 + up * 0.45) * s, Math.sin(a) * r * s,
        rr, gg, bb,
        size * (0.6 + Math.random() * 0.8),
        life * (0.55 + Math.random() * 0.7),
        gravity, drag, 1,
      );
    }
  }

  embers(position, opts = {}) {
    const count = Math.min(opts.count ?? 14, 60);
    const color = new THREE.Color(opts.color ?? 0xff7a2f);
    const life = opts.life ?? 1.4;
    for (let n = 0; n < count; n++) {
      this._spawnParticle(
        position.x + (Math.random() - 0.5) * 0.6,
        position.y + Math.random() * 0.4,
        position.z + (Math.random() - 0.5) * 0.6,
        (Math.random() - 0.5) * 0.7, 1.2 + Math.random() * 1.6, (Math.random() - 0.5) * 0.7,
        color.r, color.g, color.b,
        0.06 + Math.random() * 0.06, life * (0.6 + Math.random() * 0.8),
        0.4, 0.55, 1,
      );
    }
  }

  smoke(position, opts = {}) {
    const count = Math.min(opts.count ?? 8, 40);
    for (let n = 0; n < count; n++) {
      // Smoke uses grey, low alpha, slow rise, grows
      const g = 0.22 + Math.random() * 0.12;
      this._spawnParticle(
        position.x + (Math.random() - 0.5) * (opts.radius ?? 0.6),
        position.y + Math.random() * 0.2,
        position.z + (Math.random() - 0.5) * (opts.radius ?? 0.6),
        (Math.random() - 0.5) * 0.5, 0.7 + Math.random() * 0.9, (Math.random() - 0.5) * 0.5,
        g * 0.8, g, g * 1.1,
        (opts.size ?? 0.5) * (0.8 + Math.random() * 0.6),
        (opts.life ?? 1.3) * (0.8 + Math.random() * 0.5),
        0.12, 0.9, 2,
      );
    }
  }

  sparks(position, opts = {}) {
    const count = Math.min(opts.count ?? 12, 60);
    const color = new THREE.Color(opts.color ?? 0xffd9a0);
    const speed = opts.speed ?? 9;
    for (let n = 0; n < count; n++) {
      const a = Math.random() * Math.PI * 2;
      const upv = Math.random();
      const s = speed * (0.5 + Math.random() * 0.7);
      this._spawnParticle(
        position.x, position.y + 0.05, position.z,
        Math.cos(a) * s * (1 - upv), upv * s * 0.9 + 1, Math.sin(a) * s * (1 - upv),
        color.r, color.g, color.b,
        0.05 + Math.random() * 0.04,
        0.35 + Math.random() * 0.4,
        14, 0.35, 1,
      );
    }
  }

  update(dt) {
    this.time += dt;
    this._frameEmitted = 0; // reset per-frame emission budget
    // --- particles (compact live list; skip the 2500-slot scan) ---
    const pos = this._pos, vel = this._vel, col = this._col;
    const live = this._live;
    for (let li = live.length - 1; li >= 0; li--) {
      const i = live[li];
      if (this._alive[i] === 0) { live[li] = live[live.length - 1]; live.pop(); continue; }
      this._life[i] -= dt;
      if (this._life[i] <= 0) {
        this._alive[i] = 0;
        this._size[i] = 0;
        this._free.push(i);
        continue;
      }
      const p3 = i * 3;
      const drag = 1 - this._drag[i] * dt;
      vel[p3] *= drag; vel[p3 + 2] *= drag;
      vel[p3 + 1] = vel[p3 + 1] * drag - this._grav[i] * dt;
      pos[p3] += vel[p3] * dt;
      pos[p3 + 1] += vel[p3 + 1] * dt;
      pos[p3 + 2] += vel[p3 + 2] * dt;
      if (pos[p3 + 1] < 0.02) { pos[p3 + 1] = 0.02; vel[p3 + 1] *= -0.28; }
      const t = this._life[i] / this._maxLife[i];
      const p4 = i * 4;
      col[p4 + 3] = t;
      const sh = this._shrink[i];
      this._size[i] = sh === 2
        ? this._baseSize[i] * (0.35 + (1 - t) * 1.4)
        : this._baseSize[i] * (0.25 + t * 0.75);
    }
    this._geo.attributes.position.needsUpdate = true;
    this._geo.attributes.aColor.needsUpdate = true;
    this._geo.attributes.aSize.needsUpdate = true;

    // --- staged effects ---
    for (let i = this._timers.length - 1; i >= 0; i--) {
      const t = this._timers[i];
      t.life -= dt;
      if (t.update) t.update(dt, t.obj, 1 - Math.max(0, t.life) / t.maxLife);
      if (t.life <= 0) {
        if (t.dispose) t.dispose(t.obj);
        const last = this._timers.pop();
        if (i < this._timers.length) this._timers[i] = last;
      }
    }
  }

  // ---------------------------------------------------------------- helpers
  _timer(life, obj, update, dispose) {
    this._timers.push({ obj, life, maxLife: life, update, dispose });
    return obj;
  }

  _takeFx(kind) {
    const pool = this._fxPools[kind];
    return pool.pop() ?? null;
  }

  _returnFx(kind, mesh) {
    mesh.visible = false;
    this._fxPools[kind].push(mesh);
  }

  // Allocate the whole light budget up front and park it in the scene. Creating
  // a light mid-combat changes Three.js' light-count hash, which recompiles every
  // lit program on that frame (~17 programs, ~90ms at x4 CPU throttle).
  warmLights(count = 8) {
    while (this._lightsCreated < count) {
      const l = new THREE.PointLight(0xffffff, 0, 8, 2);
      l.visible = true;
      l.userData._returned = true;
      this.scene.add(l);
      this._lightsCreated++;
      this._lightPool.push(l);
    }
  }

  _returnLight(l) {
    if (!l || l.userData._returned) return;
    l.userData._returned = true;
    // Keep the light attached AND visible with intensity 0: flipping .visible or
    // add/remove changes Three.js' light-count hash and recompiles every lit program.
    l.visible = true;
    l.intensity = 0;
    if (this._lightPool.length < 10) this._lightPool.push(l);
  }

  _light(x, y, z, color, intensity, distance, life, decayFlicker = 0.5) {
    let l = this._lightPool.pop();
    if (!l) {
      if (this._lightsCreated >= 8) return null; // total light budget
      this._lightsCreated++;
      l = new THREE.PointLight(0xffffff, 0, 8, 2);
      l.userData._returned = false;
    }
    l.userData._returned = false;
    l.color.set(color);
    l.intensity = intensity;
    l.distance = distance;
    l.position.set(x, y, z);
    l.visible = true;
    if (!l.parent) this.scene.add(l); // attach once: add/remove recompiles every lit program
    const base = intensity;
    this._timer(life, l, (dt, obj, t) => {
      obj.intensity = base * (1 - t) * (0.85 + Math.random() * decayFlicker);
    }, (obj) => {
      this._returnLight(obj);
    });
    return l;
  }

  // Fullscreen flash rendered INSIDE the WebGL canvas: a camera-anchored additive
  // quad. The old DOM overlay (semi-transparent div above the canvas) forced the
  // compositor to blend the whole canvas every frame it was visible, which stalled
  // weak machines ~80ms on boss-death frames.
  screenFlash(color = 0xff8a3d, strength = 0.35, life = 0.35) {
    if (this._flashQuadMat === undefined) {
      this._flashQuadGeo = new THREE.PlaneGeometry(2, 2);
      this._flashQuadMat = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false,
        fog: false, side: THREE.DoubleSide,
      });
    }
    // single reusable quad — flashes never overlap in practice
    let mesh = this._flashQuad;
    if (!mesh) {
      mesh = new THREE.Mesh(this._flashQuadGeo, this._flashQuadMat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 999;
      this._flashQuad = mesh;
    }
    mesh.material.color.set(color);
    mesh.material.opacity = Math.min(0.85, strength);
    mesh.visible = true;
    this.scene.add(mesh);
    mesh.position.copy(this.game.camera.position);
    mesh.quaternion.copy(this.game.camera.quaternion);
    mesh.translateZ(-0.5);
    const base = Math.min(0.85, strength);
    this._timer(life, mesh, (dt, obj, t) => {
      obj.material.opacity = base * (1 - t) * (1 - t);
      obj.position.copy(this.game.camera.position);
      obj.quaternion.copy(this.game.camera.quaternion);
      obj.translateZ(-0.5);
    }, (obj) => { obj.visible = false; });
    return mesh;
  }

  // Public: short-lived dynamic light for skill choreography.
  flashLight(position, opts = {}) {
    return this._light(
      position.x, position.y ?? 1, position.z,
      opts.color ?? 0xffaa55, opts.intensity ?? 4,
      opts.distance ?? 8, opts.life ?? 0.3, opts.flicker ?? 0.5,
    );
  }

  _fadeMesh(mesh, life, update, dispose) {
    if (mesh.material) mesh.userData._origOpacity = mesh.material.opacity;
    this._timer(life, mesh, (dt, obj, t) => {
      if (update) update(dt, obj, t);
    }, dispose);
    return mesh;
  }

  // ---------------------------------------------------------------- rings
  ring(position, opts = {}) {
    const radius = opts.radius ?? 4;
    const color = opts.color ?? 0xff6b2b;
    const life = opts.life ?? 0.45;
    const height = opts.height ?? 0.1;
    const thickness = opts.thickness ?? 0.25;
    const startRadius = opts.startRadius ?? 0.2;
    const mesh = this._takeFx('ring');
    if (!mesh) return null;
    mesh.material.color.set(color);
    mesh.material.opacity = 0.9;
    mesh.position.set(position.x, position.y + height, position.z);
    mesh.rotation.set(-Math.PI / 2, 0, Math.random() * Math.PI * 2);
    mesh.scale.setScalar(0.01);
    mesh.visible = true;
    mesh.userData._fade = false; // custom alpha handling
    this._fadeMesh(mesh, life, (dt, obj, t) => {
      const r = startRadius + (radius - startRadius) * (1 - (1 - t) * (1 - t));
      obj.scale.set(r / 0.67, r / 0.67, 1);
      const fade = 1 - t;
      obj.material.opacity = 0.95 * fade * fade;
    }, (obj) => {
      this._returnFx('ring', obj);
    });
    return mesh;
  }

  shockwave(position, opts = {}) {
    // Vertical ring expanding outward — a wall of force.
    const radius = opts.radius ?? 3.5;
    const color = opts.color ?? 0xffc37a;
    const life = opts.life ?? 0.5;
    const height = opts.height ?? 1.6;
    const tilt = opts.tilt ?? 0;
    const mesh = this._takeFx('shock');
    if (!mesh) return null;
    mesh.material.color.set(color);
    mesh.material.opacity = 0.85;
    mesh.position.set(position.x, position.y + height * 0.5, position.z);
    mesh.rotation.set(Math.PI / 2 + tilt, Math.random() * Math.PI, 0);
    mesh.scale.setScalar(1);
    mesh.visible = true;
    mesh.userData._fade = false;
    this._fadeMesh(mesh, life, (dt, obj, t) => {
      const r = 0.3 + radius * (1 - Math.pow(1 - t, 2));
      obj.scale.set(r / 0.67, r / 0.67, 1);
      obj.material.opacity = 0.85 * (1 - t) * (1 - t);
      obj.position.y = position.y + height * 0.5 * (1 - t * 0.4);
    }, (obj) => {
      this._returnFx('shock', obj);
    });
    return mesh;
  }

  // ---------------------------------------------------------------- beams
  beam(from, to, opts = {}) {
    const color = opts.color ?? 0xffd9a0;
    const width = opts.width ?? 0.08;
    const life = opts.life ?? 0.25;
    const dir = this._v1.copy(to).sub(from);
    const len = dir.length();
    if (len < 0.01) return null;
    const geo = new THREE.CylinderGeometry(width, width * 0.6, len, 6, 1, true);
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(from).addScaledVector(dir, 0.5 * len);
    mesh.quaternion.setFromUnitVectors(UP_VEC, dir.normalize());
    mesh.userData._fade = false;
    this.scene.add(mesh);
    this._fadeMesh(mesh, life, (dt, obj, t) => {
      obj.material.opacity = 0.95 * (1 - t) * (1 - t);
      obj.scale.x = 1 + t * 1.2;
      obj.scale.z = 1 + t * 1.2;
    }, (obj) => {
      this.scene.remove(obj);
      obj.geometry.dispose();
      obj.material.dispose();
    });
    this._light((from.x + to.x) / 2, (from.y + to.y) / 2 + 0.3, (from.z + to.z) / 2,
      color, 2.2, 6, life * 0.8, 0.3);
    return mesh;
  }

  // ---------------------------------------------------------------- lightning
  lightning(from, to, opts = {}) {
    const color = opts.color ?? 0x9d7bff;
    const life = opts.life ?? 0.25;
    const jitter = opts.jitter ?? 0.4;
    const branches = opts.branches ?? 2;
    const group = new THREE.Group();

    const buildArc = (a, b, jag) => {
      const pts = [];
      const segs = 7;
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const p = new THREE.Vector3().lerpVectors(a, b, t);
        if (i > 0 && i < segs) {
          p.x += (Math.random() - 0.5) * jag;
          p.y += (Math.random() - 0.5) * jag * 0.7;
          p.z += (Math.random() - 0.5) * jag;
        }
        pts.push(p);
      }
      return pts;
    };

    const makeBolt = (pts, width, op) => {
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const mat = new THREE.LineBasicMaterial({
        color, transparent: true, opacity: op,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      });
      const line = new THREE.Line(geo, mat);
      group.add(line);
    };

    // Core bolt (brighter, thicker via duplicate lines slightly offset)
    const main = buildArc(from, to, jitter);
    makeBolt(main, 2, 1);
    makeBolt(buildArc(from, to, jitter * 0.5), 1, 0.5);
    // glow halo around main bolt
    const haloPts = main.map((p) => new THREE.Vector3(
      p.x + (Math.random() - 0.5) * 0.06,
      p.y + (Math.random() - 0.5) * 0.06,
      p.z + (Math.random() - 0.5) * 0.06,
    ));
    const haloGeo = new THREE.BufferGeometry().setFromPoints(haloPts);
    group.add(new THREE.Line(haloGeo, new THREE.LineBasicMaterial({
      color, transparent: true, opacity: 0.3,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    })));
    // Branches
    for (let bi = 0; bi < branches; bi++) {
      const idx = 2 + Math.floor(Math.random() * (main.length - 3));
      const start = main[idx].clone();
      const endDir = this._v1.copy(start).sub(to).normalize();
      const blen = 1.2 + Math.random() * 2;
      const end = new THREE.Vector3(
        start.x + endDir.x * blen + (Math.random() - 0.5) * 2,
        start.y - 0.4 - Math.random() * 1.2,
        start.z + endDir.z * blen + (Math.random() - 0.5) * 2,
      );
      makeBolt(buildArc(start, end, jitter * 0.8), 1, 0.55);
    }

    this.scene.add(group);
    const light = this._light(
      (from.x + to.x) / 2, (from.y + to.y) / 2 + 0.4, (from.z + to.z) / 2,
      color, 3, 7, life, 0.9,
    );
    this._fadeMesh(group, life, (dt, obj, t) => {
      obj.traverse((child) => {
        if (child.material) child.material.opacity *= Math.max(0, 1 - dt * 5.5);
      });
      if (light) light.intensity = Math.max(0, light.intensity - dt * 12);
    }, (obj) => {
      obj.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
      });
      this.scene.remove(obj);
    });
    return group;
  }

  // ---------------------------------------------------------------- slash
  slash(position, angle, opts = {}) {
    const color = opts.color ?? 0xffd9a0;
    const radius = opts.radius ?? 2.4;
    const life = opts.life ?? 0.22;
    const arc = opts.arc ?? Math.PI * 0.8;
    const height = opts.height ?? 1.0;
    const y = position.y + height * 0.5;

    const shape = new THREE.Shape();
    const inner = radius * 0.42;
    const steps = 20;
    for (let i = 0; i <= steps; i++) {
      const a = -arc / 2 + (arc * i) / steps;
      const x = Math.cos(a) * radius, yy = Math.sin(a) * radius;
      if (i === 0) shape.moveTo(x, yy); else shape.lineTo(x, yy);
    }
    for (let i = steps; i >= 0; i--) {
      const a = -arc / 2 + (arc * i) / steps;
      const x = Math.cos(a) * inner, yy = Math.sin(a) * inner;
      shape.lineTo(x, yy);
    }
    const geo = new THREE.ShapeGeometry(shape, 4);
    const opacity = opts.opacity ?? 0.55;
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(position.x, y, position.z);
    mesh.rotation.x = -Math.PI / 2 + (opts.tilt ?? 0.35);
    mesh.rotation.z = angle - Math.PI / 2;
    mesh.userData._fade = false;
    this.scene.add(mesh);
    this._fadeMesh(mesh, life, (dt, obj, t) => {
      obj.rotation.z = angle - Math.PI / 2 + t * 0.9;
      obj.material.opacity = opacity * (1 - t);
      const s = 1 + t * 0.35;
      obj.scale.set(s, s, 1);
    }, (obj) => {
      this.scene.remove(obj);
      obj.geometry.dispose();
      obj.material.dispose();
    });
    return mesh;
  }

  // ---------------------------------------------------------------- rune circle
  runeCircle(position, opts = {}) {
    const color = opts.color ?? 0xff6b2b;
    const radius = opts.radius ?? 2.2;
    const life = opts.life ?? 1.0;
    const rotate = opts.rotate !== false;
    const mesh = this._takeFx('rune');
    if (!mesh) return null;
    mesh.material.color.set(color);
    mesh.material.opacity = 0.95;
    mesh.position.set(position.x, position.y + 0.06, position.z);
    mesh.rotation.set(-Math.PI / 2, 0, 0);
    mesh.scale.setScalar(radius);
    mesh.visible = true;
    mesh.userData._fade = false;
    this._fadeMesh(mesh, life, (dt, obj, t) => {
      if (rotate) obj.rotation.z += dt * 1.4;
      const pulse = opts.pulse ? 0.55 + 0.45 * Math.sin(this.time * 10) : 1;
      obj.material.opacity = Math.min(1, 2.4 * t) * (1 - t * t) * pulse;
      obj.scale.setScalar(radius * (0.6 + 0.4 * Math.min(1, t * 3)));
    }, (obj) => {
      this._returnFx('rune', obj);
    });
    this._light(position.x, position.y + 0.5, position.z, color, 2.5, radius * 3, Math.min(life, 0.8), 0.4);
    return mesh;
  }

  // ---------------------------------------------------------------- impact / explosion
  impact(position, color, scale = 1) {
    this.burst(position, { count: 10 + 8 * scale, color, size: 0.14 * scale, speed: 5 * scale, life: 0.4 });
    this.sparks(position, { count: 6 + 6 * scale, color: 0xffe6b0, speed: 8 * scale });
    this._light(position.x, position.y + 0.4, position.z, color, 3 * scale, 6 * scale, 0.18, 0.6);
  }

  explosion(position, opts = {}) {
    const radius = opts.radius ?? 3;
    const color = opts.color ?? 0xff6b2b;
    const scale = opts.scale ?? radius / 3;
    // Particle + effect counts are tuned so a boss death stays under ~250
    // live particles per frame — the previous 144+ burst stalled weaker GPUs.
    this.burst(position, { count: Math.min(34 * scale, 52), color, size: 0.2 * scale, speed: 9 * scale, life: 0.8, gravity: 4, up: 1 });
    this.smoke(position, { count: Math.min(6 * scale, 10), radius: radius * 0.35, size: 0.6 * scale, life: 1.4 });
    this.sparks(position, { count: 12, color: 0xffd9a0, speed: 11 * scale });
    this.ring(position, { radius, color: 0xffc37a, life: 0.5, height: 0.12, thickness: 0.4 });
    this.shockwave(position, { radius: radius * 0.8, color, life: 0.45, height: 1.4 });
    this._light(position.x, position.y + 1, position.z, 0xffa14d, 8 * scale, radius * 4, 0.4, 0.7);
    this.embers(position, { count: 10, color, life: 1.2 });
    return { light: true };
  }

  // ---------------------------------------------------------------- frost
  frostBurst(position, opts = {}) {
    const radius = opts.radius ?? 4;
    const color = opts.color ?? 0x6fd8ff;
    this.burst(position, {
      count: Math.min(40, 70), color, size: 0.16, speed: 7.5,
      life: 0.7, spread: 0.9, gravity: 2, up: 0.9, drag: 1.2,
    });
    // crystal spikes: cheap cones, additive-ish
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.75,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const geo = new THREE.ConeGeometry(1, 1, 5);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + Math.random() * 0.4;
      const d = 0.5 + Math.random() * 0.5;
      const h = (0.7 + Math.random() * 1.3) * (opts.spikeScale ?? 1);
      const cone = new THREE.Mesh(geo, mat);
      cone.position.set(
        position.x + Math.cos(a) * radius * 0.55 * d,
        h * 0.5 * 0.8,
        position.z + Math.sin(a) * radius * 0.55 * d,
      );
      cone.scale.set(0.16 + Math.random() * 0.12, h, 0.16 + Math.random() * 0.12);
      cone.rotation.set((Math.random() - 0.5) * 0.5, 0, (Math.random() - 0.5) * 0.5);
      group.add(cone);
    }
    this.scene.add(group);
    this._fadeMesh(group, 1.1, null, (obj) => {
      this.scene.remove(obj);
      obj.traverse((c) => { if (c.geometry) c.geometry.dispose(); });
      mat.dispose();
    });
    this.ring(position, { radius, color: 0xbdf3ff, life: 0.5, height: 0.1 });
    this._light(position.x, position.y + 0.8, position.z, color, 5, radius * 3.4, 0.5, 0.5);
  }

  // ---------------------------------------------------------------- void rift
  voidRift(position, opts = {}) {
    const life = opts.life ?? 2.2;
    const radius = opts.radius ?? 2.2;
    const group = new THREE.Group();

    // spinning disc: dark core with purple rim — uses rune texture tinted violet
    const disc = new THREE.Mesh(
      this._sharedGeo.plane,
      new THREE.MeshBasicMaterial({
        map: this._runeTex, color: 0x2a0a44, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.scale.setScalar(radius);
    group.add(disc);

    const rim = new THREE.Mesh(
      this._sharedGeo.ring,
      new THREE.MeshBasicMaterial({
        color: 0xb46bff, transparent: true, opacity: 0.8,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
      }),
    );
    rim.rotation.x = -Math.PI / 2;
    rim.scale.setScalar(radius / 0.67);
    group.add(rim);

    group.position.set(position.x, 0.08, position.z);
    this.scene.add(group);
    this._fadeMesh(group, life, (dt, obj, t) => {
      disc.rotation.z += dt * 2.2;
      rim.rotation.z -= dt * 1.1;
      const pulse = 1 + Math.sin(this.time * 9) * 0.06;
      obj.scale.setScalar(pulse);
    }, (obj) => {
      this.scene.remove(obj);
      obj.traverse((c) => { if (c.material) c.material.dispose(); });
    });
    // drifting void motes
    const n = 18;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = radius * (0.3 + Math.random() * 0.7);
      this._spawnParticle(
        position.x + Math.cos(a) * r, 0.15 + Math.random() * 1.6, position.z + Math.sin(a) * r,
        0, -0.4 - Math.random() * 0.5, 0,
        0.62, 0.18, 1.0, 0.1 + Math.random() * 0.08, life * (0.6 + Math.random() * 0.7),
        -0.2, 0.4, 1,
      );
    }
    this._light(position.x, position.y + 1, position.z, 0xb46bff, 4, radius * 3, Math.min(life, 1), 0.5);
    return group;
  }

  // ---------------------------------------------------------------- meteor
  meteorFall(from, to, opts = {}) {
    // A burning rock falls from the sky toward `to`. Telegraph already drawn by caller.
    const color = opts.color ?? 0xff6b2b;
    const duration = opts.duration ?? 0.65;
    const start = this._v1.set(to.x + 6, 16, to.z - 4).clone();
    const rock = new THREE.Group();

    const core = new THREE.Mesh(
      this._sharedGeo.sphere,
      new THREE.MeshBasicMaterial({ color: 0xffb066, fog: false }),
    );
    core.scale.setScalar(0.5);
    rock.add(core);
    const shell = new THREE.Mesh(
      this._sharedGeo.sphere,
      new THREE.MeshBasicMaterial({
        color: 0x2a140c, transparent: true, opacity: 0.85, fog: false,
      }),
    );
    shell.scale.setScalar(0.75);
    rock.add(shell);
    rock.position.copy(start);
    this.scene.add(rock);

    const trailLight = this._light(to.x, 8, to.z, 0xff7a2f, 5, 12, duration + 0.3, 0.5);

    this._timer(duration, rock, (dt, obj, t) => {
      obj.position.lerpVectors(start, to, t * t);
      obj.rotation.x += dt * 9; obj.rotation.y += dt * 7;
      // fire trail
      this._spawnParticle(
        obj.position.x + (Math.random() - 0.5) * 0.5,
        obj.position.y + (Math.random() - 0.5) * 0.5,
        obj.position.z + (Math.random() - 0.5) * 0.5,
        (Math.random() - 0.5) * 1.5, -2 - Math.random() * 2, (Math.random() - 0.5) * 1.5,
        1, 0.42 + Math.random() * 0.2, 0.12, 0.3 + Math.random() * 0.25, 0.45, -3, 1.2, 1,
      );
      this._spawnParticle(
        obj.position.x + (Math.random() - 0.5) * 0.6,
        obj.position.y + (Math.random() - 0.5) * 0.6,
        obj.position.z + (Math.random() - 0.5) * 0.6,
        (Math.random() - 0.5) * 0.8, -1 - Math.random(), (Math.random() - 0.5) * 0.8,
        0.35, 0.32, 0.34, 0.55, 0.7, -1, 1.6, 2,
      );
      if (trailLight) trailLight.position.copy(obj.position);
    }, (obj) => {
      this.scene.remove(obj);
      this._returnLight(trailLight);
    });
    return rock;
  }

  // ---------------------------------------------------------------- blizzard
  blizzardZone(position, opts = {}) {
    const radius = opts.radius ?? 6;
    const life = opts.duration ?? 5;
    const color = opts.color ?? 0x9adfff;
    const group = new THREE.Group();

    const disc = new THREE.Mesh(
      this._sharedGeo.plane,
      new THREE.MeshBasicMaterial({
        map: this._runeTex, color: 0x1a3a4d, transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }),
    );
    disc.rotation.x = -Math.PI / 2;
    disc.scale.setScalar(radius * 0.9);
    group.add(disc);

    const rim = new THREE.Mesh(
      this._sharedGeo.ring,
      new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.5,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
      }),
    );
    rim.rotation.x = -Math.PI / 2;
    rim.scale.setScalar(radius / 0.67);
    group.add(rim);
    group.position.set(position.x, 0.07, position.z);
    this.scene.add(group);

    const light = this._light(position.x, position.y + 2.2, position.z, color, 3.2, radius * 2.6, life, 0.3);

    // Persistent snowfall handled in update loop via emitter timer
    const snowState = { t: 0 };
    this._timer(life, group, (dt, obj, t) => {
      disc.rotation.z += dt * 0.5;
      rim.rotation.z -= dt * 0.3;
      rim.material.opacity = 0.5 * Math.min(1, t * 6) * Math.min(1, (1 - t) * 4);
      disc.material.opacity = 0.55 * Math.min(1, t * 6) * Math.min(1, (1 - t) * 4);
      snowState.t += dt;
      // emit snow particles at ~40/s
      const emit = Math.min(3, Math.floor(snowState.t * 40));
      if (emit > 0) {
        snowState.t -= emit / 40;
        for (let i = 0; i < emit; i++) {
          const a = Math.random() * Math.PI * 2;
          const r = radius * Math.sqrt(Math.random());
          this._spawnParticle(
            position.x + Math.cos(a) * r, 3.2 + Math.random() * 1.5, position.z + Math.sin(a) * r,
            (Math.random() - 0.5) * 1.6, -3.4 - Math.random() * 1.4, (Math.random() - 0.5) * 1.6,
            0.85, 0.95, 1.0, 0.09 + Math.random() * 0.05, 1.1, 0, 0.1, 1,
          );
        }
      }
      if (light) {
        light.position.x = position.x + Math.sin(this.time * 3) * radius * 0.3;
        light.position.z = position.z + Math.cos(this.time * 2.4) * radius * 0.3;
      }
    }, (obj) => {
      this.scene.remove(obj);
      obj.traverse((c) => { if (c.material) c.material.dispose(); });
      this._returnLight(light);
    });
    return group;
  }

  // ---------------------------------------------------------------- black hole
  blackHole(position, opts = {}) {
    const duration = opts.duration ?? 1.6;
    const radius = opts.radius ?? 3;
    const color = opts.color ?? 0xb46bff;
    const group = new THREE.Group();
    group.position.set(position.x, 1.2, position.z);

    // Black core: renders dark by plain material (no additive)
    const core = new THREE.Mesh(
      this._sharedGeo.sphere,
      new THREE.MeshBasicMaterial({ color: 0x090313, fog: false }),
    );
    core.scale.setScalar(0.55);
    group.add(core);

    // Accretion rings: tilted swirl rings orbiting the core
    const rings = [];
    for (let i = 0; i < 3; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: i === 0 ? 0x3a1560 : color, transparent: true, opacity: 0.85 - i * 0.22,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
      });
      const ring = new THREE.Mesh(this._sharedGeo.ring, mat);
      ring.rotation.x = Math.PI / 2 + (i - 1) * 0.5;
      ring.rotation.y = i * 1.1;
      ring.scale.setScalar((1.1 + i * 0.75) / 0.67);
      group.add(ring);
      rings.push(ring);
    }

    // Inward-spiraling particles spawned continuously
    const emitState = { t: 0 };
    this.scene.add(group);
    this._timer(duration, group, (dt, obj, t) => {
      for (const ring of rings) {
        ring.rotation.z += dt * (2.5 - t * 1.2);
      }
      const pulse = 1 + Math.sin(this.time * 11) * 0.08;
      core.scale.setScalar(0.55 * pulse * (1 + t * 0.9));
      obj.rotation.y += dt * 0.6;
      obj.scale.setScalar(1 + t * 0.4);
      emitState.t += dt;
      const emit = Math.min(4, Math.floor(emitState.t * 55));
      if (emit > 0) {
        emitState.t -= emit / 55;
        for (let i = 0; i < emit; i++) {
          const a = Math.random() * Math.PI * 2;
          const el = Math.random() * Math.PI - Math.PI / 2;
          const r = radius * (0.9 + Math.random() * 0.6);
          // spawn far out, velocity inward + swirl
          this._spawnParticle(
            obj.position.x + Math.cos(a) * r,
            obj.position.y + Math.sin(el) * r * 0.5,
            obj.position.z + Math.sin(a) * r,
            -Math.cos(a) * 4.5, -Math.sin(el) * 2.2, -Math.sin(a) * 4.5,
            0.72, 0.34, 1.0, 0.1 + Math.random() * 0.08, 0.55, 0, 0.6, 1,
          );
        }
      }
    }, (obj) => {
      this.scene.remove(obj);
      obj.traverse((c) => { if (c.material) c.material.dispose(); });
    });
    this._light(position.x, 2.2, position.z, color, 6, radius * 3.2, duration, 0.4);
    return group;
  }

  // ---------------------------------------------------------------- misc helpers
  groundScorch(position, radius = 2.4, life = 4, color = 0x0d0704) {
    // Non-additive dark decal that slowly fades. Uses plane.
    const mesh = new THREE.Mesh(
      this._sharedGeo.plane,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, depthWrite: false, fog: false }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(position.x, 0.03, position.z);
    mesh.scale.setScalar(radius);
    mesh.userData._fade = false;
    this.scene.add(mesh);
    this._fadeMesh(mesh, life, (dt, obj, t) => {
      obj.material.opacity = 0.75 * Math.min(1, t * 5) * (1 - t * t);
    }, (obj) => {
      this.scene.remove(obj);
      obj.material.dispose();
    });
    return mesh;
  }

  clear() {
    for (const t of this._timers) {
      if (t.dispose) t.dispose(t.obj);
      else if (t.obj && t.obj.parent) t.obj.parent.remove(t.obj);
    }
    this._timers.length = 0;
    for (const l of this._lightPool) l.userData._returned = false;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this._alive[i]) {
        this._alive[i] = 0;
        this._size[i] = 0;
        this._free.push(i);
      }
    }
    this._live.length = 0;
    this._frameEmitted = 0;
    if (this._flashQuad) this._flashQuad.visible = false;
  }

  dispose() {
    this.clear();
    for (const kind of Object.keys(this._fxPools)) {
      for (const m of this._fxPools[kind]) {
        m.material.dispose();
        this.scene.remove(m);
      }
      this._fxPools[kind].length = 0;
    }
    this.scene.remove(this._points);
    this._geo.dispose();
    this._mat.dispose();
    this._spriteTex.dispose();
    this._runeTex.dispose();
    for (const g of Object.values(this._sharedGeo)) g.dispose();
    for (const l of this._lightPool) l.dispose();
    this._lightPool.length = 0;
  }
}
