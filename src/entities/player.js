import * as THREE from 'three';
import { PLAYER, XP_TABLE, ELEMENTS } from '../config.js';
import { buildPlayerModel } from './models.js';

// ------------------------------------------------------------------ helpers

const _P1 = new THREE.Vector3();
const _RIGHT = new THREE.Vector3();
const _FWD = new THREE.Vector3();
const _DESIRED = new THREE.Vector3();

function lerpAngle(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

const ATTACK_TIME_LIGHT = 0.3;
const ATTACK_TIME_HEAVY = 0.42;
const CAST_TIME = 0.5;
const SHIELD_REGEN_DELAY = 6;
const SHIELD_REGEN_RATE = 0.3; // fraction of cap per second once regen starts
const DODGE_IFRAMES = 0.2;

/**
 * Ember-knight player: procedural hooded knight model, camera-relative movement
 * with wall collision, dodge dash, sword/cast animation, vitals + XP/levels.
 * Talks to the rest of the game exclusively through the `game` facade.
 */
export class Player {
  constructor(scene, game) {
    this.scene = scene;
    this.game = game;

    const model = buildPlayerModel();
    this.model = model;
    this.group = model.group;
    this.parts = model.parts;
    this._mats = model.materials;

    // Base limb rotations captured once; animation writes base + offset.
    const p = model.parts;
    this._base = {
      armLX: p.armL.rotation.x,
      armLZ: p.armL.rotation.z,
      armRX: p.armR.rotation.x,
      armRZ: p.armR.rotation.z,
    };

    // The eyes/rune/blade edge each hold a cloned emissive material; pulse them.
    this._emberMat = p.eyes[0].material;
    this._runeMat = p.rune.material;
    this._bladeMat = p.sword.children[3].material; // emissive edge strip

    this.radius = PLAYER.radius;
    this.maxHp = PLAYER.baseHp;
    this.hp = this.maxHp;
    this.maxMana = PLAYER.baseMana;
    this.mana = this.maxMana;
    this.maxShield = 0;
    this.shield = 0;
    this.level = 1;
    this.xp = 0;
    this.xpNext = XP_TABLE(1);
    this.skillPoints = 1;
    this.dead = false;
    this.invulnerable = 0; // seconds; boolean `true` (shadow step) is also honored
    this.stats = {
      damage: PLAYER.baseDamage,
      moveSpeed: PLAYER.moveSpeed,
      manaRegen: PLAYER.manaRegen,
      critChance: PLAYER.critChance,
      critMult: PLAYER.critMultiplier,
      armor: 0,
    };
    this.dodgeCooldown = 0;
    this.dodgeTimer = 0;
    this.isMoving = false;
    this.casting = 0;
    this.velocity = new THREE.Vector3();
    this._dashVec = new THREE.Vector3();

    this._attackT = 0;
    this._attackDur = ATTACK_TIME_LIGHT;
    this._attackHeavy = false;
    this._attackAlt = false;
    this._runPhase = Math.random() * 6.28;
    this._emberT = 0.4;
    this._trailT = 0;
    this._sinceHit = SHIELD_REGEN_DELAY;
    this._deathReported = false;
    this._disposed = false;

    this.group.position.copy(game.dungeon.playerSpawn);
    this.group.position.y = 0;
    scene.add(this.group);
  }

  get position() { return this.group.position; }

  // ---------------------------------------------------------------- update

  update(dt, input, aimPoint) {
    if (this._disposed || this.dead) return;
    const game = this.game;

    // timers
    this.dodgeCooldown = Math.max(0, this.dodgeCooldown - dt);
    this.dodgeTimer = Math.max(0, this.dodgeTimer - dt);
    if (typeof this.invulnerable === 'number') {
      this.invulnerable = Math.max(0, this.invulnerable - dt);
    }
    this._attackT = Math.max(0, this._attackT - dt);
    if (this.casting > 0) this.casting = Math.max(0, this.casting - dt);
    this._sinceHit += dt;

    // aim / facing
    const aim = aimPoint ?? game.aim?.point ?? this.group.position;
    const pos = this.group.position;

    // movement input, camera-relative
    const mv = input?.getMoveVector?.() ?? { x: 0, z: 0 };
    const cam = game.camera;
    if (cam) {
      _RIGHT.setFromMatrixColumn(cam.matrixWorld, 0);
      _RIGHT.y = 0;
      if (_RIGHT.lengthSq() < 1e-6) _RIGHT.set(1, 0, 0);
      _RIGHT.normalize();
      _FWD.set(_RIGHT.z, 0, -_RIGHT.x);
    } else {
      _RIGHT.set(1, 0, 0);
      _FWD.set(0, 0, -1);
    }
    const speedCap = (game.stats?.moveSpeed ?? this.stats.moveSpeed) * (this.casting > 0 ? 0.55 : 1);
    _DESIRED.set(0, 0, 0)
      .addScaledVector(_FWD, -mv.z)
      .addScaledVector(_RIGHT, mv.x);
    if (_DESIRED.lengthSq() > 1) _DESIRED.normalize();
    _DESIRED.multiplyScalar(speedCap);

    // dodge trigger
    if (this.dodgeTimer <= 0 && this.dodgeCooldown <= 0 && input?.pressed?.('Space')) {
      this.dodge(mv);
    }

    // accelerate toward desired velocity
    const k = 1 - Math.exp(-14 * dt);
    if (this.dodgeTimer <= 0) {
      this.velocity.x += (_DESIRED.x - this.velocity.x) * k;
      this.velocity.z += (_DESIRED.z - this.velocity.z) * k;
    }

    // integrate with wall collision
    if (this.dodgeTimer > 0) {
      this._integrateDash(dt);
    } else {
      this._integrate(this.velocity.x * dt, this.velocity.z * dt);
    }

    const spd = Math.hypot(this.velocity.x, this.velocity.z);
    this.isMoving = spd > 0.4 || this.dodgeTimer > 0;

    // face aim (or dash direction)
    const faceA = this.dodgeTimer > 0
      ? Math.atan2(this._dashVec.x, this._dashVec.z)
      : Math.atan2(aim.x - pos.x, aim.z - pos.z);
    this.group.rotation.y = lerpAngle(this.group.rotation.y, faceA, 1 - Math.exp(-12 * dt));

    // regen
    this.mana = Math.min(this.maxMana, this.mana + (game.getManaRegen?.() ?? this.stats.manaRegen) * dt);
    const cap = game.stats?.shield ?? 0;
    if (cap > 0) {
      if (cap > this.maxShield) this.maxShield = cap;
      if (this._sinceHit >= SHIELD_REGEN_DELAY && this.shield < cap) {
        this.shield = Math.min(cap, this.shield + cap * SHIELD_REGEN_RATE * dt);
      }
    }

    this._animate(dt, spd);
    this._ambientEmbers(dt);
  }

  // dodge dash in movement direction (or aim dir when idle); collision-safe
  dodge(mv) {
    if (this.dead || this._disposed) return false;
    if (this.dodgeCooldown > 0 || this.dodgeTimer > 0) return false;
    const game = this.game;
    const len = Math.hypot(mv?.x ?? 0, mv?.z ?? 0);
    if (len > 0.1) {
      const cam = game.camera;
      if (cam) {
        _RIGHT.setFromMatrixColumn(cam.matrixWorld, 0);
        _RIGHT.y = 0;
        if (_RIGHT.lengthSq() < 1e-6) _RIGHT.set(1, 0, 0);
        _RIGHT.normalize();
        _FWD.set(_RIGHT.z, 0, -_RIGHT.x);
        this._dashVec.set(0, 0, 0).addScaledVector(_FWD, -mv.z).addScaledVector(_RIGHT, mv.x).normalize();
      } else {
        this._dashVec.set(mv.x, 0, mv.z).normalize();
      }
    } else {
      const dir = game.aim?.direction;
      if (dir) this._dashVec.set(dir.x, 0, dir.z).normalize();
      else this._dashVec.set(0, 0, 1);
    }
    this._dashVec.multiplyScalar(PLAYER.dodgeDistance / PLAYER.dodgeDuration);
    this.dodgeTimer = PLAYER.dodgeDuration;
    this.dodgeCooldown = PLAYER.dodgeCooldown;
    if (typeof this.invulnerable === 'number') {
      this.invulnerable = Math.max(this.invulnerable, DODGE_IFRAMES);
    }
    const pos = this.group.position;
    game.vfx?.ring?.(pos, { radius: 1.5, color: 0xffc47a, life: 0.3, height: 0.06, startRadius: 0.3 });
    game.vfx?.burst?.(pos, { count: 10, color: 0xffb45e, size: 0.12, speed: 3, life: 0.35, gravity: 0.5 });
    game.audio?.play?.('dash', { volume: 0.85, rate: 0.95 + Math.random() * 0.1 });
    return true;
  }

  _integrate(dx, dz) {
    const dungeon = this.game.dungeon;
    const pos = this.group.position;
    const r = this.radius;
    if (!dungeon?.isWalkable) { pos.x += dx; pos.z += dz; return; }
    if (dungeon.isWalkable(pos.x + dx, pos.z, r)) pos.x += dx;
    else this.velocity.x *= 0.1;
    if (dungeon.isWalkable(pos.x, pos.z + dz, r)) pos.z += dz;
    else this.velocity.z *= 0.1;
  }

  _integrateDash(dt) {
    const dungeon = this.game.dungeon;
    const pos = this.group.position;
    const r = this.radius;
    const dx = this._dashVec.x * dt;
    const dz = this._dashVec.z * dt;
    let moved = false;
    if (!dungeon?.isWalkable) { pos.x += dx; pos.z += dz; moved = true; }
    else {
      if (dungeon.isWalkable(pos.x + dx, pos.z, r)) { pos.x += dx; moved = true; }
      if (dungeon.isWalkable(pos.x, pos.z + dz, r)) { pos.z += dz; moved = true; }
    }
    if (!moved) this.dodgeTimer = 0; // dash cut short against a wall
  }

  _dodgeTrail() {
    this._trailT -= 0.05; // called once per frame (~60fps): emits every 3rd frame
    if (this._trailT > 0) return;
    this._trailT = 0;
    const game = this.game;
    const pos = this.group.position;
    game.vfx?.spawnParticle?.(
      pos.x + (Math.random() - 0.5) * 0.5, 0.5 + Math.random() * 0.9, pos.z + (Math.random() - 0.5) * 0.5,
      (Math.random() - 0.5) * 1.2, 0.6 + Math.random(), (Math.random() - 0.5) * 1.2,
      1.0, 0.66, 0.34, 0.34, 0.32, 0.6, 0.92, 1.4,
    );
  }

  // ------------------------------------------------------------ combat acts

  // Sword slash animation + trail sparks. No damage logic (game handles hits).
  playAttack(angle, heavy = false) {
    if (this.dead || this._disposed) return;
    this._attackDur = heavy ? ATTACK_TIME_HEAVY : ATTACK_TIME_LIGHT;
    this._attackT = this._attackDur;
    this._attackHeavy = heavy;
    this._attackAlt = !this._attackAlt;
    this.velocity.x += Math.cos(angle) * 1.4;
    this.velocity.z += Math.sin(angle) * 1.4;
    this.game.audio?.play?.('swing', { volume: 0.45, rate: heavy ? 0.8 : 1.02 });
  }

  playCast(school = 'fire') {
    if (this.dead || this._disposed) return;
    this.casting = CAST_TIME;
    const game = this.game;
    const color = ELEMENTS[school]?.color ?? 0xff6b2b;
    const muzzle = this.getMuzzlePosition();
    game.vfx?.flashLight?.(muzzle, { color, intensity: 3.4, distance: 7, life: 0.4 });
    game.vfx?.burst?.(muzzle, { count: 12, color, size: 0.11, speed: 2.4, life: 0.45, gravity: 0.6 });
    game.vfx?.ring?.(this.group.position, { radius: 1.5, color, life: 0.35, height: 0.05, startRadius: 0.2 });
  }

  takeDamage(amount, source = null, opts = {}) {
    if (this._disposed || this.dead) return 0;
    const inv = this.invulnerable;
    if (inv === true || (typeof inv === 'number' && inv > 0)) return 0;
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) return 0;
    const game = this.game;

    const armor = Math.max(0, game.stats?.armor ?? this.stats.armor ?? 0);
    const dmg = amt * (100 / (100 + armor));
    const absorbed = Math.min(this.shield, dmg);
    this.shield -= absorbed;
    const rest = dmg - absorbed;
    this._sinceHit = 0;

    const chest = _P1.set(this.group.position.x, 1.3, this.group.position.z);
    if (absorbed > 0) {
      game.vfx?.impact?.(chest, 0x7bdcff, 0.7);
      game.audio?.play?.('shield', { volume: 0.55, rate: 1.05 });
      if (rest <= 0) game.flashScreen?.('#7bdcff', 0.14);
    }
    if (rest > 0) {
      this.hp -= rest;
      game.vfx?.burst?.(chest, { count: 8, color: 0xff3b2b, size: 0.12, speed: 3, life: 0.35 });
      game.flashScreen?.('#ff4b2e', Math.min(0.3, 0.07 + rest * 0.005));
      game.screenShake?.(Math.min(0.4, 0.1 + rest * 0.008), 0.22);
      game.audio?.play?.('player_hurt', { volume: 0.75, rate: 0.92 + Math.random() * 0.16 });
      // tiny same-frame i-frames: shotgun patterns cannot shred through instantly
      if (typeof this.invulnerable === 'number') {
        this.invulnerable = Math.max(this.invulnerable, 0.12);
      }
      const kb = opts.knockback ?? 0;
      if (kb > 0 && source?.position) {
        const pos = this.group.position;
        let kx = pos.x - source.position.x;
        let kz = pos.z - source.position.z;
        const l = Math.hypot(kx, kz) || 1;
        const boost = Math.min(kb, rest * 0.15);
        this._integrate((kx / l) * boost * 0.1, (kz / l) * boost * 0.1);
      }
    }
    if (this.hp <= 0) {
      this.hp = 0;
      this._die();
    }
    return absorbed + Math.max(0, rest);
  }

  _die() {
    if (this._deathReported) return;
    this.dead = true;
    this._deathReported = true;
    // knockdown pose + extinguished ember
    this.group.rotation.x = -1.3;
    this.group.position.y = -0.18;
    this._emberMat.emissiveIntensity = 0.45;
    this._bladeMat.emissiveIntensity = 0.08;
    this.velocity.set(0, 0, 0);
    this.game.onPlayerDeath?.();
  }

  // ---------------------------------------------------------------- vitals

  heal(n, opts = {}) {
    if (this.dead || this._disposed || !(n > 0)) return 0;
    const before = this.hp;
    this.hp = Math.min(this.maxHp, this.hp + n);
    const got = this.hp - before;
    if (got > 0 && !opts.silent) {
      const pos = this.group.position;
      _P1.set(pos.x, 1.2, pos.z);
      this.game.vfx?.burst?.(_P1, {
        count: 10, color: 0xffd9a0, size: 0.12, speed: 1.6, life: 0.6, gravity: -0.8,
      });
      this.game.vfx?.flashLight?.(_P1, { color: 0xffc47a, intensity: 2.2, distance: 6, life: 0.3 });
    }
    return got;
  }

  restoreMana(n) {
    if (this.dead || this._disposed || !(n > 0)) return 0;
    const before = this.mana;
    this.mana = Math.min(this.maxMana, this.mana + n);
    const got = this.mana - before;
    if (got > 0) {
      const pos = this.group.position;
      _P1.set(pos.x, 1.1, pos.z);
      this.game.vfx?.burst?.(_P1, {
        count: 8, color: 0x6fd8ff, size: 0.1, speed: 1.8, life: 0.5, gravity: -0.6,
      });
    }
    return got;
  }

  addShield(n) {
    if (this._disposed || !(n > 0)) return 0;
    const cap = this.game.stats?.shield ?? 0;
    if (cap <= 0) return 0; // no shield passive: player cannot hold shield
    if (cap > this.maxShield) this.maxShield = cap;
    const before = this.shield;
    this.shield = Math.min(cap, this.shield + n);
    const got = this.shield - before;
    if (got > 0) {
      const pos = this.group.position;
      this.game.vfx?.ring?.(pos, { radius: 1.4, color: 0x7bdcff, life: 0.5, height: 0.4 });
      this.game.audio?.play?.('shield', { volume: 0.5 });
    }
    return got;
  }

  gainXp(n) {
    if (this._disposed || !(n > 0)) return 0;
    let levels = 0;
    this.xp += n;
    while (this.xp >= this.xpNext && levels < 50) {
      this.xp -= this.xpNext;
      this.level++;
      this.xpNext = XP_TABLE(this.level);
      this.skillPoints++;
      this.maxHp += PLAYER.hpPerLevel;
      this.maxMana += PLAYER.manaPerLevel;
      this.stats.damage += PLAYER.damagePerLevel;
      this.hp = Math.min(this.maxHp, this.hp + this.maxHp * 0.3);
      this.mana = this.maxMana;
      levels++;
      const pos = this.group.position;
      const game = this.game;
      _P1.set(pos.x, 1.2, pos.z);
      game.vfx?.burst?.(_P1, {
        count: 26, color: 0xffc56a, size: 0.16, speed: 4.5, life: 0.8, gravity: 1.2,
      });
      game.vfx?.flashLight?.(_P1, { color: 0xffc56a, intensity: 4, distance: 9, life: 0.6 });
    }
    return levels;
  }

  getMuzzlePosition() {
    // spells erupt from the chest rune
    const out = new THREE.Vector3();
    this.parts.runeCore.getWorldPosition(out);
    return out;
  }

  resetForDepth() {
    this.dead = false;
    this._deathReported = false;
    this.hp = Math.min(this.maxHp, this.hp + this.maxHp * 0.25);
    this.mana = this.maxMana;
    this.dodgeCooldown = 0;
    this.dodgeTimer = 0;
    this.casting = 0;
    this._attackT = 0;
    this._sinceHit = SHIELD_REGEN_DELAY;
    this.velocity.set(0, 0, 0);
    this._dashVec.set(0, 0, 0);
    // restore pose (possibly death pose) + ember glow
    this.group.rotation.x = 0;
    this.group.position.y = 0;
    this._emberMat.emissiveIntensity = 2.6;
    this._bladeMat.emissiveIntensity = 0.5;
    const spawn = this.game.dungeon?.playerSpawn;
    if (spawn) {
      this.group.position.copy(spawn);
      this.group.position.y = 0;
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.scene.remove(this.group);
    for (const m of this._mats) m.dispose();
  }

  // ------------------------------------------------------------ animation

  _animate(dt, spd) {
    const p = this.parts;
    const t = this.game.time ?? 0;
    const n = Math.min(1, spd / Math.max(0.1, this.stats.moveSpeed));
    this._runPhase += dt * (4 + 10 * n);
    const s = Math.sin(this._runPhase);
    const base = this._base;

    // legs
    p.legL.rotation.x = s * 0.72 * n;
    p.legR.rotation.x = -s * 0.72 * n;

    // torso bob + lean
    let torsoRX = 0.09 * n + Math.sin(t * 1.8) * 0.02 * (1 - n);
    let torsoRY = 0;
    p.torso.position.y = Math.abs(Math.cos(this._runPhase)) * 0.07 * n;

    // sword arm: attack override, else run swing / idle sway
    if (this._attackT > 0) {
      const a = 1 - this._attackT / this._attackDur;
      if (this._attackHeavy) {
        // overhead: raise (0-0.45) then slam down
        const w = Math.min(1, a / 0.45);
        const sl = Math.max(0, (a - 0.45) / 0.55);
        p.armR.rotation.x = base.armRX - 2.0 * (1 - Math.pow(1 - w, 3)) + 3.1 * sl * sl;
        p.armR.rotation.z = base.armRZ + 0.18 * w - 0.3 * sl;
        torsoRX += 0.3 * sl;
      } else {
        // horizontal slash: wind-out then sweep across
        const e = Math.sin(a * Math.PI);
        p.armR.rotation.x = base.armRX - 1.0 * e;
        p.armR.rotation.z = base.armRZ + (-1.15 + 2.3 * a) * e * (this._attackAlt ? 1 : -1);
        torsoRY = 0.5 * e * (this._attackAlt ? -1 : 1);
      }
      this._bladeTrail();
    } else {
      p.armR.rotation.x = base.armRX - s * 0.42 * n - Math.sin(t * 1.6) * 0.03 * (1 - n);
      p.armR.rotation.z = base.armRZ;
    }

    // off arm: cast raise, else run counter-swing
    if (this.casting > 0) {
      const c = Math.sin((1 - this.casting / CAST_TIME) * Math.PI);
      p.armL.rotation.x = base.armLX - 2.3 * c;
      p.armL.rotation.z = base.armLZ - 0.25 * c;
      torsoRY += 0.22 * c;
    } else {
      p.armL.rotation.x = base.armLX + s * 0.5 * n;
      p.armL.rotation.z = base.armLZ;
    }

    // dodge lean
    if (this.dodgeTimer > 0) {
      torsoRX += 0.45;
      this._dodgeTrail();
    }

    p.torso.rotation.x = torsoRX;
    p.torso.rotation.y = torsoRY;

    // cloak: lean into speed, flutter
    const flutter = Math.sin(t * 7.3) * 0.05 * (0.35 + n) + Math.sin(t * 11.7) * 0.02 * n;
    p.cloak.rotation.x = 0.08 + n * 0.26 + flutter;
    p.cloakTrim.rotation.x = p.cloak.rotation.x + 0.1;

    // ember heartbeat (eyes, rune, blade share the pulse family)
    const castPulse = this.casting > 0 ? 1.6 : 0;
    this._emberMat.emissiveIntensity = 2.4 + Math.sin(t * 6.3) * 0.5 + Math.sin(t * 17.3) * 0.2 + castPulse;
    this._bladeMat.emissiveIntensity = 0.45 + n * 0.1 + this._attackT * 0.7;
    this._runeMat.emissiveIntensity = this._emberMat.emissiveIntensity;
  }

  // sparks streaming off the blade edge during a slash
  _bladeTrail() {
    if (this._trailT > 0) return;
    this._trailT = 0.07;
    const tip = _P1;
    this.parts.swordTip.getWorldPosition(tip);
    this.game.vfx?.spawnParticle?.(
      tip.x, tip.y, tip.z,
      (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 1.2 + 0.3, (Math.random() - 0.5) * 1.2,
      0.7, 0.42, 0.24, 0.12, 0.22, 1.2, 0.9, 1.2,
    );
  }

  _ambientEmbers(dt) {
    this._emberT -= dt;
    if (this._emberT > 0) return;
    this._emberT = 0.45 + Math.random() * 0.45;
    const pos = this.group.position;
    this.game.vfx?.spawnParticle?.(
      pos.x + (Math.random() - 0.5) * 0.3, 1.34, pos.z + (Math.random() - 0.5) * 0.3,
      (Math.random() - 0.5) * 0.4, 0.9 + Math.random() * 0.6, (Math.random() - 0.5) * 0.4,
      1.0, 0.48, 0.2, 0.1, 0.9, -0.4, 0.96, 0.8,
    );
  }
}
