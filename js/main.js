// Game flow: title -> loading (cargo + belts) -> driving -> result -> retry.
(function () {
  'use strict';
  const C = window.CONFIG;
  const { Sim, SPECS, HOOKS, BED, groundY } = window.Phys;
  const AU = window.GameAudio;
  const $ = (id) => document.getElementById(id);
  const H = 1 / C.physics.hz;
  const DEG = Math.PI / 180;
  const ROT_STEP = 15 * DEG;
  const LIFT_PX = 26; // the held item floats this far above the finger so it stays visible

  // ---------------------------------------------------------------- sprites
  const SPRITE_NAMES = ['truck', 'magnet_truck', 'wheel', 'tire', 'box', 'fridge', 'sofa', 'cat', 'plank'];
  const spriteURL = (n) => (window.SPRITES && window.SPRITES[n]) || (window.SPRITE_BASE || 'assets/sprites/') + n + '.png';
  const sprites = {};
  const spritesReady = Promise.all(SPRITE_NAMES.map((n) => new Promise((res) => {
    const img = new Image();
    img.onload = () => { sprites[n] = img; res(); };
    img.onerror = () => res();
    img.src = spriteURL(n);
  })));

  // ---------------------------------------------------------------- state
  const G = {
    state: 'title',        // title | loading | driving | result
    sim: null,
    departSnap: null,
    mode: 'cargo',         // cargo | belt (loading only)
    held: null,            // {id, x, y, a, valid, finger}
    drag: null,            // pointer id moving the held item
    history: [],
    beltHook: null,
    beltItem: null,        // {id, local}
    pointer: null,
    paused: false,
    input: { throttle: false, brake: false },
    drive: null,           // per-run counters
    rotateDismissed: false,
    soundOn: true,
  };

  const cv = $('cv');
  const R = new window.Renderer(cv, sprites);
  R.debug = /debug/.test(location.search + location.hash);

  try { G.soundOn = localStorage.getItem('ichibin-sound') !== 'off'; } catch (_) { /* storage blocked */ }
  AU.enabled = G.soundOn;
  document.body.classList.toggle('muted', !G.soundOn);

  // ---------------------------------------------------------------- helpers
  let toastTimer = 0;
  function toast(msg, warn, ms) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.toggle('warn', !!warn);
    el.hidden = false;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), ms || 1900);
  }
  const yen = (v) => '¥' + v.toLocaleString('ja-JP');
  const show = (id, on) => ($(id).hidden = !on);

  function halfExtentY(spec, a) {
    const c = Math.cos(a), s = Math.sin(a);
    let m = 0;
    for (const p of spec.parts) {
      if (p.circle) m = Math.max(m, Math.abs(p.c.x * s + p.c.y * c) + p.r);
      else for (const v of p.verts) m = Math.max(m, Math.abs(v.x * s + v.y * c));
    }
    return m;
  }

  function topOfCargo(filter) {
    let top = -Infinity;
    for (const it of G.sim.items) {
      if (!it.body || (filter && !filter(it))) continue;
      for (let f = it.body.getFixtureList(); f; f = f.getNext()) top = Math.max(top, f.getAABB(0).upperBound.y);
    }
    return top;
  }

  function bedWorld(u) { return G.sim.chassis.getWorldPoint({ x: BED.rear + u, y: BED.floorY }); }

  // ---------------------------------------------------------------- sim lifecycle
  function newLoadingSim(snapshot) {
    const sim = new Sim(snapshot || null);
    sim.phase = 'loading';
    sim.onImpact = onImpact;
    G.sim = sim;
    G.held = null;
    G.drag = null;
    G.beltHook = null;
    G.beltItem = null;
    G.history = sim.loadedItems().map((it) => it.id);
  }

  function onImpact(j, item) {
    if (G.state === 'driving' || G.state === 'loading') AU.thump(j, item.spec.mass);
  }

  // ---------------------------------------------------------------- tray (cargo list)
  const TYPES = Object.keys(C.cargoTypes);
  const trayCards = {};
  function buildTray() {
    const tray = $('tray');
    tray.innerHTML = '';
    for (const key of TYPES) {
      const t = C.cargoTypes[key];
      const b = document.createElement('button');
      b.className = 'card-item';
      b.innerHTML = `<span class="thumb"><img alt="" src="${spriteURL(t.sprite)}"></span>` +
        `<span><span class="nm">${t.name}</span><span class="meta">${key === 'box' ? '3サイズ' : t.mass + 'kg'} ・ ${yen(t.value)}</span></span>` +
        '<span class="ct">0</span>';
      b.addEventListener('click', () => takeFromTray(key));
      tray.appendChild(b);
      trayCards[key] = b;
    }
    $('total-count').textContent = SPECS.length;
  }

  function availableIds(key) {
    return G.sim.items.filter((it) => it.spec.typeKey === key && !it.body && !(G.held && G.held.id === it.id)).map((it) => it.id);
  }

  function refreshTray() {
    let unloaded = 0;
    for (const key of TYPES) {
      const n = availableIds(key).length;
      unloaded += n;
      const card = trayCards[key];
      card.querySelector('.ct').textContent = n;
      card.classList.toggle('empty', n === 0);
      card.classList.toggle('sel', !!(G.held && G.sim.item(G.held.id).spec.typeKey === key));
    }
    if (G.held) unloaded += 1;
    $('unloaded-count').textContent = unloaded;
    const quip = $('load-quip');
    if (G.held && !G.held.valid) quip.textContent = 'そこは物理的に無理です。';
    else if (unloaded === 0) quip.textContent = '全部載りました。一便でいけます。';
    else if (unloaded <= 5) quip.textContent = 'あと少しで全部載ります。';
    else if (unloaded < SPECS.length) quip.textContent = 'まだまだ載ります。';
    else quip.textContent = 'まだ載ります。';
    // held controls
    show('held-tools', !!G.held);
    show('cargo-hint', !G.held);
    if (G.held) $('held-name').textContent = `${G.sim.item(G.held.id).spec.name}を持っています`;
    $('btn-place').disabled = !(G.held && G.held.valid);
  }

  function takeFromTray(key) {
    if (G.state !== 'loading') return;
    AU.unlock();
    if (G.mode !== 'cargo') setMode('cargo');
    if (G.held) {
      const same = G.sim.item(G.held.id).spec.typeKey === key;
      G.held = null;
      if (same) { refreshTray(); return; }
    }
    const ids = availableIds(key);
    if (!ids.length) { toast(`${C.cargoTypes[key].name}は全部載せました。`); return; }
    const id = ids[0];
    const spec = G.sim.item(id).spec;
    const p = bedWorld((BED.front - BED.rear) / 2);
    const top = Math.max(p.y, topOfCargo((it) => Math.abs(it.body.getPosition().x - p.x) < 3));
    G.held = { id, x: p.x, y: top + halfExtentY(spec, 0) + 0.35, a: 0, valid: true, finger: null };
    validateHeld();
    AU.click();
    refreshTray();
  }

  function validateHeld() {
    const h = G.held;
    if (!h) return;
    const spec = G.sim.item(h.id).spec;
    const ext = halfExtentY(spec, h.a);
    h.valid = h.y - ext > groundY(h.x) + 0.02 && !G.sim.overlaps(h.id, h.x, h.y, h.a);
  }

  function moveHeldTo(px, py) {
    const h = G.held;
    const spec = G.sim.item(h.id).spec;
    const w = R.toWorld(px, py - LIFT_PX);
    const cx = G.sim.chassis.getPosition().x;
    h.x = Math.max(cx - 5, Math.min(cx + 5, w.x));
    h.y = Math.max(groundY(h.x) + 0.1, w.y + halfExtentY(spec, h.a));
    h.finger = { px, py };
    const wasValid = h.valid;
    validateHeld();
    if (wasValid !== h.valid) refreshTray();
  }

  function dropHeld() {
    const h = G.held;
    if (!h) return;
    if (!h.valid) {
      toast('ほかの荷物やトラックと重なっています。少しずらしてください。', true);
      refreshTray();
      return;
    }
    G.sim.placeItem(h.id, h.x, h.y, h.a);
    G.history = G.history.filter((id) => id !== h.id);
    G.history.push(h.id);
    G.held = null;
    AU.place();
    refreshTray();
  }

  function pickUp(it) {
    const b = it.body;
    const hadBelts = G.sim.belts.some((bt) => bt.id === it.id);
    G.held = { id: it.id, x: b.getPosition().x, y: b.getPosition().y, a: b.getAngle(), valid: true, finger: null };
    G.sim.removeItem(it.id);
    G.history = G.history.filter((id) => id !== it.id);
    if (hadBelts) { toast('持ち上げたのでベルトを外しました。'); refreshBelts(); }
    AU.click();
  }

  function rotateHeld(dir) {
    if (!G.held) return;
    G.held.a += dir * ROT_STEP;
    validateHeld();
    AU.click();
    refreshTray();
  }

  function clearAll() {
    for (const it of G.sim.items) if (it.body) G.sim.removeItem(it.id);
    G.held = null;
    G.history = [];
    G.beltHook = null;
    G.beltItem = null;
  }

  let resetArmed = 0;
  function resetLoad() {
    const btn = $('btn-reset');
    if (!G.sim.loadedItems().length && !G.held) { toast('荷台はもう空です。'); return; }
    if (performance.now() - resetArmed > 2500) {
      resetArmed = performance.now();
      btn.textContent = 'もう一度押すと全部おろす';
      setTimeout(() => (btn.textContent = '積み直し'), 2500);
      return;
    }
    resetArmed = 0;
    btn.textContent = '積み直し';
    clearAll();
    toast('全部おろしました。');
    refreshTray();
    refreshBelts();
  }

  function undo() {
    if (G.held) { G.held = null; refreshTray(); return; }
    while (G.history.length) {
      const id = G.history.pop();
      if (G.sim.item(id).body) {
        G.sim.removeItem(id);
        toast(`${G.sim.item(id).spec.name}をおろしました。`);
        refreshTray();
        refreshBelts();
        return;
      }
    }
    toast('取り消せる荷物がありません。');
  }

  function recommended() {
    clearAll();
    G.history = window.Layout.apply(G.sim, C.recommended);
    toast('おすすめの無茶積みです。ベルト3本つき。');
    AU.place();
    refreshTray();
    refreshBelts();
  }

  // ---------------------------------------------------------------- belts
  const beltNodes = [];
  function refreshBelts() {
    const ul = $('belt-list');
    ul.innerHTML = '';
    beltNodes.length = 0;
    for (let i = 0; i < C.belt.count; i++) {
      const b = G.sim.belts[i];
      const li = document.createElement('li');
      if (b) {
        li.innerHTML = `<i class="sw"></i><span>${HOOKS[b.hook].name}<br>→ ${G.sim.item(b.id).spec.name}</span><button>外す</button>`;
        li.querySelector('button').addEventListener('click', () => {
          const idx = G.sim.belts.indexOf(b);
          if (idx >= 0) G.sim.removeBelt(idx);
          AU.click();
          refreshBelts();
        });
        beltNodes.push({ b, sw: li.querySelector('.sw') });
      } else {
        li.className = 'empty-slot';
        li.textContent = `ベルト${i + 1}: 未使用`;
      }
      ul.appendChild(li);
    }
    $('belt-left').textContent = C.belt.count - G.sim.belts.length;
    const hint = $('belt-hint');
    if (G.beltHook != null && !G.beltItem) hint.textContent = `${HOOKS[G.beltHook].name}を選びました。次に荷物の留めたい場所を押します。`;
    else if (G.beltItem && G.beltHook == null) hint.textContent = `${G.sim.item(G.beltItem.id).spec.name}を選びました。次に光っているフックを押します。`;
    else if (G.sim.belts.length >= C.belt.count) hint.textContent = 'ベルトは3本とも使っています。付け直すときは「外す」を押します。';
    else hint.textContent = '光っているフックを押してから、荷物の留めたい場所を押します。';
  }

  function beltTap(px, py, w) {
    let hook = null, best = 30;
    HOOKS.forEach((_, i) => {
      const p = G.sim.hookWorld(i);
      const d = Math.hypot(R.sx(p.x) - px, R.sy(p.y) - py);
      if (d < best) { best = d; hook = i; }
    });
    if (hook != null) {
      G.beltHook = G.beltHook === hook ? null : hook;
      AU.click();
    } else {
      const it = G.sim.hitTest(w);
      if (it) {
        G.beltItem = { id: it.id, local: it.body.getLocalPoint(w) };
        AU.click();
      } else {
        G.beltHook = null;
        G.beltItem = null;
      }
    }
    if (G.beltHook != null && G.beltItem) {
      if (G.sim.belts.length >= C.belt.count) {
        toast('ベルトは3本までです。どれかを外してください。', true);
      } else {
        const b = G.sim.addBelt(G.beltHook, G.beltItem.id, G.beltItem.local);
        if (b) { AU.belt(); toast(`${G.sim.item(b.id).spec.name}を固定しました。`); }
        else toast('フックから遠すぎるか、同じ場所に掛かっています。', true);
      }
      G.beltHook = null;
      G.beltItem = null;
    }
    refreshBelts();
  }

  function setMode(m) {
    G.mode = m;
    if (m === 'belt' && G.held) G.held = null;
    G.beltHook = null;
    G.beltItem = null;
    $('tab-cargo').classList.toggle('on', m === 'cargo');
    $('tab-belt').classList.toggle('on', m === 'belt');
    $('tab-cargo').setAttribute('aria-selected', m === 'cargo');
    $('tab-belt').setAttribute('aria-selected', m === 'belt');
    $('step-load').classList.toggle('on', m === 'cargo');
    $('step-belt').classList.toggle('on', m === 'belt');
    show('cargo-tools', m === 'cargo');
    show('belt-tools', m === 'belt');
    refreshTray();
    refreshBelts();
  }

  // ---------------------------------------------------------------- canvas pointer (loading)
  function localPt(e) {
    const r = cv.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top };
  }
  cv.addEventListener('pointerdown', (e) => {
    if (G.state !== 'loading' || G.paused) return;
    e.preventDefault();
    AU.unlock();
    const p = localPt(e);
    const w = R.toWorld(p.px, p.py);
    G.pointer = p;
    if (G.mode === 'belt') { beltTap(p.px, p.py, w); return; }
    if (G.drag != null) return; // ignore a second finger
    if (!G.held) {
      const it = G.sim.hitTest(w);
      if (!it) return;
      pickUp(it);
    }
    G.drag = e.pointerId;
    try { cv.setPointerCapture(e.pointerId); } catch (_) { /* not supported */ }
    moveHeldTo(p.px, p.py);
    refreshTray();
  });
  cv.addEventListener('pointermove', (e) => {
    if (G.state !== 'loading') return;
    const p = localPt(e);
    G.pointer = p;
    if (G.drag === e.pointerId && G.held) moveHeldTo(p.px, p.py);
  });
  const endDrag = (drop) => (e) => {
    if (G.drag !== e.pointerId) return;
    G.drag = null;
    if (G.held) {
      G.held.finger = null;
      if (drop) dropHeld();
    }
  };
  cv.addEventListener('pointerup', endDrag(true));
  cv.addEventListener('pointercancel', endDrag(false));
  cv.addEventListener('lostpointercapture', endDrag(false));

  // ---------------------------------------------------------------- pedals
  function bindPedal(el, key) {
    const ids = new Set();
    const set = (v) => { G.input[key] = v; el.classList.toggle('down', v); };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      AU.unlock();
      ids.add(e.pointerId);
      // touch pointers are captured implicitly; release so sliding off the pedal ends the press
      try { el.releasePointerCapture(e.pointerId); } catch (_) { /* not captured */ }
      set(true);
    });
    const off = (e) => { if (ids.delete(e.pointerId) && !ids.size) set(false); };
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => el.addEventListener(t, off));
    window.addEventListener('pointerup', off);
    window.addEventListener('pointercancel', off);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    return () => { ids.clear(); set(false); };
  }
  const releaseBrake = bindPedal($('pedal-brake'), 'brake');
  const releaseAccel = bindPedal($('pedal-accel'), 'throttle');
  function releaseInputs() { releaseBrake(); releaseAccel(); }

  // ---------------------------------------------------------------- screens
  function setState(s) {
    G.state = s;
    show('title', s === 'title');
    show('load-ui', s === 'loading');
    show('drive-ui', s === 'driving' || s === 'result');
    show('result', s === 'result');
    show('pause', false);
    show('stuck', false);
    G.paused = false;
    releaseInputs();
    if (s !== 'driving') AU.engineOff();
    checkOrientation();
  }

  function enterLoading(snapshot) {
    newLoadingSim(snapshot);
    setState('loading');
    setMode('cargo');
    refreshTray();
    refreshBelts();
  }

  function depart() {
    if (G.held) G.held = null;
    G.departSnap = G.sim.snapshot();
    startDrive();
    toast(G.departSnap.cargo.length ? '一便でいけます。' : '空のトラックで出発します。');
  }

  function startDrive() {
    const sim = new Sim(G.departSnap);
    sim.phase = 'driving';
    sim.onImpact = onImpact;
    G.sim = sim;
    G.drive = { t: 0, falls: 0, lastFallToast: -10, goalHold: 0, rollT: 0, stuckT: 0, stuckShown: false, magnetToast: false, onCount: 0, highT: 0 };
    $('load-count').textContent = sim.loadedItems().length;
    setState('driving');
    AU.engineOn();
  }

  function finish() {
    const sim = G.sim;
    const loaded = sim.loadedItems();
    const sup = sim.supportedIds();
    const delivered = loaded.filter((it) => sup.has(it.id) && !it.fallen);
    const lost = loaded.length - delivered.length;
    const unloaded = SPECS.length - loaded.length;
    const value = delivered.reduce((s, it) => s + it.spec.value, 0);
    const loadedValue = loaded.reduce((s, it) => s + it.spec.value, 0);
    const allValue = SPECS.reduce((s, sp) => s + sp.value, 0);
    let title;
    if (!loaded.length) title = '何も積まずに着きました。';
    else if (lost === 0 && unloaded === 0) title = '一便でいけました。';
    else if (lost === 0) title = '載せた分は全部届きました。';
    else if (value >= loadedValue * 0.6) title = 'だいたい届きました。';
    else if (value > 0) title = '一部は、確かに届きました。';
    else title = 'トラックは無事です。';
    $('result-title').textContent = title;
    $('res-value').textContent = yen(value);
    $('res-max').textContent = `積んだ分 ${yen(loadedValue)} / 全部 ${yen(allValue)}`;
    $('res-delivered').textContent = delivered.length;
    $('res-lost').textContent = lost;
    $('res-unloaded').textContent = unloaded;
    $('res-time').textContent = Math.round(G.drive.t) + '秒';
    const ul = $('res-items');
    ul.innerHTML = '';
    for (const it of loaded) {
      const li = document.createElement('li');
      if (!delivered.includes(it)) li.className = 'lost';
      li.innerHTML = `<img alt="${it.spec.name}" src="${spriteURL(it.spec.sprite)}">`;
      ul.appendChild(li);
    }
    setState('result');
    if (lost === 0 && loaded.length) AU.fanfare(); else AU.sad();
  }

  function pause(on) {
    if (G.state !== 'driving') return;
    G.paused = on;
    releaseInputs();
    show('pause', on);
    if (on) AU.suspend(); else AU.resume();
  }

  function goTitle() {
    setState('title');
    newLoadingSim(G.departSnap);
  }

  // ---------------------------------------------------------------- per-step game logic
  function stepLoading(h) {
    const sim = G.sim;
    sim.controls.throttle = false;
    sim.controls.brake = true;
    sim.step(h);
    // anything that slid off onto the road goes back to the list
    for (const it of sim.items) {
      if (it.body && it.fallen) {
        sim.removeItem(it.id);
        G.history = G.history.filter((id) => id !== it.id);
        toast(`${it.spec.name}が落ちたので一覧に戻しました。`);
        refreshTray();
        refreshBelts();
      }
    }
  }

  const FALL_LINES = ['今のは予備です。', '今のも予備です。', 'あれは置いていく予定でした。', '想定内です。'];
  function stepDriving(h) {
    const sim = G.sim;
    const d = G.drive;
    sim.controls.throttle = G.input.throttle;
    sim.controls.brake = G.input.brake;
    sim.step(h);
    d.t += h;
    // falls
    for (const it of sim.items) {
      if (it.body && it.fallen && !it.counted) {
        it.counted = true;
        d.falls += 1;
        if (d.t - d.lastFallToast > 2.5) {
          toast(FALL_LINES[Math.min(d.falls - 1, FALL_LINES.length - 1)]);
          d.lastFallToast = d.t;
        }
        AU.fall();
      }
    }
    const ch = sim.chassis;
    const x = ch.getPosition().x;
    const v = sim.speed();
    // magnet warning
    if (!d.magnetToast && sim.magnet.moving) { d.magnetToast = true; toast('対向車です。磁石です。', true, 2200); }
    // belt creak when a strap is near its limit
    const maxT = sim.belts.reduce((m, b) => Math.max(m, b.tension), 0);
    if (maxT > C.belt.tensionHigh) { d.highT += h; if (d.highT > 0.05) AU.creak(Math.min(1, maxT / C.belt.maxForce)); } else d.highT = 0;
    // delivery
    const c = C.course;
    if (x > c.goalStart && x < c.goalEnd && Math.abs(v) < c.goalSpeed && Math.abs(ch.getAngle()) < 0.8) {
      d.goalHold += h;
      if (d.goalHold > c.goalHold) { finish(); return; }
    } else d.goalHold = 0;
    // rolled over / stuck
    let ang = ch.getAngle() % (2 * Math.PI);
    if (ang > Math.PI) ang -= 2 * Math.PI;
    if (ang < -Math.PI) ang += 2 * Math.PI;
    d.rollT = Math.abs(ang) > 1.15 ? d.rollT + h : 0;
    d.stuckT = G.input.throttle && Math.abs(v) < 0.12 && x < c.goalStart ? d.stuckT + h : 0;
    if (!d.stuckShown && (d.rollT > 1.2 || d.stuckT > 4)) {
      d.stuckShown = true;
      $('stuck-title').textContent = d.rollT > 1.2 ? 'ひっくり返りました。' : '動けなくなりました。';
      G.paused = true;
      releaseInputs();
      show('stuck', true);
    }
  }

  // ---------------------------------------------------------------- camera
  function freeRect() {
    const r = { l: 0, t: 0, r: R.w, b: R.h };
    const cr = cv.getBoundingClientRect();
    const sel = G.state === 'loading' ? ['.topbar', '#tray', '#tools'] : G.state === 'driving' || G.state === 'result' ? ['.hud'] : [];
    for (const s of sel) {
      const el = document.querySelector(s);
      if (!el || el.offsetParent === null) continue;
      const b = el.getBoundingClientRect();
      const x0 = b.left - cr.left, x1 = b.right - cr.left, y0 = b.top - cr.top, y1 = b.bottom - cr.top;
      if (b.width > R.w * 0.6) {
        if (y0 < R.h * 0.3) r.t = Math.max(r.t, y1); else r.b = Math.min(r.b, y0);
      } else if (x0 < R.w * 0.3) r.l = Math.max(r.l, x1);
      else r.r = Math.min(r.r, x0);
    }
    if (G.state === 'title' && R.w > R.h) r.l = R.w * 0.42;
    r.l += 8; r.r -= 8; r.t += 8; r.b -= 8;
    return r;
  }

  function updateCamera(dt) {
    const sim = G.sim;
    const ch = sim.chassis.getPosition();
    const g = groundY(ch.x);
    if (G.state === 'driving' || G.state === 'result') {
      const top = topOfCargo((it) => !it.fallen && Math.abs(it.body.getPosition().x - ch.x) < 6);
      const y1 = Math.max(g + 3.3, top + 0.5);
      const y0 = Math.min(g, groundY(ch.x + 6)) - 0.9;
      const rect = freeRect();
      // keep the road clear of the pedals: the view bottom sits a little above the screen bottom
      rect.b -= Math.min(60, R.h * 0.08);
      // widen the view ahead while the magnet truck approaches so it is seen coming
      let ahead = 6.5;
      const mx = sim.magnet.x - ch.x;
      if (mx > 0 && mx < 26) ahead = Math.min(12, Math.max(ahead, mx + 3));
      R.frame(ch.x - 2.6, ch.x + ahead, y0, y1, rect, 1 - Math.exp(-dt * 2.5));
    } else {
      let top = topOfCargo((it) => Math.abs(it.body.getPosition().x - ch.x) < 6);
      if (G.held) top = Math.max(top, G.held.y + halfExtentY(G.sim.item(G.held.id).spec, G.held.a));
      const y1 = Math.max(g + 4.2, top + 0.6);
      R.frame(ch.x - 2.9, ch.x + 2.7, g - 0.85, y1, freeRect(), 1 - Math.exp(-dt * 5));
    }
  }

  // ---------------------------------------------------------------- HUD
  let hudTick = 0;
  function updateHUD(dt) {
    hudTick += dt;
    if (G.state === 'loading') {
      for (const n of beltNodes) n.sw.style.background = R.beltColor(n.b.tension);
      return;
    }
    if (G.state !== 'driving') return;
    const sim = G.sim;
    const x = sim.chassis.getPosition().x;
    const c = C.course;
    const f = Math.max(0, Math.min(1, (x - C.truck.startX) / (c.goalStart + 14 - C.truck.startX)));
    $('prog-truck').style.left = (f * 100).toFixed(1) + '%';
    if (hudTick > 0.25) {
      hudTick = 0;
      const sup = sim.supportedIds();
      $('on-count').textContent = sim.loadedItems().filter((it) => sup.has(it.id) && !it.fallen).length;
    }
    AU.engineSet(Math.min(1, Math.abs(sim.speed()) / 7.5), sim.throttle);
  }

  function buildProgressMarks() {
    const c = C.course;
    const span = c.goalStart + 14 - C.truck.startX;
    const marks = [
      [c.bumpX, '段差'], [c.stepX, '段差'], [c.hillStart + c.hillUpLen, '坂'], [C.magnet.triggerX + 12, '磁石'], [c.goalStart, 'ゴール'],
    ];
    const track = $('prog-track');
    for (const [x, label] of marks) {
      const i = document.createElement('i');
      i.className = 'mk' + (label === 'ゴール' ? ' goal' : '');
      i.style.left = (((x - C.truck.startX) / span) * 100).toFixed(1) + '%';
      i.textContent = label;
      track.appendChild(i);
    }
  }

  // ---------------------------------------------------------------- orientation & lifecycle
  function checkOrientation() {
    const portrait = window.innerHeight > window.innerWidth;
    const need = portrait && !G.rotateDismissed && (G.state === 'loading' || G.state === 'driving');
    show('rotate', need);
    if (need && G.state === 'driving' && !G.paused) { G.paused = true; releaseInputs(); }
  }
  window.addEventListener('resize', checkOrientation);
  window.addEventListener('orientationchange', checkOrientation);

  document.addEventListener('visibilitychange', () => {
    releaseInputs();
    if (document.hidden) {
      if (G.state === 'driving' && !G.paused) pause(true);
      AU.suspend();
    } else if (!G.paused) AU.resume();
  });
  window.addEventListener('blur', releaseInputs);
  window.addEventListener('pagehide', releaseInputs);

  // block page scroll, pinch zoom, double-tap zoom and the long-press menu
  document.addEventListener('touchmove', (e) => {
    if (!e.target.closest('.tray, .tool-body, .overlay')) e.preventDefault();
  }, { passive: false });
  ['gesturestart', 'gesturechange', 'dblclick', 'contextmenu', 'selectstart'].forEach((t) => document.addEventListener(t, (e) => e.preventDefault()));

  // ---------------------------------------------------------------- buttons
  const on = (id, fn) => $(id).addEventListener('click', (e) => { AU.unlock(); fn(e); });
  on('btn-start', () => { AU.click(); enterLoading(G.departSnap); });
  on('btn-howto', () => { $('howto').hidden = !$('howto').hidden; });
  on('btn-home', goTitle);
  on('tab-cargo', () => setMode('cargo'));
  on('tab-belt', () => setMode('belt'));
  on('rot-l', () => rotateHeld(1));
  on('rot-r', () => rotateHeld(-1));
  on('btn-place', dropHeld);
  on('btn-return', () => { G.held = null; refreshTray(); });
  on('btn-undo', undo);
  on('btn-reset', resetLoad);
  on('btn-reco', recommended);
  on('btn-go', depart);
  on('btn-pause', () => pause(true));
  on('btn-resume', () => pause(false));
  on('btn-retry', startDrive);
  on('btn-pause-retry', startDrive);
  on('btn-pause-reload', () => enterLoading(G.departSnap));
  on('btn-stuck-retry', startDrive);
  on('btn-stuck-reload', () => enterLoading(G.departSnap));
  on('btn-stuck-close', () => { show('stuck', false); G.paused = false; });
  on('btn-res-retry', startDrive);
  on('btn-res-reload', () => enterLoading(G.departSnap));
  on('btn-res-title', goTitle);
  on('btn-rotate-ok', () => { G.rotateDismissed = true; show('rotate', false); if (G.state === 'driving') G.paused = false; });
  document.querySelectorAll('.sound-btn').forEach((b) => b.addEventListener('click', () => {
    AU.unlock();
    G.soundOn = !G.soundOn;
    AU.setEnabled(G.soundOn);
    document.body.classList.toggle('muted', !G.soundOn);
    try { localStorage.setItem('ichibin-sound', G.soundOn ? 'on' : 'off'); } catch (_) { /* storage blocked */ }
    if (G.soundOn) AU.click();
  }));

  // ---------------------------------------------------------------- main loop (fixed step)
  let last = performance.now();
  let acc = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    let dt = (now - last) / 1000;
    last = now;
    if (!(dt > 0)) dt = 0;
    if (dt > C.physics.maxFrameDt) dt = C.physics.maxFrameDt; // tab return: never simulate a huge gap
    R.resize();
    const stepping = !G.paused && G.state !== 'result';
    if (stepping) {
      acc += dt;
      let n = 0;
      while (acc >= H && n < C.physics.maxStepsPerFrame) {
        if (G.state === 'driving') stepDriving(H); else stepLoading(H);
        acc -= H;
        n++;
        if (G.state !== 'driving' && G.state !== 'loading' && G.state !== 'title') break;
      }
      if (n >= C.physics.maxStepsPerFrame) acc = 0;
    } else acc = 0;
    updateCamera(dt);
    R.draw({
      sim: G.sim, t: now / 1000,
      mode: G.state === 'loading' ? G.mode : null,
      held: G.state === 'loading' ? G.held : null,
      highlight: G.beltItem ? G.beltItem.id : null,
      beltHook: G.state === 'loading' && G.mode === 'belt' ? G.beltHook : null,
      pointer: G.state === 'loading' && G.mode === 'belt' ? G.pointer : null,
    });
    updateHUD(dt);
  }

  // ---------------------------------------------------------------- boot
  buildTray();
  buildProgressMarks();
  newLoadingSim(null);
  setState('title');
  spritesReady.then(() => {
    last = performance.now();
    requestAnimationFrame(frame);
  });

  // exposed for automated checks
  window.__game = { G, R, startDrive, enterLoading, recommended, depart, finish, setMode, takeFromTray, dropHeld, moveHeldTo };
})();
