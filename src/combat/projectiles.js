// EMBERFALL — projectile system. Glowing core + additive particle trail + light.
import * as THREE from 'three';

const TRAIL_RATE = 42; // particles per second while moving

export class ProjectileSystem {
  constructor(scene, game) {
    this.scene = scene;
    this.game = game;
    this.projectiles = [];

    this._coreGeo = new THREE.SphereGeometry(1, 10, 8);
    this._haloGeo = new THREE.SphereGeometry(1, 8, 6);

    // Shared materials: creating a fresh material per shot allocates and re-runs
    // renderer setup. Halo color varies, so cache one material per color.
    this._coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
    this._haloMats = new Map();

    // Pooled trail lights, parked permanently in the scene with intensity 0.
    // Adding/removing a light changes Three.js' light-count hash, which recompiles
    // every lit program (~15 programs, ~100ms stall when a pack fires at once).
    this._lightPool = [];
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 8, 2);
      l.position.set(0, -100, 0);
      l.visible = true; // constant count; intensity 0 is free
      scene.add(l);
      this._lightPool.push(l);
    }

    // scratch
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._c1 = new THREE.Color();
  }

  _haloMaterial(color) {
    let m = this._haloMats.get(color);
    if (!m) {
      m = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      });
      this._haloMats.set(color, m);
    }
    return m;
  }

  /**
   * spawn(opts): {
   *   position, direction, speed, radius=0.25, life=3, owner='player'|'enemy',
   *   damage, element, color, scale=1, trail=true, homingTarget, turnRate,
   *   pierce=0, onHit(enemy, projectile), onExpire(position, projectile), mesh?
   * }
   */
  spawn(opts) {
    const color = opts.color ?? 0xff6b2b;
    const scale = opts.scale ?? 1;
    const dir = this._v1.copy(opts.direction);
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();

    const group = new THREE.Group();
    group.position.copy(opts.position);
    if (opts.position.y === undefined) group.position.y = 0.9;

    let ownsMesh = false;
    let core;
    if (opts.mesh) {
      core = opts.mesh;
      group.userData._providedMesh = true;
      group.add(core);
    } else {
      ownsMesh = true;
      core = new THREE.Mesh(this._coreGeo, this._coreMat);
      core.scale.setScalar(0.12 * scale);
      group.add(core);
      const halo = new THREE.Mesh(this._haloGeo, this._haloMaterial(color));
      halo.scale.setScalar(0.34 * scale);
      group.add(halo);
    }

    // Trail light from the permanent pool (never add/remove lights at runtime).
    let light = null;
    if (opts.light !== false && this._lightPool.length) {
      light = this._lightPool.pop();
      light.color.set(color);
      light.intensity = 2.4 * scale;
      light.distance = 5.5 * scale;
      light.position.copy(group.position);
    }

    this.scene.add(group);

    const p = {
      group, core, light,
      vel: dir.clone().multiplyScalar(opts.speed ?? 12),
      speed: opts.speed ?? 12,
      radius: (opts.radius ?? 0.25) * scale,
      life: opts.life ?? 3,
      owner: opts.owner ?? 'player',
      damage: opts.damage ?? 0,
      element: opts.element ?? 'fire',
      scale,
      trailR: ((color >> 16) & 255) / 255,
      trailG: ((color >> 8) & 255) / 255,
      trailB: (color & 255) / 255,
      trail: opts.trail !== false,
      homingTarget: opts.homingTarget ?? null,
      turnRate: opts.turnRate ?? 0,
      pierce: opts.pierce ?? 0,
      hitSet: new Set(),
      onHit: opts.onHit ?? null,
      onExpire: opts.onExpire ?? null,
      trailAcc: 0,
      dead: false,
      ownsMesh,
    };
    this.projectiles.push(p);
    return p;
  }

  _kill(p, hitSomething) {
    if (p.dead) return;
    p.dead = true;
    this.scene.remove(p.group);
    // Shared geometry/materials stay alive; only caller-provided meshes are owned.
    if (p.group.userData._providedMesh) {
      p.core.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
    if (p.light) {
      p.light.intensity = 0;
      p.light.position.set(0, -100, 0);
      this._lightPool.push(p.light);
      p.light = null;
    }
  }

  update(dt) {
    const game = this.game;
    const player = game.player;
    const enemies = game.enemies;

    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];

      // ---- homing steering
      if (p.turnRate > 0 && p.homingTarget && !p.homingTarget.dead) {
        this._v2.copy(p.homingTarget.position).sub(p.group.position).setY(0);
        const dist = this._v2.length();
        if (dist > 0.05) {
          this._v2.normalize().multiplyScalar(p.speed);
          const t = Math.min(1, p.turnRate * dt);
          p.vel.x += (this._v2.x - p.vel.x) * t;
          p.vel.z += (this._v2.z - p.vel.z) * t;
        }
      } else if (p.turnRate > 0 && p.owner === 'player' && !p.homingTarget) {
        // ember bolt-style soft seek: steer toward nearest enemy ahead
        const target = game.nearestEnemyInDirection(
          p.group.position,
          this._v2.set(p.vel.x, 0, p.vel.z).normalize(),
          9, Math.PI * 0.4,
        );
        if (target) {
          this._v2.copy(target.position).sub(p.group.position).setY(0).normalize().multiplyScalar(p.speed);
          const t = Math.min(1, p.turnRate * 0.6 * dt);
          p.vel.x += (this._v2.x - p.vel.x) * t;
          p.vel.z += (this._v2.z - p.vel.z) * t;
        }
      }

      // ---- move
      p.group.position.addScaledVector(p.vel, dt);
      p.life -= dt;
      if (p.light) p.light.position.copy(p.group.position);

      // ---- trail
      if (p.trail) {
        p.trailAcc += dt * TRAIL_RATE * p.scale;
        const pos = p.group.position;
        while (p.trailAcc >= 1 && p.trailAcc < 6) {
          p.trailAcc -= 1;
          const r = p.trailR, g = p.trailG, b = p.trailB;
          this.game.vfx.spawnParticle(
            pos.x + (Math.random() - 0.5) * 0.1,
            pos.y + (Math.random() - 0.5) * 0.1,
            pos.z + (Math.random() - 0.5) * 0.1,
            -p.vel.x * 0.06 + (Math.random() - 0.5) * 0.4,
            0.3 + Math.random() * 0.5,
            -p.vel.z * 0.06 + (Math.random() - 0.5) * 0.4,
            r * 1.2, g * 1.1, b * 0.9,
            0.14 * p.scale, 0.3 + Math.random() * 0.2, 0, 2, 1,
          );
        }
      }

      // ---- wall collision
      if (!game.dungeon.isWalkable(p.group.position.x, p.group.position.z, p.radius * 0.6)) {
        this._impactAndKill(p, true);
        continue;
      }

      // ---- entity collision
      if (p.owner === 'player') {
        let hit = false;
        for (let e = 0; e < enemies.length; e++) {
          const en = enemies[e];
          if (en.dead || p.hitSet.has(en)) continue;
          const dx = en.position.x - p.group.position.x;
          const dz = en.position.z - p.group.position.z;
          const rr = p.radius + en.radius;
          if (dx * dx + dz * dz <= rr * rr) {
            p.hitSet.add(en);
            this._onHitEntity(p, en);
            hit = true;
            if (p.pierce <= 0) break;
            p.pierce--;
          }
        }
        if (hit && p.pierce <= 0) {
          this._impactAndKill(p, false);
          continue;
        }
      } else {
        // enemy projectile vs player
        if (player && !player.dead && !player.invulnerable) {
          const dx = player.position.x - p.group.position.x;
          const dz = player.position.z - p.group.position.z;
          const rr = p.radius + player.radius;
          if (dx * dx + dz * dz <= rr * rr) {
            game.damagePlayer(p.damage, null, { element: p.element });
            this._impactAndKill(p, false);
            continue;
          }
        }
      }

      // ---- expiry
      if (p.life <= 0) {
        if (p.onExpire) p.onExpire(p.group.position, p);
        else this._impactBurst(p);
        this._kill(p, false);
        this.projectiles.splice(i, 1);
      }
    }
  }

  _onHitEntity(p, enemy) {
    if (p.onHit) {
      p.onHit(enemy, p);
      return;
    }
    if (p.owner === 'player') {
      this.game.dealDamage(enemy, p.damage, { element: p.element, source: 'skill' });
      this._impactBurst(p, enemy.position);
    }
  }

  _impactBurst(p, at) {
    const pos = at ?? p.group.position;
    this.game.vfx.impact(pos, p.color, p.scale);
  }

  _impactAndKill(p, hitWall) {
    const pos = p.group.position;
    if (p.onExpire) {
      p.onExpire(pos, p);
    } else {
      this._impactBurst(p);
      if (p.owner === 'player' && p.damage > 0 && !hitWall) {
        // AoE-less direct hit already applied; walls only spark
      }
    }
    this._kill(p, hitWall);
    const idx = this.projectiles.indexOf(p);
    if (idx >= 0) this.projectiles.splice(idx, 1);
  }

  clear() {
    for (const p of this.projectiles) {
      this.scene.remove(p.group);
      if (p.group.userData._providedMesh) {
        p.core.traverse((o) => {
          if (o.geometry) o.geometry.dispose();
          if (o.material) o.material.dispose();
        });
      }
      if (p.light) {
        p.light.intensity = 0;
        p.light.position.set(0, -100, 0);
        this._lightPool.push(p.light);
        p.light = null;
      }
    }
    this.projectiles.length = 0;
  }

  dispose() {
    this.clear();
    this._coreGeo.dispose();
    this._haloGeo.dispose();
    this._coreMat.dispose();
    for (const m of this._haloMats.values()) m.dispose();
    for (const l of this._lightPool) l.dispose();
  }
}
