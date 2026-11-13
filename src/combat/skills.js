// EMBERFALL — skill system. Nine actives, rank scaling, echo, statuses.
// Damage always flows through game.dealDamage; statuses via game.applyStatus/
// game.applyChill. Power scaling: ranks raise base numbers; `power` multiplier
// is applied internally so Eclipse echoes hit at 45%.
import * as THREE from 'three';
import { ACTIVE_SKILLS, NODE_BY_ID, ACTIVE_ORDER, PASSIVE_STATS } from '../data/skills.js';

const ELEMENT_COLORS = {
  fire: 0xff6b2b,
  frost: 0x6fd8ff,
  lightning: 0x9d7bff,
  void: 0xc04dff,
  physical: 0xffe2b8,
};

// Per-skill cast audio; impact/explosion sounds are triggered by the skills themselves.
const CAST_AUDIO = {
  ember_bolt: 'fireball_cast',
  flame_wave: 'flame_wave',
  meteor: 'meteor_warn',
  frost_nova: 'frost_burst',
  ice_shards: 'ice_shards',
  blizzard: 'blizzard',
  shadow_step: 'dash',
  chain_lightning: 'lightning',
  singularity: 'void_cast',
};

export class SkillSystem {
  constructor(game) {
    this.game = game;
    this.ranks = {};
    this.unlocked = new Set();
    this.cooldowns = {};
    this._echoQueue = []; // {id, at, position, direction, power}
    this._echoArmed = new Set();
    this._pending = []; // delayed effects (meteor) {t, fn}
    this._zones = []; // persistent zones {update(dt)->bool alive, dispose()}
    for (const id of ACTIVE_ORDER) {
      this.ranks[id] = 0;
      this.cooldowns[id] = 0;
    }
    this._scratch = new THREE.Vector3();
    this._scratch2 = new THREE.Vector3();
  }

  // ------------------------------------------------------------ rank helpers
  canRank(id) {
    const node = NODE_BY_ID[id];
    if (!node) return { ok: false, reason: 'Unknown node' };
    const r = this.ranks[id] ?? 0;
    if (r >= node.maxRank) return { ok: false, reason: 'Fully ranked' };
    if (this.game.player.skillPoints <= 0) return { ok: false, reason: 'No skill points' };
    for (const req of node.req) {
      if ((this.ranks[req] ?? 0) < 1) {
        return { ok: false, reason: `Requires ${NODE_BY_ID[req].name}` };
      }
    }
    return { ok: true, reason: '' };
  }

  rankNode(id) {
    const check = this.canRank(id);
    if (!check.ok) return check;
    const node = NODE_BY_ID[id];
    this.ranks[id] = (this.ranks[id] ?? 0) + 1;
    this.game.player.skillPoints--;
    if (node.type === 'active') {
      this.unlocked.add(id);
    }
    return { ok: true, reason: '' };
  }

  getActiveSkills() {
    const list = [];
    for (const id of ACTIVE_ORDER) {
      if (!this.unlocked.has(id)) continue;
      const a = ACTIVE_SKILLS[id];
      list.push({
        id,
        name: a.label,
        icon: NODE_BY_ID[id].icon,
        color: ELEMENT_COLORS[a.element],
        mana: a.mana,
        cooldown: a.cooldown,
        rank: this.ranks[id],
      });
    }
    return list;
  }

  getPassiveStats() {
    const out = {};
    for (const [id, fn] of Object.entries(PASSIVE_STATS)) {
      const r = this.ranks[id] ?? 0;
      if (r <= 0) continue;
      const stats = fn(r);
      for (const [k, v] of Object.entries(stats)) {
        out[k] = (out[k] ?? 0) + v;
      }
    }
    return out;
  }

  reset() {
    for (const id of ACTIVE_ORDER) {
      this.ranks[id] = 0;
      this.cooldowns[id] = 0;
    }
    this.unlocked.clear();
    this._echoQueue.length = 0;
    this._echoArmed.clear();
    this._pending.length = 0;
    for (const z of this._zones) {
      if (typeof z.dispose === 'function') z.dispose();
    }
    this._zones.length = 0;
  }

  update(dt) {
    for (const id of ACTIVE_ORDER) {
      if (this.cooldowns[id] > 0) this.cooldowns[id] -= dt;
    }
    // delayed effects (meteor impact etc.)
    for (let i = this._pending.length - 1; i >= 0; i--) {
      const pd = this._pending[i];
      pd.t -= dt;
      if (pd.t <= 0) {
        this._pending.splice(i, 1);
        const g = this.game;
        if (g.state === 'playing' && g.player && !g.player.dead) {
          pd.fn();
        }
      }
    }
    // echo queue
    for (let i = this._echoQueue.length - 1; i >= 0; i--) {
      const ec = this._echoQueue[i];
      ec.at -= dt;
      if (ec.at <= 0) {
        this._echoQueue.splice(i, 1);
        const g = this.game;
        if (g.state === 'playing' && g.player && !g.player.dead) {
          this._execute(ec.id, ec.opts, ec.power, true);
        }
      }
    }
    // persistent zones (blizzard, singularity, burning ground)
    for (let i = this._zones.length - 1; i >= 0; i--) {
      if (!this._zones[i].update(dt)) {
        if (typeof this._zones[i].dispose === 'function') this._zones[i].dispose();
        this._zones.splice(i, 1);
      }
    }
  }

  // ------------------------------------------------------------ casting
  canCast(id) {
    const def = ACTIVE_SKILLS[id];
    if (!def) return false;
    if ((this.ranks[id] ?? 0) <= 0) return false;
    if (this.cooldowns[id] > 0) return false;
    const player = this.game.player;
    if (!player || player.dead) return false;
    if (player.mana < def.mana) return false;
    return true;
  }

  cast(id, opts = {}, isEcho = false) {
    if (!this.canCast(id)) return false;
    const def = ACTIVE_SKILLS[id];
    const player = this.game.player;
    player.mana -= def.mana;
    this.cooldowns[id] = def.cooldown;
    player.playCast(def.element);
    this.game.audio.play(CAST_AUDIO[id] ?? 'fireball_cast', { volume: 0.8 });
    const ok = this._execute(id, opts, 1, false);
    // Eclipse echo roll (echoes never recurse: _echoQueue only fills from cast())
    const echoChance = (this.game.stats.echoChance ?? 0) * (isEcho ? 0 : 1);
    if (echoChance > 0 && Math.random() < echoChance && this._echoQueue.length < 4) {
      this._echoQueue.push({
        id,
        at: 0.35,
        opts: { ...opts },
        power: 0.45,
      });
      this.game.notify('The spell echoes...', 'void');
    }
    return ok;
  }

  _execute(id, opts, power, isEcho) {
    switch (id) {
      case 'ember_bolt': return this._emberBolt(opts, power);
      case 'flame_wave': return this._flameWave(opts, power);
      case 'meteor': return this._meteor(opts, power);
      case 'frost_nova': return this._frostNova(opts, power);
      case 'ice_shards': return this._iceShards(opts, power);
      case 'blizzard': return this._blizzard(opts, power);
      case 'shadow_step': return this._shadowStep(opts, power);
      case 'chain_lightning': return this._chainLightning(opts, power);
      case 'singularity': return this._singularity(opts, power);
      default: return false;
    }
  }

  // ------------------------------------------------------------ aim helpers
  _aimPoint() {
    return this.game.aim.point;
  }
  _aimDir() {
    return this.game.aim.direction;
  }

  _castersOrigin(out) {
    const p = this.game.player;
    if (p.getMuzzlePosition) return p.getMuzzlePosition();
    return out.copy(p.position).setY(1.1);
  }

  _damage(base, power) {
    return base * power;
  }

  _fireStatus(rank) {
    return { type: 'burn', duration: 4, dps: 4 + rank * 2 };
  }

  // ------------------------------------------------------------ EMBER BOLT
  _emberBolt(opts, power) {
    const game = this.game;
    const rank = this.ranks.ember_bolt;
    const origin = this._castersOrigin(this._scratch2);
    const target = game.nearestEnemyInDirection(
      origin, this._aimDir(), 16, Math.PI * 0.22,
    );
    const dir = this._scratch.copy(this._aimDir());
    game.projectiles.spawn({
      position: origin.clone().setY(0.95),
      direction: dir,
      speed: 16,
      radius: 0.3,
      life: 2.2,
      owner: 'player',
      damage: 0, // damage applied in onHit so the explosion is centered on hit
      element: 'fire',
      color: 0xff6b2b,
      scale: 1,
      homingTarget: target ?? undefined,
      turnRate: target ? 3.2 : 0,
      onHit: (enemy) => {
        this._emberBoltDetonate(enemy.position, rank, power, true);
      },
      onExpire: (pos) => {
        this._emberBoltDetonate(pos, rank, power, true);
      },
    });
    const muzzle = origin.clone ? origin.clone() : origin;
    game.vfx.burst(muzzle, { count: 8, color: 0xff8a3d, size: 0.12, speed: 3, life: 0.35 });
    return true;
  }

  _emberBoltDetonate(pos, rank, power, centered) {
    const game = this.game;
    const dmg = (28 + rank * 9) * power;
    const radius = 2.2;
    game.vfx.explosion(pos, { radius, color: 0xff6b2b, scale: 1 });
    game.audio.play('fireball_explode', { volume: 0.9 });
    game.screenShake(0.25, 0.25);
    const hitList = game.enemiesInRadius(pos, radius);
    for (let i = 0; i < hitList.length; i++) {
      const e = hitList[i];
      game.dealDamage(e, dmg, {
        element: 'fire',
        source: 'explosion',
        status: { type: 'burn', duration: 4, dps: 4 + rank * 2 },
      });
    }
    game.vfx.embers(pos, { count: 10, color: 0xff7a2f, life: 1.2 });
  }

  // ------------------------------------------------------------ FLAME WAVE
  _flameWave(opts, power) {
    const game = this.game;
    const rank = this.ranks.flame_wave;
    const dmg = (32 + rank * 12) * power;
    const origin = this._castersOrigin(this._scratch2).clone();
    const dir = this._scratch.copy(this._aimDir()).clone();
    const coneCos = Math.cos(0.6); // ~35 deg half-angle -> ~7m cone at 7m range
    const range = 7;
    const enemies = game.enemies;
    const struck = [];
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (e.dead) continue;
      const dx = e.position.x - origin.x;
      const dz = e.position.z - origin.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > range * range) continue;
      const dist = Math.sqrt(distSq) || 1;
      const dot = (dx / dist) * dir.x + (dz / dist) * dir.z;
      if (dot < coneCos && dist > 1.4) continue;
      struck.push(e);
      game.dealDamage(e, dmg, {
        element: 'fire',
        source: 'skill',
        knockback: 2.2,
        status: { type: 'burn', duration: 5, dps: 5 + rank * 2 },
      });
    }
    // Choreography: expanding fire arc + rolling wave particles + rings
    game.audio.play('flame_wave', { volume: 0.9 });
    game.screenShake(0.3, 0.3);
    const ang = Math.atan2(dir.x, dir.z);
    game.vfx.slash(origin, ang, { color: 0xff8a3d, radius: 6.5, life: 0.35, arc: Math.PI * 0.85, height: 1.3, tilt: 0.5 });
    game.vfx.ring(origin, { radius: 7, color: 0xff6b2b, life: 0.55, height: 0.08, startRadius: 0.4 });
    for (let s = 0; s < 3; s++) {
      const d = 1.6 + s * 2.2;
      const wavePos = this._scratch2.set(origin.x + dir.x * d, 0.5, origin.z + dir.z * d);
      game.vfx.burst(wavePos, {
        count: 26, color: s === 2 ? 0xffd9a0 : 0xff6b2b, size: 0.24, speed: 4.5,
        life: 0.55 + s * 0.1, spread: 0.5, gravity: -2, up: 0.4, drag: 1.1,
      });
    }
    game.vfx.embers(origin, { count: 16, life: 1.4 });
    // flame tongue down the cone via timed particles
    const pending = this._pending;
    const waveBurst = (d) => {
      this._scratch2.set(origin.x + dir.x * d, 0.4, origin.z + dir.z * d);
      game.vfx.burst(this._scratch2, {
        count: 14, color: 0xff9a4d, size: 0.2, speed: 2.5, life: 0.6,
        spread: 0.9, gravity: -1.5, up: 0.7,
      });
    };
    for (let s = 0; s < 2; s++) waveBurst(2 + s * 1.4);
    pending.push({ t: 0.12, fn: () => { waveBurst(4.8); waveBurst(6.2); } });
    return true;
  }

  // ------------------------------------------------------------ METEOR
  _meteor(opts, power) {
    const game = this.game;
    const rank = this.ranks.meteor;
    const target = this._scratch.copy(this._aimPoint()).clone();
    target.y = 0;
    const delay = 1.1;
    const dmg = (90 + rank * 30) * power;
    const radius = 4.6;

    // Telegraph: warning rune + expanding rings + light
    game.vfx.runeCircle(target, {
      color: 0xff6b2b, radius: radius, life: delay + 0.25, rotate: true, pulse: true,
    });
    game.audio.play('meteor_warn', { volume: 1 });
    game.vfx.embers(this._scratch2.set(target.x, 0.2, target.z), { count: 14, life: 1.2 });
    game.vfx.ring(target, { radius: radius * 0.5, color: 0xff8a3d, life: 0.4 });

    game.vfx.meteorFall(target, target, { duration: 0.65 });
    this._pending.push({
      t: delay, fn: () => {
        // Impact
        game.vfx.explosion(target, { radius: radius, color: 0xff6b2b, scale: 2.2 });
        game.vfx.ring(target, { radius: radius * 1.35, color: 0xffc37a, life: 0.6, thickness: 0.5 });
        game.vfx.shockwave(target, { radius: radius * 1.1, color: 0xff8a3d, life: 0.55, height: 2.2 });
        game.audio.play('meteor_impact', { volume: 1 });
        game.screenShake(0.9, 0.45);
        game.hitstop(0.06);
        const hitList = game.enemiesInRadius(target, radius);
        for (let i = 0; i < hitList.length; i++) {
          const e = hitList[i];
          game.dealDamage(e, dmg, {
            element: 'fire', source: 'explosion', knockback: 3,
            status: { type: 'burn', duration: 4, dps: 6 + rank * 2 },
          });
        }
        game.vfx.groundScorch(target, radius * 0.8, 5);
        // burning ground: 3s zone dealing burn ticks
        this._burningGround(target, radius * 0.72, 3, 8 + rank * 3, power);
      },
    });
    return true;
  }

  _burningGround(center, radius, duration, tickDps, power) {
    const game = this.game;
    const vfx = game.vfx;
    const zone = {
      t: 0,
      tickTimer: 0,
      update(dt) {
        this.t += dt;
        this.tickTimer -= dt;
        if (this.tickTimer <= 0) {
          this.tickTimer = 0.5;
          const list = game.enemiesInRadius(center, radius);
          for (let i = 0; i < list.length; i++) {
            game.dealDamage(list[i], tickDps * 0.5 * power, {
              element: 'fire', canCrit: false, noNumber: Math.random() > 0.35, source: 'dot',
              status: { type: 'burn', duration: 2, dps: 4 },
            });
          }
        }
        if (Math.random() < 0.5) {
          const a = Math.random() * Math.PI * 2;
          const r = radius * Math.sqrt(Math.random());
          const px = center.x + Math.cos(a) * r;
          const pz = center.z + Math.sin(a) * r;
          vfx.embers({ x: px, y: 0.15, z: pz }, { count: 3, life: 0.9 });
        }
        return this.t < duration;
      },
      dispose() {
        // embers fade on their own; no owned scene objects
      },
    };
    this._zones.push(zone);
  }

  // ------------------------------------------------------------ FROST NOVA
  _frostNova(opts, power) {
    const game = this.game;
    const rank = this.ranks.frost_nova;
    const dmg = (22 + rank * 9) * power;
    const radius = 5.5;
    const origin = game.player.position.clone();
    const chillDur = 4 + (this.ranks.permafrost ?? 0) * 1.5;

    game.audio.play('frost_cast', { volume: 0.9 });
    game.audio.play('frost_burst', { volume: 1 });
    game.screenShake(0.35, 0.3);
    game.hitstop(0.03);
    game.vfx.ring(origin, { radius, color: 0xbdf3ff, life: 0.5, height: 0.1, startRadius: 0.3 });
    game.vfx.ring(origin, { radius: radius * 0.7, color: 0x6fd8ff, life: 0.42, height: 0.35 });
    game.vfx.shockwave(origin, { radius: radius * 0.75, color: 0x8fe6ff, life: 0.45, height: 1.2 });
    game.vfx.frostBurst(origin, { radius: radius * 0.7, spikeScale: 1.1 });
    game.vfx._light(origin.x, 0.9, origin.z, 0x6fd8ff, 6, radius * 3, 0.5, 0.5);
    this._zones.push(this._makeFrostSpikes(origin, radius, 1.4));

    const enemies = game.enemiesInRadius(origin, radius);
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      game.dealDamage(e, dmg, { element: 'frost', source: 'skill', knockback: 1.6 });
      game.applyChill(e, chillDur);
    }
    return true;
  }

  _makeFrostSpikes(center, radius, life) {
    const game = this.game;
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
      color: 0xaeeaff, transparent: true, opacity: 0.7,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const geo = new THREE.ConeGeometry(1, 1, 5);
    const spikes = [];
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = radius * (0.35 + Math.random() * 0.6);
      const h = 0.5 + Math.random() * 1.1;
      const m = new THREE.Mesh(geo, mat);
      m.position.set(center.x + Math.cos(a) * r, h * 0.5, center.z + Math.sin(a) * r);
      m.scale.set(0.14 + Math.random() * 0.1, h, 0.14 + Math.random() * 0.1);
      m.rotation.set((Math.random() - 0.5) * 0.4, 0, (Math.random() - 0.5) * 0.4);
      group.add(m);
      spikes.push(m);
    }
    game.scene.add(group);
    return {
      t: 0,
      update(dt) {
        this.t += dt;
        for (let i = 0; i < spikes.length; i++) {
          spikes[i].position.y = spikes[i].scale.y * 0.5 * Math.min(1, this.t * 5);
        }
        return this.t < life;
      },
      dispose() {
        game.scene.remove(group);
        mat.dispose();
        geo.dispose();
      },
    };
  }

  // ------------------------------------------------------------ ICE SHARDS
  _iceShards(opts, power) {
    const game = this.game;
    const rank = this.ranks.ice_shards;
    const dmg = (11 + rank * 5) * power;
    const origin = this._castersOrigin(this._scratch);
    const baseAngle = Math.atan2(this._aimDir().x, this._aimDir().z);
    const chillDur = 3 + (this.ranks.permafrost ?? 0) * 1.5;
    const spread = 0.5; // radians total fan

    game.audio.play('ice_shards', { volume: 1 });
    game.screenShake(0.18, 0.2);
    for (let i = 0; i < 7; i++) {
      const t = i / 6;
      const angle = baseAngle + (t - 0.5) * spread;
      const dir = this._scratch2.set(Math.sin(angle), 0, Math.cos(angle));
      const shard = this._makeShardMesh();
      game.projectiles.spawn({
        position: origin.clone().setY(0.85),
        direction: dir,
        speed: 20,
        radius: 0.22,
        life: 1.1,
        owner: 'player',
        damage: dmg,
        element: 'frost',
        color: 0x9ae9ff,
        scale: 0.85,
        light: false,
        trail: true,
        mesh: shard,
        onHit: (enemy, proj) => {
          game.dealDamage(enemy, dmg, { element: 'frost', source: 'skill', knockback: 0.8 });
          game.applyChill(enemy, chillDur);
          game.vfx.frostBurst(enemy.position, { radius: 1.4, spikeScale: 0.4 });
          game.audio.play('frost_burst', { volume: 0.4, rate: 1.4 });
        },
      });
    }
    game.vfx.burst(origin, { count: 12, color: 0xbdf3ff, size: 0.12, speed: 4, life: 0.4 });
    return true;
  }

  _makeShardMesh() {
    const geo = new THREE.OctahedronGeometry(0.16, 0);
    const mat = new THREE.MeshBasicMaterial({ color: 0xbdf3ff, fog: false });
    const m = new THREE.Mesh(geo, mat);
    // elongated ice spike shape
    m.scale.set(0.7, 2.6, 0.7);
    return m;
  }

  // ------------------------------------------------------------ BLIZZARD
  _blizzard(opts, power) {
    const game = this.game;
    const rank = this.ranks.blizzard;
    const center = this._scratch.copy(this._aimPoint()).setY(0).clone();
    const radius = 6;
    const duration = 5;
    const tickDps = (8 + rank * 4) * power;
    const chillDur = 1.6 + (this.ranks.permafrost ?? 0) * 1.5;

    game.audio.play('blizzard', { volume: 1 });
    game.screenShake(0.3, 0.4);
    game.vfx.blizzardZone(center, { radius, duration });

    const zone = {
      t: 0,
      tickTimer: 0.25,
      update: (dt) => {
        zone.t += dt;
        zone.tickTimer -= dt;
        if (zone.tickTimer <= 0) {
          zone.tickTimer = 0.75;
          const list = game.enemiesInRadius(center, radius);
          for (let i = 0; i < list.length; i++) {
            game.dealDamage(list[i], tickDps * 0.75, {
              element: 'frost', canCrit: false, noNumber: Math.random() > 0.5, source: 'dot',
            });
            game.applyChill(list[i], chillDur);
          }
          // ice spikes erupting randomly
          const a = Math.random() * Math.PI * 2;
          const r = radius * Math.sqrt(Math.random());
          this._scratch2.set(center.x + Math.cos(a) * r, 0, center.z + Math.sin(a) * r);
          game.vfx.frostBurst(this._scratch2, { radius: 1.2, spikeScale: 0.7, count: 0 });
          game.audio.play('frost_burst', { volume: 0.25, rate: 1.3 + Math.random() * 0.4 });
        }
        return zone.t < duration;
      },
      dispose() {},
    };
    this._zones.push(zone);
    return true;
  }

  // ------------------------------------------------------------ SHADOW STEP
  _shadowStep(opts, power) {
    const game = this.game;
    const rank = this.ranks.shadow_step;
    const dmg = (36 + rank * 14) * power;
    const player = game.player;
    const dist = 8;
    const start = this._scratch.copy(player.position).clone();
    const dir = this._aimDir().clone();

    // Find a collision-safe blink target along the aim direction
    let target = start.clone();
    let step = 0.5;
    while (step <= dist) {
      const testX = start.x + dir.x * step;
      const testZ = start.z + dir.z * step;
      if (game.dungeon.isWalkable(testX, testZ, player.radius)) {
        target.set(testX, player.position.y, testZ);
      } else {
        break;
      }
      step += 0.4;
    }
    // Cut every enemy along the path
    const cut = [];
    for (const e of game.enemies) {
      if (e.dead) continue;
      const dx = e.position.x - start.x;
      const dz = e.position.z - start.z;
      const proj = dx * dir.x + dz * dir.z;
      if (proj < 0 || proj > dist + e.radius) continue;
      const perp = Math.abs(dx * dir.z - dz * dir.x);
      if (perp < e.radius + 0.9) cut.push(e);
    }
    for (const e of cut) {
      game.dealDamage(e, dmg, {
        element: 'void', source: 'skill', knockback: 0.5,
        status: { type: 'void', duration: 2.5, dps: 0 },
      });
    }
    // VFX: dark trail along path, void burst at both ends
    const segCount = Math.max(1, Math.round(target.distanceTo(start) / 0.8));
    for (let i = 0; i < segCount; i++) {
      const t = i / segCount;
      this._scratch2.set(
        start.x + (target.x - start.x) * t,
        0.5 + Math.sin(t * Math.PI) * 0.4,
        start.z + (target.z - start.z) * t,
      );
      game.vfx.burst(this._scratch2, {
        count: 6, color: 0x8a2be2, size: 0.16, speed: 1.6, life: 0.45, spread: 0.8, gravity: -1, up: 0.5,
      });
    }
    game.vfx.voidRift(start, { radius: 1.6, life: 0.9 });
    game.vfx.voidRift(target, { radius: 2.0, life: 1.1 });
    game.vfx.ring(start, { radius: 2.2, color: 0xb46bff, life: 0.4, height: 0.08 });
    game.audio.play('dash', { volume: 1 });
    game.audio.play('void_cast', { volume: 0.7 });
    game.screenShake(0.22, 0.2);
    // Blink: teleport + brief invulnerability
    player.group.position.set(target.x, player.position.y, target.z);
    player.invulnerable = true;
    this._pending.push({
      t: 0.35, fn: () => {
        if (!player.dead) player.invulnerable = false;
      },
    });
    return true;
  }

  // ------------------------------------------------------------ CHAIN LIGHTNING
  _chainLightning(opts, power) {
    const game = this.game;
    const rank = this.ranks.chain_lightning;
    const dmg = (30 + rank * 11) * power;
    const origin = this._castersOrigin(this._scratch2).clone();
    const maxTargets = 5;
    const maxRange = 9;

    // First target: nearest in aim direction, else nearest anywhere
    let current = game.nearestEnemyInDirection(
      origin, this._aimDir(), maxRange, Math.PI * 0.35,
    ) ?? game.nearestEnemy(origin, maxRange * 1.4);
    if (!current) {
      game.vfx.lightning(
        origin,
        this._scratch.copy(origin).addScaledVector(this._aimDir(), 6).clone(),
        { color: 0x9d7bff, life: 0.28 },
      );
      game.audio.play('lightning', { volume: 0.6, rate: 1.3 });
      return true;
    }

    const struckSet = new Set();
    let boltFrom = origin;

    let cur = current;
    for (let n = 0; n < maxTargets && cur; n++) {
      struckSet.add(cur);
      game.vfx.lightning(boltFrom, cur.position, {
        color: 0x9d7bff, life: 0.3, jitter: 0.45, branches: n === 0 ? 3 : 2,
      });
      game.dealDamage(cur, dmg, {
        element: 'lightning', source: 'skill', critBonus: 0.05,
        status: { type: 'shock', duration: 3, dps: 0 },
      });
      game.vfx.impact(cur.position, 0x9d7bff, 0.8);
      game.applyStatus(cur, 'shock', 3, 0);
      boltFrom = cur.position;
      // next: nearest unstruck within chain range
      let best = null;
      let bestDist = maxRange;
      for (const e of game.enemies) {
        if (e.dead || struckSet.has(e)) continue;
        const d = e.position.distanceTo(boltFrom);
        if (d < bestDist) { best = e; bestDist = d; }
      }
      cur = best;
    }
    game.audio.play('lightning', { volume: 1 });
    game.screenShake(0.3, 0.25);
    game.hitstop(0.03);
    game.flashScreen && game.flashScreen(0x9d7bff, 0.12);
    game.vfx.burst(origin, { count: 10, color: 0xb79cff, size: 0.14, speed: 4, life: 0.4 });
    return true;
  }

  // ------------------------------------------------------------ SINGULARITY
  _singularity(opts, power) {
    const game = this.game;
    const rank = this.ranks.singularity;
    const center = this._scratch.copy(this._aimPoint()).setY(0).clone();
    const duration = 1.6;
    const totalDmg = (65 + rank * 22) * power;
    const radius = 6.5;

    game.audio.play('void_cast', { volume: 0.9 });
    game.audio.play('singularity', { volume: 1 });
    game.screenShake(0.4, 0.5);
    game.vfx.blackHole(center, { duration, radius: radius * 0.55 });
    game.vfx.voidRift(center, { radius: 3.2, life: duration + 0.4 });
    game.vfx.ring(center, { radius: radius, color: 0xb46bff, life: 0.6, height: 0.1 });

    const zone = {
      t: 0,
      tickTimer: 0,
      update: (dt) => {
        zone.t += dt;
        zone.tickTimer -= dt;
        // Pull enemies inward
        for (const e of game.enemies) {
          if (e.dead) continue;
          const dx = center.x - e.position.x;
          const dz = center.z - e.position.z;
          const d = Math.sqrt(dx * dx + dz * dz) || 1;
          if (d > radius) continue;
          const strength = (1 - d / radius) * 10;
          const nx = (dx / d) * strength * dt;
          const nz = (dz / d) * strength * dt;
          if (game.dungeon.isWalkable(e.position.x + nx, e.position.z + nz, e.radius)) {
            e.position.x += nx;
            e.position.z += nz;
          }
        }
        // Void damage over life
        if (zone.tickTimer <= 0) {
          zone.tickTimer = 0.4;
          const list = game.enemiesInRadius(center, radius);
          for (let i = 0; i < list.length; i++) {
            game.dealDamage(list[i], totalDmg * 0.25, {
              element: 'void', source: 'skill', noNumber: Math.random() > 0.6,
            });
          }
          game.vfx.voidRift(center, { radius: 1.2, life: 0.4 });
        }
        return zone.t < duration;
      },
      dispose: () => {
        // collapse burst
        game.vfx.explosion(center, { radius: 3.4, color: 0xb46bff, scale: 1.4 });
        game.vfx.shockwave(center, { radius: 5, color: 0x8a2be2, life: 0.5, height: 2 });
        game.audio.play('singularity', { volume: 0.8, rate: 0.7 });
        game.screenShake(0.5, 0.3);
      },
    };
    this._zones.push(zone);
    return true;
  }
}
