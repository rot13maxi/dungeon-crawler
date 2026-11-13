// EMBERFALL — skill tree overlay. Three branch columns, SVG connectors,
// hover tooltips, click-to-rank through game.skills.rankNode.
// Pure DOM/SVG; reads BRANCHES/NODE_BY_ID directly from data/skills.js.

import { BRANCHES, NODE_BY_ID } from '../data/skills.js';

const KIND_LABEL = { active: 'ACTIVE', passive: 'PASSIVE' };

export class SkillTree {
  /**
   * @param {object} game  facade
   * @param {HTMLElement} root  element to mount into
   * @param {() => void} onClose  invoked when the tree requests to close
   */
  constructor(game, root, onClose) {
    this.game = game;
    this.onClose = onClose;
    this.tipEl = null;
    this._build();
    root.appendChild(this.el);
  }

  _build() {
    this.el = document.createElement('div');
    this.el.className = 'ef-tree interactive';
    this.el.innerHTML = `
      <div class="ef-tree-panel ef-panel">
        <div class="ef-tree-head">
          <div>
            <h2 class="ef-title">THE ASHEN PATHS</h2>
            <div class="ef-tree-hint">Click a node to rank it &middot; T or Esc to close</div>
          </div>
          <div class="ef-tree-points"><b data-points>0</b> SKILL POINTS</div>
        </div>
        <div class="ef-tree-branches" data-branches></div>
      </div>
      <div class="ef-tree-tip ef-panel" data-tip></div>
    `;
    this.branchWrap = this.el.querySelector('[data-branches]');
    this.tipEl = this.el.querySelector('[data-tip]');
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'ef-tree-svg');

    this.branchEls = [];
    for (const branch of BRANCHES) {
      const col = document.createElement('div');
      col.className = 'ef-branch';
      col.style.setProperty('--branch-color', branch.color);
      col.style.setProperty('--branch-glow', branch.glow);
      col.style.setProperty('--branch-line', branch.glow);
      col.innerHTML = `
        <div class="ef-branch-head">
          <div class="b-name">${branch.icon ? branch.icon + ' ' : ''}${branch.name.toUpperCase()}</div>
          <div class="b-sub">${branch.subtitle.toUpperCase()}</div>
        </div>
        <div class="ef-nodes" data-nodes></div>
      `;
      const nodeWrap = col.querySelector('[data-nodes]');
      const rows = new Map();
      for (const node of branch.nodes) {
        const row = document.createElement('div');
        row.className = 'ef-node-row';
        const el = document.createElement('div');
        el.className = 'ef-node';
        el.dataset.id = node.id;
        el.innerHTML = `
          <span class="n-tier">${node.tier}</span>
          <span class="n-icon">${node.icon}</span>
          <span class="n-rank">${'<i></i>'.repeat(node.maxRank)}</span>
        `;
        el.addEventListener('click', () => this._click(node.id));
        el.addEventListener('mouseenter', () => this._showTip(node));
        el.addEventListener('mousemove', (e) => this._moveTip(e));
        el.addEventListener('mouseleave', () => this._hideTip());
        row.appendChild(el);
        nodeWrap.appendChild(row);
        rows.set(node.id, el);
      }
      nodeWrap.appendChild(this.svg);
      this.branchWrap.appendChild(col);
      this.branchEls.push({ col, rows, branch });
    }
    this.el.addEventListener('mouseleave', () => this._hideTip());
  }

  /** Position the SVG connectors for one branch. Call after layout. */
  _drawBranchConnectors({ rows, branch }) {
    const nodeWrap = rows.values().next().value?.parentElement?.parentElement;
    if (!nodeWrap) return;
    // Remove previous paths belonging to this branch.
    for (const p of [...this.svg.querySelectorAll(`path[data-branch="${branch.id}"]`)]) p.remove();

    const wrapRect = nodeWrap.getBoundingClientRect();
    const svgRect = this.svg.getBoundingClientRect();
    const ox = wrapRect.left - svgRect.left;
    const oy = wrapRect.top - svgRect.top;

    for (const node of branch.nodes) {
      if (!node.req?.length) continue;
      const childEl = rows.get(node.id);
      for (const reqId of node.req) {
        const parentEl = rows.get(reqId);
        if (!childEl || !parentEl) continue;
        const a = parentEl.getBoundingClientRect();
        const b = childEl.getBoundingClientRect();
        const x1 = a.left + a.width / 2 - svgRect.left;
        const y1 = a.top + a.height / 2 - svgRect.top;
        const x2 = b.left + b.width / 2 - svgRect.left;
        const y2 = b.top + b.height / 2 - svgRect.top;
        // Gentle S-curve; small sideways drift when tiers align horizontally.
        const mx = (x1 + x2) / 2 + (y2 - y1 < 12 ? 26 : 0);
        const d = `M ${x1 - ox} ${y1 - oy} C ${mx - ox} ${y1 + (y2 - y1) * 0.45 - oy}, ${mx - ox} ${y2 - (y2 - y1) * 0.45 - oy}, ${x2 - ox} ${y2 - oy}`;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.dataset.branch = branch.id;
        path.dataset.req = reqId;
        path.dataset.child = node.id;
        path.setAttribute('d', d);
        this.svg.appendChild(path);
      }
    }
  }

  /** Full re-render from game.skills.ranks + player.skillPoints. */
  refresh() {
    const skills = this.game.skills;
    const points = this.game.player.skillPoints;
    const el = this.el;
    el.querySelector('[data-points]').textContent = String(points);

    for (const { rows, branch } of this.branchEls) {
      for (const node of branch.nodes) {
        const dom = rows.get(node.id);
        const rank = skills.ranks[node.id] ?? 0;
        const check = skills.canRank(node.id);
        dom.classList.toggle('ranked', rank > 0);
        dom.classList.toggle('maxed', rank >= node.maxRank);
        dom.classList.toggle('rankable', check.ok);
        const locked = !check.ok && rank === 0 && check.reason !== 'No skill points';
        dom.classList.toggle('locked', locked);
        dom.classList.toggle('unaffordable', !check.ok && rank === 0 && check.reason === 'No skill points');
        const pips = dom.querySelectorAll('.n-rank i');
        pips.forEach((p, i) => p.classList.toggle('on', i < rank));
      }
      this._drawBranchConnectors({ rows, branch });
    }

    // Connector states: earned = child ranked and prereq ranked.
    for (const p of this.svg.querySelectorAll('path')) {
      const childRank = skills.ranks[p.dataset.child] ?? 0;
      const reqRank = skills.ranks[p.dataset.req] ?? 0;
      const earned = childRank > 0 && reqRank > 0;
      p.style.stroke = earned ? (BRANCHES.find((b) => b.id === p.dataset.branch)?.color ?? '#d9b26a') : 'rgba(150, 138, 118, 0.28)';
      p.style.opacity = earned ? '0.85' : '0.5';
      p.style.filter = earned ? 'drop-shadow(0 0 3px rgba(255, 180, 90, 0.4))' : 'none';
    }

    if (this.tipEl.classList.contains('show') && this._tipNodeId) {
      const node = NODE_BY_ID[this._tipNodeId];
      if (node) this._fillTip(node);
    }
  }

  _click(id) {
    const skills = this.game.skills;
    const check = skills.canRank(id);
    if (!check.ok) {
      const node = NODE_BY_ID[id];
      this.game.notify?.(node ? `${node.name}: ${check.reason}` : check.reason, 'hp');
      this.game.audio?.play?.('ui_click', { volume: 0.5, rate: 0.7 });
      return;
    }
    const res = skills.rankNode(id);
    if (res.ok) {
      this.game.audio?.play?.('level_up', { volume: 0.3, rate: 1.6 });
      this.game._computeStats?.();
      this.refresh();
    }
  }

  _showTip(node) {
    this._tipNodeId = node.id;
    this._fillTip(node);
    this.tipEl.classList.add('show');
  }

  _fillTip(node) {
    const skills = this.game.skills;
    const rank = skills.ranks[node.id] ?? 0;
    const branch = BRANCHES.find((b) => b.id === node.branch);
    const branchColor = branch ? branch.color : 'var(--ef-gold-bright)';
    const check = skills.canRank(node.id);
    const tip = this.tipEl;
    tip.style.setProperty('--tip-color', branchColor);

    let req = '';
    if (node.req?.length && rank === 0) {
      const missing = node.req.filter((r) => (skills.ranks[r] ?? 0) < 1);
      if (missing.length) {
        req = `<div class="t-req">Requires ${missing.map((m) => NODE_BY_ID[m].name).join(', ')}</div>`;
      }
    }
    const missingReq = node.req?.filter((r) => (skills.ranks[r] ?? 0) < 1) ?? [];
    let hint;
    if (rank >= node.maxRank) {
      hint = '<div class="t-hint ok">Fully ranked.</div>';
    } else if (missingReq.length) {
      hint = '<div class="t-hint">Prerequisite not yet ranked.</div>';
    } else if (check.ok) {
      hint = `<div class="t-hint ok">Click to learn rank ${rank + 1} (1 skill point).</div>`;
    } else if (rank > 0) {
      hint = '<div class="t-hint">No skill points remaining.</div>';
    } else {
      hint = `<div class="t-hint">${check.reason}</div>`;
    }

    const nextDesc = node.desc(rank + 1);
    const curDesc = rank > 0 ? node.desc(rank) : null;
    tip.innerHTML = `
      <div class="t-name"><span class="t-icon">${node.icon}</span>${node.name}<span class="t-kind">${KIND_LABEL[node.type] ?? node.type.toUpperCase()}</span></div>
      <div class="t-rank">Rank ${rank} / ${node.maxRank}</div>
      ${curDesc ? `<div class="t-desc">Current: ${curDesc}</div>` : ''}
      ${rank < node.maxRank ? `<div class="t-desc">${rank > 0 ? 'Next rank: ' : ''}${nextDesc}</div>` : ''}
      ${req}
      ${hint}
    `;
    tip.style.borderColor = rank > 0 ? branchColor : '';
  }

  _moveTip(e) {
    const pad = 18;
    const w = this.tipEl.offsetWidth || 280;
    const h = this.tipEl.offsetHeight || 160;
    let x = e.clientX + pad;
    let y = e.clientY - h - 12;
    if (x + w > window.innerWidth - 8) x = e.clientX - w - pad;
    if (y < 8) y = e.clientY + pad;
    this.tipEl.style.left = `${x}px`;
    this.tipEl.style.top = `${y}px`;
  }

  _hideTip() {
    this._tipNodeId = null;
    this.tipEl.classList.remove('show');
  }

  /** Open: mount shown, connectors measured, state refreshed. */
  open() {
    this.el.classList.remove('hidden');
    this.el.style.display = '';
    this._hideTip();
    this.refresh();
    requestAnimationFrame(() => {
      for (const b of this.branchEls) this._drawBranchConnectors(b);
      this.refresh();
    });
  }

  close() {
    this._hideTip();
    this.el.style.display = 'none';
  }
}
