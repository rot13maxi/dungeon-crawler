// EMBERFALL — HUD and overlay layer. Owns everything inside #ui-root:
// start screen, vitals, XP, progress, skill bar, boss bar, minimap,
// enemy bars, damage numbers, banners, toasts, overlays, skill tree.
// Reads from the game facade every frame in update(dt). No game.js import.

import './ui.css';
import * as THREE from 'three';
import { WORLD } from '../config.js';
import {
  BAG_LIMIT, GEAR_RARITY, GEAR_SLOTS, itemPowerLines, itemStatLines,
} from '../data/loot.js';
import { SkillTree } from './skilltree.js';

const TONE_COLORS = {
  gold: '#f4d79a',
  ember: '#ff8a3d',
  frost: '#8fe6ff',
  void: '#d884ff',
  hp: '#ff6b6b',
  mana: '#8fd0ff',
  common: '#b9b2a6',
  magic: '#6fa8ff',
  rare: '#ffd166',
  legendary: '#ff7a2f',
};

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

export class UI {
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('ui-root');
    if (!this.root) throw new Error('UI: #ui-root not found');

    this.el = document.createElement('div');
    this.el.className = 'ef';
    this.root.appendChild(this.el);

    this._enemyBarCache = new WeakMap();
    this._enemyBarPool = [];
    this._dmgNumbers = []; // {el, pos:Vector3, vy, life, ttl}
    this._toasts = [];
    this._banner = null;
    this._bossEnemy = null;
    this._cdDigits = []; // skill slot DOM refs for cooldown updates
    this._skillsRef = []; // last skills array from setSkillBar
    this._mmTimer = 0;
    this._flashValue = 0;
    this._flashDecay = 0;
    this._tree = null;

    // Scratch vectors (zero allocation in hot paths).
    this._pv = new THREE.Vector3();
    this._ep = new THREE.Vector3();
    this._dp = new THREE.Vector3();
    this._sp = { x: 0, y: 0, behind: false };
    this._cd = new THREE.Vector3();

    this._build();
  }

  // ------------------------------------------------------------- structure

  _build() {
    const E = (cls, parent, html = '') => {
      const d = document.createElement('div');
      d.className = cls;
      if (html) d.innerHTML = html;
      (parent || this.el).appendChild(d);
      return d;
    };

    // Full-screen flash (topmost, blend screen).
    this._flashEl = E('ef-flash', this.el);

    // ---------------- start screen ----------------
    this.startEl = E('ef-start interactive', this.el, `
      <div class="ef-start-embers" data-embers></div>
      <div class="ef-start-rule"><span class="gem">◆</span></div>
      <div class="ef-start-kicker">A DESCENT INTO RUIN</div>
      <h1 class="ef-start-title">EMBERFALL</h1>
      <div class="ef-start-sub">ASHEN DEPTHS</div>
      <div class="ef-start-rule"><span class="gem">◆</span></div>
      <div class="ef-start-class">
        <div class="ef-class-name">THE EMBER KNIGHT</div>
        A hooded blade tempered in dying fire. Steel, spellcraft and stubborn
        ash-covenant carry you downward through vaults that hunger for the
        light you bear.
      </div>
      <div class="ef-start-controls">
        <span><b>WASD</b>Move</span>
        <span><b>LMB</b>Attack</span>
        <span><b>SPACE</b>Dodge</span>
        <span><b>1–9</b>Spells</span>
        <span><b>T</b>Skill Tree</span>
        <span><b>I</b>Armory</span>
        <span><b>ESC</b>Pause</span>
      </div>
      <button class="ef-button ef-start-enter" data-enter>ENTER THE DEPTHS</button>
    `);
    this.startEl.querySelector('[data-enter]').addEventListener('click', () => {
      this.game.audio?.init?.();
      this.game.startRun();
    });
    const emberWrap = this.startEl.querySelector('[data-embers]');
    for (let i = 0; i < 26; i++) {
      const ember = document.createElement('i');
      ember.className = 'ef-ember';
      ember.style.left = `${Math.random() * 100}%`;
      ember.style.animationDuration = `${5.5 + Math.random() * 8}s`;
      ember.style.animationDelay = `${-Math.random() * 12}s`;
      ember.style.setProperty('--drift', `${(Math.random() * 2 - 1) * 90}px`);
      const s = 0.6 + Math.random() * 1.6;
      ember.style.transform = `scale(${s})`;
      emberWrap.appendChild(ember);
    }
    this.startEl.addEventListener('mouseenter', (e) => {
      if (e.target.closest?.('.ef-button')) this.game.audio?.play?.('ui_hover', { volume: 0.5 });
    }, true);

    // ---------------- HUD ----------------
    this.hudEl = E('ef-hud', this.el);
    this.hudEl.classList.add('hidden');

    // Vitals: bottom-left
    this._vitals = E('ef-vitals', this.hudEl, `
      <div class="ef-vitals-crest">
        <div class="ef-level-medallion" data-level>1</div>
        <div>
          <div class="ef-vitals-name">EMBER KNIGHT</div>
          <div class="ef-bar-label" style="position:static;justify-content:flex-start;gap:0;padding-left:2px;font-size:10px;color:var(--ef-muted);letter-spacing:0.18em;">
            <span data-hptext>120 / 120</span>
          </div>
        </div>
      </div>
      <div class="ef-bar ef-bar-hp" data-hpbar>
        <div class="ef-bar-ghost" data-hpghost></div>
        <div class="ef-bar-fill" data-hpfill></div>
        <div class="ef-shield-layer" data-shield></div>
        <div class="ef-bar-label"><span data-hpnum>120 / 120</span></div>
      </div>
      <div class="ef-bar ef-bar-mana" data-manabar>
        <div class="ef-bar-fill" data-manafill></div>
        <div class="ef-bar-label"><span data-mananum>110 / 110</span></div>
      </div>
    `);
    this._hpBar = this._vitals.querySelector('[data-hpbar]');
    this._hpFill = this._vitals.querySelector('[data-hpfill]');
    this._hpGhost = this._vitals.querySelector('[data-hpghost]');
    this._hpNum = this._vitals.querySelector('[data-hpnum]');
    this._manaFill = this._vitals.querySelector('[data-manafill]');
    this._manaNum = this._vitals.querySelector('[data-mananum]');
    this._shieldEl = this._vitals.querySelector('[data-shield]');
    this._levelEl = this._vitals.querySelector('[data-level]');

    // XP strip across the bottom
    this.xpEl = E('ef-xpbar', this.hudEl, '<div class="ef-xpbar-fill" data-xpfill></div>');
    this._xpFill = this.xpEl.querySelector('[data-xpfill]');

    // Progress: top center
    this._progress = E('ef-progress ef-panel', this.hudEl, `
      <span>DEPTH <b data-depth>1</b></span><span class="sep">·</span>
      <span>LEVEL <b data-proglevel>1</b></span><span class="sep">·</span>
      <span>SLAIN <b data-kills>0</b></span>
    `);
    this._depthEl = this._progress.querySelector('[data-depth]');
    this._progLevelEl = this._progress.querySelector('[data-proglevel]');
    this._killsEl = this._progress.querySelector('[data-kills]');

    // Skill bar: bottom center
    this._skillBar = E('ef-skillbar', this.hudEl);

    // Equipped gear strip: bottom right. Click opens the armory.
    this._gearEl = E('ef-gear interactive', this.hudEl, `
      <div class="ef-gear-slot" data-gear-slot="weapon"><span class="gi">⚔</span><span class="gn">Weapon</span></div>
      <div class="ef-gear-slot" data-gear-slot="armor"><span class="gi">❖</span><span class="gn">Armor</span></div>
      <div class="ef-gear-slot" data-gear-slot="accessory"><span class="gi">◈</span><span class="gn">Accessory</span></div>
      <div class="ef-gear-hint"><b>I</b> ARMORY <span class="bag" data-bagcount>0</span></div>
    `);
    this._gearSlots = {};
    for (const el of this._gearEl.querySelectorAll('[data-gear-slot]')) {
      this._gearSlots[el.dataset.gearSlot] = el;
    }
    this._gearEl.addEventListener('click', () => this.openInventory());

    // Skill points prompt
    this._spEl = E('ef-skillpoints', this.hudEl, `
      <span class="count" data-spcount>0</span>
      <span>SKILL POINTS</span>
      <span class="hint">— press T</span>
    `);

    // Boss bar: top center
    this._bossEl = E('ef-bossbar', this.hudEl, `
      <div class="ef-boss-name"><span class="orn">✦</span><span data-bossname>BOSS</span><span class="orn">✦</span></div>
      <div class="ef-boss-track" data-bosstrack>
        <div class="ef-boss-fill" data-bossfill></div>
        <div class="pips"><span></span><span></span><span></span></div>
      </div>
    `);
    this._bossEl.style.display = 'none';
    this._bossName = this._bossEl.querySelector('[data-bossname]');
    this._bossFill = this._bossEl.querySelector('[data-bossfill]');
    this._bossTrack = this._bossEl.querySelector('[data-bosstrack]');

    // Minimap: top right
    const mmWrap = E('ef-minimap-wrap ef-panel', this.hudEl, `
      <div class="ef-mm-label">THE DEPTHS</div>
      <canvas class="ef-minimap" width="336" height="336" data-mm></canvas>
      <div class="ef-mm-depth" data-mmdepth>DEPTH I</div>
    `);
    this._mmCanvas = mmWrap.querySelector('[data-mm]');
    this._mmDepth = mmWrap.querySelector('[data-mmdepth]');
    this._mmCtx = this._mmCanvas.getContext('2d');

    // Enemy bars + damage numbers layer
    this._ebarLayer = E('ef-ebar-layer', this.hudEl);
    this._ebarLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
    this._dmgLayer = E('ef-dmg-layer', this.hudEl);
    this._dmgLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;';

    // Banners / toasts
    this._bannerLayer = E('ef-banner-layer', this.hudEl);
    this._bannerLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    this._toastLayer = E('ef-toasts', this.hudEl);
    this._toastLayer.classList.remove('ef-toasts');
    this._toastLayer.className = 'ef-toasts';

    // ---------------- overlays ----------------
    this._pauseEl = E('ef-overlay interactive', this.el, `
      <div class="ef-panel">
        <h2 class="ef-title">PAUSED</h2>
        <div class="ef-ov-sub">THE DARK HOLDS ITS BREATH</div>
        <div class="ef-ov-buttons">
          <button class="ef-button" data-resume>RESUME</button>
          <button class="ef-button" data-tree>SKILL TREE&nbsp;&nbsp;[T]</button>
        </div>
        <div class="ef-ov-hint">ESC TO RESUME</div>
      </div>
    `);
    this._pauseEl.style.display = 'none';
    this._pauseEl.querySelector('[data-resume]').addEventListener('click', () => this._pauseCb?.());
    this._pauseEl.querySelector('[data-tree]').addEventListener('click', () => {
      this._pauseCb?.();
      this.openSkillTree();
    });
    this._pauseCb = null;

    this._invEl = E('ef-overlay interactive', this.el, `
      <div class="ef-panel ef-inv-panel">
        <h2 class="ef-title">ARMORY</h2>
        <div class="ef-ov-sub">GEAR CARRIED FROM THE DEPTHS</div>
        <div class="ef-inv-equipped" data-equipped></div>
        <div class="ef-inv-head"><span>SATCHEL</span><span data-invbagcount></span></div>
        <div class="ef-inv-bag" data-bag></div>
        <div class="ef-ov-buttons"><button class="ef-button" data-inv-close>CLOSE&nbsp;&nbsp;[I]</button></div>
        <div class="ef-ov-hint">CLICK AN ITEM TO EQUIP · CLICK AN EQUIPPED SLOT TO STOW</div>
      </div>
    `);
    this._invEl.style.display = 'none';
    this._invEl.addEventListener('click', (e) => {
      const drop = e.target.closest('[data-discard-index]');
      if (drop) {
        e.stopPropagation();
        this.game.discardItem?.(Number(drop.dataset.discardIndex));
        return;
      }
      const bag = e.target.closest('[data-bag-index]');
      if (bag) {
        const item = this.game.inventory[Number(bag.dataset.bagIndex)];
        if (item) this.game.equipItem?.(item);
        return;
      }
      const eq = e.target.closest('[data-unequip]');
      if (eq) {
        this.game.unequipItem?.(eq.dataset.unequip);
        return;
      }
      if (e.target.closest('[data-inv-close]')) this.closeInventory();
    });

    this._overEl = E('ef-overlay interactive', this.el, `
      <div class="ef-panel">
        <h2 class="ef-title" style="color:#ff7a5c;">YOU HAVE FALLEN</h2>
        <div class="ef-ov-sub">THE DEPTHS CLAIM ANOTHER</div>
        <div class="ef-ov-stats" data-overstats></div>
        <div class="ef-ov-buttons">
          <button class="ef-button" data-revive>RISE AGAIN</button>
          <button class="ef-button" data-newrun>NEW DESCENT</button>
        </div>
      </div>
    `);
    this._overEl.style.display = 'none';
    this._overEl.querySelector('[data-revive]').addEventListener('click', () => this._overRevive?.());
    this._overEl.querySelector('[data-newrun]').addEventListener('click', () => this._overNew?.());
    this._overRevive = null;
    this._overNew = null;

    // Skill tree overlay (component: skilltree.js)
    this._tree = new SkillTree(this.game, this.el, () => {
      this.game.setOverlay?.('skilltree', false);
    });
    this._tree.close();
  }

  // ---------------------------------------------------------- start screen

  showStart() {
    this.startEl.style.display = '';
    this.hideHUD();
  }

  hideStart() {
    this.startEl.style.display = 'none';
  }

  // --------------------------------------------------------------- HUD

  showHUD() {
    this.hudEl.classList.remove('hidden');
    this._hudVisible = true;
  }

  hideHUD() {
    this.hudEl.classList.add('hidden');
    this._hudVisible = false;
    this.setBoss(null);
  }

  // --------------------------------------------------------------- vitals

  setVitals(hp, maxHp, mana, maxMana, shield) {
    const hpPct = Math.max(0, Math.min(1, maxHp > 0 ? hp / maxHp : 0));
    const manaPct = Math.max(0, Math.min(1, maxMana > 0 ? mana / maxMana : 0));
    const shieldPct = Math.min(100, maxHp > 0 ? (shield / maxHp) * 100 : 0);
    this._hpFill.style.width = `${hpPct * 100}%`;
    this._hpGhost.style.width = `${hpPct * 100}%`;
    this._manaFill.style.width = `${manaPct * 100}%`;
    this._shieldEl.style.width = `${shieldPct}%`;
    this._hpNum.textContent = `${Math.max(0, Math.ceil(hp))} / ${Math.ceil(maxHp)}`;
    this._manaNum.textContent = `${Math.max(0, Math.floor(mana))} / ${Math.floor(maxMana)}`;
    this._hpBar.classList.toggle('low', hpPct < 0.3 && hp > 0);
  }

  setProgress(level, xp, xpNext, depth, kills) {
    this._levelEl.textContent = String(level);
    this._depthEl.textContent = ROMAN[depth] ?? String(depth);
    this._progLevelEl.textContent = String(level);
    this._killsEl.textContent = String(kills);
    this._xpFill.style.width = `${Math.max(0, Math.min(100, xpNext > 0 ? (xp / xpNext) * 100 : 0))}%`;
  }

  // ------------------------------------------------------------ skill bar

  setSkillBar(skills, cooldowns) {
    skills = skills || [];
    this._skillsRef = skills;
    if (skills.length !== this._slotsBuiltFor) {
      this._slotsBuiltFor = skills.length;
      this._skillBar.innerHTML = '';
      this._cdDigits = [];
      skills.forEach((s, i) => {
        const slot = document.createElement('div');
        slot.className = 'ef-slot';
        slot.style.setProperty('--skill-color', s.color);
        slot.innerHTML = `
          <span class="key">${i + 1}</span>
          <span class="glyph" style="color:${s.color}">${s.icon}</span>
          <span class="rank">${'·'.repeat(Math.max(1, s.rank))}</span>
          <span class="cost">${s.mana}</span>
          <div class="ef-cooldown"></div>
          <div class="ef-cd-num"></div>
        `;
        this._skillBar.appendChild(slot);
        this._cdDigits.push({ el: slot, cd: slot.querySelector('.ef-cooldown'), num: slot.querySelector('.ef-cd-num'), rank: slot.querySelector('.rank'), cost: slot.querySelector('.cost') });
      });
    } else {
      skills.forEach((s, i) => {
        const ref = this._cdDigits[i];
        if (!ref) return;
        ref.el.style.setProperty('--skill-color', s.color);
        const glyph = ref.el.querySelector('.glyph');
        if (glyph) { glyph.textContent = s.icon; glyph.style.color = s.color; }
        if (ref.rank) ref.rank.textContent = '·'.repeat(Math.max(1, s.rank));
        if (ref.cost) ref.cost.textContent = s.mana;
      });
    }
    // Cost coloring against current mana.
    const mana = this.game.player ? this.game.player.mana : Infinity;
    skills.forEach((s, i) => {
      const ref = this._cdDigits[i];
      if (!ref) return;
      ref.el.classList.toggle('nomana', this.game.player.mana < s.mana);
      ref.el.classList.toggle('casting', (cooldowns?.[s.id] ?? 0) <= 0 && this.game.player.mana >= s.mana);
    });
    this._cooldownsRef = cooldowns || {};
  }

  setSkillPoints(n) {
    this._spEl.querySelector('[data-spcount]').textContent = String(n);
    this._spEl.style.display = n > 0 ? '' : 'none';
  }

  // -------------------------------------------------------------- banners

  showBanner(title, subtitle = '', tone = 'gold', duration = 2.5) {
    const color = TONE_COLORS[tone] ?? TONE_COLORS.gold;
    const layer = this._bannerLayer;
    if (this._banner) {
      this._banner.el.remove();
      clearTimeout(this._banner.timer);
      this._banner = null;
    }
    const el = document.createElement('div');
    el.className = 'ef-banner';
    el.style.setProperty('--banner-glow', `${color}88`);
    el.innerHTML = `
      <div class="ef-banner-title" style="color:${color}">${title}</div>
      ${subtitle ? `<div class="ef-banner-sub">${subtitle}</div>` : ''}
      <svg class="ef-banner-rule" viewBox="0 0 420 12" preserveAspectRatio="none">
        <line x1="0" y1="6" x2="420" y2="6" stroke="${color}" stroke-opacity="0.45" stroke-width="1"/>
        <path d="M 180 6 L 204 2 L 210 6 L 216 10 Z" fill="${color}" fill-opacity="0.7"/>
        <path d="M 210 6 L 234 2 L 240 6 L 246 10 Z" fill="${color}" fill-opacity="0.45"/>
        <path d="M 180 6 L 174 2 L 168 6 L 174 10 Z" fill="${color}" fill-opacity="0.45"/>
      </svg>
    `;
    layer.appendChild(el);
    const timer = setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 520);
      if (this._banner && this._banner.el === el) this._banner = null;
    }, Math.max(0.2, duration) * 1000);
    this._banner = { el, timer };
  }

  showToast(text, tone = 'gold') {
    const color = TONE_COLORS[tone] ?? TONE_COLORS.gold;
    const el = document.createElement('div');
    el.className = 'ef-toast';
    el.style.setProperty('--toast-color', color);
    el.textContent = text;
    this._toastLayer.appendChild(el);
    while (this._toastLayer.children.length > 4) this._toastLayer.firstChild.remove();
    const timer = setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 380);
    }, 2400);
    this._toasts.push({ el, timer });
  }

  // ------------------------------------------------------- damage numbers

  showDamageNumber(worldPos, value, { color = '#ffe2b8', crit = false, element = 'physical' } = {}) {
    if (!this._hudVisible && this.game.state !== 'dead') return;
    const el = document.createElement('div');
    el.className = 'ef-dmg' + (crit ? ' crit' : '');
    el.textContent = String(Math.round(value));
    if (!crit) el.style.color = color;
    this._dmgLayer.appendChild(el);
    // Store a lightweight position copy — Vector3 keeps being mutated upstream.
    const pos = { x: worldPos.x, y: worldPos.y, z: worldPos.z };
    this._dmgNumbers.push({ el, pos, life: 0, dur: 0.95, rise: 0.55 + Math.random() * 0.3, drift: (Math.random() * 2 - 1) * 0.3 });
  }

  _projectToScreen(pos, out) {
    const v = this._pv.set(pos.x, pos.y, pos.z).project(this.game.camera);
    const w = window.innerWidth, h = window.innerHeight;
    out.x = (v.x * 0.5 + 0.5) * w;
    out.y = (-v.y * 0.5 + 0.5) * h;
    out.behind = v.z > 1 || v.z < -1;
    return out;
  }

  // ---------------------------------------------------------- enemy bars

  updateEnemyBars(enemies, camera) {
    const layer = this._ebarLayer;
    const w = window.innerWidth, h = window.innerHeight;
    const seen = new Set();
    const camDir = this._cd.set(0, 0, -1).applyQuaternion(camera.quaternion);

    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e || e.dead || e.dying) continue;
      // Cheap off-screen / behind-camera cull before projecting.
      const dx = e.position.x - camera.position.x;
      const dy = e.position.y - camera.position.y;
      const dz = e.position.z - camera.position.z;
      if (dx * camDir.x + dy * camDir.y + dz * camDir.z < 0.5) continue;

      this._projectToScreen(this._ep.set(e.position.x, e.position.y + (e.bodyHeight ?? 1.7) + 0.5, e.position.z), this._sp);
      if (this._sp.behind || this._sp.x < -40 || this._sp.x > w + 40 || this._sp.y < 40 || this._sp.y > h) continue;

      let rec = this._enemyBarCache.get(e);
      if (!rec) {
        const el = this._enemyBarPool.pop() || document.createElement('div');
        el.className = 'ef-ebar';
        el.innerHTML = `
          <div class="ef-ebar-name"></div>
          <div class="ef-ebar-track"><div class="ef-ebar-fill"></div></div>
        `;
        rec = { el, name: el.querySelector('.ef-ebar-name'), fill: el.querySelector('.ef-ebar-fill') };
        this._enemyBarCache.set(e, rec);
        layer.appendChild(el);
      }
      const name = (e.elite ? '✧ ' : '') + e.name;
      if (rec.name.textContent !== name) rec.name.textContent = name;
      const pct = Math.max(0, Math.min(1, e.maxHp > 0 ? e.hp / e.maxHp : 0));
      rec.fill.style.width = `${pct * 100}%`;
      const el = rec.el;
      el.style.transform = `translate(-50%, -100%) translate(${this._sp.x}px, ${this._sp.y}px)`;
      el.classList.toggle('elite', !!e.elite);
      el.classList.toggle('boss-minion', !!e.isBoss);
      el.style.opacity = '1';
      el.style.display = '';
      el._efRec = rec;
      seen.add(rec);
    }

    // Hide bars not seen this frame (cached per enemy via WeakMap).
    for (const child of [...layer.children]) {
      if (!seen.has(child._efRec)) child.style.display = 'none';
    }
  }

  // ---------------------------------------------------------------- boss

  setBoss(enemy) {
    this._bossEnemy = enemy;
    if (enemy) {
      this._bossEl.style.display = '';
      this._bossName.textContent = (enemy.name ?? 'UNKNOWN HORROR').toUpperCase();
    } else {
      this._bossEl.style.display = 'none';
    }
  }

  _updateBoss(dt) {
    const e = this._bossEnemy;
    if (!e) return;
    if (e.dead || e.dying) {
      this.setBoss(null);
      return;
    }
    const pct = Math.max(0, Math.min(1, e.maxHp > 0 ? e.hp / e.maxHp : 0));
    this._bossFill.style.width = `${pct * 100}%`;
    const phase2 = pct <= 0.5;
    this._bossTrack.classList.toggle('phase2', phase2);
  }

  // ------------------------------------------------------------- minimap

  updateMinimap(dungeon, player, enemies) {
    if (!dungeon || !dungeon.grid) return;
    if (this._mmDepth) this._mmDepth.textContent = `DEPTH ${ROMAN[dungeon.depth] ?? dungeon.depth}`;
    const ctx = this._mmCtx;
    const size = this._mmCanvas.width;
    const grid = dungeon.grid;
    const gw = dungeon.gridW;
    const gh = dungeon.gridH;
    if (!gw || !gh) return;
    // The grid is centered on world origin: cell (c,r) spans world
    // [c*CELL - ORIGIN, (c+1)*CELL - ORIGIN]. Map the whole grid onto the
    // canvas so rooms always sit inside the frame regardless of world extents.
    const span = Math.max(gw, gh) * WORLD.cell;
    const s = size / span;
    const ox = size / 2; // world 0 maps to canvas center
    const toPx = (w) => w * s + ox;

    ctx.clearRect(0, 0, size, size);

    // Walkable grid
    ctx.fillStyle = 'rgba(196, 178, 140, 0.34)';
    for (let row = 0; row < gh; row++) {
      const line = grid[row];
      if (!line) continue;
      for (let col = 0; col < gw; col++) {
        if (!line[col]) continue;
        ctx.fillRect(col * WORLD.cell * s + ox + 0.5, row * WORLD.cell * s + ox + 0.5, WORLD.cell * s - 1, WORLD.cell * s - 1);
      }
    }

    // Room borders: boss room ember, entry gold, combat dim
    const curRoom = dungeon.getRoomAt?.(player.position);
    if (dungeon.rooms) {
      for (const room of dungeon.rooms) {
        const b = room.bounds;
        const x = toPx(b.minX), y = toPx(b.minZ);
        const w = (b.maxX - b.minX) * s, h = (b.maxZ - b.minZ) * s;
        ctx.fillStyle = 'rgba(217, 178, 106, 0.10)';
        if (room === curRoom) ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = room.type === 'boss' ? 'rgba(255,122,47,0.75)' : room.type === 'entry' ? 'rgba(217,178,106,0.55)' : 'rgba(150,138,120,0.22)';
        ctx.lineWidth = room === curRoom ? 1.5 : 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        if (room.cleared && room.type === 'combat') {
          ctx.fillStyle = 'rgba(120, 200, 130, 0.13)';
          ctx.fillRect(x, y, w, h);
        }
      }
    }

    // Exit portal marker
    const portal = dungeon.exitPortal;
    if (portal && portal.active) {
      const px = toPx(portal.position.x);
      const py = toPx(portal.position.z);
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(this.game.time * 1.6);
      ctx.strokeStyle = '#ff8a3d';
      ctx.lineWidth = 1.4;
      ctx.strokeRect(-3.5, -3.5, 7, 7);
      ctx.restore();
      ctx.fillStyle = '#ff8a3d';
      ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
    }

    // Enemies
    ctx.fillStyle = '#ff5545';
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e || e.dead) continue;
      ctx.globalAlpha = e.isBoss ? 1 : 0.85;
      ctx.fillRect(toPx(e.position.x) - 1.5, toPx(e.position.z) - 1.5, 3, 3);
    }
    ctx.globalAlpha = 1;

    // Player arrow (direction of aim)
    const px = toPx(player.position.x);
    const py = toPx(player.position.z);
    const dir = this.game.aim?.direction;
    const ang = dir ? Math.atan2(dir.z, dir.x) + Math.PI / 2 : 0;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(ang);
    ctx.fillStyle = '#f4d79a';
    ctx.beginPath();
    ctx.moveTo(0, -5);
    ctx.lineTo(3.5, 4);
    ctx.lineTo(0, 2);
    ctx.lineTo(-3.5, 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // ---------------------------------------------------------------- flash

  flash(color, strength = 0.35) {
    const el = this._flashEl;
    el.style.background = color;
    // One-shot compositor-driven animation. The old per-frame style.opacity writes
    // blended this fullscreen layer against the WebGL canvas on the main thread and
    // stalled weak machines ~80ms on heavy boss-death frames.
    el.style.setProperty('--flash-peak', String(strength));
    el.style.animation = 'none';
    void el.offsetWidth; // restart the animation
    el.style.animation = `ef-flash-fade ${Math.max(0.25, strength / 2.6)}s ease-out forwards`;
  }

  // ----------------------------------------------------------- game over

  showGameOver(stats, onRevive, onNewRun) {
    this._overRevive = onRevive;
    this._overNew = onNewRun;
    const mins = Math.floor(stats.time / 60);
    const secs = Math.floor(stats.time % 60);
    this._overEl.querySelector('[data-overstats]').innerHTML = `
      <div><span>Depth reached</span><b>${ROMAN[stats.depth] ?? stats.depth}</b></div>
      <div><span>Level</span><b>${stats.level}</b></div>
      <div><span>Enemies slain</span><b>${stats.kills}</b></div>
      <div><span>Gold gathered</span><b>${stats.gold}</b></div>
      <div><span>Time endured</span><b>${mins}:${String(secs).padStart(2, '0')}</b></div>
    `;
    this._overEl.style.display = '';
  }

  hideGameOver() {
    this._overEl.style.display = 'none';
  }

  // --------------------------------------------------------------- pause

  showPause(onResume) {
    this._pauseCb = onResume;
    this._pauseEl.style.display = '';
  }

  hidePause() {
    this._pauseEl.style.display = 'none';
  }

  // ----------------------------------------------------------- skill tree

  openSkillTree() {
    if (this.game.state !== 'playing' && this.game.overlay !== 'skilltree') return;
    this.game.setOverlay?.('skilltree', true);
    this._tree.open();
  }

  closeSkillTree() {
    this.game.setOverlay?.('skilltree', false);
    this._tree.close();
  }

  toggleSkillTree() {
    if (this.game.overlay === 'skilltree') this.closeSkillTree();
    else this.openSkillTree();
  }

  refreshSkillTree() {
    if (this._tree) this._tree.refresh();
  }

  // ------------------------------------------------------------- gear / armory

  setGear(equipped, bagCount) {
    this._gearBagCount = bagCount ?? 0;
    if (!this._gearSlots) return;
    for (const [slot, el] of Object.entries(this._gearSlots)) {
      const item = equipped?.[slot];
      const rarity = item ? GEAR_RARITY[item.rarity] : null;
      el.style.setProperty('--gear-rarity', rarity ? rarity.css : 'rgba(214, 183, 130, 0.18)');
      el.classList.toggle('filled', !!item);
      const glyph = el.querySelector('.gi');
      const name = el.querySelector('.gn');
      if (glyph) glyph.textContent = GEAR_SLOTS[slot].icon;
      if (name) name.textContent = item ? item.name : GEAR_SLOTS[slot].label;
      el.title = item ? `${item.name} · ${rarity.name}` : `Empty ${GEAR_SLOTS[slot].label}`;
    }
    const bag = this._gearEl?.querySelector('[data-bagcount]');
    if (bag) bag.textContent = String(this._gearBagCount);
    const invBag = this._invEl?.querySelector('[data-invbagcount]');
    if (invBag) invBag.textContent = `${this._gearBagCount} / ${BAG_LIMIT}`;
  }

  _itemCard(item, { bagIndex = null, equippedSlot = null } = {}) {
    const rarity = GEAR_RARITY[item.rarity] ?? GEAR_RARITY.common;
    const stats = itemStatLines(item)
      .map((l) => `<div class="ii-stat"><span>${l.label}</span><b>${l.text}</b></div>`)
      .join('');
    const powers = itemPowerLines(item)
      .map((p) => `<div class="ii-power"><span class="pw">✦</span><span><b>${p.name}</b> ${p.text}</span></div>`)
      .join('');
    const attr = bagIndex != null
      ? `data-bag-index="${bagIndex}"`
      : `data-unequip="${equippedSlot}"`;
    const melt = bagIndex != null
      ? `<span class="ii-drop" data-discard-index="${bagIndex}" title="Melt for gold">✕</span>`
      : '';
    return `
      <div class="ef-inv-item${equippedSlot ? ' equipped' : ''}" style="--rarity:${rarity.css}" ${attr}>
        <div class="ii-top">
          <span class="ii-icon">${item.icon}</span>
          <span class="ii-name">${item.name}</span>
          <span class="ii-rarity">${rarity.name}</span>
        </div>
        <div class="ii-sub">${GEAR_SLOTS[item.slot].label} · ILVL ${item.ilvl}</div>
        <div class="ii-stats">${stats}</div>
        ${powers ? `<div class="ii-powers">${powers}</div>` : ''}
        ${melt}
      </div>`;
  }

  refreshInventory() {
    if (!this._invEl) return;
    const game = this.game;
    const eqWrap = this._invEl.querySelector('[data-equipped]');
    if (eqWrap) {
      eqWrap.innerHTML = Object.keys(GEAR_SLOTS).map((slot) => {
        const item = game.equipped?.[slot];
        return `<div class="ef-inv-slot">
          <div class="ef-inv-slot-label">${GEAR_SLOTS[slot].label}</div>
          ${item
            ? this._itemCard(item, { equippedSlot: slot })
            : `<div class="ef-inv-empty">Empty ${GEAR_SLOTS[slot].label.toLowerCase()}</div>`}
        </div>`;
      }).join('');
    }
    const bagWrap = this._invEl.querySelector('[data-bag]');
    if (bagWrap) {
      const bag = game.inventory ?? [];
      bagWrap.innerHTML = bag.length
        ? bag.map((item, i) => this._itemCard(item, { bagIndex: i })).join('')
        : '<div class="ef-inv-empty">No spare gear. Slay something.</div>';
    }
    const count = this._invEl.querySelector('[data-invbagcount]');
    if (count) count.textContent = `${game.inventory?.length ?? 0} / ${BAG_LIMIT}`;
  }

  openInventory() {
    if (this.game.state !== 'playing' && this.game.overlay !== 'inventory') return;
    this.game.setOverlay?.('inventory', true);
    this.refreshInventory();
    this._invEl.style.display = '';
    this.game.audio?.play?.('ui_click', { volume: 0.5 });
  }

  closeInventory() {
    this.game.setOverlay?.('inventory', false);
    this._invEl.style.display = 'none';
  }

  toggleInventory() {
    if (this.game.overlay === 'inventory') this.closeInventory();
    else this.openInventory();
  }

  // ------------------------------------------------------------- update

  update(dt) {
    // Cooldown sweeps on hotbar slots.
    const cds = this._cooldownsRef;
    if (cds && this._cdDigits.length) {
      for (let i = 0; i < this._skillsRef.length; i++) {
        const s = this._skillsRef[i];
        const ref = this._cdDigits[i];
        if (!ref || !s) continue;
        const remaining = cds[s.id] ?? 0;
        if (remaining > 0) {
          const frac = Math.max(0, Math.min(1, remaining / s.cooldown));
          ref.cd.style.setProperty('--sweep', `${frac * 100}%`);
          ref.num.textContent = remaining >= 1 ? String(Math.ceil(remaining)) : remaining.toFixed(1);
          ref.num.style.visibility = remaining > 0.08 ? 'visible' : 'hidden';
        } else {
          ref.cd.style.setProperty('--sweep', '0%');
          ref.num.style.visibility = 'hidden';
        }
      }
    }

    this._updateBoss(dt);

    // Damage numbers: rise, fade, cleanup.
    const cam = this.game.camera;
    for (let i = this._dmgNumbers.length - 1; i >= 0; i--) {
      const d = this._dmgNumbers[i];
      d.life += dt;
      const t = d.life / d.dur;
      if (t >= 1) {
        d.el.remove();
        this._dmgNumbers.splice(i, 1);
        continue;
      }
      const y = d.pos.y + d.rise * t;
      const x = d.pos.x + d.drift * t;
      this._projectToScreen(this._dp.set(x, y, d.pos.z), this._sp);
      if (this._sp.behind) { d.el.style.opacity = '0'; continue; }
      d.el.style.transform = `translate(-50%, -50%) translate(${this._sp.x}px, ${this._sp.y}px)`;
      d.el.style.opacity = String(t > 0.65 ? 1 - (t - 0.65) / 0.35 : 1);
    }

    // Minimap throttle ~5 Hz.
    this._mmTimer -= dt;
    if (this._mmTimer <= 0 && this._hudVisible && this.game.player) {
      this._mmTimer = 0.2;
      this.updateMinimap(this.game.dungeon, this.game.player, this.game.enemies);
    }

    // Keep vitals fresh if game doesn't push every frame (it does).
  }

  // ------------------------------------------------------------- resize

  onResize() {
    this._mmTimer = 0; // force minimap redraw
  }

  destroy() {
    for (const t of this._toasts) clearTimeout(t.timer);
    this._toasts.length = 0;
    if (this._banner) clearTimeout(this._banner.timer);
    this.el.remove();
  }
}
