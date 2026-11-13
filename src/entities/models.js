import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// Procedural low-poly character models. Geometries are cached and shared across
// every instance of a type; materials are cloned per instance so hit-flash and
// status tinting never leak between enemies.

const GEO = new Map();

function cached(key, make) {
  let g = GEO.get(key);
  if (!g) {
    g = make();
    GEO.set(key, g);
  }
  return g;
}

const box = (w, h, d) => cached(`b${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d));
const cyl = (rt, rb, h, s = 6) =>
  cached(`c${rt},${rb},${h},${s}`, () => new THREE.CylinderGeometry(rt, rb, h, s));
const ico = (r, d = 0) => cached(`i${r},${d}`, () => new THREE.IcosahedronGeometry(r, d));
const cone = (r, h, s = 6) => cached(`k${r},${h},${s}`, () => new THREE.ConeGeometry(r, h, s));
const torus = (r, t, s = 5, ts = 14, arc = Math.PI * 2) =>
  cached(`t${r},${t},${s},${ts},${arc}`, () => new THREE.TorusGeometry(r, t, s, ts, arc));
const plane = (w, h, sw = 1, sh = 1) =>
  cached(`p${w},${h},${sw},${sh}`, () => new THREE.PlaneGeometry(w, h, sw, sh));

// Broad bevels catch dungeon light; shared geometry keeps instance cost low.
const plate = (w, h, d) => cached(`plate${w},${h},${d}`, () =>
  new RoundedBoxGeometry(w, h, d, 1, Math.min(w, h, d) * 0.22));

function mantle(w, h) {
  return cached(`mantle${w},${h}`, () => {
    const g = new THREE.PlaneGeometry(w, h, 8, 5);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i) / w;
      const t = 0.5 - p.getY(i) / h;
      p.setXYZ(i, u * w * (0.58 + t * 0.42),
        p.getY(i) + (t === 1 ? (i % 2) * h * 0.07 : 0),
        -t * t * h * 0.22 + Math.cos(u * Math.PI * 8) * w * 0.055 * (0.3 + t));
    }
    g.computeVertexNormals();
    return g;
  });
}

function hoodGeometry() {
  return cached('openHood', () => {
    const vertices = [], indices = [];
    const rings = [[0.27, -0.15], [0.29, 0.08], [0.22, 0.3], [0.035, 0.4]];
    for (const [radius, y] of rings) {
      for (let i = 0; i <= 8; i++) {
        const a = 0.72 + i / 8 * (Math.PI * 2 - 1.44);
        vertices.push(Math.sin(a) * radius, y, Math.cos(a) * radius - 0.045);
      }
    }
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 8; col++) {
        const a = row * 9 + col, b = a + 9;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    g.setIndex(indices);
    g.computeVertexNormals();
    return g;
  });
}

const _proto = new Map();

function protoMat(key, opts) {
  let m = _proto.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ flatShading: true, ...opts });
    _proto.set(key, m);
  }
  return m;
}

function cloneMat(key, opts) {
  return protoMat(key, opts).clone();
}

function std(color, opts = {}) {
  return cloneMat(`s${color}:${JSON.stringify(opts)}`, { color, metalness: 0.1, roughness: 0.62, ...opts });
}

function glow(color, intensity = 2) {
  return cloneMat(`g${color},${intensity}`, {
    color: 0x111111,
    emissive: color,
    emissiveIntensity: intensity,
    metalness: 0.1,
    roughness: 0.4,
  });
}

function mesh(geo, material, cast = true) {
  const m = new THREE.Mesh(geo, material);
  m.castShadow = cast;
  m.receiveShadow = false;
  return m;
}

function pivot(x, y, z, parent) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

function markMaterials(materials) {
  const seen = new Set();
  const list = [];
  for (const m of Object.values(materials)) {
    if (m && m.isMaterial && !seen.has(m)) {
      seen.add(m);
      list.push(m);
    }
  }
  return list;
}

function finalize(group, parts, materials, meta = {}) {
  group.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
    }
  });
  return { group, parts, materials: markMaterials(materials), meta };
}

/* ------------------------------------------------------------------ player */

export function buildPlayerModel() {
  const group = new THREE.Group();
  const mats = {
    armor: std(0x586979, { metalness: 0.65, roughness: 0.38 }),
    armorDark: std(0x252d38, { metalness: 0.55, roughness: 0.5 }),
    trim: std(0xc29450, { metalness: 0.72, roughness: 0.34 }),
    cloth: std(0x7b2934, { metalness: 0, roughness: 0.92, side: THREE.DoubleSide }),
    hood: std(0x452631, { metalness: 0, roughness: 0.9, side: THREE.DoubleSide }),
    leather: std(0x40251c, { metalness: 0, roughness: 0.8 }),
    ember: glow(0xff6b2b, 2.6),
    emberSoft: glow(0xffa45e, 1.4),
    steel: std(0xb9c2cf, { metalness: 0.95, roughness: 0.22 }),
    bladeGlow: glow(0xc4622c, 0.55),
    visor: std(0x0a0a0c, { metalness: 0.9, roughness: 0.2 }),
  };

  const torso = pivot(0, 0, 0, group);
  const hips = mesh(box(0.42, 0.24, 0.3), mats.armorDark);
  hips.position.y = 0.94;
  torso.add(hips);

  const chest = mesh(plate(0.58, 0.55, 0.38), mats.armor);
  chest.position.y = 1.28;
  torso.add(chest);
  const chestPlate = mesh(plate(0.4, 0.34, 0.09), mats.armorDark);
  chestPlate.position.set(0, 1.32, 0.2);
  torso.add(chestPlate);

  // glowing chest rune
  const rune = mesh(torus(0.09, 0.022, 4, 12), mats.ember, false);
  rune.position.set(0, 1.34, 0.245);
  torso.add(rune);
  const runeCore = mesh(ico(0.055, 0), mats.emberSoft, false);
  runeCore.position.set(0, 1.34, 0.25);
  torso.add(runeCore);

  // belt + tassets
  const belt = mesh(box(0.5, 0.09, 0.36), mats.trim);
  belt.position.y = 1.03;
  torso.add(belt);
  for (const sx of [-1, 1]) {
    const tasset = mesh(box(0.2, 0.3, 0.05), mats.armor);
    tasset.position.set(sx * 0.19, 0.86, 0.17);
    tasset.rotation.x = -0.16;
    torso.add(tasset);
  }

  // head + hood
  const headPivot = pivot(0, 1.56, 0, torso);
  const head = mesh(box(0.24, 0.24, 0.24), mats.visor);
  head.position.y = 0.08;
  headPivot.add(head);
  const hood = mesh(hoodGeometry(), mats.hood);
  hood.position.set(0, 0.02, 0);
  headPivot.add(hood);
  const hoodBack = mesh(box(0.36, 0.34, 0.16), mats.cloth);
  hoodBack.position.set(0, 0.02, -0.16);
  headPivot.add(hoodBack);

  const eyes = [];
  for (const sx of [-1, 1]) {
    const eye = mesh(box(0.045, 0.022, 0.02), mats.ember, false);
    eye.position.set(sx * 0.055, 0.075, 0.125);
    headPivot.add(eye);
    eyes.push(eye);
  }

  // shoulder pauldrons
  for (const sx of [-1, 1]) {
    const pauldron = mesh(plate(0.31, 0.2, 0.38), mats.armor);
    pauldron.position.set(sx * 0.35, 1.51, 0);
    pauldron.rotation.z = sx * -0.18;
    torso.add(pauldron);
    const rim = mesh(plate(0.32, 0.045, 0.39), mats.trim);
    rim.position.set(sx * 0.35, 1.45, 0);
    rim.rotation.z = sx * -0.18;
    torso.add(rim);
    const spike = mesh(cone(0.05, 0.16, 4), mats.trim);
    spike.position.set(sx * 0.4, 1.62, -0.02);
    spike.rotation.z = sx * 0.5;
    torso.add(spike);
  }

  // arms
  const armL = pivot(-0.3, 1.48, 0, torso);
  const armR = pivot(0.3, 1.48, 0, torso);
  for (const [arm, sx] of [[armL, -1], [armR, 1]]) {
    const upper = mesh(cyl(0.075, 0.065, 0.34), mats.armorDark);
    upper.position.y = -0.18;
    arm.add(upper);
    const fore = mesh(plate(0.16, 0.3, 0.17), mats.armor);
    fore.position.y = -0.48;
    arm.add(fore);
    const hand = mesh(box(0.1, 0.11, 0.1), mats.leather);
    hand.position.y = -0.66;
    arm.add(hand);
    arm.rotation.z = sx * 0.06;
  }

  // legs
  const legL = pivot(-0.14, 0.92, 0, group);
  const legR = pivot(0.14, 0.92, 0, group);
  for (const leg of [legL, legR]) {
    const thigh = mesh(box(0.17, 0.42, 0.18), mats.armorDark);
    thigh.position.y = -0.22;
    leg.add(thigh);
    const shin = mesh(plate(0.17, 0.4, 0.19), mats.armor);
    shin.position.y = -0.62;
    leg.add(shin);
    const knee = mesh(ico(0.105), mats.trim);
    knee.position.set(0, -0.42, 0.08);
    knee.scale.set(0.85, 1, 0.5);
    leg.add(knee);
    const boot = mesh(box(0.17, 0.14, 0.28), mats.leather);
    boot.position.set(0, -0.84, 0.05);
    leg.add(boot);
  }

  // cloak
  const cloak = mesh(mantle(0.9, 1.18), mats.cloth);
  cloak.position.set(0, 1.22, -0.21);
  cloak.rotation.x = 0.08;
  torso.add(cloak);
  const cloakTrim = mesh(mantle(0.72, 0.09), mats.trim);
  cloakTrim.material.side = THREE.DoubleSide;
  cloakTrim.position.set(0, 0.66, -0.46);
  torso.add(cloakTrim);

  // sword
  const sword = new THREE.Group();
  sword.position.set(0.02, -0.64, 0.06);
  sword.rotation.set(1.15, 0, 0.12); // blade extends forward from the hand
  armR.add(sword);
  const grip = mesh(cyl(0.022, 0.026, 0.24, 5), mats.leather);
  grip.position.y = -0.06;
  sword.add(grip);
  const guard = mesh(box(0.26, 0.04, 0.06), mats.trim);
  guard.position.y = 0.08;
  sword.add(guard);
  const blade = mesh(cyl(0, 0.055, 1.12, 4), mats.steel);
  blade.position.y = 0.66;
  sword.add(blade);
  blade.scale.z = 0.4;
  const edge = mesh(box(0.016, 1.08, 0.02), mats.bladeGlow, false);
  edge.position.set(0.03, 0.66, 0.005);
  sword.add(edge);
  const tip = new THREE.Object3D();
  tip.position.set(0, 1.22, 0);
  sword.add(tip);

  // sword trail anchor (world-space arc origin)
  const trailAnchor = new THREE.Object3D();
  trailAnchor.position.y = 1.25;
  torso.add(trailAnchor);

  group.scale.setScalar(1);
  return finalize(group, {
    torso, head: headPivot, armL, armR, legL, legR, cloak, cloakTrim,
    sword, swordTip: tip, trailAnchor, rune, runeCore, eyes, chest,
  }, mats, { height: 1.8 });
}

/* --------------------------------------------------------------- skeletons */

export function buildSkeletonModel(variant = 'skeleton') {
  const group = new THREE.Group();
  const isArcher = variant === 'archer';
  const mats = {
    bone: std(0xd6cdb4, { roughness: 0.75, metalness: 0.05 }),
    boneDark: std(0x8f846c, { roughness: 0.85 }),
    cloth: std(isArcher ? 0x3d5948 : 0x594038, { metalness: 0, roughness: 0.95, side: THREE.DoubleSide }),
    rust: std(0x7a5238, { metalness: 0.7, roughness: 0.6 }),
    steel: std(0x9aa3ad, { metalness: 0.85, roughness: 0.35 }),
    accent: glow(isArcher ? 0xffb45e : 0x9dffcf, 2.2),
    wood: std(0x4a2f1d, { roughness: 0.9 }),
    socket: std(0x201e22, { metalness: 0, roughness: 1 }),
  };

  const torso = pivot(0, 0, 0, group);
  const spine = mesh(cyl(0.07, 0.09, 0.62, 5), mats.bone);
  spine.position.y = 1.16;
  torso.add(spine);

  // ribcage
  for (let i = 0; i < 4; i++) {
    const rib = mesh(torus(0.2 - i * 0.012, 0.026, 4, 12, Math.PI * 1.5), mats.bone);
    rib.position.set(0, 1.36 - i * 0.09, 0);
    rib.rotation.set(Math.PI / 2, 0, Math.PI / 2);
    torso.add(rib);
  }
  const sternum = mesh(box(0.06, 0.3, 0.04), mats.boneDark);
  sternum.position.set(0, 1.3, 0.2);
  torso.add(sternum);

  // tattered tabard
  const tabard = mesh(mantle(0.46, 0.85), mats.cloth);
  tabard.position.set(0, 0.78, -0.06);
  tabard.rotation.x = 0.12;
  torso.add(tabard);

  // skull
  const headPivot = pivot(0, 1.62, 0, torso);
  const skull = mesh(ico(0.19, 1), mats.bone);
  skull.scale.set(1, 1.1, 0.95);
  headPivot.add(skull);
  const jaw = mesh(plate(0.21, 0.09, 0.15), mats.bone);
  jaw.position.set(0, -0.12, 0.03);
  headPivot.add(jaw);
  for (const sx of [-1, 1]) {
    const socket = mesh(ico(0.062), mats.socket);
    socket.scale.set(1, 0.85, 0.35);
    socket.position.set(sx * 0.075, 0.03, 0.16);
    headPivot.add(socket);
    const eye = mesh(box(0.028, 0.028, 0.02), mats.accent, false);
    eye.position.set(sx * 0.075, 0.03, 0.18);
    headPivot.add(eye);
  }
  const nose = mesh(cone(0.035, 0.07, 3), mats.socket);
  nose.position.set(0, -0.04, 0.175);
  nose.rotation.z = Math.PI;
  headPivot.add(nose);

  // arms
  const armL = pivot(-0.22, 1.48, 0, torso);
  const armR = pivot(0.22, 1.48, 0, torso);
  for (const arm of [armL, armR]) {
    const upper = mesh(cyl(0.045, 0.04, 0.4, 5), mats.bone);
    upper.position.y = -0.2;
    arm.add(upper);
    const fore = mesh(cyl(0.035, 0.045, 0.36, 5), mats.boneDark);
    fore.position.y = -0.58;
    arm.add(fore);
  }

  // legs
  const legL = pivot(-0.13, 0.86, 0, group);
  const legR = pivot(0.13, 0.86, 0, group);
  for (const leg of [legL, legR]) {
    const thigh = mesh(cyl(0.05, 0.04, 0.42, 5), mats.bone);
    thigh.position.y = -0.22;
    leg.add(thigh);
    const shin = mesh(cyl(0.04, 0.03, 0.4, 5), mats.boneDark);
    shin.position.y = -0.62;
    leg.add(shin);
    const foot = mesh(box(0.1, 0.07, 0.22), mats.bone);
    foot.position.set(0, -0.84, 0.05);
    leg.add(foot);
  }

  let weapon = null;
  let muzzle = new THREE.Object3D();
  if (isArcher) {
    weapon = new THREE.Group();
    weapon.position.set(-0.06, -0.5, 0.14);
    weapon.rotation.set(0, 0, Math.PI / 2);
    armL.add(weapon);
    const limb = mesh(torus(0.42, 0.03, 4, 14, Math.PI * 1.1), mats.wood);
    limb.rotation.z = Math.PI * 0.45;
    weapon.add(limb);
    const string = mesh(box(0.006, 0.82, 0.006), mats.boneDark);
    string.position.x = -0.38;
    weapon.add(string);
    const grip = mesh(cyl(0.035, 0.035, 0.16, 5), mats.cloth);
    grip.rotation.z = Math.PI / 2;
    weapon.add(grip);
    muzzle.position.set(-0.3, 0, 0);
    weapon.add(muzzle);
    // quiver
    const quiver = mesh(cyl(0.09, 0.07, 0.5, 6), mats.wood);
    quiver.position.set(0.1, 1.22, -0.18);
    quiver.rotation.z = 0.35;
    torso.add(quiver);
    for (let i = 0; i < 3; i++) {
      const arrow = mesh(cyl(0.009, 0.009, 0.36, 4), mats.bone);
      arrow.position.set(0.03 + i * 0.055, 1.53, -0.18);
      arrow.rotation.z = 0.35;
      torso.add(arrow);
    }
  } else {
    weapon = new THREE.Group();
    weapon.position.set(0.02, -0.66, 0.05);
    weapon.rotation.set(-0.55, 0, 0.08);
    armR.add(weapon);
    const grip = mesh(cyl(0.025, 0.025, 0.2, 5), mats.cloth);
    weapon.add(grip);
    const guard = mesh(box(0.2, 0.035, 0.05), mats.rust);
    guard.position.y = 0.09;
    weapon.add(guard);
    const blade = mesh(box(0.06, 0.9, 0.02), mats.steel);
    blade.position.y = 0.55;
    blade.rotation.z = 0.04;
    weapon.add(blade);
    muzzle.position.set(0, 1.0, 0);
    weapon.add(muzzle);
  }

  // shoulder cloth scraps
  for (const sx of [-1, 1]) {
    const rag = mesh(plane(0.18, 0.28), mats.cloth);
    rag.position.set(sx * 0.24, 1.4, -0.04);
    rag.rotation.y = sx * 0.3;
    torso.add(rag);
  }

  return finalize(group, {
    torso, head: headPivot, armL, armR, legL, legR, weapon, muzzle,
    accentMats: [mats.accent],
  }, mats, { height: isArcher ? 1.8 : 1.75, variant });
}

/* --------------------------------------------------------------- cultists */

export function buildCultistModel() {
  const group = new THREE.Group();
  const mats = {
    robe: std(0x63344f, { metalness: 0, roughness: 0.92 }),
    robeDark: std(0x302139, { metalness: 0, roughness: 0.95, side: THREE.DoubleSide }),
    trim: std(0x7d5a32, { metalness: 0.7, roughness: 0.4 }),
    skin: std(0x8f7c74, { roughness: 0.8 }),
    staff: std(0x2f2118, { roughness: 0.85 }),
    orb: glow(0xff4d6d, 2.8),
    rune: glow(0xff7a4d, 1.8),
    void: glow(0xc04dff, 1.6),
  };

  const torso = pivot(0, 0, 0, group);
  const robe = mesh(cyl(0.24, 0.5, 1.24, 8), mats.robe);
  robe.position.y = 0.62;
  torso.add(robe);
  const robeTrim = mesh(cyl(0.5, 0.52, 0.08, 8), mats.trim);
  robeTrim.position.y = 0.06;
  torso.add(robeTrim);

  const sash = mesh(cyl(0.27, 0.31, 0.1, 8), mats.trim);
  sash.position.y = 1.1;
  torso.add(sash);
  const chestRune = mesh(torus(0.07, 0.018, 4, 10), mats.rune, false);
  chestRune.position.set(0, 1.16, 0.22);
  torso.add(chestRune);

  const headPivot = pivot(0, 1.35, 0, torso);
  const head = mesh(ico(0.15, 0), mats.skin);
  head.scale.set(1, 1.05, 0.95);
  headPivot.add(head);
  const hood = mesh(hoodGeometry(), mats.robeDark);
  hood.position.set(0, 0.02, 0);
  headPivot.add(hood);
  for (const sx of [-1, 1]) {
    const eye = mesh(box(0.04, 0.02, 0.02), mats.rune, false);
    eye.position.set(sx * 0.055, 0.02, 0.14);
    headPivot.add(eye);
  }
  const stole = mesh(mantle(0.2, 0.92), mats.trim);
  stole.position.set(0, 0.67, 0.37);
  stole.rotation.x = -0.24;
  torso.add(stole);

  // arms with wide sleeves
  const armL = pivot(-0.3, 1.22, 0, torso);
  const armR = pivot(0.3, 1.22, 0, torso);
  for (const [arm, sx] of [[armL, -1], [armR, 1]]) {
    const sleeve = mesh(cyl(0.1, 0.16, 0.5, 6), mats.robe);
    sleeve.position.y = -0.24;
    arm.add(sleeve);
    const hand = mesh(box(0.09, 0.1, 0.09), mats.skin);
    hand.position.y = -0.5;
    arm.add(hand);
    arm.rotation.z = sx * 0.08;
  }

  // staff
  const weapon = new THREE.Group();
  weapon.position.set(0.02, -0.52, 0.08);
  weapon.rotation.set(-0.2, 0, 0);
  armR.add(weapon);
  const shaft = mesh(cyl(0.03, 0.035, 1.7, 6), mats.staff);
  shaft.position.y = 0.2;
  weapon.add(shaft);
  const cage = mesh(torus(0.13, 0.025, 4, 10), mats.trim);
  cage.position.y = 1.06;
  cage.rotation.x = Math.PI / 2;
  weapon.add(cage);
  const halo = mesh(torus(0.2, 0.025, 4, 8), mats.trim);
  halo.position.y = 1.06;
  weapon.add(halo);
  const orb = mesh(ico(0.11, 0), mats.orb, false);
  orb.position.y = 1.06;
  weapon.add(orb);
  const muzzle = new THREE.Object3D();
  muzzle.position.y = 1.12;
  weapon.add(muzzle);

  // floating rune shards
  const runes = [];
  for (let i = 0; i < 3; i++) {
    const shard = mesh(box(0.06, 0.14, 0.02), mats.void, false);
    shard.position.set(Math.cos(i * 2.1) * 0.55, 1.0 + i * 0.18, Math.sin(i * 2.1) * 0.55);
    torso.add(shard);
    runes.push(shard);
  }

  return finalize(group, {
    torso, head: headPivot, armL, armR, weapon, muzzle, orb, runes,
    accentMats: [mats.orb],
  }, mats, { height: 1.8 });
}

/* ------------------------------------------------------------------ brutes */

export function buildBruteModel() {
  const group = new THREE.Group();
  const mats = {
    flesh: std(0x8b8174, { roughness: 0.9 }),
    hide: std(0x4b3a2c, { roughness: 0.95 }),
    armor: std(0x4b5960, { metalness: 0.55, roughness: 0.6 }),
    iron: std(0x6b625a, { metalness: 0.8, roughness: 0.5 }),
    ember: glow(0xff7a35, 2.2),
    bone: std(0xcfc3a8, { roughness: 0.8 }),
  };

  const torso = pivot(0, 0, 0, group);
  const body = mesh(ico(0.52, 1), mats.flesh);
  body.position.y = 1.28;
  body.scale.set(1.15, 1.2, 0.95);
  torso.add(body);

  const belly = mesh(ico(0.4, 1), mats.hide);
  belly.position.set(0, 0.86, 0.05);
  belly.scale.set(1.1, 0.8, 1);
  torso.add(belly);

  // shoulder plates + back spikes
  for (const sx of [-1, 1]) {
    const plate = mesh(ico(0.24, 0), mats.armor);
    plate.position.set(sx * 0.52, 1.62, 0);
    plate.scale.set(1.1, 0.9, 1.05);
    torso.add(plate);
    const spike = mesh(cone(0.07, 0.3, 4), mats.bone);
    spike.position.set(sx * 0.62, 1.78, -0.05);
    spike.rotation.z = sx * 0.6;
    torso.add(spike);
  }
  for (let i = 0; i < 3; i++) {
    const spike = mesh(cone(0.06, 0.24, 4), mats.bone);
    spike.position.set((i - 1) * 0.16, 1.7, -0.4);
    spike.rotation.x = -0.5;
    torso.add(spike);
  }

  const headPivot = pivot(0, 1.88, 0.3, torso);
  const head = mesh(ico(0.2, 0), mats.flesh);
  head.scale.set(1, 0.95, 1.1);
  headPivot.add(head);
  const jaw = mesh(box(0.22, 0.1, 0.16), mats.bone);
  jaw.position.set(0, -0.12, 0.1);
  headPivot.add(jaw);
  const brow = mesh(plate(0.33, 0.075, 0.16), mats.armor);
  brow.position.set(0, 0.1, 0.12);
  headPivot.add(brow);
  for (const sx of [-1, 1]) {
    const eye = mesh(box(0.05, 0.03, 0.02), mats.ember, false);
    eye.position.set(sx * 0.07, 0.04, 0.18);
    headPivot.add(eye);
    const tusk = mesh(cone(0.04, 0.17, 5), mats.bone);
    tusk.position.set(sx * 0.12, -0.055, 0.21);
    tusk.rotation.z = sx * -0.25;
    headPivot.add(tusk);
  }
  // crude iron crown
  const crown = mesh(torus(0.22, 0.03, 4, 10), mats.iron);
  crown.position.y = 0.14;
  crown.rotation.x = Math.PI / 2;
  headPivot.add(crown);

  const armL = pivot(-0.52, 1.55, 0, torso);
  const armR = pivot(0.52, 1.55, 0, torso);
  for (const arm of [armL, armR]) {
    const upper = mesh(cyl(0.13, 0.16, 0.5, 6), mats.flesh);
    upper.position.y = -0.26;
    arm.add(upper);
    const fore = mesh(cyl(0.11, 0.15, 0.46, 6), mats.hide);
    fore.position.y = -0.66;
    arm.add(fore);
    const fist = mesh(ico(0.15, 0), mats.flesh);
    fist.position.y = -0.92;
    arm.add(fist);
  }

  const legL = pivot(-0.25, 0.8, 0, group);
  const legR = pivot(0.25, 0.8, 0, group);
  for (const leg of [legL, legR]) {
    const thigh = mesh(cyl(0.14, 0.12, 0.42, 6), mats.flesh);
    thigh.position.y = -0.2;
    leg.add(thigh);
    const shin = mesh(cyl(0.12, 0.1, 0.4, 6), mats.hide);
    shin.position.y = -0.6;
    leg.add(shin);
    const foot = mesh(box(0.2, 0.12, 0.3), mats.hide);
    foot.position.set(0, -0.82, 0.06);
    leg.add(foot);
  }

  // massive cleaver
  const weapon = new THREE.Group();
  weapon.position.set(0.02, -0.9, 0.08);
  weapon.rotation.set(-0.5, 0, 0.1);
  armR.add(weapon);
  const haft = mesh(cyl(0.05, 0.05, 1.1, 6), mats.hide);
  haft.position.y = 0.2;
  weapon.add(haft);
  const cleaver = mesh(box(0.06, 0.9, 0.42), mats.iron);
  cleaver.position.set(0, 0.75, 0.18);
  weapon.add(cleaver);
  const edge = mesh(box(0.04, 0.86, 0.06), mats.ember, false);
  edge.position.set(0, 0.75, 0.4);
  weapon.add(edge);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 1.1, 0.2);
  weapon.add(muzzle);

  return finalize(group, {
    torso, head: headPivot, armL, armR, legL, legR, weapon, muzzle,
    accentMats: [mats.ember],
  }, mats, { height: 2.4 });
}

/* -------------------------------------------------------------------- boss */

export function buildBossModel() {
  const group = new THREE.Group();
  const mats = {
    armor: std(0x52606b, { metalness: 0.65, roughness: 0.4 }),
    armorDark: std(0x241c18, { metalness: 0.7, roughness: 0.5 }),
    iron: std(0x8a7d6c, { metalness: 0.9, roughness: 0.32 }),
    trim: std(0xa07838, { metalness: 0.95, roughness: 0.28 }),
    cloth: std(0x69252a, { metalness: 0, roughness: 0.95, side: THREE.DoubleSide }),
    core: glow(0xff5a22, 3.4),
    coreHot: glow(0xffc06a, 2.6),
    ember: glow(0xff5a22, 2.8),
    crack: glow(0xff7a2b, 2.0),
    steel: std(0x9aa3ad, { metalness: 0.95, roughness: 0.25 }),
    void: glow(0x8a2f18, 1.4),
  };

  const torso = pivot(0, 0, 0, group);
  const body = mesh(plate(1.08, 1.15, 0.68), mats.armor);
  body.position.y = 2.25;
  torso.add(body);
  const chestPlate = mesh(plate(0.78, 0.8, 0.14), mats.armorDark);
  chestPlate.position.set(0, 2.3, 0.35);
  torso.add(chestPlate);

  // glowing core
  const coreHousing = mesh(torus(0.24, 0.05, 4, 14), mats.trim, false);
  coreHousing.position.set(0, 2.3, 0.42);
  torso.add(coreHousing);
  const core = mesh(ico(0.17, 1), mats.core, false);
  core.position.set(0, 2.3, 0.43);
  torso.add(core);
  const coreInner = mesh(ico(0.08, 0), mats.coreHot, false);
  coreInner.position.set(0, 2.3, 0.47);
  torso.add(coreInner);

  // ember cracks across the armor
  const cracks = [];
  for (let i = 0; i < 6; i++) {
    const crack = mesh(box(0.035, 0.4, 0.02), mats.crack, false);
    crack.position.set(-0.32 + (i % 3) * 0.32, 2.5 - Math.floor(i / 3) * 0.5, 0.405);
    crack.rotation.z = (i % 2 ? 1 : -1) * 0.5;
    torso.add(crack);
    cracks.push(crack);
  }

  const hips = mesh(box(0.8, 0.3, 0.5), mats.armorDark);
  hips.position.y = 1.5;
  torso.add(hips);
  for (let i = 0; i < 3; i++) {
    const tasset = mesh(box(0.3, 0.55, 0.07), mats.armor);
    tasset.position.set((i - 1) * 0.28, 1.25, 0.28);
    tasset.rotation.x = -0.14;
    torso.add(tasset);
  }

  // head + crown
  const headPivot = pivot(0, 2.95, 0.02, torso);
  const helm = mesh(plate(0.42, 0.43, 0.38), mats.armorDark);
  headPivot.add(helm);
  const visor = mesh(box(0.26, 0.1, 0.05), mats.iron);
  visor.position.set(0, 0.02, 0.18);
  headPivot.add(visor);
  for (const sx of [-1, 1]) {
    const eye = mesh(box(0.07, 0.035, 0.02), mats.coreHot, false);
    eye.position.set(sx * 0.08, 0.02, 0.205);
    headPivot.add(eye);
  }
  const crown = mesh(torus(0.3, 0.035, 4, 12), mats.trim);
  crown.position.y = 0.22;
  crown.rotation.x = Math.PI / 2;
  headPivot.add(crown);
  const crownSpikes = [];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const spike = mesh(cone(0.05, 0.3 + (i % 3) * 0.12, 4), mats.ember, false);
    spike.position.set(Math.cos(a) * 0.3, 0.34, Math.sin(a) * 0.3);
    spike.rotation.z = Math.cos(a) * 0.25;
    spike.rotation.x = Math.sin(a) * 0.25;
    headPivot.add(spike);
    crownSpikes.push(spike);
  }

  // shoulders
  for (const sx of [-1, 1]) {
    const pauldron = mesh(ico(0.36, 1), mats.armor);
    pauldron.position.set(sx * 0.72, 2.75, 0);
    pauldron.scale.set(1.1, 0.85, 1.05);
    torso.add(pauldron);
    for (let i = 0; i < 2; i++) {
      const spike = mesh(cone(0.07, 0.42, 4), mats.iron);
      spike.position.set(sx * (0.8 + i * 0.08), 2.98, -0.1 + i * 0.18);
      spike.rotation.z = sx * 0.5;
      torso.add(spike);
    }
  }

  // arms
  const armL = pivot(-0.72, 2.6, 0, torso);
  const armR = pivot(0.72, 2.6, 0, torso);
  for (const arm of [armL, armR]) {
    const upper = mesh(cyl(0.16, 0.2, 0.62, 6), mats.armorDark);
    upper.position.y = -0.32;
    arm.add(upper);
    const fore = mesh(plate(0.3, 0.62, 0.3), mats.armor);
    fore.position.y = -0.88;
    arm.add(fore);
    const fist = mesh(ico(0.2, 0), mats.iron);
    fist.position.y = -1.2;
    arm.add(fist);
  }

  // legs
  const legL = pivot(-0.3, 1.5, 0, group);
  const legR = pivot(0.3, 1.5, 0, group);
  for (const leg of [legL, legR]) {
    const thigh = mesh(box(0.3, 0.72, 0.32), mats.armorDark);
    thigh.position.y = -0.38;
    leg.add(thigh);
    const shin = mesh(plate(0.3, 0.68, 0.32), mats.armor);
    shin.position.y = -1.06;
    leg.add(shin);
    const boot = mesh(box(0.32, 0.2, 0.5), mats.iron);
    boot.position.set(0, -1.44, 0.08);
    leg.add(boot);
  }

  // cape
  const cloak = mesh(mantle(1.7, 2.1), mats.cloth);
  cloak.position.set(0, 2.05, -0.4);
  cloak.rotation.x = 0.1;
  torso.add(cloak);

  // huge axe
  const weapon = new THREE.Group();
  weapon.position.set(0.02, -1.2, 0.1);
  weapon.rotation.set(-0.45, 0, 0.08);
  armR.add(weapon);
  const haft = mesh(cyl(0.07, 0.08, 2.4, 6), mats.armorDark);
  haft.position.y = 0.5;
  weapon.add(haft);
  const head = mesh(box(0.14, 0.8, 0.7), mats.iron);
  head.position.set(0, 1.75, 0.25);
  weapon.add(head);
  const blade = mesh(box(0.08, 0.9, 0.5), mats.steel);
  blade.position.set(0, 1.8, 0.66);
  weapon.add(blade);
  const edge = mesh(box(0.06, 0.95, 0.06), mats.ember, false);
  edge.position.set(0, 1.8, 0.93);
  weapon.add(edge);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 2.0, 0.5);
  weapon.add(muzzle);

  return finalize(group, {
    torso, head: headPivot, armL, armR, legL, legR, cloak, weapon, muzzle,
    core, coreInner, cracks, crownSpikes,
    accentMats: [mats.core, mats.coreHot, mats.crack, mats.ember],
  }, mats, { height: 3.9 });
}

export function buildModel(defId, opts = {}) {
  switch (defId) {
    case 'skeleton':
    case 'archer':
      return buildSkeletonModel(defId);
    case 'cultist':
      return buildCultistModel();
    case 'brute':
      return buildBruteModel();
    case 'boss':
      return buildBossModel();
    default:
      return buildSkeletonModel('skeleton');
  }
}
