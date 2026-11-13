// EMBERFALL — procedural gear. Rarity curve, rolled affixes and rare+ powers.
// Pure data/rolling helpers: no THREE, no game import. The game owns the
// equipped slots and applies `aggregateGear()` to its stats.

export const BAG_LIMIT = 30;

export const GEAR_SLOTS = {
  weapon: { id: 'weapon', label: 'Weapon', icon: '⚔' },
  armor: { id: 'armor', label: 'Armor', icon: '❖' },
  accessory: { id: 'accessory', label: 'Accessory', icon: '◈' },
};

export const GEAR_RARITY = {
  common: { id: 'common', name: 'Common', css: '#b9b2a6', color: 0xb9b2a6, affixes: 1, powers: 0, mult: 1 },
  magic: { id: 'magic', name: 'Magic', css: '#6fa8ff', color: 0x6fa8ff, affixes: 2, powers: 0, mult: 1.2 },
  rare: { id: 'rare', name: 'Rare', css: '#ffd166', color: 0xffd166, affixes: 3, powers: 1, mult: 1.45 },
  legendary: { id: 'legendary', name: 'Legendary', css: '#ff7a2f', color: 0xff7a2f, affixes: 4, powers: 2, mult: 1.8 },
};

const RARITY_ORDER = ['common', 'magic', 'rare', 'legendary'];

const BASES = {
  weapon: ['Blade', 'War Axe', 'Spear'],
  armor: ['Cuirass', 'Hauberk', 'Warden Plate'],
  accessory: ['Signet', 'Talisman', 'Torc'],
};

const PREFIX = {
  common: ['Worn', 'Chipped', 'Scorched', 'Dull', 'Ashen'],
  magic: ['Runed', 'Gilded', 'Ember', 'Frostbound', 'Stormforged'],
  rare: ['Emberfang', 'Ashwrought', 'Graveborn', 'Cinder', 'Riftsteel'],
  legendary: ["Warden's", 'Sovereign', 'Eternal', 'Doomforged', 'Ashen Crown'],
};

const SUFFIX = {
  damage: 'of Ruin',
  damagePct: 'of Fury',
  critChance: 'of Precision',
  critMult: 'of Cruelty',
  armor: 'of Warding',
  maxHp: 'of Vitality',
  maxMana: 'of the Well',
  manaRegen: 'of Focus',
  moveSpeedPct: 'of Swiftness',
  lifesteal: 'of Leeching',
  thorns: 'of Spite',
  goldFind: 'of Avarice',
  pickupRadius: 'of Gathering',
  shield: 'of Aegis',
};

// Affix ranges are pre-rarity, pre-depth. Percent affixes use a softer depth
// curve so deep gear does not turn every roll into a runaway multiplier.
const AFFIX = {
  damage: { label: 'Damage', min: 2, max: 5, flat: true },
  damagePct: { label: 'Damage', min: 0.04, max: 0.09, pct: true },
  critChance: { label: 'Crit Chance', min: 0.01, max: 0.03, pct: true },
  critMult: { label: 'Crit Damage', min: 0.06, max: 0.16, pct: true },
  armor: { label: 'Armor', min: 4, max: 10, flat: true },
  maxHp: { label: 'Life', min: 8, max: 20, flat: true },
  maxMana: { label: 'Mana', min: 6, max: 16, flat: true },
  manaRegen: { label: 'Mana Regen', min: 0.4, max: 1.2, decimals: 1 },
  moveSpeedPct: { label: 'Move Speed', min: 0.03, max: 0.07, pct: true },
  lifesteal: { label: 'Life Steal', min: 0.02, max: 0.04, pct: true },
  thorns: { label: 'Thorns', min: 0.04, max: 0.09, pct: true },
  goldFind: { label: 'Gold Find', min: 0.08, max: 0.2, pct: true },
  pickupRadius: { label: 'Pickup Radius', min: 0.3, max: 0.8, decimals: 1 },
  shield: { label: 'Shield', min: 8, max: 18, flat: true },
};

const SLOT_POOL = {
  weapon: ['damage', 'damagePct', 'critChance', 'critMult', 'lifesteal'],
  armor: ['armor', 'maxHp', 'thorns', 'shield'],
  accessory: ['manaRegen', 'maxMana', 'moveSpeedPct', 'critChance', 'goldFind', 'pickupRadius'],
};

// Rare+ powers: every entry has a real gameplay hook wired in game.js.
const POWERS = {
  vampiric: {
    name: 'Vampiric', min: 0.04, max: 0.09, pct: true,
    text: (v) => `Heal for ${fmtPct(v)} of damage dealt`,
  },
  emberbrand: {
    name: 'Emberbrand', min: 2, max: 5,
    text: (v) => `Attacks burn for ${v} damage per second (3s)`,
  },
  frostbrand: {
    name: 'Frostbrand', min: 1, max: 2, decimals: 1,
    text: (v) => `Attacks chill for ${fmtNum(v)}s`,
  },
  stormbrand: {
    name: 'Stormbrand', min: 1, max: 2, decimals: 1,
    text: (v) => `Attacks shock for ${fmtNum(v)}s`,
  },
  executioner: {
    name: 'Executioner', min: 0.25, max: 0.5, pct: true,
    text: (v) => `+${fmtPct(v)} damage to foes below 30% life`,
  },
  thorns: {
    name: 'Thorns', min: 0.08, max: 0.2, pct: true,
    text: (v) => `Reflect ${fmtPct(v)} of damage taken`,
  },
  soulharvest: {
    name: 'Soul Harvest', min: 0.05, max: 0.12, pct: true,
    text: (v) => `Restore ${fmtPct(v)} mana on kill`,
  },
  emberheart: {
    name: 'Emberheart', min: 3, max: 8,
    text: (v) => `Burn nearby foes for ${v} damage per second`,
  },
  echo: {
    name: 'Echoing', min: 0.06, max: 0.15, pct: true,
    text: (v) => `+${fmtPct(v)} spell echo chance`,
  },
  deathbloom: {
    name: 'Deathbloom', min: 5, max: 12,
    text: (v) => `Slain foes explode for ${v} damage`,
  },
  chain: {
    name: 'Stormchain', min: 0.15, max: 0.3, pct: true,
    text: (v) => `${fmtPct(v)} chance attacks arc to another foe`,
  },
  gilded: {
    name: 'Gilded', min: 0.15, max: 0.35, pct: true,
    text: (v) => `+${fmtPct(v)} gold from drops`,
  },
};

const POWER_IDS = Object.keys(POWERS);

let _uid = 0;

function fmtPct(v) {
  return `${(v * 100).toFixed(1).replace(/\.0$/, '')}%`;
}

function fmtNum(v) {
  return `${Number(v).toFixed(1).replace(/\.0$/, '')}`;
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function shuffled(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function depthScale(depth) {
  return 1 + Math.max(0, depth - 1) * 0.3;
}

function pctDepthScale(depth) {
  return Math.pow(1 + Math.max(0, depth - 1) * 0.22, 0.7);
}

function roundAffix(key, value) {
  const a = AFFIX[key];
  if (a.flat) return Math.max(1, Math.round(value));
  if (a.pct) return Math.max(0.001, Math.round(value * 1000) / 1000);
  if (a.decimals) return Math.max(0.1, Math.round(value * 10) / 10);
  return Math.max(1, Math.round(value));
}

function rollAffix(key, rarity, depth) {
  const a = AFFIX[key];
  const base = a.min + Math.random() * (a.max - a.min);
  const scale = a.pct ? pctDepthScale(depth) : depthScale(depth);
  return roundAffix(key, base * scale * rarity.mult);
}

function rollPower(id, rarity, depth) {
  const p = POWERS[id];
  const base = p.min + Math.random() * (p.max - p.min);
  const scale = p.pct ? pctDepthScale(depth) : depthScale(depth);
  let value = base * scale * (1 + (rarity.mult - 1) * 0.55);
  if (p.pct) value = Math.round(value * 1000) / 1000;
  else if (p.decimals) value = Math.round(value * 10) / 10;
  else value = Math.max(1, Math.round(value));
  return { id, name: p.name, value, text: p.text(value) };
}

/**
 * Rarity curve. Weight shifts toward higher tiers with depth and enemy tier
 * (`bias`: 1 normal, ~1.7 elite, 3+ boss). Returns a rarity id.
 */
export function rollRarity(depth = 1, bias = 1) {
  const d = Math.max(1, depth);
  const b = Math.max(0.4, bias);
  const common = Math.max(18, 68 - (d - 1) * 3);
  const magic = 22 + (d - 1) * 1.2;
  const rare = (5 + (d - 1) * 1.3) * b;
  const legendary = (1.6 + (d - 1) * 0.6) * b * b;
  const total = common + magic + rare + legendary;
  let roll = Math.random() * total;
  for (let i = 0; i < RARITY_ORDER.length; i++) {
    roll -= [common, magic, rare, legendary][i];
    if (roll <= 0) return RARITY_ORDER[i];
  }
  return 'common';
}

/**
 * Roll a complete item. `forcedRarity` bypasses the curve (boss rewards, tests).
 */
export function rollLootItem(opts = {}) {
  const depth = Math.max(1, opts.depth ?? 1);
  const slot = opts.slot ?? weightedSlot();
  let rarityId = opts.forcedRarity ?? rollRarity(depth, opts.bias ?? 1);
  if (opts.minRarity && RARITY_ORDER.indexOf(rarityId) < RARITY_ORDER.indexOf(opts.minRarity)) {
    rarityId = opts.minRarity;
  }
  const rarity = GEAR_RARITY[rarityId] ?? GEAR_RARITY.common;
  const pool = SLOT_POOL[slot] ?? SLOT_POOL.weapon;
  const affixKeys = shuffled(pool).slice(0, Math.min(rarity.affixes, pool.length));
  const stats = {};
  for (const key of affixKeys) stats[key] = rollAffix(key, rarity, depth);

  const powers = [];
  if (rarity.powers > 0) {
    const powerIds = shuffled(POWER_IDS).slice(0, rarity.powers);
    for (const id of powerIds) powers.push(rollPower(id, rarity, depth));
  }

  const base = pick(BASES[slot]);
  const prefix = pick(PREFIX[rarityId] ?? PREFIX.common);
  let name = `${prefix} ${base}`;
  if (rarityId === 'rare' || rarityId === 'legendary') {
    const dominant = powers[0]?.id ?? affixKeys[0];
    const suffix = SUFFIX[dominant] ?? 'of the Depths';
    name += ` ${suffix}`;
  }

  return {
    id: `gear_${++_uid}`,
    slot,
    rarity: rarityId,
    baseType: base,
    icon: GEAR_SLOTS[slot].icon,
    name,
    ilvl: depth * 3,
    depth,
    stats,
    powers,
  };
}

function weightedSlot() {
  const r = Math.random() * 100;
  if (r < 38) return 'weapon';
  if (r < 74) return 'armor';
  return 'accessory';
}

export function createStarterWeapon() {
  return {
    id: 'starter_blade',
    slot: 'weapon',
    rarity: 'common',
    baseType: 'Blade',
    icon: GEAR_SLOTS.weapon.icon,
    name: 'Ashen Blade',
    ilvl: 1,
    depth: 1,
    stats: { damage: 2 },
    powers: [],
    starter: true,
  };
}

/**
 * Fold equipped items into one stat/power bundle. `brands` carries the
 * on-hit status riders granted by branded weapons.
 */
export function aggregateGear(equipped) {
  const stats = {
    damage: 0, damagePct: 0, critChance: 0, critMult: 0, armor: 0,
    maxHp: 0, maxMana: 0, manaRegen: 0, moveSpeedPct: 0, lifesteal: 0,
    thorns: 0, goldFind: 0, pickupRadius: 0, shield: 0,
    auraDps: 0, echoChance: 0, manaOnKill: 0, deathExplosion: 0,
    execute: 0, chainChance: 0,
    brands: { burn: 0, chill: 0, shock: 0 },
  };
  const powers = [];
  if (!equipped) return { stats, powers };

  for (const slot of Object.keys(GEAR_SLOTS)) {
    const item = equipped[slot];
    if (!item) continue;
    for (const [key, value] of Object.entries(item.stats ?? {})) {
      if (key in stats && typeof stats[key] === 'number') stats[key] += value;
    }
    for (const p of item.powers ?? []) {
      powers.push(p);
      switch (p.id) {
        case 'vampiric': stats.lifesteal += p.value; break;
        case 'thorns': stats.thorns += p.value; break;
        case 'executioner': stats.execute += p.value; break;
        case 'soulharvest': stats.manaOnKill += p.value; break;
        case 'emberheart': stats.auraDps += p.value; break;
        case 'echo': stats.echoChance += p.value; break;
        case 'deathbloom': stats.deathExplosion += p.value; break;
        case 'chain': stats.chainChance += p.value; break;
        case 'gilded': stats.goldFind += p.value; break;
        case 'emberbrand': stats.brands.burn = Math.max(stats.brands.burn, p.value); break;
        case 'frostbrand': stats.brands.chill = Math.max(stats.brands.chill, p.value); break;
        case 'stormbrand': stats.brands.shock = Math.max(stats.brands.shock, p.value); break;
        default: break;
      }
    }
  }
  return { stats, powers };
}

/** Display rows for an item's rolled affixes. */
export function itemStatLines(item) {
  const out = [];
  for (const [key, value] of Object.entries(item?.stats ?? {})) {
    const a = AFFIX[key];
    if (!a) continue;
    const text = a.pct ? fmtPct(value) : a.decimals ? fmtNum(value) : String(Math.round(value));
    out.push({ label: a.label, text: `+${text}` });
  }
  return out;
}

/** Display rows for an item's powers. */
export function itemPowerLines(item) {
  return (item?.powers ?? []).map((p) => ({ name: p.name, text: p.text }));
}
