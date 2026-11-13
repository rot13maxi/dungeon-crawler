// EMBERFALL — procedural audio engine. Pure WebAudio synthesis: oscillators,
// noise buffers, filters and envelopes. No external assets, no decoding.
// Voice budget is capped; the noise buffer and reverb impulse are shared.

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Per-sound reverb send level (0 = dry, 1 = drenched).
const WET = {
  fireball_explode: 0.5,
  meteor_impact: 0.55,
  meteor_warn: 0.35,
  singularity: 0.62,
  boss_roar: 0.5,
  portal: 0.62,
  death: 0.55,
  level_up: 0.42,
  room_clear: 0.4,
  void_cast: 0.4,
  blizzard: 0.3,
  frost_burst: 0.3,
  lightning: 0.3,
  flame_wave: 0.28,
  enemy_death: 0.28,
  player_hurt: 0.25,
  heal: 0.3,
  shield: 0.3,
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.master = null;
    this.sfxBus = null;
    this.ambBus = null;
    this.reverb = null;
    this._noiseBuf = null;
    this._voices = 0;
    this._amb = null;
    this._volume = 0.7;
    this.depth = 1;
  }

  // ---------------------------------------------------------------- setup

  /** Must be called from a user gesture. Safe to call repeatedly. */
  init() {
    if (this.ready) {
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = this._volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 26;
    comp.ratio.value = 5;
    comp.attack.value = 0.004;
    comp.release.value = 0.24;
    master.connect(comp);
    comp.connect(ctx.destination);
    this.master = master;

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = 1;
    this.sfxBus.connect(master);

    this.ambBus = ctx.createGain();
    this.ambBus.gain.value = 0;
    this.ambBus.connect(master);

    const conv = ctx.createConvolver();
    conv.buffer = this._makeImpulse(ctx, 1.9, 2.4);
    const wet = ctx.createGain();
    wet.gain.value = 0.42;
    conv.connect(wet);
    wet.connect(master);
    this.reverb = conv;

    this._noiseBuf = this._makeNoise(ctx, 2);
    this.ready = true;
  }

  _makeNoise(ctx, seconds) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  _makeImpulse(ctx, seconds, decay) {
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  // ------------------------------------------------------------- primitives

  /** Pitched oscillator with percussive envelope. Returns stop time offset. */
  _tone(out, { type = 'sine', f0 = 440, f1 = 0, at = 0, dur = 0.2, g = 0.2, a = 0.004, bend = 'exp' }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(20, f0), t);
    if (f1 > 0) {
      const fe = Math.max(20, f1);
      if (bend === 'exp') o.frequency.exponentialRampToValueAtTime(fe, t + dur);
      else o.frequency.linearRampToValueAtTime(fe, t + dur);
    }
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(0.0001, t);
    gn.gain.linearRampToValueAtTime(Math.max(0.0001, g), t + a);
    gn.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(a + 0.03, dur));
    o.connect(gn);
    gn.connect(out);
    o.start(t);
    o.stop(t + dur + 0.1);
    return o;
  }

  /** Filtered noise burst with sweepable filter and percussive envelope. */
  _noise(out, { at = 0, dur = 0.2, type = 'bandpass', f0 = 800, f1 = 0, q = 1, g = 0.3, a = 0.006 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    src.loop = true;
    src.playbackRate.value = 0.8 + Math.random() * 0.45;
    const flt = ctx.createBiquadFilter();
    flt.type = type;
    flt.Q.value = q;
    flt.frequency.setValueAtTime(Math.max(30, f0), t);
    if (f1 > 0) flt.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(0.0001, t);
    gn.gain.linearRampToValueAtTime(Math.max(0.0001, g), t + a);
    gn.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(a + 0.03, dur));
    src.connect(flt);
    flt.connect(gn);
    gn.connect(out);
    src.start(t, Math.random() * 1.2);
    src.stop(t + dur + 0.1);
  }

  // ------------------------------------------------------------------ play

  /**
   * Play a named synth sound.
   * @param {string} name   one of the contract sound names (unknown = silent)
   * @param {{volume?:number, rate?:number, pan?:number}} opts
   */
  play(name, opts = {}) {
    if (!this.ready) return;
    const ctx = this.ctx;
    if (ctx.state === 'suspended') ctx.resume();
    const fn = this['_s_' + name];
    if (!fn || this._voices > 26) return;
    // Cap identical sounds per short window: 20 enemies dying in the same frame
    // previously stacked 20 synth voices and stalled weaker machines ~90ms.
    if (!this._lastPlay) this._lastPlay = new Map();
    const now = ctx.currentTime;
    const lastAt = this._lastPlay.get(name) ?? -1;
    const minGap = name === 'enemy_death' ? 0.055 : 0.012;
    if (now - lastAt < minGap) return;
    this._lastPlay.set(name, now);
    const volume = clamp(opts.volume ?? 1, 0, 4);
    const rate = clamp(opts.rate ?? 1, 0.25, 4) * (0.96 + Math.random() * 0.08);
    const pan = clamp(opts.pan ?? 0, -1, 1);

    const bus = ctx.createGain();
    bus.gain.value = volume;
    let tail = bus;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      bus.connect(p);
      tail = p;
    }
    tail.connect(this.sfxBus);
    const wet = ctx.createGain();
    wet.gain.value = WET[name] ?? 0.22;
    bus.connect(wet);
    wet.connect(this.reverb);

    const dur = fn.call(this, bus, rate) || 0.3;
    this._voices++;
    setTimeout(() => { this._voices--; }, dur * 1000 + 80);
  }

  // ---------------------------------------------------------------- sounds
  // Every recipe builds nodes into `out`; `r` is the rate multiplier.

  _s_ui_click(out, r) {
    this._tone(out, { type: 'triangle', f0: 560 * r, f1: 380 * r, dur: 0.07, g: 0.2 });
    this._noise(out, { type: 'highpass', f0: 3200, dur: 0.03, g: 0.05 });
    return 0.09;
  }

  _s_ui_hover(out, r) {
    this._tone(out, { type: 'sine', f0: 760 * r, f1: 720 * r, dur: 0.045, g: 0.06 });
    return 0.06;
  }

  _s_swing(out, r) {
    this._noise(out, { f0: 1500 * r, f1: 320 * r, q: 2.2, dur: 0.16, g: 0.38 });
    this._tone(out, { type: 'sine', f0: 300 * r, f1: 170 * r, dur: 0.12, g: 0.06 });
    return 0.18;
  }

  _s_hit(out, r) {
    this._tone(out, { type: 'sine', f0: 195 * r, f1: 62 * r, dur: 0.1, g: 0.5 });
    this._noise(out, { type: 'lowpass', f0: 750 * r, dur: 0.07, g: 0.32 });
    return 0.13;
  }

  _s_crit(out, r) {
    this._tone(out, { type: 'sine', f0: 220 * r, f1: 60 * r, dur: 0.12, g: 0.6 });
    this._tone(out, { type: 'square', f0: 1500 * r, f1: 1040 * r, dur: 0.11, g: 0.13 });
    this._noise(out, { type: 'highpass', f0: 3600, dur: 0.1, g: 0.2 });
    this._noise(out, { type: 'lowpass', f0: 900 * r, dur: 0.09, g: 0.35 });
    return 0.16;
  }

  _s_player_hurt(out, r) {
    this._tone(out, { type: 'sawtooth', f0: 155 * r, f1: 56 * r, dur: 0.26, g: 0.34 });
    this._tone(out, { type: 'sine', f0: 96 * r, f1: 48 * r, dur: 0.2, g: 0.3 });
    this._noise(out, { type: 'lowpass', f0: 380 * r, dur: 0.16, g: 0.28 });
    return 0.3;
  }

  _s_enemy_death(out, r) {
    this._noise(out, { f0: 430 * r, f1: 170 * r, q: 1.4, dur: 0.22, g: 0.36 });
    this._tone(out, { type: 'sawtooth', f0: 210 * r, f1: 48 * r, dur: 0.3, g: 0.24 });
    this._noise(out, { type: 'highpass', f0: 2400, at: 0.02, dur: 0.04, g: 0.16 });
    this._noise(out, { type: 'highpass', f0: 2900, at: 0.06, dur: 0.04, g: 0.13 });
    return 0.36;
  }

  _s_fireball_cast(out, r) {
    this._noise(out, { f0: 260 * r, f1: 1300 * r, q: 1.2, dur: 0.28, g: 0.32 });
    this._tone(out, { type: 'sine', f0: 170 * r, f1: 330 * r, dur: 0.22, g: 0.11, bend: 'lin' });
    return 0.3;
  }

  _s_fireball_explode(out, r) {
    this._tone(out, { type: 'sine', f0: 115 * r, f1: 34 * r, dur: 0.46, g: 0.5 });
    this._noise(out, { type: 'lowpass', f0: 1700 * r, f1: 110, dur: 0.42, g: 0.55 });
    this._noise(out, { type: 'bandpass', f0: 2400 * r, dur: 0.11, g: 0.18, q: 0.8 });
    return 0.5;
  }

  _s_flame_wave(out, r) {
    this._noise(out, { f0: 420 * r, f1: 900 * r, q: 0.8, dur: 0.5, g: 0.42, a: 0.03 });
    this._noise(out, { f0: 1100 * r, f1: 300 * r, q: 0.9, at: 0.08, dur: 0.42, g: 0.28 });
    this._noise(out, { type: 'highpass', f0: 2500, at: 0.1, dur: 0.05, g: 0.12 });
    this._noise(out, { type: 'highpass', f0: 2800, at: 0.2, dur: 0.05, g: 0.1 });
    this._noise(out, { type: 'highpass', f0: 2400, at: 0.32, dur: 0.05, g: 0.09 });
    return 0.58;
  }

  _s_frost_cast(out, r) {
    this._tone(out, { type: 'sine', f0: 1180 * r, dur: 0.1, g: 0.11 });
    this._tone(out, { type: 'sine', f0: 1570 * r, at: 0.06, dur: 0.12, g: 0.09 });
    this._noise(out, { type: 'highpass', f0: 5200, dur: 0.18, g: 0.09 });
    return 0.24;
  }

  _s_frost_burst(out, r) {
    const fs = [880, 1140, 1430, 1780];
    for (let i = 0; i < fs.length; i++) {
      this._tone(out, { type: 'sine', f0: fs[i] * r, dur: 0.3, g: 0.13, a: 0.003 });
    }
    this._noise(out, { type: 'highpass', f0: 3000, dur: 0.24, g: 0.24 });
    this._tone(out, { type: 'sine', f0: 320 * r, f1: 150 * r, dur: 0.26, g: 0.18 });
    return 0.34;
  }

  _s_ice_shards(out, r) {
    for (let i = 0; i < 5; i++) {
      this._tone(out, { type: 'triangle', f0: (1650 + Math.random() * 1400) * r, at: i * 0.03, dur: 0.08, g: 0.11, a: 0.002 });
    }
    this._noise(out, { type: 'highpass', f0: 6000, dur: 0.14, g: 0.07 });
    return 0.24;
  }

  _s_meteor_warn(out, r) {
    this._tone(out, { type: 'sine', f0: 620 * r, f1: 1500 * r, dur: 0.95, g: 0.09, bend: 'lin' });
    this._noise(out, { type: 'lowpass', f0: 140, dur: 0.95, g: 0.26, a: 0.45 });
    return 1.0;
  }

  _s_meteor_impact(out, r) {
    this._tone(out, { type: 'sine', f0: 95 * r, f1: 26 * r, dur: 0.8, g: 0.55 });
    this._tone(out, { type: 'sine', f0: 115 * r, f1: 34 * r, dur: 0.46, g: 0.5 });
    this._noise(out, { type: 'lowpass', f0: 2200 * r, f1: 90, dur: 0.7, g: 0.4 });
    this._tone(out, { type: 'sawtooth', f0: 70 * r, f1: 24 * r, dur: 0.6, g: 0.3 });
    this._noise(out, { type: 'bandpass', f0: 900 * r, dur: 0.2, g: 0.22, q: 0.7 });
    return 0.85;
  }

  _s_blizzard(out, r) {
    this._noise(out, { f0: 750 * r, q: 0.6, dur: 1.1, g: 0.3, a: 0.2 });
    this._noise(out, { f0: 1400 * r, f1: 580 * r, q: 0.8, dur: 1.1, g: 0.16, a: 0.25 });
    this._tone(out, { type: 'sine', f0: 220 * r, f1: 175 * r, dur: 1.0, g: 0.05, a: 0.2 });
    return 1.15;
  }

  _s_lightning(out, r) {
    this._noise(out, { type: 'highpass', f0: 2600, dur: 0.09, g: 0.48, a: 0.001 });
    this._tone(out, { type: 'sawtooth', f0: 2800 * r, f1: 170 * r, dur: 0.13, g: 0.26 });
    this._noise(out, { type: 'lowpass', f0: 520, at: 0.05, dur: 0.3, g: 0.28 });
    return 0.36;
  }

  _s_dash(out, r) {
    this._noise(out, { f0: 480 * r, f1: 2300 * r, q: 1.6, dur: 0.15, g: 0.26 });
    this._tone(out, { type: 'sine', f0: 240 * r, f1: 420 * r, dur: 0.1, g: 0.06, bend: 'lin' });
    return 0.17;
  }

  _s_void_cast(out, r) {
    this._tone(out, { type: 'sine', f0: 175 * r, f1: 62 * r, dur: 0.38, g: 0.3 });
    this._tone(out, { type: 'sine', f0: 181 * r, f1: 66 * r, dur: 0.38, g: 0.18 });
    this._noise(out, { type: 'lowpass', f0: 380 * r, dur: 0.3, g: 0.16 });
    return 0.42;
  }

  _s_singularity(out, r) {
    this._tone(out, { type: 'sine', f0: 54 * r, dur: 1.05, g: 0.46, a: 0.24 });
    this._tone(out, { type: 'sine', f0: 57.5 * r, dur: 1.05, g: 0.32, a: 0.24 });
    this._noise(out, { f0: 320 * r, f1: 85, q: 1.1, dur: 1.0, g: 0.22, a: 0.3 });
    this._tone(out, { type: 'sine', f0: 1040 * r, f1: 210 * r, dur: 0.5, g: 0.07 });
    return 1.2;
  }

  _s_heal(out, r) {
    this._tone(out, { type: 'triangle', f0: 660 * r, dur: 0.3, g: 0.15 });
    this._tone(out, { type: 'triangle', f0: 990 * r, at: 0.12, dur: 0.34, g: 0.12 });
    this._noise(out, { type: 'highpass', f0: 4200, dur: 0.2, g: 0.04 });
    return 0.48;
  }

  _s_loot(out, r) {
    this._tone(out, { type: 'triangle', f0: 1320 * r, dur: 0.08, g: 0.18 });
    this._tone(out, { type: 'triangle', f0: 1780 * r, at: 0.07, dur: 0.12, g: 0.15 });
    return 0.22;
  }

  _s_level_up(out, r) {
    const fs = [523, 659, 784, 1046];
    for (let i = 0; i < fs.length; i++) {
      this._tone(out, { type: 'triangle', f0: fs[i] * r, at: i * 0.09, dur: 0.36, g: 0.16 });
    }
    this._tone(out, { type: 'sine', f0: 260 * r, f1: 130 * r, dur: 0.5, g: 0.12 });
    return 0.78;
  }

  _s_shield(out, r) {
    this._tone(out, { type: 'sine', f0: 880 * r, f1: 990 * r, dur: 0.3, g: 0.13, bend: 'lin' });
    this._tone(out, { type: 'sine', f0: 2640 * r, dur: 0.18, g: 0.06 });
    this._noise(out, { type: 'bandpass', f0: 5200, dur: 0.1, g: 0.05, q: 2 });
    return 0.34;
  }

  _s_boss_roar(out, r) {
    for (const d of [1, 1.012, 0.988]) {
      this._tone(out, { type: 'sawtooth', f0: 112 * r * d, f1: 44 * r, dur: 0.95, g: 0.16, a: 0.04 });
    }
    this._noise(out, { f0: 240 * r, q: 1, dur: 0.9, g: 0.2, a: 0.1 });
    this._noise(out, { type: 'lowpass', f0: 120, dur: 1.05, g: 0.18 });
    return 1.1;
  }

  _s_room_clear(out, r) {
    const fs = [392, 494, 587];
    for (let i = 0; i < fs.length; i++) {
      this._tone(out, { type: 'triangle', f0: fs[i] * r, at: i * 0.045, dur: 0.7, g: 0.12 });
    }
    this._tone(out, { type: 'sine', f0: 140 * r, f1: 64 * r, dur: 0.5, g: 0.2 });
    return 0.82;
  }

  _s_portal(out, r) {
    this._tone(out, { type: 'sine', f0: 440 * r, f1: 660 * r, dur: 1.4, g: 0.11, a: 0.3, bend: 'lin' });
    this._tone(out, { type: 'sine', f0: 446 * r, f1: 668 * r, dur: 1.4, g: 0.09, a: 0.3, bend: 'lin' });
    this._tone(out, { type: 'sine', f0: 880 * r, f1: 1320 * r, dur: 1.2, g: 0.05, a: 0.4, bend: 'lin' });
    this._noise(out, { type: 'highpass', f0: 6000, dur: 1.2, g: 0.05, a: 0.4 });
    return 1.5;
  }

  _s_death(out, r) {
    this._tone(out, { type: 'sine', f0: 165 * r, f1: 38 * r, dur: 1.3, g: 0.6 });
    this._tone(out, { type: 'sawtooth', f0: 110 * r, f1: 28 * r, dur: 1.5, g: 0.26 });
    this._tone(out, { type: 'sine', f0: 233 * r, at: 0.1, dur: 0.9, g: 0.18 });
    this._tone(out, { type: 'sine', f0: 185 * r, at: 0.55, dur: 1.0, g: 0.18 });
    this._tone(out, { type: 'sine', f0: 147 * r, at: 1.05, dur: 1.1, g: 0.2 });
    return 2.3;
  }

  // -------------------------------------------------------------- ambience

  /** Layered dark ambient drone + wind + occasional distant events. */
  startAmbience() {
    if (!this.ready) return;
    const ctx = this.ctx;
    if (ctx.state === 'suspended') ctx.resume();
    if (this._amb) return;

    const bus = this.ambBus;
    bus.gain.cancelScheduledValues(ctx.currentTime);
    bus.gain.setTargetAtTime(0.85, ctx.currentTime, 1.4);

    const amb = { osc: [], gains: [], srcs: [], timers: [], drones: [], windFilter: null, windGain: null };
    this._amb = amb;

    const droneBus = ctx.createGain();
    droneBus.gain.value = 1;
    droneBus.connect(bus);

    // Sub / root / fifth / octave drone stack through a soft lowpass.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 260;
    lp.Q.value = 0.4;
    lp.connect(droneBus);

    const mkDrone = (freq, gain, type = 'sine') => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = gain;
      // Slow breathing LFO on the drone level.
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.04 + Math.random() * 0.05;
      const lg = ctx.createGain();
      lg.gain.value = gain * 0.45;
      lfo.connect(lg);
      lg.connect(g.gain);
      o.connect(g);
      g.connect(lp);
      o.start();
      lfo.start();
      amb.osc.push(o, lfo);
      amb.gains.push(g, lg);
      amb.drones.push({ o, base: freq });
      return o;
    };
    mkDrone(36.7, 0.12);          // sub ember drone
    mkDrone(36.7 * 2, 0.07);       // root
    mkDrone(36.7 * 3, 0.04, 'triangle'); // twelfth, slightly gritty
    mkDrone(36.7 * 4.5, 0.02);   // cold overtone

    // Wind: looped noise through a wandering bandpass.
    const wind = ctx.createBufferSource();
    wind.buffer = this._noiseBuf;
    wind.loop = true;
    const wf = ctx.createBiquadFilter();
    wf.type = 'bandpass';
    wf.frequency.value = 520;
    wf.Q.value = 0.55;
    const wg = ctx.createGain();
    wg.gain.value = 0.032;
    const wlfo = ctx.createOscillator();
    wlfo.type = 'sine';
    wlfo.frequency.value = 0.07;
    const wlg = ctx.createGain();
    wlg.gain.value = 0.03;
    wlfo.connect(wlg);
    wlg.connect(wg.gain);
    const wflfo = ctx.createOscillator();
    wflfo.type = 'sine';
    wflfo.frequency.value = 0.11;
    const wflg = ctx.createGain();
    wflg.gain.value = 150;
    wflfo.connect(wflg);
    wflg.connect(wf.frequency);
    wind.connect(wf);
    wf.connect(wg);
    wg.connect(bus);
    wind.start();
    wlfo.start();
    wflfo.start();
    amb.osc.push(wlfo, wflfo);
    amb.srcs.push(wind);
    amb.gains.push(wg, wlg, wflg);
    amb.windFilter = wf;
    amb.windGain = wg;

    this._ambTick();
  }

  /** Schedule the next distant drip / brazier pop / rumble. */
  _ambTick() {
    const amb = this._amb;
    if (!amb) return;
    amb.timers.push(setTimeout(() => {
      if (!this._amb || !this.ready) return;
      const pan = Math.random() * 1.6 - 0.8;
      const roll = Math.random();
      if (roll < 0.45) {
        // Distant drip: short pitched drop.
        this._toneAt(this.ambBus, { f0: 1150 + Math.random() * 500, f1: 620, dur: 0.13, g: 0.045, pan });
      } else if (roll < 0.75) {
        // Brazier settle / ash collapse.
        this._noiseAt(this.ambBus, { type: 'lowpass', f0: 240, dur: 0.22, g: 0.075, pan });
      } else {
        // Deep distant rumble.
        this._toneAt(this.ambBus, { f0: 46, f1: 30, dur: 2.4, g: 0.055, a: 0.8, pan });
      }
      this._ambTick();
    }, 2800 + Math.random() * 5200));
  }

  /** One-off quiet event routed into the ambience bus with a pan. */
  _toneAt(dest, { type = 'sine', f0, f1 = 0, dur = 0.2, g = 0.1, a = 0.005, pan = 0 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(20, f0), t);
    if (f1 > 0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(0.0001, t);
    gn.gain.linearRampToValueAtTime(g, t + a);
    gn.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(a + 0.03, dur));
    let tail = gn;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      gn.connect(p);
      tail = p;
    }
    o.connect(gn);
    tail.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.1);
  }

  _noiseAt(dest, { type = 'lowpass', f0 = 300, dur = 0.2, g = 0.1, a = 0.01, pan = 0 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    src.loop = true;
    src.playbackRate.value = 0.7 + Math.random() * 0.5;
    const flt = ctx.createBiquadFilter();
    flt.type = type;
    flt.frequency.value = f0;
    flt.Q.value = 0.8;
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(0.0001, t);
    gn.gain.linearRampToValueAtTime(g, t + a);
    gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let tail = gn;
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      gn.connect(p);
      tail = p;
    }
    src.connect(flt);
    flt.connect(gn);
    tail.connect(dest);
    src.start(t, Math.random() * 1.2);
    src.stop(t + dur + 0.1);
  }

  /** Retune the drone stack for a new depth: lower, darker, windier. */
  setDepth(depth) {
    this.depth = depth;
    if (!this._amb || !this.ctx) return;
    const t = this.ctx.currentTime;
    const k = Math.max(0.6, Math.pow(0.93, depth - 1));
    for (const d of this._amb.drones) {
      d.o.frequency.setTargetAtTime(Math.max(22, d.base * k), this.ctx.currentTime, 1.5);
    }
    if (this._amb.windFilter) {
      this._amb.windFilter.frequency.setTargetAtTime(Math.max(260, 520 * k), this.ctx.currentTime, 1.5);
    }
    if (this._amb.windGain) {
      this._amb.windGain.gain.setTargetAtTime(Math.min(0.09, 0.045 + (depth - 1) * 0.006), this.ctx.currentTime, 1.5);
    }
  }

  stopAmbience() {
    const amb = this._amb;
    if (!amb || !this.ctx) return;
    this._amb = null;
    for (const t of amb.timers) clearTimeout(t);
    const ctx = this.ctx;
    const t = ctx.currentTime;
    this.ambBus.gain.cancelScheduledValues(t);
    this.ambBus.gain.setTargetAtTime(0.0001, t, 0.35);
    setTimeout(() => {
      for (const o of amb.osc) { try { o.stop(); } catch { /* already stopped */ } }
      for (const s of amb.srcs) { try { s.stop(); } catch { /* already stopped */ } }
      for (const g of amb.gains) { try { g.disconnect(); } catch { /* already disconnected */ } }
    }, 1400);
  }

  setMasterVolume(v) {
    this._volume = clamp(v, 0, 1);
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this._volume, this.ctx.currentTime, 0.05);
    }
  }
}
