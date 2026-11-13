# EMBERFALL — Ashen Depths

A top-down 3D action RPG dungeon crawler built with **Three.js** and **Vite**.
Everything is procedural — dungeon rooms, textures, character models, VFX, and
audio synthesis — with no external art or sound assets.

Descend through 5–7 rooms per depth, clear packs of undead, grow a skill tree,
and break the Ashen Warden's seal to reach the next depth.

## Quick start

```bash
npm install
npm run dev       # http://127.0.0.1:5173
```

Production build and preview:

```bash
npm run build
npm run preview   # http://127.0.0.1:4173
```

Requires Node 20.19+ or 22.12+ (Vite 8).

## Controls

| Input | Action |
| --- | --- |
| **WASD** | Move (camera-relative) |
| **Left mouse** | Basic sword attack |
| **Space** | Dodge dash (brief invulnerability) |
| **1–9** | Cast unlocked active spells |
| **T** | Skill tree |
| **I** | Armory (equipment and satchel) |
| **Esc** | Pause / close overlay |

## Gameplay

- **Rooms:** Entry chamber, combat chambers, and a boss room. Clearing a room
  grants XP, consumables, gold, and gear. The boss room opens the exit portal.
- **Skill tree:** Three branches — **Ember** (fire damage and explosions),
  **Frost** (chill, shatter, control), and **Void** (shadow, lightning, gravity).
  Each branch mixes active spells with passives. Rank nodes with skill points
  earned on level-up.
- **Enemies:** Risen Blades, archers, cultists, brutes, and the multi-phase Ashen
  Warden. Elites roll modifiers, an aura, and better loot.
- **Progression:** Levels raise HP, mana, damage, and skill points. Depths scale
  enemy HP, damage, and XP.

## Loot

Gear drops for three slots: **weapon**, **armor**, and **accessory**.

| Rarity | Affixes | Powers | Source |
| --- | --- | --- | --- |
| Common | 1 | — | Any enemy |
| Magic | 2 | — | Any enemy; elites always at least magic |
| Rare | 3 | 1 | Bosses always rare or better |
| Legendary | 4 | 2 | Rare rolls, especially deep or from bosses |

- Normal enemies roll gear ~9% of the time (+1.2% per depth); elites ~50%; the
  boss drops three items.
- Affixes are slot-specific: weapons roll damage, crit, and lifesteal; armor
  rolls armor, life, thorns, and shield; accessories roll mana, regeneration,
  move speed, gold find, and pickup radius.
- Rare and legendary gear rolls **powers** with real gameplay hooks: elemental
  brands on basic attacks, vampiric lifesteal, thorns, executioner damage,
  mana on kill, a burning aura, spell echo, death explosions, chain lightning,
  and gold find.
- Gear auto-picks up into a 30-slot satchel. Press **I** to open the Armory:
  click a satchel item to equip it, click an equipped slot to stow it, or hover
  an item and press **✕** to melt it into gold.
- A new descent resets equipment to the starter Ashen Blade; reviving and
  descending keep your gear.

## Architecture

```
src/
  main.js              entry point, exposes window.game
  game.js              orchestration: loop, camera, combat, stats, loot, rooms
  config.js            tuning constants (player, camera, XP, rarity colors)
  data/
    enemies.js         enemy definitions, room packs, elite modifiers
    skills.js          skill tree branches, nodes, passive stats
    loot.js            gear generation, rarity curve, affixes, powers
  entities/
    player.js          movement, dodge, attacks, vitals, animation
    enemy.js           AI, statuses, boss phases, death
    models.js          procedural low-poly character geometry
  combat/
    vfx.js             pooled particles, rings, beams, explosions
    projectiles.js     player/enemy projectiles and collisions
    skills.js          spell execution, cooldowns, echo, passives
  world/
    dungeon.js         room generation, walls, torches, portal
    textures.js        procedural canvas textures
  ui/
    ui.js              HUD, overlays, armory, damage numbers, minimap
    skilltree.js       skill tree overlay
    ui.css             dark-fantasy UI styling
  core/
    input.js           keyboard/mouse state
    audio.js           procedural Web Audio synthesis
```

`CONTRACT.md` documents the module interfaces and integration boundaries.

## Notes

- Rendering targets 60 FPS on a good desktop: shared geometry/material caches,
  pooled VFX, throttled HUD/minimap updates, and deferred celebration effects.
- All textures are generated on canvas at runtime; all models are built from
  Three.js primitives. No asset downloads.
- `window.game` is exposed for debugging and browser-based testing.
