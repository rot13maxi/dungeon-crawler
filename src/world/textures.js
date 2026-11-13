// src/world/textures.js
// Procedural canvas textures for the dungeon. No external assets.
// All color maps are drawn once at startup; bump/roughness maps are derived
// from the color pass (cheap) plus value-noise grain.

import * as THREE from 'three';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// Tileable value noise: lattice of freqX x freqY random values, bilinear + smoothstep.
function noiseField(w, h, fx, fy, seed) {
  const rnd = mulberry32(seed);
  const lat = new Float32Array(fx * fy);
  for (let i = 0; i < lat.length; i++) lat[i] = rnd();
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const gy = (y / h) * fy;
    const y0 = Math.floor(gy);
    const fy0 = ((y0 % fy) + fy) % fy;
    const fy1 = (fy0 + 1) % fy;
    const ty = gy - y0;
    const sy = ty * ty * (3 - 2 * ty);
    for (let x = 0; x < w; x++) {
      const gx = (x / w) * fx;
      const x0 = Math.floor(gx);
      const fx0 = ((x0 % fx) + fx) % fx;
      const fx1 = (fx0 + 1) % fx;
      const tx = gx - x0;
      const sx = tx * tx * (3 - 2 * tx);
      const a = lat[fy0 * fx + fx0];
      const b = lat[fy0 * fx + fx1];
      const c = lat[fy1 * fx + fx0];
      const d = lat[fy1 * fx + fx1];
      out[y * w + x] = a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
    }
  }
  return out;
}

function fbmField(w, h, fx, fy, octaves, seed) {
  const out = new Float32Array(w * h);
  let amp = 1;
  let total = 0;
  let sx = fx;
  let sy = fy;
  for (let o = 0; o < octaves; o++) {
    const n = noiseField(w, h, Math.max(1, Math.round(sx)), Math.max(1, Math.round(sy)), seed + o * 131);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    total += amp;
    amp *= 0.55;
    sx *= 2;
    sy *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function multiplyField(ctx, w, h, field, lo, hi) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < w * h; i++) {
    const m = lo + (hi - lo) * field[i];
    const j = i * 4;
    d[j] = Math.min(255, d[j] * m);
    d[j + 1] = Math.min(255, d[j + 1] * m);
    d[j + 2] = Math.min(255, d[j + 2] * m);
  }
  ctx.putImageData(img, 0, 0);
}

// Derive cheap bump + roughness maps from a finished color canvas.
function deriveBumpRough(colorCtx, w, h, seed) {
  const img = colorCtx.getImageData(0, 0, w, h);
  const d = img.data;
  const grain = fbmField(w, h, 26, 26, 3, seed ^ 0x9e37);
  const bumpC = makeCanvas(w, h);
  const bctx = bumpC.getContext('2d');
  const bImg = bctx.createImageData(w, h);
  const bd = bImg.data;
  const roughC = makeCanvas(w, h);
  const rctx = roughC.getContext('2d');
  const rImg = rctx.createImageData(w, h);
  const rd = rImg.data;
  for (let i = 0; i < w * h; i++) {
    const j = i * 4;
    const lum = (d[j] * 0.2126 + d[j + 1] * 0.7152 + d[j + 2] * 0.0722) / 255;
    let b = lum * 255 + (grain[i] - 0.5) * 26;
    b = b < 0 ? 0 : b > 255 ? 255 : b;
    bd[j] = bd[j + 1] = bd[j + 2] = b;
    bd[j + 3] = 255;
    let r = 0.58 + 0.36 * (1 - lum) + (grain[i] - 0.5) * 0.16;
    r = r < 0 ? 0 : r > 1 ? 1 : r;
    rd[j] = rd[j + 1] = rd[j + 2] = r * 255;
    rd[j + 3] = 255;
  }
  bctx.putImageData(bImg, 0, 0);
  rctx.putImageData(rImg, 0, 0);
  return { bumpCanvas: bumpC, roughCanvas: roughC };
}

function finishTex(canvas, { color = false, anisotropy = 4 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = anisotropy;
  if (color) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

function polyPath(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
}

// ---------------------------------------------------------------- stone floor
// Large irregular flagstones with mortar gaps, chips, cracks, stains.
export function createStoneFloorTextures(opts = {}) {
  const S = opts.size ?? 512;
  const tiles = opts.tiles ?? 4;
  const seed = opts.seed ?? 11;
  const rng = mulberry32(seed);
  const c = makeCanvas(S);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#15130f';
  ctx.fillRect(0, 0, S, S);

  const ts = S / tiles;
  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      const ox = tx * ts;
      const oy = ty * ts;
      const j = () => 2 + rng() * ts * 0.09;
      const pts = [
        [ox + j(), oy + j()],
        [ox + ts - j(), oy + j() * 0.8],
        [ox + ts - j() * 0.9, oy + ts - j()],
        [ox + j() * 0.8, oy + ts - j() * 0.9],
      ];
      const warm = rng();
      const shade = 0.72 + rng() * 0.42;
      const r = Math.round((86 * warm + 74 * (1 - warm)) * shade);
      const g = Math.round((80 * warm + 76 * (1 - warm)) * shade);
      const b = Math.round((74 * warm + 84 * (1 - warm)) * shade);
      const grad = ctx.createLinearGradient(ox, oy, ox + ts, oy + ts);
      grad.addColorStop(0, `rgb(${Math.min(255, r + 14)},${Math.min(255, g + 13)},${Math.min(255, b + 12)})`);
      grad.addColorStop(1, `rgb(${Math.max(0, r - 16)},${Math.max(0, g - 15)},${Math.max(0, b - 14)})`);
      polyPath(ctx, pts);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,238,214,0.06)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      drawChips(ctx, pts, rng);
      if (rng() < 0.45) drawCrack(ctx, ox, oy, ts, rng);
    }
  }
  // large stains
  for (let k = 0; k < 7; k++) {
    const x = rng() * S;
    const y = rng() * S;
    const rr = S * (0.12 + rng() * 0.22);
    const g2 = ctx.createRadialGradient(x, y, 0, x, y, S * 0.3);
    const dark = rng() < 0.6;
    g2.addColorStop(0, dark ? 'rgba(24,18,12,0.22)' : 'rgba(70,58,40,0.14)');
    g2.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g2;
    ctx.fillRect(x - S * 0.3, y - S * 0.3, S * 0.6, S * 0.6);
  }
  const grain = fbmField(S, S, 18, 18, 4, seed + 17);
  multiplyField(ctx, S, S, grain, 0.8, 1.14);
  const speck = noiseField(S, S, 96, 96, seed + 29);
  multiplyField(ctx, S, S, speck, 0.94, 1.06);

  const maps = deriveBumpRough(ctx, S, S, seed + 41);
  return {
    map: finishTex(c, { color: true, anisotropy: opts.anisotropy }),
    bumpMap: finishTex(maps.bumpCanvas, { anisotropy: opts.anisotropy }),
    roughnessMap: finishTex(maps.roughCanvas, { anisotropy: opts.anisotropy }),
  };
}

function drawChips(ctx, pts, rng) {
  const n = Math.floor(rng() * 3);
  for (let k = 0; k < n; k++) {
    const e = Math.floor(rng() * 4);
    const a = pts[e];
    const b = pts[(e + 1) % 4];
    const t = 0.25 + rng() * 0.5;
    const mx = a[0] + (b[0] - a[0]) * t;
    const my = a[1] + (b[1] - a[1]) * t;
    const inx = mx + (rng() - 0.5) * 10;
    const iny = my + (rng() - 0.5) * 10;
    ctx.beginPath();
    ctx.moveTo(mx, my);
    ctx.lineTo(mx + (b[0] - a[0]) * 0.12, my + (b[1] - a[1]) * 0.12);
    ctx.lineTo(inx, iny);
    ctx.closePath();
    ctx.fillStyle = 'rgba(16,14,11,0.7)';
    ctx.fill();
  }
}

function drawCrack(ctx, ox, oy, ts, rng) {
  let x = ox + ts * (0.15 + rng() * 0.7);
  let y = oy + ts * (0.1 + rng() * 0.2);
  ctx.beginPath();
  ctx.moveTo(x, y);
  const segs = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < segs; i++) {
    x += (rng() - 0.5) * ts * 0.4;
    y += ts * (0.12 + rng() * 0.18);
    ctx.lineTo(x, y);
  }
  ctx.strokeStyle = 'rgba(10,8,6,0.55)';
  ctx.lineWidth = 1.4;
  ctx.stroke();
}

// ------------------------------------------------------------------ wall stone
// Offset brick courses, chipped edges, baked soot trim at the bottom.
export function createWallStoneTextures(opts = {}) {
  const S = opts.size ?? 512;
  const seed = opts.seed ?? 23;
  const rng = mulberry32(seed);
  const c = makeCanvas(S);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#100f12';
  ctx.fillRect(0, 0, S, S);

  const rows = opts.rows ?? 10;
  const bh = S / rows;
  const bw = S / 5;
  for (let r = 0; r < rows; r++) {
    const y0 = r * bh;
    const off = (r % 2) * bw * 0.5;
    for (let b = -1; b < 6; b++) {
      const x0 = b * bw + off + (rng() - 0.5) * 4;
      const missing = rng() < 0.05;
      const shade = 0.6 + rng() * 0.34;
      const warm = rng();
      const rr = Math.round((64 * warm + 58 * (1 - warm)) * shade);
      const gg = Math.round((62 * warm + 64 * (1 - warm)) * shade);
      const bb = Math.round((58 * warm + 72 * (1 - warm)) * shade);
      const grad = ctx.createLinearGradient(x0, y0, x0, y0 + bh);
      if (missing) {
        grad.addColorStop(0, '#0c0b0e');
        grad.addColorStop(1, '#08070a');
      } else {
        grad.addColorStop(0, `rgb(${Math.min(255, rr + 10)},${Math.min(255, gg + 10)},${Math.min(255, bb + 10)})`);
        grad.addColorStop(1, `rgb(${Math.max(0, rr - 14)},${Math.max(0, gg - 14)},${Math.max(0, bb - 12)})`);
      }
      ctx.fillStyle = grad;
      ctx.fillRect(x0 + 2.5, y0 + 2.5, bw - 5, bh - 5);
      if (!missing) {
        ctx.fillStyle = 'rgba(255,240,220,0.05)';
        ctx.fillRect(x0 + 2.5, y0 + 2.5, bw - 5, 2);
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fillRect(x0 + 2.5, y0 + bh - 4.5, bw - 5, 2);
        if (rng() < 0.35) {
          // chipped corner
          ctx.beginPath();
          const cx = rng() < 0.5 ? x0 + 2.5 : x0 + bw - 2.5;
          const cy = rng() < 0.5 ? y0 + 2.5 : y0 + bh - 2.5;
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + (rng() - 0.5) * 16, cy + (rng() < 0.5 ? -1 : 1) * 8);
          ctx.lineTo(cx + (rng() - 0.5) * 10, cy + (rng() < 0.5 ? -1 : 1) * 12);
          ctx.closePath();
          ctx.fillStyle = 'rgba(14,13,16,0.85)';
          ctx.fill();
        }
        if (rng() < 0.08) {
          const mx = x0 + rng() * bw;
          const my = y0 + rng() * bh;
          const g2 = ctx.createRadialGradient(mx, my, 0, mx, my, 14 + rng() * 14);
          g2.addColorStop(0, 'rgba(52,72,40,0.16)');
          g2.addColorStop(1, 'rgba(52,72,40,0)');
          ctx.fillStyle = g2;
          ctx.fillRect(mx - 30, my - 30, 60, 60);
        }
      }
    }
  }
  // baked trim: soot rising from the floor
  const soot = ctx.createLinearGradient(0, S, 0, S * 0.62);
  soot.addColorStop(0, 'rgba(6,5,4,0.62)');
  soot.addColorStop(1, 'rgba(6,5,4,0)');
  ctx.fillStyle = soot;
  ctx.fillRect(0, S * 0.62, S, S * 0.38);
  const top = ctx.createLinearGradient(0, 0, 0, S * 0.12);
  top.addColorStop(0, 'rgba(4,4,6,0.5)');
  top.addColorStop(1, 'rgba(4,4,4,0)');
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, S, S * 0.12);

  const grain = fbmField(S, S, 16, 16, 4, seed + 31);
  multiplyField(ctx, S, S, grain, 0.8, 1.12);
  const speck = noiseField(S, S, 80, 80, seed + 47);
  multiplyField(ctx, S, S, speck, 0.93, 1.07);

  const maps = deriveBumpRough(ctx, S, S, seed + 53);
  return {
    map: finishTex(c, { color: true, anisotropy: opts.anisotropy }),
    bumpMap: finishTex(maps.bumpCanvas, { anisotropy: opts.anisotropy }),
    roughnessMap: finishTex(maps.roughCanvas, { anisotropy: opts.anisotropy }),
  };
}

// ----------------------------------------------------------------------- metal
// Dark iron plate: brushed streaks, rivet grid, scratches.
export function createMetalTextures(opts = {}) {
  const S = opts.size ?? 512;
  const seed = opts.seed ?? 37;
  const rng = mulberry32(seed);
  const c = makeCanvas(S);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#24272d';
  ctx.fillRect(0, 0, S, S);

  for (let i = 0; i < 420; i++) {
    const y = rng() * S;
    const x = rng() * S;
    const len = 40 + rng() * 200;
    const light = rng() < 0.5;
    ctx.strokeStyle = light ? `rgba(210,214,222,${0.02 + rng() * 0.06})` : `rgba(0,0,0,${0.03 + rng() * 0.08})`;
    ctx.lineWidth = 0.8 + rng() * 1.4;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y + (rng() - 0.5) * 3);
    ctx.stroke();
  }
  // rivet grid
  const step = S / 8;
  for (let ry = 0; ry < 8; ry++) {
    const offset = (ry % 2) * step * 0.5;
    for (let rx = 0; rx < 9; rx++) {
      const x = rx * step + offset;
      const y = ry * step + step * 0.5;
      ctx.beginPath();
      ctx.arc(x, y, 5.4, 0, Math.PI * 2);
      ctx.fillStyle = '#3a4049';
      ctx.fill();
      ctx.strokeStyle = 'rgba(10,12,15,0.8)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x - 1.4, y - 1.4, 2.6, Math.PI * 0.9, Math.PI * 1.9);
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
  }
  for (let k = 0; k < 26; k++) {
    const x = rng() * S;
    const y = rng() * S;
    ctx.strokeStyle = `rgba(200,205,215,${0.05 + rng() * 0.1})`;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rng() - 0.5) * 90, y + (rng() - 0.5) * 14);
    ctx.stroke();
  }
  const grain = fbmField(S, S, 6, 42, 3, seed + 61); // stretched -> brushed
  multiplyField(ctx, S, S, grain, 0.82, 1.12);

  const maps = deriveBumpRough(ctx, S, S, seed + 67);
  return {
    map: finishTex(c, { color: true, anisotropy: opts.anisotropy }),
    bumpMap: finishTex(maps.bumpCanvas, { anisotropy: opts.anisotropy }),
    roughnessMap: finishTex(maps.roughCanvas, { anisotropy: opts.anisotropy }),
  };
}

// ------------------------------------------------------------------------ rug
// Worn crimson carpet: gold border bands, diamond motifs, center medallion.
export function createRugTextures(opts = {}) {
  const S = opts.size ?? 512;
  const seed = opts.seed ?? 43;
  const rng = mulberry32(seed);
  const c = makeCanvas(S);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#4a181e';
  ctx.fillRect(0, 0, S, S);
  // weave streaks
  for (let x = 0; x < S; x += 3) {
    ctx.fillStyle = `rgba(255,190,160,${0.02 + rng() * 0.05})`;
    ctx.fillRect(x, 0, 1.4, S);
    ctx.fillStyle = `rgba(0,0,0,${0.03 + rng() * 0.06})`;
    ctx.fillRect(x + 1.5, 0, 1.4, S);
  }
  const gold = '#8a6d33';
  const dark = '#241014';
  // border bands
  ctx.strokeStyle = dark;
  ctx.lineWidth = 14;
  ctx.strokeRect(22, 22, S - 44, S - 44);
  ctx.strokeStyle = gold;
  ctx.lineWidth = 3;
  ctx.strokeRect(34, 34, S - 68, S - 68);
  ctx.strokeRect(46, 46, S - 92, S - 92);
  // diamond motifs along the border midline
  const mid = 40;
  ctx.fillStyle = gold;
  for (let t = 90; t < S - 90; t += 52) {
    diamond(ctx, t, mid, 7);
    diamond(ctx, t, S - mid, 7);
    diamond(ctx, mid, t, 7);
    diamond(ctx, S - mid, t, 7);
  }
  // central medallion
  const m = S / 2;
  ctx.strokeStyle = gold;
  ctx.lineWidth = 5;
  diamondPath(ctx, m, m, 108);
  ctx.stroke();
  ctx.lineWidth = 2.5;
  diamondPath(ctx, m, m, 70);
  ctx.stroke();
  ctx.fillStyle = gold;
  diamond(ctx, m, m, 16);
  // corner quarter-motifs
  for (const [cx, cy] of [[70, 70], [S - 70, 70], [70, S - 70], [S - 70, S - 70]]) {
    ctx.strokeStyle = gold;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx - 22, cy);
    ctx.lineTo(cx, cy - 22);
    ctx.lineTo(cx + 22, cy);
    ctx.lineTo(cx, cy + 22);
    ctx.closePath();
    ctx.stroke();
    ctx.fillStyle = gold;
    diamond(ctx, cx, cy, 5);
  }
  const grain = fbmField(S, S, 24, 24, 4, seed + 71);
  multiplyField(ctx, S, S, grain, 0.72, 1.08);
  // worn walk path down the middle
  const wear = ctx.createLinearGradient(0, S * 0.2, 0, S * 0.8);
  wear.addColorStop(0, 'rgba(0,0,0,0)');
  wear.addColorStop(0.5, 'rgba(10,6,6,0.18)');
  wear.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = wear;
  ctx.fillRect(S * 0.28, S * 0.2, S * 0.44, S * 0.6);

  const maps = deriveBumpRough(ctx, S, S, seed + 79);
  return {
    map: finishTex(c, { color: true, anisotropy: opts.anisotropy }),
    bumpMap: finishTex(maps.bumpCanvas, { anisotropy: opts.anisotropy }),
  };
}

function diamondPath(ctx, x, y, r) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
}

function diamond(ctx, x, y, r) {
  diamondPath(ctx, x, y, r);
  ctx.fill();
}

// ---------------------------------------------------------------- rune circle
// White luminous rune ring on transparent background; tint via material color.
export function createRuneTexture(opts = {}) {
  const S = opts.size ?? 512;
  const seed = opts.seed ?? 57;
  const rng = mulberry32(seed);
  const c = makeCanvas(S);
  const ctx = c.getContext('2d');
  const m = S / 2;
  const R = S * 0.46;
  ctx.lineCap = 'round';

  const rings = opts.rings ?? [0.98, 0.82, 0.62];
  // soft glow underlay
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 9;
  ctx.shadowColor = 'rgba(255,255,255,0.9)';
  ctx.shadowBlur = 18;
  for (const rr of rings) {
    ctx.beginPath();
    ctx.arc(m, m, R * rr, 0, Math.PI * 2);
    ctx.stroke();
  }
  // crisp pass
  ctx.shadowBlur = 4;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3;
  for (let i = 0; i < rings.length; i++) {
    ctx.beginPath();
    ctx.arc(m, m, R * rings[i], 0, Math.PI * 2);
    if (i === 1) ctx.setLineDash([R * 0.11, R * 0.09]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // glyph ring between rings[1] and rings[0]
  const glyphs = opts.glyphs ?? 24;
  const gr = R * (rings[1] + rings[0]) * 0.5;
  const gs = R * 0.11;
  for (let i = 0; i < glyphs; i++) {
    const a = (i / glyphs) * Math.PI * 2;
    ctx.save();
    ctx.translate(m + Math.cos(a) * gr, m + Math.sin(a) * gr);
    ctx.rotate(a + Math.PI / 2);
    drawGlyph(ctx, 0, 0, gs, rng);
    ctx.restore();
  }
  // spokes + nodes
  const spokes = opts.spokes ?? 8;
  ctx.lineWidth = 3;
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2 + Math.PI / spokes;
    ctx.beginPath();
    ctx.moveTo(m + Math.cos(a) * R * rings[2], m + Math.sin(a) * R * rings[2]);
    ctx.lineTo(m + Math.cos(a) * R * rings[1], m + Math.sin(a) * R * rings[1]);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(m + Math.cos(a) * R * rings[2], m + Math.sin(a) * R * rings[2], R * 0.035, 0, Math.PI * 2);
    ctx.stroke();
  }
  // center sigil: {7/3} star polygon
  const pts = 7;
  const step = 3;
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  for (let i = 0; i <= pts; i++) {
    const a = ((i * step) % pts) / pts * Math.PI * 2 - Math.PI / 2;
    const x = m + Math.cos(a) * R * 0.44;
    const y = m + Math.sin(a) * R * 0.44;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(m, m, R * 0.14, 0, Math.PI * 2);
  ctx.stroke();

  return finishTex(c, { color: true, anisotropy: opts.anisotropy });
}

function drawGlyph(ctx, x, y, s, rng) {
  ctx.lineWidth = 3.4;
  ctx.beginPath();
  ctx.moveTo(x, y - s * 0.55);
  ctx.lineTo(x, y + s * 0.55);
  const branches = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < branches; i++) {
    const yy = y + (rng() - 0.5) * s;
    const dir = rng() < 0.5 ? -1 : 1;
    const len = s * (0.3 + rng() * 0.45);
    if (rng() < 0.3) {
      ctx.moveTo(x, yy);
      ctx.lineTo(x + dir * len, yy + (rng() - 0.5) * s * 0.5);
    } else {
      ctx.moveTo(x, yy);
      ctx.lineTo(x + dir * len, yy);
    }
  }
  ctx.stroke();
}

// ------------------------------------------------------------- glyph strip row
// A horizontal band of runes (portal lintel).
export function createGlyphStripTexture(opts = {}) {
  const W = opts.width ?? 512;
  const H = opts.height ?? 96;
  const seed = opts.seed ?? 71;
  const rng = mulberry32(seed);
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.lineCap = 'round';
  const count = opts.count ?? 9;
  const gw = W / count;
  ctx.shadowColor = 'rgba(255,255,255,0.9)';
  ctx.shadowBlur = 10;
  for (let i = 0; i < count; i++) {
    ctx.save();
    ctx.translate(gw * (i + 0.5), H * 0.5);
    ctx.strokeStyle = i % 2 === 0 ? '#ffffff' : 'rgba(235,240,255,0.85)';
    drawGlyph(ctx, 0, 0, H * 0.3, rng);
    ctx.restore();
  }
  return finishTex(c, { color: true, anisotropy: opts.anisotropy });
}

// ------------------------------------------------------------- soft glow sprite
// Radial dot for points/sprites (flames, embers, dust, portal sparks).
export function createGlowSpriteTexture(opts = {}) {
  const S = opts.size ?? 128;
  const c = makeCanvas(S);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.22, 'rgba(255,255,255,0.72)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.24)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const t = finishTex(c, { color: true, anisotropy: opts.anisotropy });
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}
