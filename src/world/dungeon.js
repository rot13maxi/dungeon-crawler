// src/world/dungeon.js
// DungeonWorld module: procedural 46x46 dungeon — 5-7 connected rooms,
// 3-wide corridors, merged static geometry, instanced decoration, animated
// braziers/torches with flickering point lights, dust motes, embers, fog,
// rune circles, boss seal and a dormant exit portal.
// Exports class Dungeon per the EMBERFALL module contract.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { WORLD } from '../config.js';
import {
  createStoneFloorTextures,
  createWallStoneTextures,
  createMetalTextures,
  createRugTextures,
  createRuneTexture,
  createGlyphStripTexture,
  createGlowSpriteTexture,
  mulberry32,
} from './textures.js';

const CELL = WORLD.cell; // 2.5
const GRID_W = WORLD.gridW; // 46
const GRID_H = WORLD.gridH; // 46
const WALL_H = WORLD.wallHeight; // 3.2

const ORIGIN_X = (CELL * GRID_W) / 2; // 57.5
const ORIGIN_Z = (CELL * GRID_H) / 2;

const MORTAR = 0.11; // wall slab half-thickness (m)
const TRIM_H = 0.5; // metal skirt height on wall bases (m)
const TILE_W = CELL * 2; // floor texture world tile (m)
const WALL_TILE = CELL * 2.4; // wall texture world tile (m)
const FLOOR_THICK = 0.55;

const X = (c) => c * CELL - ORIGIN_X; // grid col -> world x (cell center)
const Z = (r) => r * CELL - ORIGIN_Z; // grid row -> world z (cell center)

function odd(n) { return n % 2 === 1 ? n : n + 1; }
function even(n) { return n % 2 === 0 ? n : n + 1; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

class Dungeon {
  constructor(scene, { depth = 1 } = {}) {
    this.scene = scene;
    this.depth = depth;

    this.group = new THREE.Group();
    this.group.name = 'dungeon';
    this._tracked = { textures: new Set(), materials: new Set(), geometries: new Set() };

    this.grid = [];
    this.gridW = GRID_W;
    this.gridH = GRID_H;
    this.cell = CELL;
    this.rooms = [];
    this.corridors = [];
    this.torches = [];

    this._flames = [];
    this._flameLights = [];
    this._runeCircles = [];
    this._portal = null;
    this._disposed = false;

    this._seed = 1337 + depth * 9176;
    this._rng = mulberry32(this._seed);
    this._dummy = new THREE.Object3D();
    this._pillarCells = [];
    this._emberSources = [];
    this._postCells = new Set();

    this._generate();
    this._buildTextures();
    this._buildMaterials();
    this._buildFloors();
    this._buildRoof();
    this._buildWalls();
    this._buildTrim();
    this._buildLights();
    this._decorate();
    this._buildExitPortal();
    this._buildDust();
    this._buildEmbers();

    // Low ambient + cold moonlight with shadows (the only shadow caster).
    this._hemi = new THREE.HemisphereLight(0x3a4152, 0x17120c, 0.3);
    this._ambient = new THREE.AmbientLight(0x191c26, 0.3);
    this._moon = new THREE.DirectionalLight(0x8fa3d9, 0.4);
    this._moon.position.set(26, 40, -16);
    this._moon.target.position.set(0, 0, 0);
    this._moon.castShadow = true;
    this._moon.shadow.mapSize.set(2048, 2048);
    this._moon.shadow.camera.left = -64;
    this._moon.shadow.camera.right = 64;
    this._moon.shadow.camera.top = 64;
    this._moon.shadow.camera.bottom = -64;
    this._moon.shadow.camera.near = 5;
    this._moon.shadow.camera.far = 130;
    this._moon.shadow.bias = -0.0008;
    this._moon.shadow.normalBias = 0.02;
    this.group.add(this._hemi, this._ambient, this._moon, this._moon.target);

    // Fog (save previous so dispose can restore).
    this._prevFog = scene.fog || null;
    scene.fog = new THREE.FogExp2(0x07070d, clamp(0.02 + (depth - 1) * 0.0015, 0.02, 0.035));

    scene.add(this.group);
  }

  // ------------------------------------------------------------ generation
  _generate() {
    const rng = this._rng;
    this.grid = [];
    for (let r = 0; r < GRID_H; r++) this.grid.push(new Uint8Array(GRID_W));

    // Five fixed rectangular footprints (odd-aligned carving lattice),
    // non-overlapping by construction; corridors provide connectivity.
    const footprints = [
      { c0: 5, r0: 33, w: 9, h: 9 },    // entry (southwest)
      { c0: 19, r0: 36, w: 11, h: 9 },  // combat (south)
      { c0: 31, r0: 22, w: 11, h: 11 }, // combat (southeast)
      { c0: 17, r0: 21, w: 11, h: 9 },  // combat (center)
      { c0: 15, r0: 5, w: 13, h: 13 },  // boss (north)
    ];
    // 0-2 extra rooms in empty pockets depending on depth.
    const extraSpots = [
      { c0: 3, r0: 15, w: 9, h: 11 },
      { c0: 33, r0: 7, w: 10, h: 10 },
    ];
    const extra = this.depth % 3;
    for (let i = 0; i < extra && i < extraSpots.length; i++) {
      const s = extraSpots[i];
      let ok = true;
      for (const f of footprints) {
        if (s.c0 < f.c0 + f.w + 1 && s.c0 + s.w + 1 > f.c0 &&
            s.r0 < f.r0 + f.h + 1 && s.r0 + s.h + 1 > f.r0) ok = false;
      }
      if (ok) footprints.splice(footprints.length - 1, 0, s);
    }

    footprints.forEach((f, i) => {
      const last = i === footprints.length - 1;
      const first = i === 0;
      this._stampRoom(f, i, first ? 'entry' : last ? 'boss' : 'combat');
    });

    // Connected chain through room centers + 0-2 cheap loop corridors.
    for (let i = 1; i < this.rooms.length; i++) {
      this._connectRooms(this.rooms[i - 1], this.rooms[i]);
      if (i < this.rooms.length - 1 && rng() < 0.5) {
        const back = this.rooms[Math.floor(rng() * i)];
        const dist = Math.abs(this.rooms[i]._cc - back._cc) + Math.abs(this.rooms[i]._cr - back._cr);
        if (dist < 26) this._connectRooms(this.rooms[i], back);
      }
    }

    this._placePillars();
    this._markStructureCells();

    this.playerSpawn = this.rooms[0].center.clone();
    this.playerSpawn.x += 0.6;
    this.playerSpawn.z += 0.4; // slight offset per contract
    this.playerSpawn.y = 0;
  }

  _carveH(row, c0, c1) {
    const a = Math.min(c0, c1);
    const b = Math.max(c0, c1);
    for (let c = a; c <= b; c++) {
      for (let r = row - 1; r <= row + 1; r++) this._carveCell(c, r);
    }
    this.corridors.push({ c0: a, c1: b, r0: row - 1, r1: row + 1 });
  }

  _carveV(col, r0, r1) {
    const a = Math.min(r0, r1);
    const b = Math.max(r0, r1);
    for (let r = a; r <= b; r++) {
      for (let c = col - 1; c <= col + 1; c++) this._carveCell(c, r);
    }
    this.corridors.push({ c0: col - 1, c1: col + 1, r0: a, r1: b });
  }

  _carveCell(c, r) {
    if (c > 0 && c < GRID_W - 1 && r > 0 && r < GRID_H - 1) this.grid[r][c] = 1;
  }

  // L-shaped corridor from room a to room b, entering b through a clean
  // 3-wide opening in the wall facing a.
  _connectRooms(a, b) {
    const dc = b._cc - a._cc;
    const dr = b._cr - a._cr;
    if (Math.abs(dc) >= Math.abs(dr)) {
      const entryCol = dc >= 0 ? b._cols[0] - 1 : b._cols[1] + 1;
      this._carveH(a._cr, a._cc, entryCol);
      this._carveV(entryCol, a._cr, b._cr);
    } else {
      const entryRow = dr >= 0 ? b._rows[0] - 1 : b._rows[1] + 1;
      this._carveV(a._cc, a._cr, entryRow);
      this._carveH(entryRow, a._cc, b._cc);
    }
  }

  _stampRoom(f, index, type) {
    const c0 = odd(f.c0);
    const r0 = odd(f.r0);
    const c1 = even(f.c0 + f.w - 1);
    const r1 = even(f.r0 + f.h - 1);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (c > 0 && c < GRID_W - 1 && r > 0 && r < GRID_H - 1) this.grid[r][c] = 1;
      }
    }
    const minX = X(c0) - CELL / 2;
    const maxX = X(c1) + CELL / 2;
    const minZ = Z(r0) - CELL / 2;
    const maxZ = Z(r1) + CELL / 2;
    const center = new THREE.Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
    const cc = Math.floor((c0 + c1) / 2);
    const cr = Math.floor((r0 + r1) / 2);
    const names = ['Ashen Barracks', 'Sunken Reliquary', 'Hall of Chains', 'Cracked Sanctum', 'Ember Gallery'];
    const room = {
      index,
      type,
      name: type === 'entry' ? 'Threshold of Ash' : type === 'boss' ? "The Warden's Vault" : names[(index - 1) % names.length],
      center,
      size: { x: maxX - minX, z: maxZ - minZ },
      bounds: { minX, maxX, minZ, maxZ },
      spawnPoints: [],
      cleared: false,
      activated: false,
      _cols: [c0, c1],
      _rows: [r0, r1],
      _cc: cc,
      _cr: cr,
    };
    // Spawn points: interior cells away from corner pockets, pillar cells
    // and the boss portal dais.
    const pool = [];
    for (let r = r0 + 1; r <= r1 - 1; r++) {
      for (let c = c0 + 1; c <= c1 - 1; c++) {
        if ((c <= c0 + 1 || c >= c1 - 1) && (r <= r0 + 1 || r >= r1 - 1)) continue; // corner pockets
        if (Math.abs(c - cc) === 3 && Math.abs(r - cr) === 3) continue; // pillar cells
        if (type === 'boss' && r <= r0 + 3) continue; // portal dais zone
        pool.push([c, r]);
      }
    }
    const rng = this._rng;
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    const count = Math.min(9, Math.max(6, Math.floor(pool.length / 6)));
    for (let i = 0; i < count && i < pool.length; i++) {
      const [c, r] = pool[i];
      room.spawnPoints.push(new THREE.Vector3(X(c), 0, Z(r)));
    }
    this.rooms.push(room);
  }

  // Pillars at symmetric interior cells of combat/boss rooms; their cells
  // become solid so collision matches visuals.
  _placePillars() {
    for (const room of this.rooms) {
      if (room.type === 'entry') continue;
      const [c0, c1] = room._cols;
      const [r0, r1] = room._rows;
      for (const [c, r] of [
        [room._cc - 3, room._cr - 3], [room._cc + 3, room._cr - 3],
        [room._cc - 3, room._cr + 3], [room._cc + 3, room._cr + 3],
      ]) {
        if (c < c0 + 2 || c > c1 - 2 || r < r0 + 2 || r > r1 - 2) continue;
        if (!this.grid[r][c]) continue;
        let blocked = false;
        for (const band of this.corridors) {
          if (c >= band.c0 - 1 && c <= band.c1 + 1 && r >= band.r0 - 1 && r <= band.r1 + 1) { blocked = true; break; }
        }
        if (blocked) continue;
        this.grid[r][c] = 0;
        this._pillarCells.push({ c, r });
      }
    }
  }

  // The exit gate stands on a low dais in the boss room. The dais cells stay
  // walkable: sealing them built a walled box around the gate, which made the
  // exit unreachable.
  _markStructureCells() {
    const boss = this.rooms[this.rooms.length - 1];
    this._portalCell = { c: boss._cc, r: boss._rows[0] + 2 };
  }

  // -------------------------------------------------------------- textures
  _buildTextures() {
    const aniso = 8;
    const t = {
      floor: createStoneFloorTextures({ seed: 1000 + this.depth * 37, anisotropy: aniso }),
      wall: createWallStoneTextures({ seed: 2000 + this.depth * 41, anisotropy: aniso }),
      metal: createMetalTextures({ seed: 3000 + this.depth * 43, anisotropy: aniso }),
      rug: createRugTextures({ seed: 4000 + this.depth * 47, anisotropy: aniso }),
      rune: createRuneTexture({ seed: 5000 + this.depth * 53 }),
      glyphs: createGlyphStripTexture({ seed: 6000 + this.depth * 59 }),
      glow: createGlowSpriteTexture(),
    };
    this._textures = t;
    for (const key of Object.keys(t)) {
      const set = t[key];
      if (set.map) {
        this._trackTex(set.map); this._trackTex(set.bumpMap); this._trackTex(set.roughnessMap);
      } else {
        this._trackTex(set);
      }
    }
    // UVs carry world-scaled repeats; keep texture-level repeat at 1.
    t.floor.map.repeat.set(1, 1);
    t.floor.bumpMap.repeat.set(1, 1);
    t.floor.roughnessMap.repeat.set(1, 1);
    t.wall.map.repeat.set(1, 1);
    t.wall.bumpMap.repeat.set(1, 1);
    t.wall.roughnessMap.repeat.set(1, 1);
  }

  _trackTex(t) { if (t && t.isTexture) this._tracked.textures.add(t); }
  _trackMat(m) { this._tracked.materials.add(m); return m; }
  _trackGeo(g) { this._tracked.geometries.add(g); return g; }

  // -------------------------------------------------------------- materials
  _buildMaterials() {
    const T = this._textures;
    this._materials = {
      floor: this._trackMat(new THREE.MeshStandardMaterial({
        map: T.floor.map, bumpMap: T.floor.bumpMap, bumpScale: 0.35,
        roughnessMap: T.floor.roughnessMap, roughness: 1.0, metalness: 0.04,
        color: 0x9a9a92, vertexColors: true,
      })),
      floorDark: this._trackMat(new THREE.MeshStandardMaterial({
        map: T.floor.map, bumpMap: T.floor.bumpMap, bumpScale: 0.3,
        roughnessMap: T.floor.roughnessMap, roughness: 1.0, metalness: 0.04,
        color: 0x62626b, vertexColors: true,
      })),
      wall: this._trackMat(new THREE.MeshStandardMaterial({
        map: T.wall.map, bumpMap: T.wall.bumpMap, bumpScale: 0.5,
        roughnessMap: T.wall.roughnessMap, roughness: 1.0, metalness: 0.02,
        color: 0xb2b2ae,
      })),
      roof: this._trackMat(new THREE.MeshStandardMaterial({
        map: T.wall.map, bumpMap: T.wall.bumpMap, bumpScale: 0.4,
        roughnessMap: T.wall.roughnessMap, roughness: 1.0, metalness: 0.02,
        color: 0x4c4c4a,
      })),
      metal: this._trackMat(new THREE.MeshStandardMaterial({
        map: T.metal.map, bumpMap: T.metal.bumpMap, bumpScale: 0.35,
        roughnessMap: T.metal.roughnessMap, roughness: 1.0, metalness: 0.82,
        color: 0x8f97a2,
      })),
      metalDark: this._trackMat(new THREE.MeshStandardMaterial({
        map: T.metal.map, bumpMap: T.metal.bumpMap, bumpScale: 0.3,
        roughnessMap: T.metal.roughnessMap, roughness: 1.0, metalness: 0.82,
        color: 0x565b64,
      })),
      rug: this._trackMat(new THREE.MeshStandardMaterial({
        map: T.rug.map, bumpMap: T.rug.bumpMap, bumpScale: 0.25,
        roughness: 0.94, metalness: 0.0,
      })),
      bone: this._trackMat(new THREE.MeshStandardMaterial({ color: 0xd8cfb8, roughness: 0.85 })),
      wood: this._trackMat(new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 0.9 })),
      coal: this._trackMat(new THREE.MeshBasicMaterial({ color: 0xff8a3d })),
      chain: this._trackMat(new THREE.MeshStandardMaterial({ color: 0x33363c, roughness: 0.6, metalness: 0.85 })),
      flameInner: this._trackMat(new THREE.MeshBasicMaterial({
        color: 0xffd9a0, transparent: true, opacity: 0.92,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })),
      flameOuter: this._trackMat(new THREE.MeshBasicMaterial({
        color: 0xff7a2b, transparent: true, opacity: 0.42,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      })),
    };
    this._runeMat = this._trackMat(new THREE.MeshBasicMaterial({
      map: T.rune, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, opacity: 0.14,
    }));
    this._runeMatDim = this._trackMat(new THREE.MeshBasicMaterial({
      map: T.rune, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, opacity: 0.05,
    }));
    this._glyphMat = this._trackMat(new THREE.MeshBasicMaterial({
      map: T.glyphs, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide, opacity: 0.35,
    }));
    this._glowSpriteMat = this._trackMat(new THREE.SpriteMaterial({
      map: T.glow, color: 0xffa04a, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.85,
    }));
  }

  // Box with per-face UVs scaled to world tile size + world offset so merged
  // boxes tile continuously. Optional flat vertex-color tint.
  _boxGeo(sx, sy, sz, x, y, z, tile, u0 = 0, v0 = 0, tint = null) {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    const uv = g.attributes.uv;
    const scales = [
      [sz / tile, sy / tile], // +x
      [sz / tile, sy / tile], // -x
      [sx / tile, sz / tile], // +y
      [sx / tile, sz / tile], // -y
      [sx / tile, sy / tile], // +z
      [sx / tile, sy / tile], // -z
    ];
    for (let f = 0; f < 6; f++) {
      const us = scales[f][0];
      const vs = scales[f][1];
      for (let i = 0; i < 4; i++) {
        const idx = f * 4 + i;
        uv.setXY(idx, uv.getX(idx) * us + u0, uv.getY(idx) * vs + v0);
      }
    }
    if (tint) {
      const colors = new Float32Array(24 * 3);
      for (let i = 0; i < 24; i++) {
        colors[i * 3] = tint[0]; colors[i * 3 + 1] = tint[1]; colors[i * 3 + 2] = tint[2];
      }
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
    g.translate(x, y, z);
    return g;
  }

  // ---------------------------------------------------------------- floors
  _buildFloors() {
    const geos = [];
    const geosDark = [];
    const rng = mulberry32(this._seed ^ 0x5157);
    for (let r = 1; r < GRID_H - 1; r++) {
      for (let c = 1; c < GRID_W - 1; c++) {
        if (!this.grid[r][c]) continue;
        const x0 = X(c) - CELL / 2;
        const z0 = Z(r) - CELL / 2;
        const shade = 0.86 + rng() * 0.26;
        const warm = rng() * 0.08;
        const tint = [shade * (1 + warm), shade, shade * (1 - warm * 0.6)];
        const geo = this._boxGeo(CELL, FLOOR_THICK, CELL, X(c), -FLOOR_THICK / 2, Z(r), TILE_W, x0 / TILE_W, z0 / TILE_W, tint);
        (this._isCorridorCell(c, r) ? geosDark : geos).push(geo);
      }
    }
    const merged = mergeGeometries(geos, false);
    const mergedDark = mergeGeometries(geosDark, false);
    this._trackGeo(merged);
    this._trackGeo(mergedDark);
    const floor = new THREE.Mesh(merged, this._materials.floor);
    floor.receiveShadow = true;
    const floorDark = new THREE.Mesh(mergedDark, this._materials.floorDark);
    floorDark.receiveShadow = true;
    this.group.add(floor, floorDark);

    // Rubble + gravel scattered in rooms (kept clear of seal/portal).
    const rubbleGeos = [];
    const gravelGeos = [];
    const boss = this.rooms[this.rooms.length - 1];
    for (const room of this.rooms) {
      const n = Math.floor(room.size.x * room.size.z * 0.012);
      for (let i = 0; i < n; i++) {
        const x = room.bounds.minX + 0.8 + rng() * (room.size.x - 1.6);
        const z = room.bounds.minZ + 0.8 + rng() * (room.size.z - 1.6);
        if (!this.isWalkable(x, z, 0.9)) continue;
        if (room === boss && Math.hypot(x - boss.center.x, z - boss.center.z) < 5.5) continue;
        const s = 0.05 + rng() * 0.16;
        const g = new THREE.DodecahedronGeometry(s, 0);
        g.scale(1, 0.55 + rng() * 0.5, 1);
        g.rotateY(rng() * Math.PI * 2);
        g.translate(x, s * 0.22, z);
        rubbleGeos.push(g);
        for (let k = 0; k < 4; k++) {
          const gs = 0.03 + rng() * 0.06;
          const gg = new THREE.DodecahedronGeometry(gs, 0);
          gg.translate(x + (rng() - 0.5) * 1.6, gs * 0.5, z + (rng() - 0.5) * 1.6);
          gravelGeos.push(gg);
        }
      }
    }
    if (rubbleGeos.length) {
      const rubble = mergeGeometries(rubbleGeos, false);
      this._trackGeo(rubble);
      const mesh = new THREE.Mesh(rubble, this._materials.wall);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
    if (gravelGeos.length) {
      const gravel = mergeGeometries(gravelGeos, false);
      this._trackGeo(gravel);
      const mesh = new THREE.Mesh(gravel, this._materials.bone); // pale grit
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
  }

  // Corridor cell: 3-wide line in exactly one axis.
  _isCorridorCell(c, r) {
    const g = this.grid;
    const wRow = (g[r][c - 1] ? 1 : 0) + (g[r][c] ? 1 : 0) + (g[r][c + 1] ? 1 : 0);
    const hCol = (g[r - 1][c] ? 1 : 0) + (g[r][c] ? 1 : 0) + (g[r + 1][c] ? 1 : 0);
    return (wRow === 3 && hCol < 3) || (hCol === 3 && wRow < 3);
  }

  // ------------------------------------------------------------------ roof
  // Camera looks down from y≈19, so rooms stay open to the sky for gameplay
  // readability. Every SOLID cell gets a rock slab top at wall height: the
  // dungeon reads as rooms and corridors carved into a solid rock mass and
  // the wall band is fully enclosed from above (no see-through gaps).
  _buildRoof() {
    const geos = [];
    for (let r = 0; r < GRID_H; r++) {
      for (let c = 0; c < GRID_W; c++) {
        if (this.grid[r][c]) continue;
        const x0 = X(c) - CELL / 2;
        const z0 = Z(r) - CELL / 2;
        geos.push(this._boxGeo(CELL, 0.3, CELL, X(c), WALL_H + 0.17, Z(r), WALL_TILE, x0 / WALL_TILE, z0 / WALL_TILE));
      }
    }
    const merged = mergeGeometries(geos, false);
    this._trackGeo(merged);
    const mesh = new THREE.Mesh(merged, this._materials.roof);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  // ----------------------------------------------------------------- walls
  // Maximal wall runs along grid boundaries between floor and solid cells.
  // Runs are thin slabs (0.22m) centered on the boundary line; corner posts
  // fill the notches where horizontal and vertical runs meet.
  _buildWalls() {
    const geos = [];
    const postCells = new Set();
    const T = WALL_TILE;
    // Horizontal boundary lines (between grid rows rl-1 and rl).
    for (let rl = 1; rl < GRID_H; rl++) {
      let run = null; // {c0, c1, side, rl}
      for (let c = 0; c <= GRID_W; c++) {
        const above = c < GRID_W && rl - 1 >= 0 ? this.grid[rl - 1][c] : 0;
        const below = c < GRID_W && rl < GRID_H ? this.grid[rl][c] : 0;
        const isWall = c < GRID_W && (above ? 1 : 0) !== (below ? 1 : 0);
        const side = above ? -1 : 1; // -1: floor above (smaller z), +1: floor below
        if (isWall) {
          if (run && run.side === side) run.c1 = c;
          else {
            if (run) this._pushWallRunH(geos, run, T);
            run = { c0: c, c1: c, side, rl };
          }
        } else if (run) {
          this._pushWallRunH(geos, run, T);
          run = null;
        }
      }
      if (run) this._pushWallRunH(geos, run, T);
    }
    // Vertical boundary lines (between grid columns cl-1 and cl).
    for (let cl = 1; cl < GRID_W; cl++) {
      let run = null;
      for (let r = 0; r <= GRID_H; r++) {
        const left = r < GRID_H && cl - 1 >= 0 ? this.grid[r][cl - 1] : 0;
        const right = r < GRID_H && cl < GRID_W ? this.grid[r][cl] : 0;
        const isWall = r < GRID_H && (left ? 1 : 0) !== (right ? 1 : 0);
        const side = left ? -1 : 1; // -1: floor on -x side
        if (isWall) {
          if (run && run.side === side) run.r1 = r;
          else {
            if (run) this._pushWallRunV(geos, run, T);
            run = { r0: r, r1: r, side, cl };
          }
        } else if (run) {
          this._pushWallRunV(geos, run, T);
          run = null;
        }
      }
      if (run) this._pushWallRunV(geos, run, T);
    }
    // Corner posts at vertices with both an H and a V boundary.
    for (let rl = 1; rl < GRID_H; rl++) {
      for (let cl = 1; cl < GRID_W; cl++) {
        const A = this.grid[rl - 1][cl - 1], B = this.grid[rl - 1][cl];
        const C = this.grid[rl][cl - 1], D = this.grid[rl][cl];
        const hB = (A ? 1 : 0) !== (C ? 1 : 0) || (B ? 1 : 0) !== (D ? 1 : 0);
        const vB = (A ? 1 : 0) !== (B ? 1 : 0) || (C ? 1 : 0) !== (D ? 1 : 0);
        if (!(hB && vB)) continue;
        const px = cl * CELL - CELL / 2 - ORIGIN_X;
        const pz = rl * CELL - CELL / 2 - ORIGIN_Z;
        geos.push(this._boxGeo(MORTAR * 2 + 0.03, WALL_H + 0.02, MORTAR * 2 + 0.03, px, WALL_H / 2, pz, WALL_TILE, px / T, pz / T));
        postCells.add(rl * (GRID_W + 1) + cl);
      }
    }
    this._postCells = postCells;
    const merged = mergeGeometries(geos, false);
    this._trackGeo(merged);
    const mesh = new THREE.Mesh(merged, this._materials.wall);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  _pushWallRunH(geos, run, T) {
    const len = (run.c1 - run.c0 + 1) * CELL;
    const cx = ((run.c0 + run.c1) / 2) * CELL - ORIGIN_X;
    const zB = run.rl * CELL - CELL / 2 - ORIGIN_Z;
    const x0 = cx - len / 2;
    geos.push(this._boxGeo(len, WALL_H, MORTAR * 2, cx, WALL_H / 2, zB, T, x0 / T, zB / T));
  }

  _pushWallRunV(geos, run, T) {
    const len = (run.r1 - run.r0 + 1) * CELL;
    const cz = ((run.r0 + run.r1) / 2) * CELL - ORIGIN_Z;
    const xB = run.cl * CELL - CELL / 2 - ORIGIN_X;
    const z0 = cz - len / 2;
    geos.push(this._boxGeo(MORTAR * 2, WALL_H, len, xB, WALL_H / 2, cz, T, xB / T, z0 / T));
  }

  // ------------------------------------------------------------------ trim
  // Metal skirt along wall bases (floor side) + metal caps on corner posts.
  _buildTrim() {
    const geos = [];
    const T = 3.0;
    for (let rl = 1; rl < GRID_H; rl++) {
      let run = null;
      for (let c = 0; c <= GRID_W; c++) {
        const above = c < GRID_W ? this.grid[rl - 1][c] : 0;
        const below = c < GRID_W ? this.grid[rl][c] : 0;
        const isWall = c < GRID_W && (above ? 1 : 0) !== (below ? 1 : 0);
        const side = above ? -1 : 1;
        if (isWall) {
          if (run && run.side === side) run.c1 = c;
          else {
            if (run) this._pushSkirtH(geos, run, T);
            run = { c0: c, c1: c, side, rl };
          }
        } else if (run) {
          this._pushSkirtH(geos, run, T);
          run = null;
        }
      }
      if (run) this._pushSkirtH(geos, run, T);
    }
    for (let cl = 1; cl < GRID_W; cl++) {
      let run = null;
      for (let r = 0; r <= GRID_H; r++) {
        const left = r < GRID_H ? this.grid[r][cl - 1] : 0;
        const right = r < GRID_H ? this.grid[r][cl] : 0;
        const isWall = r < GRID_H && (left ? 1 : 0) !== (right ? 1 : 0);
        const side = left ? -1 : 1;
        if (isWall) {
          if (run && run.side === side) run.r1 = r;
          else {
            if (run) this._pushSkirtV(geos, run, T);
            run = { r0: r, r1: r, side, cl };
          }
        } else if (run) {
          this._pushSkirtV(geos, run, T);
          run = null;
        }
      }
      if (run) this._pushSkirtV(geos, run, T);
    }
    for (const key of this._postCells) {
      const rl = Math.floor(key / (GRID_W + 1));
      const cl = key % (GRID_W + 1);
      const px = cl * CELL - CELL / 2 - ORIGIN_X;
      const pz = rl * CELL - CELL / 2 - ORIGIN_Z;
      geos.push(this._boxGeo(0.34, 0.07, 0.34, px, WALL_H + 0.055, pz, T, px / T, pz / T));
    }
    const merged = mergeGeometries(geos, false);
    this._trackGeo(merged);
    const mesh = new THREE.Mesh(merged, this._materials.metalDark);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  _pushSkirtH(geos, run, T) {
    const len = (run.c1 - run.c0 + 1) * CELL;
    const cx = ((run.c0 + run.c1) / 2) * CELL - ORIGIN_X;
    const zB = run.rl * CELL - CELL / 2 - ORIGIN_Z;
    geos.push(this._boxGeo(len, TRIM_H, 0.14, cx, TRIM_H / 2, zB + run.side * (MORTAR + 0.04), T, cx / T, zB / T));
  }

  _pushSkirtV(geos, run, T) {
    const len = (run.r1 - run.r0 + 1) * CELL;
    const cz = ((run.r0 + run.r1) / 2) * CELL - ORIGIN_Z;
    const xB = run.cl * CELL - CELL / 2 - ORIGIN_X;
    geos.push(this._boxGeo(0.14, TRIM_H, len, xB + run.side * (MORTAR + 0.04), TRIM_H / 2, cz, T, xB / T, cz / T));
  }

  // ----------------------------------------------------------------- lights
  // Braziers in rooms, wall torches along corridors. Flames render as two
  // instanced cone shells (inner hot + outer haze) driven in update().
  _buildLights() {
    const rng = this._rng;
    const ironGeos = [];
    const coalGeos = [];

    const addBrazier = (x, z) => {
      const ped = new THREE.CylinderGeometry(0.16, 0.22, 0.78, 7);
      ped.translate(x, 0.39, z);
      ironGeos.push(ped);
      const bowl = new THREE.CylinderGeometry(0.44, 0.2, 0.32, 9);
      bowl.translate(x, 0.94, z);
      ironGeos.push(bowl);
      const lip = new THREE.TorusGeometry(0.44, 0.045, 5, 12);
      lip.rotateX(Math.PI / 2);
      lip.translate(x, 1.1, z);
      ironGeos.push(lip);
      const coal = new THREE.IcosahedronGeometry(0.26, 0);
      coal.scale(1.25, 0.55, 1.25);
      coal.translate(x, 1.06, z);
      coalGeos.push(coal);
      const flame = { x, y: 1.12, z, radius: 0.34, rate: 5.5 + rng() * 2.5, phase: rng() * 20, light: null, base: 2.4 };
      const light = new THREE.PointLight(0xff8a3d, 4.5, 13, 2);
      light.position.set(x, 1.9, z);
      this.group.add(light);
      flame.light = light;
      this._flameLights.push(light);
      this._flames.push(flame);
      this._emberSources.push({ x, y: 1.25, z });
      this.torches.push({ position: new THREE.Vector3(x, 0, z), kind: 'brazier', light });
    };

    for (const room of this.rooms) {
      const b = room.bounds;
      if (room.type === 'entry') {
        addBrazier(b.minX + 1.7, b.minZ + 1.7);
        addBrazier(b.maxX - 1.7, b.maxZ - 1.7);
      } else if (room.type === 'combat') {
        addBrazier(b.minX + 1.7, b.minZ + 1.7);
        addBrazier(b.maxX - 1.7, b.maxZ - 1.7);
      } else {
        // boss room: four corners
        addBrazier(b.minX + 1.7, b.minZ + 1.7);
        addBrazier(b.maxX - 1.7, b.minZ + 1.7);
        addBrazier(b.minX + 1.7, b.maxZ - 1.7);
        addBrazier(b.maxX - 1.7, b.maxZ - 1.7);
      }
    }
    if (this._portalCell) {
      // Flanking braziers sit beside the dais pocket (pocket is 3 cells wide).
      const px = X(this._portalCell.c);
      const pz = Z(this._portalCell.r);
      addBrazier(px - 5.5, pz + 0.5);
      addBrazier(px + 5.5, pz + 0.5);
    }

    // Wall torches along corridors: candidate cells adjacent to a wall.
    const torchSpots = [];
    for (const band of this.corridors) {
      const horizontal = band.c1 - band.c0 > band.r1 - band.r0;
      if (horizontal) {
        const row = Math.round((band.r0 + band.r1) / 2);
        for (let c = band.c0 + 2; c <= band.c1 - 2; c += 4) {
          const dirs = [];
          if (row > 0 && !this.grid[row - 1][c]) dirs.push(-1);
          if (row < GRID_H - 1 && !this.grid[row + 1][c]) dirs.push(1);
          if (dirs.length) torchSpots.push({ c, r: row, dz: dirs[Math.floor(rng() * dirs.length)], dx: 0 });
        }
      } else {
        const col = Math.round((band.c0 + band.c1) / 2);
        for (let r = band.r0 + 2; r <= band.r1 - 2; r += 4) {
          const dirs = [];
          if (col > 0 && !this.grid[r][col - 1]) dirs.push(-1);
          if (col < GRID_W - 1 && !this.grid[r][col + 1]) dirs.push(1);
          if (dirs.length) torchSpots.push({ c: col, r, dx: dirs[Math.floor(rng() * dirs.length)], dz: 0 });
        }
      }
    }
    // Greedy placement with min separation; every other torch gets a light.
    const placed = [];
    let lightToggle = false;
    for (const s of torchSpots) {
      const x = X(s.c) + s.dx * (CELL / 2 - 0.16);
      const z = Z(s.r) + s.dz * (CELL / 2 - 0.16);
      if (placed.some((p) => Math.hypot(p[0] - x, p[1] - z) < 7)) continue;
      placed.push([x, z]);
      const bracket = new THREE.BoxGeometry(0.09, 0.42, 0.09);
      if (s.dz !== 0) bracket.rotateX(Math.PI / 2);
      else bracket.rotateY(Math.PI / 2);
      bracket.translate(x - s.dx * 0.1, 1.9, z - s.dz * 0.1);
      ironGeos.push(bracket);
      const cup = new THREE.CylinderGeometry(0.13, 0.05, 0.16, 7);
      cup.translate(x, 2.12, z);
      ironGeos.push(cup);
      const flame = { x, y: 2.2, z, radius: 0.22, rate: 6.5 + rng() * 3, phase: rng() * 20, light: null, base: 1.6 };
      lightToggle = !lightToggle;
      if (lightToggle) {
        const light = new THREE.PointLight(0xffa04a, 3, 11, 2);
        light.position.set(x - s.dx * 0.35, 2.35, z - s.dz * 0.35);
        this.group.add(light);
        flame.light = light;
        this._flameLights.push(light);
      }
      this._flames.push(flame);
      this._emberSources.push({ x, y: 2.3, z });
      this.torches.push({ position: new THREE.Vector3(x, 0, z), kind: 'torch', light: flame.light });
    }

    if (ironGeos.length) {
      const merged = mergeGeometries(ironGeos, false);
      this._trackGeo(merged);
      const mesh = new THREE.Mesh(merged, this._materials.metalDark);
      mesh.castShadow = true;
      this.group.add(mesh);
    }
    if (coalGeos.length) {
      const merged = mergeGeometries(coalGeos, false);
      this._trackGeo(merged);
      const mesh = new THREE.Mesh(merged, this._materials.coal);
      this.group.add(mesh);
    }

    // Instanced flame shells (inner hot cone + outer haze cone).
    if (this._flames.length) {
      const cone = this._trackGeo(new THREE.ConeGeometry(1, 1, 7, 2, true));
      cone.translate(0, 0.5, 0); // base at origin, tip at +1
      this._flameInner = new THREE.InstancedMesh(cone, this._materials.flameInner, this._flames.length);
      this._flameOuter = new THREE.InstancedMesh(cone, this._materials.flameOuter, this._flames.length);
      this._flameInner.frustumCulled = false;
      this._flameOuter.frustumCulled = false;
      this._flameInner.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this._flameOuter.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(this._flameInner, this._flameOuter);
    }
  }

  // ------------------------------------------------------------- decorate
  // Pillars, rugs, rune circles, bones, hanging chains, boss seal.
  _decorate() {
    const rng = this._rng;
    const pillarGeos = [];
    const T = WALL_TILE;
    for (const p of this._pillarCells) {
      const x = X(p.c);
      const z = Z(p.r);
      const shaft = new THREE.CylinderGeometry(0.58, 0.66, WALL_H, 9);
      shaft.translate(x, WALL_H / 2, z);
      pillarGeos.push(shaft);
      pillarGeos.push(this._boxGeo(1.5, 0.28, 1.5, x, 0.14, z, T, x / T, z / T));
      pillarGeos.push(this._boxGeo(1.4, 0.22, 1.4, x, WALL_H - 0.11, z, T, x / T, z / T));
      if (rng() < 0.5) {
        const ring = new THREE.TorusGeometry(0.62, 0.05, 5, 10);
        ring.rotateX(Math.PI / 2);
        ring.translate(x, 1.6, z);
        pillarGeos.push(ring);
      }
    }
    if (pillarGeos.length) {
      const merged = mergeGeometries(pillarGeos, false);
      this._trackGeo(merged);
      const mesh = new THREE.Mesh(merged, this._materials.wall);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }

    // Rugs (merged into one mesh; texture UV 0..1 per rug).
    // Per-room vertex tint keeps the same weave from reading as one repeated prop.
    const RUG_TINTS = [0xffffff, 0xc8a898, 0xa8b8c8, 0xb8a0c8, 0xd0b890, 0xffb080];
    const rugGeos = [];
    for (const room of this.rooms) {
      if (room.size.x < 12 || room.size.z < 12) continue;
      const w = Math.min(room.size.x * 0.5, 13);
      const d = Math.min(room.size.z * 0.45, 11);
      const g = new THREE.PlaneGeometry(w, d);
      g.rotateX(-Math.PI / 2);
      g.translate(room.center.x, 0.015, room.center.z);
      const tint = new THREE.Color(RUG_TINTS[room.index % RUG_TINTS.length]);
      const count = g.attributes.position.count;
      const colors = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        colors[i * 3] = tint.r;
        colors[i * 3 + 1] = tint.g;
        colors[i * 3 + 2] = tint.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      rugGeos.push(g);
    }
    if (rugGeos.length) {
      const merged = mergeGeometries(rugGeos, false);
      this._trackGeo(merged);
      const mesh = new THREE.Mesh(merged, this._materials.rug);
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }

    // Rune circles: one per room, tinted per role, slow rotation.
    const circleGeo = this._trackGeo(new THREE.CircleGeometry(1, 48));
    for (const room of this.rooms) {
      const r = Math.min(room.size.x, room.size.z) * 0.26;
      const mat = room.type === 'boss' ? this._runeMat : this._runeMatDim;
      const mesh = new THREE.Mesh(circleGeo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(room.center.x, 0.02, room.center.z);
      this.group.add(mesh);
      this._runeCircles.push({
        mesh,
        baseScale: r,
        spin: room.type === 'boss' ? -0.3 : 0.18 + rng() * 0.12,
        phase: rng() * Math.PI * 2,
      });
    }

    // Bones: skulls, long bones, ribs scattered on floors.
    const boneGeos = [];
    const bossRoom = this.rooms[this.rooms.length - 1];
    for (const room of this.rooms) {
      const n = Math.floor(room.size.x * room.size.z * 0.02);
      for (let i = 0; i < n; i++) {
        const x = room.bounds.minX + 0.9 + rng() * (room.size.x - 1.8);
        const z = room.bounds.minZ + 0.9 + rng() * (room.size.z - 1.8);
        if (!this.isWalkable(x, z, 0.7)) continue;
        if (room === bossRoom && Math.hypot(x - bossRoom.center.x, z - bossRoom.center.z) < 6) continue;
        const kind = rng();
        if (kind < 0.3) {
          const skull = new THREE.SphereGeometry(0.16, 7, 6);
          skull.scale(1, 0.82, 1.2);
          skull.rotateY(rng() * Math.PI * 2);
          skull.translate(x, 0.12, z);
          boneGeos.push(skull);
          const jaw = new THREE.BoxGeometry(0.16, 0.07, 0.1);
          jaw.rotateY(rng() * Math.PI * 2);
          jaw.translate(x, 0.05, z + 0.12);
          boneGeos.push(jaw);
        } else if (kind < 0.75) {
          const len = 0.5 + rng() * 0.5;
          const ang = rng() * Math.PI * 2;
          const bone = new THREE.CylinderGeometry(0.035, 0.035, len, 5);
          bone.rotateZ(Math.PI / 2);
          bone.rotateY(ang);
          bone.translate(x, 0.045, z);
          boneGeos.push(bone);
          for (const s of [-1, 1]) {
            const knob = new THREE.SphereGeometry(0.06, 6, 5);
            knob.translate(x + Math.cos(ang) * s * len * 0.5, 0.045, z - Math.sin(ang) * s * len * 0.5);
            boneGeos.push(knob);
          }
        } else {
          const rib = new THREE.TorusGeometry(0.22 + rng() * 0.1, 0.02, 4, 10, Math.PI);
          rib.rotateX(Math.PI / 2);
          rib.rotateY(rng() * Math.PI * 2);
          rib.translate(x, 0.03, z);
          boneGeos.push(rib);
        }
      }
    }
    if (boneGeos.length) {
      const merged = mergeGeometries(boneGeos, false);
      this._trackGeo(merged);
      const mesh = new THREE.Mesh(merged, this._materials.bone);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }

    // Hanging chains: wall hangers in rooms + catenaries across wide
    // corridors. All links in one InstancedMesh.
    const linkGeo = this._trackGeo(new THREE.TorusGeometry(0.085, 0.024, 5, 8));
    const chainTransforms = [];
    const up = new THREE.Vector3(0, 1, 0);
    const addChainPath = (points) => {
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i];
        const b = points[i + 1];
        const dist = a.distanceTo(b);
        const nLinks = Math.max(1, Math.round(dist / 0.15));
        const dir = new THREE.Vector3().subVectors(b, a).normalize();
        for (let k = 0; k < nLinks; k++) {
          const t = (k + 0.5) / nLinks;
          const p = new THREE.Vector3().lerpVectors(a, b, t);
          const q = new THREE.Quaternion().setFromUnitVectors(up, dir);
          // alternate links 90deg around the chain axis for a linked look
          const q2 = new THREE.Quaternion().setFromAxisAngle(dir, (i + k) % 2 === 0 ? Math.PI / 2 : 0);
          q.multiply(q2);
          chainTransforms.push(new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1)));
        }
      }
    };
    for (const room of this.rooms) {
      const b = room.bounds;
      const n = 2 + Math.floor(rng() * 3);
      for (let i = 0; i < n; i++) {
        const edge = Math.floor(rng() * 4);
        let x;
        let z;
        if (edge === 0) { x = b.minX + rng() * room.size.x; z = b.minZ + 0.35; }
        else if (edge === 1) { x = b.minX + rng() * room.size.x; z = b.maxZ - 0.35; }
        else if (edge === 2) { x = b.minX + 0.35; z = b.minZ + rng() * room.size.z; }
        else { x = b.maxX - 0.35; z = b.minZ + rng() * room.size.z; }
        const top = WALL_H + 0.1;
        const len = 0.9 + rng() * 1.3;
        const pts = [];
        const segs = 6;
        for (let k = 0; k <= segs; k++) {
          const t = k / segs;
          pts.push(new THREE.Vector3(x + Math.sin(t * 4) * 0.06, top - len * t, z + Math.cos(t * 3.4) * 0.05));
        }
        addChainPath(pts);
      }
    }
    for (const band of this.corridors.slice(0, 10)) {
      const horizontal = band.c1 - band.c0 > band.r1 - band.r0;
      if (!horizontal || band.c1 - band.c0 < 4) continue;
      const row = Math.round((band.r0 + band.r1) / 2);
      const cx = ((band.c0 + band.c1) / 2) * CELL - ORIGIN_X;
      const z0 = Z(row) - CELL / 2 + 0.2;
      const z1 = Z(row) + CELL / 2 - 0.2;
      const top = WALL_H + 0.05;
      const pts = [];
      for (let k = 0; k <= 18; k++) {
        const t = k / 18;
        pts.push(new THREE.Vector3(cx, top - Math.sin(Math.PI * t) * 0.85, z0 + (z1 - z0) * t));
      }
      addChainPath(pts);
    }
    if (chainTransforms.length) {
      const chains = new THREE.InstancedMesh(linkGeo, this._materials.chain, chainTransforms.length);
      for (let i = 0; i < chainTransforms.length; i++) chains.setMatrixAt(i, chainTransforms[i]);
      chains.instanceMatrix.needsUpdate = true;
      chains.castShadow = true;
      chains.frustumCulled = false;
      this.group.add(chains);
    }

    // Boss seal at boss room center.
    const seal = new THREE.Group();
    seal.position.set(bossRoom.center.x, 0, bossRoom.center.z);
    const sealGeos = [];
    const sealRing = new THREE.TorusGeometry(2.1, 0.17, 7, 36);
    sealRing.rotateX(Math.PI / 2);
    sealRing.translate(0, 0.12, 0);
    sealGeos.push(sealRing);
    const sealRing2 = new THREE.TorusGeometry(1.55, 0.1, 6, 28);
    sealRing2.rotateX(Math.PI / 2);
    sealRing2.translate(0, 0.08, 0);
    sealGeos.push(sealRing2);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const spike = new THREE.CylinderGeometry(0.02, 0.16, 1.5, 5);
      spike.rotateZ(Math.PI / 2);
      spike.rotateY(-a);
      spike.translate(Math.cos(a) * 2.35, 0.16, -Math.sin(a) * 2.35);
      sealGeos.push(spike);
    }
    const sealMerged = mergeGeometries(sealGeos, false);
    this._trackGeo(sealMerged);
    const sealMesh = new THREE.Mesh(sealMerged, this._materials.metalDark);
    sealMesh.castShadow = true;
    seal.add(sealMesh);
    const sealRune = new THREE.Mesh(
      this._trackGeo(new THREE.CircleGeometry(2.6, 48)),
      this._trackMat(new THREE.MeshBasicMaterial({
        map: this._textures.rune, color: 0xff3b2b, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, opacity: 0.55,
      })),
    );
    sealRune.rotation.x = -Math.PI / 2;
    sealRune.position.y = 0.03;
    seal.add(sealRune);
    this._sealRune = sealRune;
    const sealLight = new THREE.PointLight(0xff3b2b, 1.3, 12, 2);
    sealLight.position.set(0, 1.6, 0);
    seal.add(sealLight);
    this._sealLight = sealLight;
    this.group.add(seal);
  }

  // ------------------------------------------------------------------ dust
  _buildDust() {
    const COUNT = 240;
    const rng = this._rng;
    // Collect floor cells once, then sample motes from them.
    const floorCells = [];
    for (let r = 1; r < GRID_H - 1; r++) {
      for (let c = 1; c < GRID_W - 1; c++) {
        if (this.grid[r][c]) floorCells.push([c, r]);
      }
    }
    const positions = new Float32Array(COUNT * 3);
    this._dustBase = new Float32Array(COUNT * 3);
    this._dustPhase = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      const [c, r] = floorCells[Math.floor(rng() * floorCells.length)];
      positions[i * 3] = X(c) + (rng() - 0.5) * CELL;
      positions[i * 3 + 1] = 0.4 + rng() * 2.1;
      positions[i * 3 + 2] = Z(r) + (rng() - 0.5) * CELL;
      this._dustPhase[i] = rng() * Math.PI * 2;
    }
    const geo = this._trackGeo(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(positions.slice(), 3));
    this._dustBase.set(positions);
    const mat = this._trackMat(new THREE.PointsMaterial({
      map: this._textures.glow, color: 0x9aa2b8, size: 0.075, transparent: true,
      opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    }));
    this._dust = new THREE.Points(geo, mat);
    this._dust.frustumCulled = false;
    this.group.add(this._dust);
  }

  _updateDust(dt, elapsed) {
    const pos = this._dust.geometry.attributes.position;
    const arr = pos.array;
    for (let i = 0; i < this._dustPhase.length; i++) {
      const p = this._dustPhase[i];
      arr[i * 3] = this._dustBase[i * 3] + Math.sin(elapsed * 0.22 + p) * 0.5;
      arr[i * 3 + 1] = this._dustBase[i * 3 + 1] + Math.sin(elapsed * 0.35 + p * 2.1) * 0.3;
      arr[i * 3 + 2] = this._dustBase[i * 3 + 2] + Math.cos(elapsed * 0.18 + p * 1.3) * 0.5;
    }
    pos.needsUpdate = true;
  }

  // ---------------------------------------------------------------- embers
  _buildEmbers() {
    const COUNT = 150;
    const rng = this._rng;
    const positions = new Float32Array(COUNT * 3);
    this._emberVel = new Float32Array(COUNT * 3);
    this._emberLife = new Float32Array(COUNT);
    if (!this._emberSources.length) this._emberSources.push({ x: 0, y: 1.2, z: 0 });
    for (let i = 0; i < COUNT; i++) {
      const s = this._emberSources[i % this._emberSources.length];
      positions[i * 3] = s.x;
      positions[i * 3 + 1] = s.y + rng() * 2;
      positions[i * 3 + 2] = s.z;
      this._emberVel[i * 3] = (rng() - 0.5) * 0.35;
      this._emberVel[i * 3 + 1] = 0.5 + rng() * 0.9;
      this._emberVel[i * 3 + 2] = (rng() - 0.5) * 0.35;
      this._emberLife[i] = rng() * 2.4;
    }
    const geo = this._trackGeo(new THREE.BufferGeometry());
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = this._trackMat(new THREE.PointsMaterial({
      map: this._textures.glow, color: 0xffa04a, size: 0.09, transparent: true,
      opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    }));
    this._embers = new THREE.Points(geo, mat);
    this._embers.frustumCulled = false;
    this.group.add(this._embers);
  }

  _updateEmbers(dt, elapsed) {
    const pos = this._embers.geometry.attributes.position;
    const arr = pos.array;
    const n = this._emberLife.length;
    for (let i = 0; i < n; i++) {
      this._emberLife[i] += dt;
      if (this._emberLife[i] > 2.4) {
        const s = this._emberSources[i % this._emberSources.length];
        arr[i * 3] = s.x + (Math.random() - 0.5) * 0.4;
        arr[i * 3 + 1] = s.y;
        arr[i * 3 + 2] = s.z + (Math.random() - 0.5) * 0.4;
        this._emberVel[i * 3] = (Math.random() - 0.5) * 0.35;
        this._emberVel[i * 3 + 1] = 0.5 + Math.random() * 0.7;
        this._emberVel[i * 3 + 2] = (Math.random() - 0.5) * 0.35;
        this._emberLife[i] = 0;
      }
      arr[i * 3] += (this._emberVel[i * 3] + Math.sin(elapsed * 2.2 + i) * 0.12) * dt;
      arr[i * 3 + 1] += this._emberVel[i * 3 + 1] * dt;
      arr[i * 3 + 2] += (this._emberVel[i * 3 + 2] + Math.cos(elapsed * 1.9 + i * 1.3) * 0.12) * dt;
    }
    pos.needsUpdate = true;
  }

  // ---------------------------------------------------------------- portal
  _buildExitPortal() {
    const px = X(this._portalCell.c);
    const pz = Z(this._portalCell.r);
    const group = new THREE.Group();
    group.position.set(px, 0, pz);
    const statics = [];

    // Stone dais: two shallow steps + flat rim. Kept low: the player walks onto
    // it to reach the gate, and the game has no platform height, so a tall dais
    // would swallow their legs.
    const step1 = new THREE.CylinderGeometry(3.4, 3.6, 0.07, 28);
    step1.translate(0, 0.035, 0);
    const step2 = new THREE.CylinderGeometry(2.7, 2.85, 0.07, 28);
    step2.translate(0, 0.105, 0);
    statics.push(step1, step2);
    const rim = new THREE.TorusGeometry(3.0, 0.07, 6, 40);
    rim.rotateX(Math.PI / 2);
    rim.translate(0, 0.145, 0);
    statics.push(rim);
    const daisGeo = mergeGeometries(statics, false);
    this._trackGeo(daisGeo);
    const dais = new THREE.Mesh(daisGeo, this._materials.wall);
    dais.receiveShadow = true;
    dais.castShadow = true;
    group.add(dais);

    // Ground rune ring (rotating).
    const groundRune = new THREE.Mesh(
      this._trackGeo(new THREE.CircleGeometry(3.05, 48)),
      this._trackMat(new THREE.MeshBasicMaterial({
        map: this._textures.rune, color: 0xff8a3d, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, opacity: 0.18,
      })),
    );
    groundRune.rotation.x = -Math.PI / 2;
    groundRune.position.y = 0.15;
    group.add(groundRune);

    // Arch: pillars + lintel.
    const archGeos = [];
    for (const s of [-1, 1]) {
      const pillar = new THREE.CylinderGeometry(0.3, 0.38, 4.1, 8);
      pillar.translate(s * 2.65, 2.05, 0);
      archGeos.push(pillar);
      const cap = new THREE.BoxGeometry(0.85, 0.25, 0.85);
      cap.translate(s * 2.6, 4.15, 0);
      archGeos.push(cap);
    }
    const lintel = new THREE.BoxGeometry(6.3, 0.55, 0.7);
    lintel.translate(0, 4.4, 0);
    archGeos.push(lintel);
    const archGeo = mergeGeometries(archGeos, false);
    this._trackGeo(archGeo);
    const arch = new THREE.Mesh(archGeo, this._materials.metalDark);
    arch.castShadow = true;
    group.add(arch);

    const glyphStrip = new THREE.Mesh(
      this._trackGeo(new THREE.PlaneGeometry(5.6, 0.85)),
      this._glyphMat,
    );
    glyphStrip.position.set(0, 4.4, 0.38);
    group.add(glyphStrip);

    // Standing ring + swirling portal disc.
    const ring = new THREE.Mesh(
      this._trackGeo(new THREE.TorusGeometry(2.3, 0.14, 8, 48)),
      this._trackMat(new THREE.MeshStandardMaterial({
        color: 0x6b6f7a, roughness: 0.45, metalness: 0.9,
        emissive: 0xff7a2b, emissiveIntensity: 0.2,
      })),
    );
    ring.position.set(0, 2.55, 0.15);
    group.add(ring);

    const swirlMat = this._trackMat(new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 0.06 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform float uTime;
        uniform float uIntensity;
        varying vec2 vUv;
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                     mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
        }
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p);
          if (r > 1.0) discard;
          float a = atan(p.y, p.x);
          float sw = 2.4 / (r + 0.32) + uTime * 0.85;
          float n = noise(vec2(a * 2.2 + sw, r * 5.0 - uTime * 1.3));
          float n2 = noise(vec2(a * 4.6 - sw * 1.25, r * 9.0 - uTime * 2.1));
          float bands = 0.5 + 0.5 * sin(10.0 * r - uTime * 2.4 + n * 3.2);
          vec3 deep = vec3(0.10, 0.02, 0.22);
          vec3 hot = vec3(1.0, 0.45, 0.14);
          vec3 col = mix(deep, hot, clamp(bands * 0.65 + n2 * 0.5, 0.0, 1.0));
          col += vec3(1.0, 0.85, 0.6) * pow(max(0.0, 1.0 - r * 2.1), 2.0) * 1.7;
          float edge = smoothstep(1.0, 0.68, r);
          float alpha = edge * (0.3 + 0.7 * bands) * min(1.0, uIntensity);
          gl_FragColor = vec4(col * uIntensity, alpha);
        }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
    const swirl = new THREE.Mesh(this._trackGeo(new THREE.CircleGeometry(2.2, 48)), swirlMat);
    swirl.position.set(0, 2.55, 0.15);
    group.add(swirl);

    // Orbiting rune shards.
    const shardGeo = this._trackGeo(new THREE.TetrahedronGeometry(0.16, 0));
    const shards = new THREE.InstancedMesh(shardGeo, this._materials.metalDark, 8);
    shards.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    shards.frustumCulled = false;
    group.add(shards);

    // Lights: violet aura + orange core (only bright once active).
    const lightViolet = new THREE.PointLight(0xb06bff, 0.15, 16, 2);
    lightViolet.position.set(0, 2.8, 0.9);
    group.add(lightViolet);
    const lightCore = new THREE.PointLight(0xff8a3d, 0.1, 9, 2);
    lightCore.position.set(0, 1.5, 1.2);
    group.add(lightCore);

    // Glow sprite halo.
    const halo = new THREE.Sprite(this._glowSpriteMat.clone());
    this._tracked.materials.add(halo.material);
    halo.scale.set(7.5, 7.5, 1);
    halo.position.set(0, 2.6, 0.3);
    group.add(halo);

    // Inrushing sparks.
    const SPARKS = 120;
    const sparkPos = new Float32Array(SPARKS * 3);
    const sparkData = [];
    for (let i = 0; i < SPARKS; i++) {
      sparkData.push({ a: Math.random() * Math.PI * 2, r: 2.2 + Math.random() * 1.6, y: Math.random() * 4.2, sp: 0.6 + Math.random() * 1.4 });
    }
    const sparkGeo = this._trackGeo(new THREE.BufferGeometry());
    sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
    const sparkMat = this._trackMat(new THREE.PointsMaterial({
      map: this._textures.glow, color: 0xffb46b, size: 0.14, transparent: true,
      opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    }));
    const sparks = new THREE.Points(sparkGeo, sparkMat);
    sparks.frustumCulled = false;
    group.add(sparks);

    this.group.add(group);

    const state = { cur: 0, target: 0 };
    const d = this._dummy;
    const portal = {
      group,
      mesh: ring,
      position: group.position.clone(),
      active: false,
      setActive: (active) => {
        state.target = active ? 1 : 0;
        portal.active = !!active;
      },
      update: (dt, time) => {
        state.cur += (state.target - state.cur) * Math.min(1, dt * 2.0);
        const k = state.cur;
        swirlMat.uniforms.uTime.value = time;
        swirlMat.uniforms.uIntensity.value = 0.06 + 2.4 * k;
        ring.scale.setScalar(1 + Math.sin(time * 3.1) * 0.05 * (0.3 + k));
        ring.material.emissiveIntensity = 0.2 + 1.6 * k;
        groundRune.rotation.z += dt * (0.25 + 1.4 * k);
        groundRune.material.opacity = 0.18 + 0.75 * k;
        this._glyphMat.opacity = 0.35 + 0.6 * k + Math.sin(time * 4.5) * 0.12 * k;
        halo.material.opacity = 0.12 + 0.65 * k;
        halo.scale.setScalar(7.5 * (0.85 + 0.25 * k + Math.sin(time * 2.2) * 0.05 * k));
        // orbiting shards
        const orbR = 2.65 - 0.15 * k;
        const spin = 0.5 + 2.6 * k;
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2 + time * spin;
          d.position.set(Math.cos(a) * orbR, 2.55 + Math.sin(time * 1.8 + i) * 0.35, 0.15 + Math.sin(a) * orbR * 0.35);
          d.rotation.set(time * 1.3 + i, a, 0);
          d.scale.setScalar(0.8 + 0.5 * k);
          d.updateMatrix();
          shards.setMatrixAt(i, d.matrix);
        }
        shards.instanceMatrix.needsUpdate = true;
        lightViolet.intensity = 0.15 + 5.5 * k + Math.sin(time * 7.3) * 0.4 * k;
        lightCore.intensity = 0.1 + 3.0 * k + Math.sin(time * 9.1) * 0.3 * k;
        // sparks spiral inward when active
        sparkMat.opacity = 0.9 * k;
        if (k > 0.03) {
          const arr = sparkGeo.attributes.position.array;
          for (let i = 0; i < SPARKS; i++) {
            const s = sparkData[i];
            s.a += dt * (1.2 + s.sp) * (0.4 + k);
            s.r -= dt * (0.55 + k) * s.sp;
            s.y += dt * (s.sp - 0.9) * 0.7;
            if (s.r < 0.25 || s.y < -0.2 || s.y > 4.6) {
              s.a = Math.random() * Math.PI * 2;
              s.r = 2.2 + Math.random() * 1.7;
              s.y = 0.4 + Math.random() * 3.9;
            }
            arr[i * 3] = Math.cos(s.a) * s.r;
            arr[i * 3 + 1] = s.y;
            arr[i * 3 + 2] = 0.15 + Math.sin(s.a) * s.r * 0.8;
          }
          sparkGeo.attributes.position.needsUpdate = true;
        }
      },
    };
    this._portal = portal;
    this.exitPortal = portal;
  }

  // -------------------------------------------------------------- public API
  worldToCell(x, z) {
    return { col: Math.round((x + ORIGIN_X) / CELL), row: Math.round((z + ORIGIN_Z) / CELL) };
  }

  cellToWorld(col, row) {
    return { x: col * CELL - ORIGIN_X, z: row * CELL - ORIGIN_Z };
  }

  _isFloorCell(col, row) {
    return col >= 0 && col < GRID_W && row >= 0 && row < GRID_H && !!this.grid[row][col];
  }

  // Circle-fit test: sample center + 8 ring points against walkable cells.
  isWalkable(x, z, radius = 0.4) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    const r = Math.max(0.05, Number.isFinite(radius) ? radius : 0.4);
    const K = 0.70710678;
    const offs = [[r, 0], [-r, 0], [0, r], [0, -r], [r * K, r * K], [r * K, -r * K], [-r * K, r * K], [-r * K, -r * K]];
    for (let i = 0; i <= offs.length; i++) {
      const ox = i === offs.length ? 0 : offs[i][0];
      const oz = i === offs.length ? 0 : offs[i][1];
      if (!this._isFloorCell(Math.round((x + ox + ORIGIN_X) / CELL), Math.round((z + oz + ORIGIN_Z) / CELL))) return false;
    }
    return true;
  }

  getRoomAt(position) {
    if (!position) return null;
    const x = position.x;
    const z = position.z;
    const m = 1.2; // small margin per contract
    for (const room of this.rooms) {
      const b = room.bounds;
      if (x >= b.minX - m && x <= b.maxX + m && z >= b.minZ - m && z <= b.maxZ + m) return room;
    }
    return null;
  }

  roomCenter(index) {
    const room = this.rooms[index];
    return room ? room.center.clone() : null;
  }

  // ---------------------------------------------------------------- update
  update(dt, elapsed) {
    if (this._disposed) return;
    const d = this._dummy;

    // Flames + flickering lights.
    for (let i = 0; i < this._flames.length; i++) {
      const f = this._flames[i];
      const t = elapsed * f.rate + f.phase;
      const n = 0.72 + 0.2 * Math.sin(t * 6.7) + 0.12 * Math.sin(t * 17.3 + f.phase) + 0.06 * Math.sin(t * 31.1);
      const sy = f.radius * 2.6 * (0.85 + 0.3 * n);
      const sxz = f.radius * (0.78 + 0.24 * n);
      d.position.set(f.x + Math.sin(t * 1.7) * 0.03, f.y + sy * 0.42, f.z + Math.cos(t * 1.3) * 0.03);
      d.rotation.set(0, t * 0.6, 0);
      d.scale.set(sxz, sy, sxz);
      d.updateMatrix();
      this._flameInner.setMatrixAt(i, d.matrix);
      d.position.y -= 0.06;
      d.scale.set(sxz * 1.75, sy * 1.2, sxz * 1.75);
      d.updateMatrix();
      this._flameOuter.setMatrixAt(i, d.matrix);
      if (f.light) {
        // occasional gutter (wind gust dip)
        const gutter = Math.sin(t * 0.63 + f.phase * 2.7) > 0.965 ? -0.35 : 0;
        f.light.intensity = f.base * (0.72 + 0.34 * n + gutter);
      }
    }
    if (this._flames.length) {
      this._flameInner.instanceMatrix.needsUpdate = true;
      this._flameOuter.instanceMatrix.needsUpdate = true;
    }

    // Rune circles: slow spin + breathing scale.
    for (const rc of this._runeCircles) {
      rc.mesh.rotation.z += rc.spin * dt;
      rc.mesh.scale.setScalar(rc.baseScale * (1 + Math.sin(elapsed * 1.6 + rc.phase) * 0.02));
    }
    if (this._sealRune) {
      this._sealRune.rotation.z -= dt * 0.22;
      this._sealLight.intensity = 1.3 + Math.sin(elapsed * 5.1) * 0.25 + Math.sin(elapsed * 13.7) * 0.12;
    }

    this._updateDust(dt, elapsed);
    this._updateEmbers(dt, elapsed);
    if (this._portal) this._portal.update(dt, elapsed);
  }

  // --------------------------------------------------------------- dispose
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.scene.remove(this.group);
    for (const g of this._tracked.geometries) g.dispose();
    for (const m of this._tracked.materials) m.dispose();
    for (const t of this._tracked.textures) t.dispose();
    this._tracked.geometries.clear();
    this._tracked.materials.clear();
    this._tracked.textures.clear();
    if (this._prevFog) this.scene.fog = this._prevFog;
    else this.scene.fog = null;
    this._flames.length = 0;
    this._flameLights.length = 0;
    this._runeCircles.length = 0;
    this._emberSources.length = 0;
    this.torches.length = 0;
    this._portal = null;
    this.exitPortal = null;
  }
}

export { Dungeon };
