import * as THREE from 'three';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvas(size = 512) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function tex(c, { srgb = true, repeat = 1, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = aniso;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

function noiseOverlay(ctx, size, rand, amount = 0.08, alpha = 0.5) {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * amount * 255;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
    d[i + 3] = Math.max(0, Math.min(255, d[i + 3] * alpha + 255 * (1 - alpha)));
  }
  ctx.putImageData(img, 0, 0);
}

function cracks(ctx, size, rand, count = 22, color = 'rgba(8,7,6,0.6)') {
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    let x = rand() * size, y = rand() * size;
    ctx.lineWidth = 0.6 + rand() * 1.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const steps = 2 + Math.floor(rand() * 5);
    for (let s = 0; s < steps; s++) {
      x += (rand() - 0.5) * 46;
      y += (rand() - 0.5) * 46;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

export function makeStoneFloor(size = 512) {
  const rand = rng(1337);
  const c = canvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#2a2723';
  ctx.fillRect(0, 0, size, size);
  const tile = size / 4;
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const v = 38 + rand() * 18;
      ctx.fillStyle = `rgb(${v},${v - 2},${v - 6})`;
      ctx.fillRect(x * tile + 2, y * tile + 2, tile - 4, tile - 4);
      ctx.strokeStyle = 'rgba(12,11,9,0.85)';
      ctx.lineWidth = 2;
      ctx.strokeRect(x * tile + 1, y * tile + 1, tile - 2, tile - 2);
      ctx.fillStyle = 'rgba(255,255,255,0.025)';
      ctx.fillRect(x * tile + 6, y * tile + 5, tile - 12, 2);
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      ctx.fillRect(x * tile + 5, y * tile + tile - 9, tile - 10, 4);
    }
  }
  noiseOverlay(ctx, size, rand, 0.13, 0.7);
  cracks(ctx, size, rand, 24);
  // moss / grime patches
  for (let i = 0; i < 18; i++) {
    const x = rand() * size, y = rand() * size, r = 8 + rand() * 34;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(44,50,34,0.22)');
    g.addColorStop(1, 'rgba(44,50,34,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  return c;
}

export function makeStoneHeight(size = 512) {
  const rand = rng(1337);
  const c = canvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#777';
  ctx.fillRect(0, 0, size, size);
  const tile = size / 4;
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const v = 120 + rand() * 40;
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(x * tile + 4, y * tile + 4, tile - 8, tile - 8);
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 3;
      ctx.strokeRect(x * tile + 1, y * tile + 1, tile - 2, tile - 2);
    }
  }
  noiseOverlay(ctx, size, rand, 0.18, 0.9);
  cracks(ctx, size, rand, 20, 'rgba(20,20,20,0.8)');
  return c;
}

export function makeWallStone(size = 512) {
  const rand = rng(4242);
  const c = canvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#24211e';
  ctx.fillRect(0, 0, size, size);
  const rowH = size / 8;
  for (let row = 0; row < 8; row++) {
    const offset = row % 2 === 0 ? 0 : size / 8;
    for (let i = -1; i < 5; i++) {
      const x = i * (size / 4) + offset;
      const v = 42 + rand() * 16;
      ctx.fillStyle = `rgb(${v},${v - 3},${v - 7})`;
      ctx.fillRect(x + 3, row * rowH + 3, size / 4 - 6, rowH - 6);
      ctx.strokeStyle = 'rgba(10,9,8,0.9)';
      ctx.lineWidth = 3;
      ctx.strokeRect(x + 1, row * rowH + 1, size / 4 - 2, rowH - 2);
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(x + 6, row * rowH + 5, size / 4 - 12, 2);
    }
  }
  noiseOverlay(ctx, size, rand, 0.12, 0.8);
  cracks(ctx, size, rand, 18, 'rgba(6,6,5,0.8)');
  return c;
}

export function makeWallHeight(size = 512) {
  const rand = rng(4242);
  const c = canvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#555';
  ctx.fillRect(0, 0, size, size);
  const rowH = size / 8;
  for (let row = 0; row < 8; row++) {
    const offset = row % 2 === 0 ? 0 : size / 8;
    for (let i = -1; i < 5; i++) {
      const x = i * (size / 4) + offset;
      const v = 110 + rand() * 50;
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(x + 5, row * rowH + 5, size / 4 - 10, rowH - 10);
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 4;
      ctx.strokeRect(x + 1, row * rowH + 1, size / 4 - 2, rowH - 2);
    }
  }
  noiseOverlay(ctx, size, rand, 0.2, 0.9);
  return c;
}

export function makeRug(size = 512) {
  const rand = rng(999);
  const c = canvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#2b1014';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#3d171b';
  ctx.fillRect(20, 20, size - 40, size - 40);
  ctx.strokeStyle = '#8c6930';
  ctx.lineWidth = 8;
  ctx.strokeRect(20, 20, size - 40, size - 40);
  ctx.strokeStyle = 'rgba(217,178,106,0.35)';
  ctx.lineWidth = 2;
  ctx.strokeRect(38, 38, size - 76, size - 76);
  // central sigil
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.strokeStyle = '#b88a44';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.22, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.16, 0, Math.PI * 2);
  ctx.stroke();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * size * 0.16, Math.sin(a) * size * 0.16);
    ctx.lineTo(Math.cos(a) * size * 0.22, Math.sin(a) * size * 0.22);
    ctx.stroke();
  }
  ctx.restore();
  // wear
  for (let i = 0; i < 20; i++) {
    const x = rand() * size, y = rand() * size, r = 6 + rand() * 20;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(0,0,0,0.2)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  noiseOverlay(ctx, size, rand, 0.08, 0.9);
  return c;
}

export function makeRune(size = 512) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2, cy = size / 2;
  ctx.strokeStyle = 'rgba(255,200,120,0.9)';
  ctx.shadowColor = 'rgba(255,140,50,0.9)';
  ctx.shadowBlur = 18;
  for (const r of [0.42, 0.36, 0.22]) {
    ctx.beginPath();
    ctx.arc(cx, cy, size * r, 0, Math.PI * 2);
    ctx.lineWidth = r === 0.42 ? 5 : 2;
    ctx.stroke();
  }
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const r1 = size * 0.36, r2 = size * 0.42;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    ctx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  // runic ticks
  ctx.shadowBlur = 10;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const x = cx + Math.cos(a) * size * 0.3;
    const y = cy + Math.sin(a) * size * 0.3;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    ctx.strokeRect(-8, -3, 16, 6);
    ctx.restore();
  }
  return c;
}

export function makeFlame(size = 256) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const cx = size / 2, cy = size * 0.58;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.5);
  g.addColorStop(0, 'rgba(255,255,230,1)');
  g.addColorStop(0.16, 'rgba(255,230,150,0.98)');
  g.addColorStop(0.4, 'rgba(255,140,40,0.85)');
  g.addColorStop(0.7, 'rgba(200,50,10,0.35)');
  g.addColorStop(1, 'rgba(80,10,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  // flame tongues
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 9; i++) {
    const x = cx + (Math.random() - 0.5) * size * 0.3;
    const y = cy - Math.random() * size * 0.28;
    const r = 10 + Math.random() * 20;
    const fg = ctx.createRadialGradient(x, y, 0, x, y, r);
    fg.addColorStop(0, 'rgba(255,220,130,0.65)');
    fg.addColorStop(1, 'rgba(255,100,20,0)');
    ctx.fillStyle = fg;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  return c;
}

export function makeDust(size = 64) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,240,220,1)');
  g.addColorStop(0.3, 'rgba(255,220,180,0.6)');
  g.addColorStop(1, 'rgba(255,200,150,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

export function makeMetal(size = 256) {
  const rand = rng(777);
  const c = canvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#4a4034';
  ctx.fillRect(0, 0, size, size);
  noiseOverlay(ctx, size, rand, 0.2, 0.9);
  for (let i = 0; i < 8; i++) {
    ctx.fillStyle = 'rgba(255,220,150,0.03)';
    ctx.fillRect(rand() * size, rand() * size, 2 + rand() * 20, 1 + rand() * 4);
  }
  return c;
}

export function buildDungeonTextures() {
  const floorCanvas = makeStoneFloor(512);
  const floorHeight = makeStoneHeight(512);
  const wallCanvas = makeWallStone(512);
  const wallHeight = makeWallHeight(512);
  const rugCanvas = makeRug(512);
  const runeCanvas = makeRune(512);
  const flameCanvas = makeFlame(256);
  const dustCanvas = makeDust(64);
  const metalCanvas = makeMetal(256);
  return {
    floorMap: tex(floorCanvas),
    floorBump: tex(floorHeight, { srgb: false }),
    floorRough: tex(floorHeight, { srgb: false }),
    wallMap: tex(wallCanvas),
    wallBump: tex(wallHeight, { srgb: false }),
    wallRough: tex(wallHeight, { srgb: false }),
    rugMap: tex(rugCanvas),
    runeMap: tex(runeCanvas),
    flameMap: tex(flameCanvas),
    dustMap: tex(dustCanvas),
    metalMap: tex(metalCanvas),
    _canvases: [floorCanvas, floorHeight, wallCanvas, wallHeight, rugCanvas, runeCanvas, flameCanvas, dustCanvas, metalCanvas],
  };
}
