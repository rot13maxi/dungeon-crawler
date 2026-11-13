import * as THREE from 'three';
import { ENEMY_TYPES } from '../data/enemies.js';
import { buildModel } from './models.js';

// ------------------------------------------------------------------ helpers

const _P1 = new THREE.Vector3();
const _P2 = new THREE.Vector3();
const _P3 = new THREE.Vector3();
const _DIR = new THREE.Vector3();

function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rand = (a, b) => a + Math.random() * (b - a);

// status visuals need the full duration, not the remaining time
const STATUS_COLORS = {
  burn: 0xff5a22,
  chill: 0x7bdcff,
  shock: 0x9d7bff,
  void: 0xb46bff,
};

const CHILL_SLOW = 0.55; // 55% speed reduction while chilled
const SHOCK_AMP = 1.15; // +15% damage taken while shocked
const LEASH_SLACK = 2.5; // meters beyond room bounds before returning home

/**
 * Stylized enemy with per-AI behaviour: melee chaser, ranged archer, caster,
 * brute slam and the multi-phase Ashen Warden boss. Damage always flows
 * through game.dealDamage / game.damagePlayer.
 */
export class Enemy {
  constructor(scene, game, defId, position, roomIndex, opts = {}) {
    this.scene = scene;
    this.game = game;
    const def = ENEMY_TYPES[defId] ?? ENEMY_TYPES.skeleton;
    this.def = def;
    this.defId = defId;
    this.roomIndex = roomIndex;
    this.elite = opts.elite ?? null;
    this.isBoss = !!(opts.boss || defId === 'boss');
    this.phase = 1;

    const model = buildModel(defId);
    this.model = model;
    this.group = model.group;
    this.parts = model.parts;
    this._mats = model.materials;

    const eliteHp = this.elite?.hp ?? 1;
    this.scaleHp = opts.scaleHp ?? 1;
    this.maxHp = Math.round(def.hp * eliteHp * this.scaleHp);
    this.hp = this.maxHp;
    this.damage = def.damage * (this.elite?.damage ?? 1) * (opts.scaleDamage ?? 1);
    this.xp = Math.round(def.xp * (this.elite ? 1.9 : 1) * (opts.scaleXp ?? 1));
    this.radius = def.radius;
    this.name = this.isBoss
      ? def.name
      : this.elite ? `${this.elite.name} ${def.name}` : def.name;
    this.dead = false;
    this.dying = false;
    this.speedMul = 1;
    this.statuses = {};
    this._statusVfx = {};

    this._scale = this.isBoss ? 1 : this.elite ? 1.24 : 1;
    this.group.scale.setScalar(this._scale);
    this.bodyHeight = model.meta.height * this._scale;
    if (this.elite?.aura) this._tintModel(this.elite.color);

    // capture limb rest poses once
    this._rest = {};
    for (const key of ['armL', 'armR', 'legL', 'legR']) {
      this._rest[key] = this.parts[key]?.rotation.clone() ?? null;
    }

    // AI state
    this._state = 'idle';
    this._stateT = 0;
    this._attackCd = rand(0.4, 1.1); // stagger attacks so packs don't sync
    this._animPhase = Math.random() * 6.28;
    this._flash = 0;
    this._knock = new THREE.Vector3();
    this._chargeVec = new THREE.Vector3();
    this._strafeDir = Math.random() < 0.5 ? -1 : 1;
    this._lastSpeed = 0;
    this._baseScale = this.group.scale.x || 1;
    this._dt = 1 / 60;
    this._disposed = false;
    const room = game.dungeon?.rooms?.[roomIndex];
    this._bounds = room?.bounds ?? {
      minX: position.x - 14, maxX: position.x + 14,
      minZ: position.z - 14, maxZ: position.z + 14,
    };
    this._homeCenter = position.clone();

    // aura ring under elites + boss
    if (this.elite?.aura || this.isBoss) {
      const color = this.isBoss ? def.accent : (this.elite.color ?? 0xff6b2b);
      const geo = new THREE.RingGeometry(this.radius * 1.1, this.radius * 1.42, 24);
      const mat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: this.isBoss ? 0.4 : 0.3,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      });
      this._aura = new THREE.Mesh(geo, mat);
      this._aura.rotation.x = -Math.PI / 2;
      this._aura.position.y = 0.05;
      this.group.add(this._aura);
    }

    // boss core: pulsing heart of the Warden
    if (this.isBoss) {
      this._coreMat = this.parts.core?.material ?? null;
      this._coreMat2 = this.parts.coreInner?.material ?? null;
      this._coreMesh = this.parts.core ?? null;
    }

    this.group.position.copy(position);
    this.group.position.y = 0;
    scene.add(this.group);
  }

  get position() { return this.group.position; }

  get isChilled() { return this.hasStatus('chill'); }

  // ------------------------------------------------------------ helpers

  _face(target, dt, rate = 10) {
    const dx = target.x - this.group.position.x;
    const dz = target.z - this.group.position.z;
    if (dx * dx + dz * dz < 1e-6) return;
    const want = Math.atan2(dx, dz);
    this.group.rotation.y = lerpAngle(this.group.rotation.y, want, 1 - Math.exp(-rate * dt));
  }

  _dist2ToPlayer() {
    const p = this.game.player?.position;
    if (!p) return Infinity;
    const dx = p.x - this.group.position.x;
    const dz = p.z - this.group.position.z;
    return dx * dx + dz * dz;
  }

  _playerActive() {
    const p = this.game.player;
    return p && !p.dead && this.game.state === 'playing';
  }

  _step(dx, dz) {
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) return;
    const dungeon = this.game.dungeon;
    const pos = this.group.position;
    const r = this.radius * 0.9;
    if (!dungeon?.isWalkable) { pos.x += dx; pos.z += dz; return; }
    if (dungeon.isWalkable(pos.x + dx, pos.z, r)) pos.x += dx;
    if (dungeon.isWalkable(pos.x, pos.z + dz, r)) pos.z += dz;
  }

  _moveToward(tx, tz, speed, dt) {
    const pos = this.group.position;
    const dx = tx - pos.x;
    const dz = tz - pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-4) return 0;
    const slow = this.hasStatus('chill') ? CHILL_SLOW : 1;
    const step = speed * slow * this.speedMul * dt;
    this._step((dx / d) * step, (dz / d) * step);
    return d;
  }

  _strafe(dirSign, speed, dt) {
    // move perpendicular to the player direction
    const pos = this.group.position;
    const p = this.game.player.position;
    let dx = pos.x - p.x;
    let dz = pos.z - p.z;
    const d = Math.hypot(dx, dz) || 1;
    const slow = this.hasStatus('chill') ? CHILL_SLOW : 1;
    this._step((-dz / d) * dirSign * speed * slow * dt, (dx / d) * dirSign * speed * slow * dt);
  }

  _keepDistance(pref, speed, dt) {
    // approach if too far, retreat if too close, else strafe
    const d2 = this._dist2ToPlayer();
    const d = Math.sqrt(d2);
    const def = this.def;
    if (d > def.range * 0.92) {
      return this._moveToward(this.game.player.position.x, this.game.player.position.z, speed, dt);
    }
    if (d < pref) {
      const pos = this.group.position;
      const p = this.game.player.position;
      const dx = pos.x - p.x;
      const dz = pos.z - p.z;
      const l = d || 1;
      const slow = this.hasStatus('chill') ? CHILL_SLOW : 1;
      this._step((dx / l) * speed * slow * dt, (dz / l) * speed * slow * dt);
      return d;
    }
    this._strafe(this._strafeDir, speed * 0.5, dt);
    return d;
  }

  // Enemy-vs-enemy and enemy-vs-player separation so bodies don't stack.
  _separate(dt) {
    const enemies = this.game.enemies;
    const pos = this.group.position;
    let sx = 0, sz = 0, n = 0;
    if (enemies && enemies.length > 1) {
      for (let i = 0; i < enemies.length; i++) {
        const o = enemies[i];
        if (o === this || o.dead) continue;
        const dx = pos.x - o.position.x;
        const dz = pos.z - o.position.z;
        const minD = this.radius + o.radius;
        const d2 = dx * dx + dz * dz;
        if (d2 >= minD * minD || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        const push = (minD - d) / minD;
        sx += (dx / d) * push;
        sz += (dz / d) * push;
        n++;
      }
    }
    const player = this.game.player;
    if (player && !player.dead) {
      const dx = pos.x - player.position.x;
      const dz = pos.z - player.position.z;
      const minD = this.radius + player.radius;
      const d2 = dx * dx + dz * dz;
      if (d2 < minD * minD && d2 > 1e-8) {
        const d = Math.sqrt(d2);
        const push = (minD - d) / minD;
        sx += (dx / d) * push;
        sz += (dz / d) * push;
        n++;
      }
    }
    if (n > 0) this._step(sx * 2.2 * dt * n, sz * 2.2 * dt * n);
  }

  // Returns true when leashed: state set to 'return', enemy walks home and
  // ignores the player until back inside room bounds.
  _leashCheck() {
    const b = this._bounds;
    const pos = this.group.position;
    if (this._state === 'return') {
      this._moveToward(this._homeCenter.x, this._homeCenter.z, this.def.speed, this._dt);
      this._lastSpeed = this.def.speed;
      const distHome = Math.hypot(pos.x - this._homeCenter.x, pos.z - this._homeCenter.z);
      if (distHome < 1.2) this._state = 'idle'; // home again
      return true;
    }
    if (pos.x < b.minX - LEASH_SLACK || pos.x > b.maxX + LEASH_SLACK
      || pos.z < b.minZ - LEASH_SLACK || pos.z > b.maxZ + LEASH_SLACK) {
      this._state = 'return';
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ statuses

  applyStatus(type, duration, dps = 0) {
    if (this.dead || this.dying) return;
    const until = this.game.time + duration;
    const cur = this.statuses[type];
    if (!cur || cur.until < until) {
      this.statuses[type] = { until, dps };
    } else if (dps > (cur.dps ?? 0)) {
      cur.dps = dps;
    }
    if (type === 'chill') this.statuses.chill.slow = CHILL_SLOW;
    if (type === 'shock') this.statuses.shock.amp = SHOCK_AMP;
    this._applyStatusVisual(type, duration);
  }

  hasStatus(type) {
    const s = this.statuses[type];
    return !!(s && s.until > this.game.time);
  }

  _applyStatusVisual(type, duration) {
    const key = `${type}Ring`;
    const existing = this._statusVfx[key];
    if (existing && existing.userData._expireAt !== undefined) {
      // refresh the existing sigil's lifetime instead of stacking a new one
      existing.userData._expireAt = this.game.time + duration;
      return;
    }
    const mesh = this.game.vfx?.runeCircle?.(
      _P1.set(this.group.position.x, 0, this.group.position.z),
      { color: STATUS_COLORS[type], radius: this.radius * 2.1, life: duration + 0.4, pulse: true },
    );
    if (mesh) {
      mesh.userData._follow = this;
      mesh.userData._expireAt = this.game.time + duration;
      this._statusVfx[key] = mesh;
    }
  }

  _updateStatusVisuals() {
    const time = this.game.time;
    for (const key of Object.keys(this._statusVfx)) {
      const mesh = this._statusVfx[key];
      const statusActive = this.hasStatus(key.replace('Ring', ''));
      if (!statusActive || this.dead || this.dying) {
        // short fade tail, then the ring's own dispose fires
        const timer = mesh.userData._timer;
        if (timer) timer.life = Math.min(timer.life, 0.12);
        delete this._statusVfx[key];
      } else {
        mesh.position.set(this.group.position.x, 0.06, this.group.position.z);
        // keep it alive while the status persists
        mesh.userData._expireAt = time + 0.5;
      }
    }
  }

  _tickStatuses(dt) {
    const game = this.game;
    if (this.hasStatus('burn')) {
      this._burnAcc = (this._burnAcc ?? 0) + dt;
      if (this._burnAcc >= 0.5) {
        const tick = this._burnAcc;
        this._burnAcc = 0;
        game.dealDamage(this, this.statuses.burn.dps * tick, {
          element: 'fire', canCrit: false, noNumber: true, source: 'dot',
        });
      }
      if (!this.dead && Math.random() < dt * 8) {
        game.vfx?.spawnParticle?.(
          this.group.position.x + rand(-0.25, 0.25), rand(0.3, this.bodyHeight * 0.7), this.group.position.z + rand(-0.25, 0.25),
          0, 1.1, 0, 1.0, 0.45, 0.16, 0.12, 0.6, -0.6, 0.95, 0.8,
        );
      }
    } else {
      this._burnAcc = 0;
    }
    if (this.hasStatus('void') && Math.random() < dt * 6) {
      game.vfx?.spawnParticle?.(
        this.group.position.x + rand(-0.3, 0.3), rand(0.2, this.bodyHeight * 0.8), this.group.position.z + rand(-0.3, 0.3),
        0, 0.8, 0, 0.72, 0.25, 1.0, 0.12, 0.7, -0.5, 0.95, 0.8,
      );
    }
  }

  _tintModel(color) {
    for (const m of this._mats) {
      if (m.emissive && m.emissiveIntensity <= 0.01) {
        m.emissive.setHex(color);
        m.emissiveIntensity = 0.18;
      }
    }
  }

  // ------------------------------------------------------------ damage & death

  takeDamage(amount, opts = {}) {
    if (this.dead || this.dying) return false;
    if (this.hasStatus('shock')) amount *= SHOCK_AMP;
    this.hp -= amount;
    this._flash = 1;
    const kb = opts.knockback ?? 0;
    if (kb > 0 && !this.isBoss) {
      const from = opts.from ?? this.game.player?.position;
      if (from) {
        const dx = this.group.position.x - from.x;
        const dz = this.group.position.z - from.z;
        const d = Math.hypot(dx, dz) || 1;
        const power = Math.min(9, kb * 1.6 / this.def.radius);
        this._knock.x += (dx / d) * power;
        this._knock.z += (dz / d) * power;
      }
    }
    if (this.hp <= 0) {
      this.die();
      return true;
    }
    return false;
  }

  die() {
    if (this.dead || this.dying) return;
    this.dying = true;
    this.dead = true;
    this._dissolve = 0;
    const game = this.game;
    const pos = this.group.position;
    const h = this.bodyHeight * 0.5;
    // status rings must not outlive the body
    for (const key of Object.keys(this._statusVfx)) {
      const timer = this._statusVfx[key].userData._timer;
      if (timer) timer.life = Math.min(timer.life, 0.05);
      delete this._statusVfx[key];
    }
    game.vfx?.burst?.(_P1.set(pos.x, h, pos.z), {
      count: this.isBoss ? 40 : 20, color: this.isBoss ? 0xff5a22 : 0xd6cdb4,
      size: this.isBoss ? 0.2 : 0.13, speed: this.isBoss ? 8 : 5, life: 0.9, gravity: 2,
    });
    game.vfx?.impact?.(_P1, this.def.accent, this.isBoss ? 2.4 : 1);
    if (this.isBoss) {
      // explosion() already emits its own ring + shockwave; adding these two
      // explicit ones doubled the fullscreen additive overdraw and stalled
      // weaker GPUs for ~80ms on the boss-death frame.
      game.vfx?.explosion?.(_P1.set(pos.x, 1.4, pos.z), { radius: 5.5, color: 0xff5a22, scale: 1.7 });
      game.vfx?.shockwave?.(_P2.set(pos.x, 0, pos.z), { radius: 6.5, color: 0xffc37a, life: 0.55, height: 1.6 });
      game.audio?.play?.('fireball_explode', { volume: 1, rate: 0.7 });
      game.audio?.play?.('boss_roar', { volume: 0.9, rate: 0.55 });
      // Deliberately no screen flash: this frame already carries explosion +
      // shockwave + particles; a fullscreen blend on top costs ~65ms extra on
      // weak machines (measured x4 CPU throttle). Shake + roar carry the impact.
      game.screenShake?.(0.85, 0.9);
      game.hitstop?.(0.12);
      this._deathBursts = 3; // staggered secondary explosions during the collapse
      this._deathTimer = 0.35;
    } else {
      game.audio?.play?.('enemy_death', { volume: 0.4, rate: 0.85 + Math.random() * 0.3 });
      game.screenShake?.(this.elite ? 0.14 : 0.07, 0.15);
    }
    game.onEnemyKilled?.(this);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.scene.remove(this.group);
    this._aura?.geometry?.dispose();
    this._aura?.material?.dispose();
    for (const m of this._mats) m.dispose();
  }

  // ------------------------------------------------------------ main update

  update(dt) {
    if (this._disposed) return;
    const game = this.game;
    this._dt = dt;

    if (this.dying) {
      this._updateDeath(dt);
      return;
    }
    if (this.dead) return;

    if (this._flash > 0) {
      this._flash = Math.max(0, this._flash - dt * 5);
      this._applyFlash();
    }

    this._tickStatuses(dt);
    this._updateStatusVisuals();
    if (this.dead) return; // burn tick may have killed us

    if (!this._playerActive()) {
      this._animate(dt, 0);
      return;
    }

    // knockback integration
    if (this._knock.lengthSq() > 1e-6) {
      this._step(this._knock.x * dt, this._knock.z * dt);
      this._knock.multiplyScalar(Math.exp(-6 * dt));
    }

    this._separate(dt);
    this._lastSpeed = 0;
    const pd2 = this._dist2ToPlayer();
    const player = this.game.player;
    const leashed = !this.isBoss && this._leashCheck();

    if (this.isBoss) {
      this._updateBoss(dt, pd2, player);
    } else if (leashed) {
      this._face(this._homeCenter, dt, 6);
    } else if (this.def.ai === 'melee') {
      this._updateMelee(dt, pd2, player);
    } else if (this.def.ai === 'ranged') {
      this._updateRanged(dt, pd2, player);
    } else if (this.def.ai === 'caster') {
      this._updateCaster(dt, pd2, player);
    } else if (this.def.ai === 'brute') {
      this._updateBrute(dt, pd2, player);
    }

    this._animate(dt, this._lastSpeed);
    this._updateAura(dt);
  }

  _applyFlash() {
    if (!this._flashMats) {
      // non-glow standard materials only; leaves emissive accent mats untouched
      this._flashMats = this._mats.filter((m) => m.emissive && m.emissiveIntensity <= 0.01);
    }
    const f = this._flash;
    for (const m of this._flashMats) {
      if (f > 0) {
        if (m._baseEmissive === undefined) {
          m._baseEmissive = m.emissive.getHex();
          m._baseEmissiveInt = m.emissiveIntensity;
        }
        m.emissive.setHex(0xff3b2b);
        m.emissiveIntensity = Math.max(m._baseEmissiveInt, f * 1.6);
      } else if (m._baseEmissive !== undefined) {
        m.emissive.setHex(m._baseEmissive);
        m.emissiveIntensity = m._baseEmissiveInt;
        delete m._baseEmissive;
        delete m._baseEmissiveInt;
      }
    }
  }

  _updateAura(dt) {
    if (!this._aura) return;
    const t = this.game.time;
    this._aura.rotation.z += dt * 0.8;
    this._aura.material.opacity = (this.isBoss ? 0.3 : 0.22) + Math.sin(t * 3.1) * 0.08;
    if (Math.random() < dt * 0.5) this._strafeDir = -this._strafeDir;
  }

  // rough stereo pan from world X relative to the camera
  _panTo(pos) {
    const cam = this.game.camera;
    if (!cam) return 0;
    _DIR.setFromMatrixColumn(cam.matrixWorld, 0); // camera right vector
    return clamp((pos.x - cam.position.x) * _DIR.x / 12, -0.8, 0.8);
  }

  // ------------------------------------------------------------ melee AI

  _updateMelee(dt, pd2, player) {
    const d = Math.sqrt(pd2);
    const def = this.def;
    this._face(player.position, dt);

    if (this._state === 'windup') {
      this._stateT -= dt;
      this._lastSpeed = 0;
      if (this._stateT <= 0) this._strikeMelee(player);
      return;
    }
    if (this._state === 'recover') {
      this._stateT -= dt;
      this._lastSpeed = 0;
      if (this._stateT <= 0) this._state = 'idle';
      return;
    }

    if (d <= def.range * def.range) {
      if (this._attackCd <= 0) {
        this._state = 'windup';
        this._stateT = def.attackWindup;
        // telegraph: brief accent flare under the enemy
        this.game.vfx?.ring?.(_P1.set(this.group.position.x, 0, this.group.position.z), {
          radius: 1.1, color: this.def.accent, life: def.attackWindup * 0.9, height: 0.04, startRadius: 0.2,
        });
      }
      this._lastSpeed = 0;
    } else {
      const moved = this._moveToward(player.position.x, player.position.z, def.speed, dt);
      this._lastSpeed = def.speed * (moved > 0.01 ? 1 : 0);
    }
    this._attackCd -= dt;
  }

  _strikeMelee(player) {
    this._state = 'recover';
    this._stateT = 0.25;
    this._attackCd = this.def.attackCooldown;
    const game = this.game;
    const pos = this.group.position;
    const ppos = player.position;
    const dx = ppos.x - pos.x;
    const dz = ppos.z - pos.z;
    const dist = Math.hypot(dx, dz);
    // lunge
    if (dist > 0.01 && dist < this.def.range * 2.2) {
      this._step((dx / dist) * 0.3, (dz / dist) * 0.3);
    }
    game.audio?.play?.('swing', { volume: 0.35, rate: 0.9 + Math.random() * 0.2, pan: this._panTo(pos) });
    if (dist <= this.def.range + player.radius + 0.35) {
      game.damagePlayer(this.damage, this, { element: 'physical', knockback: 1.5 });
      game.vfx?.slash?.(_P1.set(ppos.x, 0.9, ppos.z), Math.atan2(dz, dx), {
        color: this.def.accent, radius: 1.3, life: 0.18, arc: Math.PI * 0.7, height: 0.8,
      });
      game.vfx?.impact?.(_P1, this.def.accent, 0.7);
    }
  }

  // ------------------------------------------------------------ ranged AI

  _updateRanged(dt, pd2, player) {
    const def = this.def;
    this._face(player.position, dt);

    if (this._state === 'windup') {
      this._stateT -= dt;
      this._lastSpeed = 0;
      // bow draw: hold still, aim glow at muzzle
      if (this._stateT <= 0) this._fireArrow(player);
      return;
    }
    if (this._state === 'recover') {
      this._stateT -= dt;
      this._lastSpeed = 0;
      if (this._stateT <= 0) this._state = 'idle';
      return;
    }

    this._keepDistance(def.range * 0.55, def.speed, dt);
    this._lastSpeed = def.speed;
    this._attackCd -= dt;
    if (this._attackCd <= 0 && pd2 <= def.range * def.range * 1.1 && this._hasLineOfSight()) {
      this._state = 'windup';
      this._stateT = def.attackWindup;
      const muzzle = _P1.setFromMatrixPosition(this.parts.muzzle.matrixWorld);
      this.game.vfx?.flashLight?.(muzzle, {
        color: this.def.accent, intensity: 1.6, distance: 3.5, life: def.attackWindup,
      });
    }
  }

  _hasLineOfSight() {
    // cheap LOS check: sample a few points toward the player
    const game = this.game;
    const pos = this.group.position;
    const p = game.player.position;
    const d = Math.hypot(p.x - pos.x, p.z - pos.z);
    const steps = Math.min(8, Math.max(2, Math.round(d / 1.5)));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (!game.dungeon.isWalkable(pos.x + (p.x - pos.x) * t, pos.z + (p.z - pos.z) * t, 0.2)) return false;
    }
    return true;
  }

  _fireArrow(player) {
    this._state = 'recover';
    this._stateT = 0.35;
    this._attackCd = this.def.attackCooldown;
    const game = this.game;
    const pos = this.group.position;
    const origin = new THREE.Vector3().setFromMatrixPosition(this.parts.muzzle.matrixWorld);
    const target = _P2.set(player.position.x, 0.9, player.position.z);
    // lead the target slightly by their current velocity
    const vel = game.player.velocity;
    if (vel) {
      const t = Math.hypot(player.position.x - origin.x, player.position.z - origin.z) / 14;
      target.x += vel.x * t * 0.7;
      target.z += vel.z * t * 0.7;
    }
    const dir = target.sub(origin).setY(0).normalize();
    game.projectiles.spawn({
      position: origin,
      direction: dir,
      speed: 14,
      radius: 0.16,
      life: 2.2,
      owner: 'enemy',
      damage: this.damage,
      element: 'physical',
      color: this.def.accent,
      scale: 0.8,
    });
    game.audio?.play?.('swing', { volume: 0.5, rate: 1.4, pan: this._panTo(pos) });
    game.vfx?.burst?.(origin, { count: 5, color: this.def.accent, size: 0.08, speed: 2, life: 0.25 });
  }

  // ------------------------------------------------------------ caster AI

  _updateCaster(dt, pd2, player) {
    const def = this.def;
    this._face(player.position, dt, 7);

    if (this._state === 'windup') {
      this._stateT -= dt;
      this._lastSpeed = 0;
      // channel: staff orb brightens, rune circle under caster
      if (this._stateT <= 0) this._castHex(player);
      return;
    }
    if (this._state === 'recover') {
      this._stateT -= dt;
      this._lastSpeed = 0;
      if (this._stateT <= 0) this._state = 'idle';
      return;
    }

    this._keepDistance(def.range * 0.55, def.speed, dt);
    this._lastSpeed = def.speed;
    this._attackCd -= dt;
    if (this._attackCd <= 0 && pd2 <= def.range * def.range * 1.2 && this._hasLineOfSight()) {
      this._state = 'windup';
      this._stateT = def.attackWindup;
      // telegraph: red sigil at the caster + glow on the orb
      const pos = this.group.position;
      this.game.vfx?.runeCircle?.(_P1.set(pos.x, 0, pos.z), {
        color: def.accent, radius: 1.2, life: def.attackWindup + 0.3, pulse: true,
      });
      if (this.parts.orb) this.parts.orb.scale.setScalar(1.6);
    }
  }

  _castHex(player) {
    this._state = 'recover';
    this._stateT = 0.4;
    this._attackCd = this.def.attackCooldown;
    if (this.parts.orb) this.parts.orb.scale.setScalar(1);
    const game = this.game;
    const pos = this.group.position;
    const origin = new THREE.Vector3().setFromMatrixPosition(this.parts.muzzle.matrixWorld);
    const dir = _P2.set(player.position.x, 0.9, player.position.z).sub(origin).setY(0).normalize();
    game.projectiles.spawn({
      position: origin,
      direction: dir,
      speed: 9,
      radius: 0.3,
      life: 3,
      owner: 'enemy',
      damage: this.damage,
      element: 'void',
      color: this.def.accent,
      scale: 1.25,
      onHit: () => {}, // plain damage handled by the system (damagePlayer)
    });
    game.audio?.play?.('void_cast', { volume: 0.5, rate: 0.9, pan: this._panTo(pos) });
    game.vfx?.burst?.(origin, { count: 10, color: this.def.accent, size: 0.13, speed: 3, life: 0.4 });
  }

  // ------------------------------------------------------------ brute AI

  _updateBrute(dt, pd2, player) {
    const def = this.def;
    this._face(player.position, dt, 6);

    if (this._state === 'windup') {
      this._stateT -= dt;
      this._lastSpeed = 0;
      // telegraph: expanding danger ring on the ground
      if (this._slamRing) {
        this._slamRing.material.opacity = 0.55 + Math.sin(this.game.time * 14) * 0.25;
      }
      if (this._stateT <= 0) this._slam();
      return;
    }
    if (this._state === 'recover') {
      this._stateT -= dt;
      this._lastSpeed = 0;
      if (this._stateT <= 0) {
        this._state = 'idle';
        this._clearSlamRing();
      }
      return;
    }

    if (d2InRange(pd2, def.range)) {
      if (this._attackCd <= 0) {
        this._state = 'windup';
        this._stateT = def.attackWindup;
        this._attackCd = def.attackCooldown + def.attackWindup;
        this._slamRing = this.game.vfx?.runeCircle?.(
          _P1.set(this.group.position.x, 0, this.group.position.z),
          { color: def.accent, radius: BRUTE_SLAM_RADIUS, life: def.attackWindup + 0.35, pulse: true },
        );
        this.game.audio?.play?.('meteor_warn', { volume: 0.4, rate: 1.3 });
      }
      this._lastSpeed = 0;
    } else {
      this._moveToward(player.position.x, player.position.z, def.speed, dt);
      this._lastSpeed = def.speed;
    }
    this._attackCd -= dt;
  }

  _clearSlamRing() {
    if (this._slamRing) {
      const timer = this._slamRing.userData._timer;
      if (timer) timer.life = Math.min(timer.life, 0.05);
      this._slamRing = null;
    }
  }

  _slam() {
    this._state = 'recover';
    this._stateT = 0.5;
    const game = this.game;
    const pos = this.group.position;
    this._clearSlamRing();
    game.vfx?.shockwave?.(_P1.set(pos.x, 0, pos.z), {
      radius: BRUTE_SLAM_RADIUS, color: 0xffc37a, life: 0.4, height: 1.2,
    });
    game.vfx?.burst?.(_P2.set(pos.x, 0.4, pos.z), {
      count: 20, color: 0x9a8f7c, size: 0.16, speed: 5, life: 0.6, gravity: 3,
    });
    game.audio?.play?.('meteor_impact', { volume: 0.65, rate: 0.8, pan: this._panTo(pos) });
    game.screenShake?.(0.3, 0.25);
    // damage if the player is caught inside the slam radius
    const p = game.player;
    const dx = p.position.x - pos.x;
    const dz = p.position.z - pos.z;
    if (dx * dx + dz * dz <= BRUTE_SLAM_RADIUS * BRUTE_SLAM_RADIUS) {
      game.damagePlayer(this.damage, this, { element: 'physical', knockback: 3 });
    }
  }

  // ------------------------------------------------------------ boss AI

  _updateBoss(dt, pd2, player) {
    const game = this.game;
    const def = this.def;

    // --- phase transitions on HP thresholds ---
    const frac = this.hp / this.maxHp;
    if (this.phase === 1 && frac <= 0.66) this._enterPhase(2);
    else if (this.phase === 2 && frac <= 0.33) this._enterPhase(3);

    if (this._state === 'stagger') {
      // brief vulnerable window after a big attack
      this._stateT -= dt;
      this._lastSpeed = 0;
      if (this._stateT <= 0) this._state = 'idle';
      return;
    }

    this._face(player.position, dt, this.phase >= 2 ? 8 : 5);

    // --- action state machine ---
    switch (this._state) {
      case 'idle':
        this._bossChase(dt, pd2, player);
        break;
      case 'slamWind':
        this._stateT -= dt;
        if (this._stateT <= 0) this._bossSlamImpact();
        break;
      case 'novaWind':
        this._stateT -= dt;
        if (this._stateT <= 0) this._bossNovaImpact();
        break;
      case 'summonWind':
        this._stateT -= dt;
        if (this._stateT <= 0) this._bossSummonDo();
        break;
      case 'chargeWind':
        this._stateT -= dt;
        if (this._stateT <= 0) this._bossChargeGo(player);
        break;
      case 'charging':
        this._bossChargeMove(dt);
        break;
      case 'teleportOut':
        this._stateT -= dt;
        if (this._stateT <= 0) this._bossTeleportIn(player);
        break;
      default:
        this._state = 'idle';
    }

    this._attackCd -= dt;
  }

  _bossChase(dt, pd2, player) {
    const def = this.def;
    const d = Math.sqrt(pd2);
    const inMelee = d <= def.range;
    this._moveToward(player.position.x, player.position.z, def.speed * (this.phase >= 2 ? 1.15 : 1), dt);
    this._lastSpeed = def.speed;

    if (this._attackCd > 0) return;

    // pick an attack: melee slam/nova mix when close, else ranged repertoire
    if (inMelee) {
      // phase 2+: nova competes with the slam even at melee range
      if (this.phase >= 2 && Math.random() < 0.4) this._startNova();
      else this._startSlam();
      return;
    }
    const roll = Math.random();
    if (this.phase === 1) {
      if (d < 11) this._startSummon();
      else this._startCharge();
    } else if (this.phase === 2) {
      if (d < 8 && roll < 0.45) this._startNova();
      else if (roll < 0.7) this._startSummon();
      else this._startCharge();
    } else {
      // phase 3: relentless
      if (d < 8 && roll < 0.5) this._startNova();
      else if (roll < 0.62) this._startTeleport();
      else if (roll < 0.85) this._startSummon();
      else this._startCharge();
    }
  }

  _startSlam() {
    this._state = 'slamWind';
    this._stateT = this.def.attackWindup;
    const pos = this.group.position;
    this.game.vfx?.runeCircle?.(_P1.set(pos.x, 0, pos.z), {
      color: 0xff5a22, radius: BOSS_SLAM_RADIUS, life: this._stateT + 0.2, pulse: true,
    });
    this.game.audio?.play?.('meteor_warn', { volume: 0.6, rate: 0.8 });
  }

  _bossSlamImpact() {
    const game = this.game;
    const pos = this.group.position;
    this._state = 'stagger';
    this._stateT = 0.35;
    this._attackCd = this.def.attackCooldown + (this.phase >= 2 ? -0.3 : 0);
    game.vfx?.shockwave?.(_P1.set(pos.x, 0, pos.z), {
      radius: BOSS_SLAM_RADIUS, color: 0xffc37a, life: 0.55, height: 1.8,
    });
    game.vfx?.ring?.(_P2.set(pos.x, 0, pos.z), { radius: BOSS_SLAM_RADIUS + 1.5, color: 0xff5a22, life: 0.5 });
    game.vfx?.burst?.(_P3.set(pos.x, 0.5, pos.z), {
      count: 18, color: 0x9a8f7c, size: 0.18, speed: 7, life: 0.7, gravity: 4,
    });
    game.audio?.play?.('meteor_impact', { volume: 0.9, rate: 0.65 });
    game.screenShake?.(0.5, 0.35);
    const p = game.player;
    const dx = p.position.x - pos.x;
    const dz = p.position.z - pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 <= BOSS_SLAM_RADIUS * BOSS_SLAM_RADIUS) {
      game.damagePlayer(this.damage, this, { element: 'physical', knockback: 5 });
    } else if (d2 <= (BOSS_SLAM_RADIUS + 1.6) * (BOSS_SLAM_RADIUS + 1.6)) {
      // edge graze: half damage, strong knockback
      game.damagePlayer(this.damage * 0.5, this, { element: 'physical', knockback: 6 });
    }
  }

  _startNova() {
    this._state = 'novaWind';
    this._stateT = 0.85;
    const pos = this.group.position;
    this.game.vfx?.runeCircle?.(_P1.set(pos.x, 0, pos.z), {
      color: 0xffd27a, radius: BOSS_NOVA_RADIUS, life: this._stateT + 0.2, pulse: true,
    });
    this.game.vfx?.ring?.(_P2.set(pos.x, 0, pos.z), {
      radius: BOSS_NOVA_RADIUS, color: 0xff5a22, life: this._stateT, height: 0.05,
    });
    this.game.audio?.play?.('meteor_warn', { volume: 0.55, rate: 1.1 });
    // core flares during windup
    this._coreBoost = 2.6;
  }

  _bossNovaImpact() {
    const game = this.game;
    const pos = this.group.position;
    this._state = 'stagger';
    this._stateT = 0.3;
    this._attackCd = this.def.attackCooldown;
    game.vfx?.explosion?.(_P1.set(pos.x, 1.2, pos.z), { radius: BOSS_NOVA_RADIUS, color: 0xff5a22, scale: 1.8 });
    game.vfx?.ring?.(_P2.set(pos.x, 0, pos.z), {
      radius: BOSS_NOVA_RADIUS + 1, color: 0xffd27a, life: 0.5, height: 0.1,
    });
    game.vfx?.shockwave?.(_P2, { radius: BOSS_NOVA_RADIUS, color: 0xffc37a, life: 0.5, height: 1.6 });
    game.audio?.play?.('fireball_explode', { volume: 0.95, rate: 0.85 });
    game.flashScreen?.('#ff8a3d', 0.3);
    game.screenShake?.(0.6, 0.4);
    const p = game.player;
    const dx = p.position.x - pos.x;
    const dz = p.position.z - pos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 <= BOSS_NOVA_RADIUS * BOSS_NOVA_RADIUS) {
      game.damagePlayer(this.damage * 0.85, this, { element: 'fire', knockback: 6 });
      game.applyStatus?.(p, 'burn', 3, 6); // status on the player is cosmetic only
    }
  }

  _startSummon() {
    this._state = 'summonWind';
    this._stateT = 0.8;
    const pos = this.group.position;
    this.game.vfx?.runeCircle?.(_P1.set(pos.x, 0, pos.z), {
      color: 0xb46bff, radius: 3, life: this._stateT + 0.4, pulse: true,
    });
    this.game.audio?.play?.('void_cast', { volume: 0.7, rate: 0.7 });
  }

  _bossSummonDo() {
    const game = this.game;
    this._state = 'stagger';
    this._stateT = 0.25;
    this._attackCd = this.def.attackCooldown + 1.2;
    const count = this.phase === 1 ? 2 : this.phase === 2 ? 3 : 4;
    const cap = this.phase === 1 ? 3 : this.phase === 2 ? 4 : 6;
    // cap total summoned minions so the fight stays fair
    let minions = 0;
    for (const e of game.enemies) {
      if (!e.dead && e !== this && e.roomIndex === this.roomIndex) minions++;
    }
    if (minions >= cap) {
      // over budget: refund into a fire ring around the boss instead
      game.vfx?.ring?.(_P1.set(this.group.position.x, 0, this.group.position.z), {
        radius: 4, color: 0xff5a22, life: 0.5, height: 0.1,
      });
      return;
    }
    const slots = Math.min(count, cap - minions);
    for (let i = 0; i < slots; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 2.6 + Math.random() * 1.6;
      const x = this.group.position.x + Math.cos(a) * r;
      const z = this.group.position.z + Math.sin(a) * r;
      if (!game.dungeon.isWalkable(x, z, 0.45)) continue;
      const kind = i % 2 === 0 ? 'skeleton' : 'archer';
      game.spawnEnemy?.(kind, new THREE.Vector3(x, 0, z), this.roomIndex, {
        elite: null, scaleHp: 0.85, scaleDamage: 0.9, scaleXp: 0.6,
      });
      game.vfx?.burst?.(_P1.set(x, 0.8, z), { count: 12, color: 0xb46bff, size: 0.14, speed: 3.4, life: 0.6 });
    }
    if (slots > 0) {
      game.audio?.play?.('room_clear', { volume: 0.5, rate: 0.6 });
      game.notify?.('The Warden calls the dead!', 'ember');
    }
  }

  _startCharge() {
    this._state = 'chargeWind';
    this._stateT = 0.7;
    const p = this.game.player.position;
    this._face(p, 1, 20); // lock facing instantly
    this._chargeVec.set(
      p.x - this.group.position.x, 0, p.z - this.group.position.z,
    ).normalize();
    this.game.vfx?.ring?.(_P1.set(this.group.position.x, 0, this.group.position.z), {
      radius: 2.6, color: 0xffb45e, life: 0.7, height: 0.05, startRadius: 0.4,
    });
    this.game.audio?.play?.('boss_roar', { volume: 0.5, rate: 1.25 });
  }

  _bossChargeGo(player) {
    // launch: dash along the locked direction until contact or timeout
    this._state = 'charging';
    this._stateT = 1.1; // hard timeout so the charge always ends
    const p = player.position;
    this._chargeVec.set(
      p.x - this.group.position.x, 0, p.z - this.group.position.z,
    ).normalize();
    this.game.audio?.play?.('dash', { volume: 0.8, rate: 0.7 });
  }

  _bossChargeMove(dt) {
    const speed = 11 + (this.phase - 1) * 1.6;
    // wall ahead? crash and stagger
    const nx = this.group.position.x + this._chargeVec.x * 0.6;
    const nz = this.group.position.z + this._chargeVec.z * 0.6;
    if (!this.game.dungeon.isWalkable(nx, nz, this.radius * 0.85)) {
      this._endCharge(false);
      return;
    }
    this._stateT -= dt;
    if (this._stateT <= 0) {
      this._endCharge(false);
      return;
    }
    this._step(this._chargeVec.x * speed * dt, this._chargeVec.z * speed * dt);
    this._lastSpeed = speed;
    // ember trail
    const pos = this.group.position;
    if (Math.random() < dt * 30) {
      this.game.vfx?.spawnParticle?.(
        pos.x + rand(-0.5, 0.5), rand(0.2, 2.2), pos.z + rand(-0.5, 0.5),
        rand(-1, 1), rand(0.5, 2), rand(-1, 1),
        1.0, 0.4, 0.14, 0.2, 0.5, 1.5, 0.92, 1.1,
      );
    }
    // contact damage during the charge
    const p = this.game.player;
    const dx = p.position.x - pos.x;
    const dz = p.position.z - pos.z;
    const rr = this.radius + p.radius + 0.25;
    if (dx * dx + dz * dz <= rr * rr) {
      this.game.damagePlayer(this.damage * 0.7, this, { element: 'physical', knockback: 7 });
      this._endCharge(true);
    }
  }

  _bossChargeImpact() {
    const game = this.game;
    const pos = this.group.position;
    game.vfx?.shockwave?.(_P1.set(pos.x, 0, pos.z), { radius: 3.4, color: 0xffb45e, life: 0.4, height: 1.1 });
    game.vfx?.burst?.(_P2.set(pos.x, 1, pos.z), { count: 16, color: 0xff5a22, size: 0.16, speed: 5, life: 0.5, gravity: 2 });
    game.audio?.play?.('meteor_impact', { volume: 0.6, rate: 1.1 });
    game.screenShake?.(0.4, 0.3);
  }

  _endCharge(hitPlayer) {
    if (this._state !== 'charging') return;
    this._bossChargeImpact();
    this._state = 'stagger';
    this._stateT = hitPlayer ? 0.3 : 0.55; // crashing into a wall stuns longer
    this._attackCd = this.def.attackCooldown;
  }

  _startTeleport() {
    this._state = 'teleportOut';
    this._stateT = 0.55;
    const pos = this.group.position;
    this.game.vfx?.voidRift?.(_P1.set(pos.x, 1, pos.z), { radius: 2.2, life: 0.6 });
    this.game.audio?.play?.('void_cast', { volume: 0.8, rate: 0.85 });
    this.group.visible = false;
  }

  _bossTeleportIn(player) {
    const game = this.game;
    this.group.visible = true;
    // reappear near the player: try a ring of candidate spots
    const spot = this._findTeleportSpot(player);
    this.group.position.set(spot.x, 0, spot.z);
    this._knock.set(0, 0, 0);
    game.vfx?.voidRift?.(_P1.set(spot.x, 1.2, spot.z), { radius: 2.4, life: 0.7 });
    game.vfx?.ring?.(_P2.set(spot.x, 0, spot.z), { radius: 3, color: 0xb46bff, life: 0.5, height: 0.08 });
    game.vfx?.burst?.(_P3.set(spot.x, 1.2, spot.z), { count: 18, color: 0xb46bff, size: 0.16, speed: 4, life: 0.6 });
    game.audio?.play?.('void_cast', { volume: 0.9, rate: 1.15 });
    game.screenShake?.(0.25, 0.2);
    this._state = 'stagger';
    this._stateT = 0.3;
    this._attackCd = this.def.attackCooldown * 0.5;
  }

  _findTeleportSpot(player) {
    const game = this.game;
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 3 + Math.random() * 3.5;
      const x = player.position.x + Math.cos(a) * r;
      const z = player.position.z + Math.sin(a) * r;
      const b = this._bounds;
      if (x < b.minX - 1 || x > b.maxX + 1 || z < b.minZ - 1 || z > b.maxZ + 1) continue;
      if (game.dungeon.isWalkable(x, z, this.radius)) return { x, z };
    }
    return { x: this._homeCenter.x, z: this._homeCenter.z };
  }

  _enterPhase(n) {
    this.phase = n;
    const game = this.game;
    const pos = this.group.position;
    // roar + shockwave + crack the armor wider
    game.audio?.play?.('boss_roar', { volume: 1, rate: n === 2 ? 0.8 : 0.62 });
    game.vfx?.ring?.(_P1.set(pos.x, 0, pos.z), { radius: 6, color: 0xff5a22, life: 0.8, height: 0.12 });
    game.vfx?.shockwave?.(_P2.set(pos.x, 0, pos.z), { radius: 5.5, color: 0xffc37a, life: 0.6, height: 2.4 });
    game.vfx?.burst?.(_P3.set(pos.x, 2, pos.z), {
      count: 60, color: 0xff5a22, size: 0.2, speed: 8, life: 1, gravity: 2,
    });
    game.vfx?.flashLight?.(_P1, { color: 0xff5a22, intensity: 8, distance: 18, life: 0.8 });
    game.flashScreen?.('#ff8a3d', 0.35);
    game.screenShake?.(0.6, 0.6);
    game.hitstop?.(0.08);
    game.notify?.(n === 2 ? 'THE WARDEN AWAKENS' : 'THE WARDEN RAGES', 'ember');
    this._interruptAttack();
    this._coreBoost = n === 2 ? 3.2 : 4.2;
    if (n === 3) {
      // cracks flare bright permanently
      for (const c of this.parts.cracks ?? []) c.material.emissiveIntensity = 4;
      this.speedMul = 1.1;
    }
    this._attackCd = 1.4; // breathing room after the transition
  }

  _interruptAttack() {
    // cancel any pending telegraph cleanly
    switch (this._state) {
      case 'slamWind': case 'novaWind': case 'summonWind':
        this._clearSlamRing();
        break;
      case 'charging':
        this.group.visible = true;
        break;
      case 'teleportOut':
        this.group.visible = true;
        break;
      default: break;
    }
    if (this.parts.orb) this.parts.orb.scale.setScalar(1);
    this._state = 'idle';
  }

  // ------------------------------------------------------------ animation

  _animate(dt, speed) {
    const p = this.parts;
    if (!p?.torso) return;
    const t = this.game.time;
    const rest = this._rest;
    const n = Math.min(1, speed / Math.max(0.6, this.def.speed));
    this._animPhase += dt * (3 + 7.5 * n);
    const s = Math.sin(this._animPhase);

    // legs
    if (p.legL) p.legL.rotation.x = s * 0.66 * n;
    if (p.legR) p.legR.rotation.x = -s * 0.66 * n;

    // torso bob
    if (p.torso) p.torso.position.y = Math.abs(Math.cos(this._animPhase)) * 0.06 * n;

    // arms by AI type
    const attacking = this._state === 'windup' || this._state === 'slamWind'
      || this._state === 'novaWind' || this._state === 'summonWind' || this._state === 'chargeWind';
    if (attacking) {
      const w = 1 - this._stateT / Math.max(0.001, this._windupDur ?? this.def.attackWindup);
      const raise = easeWindup(w);
      if (p.armR) p.armR.rotation.x = (rest.armR?.x ?? 0) - 2.4 * raise;
      if (p.armL) p.armL.rotation.x = (rest.armL?.x ?? 0) - 1.7 * raise;
    } else if (this._state === 'charging') {
      if (p.armL) p.armL.rotation.x = (rest.armL?.x ?? 0) - 1.9;
      if (p.armR) p.armR.rotation.x = (rest.armR?.x ?? 0) - 1.9;
    } else {
      if (p.armL) p.armL.rotation.x = (rest.armL?.x ?? 0) + s * 0.44 * n + Math.sin(t * 1.4) * 0.04 * (1 - n);
      if (p.armR) p.armR.rotation.x = (rest.armR?.x ?? 0) - s * 0.44 * n;
    }

    // chill/void tint drift + hit flash on materials is handled elsewhere;
    // here: boss core pulse + crack flicker
    if (this.isBoss) {
      const base = 3.0 + Math.sin(t * 4.4) * 0.55 + Math.sin(t * 15.7) * 0.22;
      const boost = this._coreBoost ?? 0;
      this._coreBoost = Math.max(0, boost - dt * 2.2);
      if (this._coreMat) this._coreMat.emissiveIntensity = base + boost;
      if (this._coreMat2) this._coreMat2.emissiveIntensity = base * 0.8 + boost * 1.2;
      if (this._coreMesh) this._coreMesh.rotation.y += dt * 1.8;
      if (Math.random() < dt * (this.phase >= 2 ? 6 : 3)) {
        const pos = this.group.position;
        this.game.vfx?.spawnParticle?.(
          pos.x + rand(-0.5, 0.5), rand(1.2, 2.4), pos.z + rand(-0.5, 0.5),
          rand(-0.5, 0.5), rand(0.5, 1.4), rand(-0.5, 0.5),
          1.0, 0.4, 0.15, 0.12, 0.8, -0.8, 0.95, 0.9,
        );
      }
    }
  }

  _updateDeath(dt) {
    const game = this.game;
    const pos = this.group.position;
    this._dissolve += dt;
    const sink = Math.min(1, this._dissolve / (this.isBoss ? 1.6 : 0.75));
    // sink + tilt + shrink; opacity fade would flip every material to a
    // transparent draw pass, which is what stalls weaker GPUs on mass deaths.
    this.group.position.y = -sink * (this.isBoss ? 2.2 : 1.1);
    this.group.rotation.x = -sink * (this.isBoss ? 0.9 : 1.4);
    const shrink = 1 - sink * sink;
    this.group.scale.setScalar(this._baseScale * shrink);
    // staggered secondary bursts for the boss
    if (this._deathBursts > 0) {
      this._deathTimer -= dt;
      if (this._deathTimer <= 0) {
        this._deathBursts--;
        this._deathTimer = 0.35;
        game.vfx?.explosion?.(
          _P1.set(pos.x + rand(-1.5, 1.5), rand(0.5, 2.5), pos.z + rand(-1.5, 1.5)),
          { radius: 3, color: 0xff5a22, scale: 0.9 },
        );
        game.screenShake?.(0.3, 0.25);
      }
    }
    // embers rising from the corpse
    if (Math.random() < dt * (this.isBoss ? 24 : 10)) {
      game.vfx?.spawnParticle?.(
        pos.x + rand(-0.6, 0.6), rand(0.1, this.bodyHeight * 0.5), pos.z + rand(-0.6, 0.6),
        rand(-0.4, 0.4), rand(1, 2.4), rand(-0.4, 0.4),
        1.0, 0.5, 0.2, 0.14, 1.1, -0.6, 0.96, 0.8,
      );
    }
    if (this._dissolve >= (this.isBoss ? 2.4 : 1.1)) {
      this.dispose();
    }
  }

}

// ------------------------------------------------------------ local helpers

function easeWindup(w) {
  // slow raise, snap at the end
  return w < 0.6 ? (w / 0.6) * 0.45 : 0.45 + ((w - 0.6) / 0.4) * 0.55;
}

function d2InRange(pd2, range) {
  return pd2 <= range * range;
}

const BRUTE_SLAM_RADIUS = 2.7;
const BOSS_SLAM_RADIUS = 4.2;
const BOSS_NOVA_RADIUS = 5.2;
