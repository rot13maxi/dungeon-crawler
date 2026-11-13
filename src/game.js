import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { CAMERA, PLAYER, XP_TABLE, ELEMENTS, DEPTH_SCALE } from './config.js';
import { ROOM_PACKS, ELITE_MODS } from './data/enemies.js';
import { ACTIVE_SKILLS } from './data/skills.js';
import {
  BAG_LIMIT, GEAR_RARITY, aggregateGear, createStarterWeapon, rollLootItem,
} from './data/loot.js';
import { Input } from './core/input.js';
import { AudioEngine } from './core/audio.js';
import { VFX } from './combat/vfx.js';
import { ProjectileSystem } from './combat/projectiles.js';
import { SkillSystem } from './combat/skills.js';
import { Dungeon } from './world/dungeon.js';
import { Player } from './entities/player.js';
import { Enemy } from './entities/enemy.js';
import { UI } from './ui/ui.js';

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const EMPTY_BRANDS = { burn: 0, chill: 0, shock: 0 };

export class Game {
  constructor() {
    this.canvas = document.getElementById('game-canvas');
    this.state = 'menu';
    this.overlay = null;
    this.depth = 1;
    this.kills = 0;
    this.gold = 0;
    this.time = 0;
    this.runTime = 0;
    this.enemies = [];
    this.pickups = [];
    this.equipped = { weapon: null, armor: null, accessory: null };
    this.inventory = [];
    this.gearStats = null;
    this.gearPowers = null;
    this._gearMaxHp = 0;
    this._gearMaxMana = 0;
    this.boss = null;
    this.currentRoom = 0;
    this.aim = { point: new THREE.Vector3(), direction: new THREE.Vector3(0, 0, 1) };
    this.attackCooldown = 0;
    this.attackIndex = 0;
    this.hitstopTimer = 0;
    this.shake = 0;
    this.shakeDecay = CAMERA.shakeDecay;
    this.transitionTimer = 0;
    this._depthBuilt = false;
    this._pendingDepth = 1;
    this._portalArmed = true;
    this._raycaster = new THREE.Raycaster();
    this._floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.15);
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
    this._cameraTarget = new THREE.Vector3();
    this._menuAngle = 0;
    this._lastHud = 0;
    this._statsDirty = true;
    this.stats = {
      damage: PLAYER.baseDamage, moveSpeed: PLAYER.moveSpeed, manaRegen: PLAYER.manaRegen,
      critChance: PLAYER.critChance, critMult: PLAYER.critMultiplier, armor: 0, shield: 0,
      damageMult: 1, chilledDamage: 0, auraDps: 0, deathExplosion: 0, manaOnKill: 0,
      echoChance: 0, chillBonus: 0, chilledCrit: 0, shatterBurst: 0,
    };
    this._lastFrame = performance.now();
    this._raf = 0;
    this._disposed = false;
  }

  async init() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05060a);
    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, window.innerWidth / window.innerHeight, 0.1, 160);
    this.camera.position.set(0, CAMERA.offset.y, CAMERA.offset.z);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.composer.setSize(window.innerWidth, window.innerHeight);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.45, 0.5, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    // Neutral IBL: keeps metal armor and gilded props from reading as black
    // silhouettes in a scene whose only lights are torches and the player spot.
    const roomEnv = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this._envTexture = pmrem.fromScene(roomEnv, 0.04).texture;
    pmrem.dispose();
    roomEnv.dispose();
    this.scene.environment = this._envTexture;
    this.scene.environmentIntensity = 0.38;

    this.input = new Input(this.canvas);
    this.input.enabled = false;
    this.audio = new AudioEngine();
    this.vfx = new VFX(this.scene, this);
    this.projectiles = new ProjectileSystem(this.scene, this);
    this.skills = new SkillSystem(this);
    this.dungeon = new Dungeon(this.scene, { depth: 1 });
    this.player = new Player(this.scene, this);
    this._resetGear();
    this._setupPlayerLight();
    this._setupAimMarker();
    this._computeStats();
    this.ui = new UI(this);
    this.ui.setGear?.(this.equipped, this.inventory.length);
    this.ui.showStart();
    this._wireEvents();
    this._setMenuCamera(0);
    this._lastFrame = performance.now();
    this._loop();
  }

  // One-time shader warm-up, run after the first depth is built: the menu
  // dungeon is disposed by _startDepth, so warming it there would be wasted.
  _warmShaders() {
    // Build one rig of every enemy type, park the heavy VFX materials in the
    // scene, then render so the GPU compiles every program before combat.
    try {
      const P = this.dungeon.playerSpawn;
      // Keep the warm rigs inside the dungeon: the only shadow-casting light is
      // the moon's directional shadow camera, and objects outside it never get
      // their depth (shadow) program variants compiled.
      const warm = P.clone().add(new THREE.Vector3(0, 0, -2.5));
      // Build the rigs once per run: disposing them releases their programs.
      if (!this._warmRigs) {
        this._warmRigs = [];
        for (const id of ['skeleton', 'archer', 'cultist', 'brute', 'boss']) {
          this._warmRigs.push(new Enemy(this.scene, this, id, warm, 0, { boss: id === 'boss' }));
        }
      }
      // Put every heavy VFX material in the scene for the compile pass too.
      this.vfx.explosion?.(warm, { radius: 1, color: 0x000000, scale: 0.01, life: 0.01 });
      this.vfx.shockwave?.(warm, { radius: 1, color: 0x000000, life: 0.01, height: 0.1 });
      this.vfx.ring?.(warm, { radius: 1, color: 0x000000, life: 0.01 });
      this.vfx.runeCircle?.(warm, { color: 0x000000, radius: 1, life: 0.01, duration: 0.01 });
      this.vfx.impact?.(warm, 0x000000, 0.01);
      // One dummy projectile so its core/halo materials are compiled as well.
      this.projectiles.spawn({
        position: warm, direction: new THREE.Vector3(0, 0, 1),
        speed: 0.01, life: 0.01, owner: 'enemy', damage: 0,
      });
      this.vfx.screenFlash?.(0x000000, 0.01, 0.01);
      // Allocate the full vfx light pool up front (attaches once; no runtime recompiles).
      this.vfx.warmLights?.(8);
      // Force one real render pass into the composer's render target. This is
      // stronger than renderer.compile(): it runs the shadow pass and compiles
      // programs against the same target color space gameplay uses, so no
      // first-use compile can land on a combat frame.
      // A throwaway camera aimed straight at the warm rigs guarantees they pass
      // frustum culling (the menu camera may be looking elsewhere entirely).
      const warmCam = this.camera.clone();
      warmCam.position.set(warm.x + 3.2, 2.4, warm.z + 3.2);
      warmCam.lookAt(warm.x, 1.0, warm.z);
      warmCam.updateMatrixWorld(true);
      const rt = this.composer.renderTarget1;
      this.renderer.setRenderTarget(rt);
      this.scene.updateMatrixWorld(true);
      this.renderer.render(this.scene, warmCam);
      this.renderer.render(this.scene, warmCam);
      // Every room's props are built up front but only compile when the camera
      // first sees them; compile() walks all materials without drawing the
      // dungeon, so entering a room never pays a first-use compile.
      this.renderer.compile(this.scene, warmCam);
      this.renderer.setRenderTarget(null);
      // Keep the warm rigs alive but invisible: disposing them releases their
      // material programs, and the first real spawn then recompiles them on a
      // gameplay frame (~17 programs, ~90ms stall). Invisible groups cost nothing.
      for (const e of this._warmRigs) e.group.visible = false;
      this.projectiles.clear();
      this.vfx.clear();
      if (this.vfx._flashQuad) this.vfx._flashQuad.visible = false;
    } catch { /* warm-up is best-effort; a failure must never block the run */ }
  }

  _setupAimMarker() {
    this.aimMarker = new THREE.Group();
    const ringGeo = new THREE.RingGeometry(0.38, 0.47, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffc56a, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    this.aimMarker.add(ring);
    const dotGeo = new THREE.CircleGeometry(0.045, 12);
    const dotMat = new THREE.MeshBasicMaterial({
      color: 0xffe6bd, transparent: true, opacity: 0.8,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
    });
    const dot = new THREE.Mesh(dotGeo, dotMat);
    dot.rotation.x = -Math.PI / 2;
    this.aimMarker.add(dot);
    this.aimMarker.position.set(0, 0.06, 0);
    this.aimMarker.visible = false;
    this.scene.add(this.aimMarker);
    this._aimRing = ring;
    this._aimDot = dot;
    this._aimRingMat = ringMat;
  }

  _updateAimMarker() {
    if (!this.aimMarker) return;
    const active = this.state === 'playing';
    this.aimMarker.visible = active;
    if (!active) return;
    this.aimMarker.position.set(this.aim.point.x, 0.06, this.aim.point.z);
    const target = this.nearestEnemy(this.aim.point, 1.8);
    const color = target ? 0xff5a3d : 0xffc56a;
    this._aimRingMat.color.setHex(color);
    this._aimRingMat.opacity = 0.42 + Math.sin(this.time * 5) * 0.1;
    this._aimRing.scale.setScalar(target ? 1.12 : 1);
  }

  _setupPlayerLight() {
    this.playerLight = new THREE.SpotLight(0xffd7a4, 620, 30, 1.02, 0.6, 1.24);
    this.playerLight.castShadow = false;
    this.scene.add(this.playerLight);
    this.scene.add(this.playerLight.target);
    this.playerLight.position.set(0, 12, 0);
  }

  _wireEvents() {
    this._onResize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
      this.composer.setSize(w, h);
      this.bloom.setSize(w, h);
      this.ui?.onResize?.();
    };
    window.addEventListener('resize', this._onResize);
    this._onVisibility = () => {
      if (document.hidden && this.state === 'playing') this._openPause();
    };
    document.addEventListener('visibilitychange', this._onVisibility);
  }

  _loop = () => {
    if (this._disposed) return;
    this._raf = requestAnimationFrame(this._loop);
    const now = performance.now();
    const dt = Math.min((now - this._lastFrame) / 1000, 0.05);
    this._lastFrame = now;
    this._tick(dt);
  };

  _tick(dt) {
    this.time += dt;
    if (this.state === 'menu') {
      this._menuAngle += dt * 0.07;
      this._setMenuCamera(this.time);
      this.dungeon.update(dt, this.time);
      this.player.update(dt, this.input, this.aim.point);
      this.vfx.update(dt);
      this.ui.update(dt);
      this._render();
      this.input.endFrame();
      return;
    }
    if (this.state === 'paused') {
      this._handleOverlayKeys();
      this.dungeon.update(dt * 0.18, this.time);
      this.vfx.update(dt * 0.18);
      this.ui.update(dt);
      this._render();
      this.input.endFrame();
      return;
    }
    if (this.state === 'dead') {
      this.dungeon.update(dt, this.time);
      this.vfx.update(dt);
      this.ui.update(dt);
      this._render();
      this.input.endFrame();
      return;
    }
    if (this.state === 'transition') {
      this.transitionTimer -= dt;
      this.vfx.update(dt);
      this.dungeon.update(dt, this.time);
      this.ui.update(dt);
      this._updateCamera(dt);
      this._updatePlayerLight();
      if (this.transitionTimer <= 0) {
        this._startDepth(this._pendingDepth, { advance: true });
        this.state = 'playing';
        this.input.enabled = true;
      }
      this._render();
      this.input.endFrame();
      return;
    }

    this.runTime += dt;
    if (this.hitstopTimer > 0) {
      this.hitstopTimer -= dt;
      this.vfx.update(dt * 0.25);
      this.ui.update(dt);
      this._updateCamera(dt);
      this._render();
      this.input.endFrame();
      return;
    }

    this._handleHotkeys();
    this._updateAim();
    this.player.update(dt, this.input, this.aim.point);
    this._updateBasicAttack(dt);
    this.skills.update(dt);
    this.projectiles.update(dt);
    for (let i = 0; i < this.enemies.length; i++) this.enemies[i].update(dt);
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (e.dead && !e._killHandled) this.onEnemyKilled(e);
    }
    this._updateRooms(dt);
    this._updatePickups(dt);
    this._updatePortal(dt);
    this.dungeon.update(dt, this.time);
    this.vfx.update(dt);
    this._updateCamera(dt);
    this._updatePlayerLight();
    this._updatePassives(dt);
    this._updateHud(dt);
    this.ui.update(dt);
    this._render();
    this.input.endFrame();
  }

  _render() {
    this.composer.render();
  }

  _setMenuCamera(t) {
    const room = this.dungeon.rooms[0];
    const c = room ? room.center : new THREE.Vector3();
    const r = 7.5;
    const x = c.x + Math.cos(t * 0.07) * r;
    const z = c.z + Math.sin(t * 0.07) * r;
    this.camera.position.set(x, 10.5, z + 8);
    this._cameraTarget.set(c.x, 1.1, c.z);
    this.camera.lookAt(this._cameraTarget);
    if (this.playerLight) {
      this.playerLight.position.set(c.x, 12, c.z);
      this.playerLight.target.position.set(c.x, 0, c.z);
      this.playerLight.target.updateMatrixWorld();
    }
  }

  _updateCamera(dt) {
    const p = this.player.position;
    const desired = this._tmp.set(p.x + CAMERA.offset.x, CAMERA.offset.y, p.z + CAMERA.offset.z);
    if (this.shake > 0.001) {
      this.shake = Math.max(0, this.shake - this.shakeDecay * dt);
      const s = this.shake * 0.16;
      desired.x += (Math.random() * 2 - 1) * s;
      desired.y += (Math.random() * 2 - 1) * s * 0.6;
      desired.z += (Math.random() * 2 - 1) * s;
    }
    const k = 1 - Math.exp(-CAMERA.followLerp * dt);
    this.camera.position.lerp(desired, k);
    this._cameraTarget.set(p.x, p.y + CAMERA.lookHeight, p.z);
    this.camera.lookAt(this._cameraTarget);
    this._updatePlayerLight();
  }

  _updatePlayerLight() {
    if (!this.playerLight || !this.player) return;
    const p = this.player.position;
    this.playerLight.position.set(p.x, 12, p.z);
    this.playerLight.target.position.set(p.x, 0, p.z);
    this.playerLight.target.updateMatrixWorld();
    this.playerLight.intensity = 620 + Math.sin(this.time * 6.2) * 28 + Math.sin(this.time * 13.1) * 14;
  }

  _updateAim() {
    const ndc = this.input.getMouseNDC();
    this._raycaster.setFromCamera(ndc, this.camera);
    const hit = this._raycaster.ray.intersectPlane(this._floorPlane, this._tmp);
    if (hit) {
      const p = this.player.position;
      const dx = hit.x - p.x;
      const dz = hit.z - p.z;
      const len = Math.hypot(dx, dz);
      const max = 18;
      if (len > max) {
        hit.x = p.x + (dx / len) * max;
        hit.z = p.z + (dz / len) * max;
      }
      this.aim.point.copy(hit);
    } else {
      this.aim.point.set(this.player.position.x, 0.2, this.player.position.z + 5);
    }
    this.aim.direction.set(this.aim.point.x - this.player.position.x, 0, this.aim.point.z - this.player.position.z);
    if (this.aim.direction.lengthSq() < 0.001) this.aim.direction.set(0, 0, 1);
    this.aim.direction.normalize();
    this._updateAimMarker();
  }

  _handleHotkeys() {
    if (this.input.consumePress('Escape')) {
      if (this.overlay === 'skilltree') this.ui.closeSkillTree();
      else if (this.overlay === 'inventory') this.ui.closeInventory();
      else if (this.state === 'playing') this._openPause();
      else if (this.overlay === 'pause') this._closePause();
      return;
    }
    if (this.input.consumePress('KeyI')) {
      if (this.overlay === 'inventory') this.ui.closeInventory();
      else if (this.state === 'playing') this.ui.openInventory();
      return;
    }
    if (this.input.consumePress('KeyT')) {
      if (this.overlay === 'skilltree') this.ui.closeSkillTree();
      else if (this.state === 'playing') this.ui.openSkillTree();
      return;
    }
    const actives = this.skills.getActiveSkills();
    for (let i = 0; i < Math.min(9, actives.length); i++) {
      if (this.input.consumePress(`Digit${i + 1}`)) {
        this.skills.cast(actives[i].id);
        break;
      }
    }
    if (this.input.consumeDown(2)) {
      const first = actives[0];
      if (first) this.skills.cast(first.id);
    }
    if (this.input.consumePress('KeyH')) {
      this._openSkillTree();
    }
  }

  _openSkillTree() {
    if (this.state === 'playing') this.ui.openSkillTree();
  }

  _openPause() {
    if (this.state !== 'playing') return;
    this.overlay = 'pause';
    this.state = 'paused';
    this.input.enabled = true;
    this.ui.showPause(() => this._closePause());
  }

  _handleOverlayKeys() {
    if (this.input.consumePress('Escape')) {
      if (this.overlay === 'skilltree') this.ui.closeSkillTree();
      else if (this.overlay === 'inventory') this.ui.closeInventory();
      else if (this.overlay === 'pause') this._closePause();
    }
    if (this.input.consumePress('KeyI')) {
      if (this.overlay === 'inventory') this.ui.closeInventory();
    }
    if (this.input.consumePress('KeyT')) {
      if (this.overlay === 'skilltree') this.ui.closeSkillTree();
      else if (this.overlay === 'pause') {
        this._closePause();
        this.ui.openSkillTree();
      } else if (this.overlay === 'inventory') {
        this.ui.closeInventory();
        this.ui.openSkillTree();
      }
    }
  }

  _closePause() {
    if (this.overlay !== 'pause') return;
    this.overlay = null;
    this.state = 'playing';
    this.input.enabled = true;
    this.ui.hidePause();
  }

  setOverlay(kind, open) {
    if (open) {
      if (this.state !== 'playing') return;
      this.overlay = kind;
      this.state = 'paused';
      this.input.enabled = true;
    } else {
      if (this.overlay !== kind) return;
      this.overlay = null;
      this.state = 'playing';
      this.input.enabled = true;
    }
  }

  _updateBasicAttack(dt) {
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    if (!this.input.mouse.left || this.attackCooldown > 0 || this.player.dead) return;
    this.attackCooldown = 0.36;
    this.attackIndex = (this.attackIndex + 1) % 2;
    const dir = this.aim.direction;
    const angle = Math.atan2(dir.x, dir.z);
    const p = this.player.position;
    const slashPos = this._tmp2.set(p.x + dir.x * 1.15, 0.05, p.z + dir.z * 1.15);
    this.player.playAttack(angle, this.attackIndex === 0);
    this.vfx.slash(slashPos, angle, {
      color: 0xffc08a, radius: 1.9, life: 0.2, arc: Math.PI * 0.92, height: 1.05, opacity: 0.32,
    });
    this.vfx.burst(this._tmp.set(p.x + dir.x * 1.4, 1.0, p.z + dir.z * 1.4), {
      count: 5, color: 0xff9a55, size: 0.07, speed: 1.8, life: 0.26,
    });
    this.audio.play('swing', { volume: 0.55, rate: 0.94 + Math.random() * 0.12 });
    const range = 3.0;
    const arc = Math.PI * 0.3;
    const brands = this.stats.brands;
    let status = null;
    if (brands.burn > 0) status = { type: 'burn', duration: 3, dps: brands.burn };
    else if (brands.chill > 0) status = { type: 'chill', duration: brands.chill };
    else if (brands.shock > 0) status = { type: 'shock', duration: brands.shock };
    else if (this.attackIndex === 0) status = { type: 'burn', duration: 2.5, dps: 3 };
    let hit = false;
    const hitEnemies = [];
    for (const e of this.enemies) {
      if (e.dead) continue;
      const dx = e.position.x - p.x;
      const dz = e.position.z - p.z;
      const dist = Math.hypot(dx, dz);
      if (dist > range + e.radius) continue;
      const dot = (dx * dir.x + dz * dir.z) / Math.max(0.001, dist);
      if (dot < Math.cos(arc)) continue;
      const base = this.stats.damage * (this.attackIndex === 0 ? 1 : 0.92);
      this.dealDamage(e, base, {
        element: 'physical',
        source: 'basic',
        knockback: 2.2,
        status,
      });
      hit = true;
      hitEnemies.push(e);
    }
    if (hit) {
      this.hitstop(0.028);
      this.screenShake(0.16, 0.16);
      this.audio.play('hit', { volume: 0.5 });
      if (this.stats.chainChance > 0 && Math.random() < this.stats.chainChance) {
        const secondary = this.nearestEnemy(p, 5.5, hitEnemies);
        if (secondary) {
          const from = this.player.getMuzzlePosition();
          this.vfx.lightning?.(from, secondary.position, {
            color: 0x9d7bff, life: 0.22, jitter: 0.3, branches: 1,
          });
          this.dealDamage(secondary, this.stats.damage * 0.5, {
            element: 'lightning', source: 'chain', canCrit: false,
          });
        }
      }
    }
  }

  _updateHud(dt) {
    this._lastHud += dt;
    if (this._lastHud < 0.05) return;
    this._lastHud = 0;
    if (!this.ui) return;
    this.ui.setVitals(this.player.hp, this.player.maxHp, this.player.mana, this.player.maxMana, this.player.shield);
    this.ui.setProgress(this.player.level, this.player.xp, this.player.xpNext, this.depth, this.kills);
    const actives = this.skills.getActiveSkills();
    const cooldowns = {};
    for (const s of actives) cooldowns[s.id] = this.skills.cooldowns[s.id] ?? 0;
    this.ui.setSkillBar(actives, cooldowns);
    this.ui.setSkillPoints(this.player.skillPoints);
    this.ui.updateEnemyBars(this.enemies, this.camera);
  }

  async startRun() {
    this.audio.init();
    this.audio.startAmbience();
    this._resetRun();
    this.state = 'playing';
    this.input.enabled = true;
    this.ui.showHUD();
    this.ui.hideStart?.();
    this.ui.showBanner('THE ASHEN DEPTHS', 'Descend. Survive. Burn.', 'gold', 3.2);
    this._startDepth(1, { fresh: true });
  }

  _resetRun() {
    this.depth = 1;
    this.kills = 0;
    this.gold = 0;
    this.runTime = 0;
    this.boss = null;
    this.currentRoom = 0;
    this.skills.reset();
    this._clearEnemies();
    this._clearPickups();
    this.projectiles.clear();
    this.vfx.clear();
    const p = this.player;
    p.level = 1;
    p.xp = 0;
    p.xpNext = XP_TABLE(1);
    p.skillPoints = 1;
    p.maxHp = PLAYER.baseHp;
    p.hp = p.maxHp;
    p.maxMana = PLAYER.baseMana;
    p.mana = p.maxMana;
    p.shield = 0;
    p.dead = false;
    p.invulnerable = 0;
    p.stats ??= {};
    p.stats.damage = PLAYER.baseDamage;
    p.stats.moveSpeed = PLAYER.moveSpeed;
    p.stats.manaRegen = PLAYER.manaRegen;
    p.stats.critChance = PLAYER.critChance;
    p.stats.critMult = PLAYER.critMultiplier;
    p.stats.armor = 0;
    this._gearMaxHp = 0;
    this._gearMaxMana = 0;
    this._resetGear();
  }

  _startDepth(depth, opts = {}) {
    this.depth = depth;
    this._pendingDepth = depth;
    this._depthBuilt = true;
    this._portalArmed = true;
    this.boss = null;
    this.currentRoom = 0;
    this._clearEnemies();
    this._clearPickups();
    this.projectiles.clear();
    this.vfx.clear();
    if (this.dungeon) {
      this.scene.remove(this.dungeon.group);
      this.dungeon.dispose();
    }
    this.dungeon = new Dungeon(this.scene, { depth });
    const p = this.player;
    p.group.position.copy(this.dungeon.playerSpawn);
    p.group.position.y = 0;
    p.dead = false;
    p.invulnerable = Math.max(p.invulnerable ?? 0, 1.2);
    if (opts.fresh) {
      p.hp = p.maxHp;
      p.mana = p.maxMana;
      p.shield = 0;
    } else {
      p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.25);
      p.mana = Math.min(p.maxMana, p.mana + p.maxMana * 0.4);
      p.shield = 0;
      if (typeof p.resetForDepth === 'function') p.resetForDepth();
      p.group.position.copy(this.dungeon.playerSpawn);
      p.group.position.y = 0;
      p.invulnerable = Math.max(p.invulnerable ?? 0, 1.2);
    }
    const entry = this.dungeon.rooms[0];
    if (entry) entry.activated = true;
    this.aim.point.set(p.position.x, 0.2, p.position.z + 5);
    this.aim.direction.set(0, 0, 1);
    this._cameraTarget.set(p.position.x, 1.2, p.position.z);
    this.camera.position.set(p.position.x + CAMERA.offset.x, CAMERA.offset.y, p.position.z + CAMERA.offset.z);
    this.camera.lookAt(this._cameraTarget);
    this.ui.setBoss(null);
    this.ui.showBanner(`DEPTH ${ROMAN[depth] ?? depth}`, depth === 1 ? 'The Ashen Depths await' : 'The dark grows hungry', 'gold', 2.6);
    this.ui.setProgress(p.level, p.xp, p.xpNext, depth, this.kills);
    this.ui.refreshSkillTree?.();
    this.audio.setDepth?.(depth);
    this._computeStats();
    this._lastHud = 1;
    this._warmShaders();
  }

  _clearEnemies() {
    for (const e of this.enemies) {
      if (e.dispose) e.dispose();
      else if (e.group) this.scene.remove(e.group);
    }
    this.enemies.length = 0;
    this.boss = null;
  }

  _clearPickups() {
    for (const p of this.pickups) {
      if (p.group) this.scene.remove(p.group);
      if (p.dispose) p.dispose();
    }
    this.pickups.length = 0;
  }

  dispose() {
    this._disposed = true;
    cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('visibilitychange', this._onVisibility);
    this.input?.dispose();
    this.ui?.destroy?.();
    this.audio?.dispose?.();
    this.dungeon?.dispose?.();
    this.player?.dispose?.();
    this.vfx?.dispose?.();
    this.projectiles?.dispose?.();
    for (const set of [this._pickupGeo, this._gearGeo]) {
      if (!set) continue;
      for (const geo of Object.values(set)) geo.dispose?.();
    }
    this.renderer?.dispose?.();
  }

  // ------------------------------------------------------------ stats & combat
  _computeStats() {
    if (!this.player) return;
    const p = this.player;
    const passive = this.skills?.getPassiveStats?.() ?? {};
    const base = p.stats ?? {};
    const g = this.gearStats ?? {};
    const brands = g.brands ?? EMPTY_BRANDS;
    this.stats = {
      damage: (base.damage ?? PLAYER.baseDamage) + (g.damage ?? 0),
      moveSpeed: (base.moveSpeed ?? PLAYER.moveSpeed) * (1 + (g.moveSpeedPct ?? 0)),
      manaRegen: (base.manaRegen ?? PLAYER.manaRegen) + (passive.manaRegen ?? 0) + (g.manaRegen ?? 0),
      critChance: (base.critChance ?? PLAYER.critChance) + (passive.critChance ?? 0) + (g.critChance ?? 0),
      critMult: (base.critMult ?? PLAYER.critMultiplier) + (g.critMult ?? 0),
      armor: (base.armor ?? 0) + (passive.armor ?? 0) + (g.armor ?? 0),
      shield: (passive.shield ?? 0) + (g.shield ?? 0),
      damageMult: (passive.damageMult ?? 1) * (1 + (g.damagePct ?? 0)),
      lifesteal: g.lifesteal ?? 0,
      thorns: g.thorns ?? 0,
      execute: g.execute ?? 0,
      chainChance: g.chainChance ?? 0,
      goldFind: g.goldFind ?? 0,
      pickupRadius: PLAYER.pickupRadius + (g.pickupRadius ?? 0),
      brands,
      chilledDamage: passive.chilledDamage ?? 0,
      auraDps: (passive.auraDps ?? 0) + (g.auraDps ?? 0),
      deathExplosion: (passive.deathExplosion ?? 0) + (g.deathExplosion ?? 0),
      manaOnKill: (passive.manaOnKill ?? 0) + (g.manaOnKill ?? 0),
      echoChance: (passive.echoChance ?? 0) + (g.echoChance ?? 0),
      chillBonus: passive.chillBonus ?? 0,
      chilledCrit: passive.chilledCrit ?? 0,
      shatterBurst: passive.shatterBurst ?? 0,
    };
  }

  // ------------------------------------------------------------ gear & loot

  _resetGear() {
    this.equipped = { weapon: createStarterWeapon(), armor: null, accessory: null };
    this.inventory.length = 0;
    this._applyGear();
  }

  _applyGear() {
    const agg = aggregateGear(this.equipped);
    this.gearStats = agg.stats;
    this.gearPowers = agg.powers;
    const p = this.player;
    if (!p) return;
    const hpDelta = agg.stats.maxHp - this._gearMaxHp;
    const manaDelta = agg.stats.maxMana - this._gearMaxMana;
    this._gearMaxHp = agg.stats.maxHp;
    this._gearMaxMana = agg.stats.maxMana;
    p.maxHp = Math.max(1, p.maxHp + hpDelta);
    p.maxMana = Math.max(0, p.maxMana + manaDelta);
    p.hp = Math.min(p.hp, p.maxHp);
    p.mana = Math.min(p.mana, p.maxMana);
    this._computeStats();
    const shieldCap = this.stats.shield ?? 0;
    p.shield = Math.min(p.shield, Math.max(0, shieldCap));
    p.maxShield = shieldCap;
    this.ui?.setGear?.(this.equipped, this.inventory.length);
  }

  equipItem(item) {
    if (!item || !(item.slot in this.equipped)) return false;
    const idx = this.inventory.indexOf(item);
    if (idx < 0) return false;
    const old = this.equipped[item.slot];
    this.inventory.splice(idx, 1);
    if (old) this.inventory.push(old);
    this.equipped[item.slot] = item;
    this._applyGear();
    this.ui?.refreshInventory?.();
    this.ui?.showToast?.(`Equipped ${item.name}`, item.rarity);
    this.audio?.play?.('loot', { volume: 0.6, rate: 1.1 });
    this.vfx?.burst?.(this.player.position, {
      count: 16, color: GEAR_RARITY[item.rarity].color, size: 0.12, speed: 3, life: 0.6, gravity: -0.4,
    });
    return true;
  }

  unequipItem(slot) {
    const item = this.equipped?.[slot];
    if (!item) return false;
    if (this.inventory.length >= BAG_LIMIT) {
      this.ui?.showToast?.('Satchel full', 'common');
      return false;
    }
    this.equipped[slot] = null;
    this.inventory.push(item);
    this._applyGear();
    this.ui?.refreshInventory?.();
    this.ui?.showToast?.(`Stowed ${item.name}`, item.rarity);
    return true;
  }

  discardItem(index) {
    const item = this.inventory[index];
    if (!item) return false;
    const rarityMult = { common: 1, magic: 2, rare: 4, legendary: 8 }[item.rarity] ?? 1;
    const value = Math.max(1, Math.round((item.ilvl + (item.powers?.length ?? 0) * 4) * rarityMult));
    this.inventory.splice(index, 1);
    this.gold += value;
    this.ui?.setGear?.(this.equipped, this.inventory.length);
    this.ui?.refreshInventory?.();
    this.ui?.showToast?.(`Melted ${item.name} → ${value} gold`, item.rarity);
    this.audio?.play?.('loot', { volume: 0.5, rate: 0.9 });
    return true;
  }

  addGear(item) {
    if (!item) return false;
    if (this.inventory.length >= BAG_LIMIT) {
      this.ui?.showToast?.('Satchel full', 'common');
      return false;
    }
    this.inventory.push(item);
    this.ui?.setGear?.(this.equipped, this.inventory.length);
    this.ui?.showToast?.(
      `${GEAR_RARITY[item.rarity].name.toUpperCase()}: ${item.name} — [I] Armory`,
      item.rarity,
    );
    this.audio?.play?.('loot', { volume: 0.6, rate: 1.25 });
    return true;
  }

  dealDamage(enemy, baseDamage, opts = {}) {
    if (!enemy || enemy.dead || baseDamage <= 0) return { damage: 0, crit: false, killed: false };
    const stats = this.stats;
    let dmg = baseDamage * stats.damageMult;
    const chilled = enemy.isChilled || enemy.hasStatus?.('chill');
    if (chilled) dmg *= 1 + stats.chilledDamage;
    if (enemy.hasStatus?.('shock')) dmg *= 1.15;
    if (stats.execute > 0 && enemy.maxHp > 0 && enemy.hp / enemy.maxHp < 0.3) {
      dmg *= 1 + stats.execute;
    }
    let crit = false;
    if (opts.canCrit !== false) {
      const chance = Math.max(0, Math.min(1, stats.critChance + (opts.critBonus ?? 0)));
      crit = Math.random() < chance;
      if (crit) dmg *= stats.critMult + (chilled ? stats.chilledCrit : 0);
    }
    dmg = Math.max(1, Math.round(dmg));
    const killed = enemy.takeDamage(dmg, {
      element: opts.element ?? 'physical',
      crit,
      knockback: opts.knockback ?? 0,
      source: opts.source ?? 'skill',
    });
    if (!opts.noNumber) {
      const y = (enemy.bodyHeight ?? 1.7) + 0.35;
      this.ui?.showDamageNumber?.(
        new THREE.Vector3(enemy.position.x, y, enemy.position.z),
        dmg,
        { color: ELEMENTS[opts.element ?? 'physical']?.ui ?? '#ffe2b8', crit, element: opts.element ?? 'physical' },
      );
    }
    if (opts.status && !enemy.dead) {
      this.applyStatus(enemy, opts.status.type, opts.status.duration, opts.status.dps ?? 0);
    }
    if (stats.lifesteal > 0 && !this.player.dead && !opts.noLifesteal
      && opts.source !== 'dot' && opts.source !== 'aura' && opts.source !== 'thorns') {
      const healed = this.player.heal(dmg * stats.lifesteal, { silent: true });
      if (healed >= 1) this.vfx?.impact?.(this.player.position, 0xff5a4a, 0.25);
    }
    if (crit) {
      this.hitstop(0.025);
      this.screenShake(0.18, 0.18);
      this.audio?.play?.('crit', { volume: 0.55 });
    } else if (opts.source === 'basic' || opts.source === 'explosion') {
      this.screenShake(0.06, 0.1);
    }
    return { damage: dmg, crit, killed };
  }

  damagePlayer(amount, sourceEnemy = null, opts = {}) {
    if (!this.player || this.player.dead || this.player.invulnerable > 0) return 0;
    const dealt = this.player.takeDamage(amount, sourceEnemy, opts);
    if (dealt > 0) {
      if (amount > 12) this.screenShake(Math.min(0.5, amount * 0.012), 0.24);
      this.hitstop(amount > 15 ? 0.025 : 0);
      const thorns = this.stats.thorns ?? 0;
      if (thorns > 0 && sourceEnemy && !sourceEnemy.dead) {
        this.dealDamage(sourceEnemy, dealt * thorns, {
          element: 'physical', source: 'thorns', canCrit: false, noNumber: true, noLifesteal: true,
        });
        this.vfx?.impact?.(sourceEnemy.position, 0xffd9a0, 0.4);
      }
    }
    return dealt;
  }

  applyStatus(enemy, type, duration, dps = 0) {
    if (!enemy || enemy.dead) return;
    if (type === 'chill') {
      duration += this.stats.chillBonus ?? 0;
      enemy.applyStatus?.('chill', duration, 0);
      this.vfx?.burst?.(this._tmp.set(enemy.position.x, 1, enemy.position.z), {
        count: 6, color: 0x9fe8ff, size: 0.09, speed: 2, life: 0.5,
      });
      return;
    }
    enemy.applyStatus?.(type, duration, dps);
    const colors = { burn: 0xff6b2b, shock: 0x9d7bff, void: 0xc04dff };
    if (colors[type]) {
      this.vfx?.burst?.(this._tmp.set(enemy.position.x, 1.1, enemy.position.z), {
        count: 7, color: colors[type], size: 0.1, speed: 2.4, life: 0.45,
      });
    }
  }

  applyChill(enemy, duration) {
    this.applyStatus(enemy, 'chill', duration, 0);
  }

  enemiesInRadius(point, radius, includeDead = false) {
    const out = [];
    const r2 = radius * radius;
    for (const e of this.enemies) {
      if (!includeDead && e.dead) continue;
      const dx = e.position.x - point.x;
      const dz = e.position.z - point.z;
      if (dx * dx + dz * dz <= r2 + (e.radius ?? 0.4) ** 2) out.push(e);
    }
    return out;
  }

  nearestEnemy(point, maxDist = Infinity, exclude = []) {
    let best = null;
    let bestD = maxDist * maxDist;
    for (const e of this.enemies) {
      if (e.dead || exclude.includes(e)) continue;
      const dx = e.position.x - point.x;
      const dz = e.position.z - point.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD) { bestD = d2; best = e; }
    }
    return best;
  }

  nearestEnemyInDirection(origin, dir, maxDist = 18, maxAngle = Math.PI) {
    let best = null;
    let bestScore = Infinity;
    const cosLimit = Math.cos(maxAngle);
    for (const e of this.enemies) {
      if (e.dead) continue;
      const dx = e.position.x - origin.x;
      const dz = e.position.z - origin.z;
      const dist = Math.hypot(dx, dz);
      if (dist > maxDist || dist < 0.01) continue;
      const dot = (dx * dir.x + dz * dir.z) / dist;
      if (dot < cosLimit) continue;
      const score = dist * (1.4 - dot);
      if (score < bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  aliveEnemiesInRoom(roomIndex) {
    return this.enemies.filter((e) => !e.dead && e.roomIndex === roomIndex);
  }

  roomIndexAt(position) {
    return this.dungeon?.getRoomAt?.(position)?.index ?? this.currentRoom;
  }

  getManaRegen() {
    return this.stats?.manaRegen ?? PLAYER.manaRegen;
  }

  addXp(amount) {
    if (!this.player || amount <= 0) return;
    const levels = this.player.gainXp(amount);
    if (levels > 0) {
      this._computeStats();
      // Stats apply immediately; celebration is deferred ~150ms so its fullscreen
      // flash never lands on a heavy combat frame (boss death levels you up on the
      // spot, and that blend cost ~65ms on weak machines).
      this.audio?.play?.('level_up', { volume: 1 });
      this._celebrate(() => {
        this.flashScreen('#f4d79a', 0.28);
        this.vfx?.runeCircle?.(this.player.position, {
          color: 0xffc56a, radius: 2.2, life: 1.6, duration: 1.6,
        });
        this.ui?.showBanner?.(`LEVEL ${this.player.level}`, 'A new skill point awaits', 'gold', 2.2);
        this.ui?.refreshSkillTree?.();
      });
    }
    this.ui?.setSkillPoints?.(this.player.skillPoints);
  }

  onEnemyKilled(enemy) {
    if (!enemy || enemy._killHandled) return;
    enemy._killHandled = true;
    this.kills++;
    this.addXp(enemy.xp ?? 10);
    this.audio?.play?.('enemy_death', { volume: 0.5, rate: 0.9 + Math.random() * 0.2 });
    const pos = enemy.position.clone();
    this.vfx?.burst?.(this._tmp.set(pos.x, 1.1, pos.z), {
      count: enemy.isBoss ? 50 : 16, color: enemy.def?.accent ?? 0xff6b2b,
      size: enemy.isBoss ? 0.3 : 0.12, speed: enemy.isBoss ? 9 : 4, life: 0.8, gravity: 2,
    });
    if (enemy.elite) this.vfx?.runeCircle?.(pos, { color: enemy.elite.color ?? 0xff6b2b, radius: 1.5, life: 0.7, duration: 0.7 });
    if (this.boss === enemy) {
      this.boss = null;
      this.ui?.setBoss?.(null);
      this.ui?.showBanner?.('THE WARDEN FALLS', 'The seal breaks. The rift awakens.', 'gold', 3.2);
      this.audio?.play?.('boss_roar', { volume: 0.7, rate: 0.7 });
      this.screenShake(0.7, 0.9);
      // The Warden's summons die with their master so the exit cannot be
      // gated behind a stray archer hiding in a corner.
      const room = enemy.roomIndex;
      for (const e of this.enemies) {
        if (e === enemy || e.dead || e.dying || e.roomIndex !== room) continue;
        e.takeDamage(e.hp + 1, { element: 'fire', source: 'boss_death' });
      }
    }
    if (enemy.roomIndex === this.dungeon?.rooms?.length - 1) {
      this._bossDefeated = true;
    }
    const stats = this.stats;
    if (stats.deathExplosion > 0) {
      const victims = this.enemiesInRadius(pos, 2.6);
      for (const v of victims) {
        this.dealDamage(v, stats.deathExplosion, {
          element: 'fire', source: 'explosion', canCrit: false,
          status: { type: 'burn', duration: 3, dps: 4 },
        });
      }
      if (victims.length) this.vfx?.explosion?.(pos, { radius: 2.6, color: 0xff5a22, scale: 0.8 });
    }
    if ((enemy.isChilled || enemy.hasStatus?.('chill')) && stats.shatterBurst > 0) {
      const victims = this.enemiesInRadius(pos, 2.4);
      for (const v of victims) {
        this.dealDamage(v, stats.shatterBurst, { element: 'frost', source: 'explosion', canCrit: false });
      }
      this.vfx?.frostBurst?.(pos, { radius: 2.4, spikeScale: 0.8 });
    }
    if (stats.manaOnKill > 0) this.player.restoreMana(this.player.maxMana * stats.manaOnKill);
    this._dropLoot(enemy);
    this.ui?.refreshSkillTree?.();
  }

  _dropLoot(enemy) {
    const pos = enemy.position;
    const roll = Math.random();
    const drops = [];
    if (enemy.isBoss) {
      drops.push(['health', 35], ['health', 35], ['mana', 40], ['gold', 25], ['soul', 30]);
    } else {
      if (enemy.elite) drops.push(['health', 30], ['gold', 5]);
      if (roll < 0.22) drops.push(['health', 22]);
      else if (roll < 0.36) drops.push(['mana', 26]);
      else if (roll < 0.58) drops.push(['gold', 1 + Math.floor(Math.random() * 3)]);
      else if (roll > 0.94) drops.push(['soul', 12]);
    }
    for (const [kind, value] of drops) {
      const a = Math.random() * Math.PI * 2;
      const r = enemy.isBoss ? 1.2 + Math.random() * 2.2 : 0.4 + Math.random() * 0.8;
      const x = pos.x + Math.cos(a) * r;
      const z = pos.z + Math.sin(a) * r;
      if (this.dungeon?.isWalkable?.(x, z, 0.3)) this.spawnPickup(kind, new THREE.Vector3(x, 0, z), value);
    }

    const gearChance = enemy.elite ? 0.5 : 0.09 + this.depth * 0.012;
    const gearRolls = enemy.isBoss ? 3 : Math.random() < gearChance ? 1 : 0;
    for (let i = 0; i < gearRolls; i++) {
      const bias = enemy.isBoss ? 3.4 - i * 0.5 : enemy.elite ? 1.7 : 1;
      const item = rollLootItem({
        depth: this.depth,
        bias,
        minRarity: enemy.isBoss ? 'rare' : enemy.elite ? 'magic' : null,
      });
      const a = Math.random() * Math.PI * 2;
      const r = enemy.isBoss ? 1.4 + Math.random() * 2.2 : 0.6 + Math.random() * 0.9;
      const x = pos.x + Math.cos(a) * r;
      const z = pos.z + Math.sin(a) * r;
      if (this.dungeon?.isWalkable?.(x, z, 0.3)) {
        this.spawnGear(item, new THREE.Vector3(x, 0, z));
      } else {
        this.spawnGear(item, pos.clone().add(new THREE.Vector3(0.5, 0, 0.5)));
      }
    }
  }

  spawnEnemy(defId, position, roomIndex, opts = {}) {
    const elite = opts.elite ?? (defId !== 'boss' && Math.random() < Math.min(0.28, 0.12 + this.depth * 0.018)
      ? ELITE_MODS[Math.floor(Math.random() * ELITE_MODS.length)] : null);
    const e = new Enemy(this.scene, this, defId, position.clone(), roomIndex, {
      elite,
      scaleHp: opts.scaleHp ?? DEPTH_SCALE.hp(this.depth),
      scaleDamage: opts.scaleDamage ?? DEPTH_SCALE.damage(this.depth),
      scaleXp: opts.scaleXp ?? DEPTH_SCALE.xp(this.depth),
      boss: defId === 'boss' || opts.boss,
    });
    this.enemies.push(e);
    if (e.isBoss) {
      this.boss = e;
      this.ui?.setBoss?.(e);
      this.audio?.play?.('boss_roar', { volume: 1 });
      this.ui?.showBanner?.(e.name.toUpperCase(), 'Keeper of the Ashen Seal', 'ember', 3);
      this.screenShake(0.5, 0.7);
    }
    this.vfx?.runeCircle?.(position, {
      color: e.isBoss ? 0xff5a22 : (elite?.color ?? 0x9a8f7c),
      radius: e.isBoss ? 3.2 : 1.2, life: 0.9, duration: 0.9,
    });
    this.vfx?.burst?.(position, {
      count: e.isBoss ? 40 : 10, color: e.isBoss ? 0xff5a22 : 0xbfae94,
      size: 0.14, speed: e.isBoss ? 7 : 3, life: 0.8, gravity: 1.5,
    });
    return e;
  }

  // ------------------------------------------------------------ rooms & world
  _spawnRoom(room) {
    if (room.type === 'entry' || room.spawned) return;
    room.spawned = true;
    const p = this.player.position;
    if (room.type === 'boss') {
      const bossPos = room.center.clone();
      this.spawnEnemy('boss', bossPos, room.index, { boss: true });
      const adds = this.depth >= 2 ? 3 : 2;
      for (let i = 0; i < adds; i++) {
        const sp = room.spawnPoints[i % room.spawnPoints.length] ?? room.center;
        this.spawnEnemy(i % 2 === 0 ? 'skeleton' : 'archer', sp, room.index);
      }
      return;
    }
    const pack = ROOM_PACKS[(room.index + this.depth * 2) % ROOM_PACKS.length];
    const extra = Math.min(3, Math.floor((this.depth - 1) / 2));
    const ids = [...pack];
    for (let i = 0; i < extra; i++) ids.push(i % 2 ? 'skeleton' : 'archer');
    const points = room.spawnPoints.length ? room.spawnPoints : [room.center];
    for (let i = 0; i < ids.length; i++) {
      let pos = points[i % points.length].clone();
      const angle = Math.random() * Math.PI * 2;
      const r = 0.4 + Math.random() * 1.1;
      pos.x += Math.cos(angle) * r;
      pos.z += Math.sin(angle) * r;
      if (!this.dungeon.isWalkable(pos.x, pos.z, 0.55)) {
        pos = room.center.clone();
      }
      if (pos.distanceTo(p) < 4.2) {
        pos = room.center.clone().add(new THREE.Vector3(
          (Math.random() - 0.5) * room.size.x * 0.35, 0,
          (Math.random() - 0.5) * room.size.z * 0.35,
        ));
      }
      this.spawnEnemy(ids[i], pos, room.index);
    }
    this.ui?.showBanner?.(room.name ?? 'THE DARK STIRS', 'The chamber awakens', 'ember', 1.8);
    this.audio?.play?.('boss_roar', { volume: 0.18, rate: 1.9, pan: 0 });
  }

  _updateRooms(dt) {
    const room = this.dungeon.getRoomAt(this.player.position);
    if (room && room.index !== this.currentRoom) {
      this.currentRoom = room.index;
      if (!room.activated) {
        room.activated = true;
        this._spawnRoom(room);
      }
    }
    for (const r of this.dungeon.rooms) {
      if (!r.activated || r.cleared || !r.spawned) continue;
      if (this.aliveEnemiesInRoom(r.index).length === 0) this._clearRoom(r);
    }
  }

  // Run a celebration callback when the VFX field has calmed down. Fullscreen
  // flashes layered on frames that still carry death effects stall weak machines
  // ~80ms (measured x4 CPU throttle), so we wait until live particles drop.
  _celebrate(fn) {
    const attempt = () => {
      if (this.state !== 'playing') return;
      const calm = (2500 - this.vfx._free.length) < 60;
      if (calm) { fn(); return; }
      setTimeout(attempt, 100);
    };
    setTimeout(attempt, 250);
  }

  _clearRoom(room) {
    if (room.cleared) return;
    room.cleared = true;
    const isBoss = room.type === 'boss';
    this.addXp(18 + this.depth * 9 + (isBoss ? 40 : 0));
    this.audio?.play?.('room_clear', { volume: 0.6 });
    const center = room.center.clone();
    if (isBoss) {
      this.dungeon.exitPortal?.setActive?.(true);
      this._portalArmed = true;
      this.spawnPickup('health', center.clone().add(new THREE.Vector3(-1.2, 0, 0)), 40);
      this.spawnPickup('mana', center.clone().add(new THREE.Vector3(1.2, 0, 0)), 45);
      // Defer flash/banner/shake: boss death + room clear land on the same frame,
      // and a fullscreen blend on top of that frame stalls weak machines ~70ms.
      this._celebrate(() => {
        this.ui?.showBanner?.('THE RIFT OPENS', 'Step into the ember gate', 'gold', 3.4);
        this.flashScreen('#c9a35a', 0.3);
        this.screenShake(0.35, 0.5);
      });
    } else {
      this.spawnPickup('health', center.clone().add(new THREE.Vector3(0.8, 0, 0.4)), 22 + this.depth * 2);
      this.spawnPickup('gold', center.clone().add(new THREE.Vector3(-0.8, 0, -0.3)), 3 + this.depth);
      this.ui?.showBanner?.('CHAMBER CLEARED', room.name ?? 'The dark recedes', 'gold', 1.8);
    }
  }

  _updatePassives(dt) {
    this._passiveTimer = (this._passiveTimer ?? 0) + dt;
    if (this._passiveTimer > 0.2) {
      this._passiveTimer = 0;
      this._computeStats();
    }
    const stats = this.stats;
    if (stats.auraDps > 0) {
      this._auraTimer = (this._auraTimer ?? 0) + dt;
      if (this._auraTimer >= 0.75) {
        this._auraTimer = 0;
        const near = this.enemiesInRadius(this.player.position, 3.5);
        for (const e of near) {
          this.dealDamage(e, stats.auraDps * 0.75, {
            element: 'fire', source: 'aura', canCrit: false, noNumber: true,
            status: { type: 'burn', duration: 1.2, dps: stats.auraDps * 0.4 },
          });
        }
        if (near.length) {
          this.vfx?.embers?.(this.player.position, { count: 5, color: 0xff7a2f, life: 0.8 });
        }
      }
    }
    if (!this.player.dead && this.player.hp <= 0) this.onPlayerDeath();
  }

  _updatePickups(dt) {
    const p = this.player.position;
    const radius = this.stats?.pickupRadius ?? PLAYER.pickupRadius;
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const pk = this.pickups[i];
      pk.ttl -= dt;
      pk.phase += dt;
      pk.group.position.y = 0.45 + Math.sin(pk.phase * 3.2) * 0.09;
      pk.group.rotation.y += dt * 1.7;
      if (pk.ttl < 4) pk.group.scale.setScalar(Math.max(0.05, pk.ttl / 4));
      if (pk.ttl <= 0) { this._removePickup(i); continue; }
      const dx = p.x - pk.group.position.x;
      const dz = p.z - pk.group.position.z;
      if (dx * dx + dz * dz > radius * radius) continue;
      let taken = false;
      if (pk.kind === 'gear') {
        if (this.inventory.length >= BAG_LIMIT) {
          if (!pk._bagWarned) {
            pk._bagWarned = true;
            this.ui?.showToast?.('Satchel full', 'common');
          }
        } else {
          taken = this.addGear(pk.item);
        }
      } else if (pk.kind === 'health') {
        if (this.player.hp < this.player.maxHp) { this.player.heal(pk.value); taken = true; this.ui?.showToast?.(`+${pk.value} life`, 'hp'); this.audio?.play?.('heal'); }
      } else if (pk.kind === 'mana') {
        if (this.player.mana < this.player.maxMana) { this.player.restoreMana(pk.value); taken = true; this.ui?.showToast?.(`+${pk.value} mana`, 'mana'); this.audio?.play?.('loot', { rate: 1.2 }); }
      } else if (pk.kind === 'gold') {
        const gain = Math.max(1, Math.round(pk.value * (1 + (this.stats?.goldFind ?? 0))));
        this.gold += gain; taken = true; this.audio?.play?.('loot', { rate: 1.35, volume: 0.45 });
      } else if (pk.kind === 'soul') {
        this.addXp(pk.value); taken = true; this.ui?.showToast?.(`+${pk.value} essence`, 'void'); this.audio?.play?.('loot', { rate: 0.9 });
      }
      if (taken) {
        this.vfx?.burst?.(pk.group.position, {
          count: 12, color: pk.color, size: 0.1, speed: 3, life: 0.5, gravity: 0.5,
        });
        this._removePickup(i);
      }
    }
  }

  spawnPickup(kind, position, value) {
    const colors = { health: 0xff3b4d, mana: 0x59c6ff, gold: 0xffc95e, soul: 0xc77dff };
    const color = colors[kind] ?? 0xffffff;
    if (!this._pickupGeo) {
      this._pickupGeo = {
        core: new THREE.IcosahedronGeometry(0.16, 1),
        halo: new THREE.SphereGeometry(0.29, 12, 8),
        ring: new THREE.TorusGeometry(0.32, 0.018, 6, 28),
      };
    }
    const group = new THREE.Group();
    group.position.copy(position);
    group.position.y = 0.45;
    const coreMat = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 2.4, roughness: 0.25, metalness: 0.2,
    });
    const core = new THREE.Mesh(this._pickupGeo.core, coreMat);
    core.castShadow = false;
    group.add(core);
    const haloMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false,
    });
    group.add(new THREE.Mesh(this._pickupGeo.halo, haloMat));
    const ringMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false,
    });
    const ring = new THREE.Mesh(this._pickupGeo.ring, ringMat);
    ring.rotation.x = Math.PI / 2;
    group.add(ring);
    this.scene.add(group);
    this.pickups.push({ kind, value, color, group, ttl: 32, phase: Math.random() * 6, dispose: () => {
      coreMat.dispose(); haloMat.dispose(); ringMat.dispose();
    } });
    this.vfx?.burst?.(group.position, { count: 6, color, size: 0.08, speed: 1.8, life: 0.4 });
  }

  _gearPickupGeo() {
    if (this._gearGeo) return this._gearGeo;
    this._gearGeo = {
      blade: new THREE.BoxGeometry(0.055, 0.62, 0.016),
      guard: new THREE.BoxGeometry(0.22, 0.035, 0.05),
      grip: new THREE.CylinderGeometry(0.018, 0.022, 0.16, 5),
      plate: new THREE.BoxGeometry(0.34, 0.34, 0.12),
      band: new THREE.TorusGeometry(0.13, 0.028, 5, 16),
      gem: new THREE.IcosahedronGeometry(0.07, 0),
      ring: new THREE.TorusGeometry(0.38, 0.02, 4, 24),
      beam: new THREE.CylinderGeometry(0.12, 0.34, 3.2, 8, 1, true),
    };
    return this._gearGeo;
  }

  spawnGear(item, position) {
    if (!item) return null;
    const rarity = GEAR_RARITY[item.rarity] ?? GEAR_RARITY.common;
    const color = rarity.color;
    const G = this._gearPickupGeo();
    const group = new THREE.Group();
    group.position.copy(position);
    group.position.y = 0.45;

    const itemMat = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 1.15, metalness: 0.75, roughness: 0.32,
    });
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0xd9b26a, emissive: 0x3a2410, emissiveIntensity: 0.35, metalness: 0.9, roughness: 0.3,
    });
    const beamMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, fog: false,
    });

    const meshGroup = new THREE.Group();
    if (item.slot === 'weapon') {
      const grip = new THREE.Mesh(G.grip, trimMat);
      grip.position.y = -0.27;
      meshGroup.add(grip);
      const guard = new THREE.Mesh(G.guard, trimMat);
      guard.position.y = -0.08;
      meshGroup.add(guard);
      const blade = new THREE.Mesh(G.blade, itemMat);
      blade.position.y = 0.23;
      meshGroup.add(blade);
      meshGroup.rotation.z = 0.45;
    } else if (item.slot === 'armor') {
      const plate = new THREE.Mesh(G.plate, itemMat);
      meshGroup.add(plate);
      const trim = new THREE.Mesh(G.guard, trimMat);
      trim.position.set(0, 0.15, 0.075);
      trim.scale.set(1.4, 1, 1);
      meshGroup.add(trim);
      meshGroup.rotation.y = 0.5;
    } else {
      const band = new THREE.Mesh(G.band, itemMat);
      band.rotation.x = Math.PI / 2;
      meshGroup.add(band);
      const gem = new THREE.Mesh(G.gem, trimMat);
      gem.position.y = 0.18;
      meshGroup.add(gem);
      meshGroup.rotation.x = 0.3;
    }
    meshGroup.position.y = 0.14;
    group.add(meshGroup);

    const beam = new THREE.Mesh(G.beam, beamMat);
    beam.position.y = 1.1;
    group.add(beam);
    const ringMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false,
    });
    const ring = new THREE.Mesh(G.ring, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -0.42;
    group.add(ring);

    this.scene.add(group);
    this.pickups.push({
      kind: 'gear', item, color, group, ttl: 90, phase: Math.random() * 6,
      dispose: () => { itemMat.dispose(); trimMat.dispose(); beamMat.dispose(); ringMat.dispose(); },
    });
    this.vfx?.burst?.(group.position, { count: 10, color, size: 0.09, speed: 2.2, life: 0.6 });
    return group;
  }

  _removePickup(i) {
    const pk = this.pickups[i];
    this.scene.remove(pk.group);
    pk.dispose?.();
    this.pickups.splice(i, 1);
  }

  _updatePortal(dt) {
    const portal = this.dungeon?.exitPortal;
    if (!portal?.active || !this._portalArmed || this.state !== 'playing') return;
    const dx = this.player.position.x - portal.position.x;
    const dz = this.player.position.z - portal.position.z;
    if (dx * dx + dz * dz < 2.3 * 2.3) {
      this._portalArmed = false;
      this.nextDepth();
    }
  }

  nextDepth() {
    if (this.state !== 'playing') return;
    this.state = 'transition';
    this.input.enabled = false;
    this.transitionTimer = 1.15;
    this._pendingDepth = this.depth + 1;
    this.player.invulnerable = 1.15;
    this.audio?.play?.('portal', { volume: 1 });
    this.flashScreen('#e7c47a', 0.55);
    this.screenShake(0.3, 0.5);
    this.vfx?.runeCircle?.(this.dungeon.exitPortal.position, {
      color: 0xffc56a, radius: 4, life: 1.2, duration: 1.2,
    });
    this.ui?.showBanner?.(`DESCENDING TO DEPTH ${ROMAN[this.depth + 1] ?? this.depth + 1}`, 'The dark grows deeper', 'gold', 1.4);
  }

  onPlayerDeath() {
    if (this.state === 'dead' || this.state === 'menu') return;
    this.state = 'dead';
    this.overlay = null;
    this.input.enabled = false;
    this.audio?.play?.('death', { volume: 1 });
    this.audio?.stopAmbience?.();
    this.ui?.setBoss?.(null);
    this.vfx?.explosion?.(this.player.position, { radius: 2.5, color: 0xff3b2b, scale: 1.2 });
    this.screenShake(0.8, 0.9);
    this.ui?.showGameOver?.(
      { depth: this.depth, level: this.player.level, kills: this.kills, gold: this.gold, time: this.runTime },
      () => this.revive(),
      () => this.newRun(),
    );
  }

  revive() {
    this.ui?.hideGameOver?.();
    this.ui?.showHUD?.();
    this.audio?.startAmbience?.();
    const p = this.player;
    p.dead = false;
    p.hp = p.maxHp;
    p.mana = p.maxMana;
    p.shield = 0;
    p.invulnerable = 2.2;
    this.state = 'playing';
    this.input.enabled = true;
    this._startDepth(this.depth, { advance: false });
    p.hp = p.maxHp;
    p.mana = p.maxMana;
    this.ui?.showBanner?.('RISE AGAIN', 'The ember refuses to die', 'ember', 2.6);
  }

  newRun() {
    this.ui?.hideGameOver?.();
    this.ui?.showHUD?.();
    this.audio?.startAmbience?.();
    this._resetRun();
    this.state = 'playing';
    this.input.enabled = true;
    this._startDepth(1, { fresh: true });
  }

  hitstop(seconds) {
    this.hitstopTimer = Math.max(this.hitstopTimer, seconds);
  }

  screenShake(amount, duration = 0.3) {
    this.shake = Math.max(this.shake, amount);
    this.shakeDecay = Math.max(4, 1 / Math.max(0.06, duration));
  }

  flashScreen(color, strength = 0.35) {
    const css = typeof color === 'number' ? `#${color.toString(16).padStart(6, '0')}` : color;
    // WebGL-side flash: the DOM overlay version forced a full-canvas compositor
    // blend per visible frame (~80ms stall on weak machines during boss death).
    this.vfx?.screenFlash?.(new THREE.Color(css).getHex(), strength);
  }

  notify(text, tone = 'gold') {
    this.ui?.showToast?.(text, tone);
  }
}
