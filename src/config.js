export const WORLD = {
  cell: 2.5,
  gridW: 46,
  gridH: 46,
  wallHeight: 3.2,
  floorY: 0,
};

export const CAMERA = {
  offset: { x: 0, y: 17, z: 14 },
  fov: 40,
  followLerp: 7,
  lookHeight: 1.2,
  shakeDecay: 7,
};

export const PLAYER = {
  baseHp: 120,
  hpPerLevel: 14,
  baseMana: 110,
  manaPerLevel: 7,
  baseDamage: 14,
  damagePerLevel: 2.2,
  moveSpeed: 6.2,
  radius: 0.52,
  manaRegen: 5.5,
  critChance: 0.05,
  critMultiplier: 1.65,
  dodgeCooldown: 2.6,
  dodgeDistance: 4.4,
  dodgeDuration: 0.18,
  pickupRadius: 2.2,
};

export const XP_TABLE = (level) => Math.floor(60 + 34 * Math.pow(level, 1.42));

export const DEPTH_SCALE = {
  hp: (d) => 1 + (d - 1) * 0.52,
  damage: (d) => 1 + (d - 1) * 0.3,
  xp: (d) => 1 + (d - 1) * 0.35,
};

export const ELEMENTS = {
  fire: { color: 0xff6b2b, ui: '#ff8a3d', name: 'Burn' },
  frost: { color: 0x6fd8ff, ui: '#8fe6ff', name: 'Chill' },
  lightning: { color: 0x9d7bff, ui: '#b79cff', name: 'Shock' },
  void: { color: 0xc04dff, ui: '#d884ff', name: 'Void' },
  physical: { color: 0xffe2b8, ui: '#ffe2b8', name: 'Physical' },
};

export const RARITY = {
  common: '#b9b2a6',
  magic: '#6fa8ff',
  rare: '#ffd166',
  legendary: '#ff7a2f',
};
