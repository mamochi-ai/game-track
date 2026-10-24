// Small synthesized sound set (Web Audio). Starts only after a user gesture (iOS requirement).
(function (root) {
  'use strict';
  const A = {
    ctx: null, master: null, enabled: true, engine: null, noise: null, lastThump: 0, lastCreak: 0,
  };

  A.unlock = function () {
    if (!A.ctx) {
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return;
      A.ctx = new AC();
      A.master = A.ctx.createGain();
      A.master.gain.value = A.enabled ? 0.7 : 0;
      A.master.connect(A.ctx.destination);
      const len = A.ctx.sampleRate * 0.5;
      A.noise = A.ctx.createBuffer(1, len, A.ctx.sampleRate);
      const d = A.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (A.ctx.state === 'suspended') A.ctx.resume();
  };

  A.setEnabled = function (on) {
    A.enabled = on;
    if (A.master) A.master.gain.setTargetAtTime(on ? 0.7 : 0, A.ctx.currentTime, 0.03);
  };

  A.suspend = function () { if (A.ctx && A.ctx.state === 'running') A.ctx.suspend(); };
  A.resume = function () { if (A.ctx && A.ctx.state === 'suspended') A.ctx.resume(); };

  // engine: two detuned oscillators through a low-pass, pitch follows wheel speed
  A.engineOn = function () {
    if (!A.ctx || A.engine) return;
    const c = A.ctx;
    const o1 = c.createOscillator(), o2 = c.createOscillator();
    o1.type = 'sawtooth'; o2.type = 'square';
    const f = c.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 380; f.Q.value = 2;
    const g = c.createGain();
    g.gain.value = 0;
    o1.connect(f); o2.connect(f); f.connect(g); g.connect(A.master);
    o1.start(); o2.start();
    A.engine = { o1, o2, f, g };
  };
  A.engineOff = function () {
    if (!A.engine) return;
    const e = A.engine;
    e.g.gain.setTargetAtTime(0, A.ctx.currentTime, 0.05);
    setTimeout(() => { try { e.o1.stop(); e.o2.stop(); } catch (_) { /* already stopped */ } }, 300);
    A.engine = null;
  };
  A.engineSet = function (speed01, throttle) {
    if (!A.engine) return;
    const t = A.ctx.currentTime;
    const base = 38 + speed01 * 70 + throttle * 18;
    A.engine.o1.frequency.setTargetAtTime(base, t, 0.08);
    A.engine.o2.frequency.setTargetAtTime(base * 1.505, t, 0.08);
    A.engine.f.frequency.setTargetAtTime(260 + throttle * 500 + speed01 * 300, t, 0.08);
    A.engine.g.gain.setTargetAtTime(0.05 + throttle * 0.07 + speed01 * 0.03, t, 0.1);
  };

  function burst(freq, q, dur, vol, type) {
    if (!A.ctx || !A.enabled) return;
    const c = A.ctx, t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = A.noise;
    const f = c.createBiquadFilter();
    f.type = type || 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(f); f.connect(g); g.connect(A.master);
    src.start(t, Math.random() * 0.3);
    src.stop(t + dur + 0.02);
  }

  function tone(f0, f1, dur, vol, type, delay) {
    if (!A.ctx || !A.enabled) return;
    const c = A.ctx, t = c.currentTime + (delay || 0);
    const o = c.createOscillator();
    o.type = type || 'triangle';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g); g.connect(A.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // impact: impulse in N*s, heavier items sound lower
  A.thump = function (impulse, mass) {
    if (!A.ctx) return;
    const now = performance.now();
    if (now - A.lastThump < 70) return;
    A.lastThump = now;
    const vol = Math.min(0.5, impulse / 900);
    burst(mass > 40 ? 140 : mass > 15 ? 230 : 420, 1.4, 0.12 + Math.min(0.15, mass / 400), vol);
  };
  A.creak = function (amount) {
    if (!A.ctx) return;
    const now = performance.now();
    if (now - A.lastCreak < 400) return;
    A.lastCreak = now;
    tone(520 + amount * 200, 760 + amount * 300, 0.16, 0.05 + amount * 0.05, 'square');
  };
  A.click = function () { tone(900, 700, 0.05, 0.06, 'triangle'); };
  A.place = function () { burst(300, 1.2, 0.1, 0.18); };
  A.fall = function () { tone(520, 160, 0.45, 0.12, 'triangle'); };
  A.belt = function () { tone(300, 1200, 0.12, 0.08, 'sawtooth'); burst(2500, 3, 0.08, 0.06); };
  A.fanfare = function () {
    [523, 659, 784, 1046].forEach((f, i) => tone(f, f, 0.22, 0.12, 'triangle', i * 0.12));
  };
  A.sad = function () { [392, 330, 262].forEach((f, i) => tone(f, f * 0.98, 0.3, 0.1, 'triangle', i * 0.18)); };

  root.GameAudio = A;
})(window);
