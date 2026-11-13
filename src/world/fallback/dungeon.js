import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildDungeonTextures } from './textures.js';

const CELL = 2.5;
const W = 46;
const H = 46;
const WALL_H = 3.2;
const ROOM_NAMES = [
  'The Threshold', 'The Ossuary', 'The Cold Hall',
  'The Drowned Vault', 'The Cinder Court', "The Warden's Gate",
];

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addColor(geo, shade = 1) {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = shade * (0.88 + Math.random() * 0.18);
    arr[i * 3] = v; arr[i * 3 + 1] = v * 0.98; arr[i * 3 + 2] = v * 0.94;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

export class Dungeon {
  constructor(scene, { depth = 1 } = {}) {
    this.scene = scene;
    this.depth = depth;
    this.cell = CELL;
    this.gridW = W;
    this.gridH = H;
    this.grid = Array.from({ length: H }, () => Array(W).fill(false));
    this.group = new THREE.Group();
    this.group.name = `dungeon-${depth}`;
    scene.add(this.group);
    this.rooms = [];
    this._blockers = [];
    this._flames = [];
    this._lights = [];
    this._rng = mulberry32(0x51ed + depth * 7919);
    this.textures = buildDungeonTextures();
    this._generateLayout();
    this._buildAtmosphere();
    this._buildFloor();
    this._buildWalls();
    this._buildRoomDetails();
    this._buildPortal();
    this._buildDust();
    this._buildSpawnPoints();
    this.playerSpawn = this.rooms[0].center.clone();
    this.exitPortal = {
      group: this._portalGroup,
      position: this.rooms[this.rooms.length - 1].center.clone(),
      active: false,
      setActive: (v) => this._setPortalActive(v),
      update: () => {},
    };
    this._setPortalActive(false);
    scene.background = new THREE.Color(0x05060a);
    scene.fog = new THREE.FogExp2(0x06070c, 0.024);
    this._moon = null;
  }

  _generateLayout() {
    const rng = this._rng;
    const bases = [
      { min: 5, max: 12, minZ: 6, maxZ: 12 },
      { min: 20, max: 27, minZ: 5, maxZ: 11 },
      { min: 33, max: 40, minZ: 12, maxZ: 18 },
      { min: 28, max: 35, minZ: 24, maxZ: 31 },
      { min: 12, max: 20, minZ: 27, maxZ: 34 },
      { min: 4, max: 13, minZ: 36, maxZ: 43 },
    ];
    for (let i = 0; i < bases.length; i++) {
      const b = bases[i];
      const jitter = i === 0 || i === bases.length - 1 ? 0 : 1;
      const min = b.min + Math.round((rng() - 0.5) * jitter);
      const max = b.max + Math.round((rng() - 0.5) * jitter);
      const minZ = b.minZ + Math.round((rng() - 0.5) * jitter);
      const maxZ = b.maxZ + Math.round((rng() - 0.5) * jitter);
      const room = { min, max, minZ, maxZ };
      // irregular alcoves, kept inside the grid and away from neighbouring rooms
      for (let a = 0; a < 2; a++) {
        const side = Math.floor(rng() * 4);
        if (side === 0 && room.min > 2) room.min -= 1;
        else if (side === 1 && room.max < W - 3) room.max += 1;
        else if (side === 2 && room.minZ > 2) room.minZ -= 1;
        else if (side === 3 && room.maxZ < H - 3) room.maxZ += 1;
      }
      for (let r = room.minZ; r <= room.maxZ; r++) {
        for (let c = room.min; c <= room.max; c++) {
          if (r >= 0 && r < H && c >= 0 && c < W) this.grid[r][c] = true;
        }
      }
      const minX = (room.min - W / 2) * CELL;
      const maxX = (room.max + 1 - W / 2) * CELL;
      const minWZ = (room.minZ - H / 2) * CELL;
      const maxWZ = (room.maxZ + 1 - H / 2) * CELL;
      this.rooms.push({
        index: i,
        type: i === 0 ? 'entry' : i === bases.length - 1 ? 'boss' : 'combat',
        name: ROOM_NAMES[i] ?? `Chamber ${i + 1}`,
        center: new THREE.Vector3((minX + maxX) / 2, 0, (minWZ + maxWZ) / 2),
        size: { x: maxX - minX, z: maxWZ - minWZ },
        bounds: { minX, maxX, minZ: minWZ, maxZ: maxWZ },
        cells: room,
        spawnPoints: [],
        cleared: false,
        activated: false,
      });
    }
    // L-shaped corridors between consecutive rooms
    for (let i = 0; i < this.rooms.length - 1; i++) {
      const a = this.rooms[i].cells;
      const b = this.rooms[i + 1].cells;
      const acx = Math.floor((a.min + a.max) / 2);
      const acy = Math.floor((a.minZ + a.maxZ) / 2);
      const bcx = Math.floor((b.min + b.max) / 2);
      const bcy = Math.floor((b.minZ + b.maxZ) / 2);
      const horizontalFirst = (i + this.depth) % 2 === 0;
      const carveH = (x0, x1, y) => {
        const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
        for (let x = lo - 1; x <= hi + 1; x++) {
          for (let dy = -1; dy <= 1; dy++) {
            if (x >= 0 && x < W && y + dy >= 0 && y + dy < H) this.grid[y + dy][x] = true;
          }
        }
      };
      const carveV = (y0, y1, x) => {
        const lo = Math.min(y0, y1), hi = Math.max(y0, y1);
        for (let y = lo - 1; y <= hi + 1; y++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (y >= 0 && y < H && x + dx >= 0 && x + dx < W) this.grid[y][x + dx] = true;
          }
        }
      };
      if (horizontalFirst) {
        carveH(acx, bcx, acy);
        carveV(acy, bcy, bcx);
      } else {
        carveV(acy, bcy, acx);
        carveH(acx, bcx, bcy);
      }
    }
  }

  _buildAtmosphere() {
    const hemi = new THREE.HemisphereLight(0x31415c, 0x120b08, 0.38);
    this.group.add(hemi);
    const ambient = new THREE.AmbientLight(0x24212c, 0.2);
    this.group.add(ambient);
    const moon = new THREE.DirectionalLight(0x8aa0d8, 0.72);
    moon.position.set(26, 48, 12);
    moon.castShadow = true;
    moon.shadow.mapSize.set(2048, 2048);
    moon.shadow.camera.left = -62;
    moon.shadow.camera.right = 62;
    moon.shadow.camera.top = 62;
    moon.shadow.camera.bottom = -62;
    moon.shadow.camera.near = 1;
    moon.shadow.camera.far = 130;
    moon.shadow.bias = -0.0006;
    moon.shadow.normalBias = 0.03;
    this.group.add(moon);
    this.group.add(moon.target);
    this._moon = moon;
    const fill = new THREE.PointLight(0x2e4a72, 9, 60, 2);
    fill.position.set(0, 18, -8);
    this.group.add(fill);
  }

  _buildFloor() {
    const geos = [];
    const baseGeo = new THREE.PlaneGeometry(CELL, CELL);
    baseGeo.rotateX(-Math.PI / 2);
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        if (!this.grid[r][c]) continue;
        const g = baseGeo.clone();
        const p = this.cellToWorld(c, r);
        g.translate(p.x, 0, p.z);
        addColor(g, 0.9 + this._rng() * 0.2);
        geos.push(g);
      }
    }
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    baseGeo.dispose();
    const mat = new THREE.MeshStandardMaterial({
      map: this.textures.floorMap,
      bumpMap: this.textures.floorBump,
      bumpScale: 0.12,
      roughnessMap: this.textures.floorRough,
      roughness: 0.93,
      metalness: 0.03,
      vertexColors: true,
    });
    const floor = new THREE.Mesh(merged, mat);
    floor.receiveShadow = true;
    floor.castShadow = false;
    this.group.add(floor);
    // dark under-floor, hides the void outside the walls
    const voidPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(220, 220),
      new THREE.MeshStandardMaterial({ color: 0x050507, roughness: 1 }),
    );
    voidPlane.rotation.x = -Math.PI / 2;
    voidPlane.position.y = -0.22;
    voidPlane.receiveShadow = true;
    this.group.add(voidPlane);
  }

  _buildWalls() {
    const wallGeos = [];
    const trimGeos = [];
    const dirs = [
      { dx: 0, dz: -1, alongX: true },
      { dx: 0, dz: 1, alongX: true },
      { dx: -1, dz: 0, alongX: false },
      { dx: 1, dz: 0, alongX: false },
    ];
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        if (!this.grid[r][c]) continue;
        const p = this.cellToWorld(c, r);
        for (const d of dirs) {
          const nr = r + d.dz, nc = c + d.dx;
          const outside = nr < 0 || nr >= H || nc < 0 || nc >= W || !this.grid[nr][nc];
          if (!outside) continue;
          const w = CELL + 0.25;
          const g = d.alongX
            ? new THREE.BoxGeometry(w, WALL_H, 0.4)
            : new THREE.BoxGeometry(0.4, WALL_H, w);
          const x = p.x + d.dx * CELL * 0.5;
          const z = p.z + d.dz * CELL * 0.5;
          g.translate(x, WALL_H * 0.5, z);
          addColor(g, 0.86 + this._rng() * 0.2);
          wallGeos.push(g);
          const cap = d.alongX
            ? new THREE.BoxGeometry(w + 0.1, 0.22, 0.62)
            : new THREE.BoxGeometry(0.62, 0.22, w + 0.1);
          cap.translate(x, WALL_H + 0.11, z);
          addColor(cap, 0.65);
          trimGeos.push(cap);
          const base = d.alongX
            ? new THREE.BoxGeometry(w + 0.05, 0.38, 0.55)
            : new THREE.BoxGeometry(0.55, 0.38, w + 0.05);
          base.translate(x, 0.19, z);
          addColor(base, 0.58);
          trimGeos.push(base);
        }
      }
    }
    const wallGeo = mergeGeometries(wallGeos, false);
    const trimGeo = mergeGeometries(trimGeos, false);
    for (const g of wallGeos) g.dispose();
    for (const g of trimGeos) g.dispose();
    const wallMat = new THREE.MeshStandardMaterial({
      map: this.textures.wallMap,
      bumpMap: this.textures.wallBump,
      bumpScale: 0.16,
      roughnessMap: this.textures.wallRough,
      roughness: 0.9,
      metalness: 0.04,
      vertexColors: true,
    });
    const walls = new THREE.Mesh(wallGeo, wallMat);
    walls.castShadow = true;
    walls.receiveShadow = true;
    this.group.add(walls);
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0x6c604e, roughness: 0.55, metalness: 0.35, vertexColors: true,
    });
    const trim = new THREE.Mesh(trimGeo, trimMat);
    trim.castShadow = true;
    trim.receiveShadow = true;
    this.group.add(trim);
  }

  _buildRoomDetails() {
    const stoneMat = new THREE.MeshStandardMaterial({
      map: this.textures.wallMap, roughness: 0.9, metalness: 0.04,
    });
    const darkStone = new THREE.MeshStandardMaterial({ color: 0x3c352c, roughness: 0.9 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x8b6b3a, roughness: 0.42, metalness: 0.7 });
    const metalMat = new THREE.MeshStandardMaterial({
      map: this.textures.metalMap, color: 0x9a8565, roughness: 0.38, metalness: 0.75,
    });
    const coalMat = new THREE.MeshStandardMaterial({
      color: 0x2a120c, emissive: 0xff3a12, emissiveIntensity: 0.8, roughness: 0.8,
    });
    const pillarGeo = new THREE.CylinderGeometry(0.46, 0.52, WALL_H + 0.35, 8);
    const pillarBaseGeo = new THREE.BoxGeometry(1.15, 0.4, 1.15);
    const pillarCapGeo = new THREE.BoxGeometry(1.05, 0.35, 1.05);

    for (const room of this.rooms) {
      const b = room.bounds;
      // rug / sigil
      const rugSize = Math.min(room.size.x, room.size.z) * 0.62;
      if (rugSize > 2) {
        const rugGeo = new THREE.PlaneGeometry(rugSize, rugSize);
        rugGeo.rotateX(-Math.PI / 2);
        const rug = new THREE.Mesh(rugGeo, new THREE.MeshStandardMaterial({
          map: this.textures.rugMap, roughness: 0.92, metalness: 0.02,
        }));
        rug.position.set(room.center.x, 0.025, room.center.z);
        rug.receiveShadow = true;
        this.group.add(rug);
      }
      if (room.type === 'boss') {
        const runeGeo = new THREE.PlaneGeometry(9, 9);
        runeGeo.rotateX(-Math.PI / 2);
        const rune = new THREE.Mesh(runeGeo, new THREE.MeshBasicMaterial({
          map: this.textures.runeMap, color: 0xff5a22, transparent: true, opacity: 0.34,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
        }));
        rune.position.set(room.center.x, 0.04, room.center.z);
        this.group.add(rune);
        this._bossSeal = rune;
      }
      // pillars at the four corners
      const inset = 1.35;
      const corners = [
        [b.minX + inset, b.minZ + inset],
        [b.maxX - inset, b.minZ + inset],
        [b.minX + inset, b.maxZ - inset],
        [b.maxX - inset, b.maxZ - inset],
      ];
      for (const [x, z] of corners) {
        if (!this.isWalkable(x, z, 0.6)) continue;
        const pg = new THREE.Mesh(pillarGeo, stoneMat);
        pg.position.set(x, (WALL_H + 0.35) / 2, z);
        pg.castShadow = true;
        pg.receiveShadow = true;
        this.group.add(pg);
        const base = new THREE.Mesh(pillarBaseGeo, darkStone);
        base.position.set(x, 0.2, z);
        base.castShadow = true;
        this.group.add(base);
        const cap = new THREE.Mesh(pillarCapGeo, trimMat);
        cap.position.set(x, WALL_H + 0.18, z);
        cap.castShadow = true;
        this.group.add(cap);
        this._blockers.push({ x, z, radius: 0.62 });
      }
      // braziers on two opposite sides
      const brazierPositions = [
        [room.center.x - room.size.x * 0.36, room.center.z - room.size.z * 0.36],
        [room.center.x + room.size.x * 0.36, room.center.z + room.size.z * 0.36],
      ];
      for (const [x, z] of brazierPositions) {
        if (!this.isWalkable(x, z, 0.6)) continue;
        this._addBrazier(x, z, metalMat, coalMat);
        this._blockers.push({ x, z, radius: 0.48 });
      }
    }

    // rubble
    const rubbleGeo = new THREE.DodecahedronGeometry(0.18, 0);
    const rubbleMat = new THREE.MeshStandardMaterial({ color: 0x3b342c, roughness: 1 });
    const rubble = new THREE.InstancedMesh(rubbleGeo, rubbleMat, 110);
    rubble.castShadow = true;
    rubble.receiveShadow = true;
    const dummy = new THREE.Object3D();
    let n = 0;
    for (const room of this.rooms) {
      const count = room.type === 'boss' ? 26 : 17;
      for (let i = 0; i < count && n < 110; i++) {
        const x = room.bounds.minX + 0.6 + this._rng() * (room.size.x - 1.2);
        const z = room.bounds.minZ + 0.6 + this._rng() * (room.size.z - 1.2);
        if (!this.isWalkable(x, z, 0.2)) continue;
        dummy.position.set(x, 0.08 + this._rng() * 0.08, z);
        dummy.rotation.set(this._rng() * Math.PI, this._rng() * Math.PI, this._rng() * Math.PI);
        const s = 0.4 + this._rng() * 1.3;
        dummy.scale.set(s, s * 0.7, s);
        dummy.updateMatrix();
        rubble.setMatrixAt(n++, dummy.matrix);
      }
    }
    rubble.count = n;
    this.group.add(rubble);

    // scattered bones
    const boneMat = new THREE.MeshStandardMaterial({ color: 0x9a8f78, roughness: 0.8 });
    const boneGeo = new THREE.CapsuleGeometry(0.035, 0.32, 2, 4);
    for (let i = 0; i < 34; i++) {
      const room = this.rooms[Math.floor(this._rng() * this.rooms.length)];
      const x = room.bounds.minX + 1 + this._rng() * (room.size.x - 2);
      const z = room.bounds.minZ + 1 + this._rng() * (room.size.z - 2);
      if (!this.isWalkable(x, z, 0.1)) continue;
      const bone = new THREE.Mesh(boneGeo, boneMat);
      bone.position.set(x, 0.06, z);
      bone.rotation.set(Math.PI / 2, this._rng() * Math.PI, this._rng() * 0.5);
      bone.castShadow = true;
      this.group.add(bone);
    }
  }

  _addBrazier(x, z, metalMat, coalMat) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.28, 0.95, 6), metalMat);
    pedestal.position.y = 0.48;
    pedestal.castShadow = true;
    g.add(pedestal);
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.32, 0.25, 8), metalMat);
    bowl.position.y = 1.04;
    bowl.castShadow = true;
    g.add(bowl);
    const coals = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 0), coalMat);
    coals.position.y = 1.16;
    coals.scale.y = 0.5;
    g.add(coals);
    const flameMat = new THREE.SpriteMaterial({
      map: this.textures.flameMap, color: 0xffa45e, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const flame = new THREE.Sprite(flameMat);
    flame.position.y = 1.75;
    flame.scale.set(1.1, 1.65, 1);
    g.add(flame);
    const innerMat = flameMat.clone();
    innerMat.color.setHex(0xfff0b0);
    const inner = new THREE.Sprite(innerMat);
    inner.position.y = 1.65;
    inner.scale.set(0.55, 0.9, 1);
    g.add(inner);
    const light = new THREE.PointLight(0xff7a2f, 34, 10, 2);
    light.position.set(0, 1.7, 0);
    g.add(light);
    this.group.add(g);
    this._flames.push({
      flame, inner, light, phase: this._rng() * Math.PI * 2,
      base: 28 + this._rng() * 12, x, z,
    });
  }

  _buildPortal() {
    const boss = this.rooms[this.rooms.length - 1];
    const center = boss.center;
    const group = new THREE.Group();
    group.position.set(center.x, 0, center.z);
    this.group.add(group);

    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffb45e, transparent: true, opacity: 0.7,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    this._portalRings = [];
    for (let i = 0; i < 3; i++) {
      const r = 1.65 + i * 0.35;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.055 + i * 0.015, 6, 48), ringMat.clone());
      ring.position.y = 2.05;
      ring.rotation.z = i * 0.7;
      ring.rotation.x = i === 1 ? 0.5 : 0;
      group.add(ring);
      this._portalRings.push(ring);
    }
    const shader = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
      `,
      fragmentShader: `
        uniform float uTime; varying vec2 vUv;
        void main(){
          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p);
          float a = atan(p.y, p.x);
          float swirl = sin(a * 5.0 + r * 12.0 - uTime * 2.6) * 0.5 + 0.5;
          float core = smoothstep(1.0, 0.08, r);
          float ring = smoothstep(0.9, 0.62, r) * smoothstep(0.5, 0.64, r);
          vec3 col = mix(vec3(0.55, 0.08, 0.01), vec3(1.0, 0.78, 0.3), swirl);
          col += vec3(0.4, 0.1, 0.0) * ring;
          float alpha = (core * 0.8 + ring * 0.6) * smoothstep(1.0, 0.85, r);
          gl_FragColor = vec4(col * (0.7 + core * 1.2), alpha);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const swirl = new THREE.Mesh(new THREE.PlaneGeometry(3.3, 3.3), shader);
    swirl.position.y = 2.05;
    group.add(swirl);
    this._portalShader = shader;
    this._portalSwirl = swirl;

    const light = new THREE.PointLight(0xff7a2f, 0, 16, 2);
    light.position.set(0, 2.2, 0);
    group.add(light);
    this._portalLight = light;

    // floating embers around the gate
    const emberMat = new THREE.SpriteMaterial({
      map: this.textures.dustMap, color: 0xffa45e, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    this._portalEmbers = [];
    for (let i = 0; i < 14; i++) {
      const s = new THREE.Sprite(emberMat.clone());
      s.scale.setScalar(0.12 + this._rng() * 0.2);
      s.userData.phase = this._rng() * Math.PI * 2;
      s.userData.radius = 1.2 + this._rng() * 1.8;
      s.userData.speed = 0.3 + this._rng() * 0.6;
      s.userData.height = 0.5 + this._rng() * 3;
      group.add(s);
      this._portalEmbers.push(s);
    }
    this._portalGroup = group;
  }

  _setPortalActive(v) {
    this.exitPortal && (this.exitPortal.active = v);
    if (!this._portalGroup) return;
    this._portalGroup.visible = v;
    this._portalLight.intensity = v ? 55 : 0;
    if (this._bossSeal) this._bossSeal.material.opacity = v ? 0.85 : 0.34;
  }

  _buildDust() {
    const count = 320;
    const pos = new Float32Array(count * 3);
    this._dustBase = new Float32Array(count * 3);
    const rooms = this.rooms;
    for (let i = 0; i < count; i++) {
      const room = rooms[Math.floor(this._rng() * rooms.length)];
      const x = room.bounds.minX + this._rng() * room.size.x;
      const z = room.bounds.minZ + this._rng() * room.size.z;
      const y = 0.2 + this._rng() * 3.2;
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      this._dustBase[i * 3] = x; this._dustBase[i * 3 + 1] = y; this._dustBase[i * 3 + 2] = z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      map: this.textures.dustMap, color: 0xffcf9a, size: 0.07,
      transparent: true, opacity: 0.35, depthWrite: false,
      blending: THREE.AdditiveBlending, sizeAttenuation: true, fog: true,
    });
    this._dust = new THREE.Points(geo, mat);
    this.group.add(this._dust);
  }

  _buildSpawnPoints() {
    for (const room of this.rooms) {
      const b = room.bounds;
      const points = [];
      if (room.type === 'boss') {
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          const x = room.center.x + Math.cos(a) * Math.min(4.5, room.size.x * 0.28);
          const z = room.center.z + Math.sin(a) * Math.min(4.5, room.size.z * 0.28);
          if (this.isWalkable(x, z, 0.8)) points.push(new THREE.Vector3(x, 0, z));
        }
      } else {
        const inset = 1.7;
        const candidates = [
          [b.minX + inset, b.minZ + inset],
          [b.maxX - inset, b.minZ + inset],
          [b.minX + inset, b.maxZ - inset],
          [b.maxX - inset, b.maxZ - inset],
          [(b.minX + b.maxX) / 2, b.minZ + inset],
          [(b.minX + b.maxX) / 2, b.maxZ - inset],
          [b.minX + inset, (b.minZ + b.maxZ) / 2],
          [b.maxX - inset, (b.minZ + b.maxZ) / 2],
        ];
        for (const [x, z] of candidates) {
          if (this.isWalkable(x, z, 0.75)) points.push(new THREE.Vector3(x, 0, z));
        }
      }
      room.spawnPoints = points.length ? points : [room.center.clone()];
    }
  }

  worldToCell(x, z) {
    return {
      col: Math.floor(x / CELL + W / 2),
      row: Math.floor(z / CELL + H / 2),
    };
  }

  cellToWorld(col, row) {
    return {
      x: (col - W / 2 + 0.5) * CELL,
      z: (row - H / 2 + 0.5) * CELL,
    };
  }

  isWalkable(x, z, radius = 0.4) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    const check = (sx, sz) => {
      const c = this.worldToCell(sx, sz);
      if (c.col < 0 || c.col >= W || c.row < 0 || c.row >= H) return false;
      return !!this.grid[c.row][c.col];
    };
    if (!check(x, z)) return false;
    if (radius > 0) {
      const r = radius;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        if (!check(x + Math.cos(a) * r, z + Math.sin(a) * r)) return false;
      }
    }
    for (const b of this._blockers) {
      const dx = x - b.x, dz = z - b.z;
      if (dx * dx + dz * dz < (radius + b.radius) ** 2) return false;
    }
    return true;
  }

  getRoomAt(position) {
    const x = position.x, z = position.z;
    for (const room of this.rooms) {
      const b = room.bounds;
      if (x >= b.minX - 0.25 && x <= b.maxX + 0.25 && z >= b.minZ - 0.25 && z <= b.maxZ + 0.25) return room;
    }
    return null;
  }

  roomCenter(index) {
    return this.rooms[index]?.center?.clone() ?? new THREE.Vector3();
  }

  update(dt, elapsed) {
    for (const f of this._flames) {
      const t = elapsed * 2.4 + f.phase;
      const flick = 0.78 + Math.sin(t) * 0.13 + Math.sin(t * 2.7) * 0.08;
      f.flame.scale.set(1.1 * flick, 1.65 * (0.88 + flick * 0.2), 1);
      f.inner.scale.set(0.55 * flick, 0.9 * flick, 1);
      f.light.intensity = f.base * flick;
      f.flame.position.x = Math.sin(t * 0.9) * 0.05;
      f.inner.position.x = Math.sin(t * 1.3 + 1) * 0.04;
    }
    if (this._portalShader) this._portalShader.uniforms.uTime.value = elapsed;
    if (this._portalRings) {
      for (let i = 0; i < this._portalRings.length; i++) {
        const r = this._portalRings[i];
        r.rotation.z += dt * (0.25 + i * 0.16);
        r.rotation.x = Math.sin(elapsed * 0.4 + i) * 0.35;
        r.material.opacity = 0.45 + Math.sin(elapsed * 2 + i) * 0.18;
      }
    }
    if (this._portalEmbers) {
      for (const s of this._portalEmbers) {
        const p = s.userData;
        p.phase += dt * p.speed;
        s.position.x = Math.cos(p.phase) * p.radius;
        s.position.z = Math.sin(p.phase) * p.radius;
        s.position.y = p.height + Math.sin(p.phase * 2) * 0.3;
        s.material.opacity = 0.35 + Math.sin(p.phase * 3) * 0.25;
      }
    }
    if (this._dust) {
      const attr = this._dust.geometry.attributes.position;
      const t = elapsed;
      for (let i = 0; i < attr.count; i++) {
        attr.array[i * 3] = this._dustBase[i * 3] + Math.sin(t * 0.18 + i) * 0.35;
        attr.array[i * 3 + 1] = this._dustBase[i * 3 + 1] + Math.sin(t * 0.3 + i * 1.7) * 0.22;
        attr.array[i * 3 + 2] = this._dustBase[i * 3 + 2] + Math.cos(t * 0.15 + i * 0.7) * 0.35;
      }
      attr.needsUpdate = true;
    }
    if (this._portalLight && this.exitPortal?.active) {
      this._portalLight.intensity = 48 + Math.sin(elapsed * 3.4) * 12;
    }
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          for (const k of Object.keys(m)) {
            const v = m[k];
            if (v && v.isTexture) v.dispose();
          }
          m.dispose();
        }
      }
    });
    this.scene.remove(this.group);
    this.textures._canvases = null;
    if (this.scene.fog) this.scene.fog = null;
  }
}
