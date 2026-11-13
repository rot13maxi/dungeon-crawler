# EMBERFALL — module contract (read fully before editing)

Project: top-down 3D action RPG dungeon crawler, Three.js + Vite, no external assets.
Working dir: repository root
Existing files you MUST read first: package.json, src/config.js, src/data/skills.js, src/data/enemies.js, src/core/input.js.

The integration owner (parent agent) writes `src/main.js`, `src/game.js`, camera, renderer, postprocessing, room spawning, pickups, progression, and final wiring. Do NOT create or edit main.js, game.js, index.html, config.js, data/*, input.js, package.json. Only edit the files assigned in your task. Other agents work in parallel; never edit their files.

Visual target: dark-fantasy Diablo 2 mood, cinematic, stylized low-poly, strong emissive magic, warm torchlight against cold shadows. Quality over quantity, but must run 60fps on a good desktop. Use procedural canvas textures and geometry; no downloads.

Coordinate system: Y up, XZ floor. Player/enemy positions are THREE.Vector3 on floor (y≈0). Units are meters. Grid cell 2.5m.

## Game facade (available at runtime; do not import game.js)
`game` instance exposes:
- `scene` THREE.Scene, `camera` THREE.PerspectiveCamera, `renderer`, `clock`, `input` Input, `audio` Audio, `ui` UI, `vfx` VFX, `skills` SkillSystem, `projectiles` ProjectileSystem, `dungeon`, `player`, `enemies` array, `pickups` array
- `state`: 'menu' | 'playing' | 'paused' | 'dead' | 'transition'
- `depth` number, `time` seconds, `isPlaying`
- `aim`: { point: THREE.Vector3, direction: THREE.Vector3 } (clamped floor point / normalized XZ dir)
- `stats` aggregated player stats object: { damageMult, armor, shield, manaRegen, critChance, critMult, chilledDamage, auraDps, deathExplosion, manaOnKill, echoChance, chillBonus, chilledCrit, shatterBurst }
- `dealDamage(enemy, baseDamage, opts={})`: central damage. opts: { element:'fire'|'frost'|'lightning'|'void'|'physical', canCrit=true, knockback=0, status:{type:'burn'|'chill'|'shock'|'void', duration, dps}, source:'skill'|'basic'|'aura'|'explosion', critBonus=0, noNumber=false }. Applies stats, crit, status, enemy.takeDamage, damage numbers, VFX, hitstop, shake. Returns {damage, crit, killed}.
- `damagePlayer(amount, sourceEnemy, opts={})`: armor/shield/UI/audio, returns damage taken.
- `applyStatus(enemy, type, duration, dps=0)`; `applyChill(enemy, duration)` uses chillBonus.
- `enemiesInRadius(point, radius, includeDead=false)`, `nearestEnemy(point, maxDist, exclude=[])`, `nearestEnemyInDirection(origin, dir, maxDist, maxAngle=Math.PI)`, `aliveEnemiesInRoom(roomIndex)`
- `spawnPickup(kind, position, value)`: kind 'health'|'mana'|'gold'|'soul'
- `onEnemyKilled(enemy)`: game handles xp, loot, passives, boss.
- `addXp(n)`, `notify(text, tone)`
- `screenShake(amount, duration=0.3)`, `hitstop(seconds)`, `flashScreen(color, strength)`
- `getManaRegen()` number
- `roomIndexAt(position)`, `currentRoom`
- `boss` (Enemy|null), `exitPortal` via dungeon
- `startDepth(depth)`, `revive()`, `nextDepth()` exist but modules should not call them
- `spawnEnemy(defId, position, roomIndex, opts)` (game may use; not needed by most modules)
- `audio.play(name, {volume, rate, pan})`, `audio.startAmbience()`

## Dungeon contract (world agent)
`src/world/dungeon.js` exports `class Dungeon`.
Constructor `new Dungeon(scene, { depth=1 })` builds everything and adds to scene.
Properties:
- `group` THREE.Group
- `grid`: 2D array [row][col] of booleans/numbers; truthy = walkable floor
- `gridW`, `gridH`, `cell` (2.5)
- `rooms`: array in traversal order. Each room:
  `{ index, type:'entry'|'combat'|'boss', name, center:Vector3, size:{x,z}, bounds:{minX,maxX,minZ,maxZ}, spawnPoints:Vector3[], cleared:false, activated:false }`
  Room 0 entry, last room boss, middle rooms combat. 5–7 rooms total.
- `playerSpawn`: Vector3 (room 0 center, slightly offset)
- `exitPortal`: { group/mesh, position:Vector3, active:boolean, update(dt,time), setActive(bool) } — placed in boss room, hidden/dormant until setActive(true). Must be visually spectacular (rune ring, swirling portal, light, particles) and readable.
- `torches` optional.
- `update(dt, elapsed)` animates flicker/portal/ambient particles.
- `isWalkable(x,z,radius=0.4)` true if a circle fits on floor (sample center + 8 ring points).
- `worldToCell(x,z) -> {col,row}`, `cellToWorld(col,row) -> {x,z}`.
- `getRoomAt(position) -> room|null` if inside bounds (with small margin).
- `roomCenter(index)`.
- `dispose()` removes group and disposes owned geometries/materials/textures.
- `depth` number.
Dungeon generation requirements: connected rooms + 3-wide corridors, irregular room shapes, no overlapping rooms. Walls must visually enclose all floor with no see-through gaps at camera angle. Use merged geometry / instancing for performance. Add wall trim, pillars, rubble, braziers/torch lights, rugs, bones, hanging chains, fog. Dynamic torch flicker. Ambient dust motes. One shadow-casting directional moon light + torch point lights (no shadows or max 2 shadow lights). Exit portal + boss seal.
Textures: `src/world/textures.js` with procedural canvas functions for stone floor, wall stone, metal, rug, rune glow. Set texture wrapping/repeat, anisotropy. Use bump/roughness maps where cheap. Include a subtle color-varied floor shader/material. Do not use external URLs.

## Player contract (entities agent)
`src/entities/player.js` exports `class Player`.
`new Player(scene, game)` builds a stylized hooded ember-knight with cloak, armor, sword, emissive runes. Add to scene. Position at `game.dungeon.playerSpawn`.
Properties: `group`, `position` (getter -> group.position), `radius` 0.52, `hp`, `maxHp`, `mana`, `maxMana`, `shield`, `maxShield`, `level`, `xp`, `xpNext`, `skillPoints`, `dead`, `invulnerable`, `stats` (base: damage, moveSpeed, manaRegen, critChance, critMult, armor), `dodgeCooldown`, `dodgeTimer`, `isMoving`, `casting`.
Methods:
- `update(dt, input)`: WASD camera-relative movement with collision via `game.dungeon.isWalkable`; smooth acceleration; face `game.aim.point`; procedural run/idle/cloak/sword animation; regen mana using `game.getManaRegen()`; shield regen from `game.stats.shield` every 6s since damage; cooldown timers. Dodge if `Space` pressed and cooldown ready: quick collision-safe dash in move direction (or aim dir if idle), invulnerable 0.2s, VFX trail via game.vfx.
- `dodge()` optional helper; input handled in update.
- `playAttack(angle, heavy=false)`: sword slash animation + trail VFX; no damage logic.
- `playCast(school)`: brief cast pose/glow.
- `takeDamage(amount, source, opts)`: armor reduction, shield absorption, invuln check, UI flash, screen shake, audio, death when hp<=0 -> sets dead and calls `game.onPlayerDeath()` once.
- `heal(n)`, `restoreMana(n)`, `addShield(n)`, `gainXp(n)` -> returns levels gained; level-ups raise max hp/mana/damage, refill some, add skill point, VFX/UI/audio. XP uses `XP_TABLE` from config. Game handles passives; player's `maxShield` is updated by game each frame? Simpler: player reads `game.stats.shield` for cap when adding shield.
- `getMuzzlePosition()` -> Vector3 near sword/hand for spell origins.
- `resetForDepth()` heal 25%, refill mana, reposition at dungeon spawn, clear states.
- `dispose()`.
Do not import game.js. Use `game.*` facade only. Visual: procedural low-poly knight ~1.8m tall, animated limbs, cape, glowing chest rune, ember eyes, sword with emissive edge. Shadows cast. No external assets.

`src/entities/enemy.js` exports `class Enemy` and `ENEMY_TYPES` re-export maybe.
`new Enemy(scene, game, defId, position, roomIndex, opts={elite, scaleHp, scaleDamage, scaleXp, boss})`.
Properties: `group`, `position` getter, `radius`, `hp`, `maxHp`, `def`, `name`, `roomIndex`, `dead`, `dying`, `elite`, `isBoss`, `statuses` {burn:{until,dps}, chill:{until,slow}, shock:{until,amp}, void:{until}}, `bodyHeight`.
Methods:
- `update(dt)`: AI with wall collision (`isWalkable`) and enemy separation; face player; procedural animation. Melee windup telegraph -> game.damagePlayer; ranged/caster fire `game.projectiles.spawn` (enemy owner) with telegraph glow; brute slam AoE telegraph; boss multi-phase (slam, nova, summons via `game.spawnEnemy('skeleton', ...)`, charge/teleport), telegraphed with `game.vfx` rings and audio. Use room bounds/leash.
- `takeDamage(amount, opts)`: hp, hit flash, knockback (small), floating health handled by UI; die() -> set dead, death animation, game.onEnemyKilled(this), VFX/audio. Return killed bool.
- `applyStatus(type, duration, dps)`: visuals; burn ticks in update via `game.dealDamage(this, dps*dt, {element:'fire', canCrit:false, noNumber:true, source:'dot'})` throttled to 0.5s; chill slow 55%; shock +15% damage taken; void maybe purple aura. `isChilled`.
- `hasStatus(type)`.
- `dispose()`.
Boss must be memorable: large armored warden with glowing core, ember crown, ground-slam shockwaves, summoning, phase 2 fire nova/charge, death explosion. Boss HP bar via UI (`game.ui.setBoss(this)` on spawn/death handled by game).
Elite: colored aura, larger scale, extra HP/damage, name prefix.
Models procedural, shared materials/geometries where possible. Cast shadows. Keep draw calls reasonable.

Character rendering: `src/entities/models.js` caches beveled armor, open-front hoods, and folded, tapered cloth geometry. Capes and hood interiors render double-sided; cloth is nonmetallic. Material prototype keys include surface options so matching colors do not override roughness or metalness. Player and Warden use cool steel with burgundy capes; skeleton skull sockets, archer quivers, cultist staff halo, and brute tusks distinguish enemy silhouettes. Model part names and animation pivots remain unchanged.

## Loot contract (integration)
`src/data/loot.js` owns procedural gear: `GEAR_SLOTS` (weapon/armor/accessory), `GEAR_RARITY` (common→magic→rare→legendary, with CSS/hex colors), `BAG_LIMIT`, `rollRarity(depth, bias)`, `rollLootItem({depth, bias, slot, forcedRarity, minRarity})`, `createStarterWeapon()`, `aggregateGear(equipped)`, `itemStatLines(item)`, `itemPowerLines(item)`.
- Rarity curve: weighted tiers; depth and enemy bias shift weight upward. Normal enemies roll gear ~9% (+1.2%/depth), elites ~50% and at least magic, the boss always drops 3 items at rare or better.
- Rolled affixes are slot-specific (weapon: damage/crit/lifesteal; armor: armor/life/thorns/shield; accessory: mana/regen/move/gold/pickup). Rare items get one power, legendaries two.
- Powers map to real hooks: brands (burn/chill/shock on basic attacks), vampiric (lifesteal), thorns (reflect), executioner (low-life bonus), soul harvest (mana on kill), emberheart (burn aura), echoing (spell echo), deathbloom (death explosion), stormchain (attack arc), gilded (gold find).
- `Game` owns `equipped`, `inventory`, `gearStats`, `gearPowers`; gear auto-picks up into the satchel (30 slots), `I` opens the armory overlay, clicking bag gear equips it, clicking an equipped slot stows it, and the hover ✕ melts a bag item into gold. `_applyGear()` folds affixes into `game.stats` and adjusts `player.maxHp/maxMana/shield`; `_resetRun()` restores the starter Ashen Blade.

## Combat/VFX contract (combat agent)
`src/combat/vfx.js` exports `class VFX`.
`new VFX(scene, game)`.
Methods (all take world positions, all self-cleaning, pooled where sensible):
- `update(dt)`
- `burst(position, {count=24,color=0xff6b2b,size=0.15,speed=6,life=0.7,spread=1,gravity=0,additive=true})`
- `ring(position, {radius=4,color,life=0.45,height=0.1,thickness=0.25,startRadius=0.2})` expanding ground ring
- `shockwave(position, {radius,color,life,height})` vertical/flat ring
- `beam(from,to,{color,width=0.08,life=0.25})`
- `lightning(from,to,{color=0x9d7bff,life=0.25,jitter=0.4,branches=2})`
- `slash(position, angle, {color,radius=2.4,life=0.22,arc=Math.PI*0.8,height=1.0})` curved sword arc
- `runeCircle(position, {color,radius,life,duration,rotate})` glowing sigil
- `trail(mesh?)` maybe internal
- `impact(position, color, scale=1)` sparks + flash light
- `explosion(position, {radius,color,scale})` big layered burst + shockwave + light flash
- `frostBurst`, `voidRift`, `meteorFall`, `blizzardZone`, `blackHole`, `portal` helpers if useful
- `screenFlash` handled by game, not VFX.
Quality bar: additive shader particles with soft round sprites, embers, smoke, sparks; dynamic PointLights on big effects with short lifetime; bloom-friendly emissive. Pool and cap particles (~2500 max). Do not tank FPS.
`src/combat/projectiles.js` exports `class ProjectileSystem`.
`new ProjectileSystem(scene, game)`.
- `spawn(opts)` where opts: { position:Vector3, direction:Vector3, speed, radius=0.25, life=3, owner:'player'|'enemy', damage, element, color, scale=1, trail=true, homingTarget?:Enemy, turnRate?, pierce=0, onHit?(enemy, projectile), onExpire?(position, projectile), mesh? }. Handles collisions vs `game.enemies` (player owner) or player (enemy owner), walls via dungeon.isWalkable, expiry. Calls `game.dealDamage` for player projectiles if no onHit, `game.damagePlayer` for enemy projectiles. Visual: glowing core + trail + light. 
- `update(dt)`, `dispose()`, `clear()`.
`src/combat/skills.js` exports `class SkillSystem`.
`new SkillSystem(game)`.
- `ranks`: object nodeId->rank, starts all 0. `unlocked` Set of active ids with rank>0.
- `cooldowns`: id->remaining. `update(dt)`.
- `canCast(id)`: rank>0, cooldown<=0, player mana >= mana cost, player alive.
- `cast(id, opts={})`: if canCast, spend mana, set cooldown, player.playCast(element), audio, execute. Use `game.aim` and helpers. Return bool.
- `rankNode(id)` -> {ok, reason}: checks skill point and prereqs (all req nodes rank>=1), increments rank, if active adds to unlocked. Game refreshes stats after.
- `canRank(id)` -> {ok, reason}
- `getActiveSkills()` -> array in tree order of {id,name,icon,color,mana,cooldown,rank} (all unlocked actives; UI maps keys 1..N).
- `getPassiveStats()` -> object aggregated from PASSIVE_STATS in data/skills.js.
- `reset()` clears ranks/cooldowns (new run only; game may call).
- Echo passive: after a spell cast, if rank eclipse>0 and Math.random()<echoChance, schedule a second execution at 45% power after 0.35s (no mana/cooldown, no further echo). Skills need a `power` multiplier argument internally.
All nine actives in ACTIVE_SKILLS must be implemented with distinct, spectacular effects and correct mechanics (see data/skills.js descriptions):
ember_bolt (homing-ish projectile w/ explosion+burn), flame_wave (cone wave), meteor (telegraphed fall + AoE + burning ground), frost_nova (ring, chill), ice_shards (7 shard projectiles cone, chill), blizzard (persistent AoE snow/ice spikes for 5s), shadow_step (blink 8m, invuln, damage path), chain_lightning (arcs up to 5 targets, shock), singularity (black hole pull 1.6s, void damage).
Use game.dealDamage for all enemy damage. Apply statuses via game.applyStatus/game.applyChill. Use vfx and projectiles heavily. Respect stats.power scaling from rank (base numbers in data/skills.js).
Add skill-specific lights, shake, hitstop, audio names. Avoid per-frame allocations in hot loops.

## UI/Audio contract (UI agent)
`src/ui/ui.js` exports `class UI`; may add `src/ui/skilltree.js`, `src/ui/ui.css` (imported from ui.js) or append-only rules to `src/style.css` (do not change existing selectors).
`new UI(game)` mounts into `#ui-root`. All overlays must have `.interactive` where clickable. High-end dark fantasy UI: Cinzel headings, gold filigree, translucent obsidian panels, subtle animations, responsive. No external images.
Methods:
- `showStart()`: full-screen title EMBERFALL, subtitle "Ashen Depths", class description, controls, big "Enter the Depths" button -> `game.startRun()`; audio init on click. Animated embers CSS. Start overlay removed on start.
- `showHUD()` / `hideHUD()`
- `setVitals(hp,maxHp,mana,maxMana,shield)`; `setProgress(level,xp,xpNext,depth,kills)`
- `setSkillBar(skills, cooldowns)`: bottom center slots with key labels, icon glyphs, cooldown sweep/number, mana cost, disabled state. `skills` from game.skills.getActiveSkills().
- `setSkillPoints(n)`: badge/prompt.
- `showBanner(title, subtitle='', tone='gold', duration=2.5)`
- `showToast(text, tone='gold')`
- `showDamageNumber(worldPos, value, {color='#ffe2b8', crit=false, element='physical'})` world->screen projection via game.camera/renderer; animated float/fade; crit larger.
- `updateEnemyBars(enemies, camera)`: projected compact health bars above enemies within view; elite names/colors; hide dead. Use DOM cache WeakMap.
- `setBoss(enemy|null)`: boss health bar top-center with name, phase tint; update via update().
- `showGameOver(stats, onRevive, onNewRun)`: overlay with run stats and buttons. Do not call game methods directly except via callbacks.
- `showPause(onResume)`, `hidePause()`
- `toggleSkillTree()` / `openSkillTree()` / `closeSkillTree()`: overlay with 3 branch columns, SVG connectors, nodes with icons, ranks, prereq states, hover tooltip (description for next rank), click to `game.skills.rankNode(id)` then re-render, points counter. Must pause gameplay while open (game handles via `ui.onSkillTreeToggle` callback? UI sets `game.state`? Contract: call `game.setOverlay('skilltree', true/false)` if exists; parent will provide; or dispatch CustomEvent 'ui-overlay'. Parent implements `game.setOverlay(kind, open)`. Use `game.setOverlay('skilltree', true)` and `game.setOverlay('skilltree', false)`; guard if missing.)
- `refreshSkillTree()` re-renders from `game.skills.ranks`, `game.player.skillPoints`.
- `updateMinimap(dungeon, player, enemies)`: canvas top-right showing walkable grid, rooms, current room highlight, player arrow, enemy dots, portal marker.
- `update(dt)`: cooldown sweeps, boss bar, minimap throttled, damage number cleanup.
- `flash(color, strength=0.35)` full-screen flash.
- `showDepthTransition(depth)` maybe.
- `destroy()`.
Skill tree click should only work if player has points and prereqs. Show reasons. Hotbar must update after ranks change via game.
`src/core/audio.js` exports `class Audio` (or AudioEngine). `new Audio()`.
- `init()` on user gesture: create AudioContext, master gain, reverb send; procedural synthesis only (oscillators, noise buffers, filters, envelopes).
- `play(name, {volume=1, rate=1, pan=0}={})`: synth sounds for: ui_click, ui_hover, swing, hit, crit, player_hurt, enemy_death, fireball_cast, fireball_explode, flame_wave, frost_cast, frost_burst, ice_shards, meteor_warn, meteor_impact, blizzard, lightning, dash, void_cast, singularity, heal, loot, level_up, shield, boss_roar, room_clear, portal, death. Unknown name = silent.
- `startAmbience()`: layered dark ambient drone + wind + occasional distant drips/braziers; loops until stopAmbience(). Adjust per depth with `setDepth(depth)`.
- `stopAmbience()`, `setMasterVolume(v)`, `update(dt)` optional.
Keep CPU low; reuse noise buffer; cap voices.

## Integration notes
Parent wires everything. Use only the contract above. If a required method is missing, implement it yourself inside your assigned files and document assumptions in your final report. Do not modify shared files. Run `npm run build` is parent's job; you can use `node --check` on your JS files. Report files created, APIs implemented, and any deviations. Keep code production-quality, no TODOs/stubs.
