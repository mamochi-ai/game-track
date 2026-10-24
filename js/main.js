// Game flow: title -> stage select -> loading (cargo + belts) -> driving -> result -> retry / next stage.
(function () {
  'use strict';
  const C = window.CONFIG;
  const { Sim, HOOKS, BED } = window.Phys;
  const AU = window.GameAudio;
  const $ = (id) => document.getElementById(id);
  const H = 1 / C.physics.hz;
  const DEG = Math.PI / 180;
  const ROT_STEP = 15 * DEG;
  const LIFT_PX = 26; // the held item floats this far above the finger so it stays visible

  // ---------------------------------------------------------------- sprites
  const SPRITE_NAMES = ['truck', 'magnet_truck', 'wheel', 'tire', 'box', 'sofa', 'plank', 'fridge_body', 'fridge_door_top', 'fridge_door_bottom',
    'watermelon', 'sofa_cushion', 'cat_body', 'cat_arm', 'bowling', 'rubber_ball', 'shelf', 'robot', 'open_box', 'fragile_box', 'lift_block',
    'magnet_sign', 'worker_push', 'worker_press', 'worker_thumb', 'crane_body', 'crane_boom', 'crane_hook'];
  const spriteURL = (n) => (window.SPRITES && window.SPRITES[n]) || (window.SPRITE_BASE || 'assets/sprites/') + n + '.png';
  const sprites = {};
  const spritesReady = Promise.all(SPRITE_NAMES.map((n) => new Promise((res) => {
    const img = new Image();
    img.onload = () => { sprites[n] = img; res(); };
    img.onerror = () => res();
    img.src = spriteURL(n);
  })));

  const PART_NAMES = { root: '本体', door0: '上の扉', door1: '下の扉', cushion: '折りたたみ部', arm: '腕', robot: 'ロボット', melon0: 'スイカ', melon1: 'スイカ', melon2: 'スイカ' };

  // ---------------------------------------------------------------- saved progress
  const SAVE_KEY = 'ichibin-progress-v2';
  let progress = { unlocked: 1, best: {}, stars: {} };
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) progress = Object.assign(progress, JSON.parse(raw));
  } catch (_) { /* storage blocked: play without saving */ }
  function saveProgress() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(progress)); } catch (_) { /* storage blocked */ }
  }

  // ---------------------------------------------------------------- state
  const G = {
    state: 'title',        // title | stages | loading | driving | result
    stage: C.stages[0],
    sim: null,
    snaps: {},             // stage id -> departure snapshot (the load to retry)
    mode: 'cargo',
    held: null,            // {id, x, y, a, valid, finger}
    drag: null,
    history: [],
    beltHook: null,
    beltItem: null,        // {id, part, local}
    pointer: null,
    paused: false,
    input: { throttle: false, brake: false },
    drive: null,
    rotateDismissed: false,
    soundOn: true,
    shownIntro: {},
    shownDriveHint: false,
  };

  const cv = $('cv');
  const R = new window.Renderer(cv, sprites);
  R.debug = /debug/.test(location.search + location.hash);

  try { G.soundOn = localStorage.getItem('ichibin-sound') !== 'off'; } catch (_) { /* storage blocked */ }
  AU.enabled = G.soundOn;
  document.body.classList.toggle('muted', !G.soundOn);

  // ---------------------------------------------------------------- toasts (never spam the driver)
  let toastTimer = 0;
  let lastToastAt = -1e9;
  const recentLines = new Map();
  function toast(msg, warn, ms, force) {
    const now = performance.now();
    if (!force) {
      if (now - (recentLines.get(msg) || -1e9) < 9000) return;   // same words: not again so soon
      if (now - lastToastAt < 1400 && !warn) return;              // one line at a time
    }
    recentLines.set(msg, now);
    lastToastAt = now;
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
  const stars = (n) => '★'.repeat(n) + '☆'.repeat(3 - n);

  function halfExtentY(spec, a) {
    const c = Math.cos(a), s = Math.sin(a);
    let m = 0;
    for (const p of spec.outer) {
      if (p.circle) m = Math.max(m, Math.abs(p.c.x * s + p.c.y * c) + p.r);
      else for (const v of p.verts) m = Math.max(m, Math.abs(v.x * s + v.y * c));
    }
    return m;
  }

  function topOfCargo(filter) {
    let top = -Infinity;
    for (const it of G.sim.allItems()) {
      if (!it.bodies || (filter && !filter(it))) continue;
      for (const b of Object.values(it.bodies)) {
        if (!b.isActive()) continue;
        for (let f = b.getFixtureList(); f; f = f.getNext()) top = Math.max(top, f.getAABB(0).upperBound.y);
      }
    }
    return top;
  }

  function bedWorld(u) { return G.sim.chassis.getWorldPoint({ x: BED.rear + u, y: BED.floorY }); }

  // ---------------------------------------------------------------- sim lifecycle
  function newLoadingSim(snapshot) {
    const sim = new Sim(G.stage, snapshot || null);
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

  // ---------------------------------------------------------------- tray (cargo list for this stage)
  let trayKeys = [];
  const trayCards = {};
  function buildTray() {
    const tray = $('tray');
    tray.innerHTML = '';
    trayKeys = [...new Set(G.stage.manifest.map((e) => e.type))];
    for (const key of trayKeys) {
      const t = C.cargoTypes[key];
      const b = document.createElement('button');
      b.className = 'card-item' + (t.kind !== 'simple' && t.kind !== 'shelf' ? ' special' : '');
      const meta = key === 'box' ? '3サイズ' : t.kind === 'fridge' ? 'スイカ入り' : t.kind === 'robotbox' ? '衝撃で起動' : t.kind === 'fragile' ? '逆さ厳禁' :
        t.kind === 'sofabed' ? '衝撃で展開' : t.kind === 'cat' ? '腕が動く' : `${t.mass}kg`;
      b.innerHTML = `<span class="thumb"><img alt="" src="${spriteURL(key === 'fridge' ? 'fridge_door_bottom' : t.kind === 'cat' ? 'cat_body' : t.sprite)}"></span>` +
        `<span><span class="nm">${t.name}</span><span class="meta">${meta} ・ ${yen(t.value)}</span></span><span class="ct">0</span>`;
      b.addEventListener('click', () => takeFromTray(key));
      tray.appendChild(b);
      trayCards[key] = b;
    }
    $('total-count').textContent = G.stage.manifest.length;
  }

  function availableIds(key) {
    return G.sim.items.filter((it) => it.spec.typeKey === key && !it.bodies && !(G.held && G.held.id === it.id)).map((it) => it.id);
  }

  function refreshTray() {
    let unloaded = 0;
    for (const key of trayKeys) {
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
    else if (unloaded <= 4) quip.textContent = 'あと少しで全部載ります。';
    else if (unloaded < G.stage.manifest.length) quip.textContent = 'まだまだ載ります。';
    else quip.textContent = 'まだ載ります。';
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
    if (!ids.length) { toast(`${C.cargoTypes[key].name}は全部載せました。`, false, 1600, true); return; }
    const id = ids[0];
    const spec = G.sim.item(id).spec;
    const p = bedWorld((BED.front - BED.rear) / 2);
    const top = Math.max(p.y, topOfCargo((it) => Math.abs(it.bodies.root.getPosition().x - p.x) < 3));
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
    h.valid = h.y - ext > G.sim.groundY(h.x) + 0.02 && !G.sim.overlaps(h.id, h.x, h.y, h.a);
  }

  function moveHeldTo(px, py) {
    const h = G.held;
    const spec = G.sim.item(h.id).spec;
    const w = R.toWorld(px, py - LIFT_PX);
    const cx = G.sim.chassis.getPosition().x;
    h.x = Math.max(cx - 5, Math.min(cx + 5, w.x));
    h.y = Math.max(G.sim.groundY(h.x) + 0.1, w.y + halfExtentY(spec, h.a));
    h.finger = { px, py };
    const wasValid = h.valid;
    validateHeld();
    if (wasValid !== h.valid) refreshTray();
  }

  function dropHeld() {
    const h = G.held;
    if (!h) return;
    if (!h.valid) {
      toast('ほかの荷物やトラックと重なっています。少しずらしてください。', true, 1900, true);
      refreshTray();
      return;
    }
    G.sim.placeItem(h.id, { x: h.x, y: h.y, a: h.a });
    G.history = G.history.filter((id) => id !== h.id);
    G.history.push(h.id);
    G.held = null;
    AU.place();
    refreshTray();
  }

  function pickUp(it) {
    const b = it.bodies.root;
    const hadBelts = G.sim.belts.some((bt) => bt.id === it.id);
    G.held = { id: it.id, x: b.getPosition().x, y: b.getPosition().y, a: b.getAngle(), valid: true, finger: null };
    G.sim.removeItem(it.id);
    G.history = G.history.filter((id) => id !== it.id);
    if (hadBelts) { toast('持ち上げたのでベルトを外しました。', false, 1800, true); refreshBelts(); }
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
    for (const it of G.sim.items) if (it.bodies) G.sim.removeItem(it.id);
    G.held = null;
    G.history = [];
    G.beltHook = null;
    G.beltItem = null;
  }

  let resetArmed = 0;
  function resetLoad() {
    const btn = $('btn-reset');
    if (!G.sim.loadedItems().length && !G.held) { toast('荷台はもう空です。', false, 1500, true); return; }
    if (performance.now() - resetArmed > 2500) {
      resetArmed = performance.now();
      btn.textContent = 'もう一度押すと全部おろす';
      setTimeout(() => (btn.textContent = '積み直し'), 2500);
      return;
    }
    resetArmed = 0;
    btn.textContent = '積み直し';
    clearAll();
    toast('全部おろしました。', false, 1500, true);
    refreshTray();
    refreshBelts();
  }

  function undo() {
    if (G.held) { G.held = null; refreshTray(); return; }
    while (G.history.length) {
      const id = G.history.pop();
      if (G.sim.item(id).bodies) {
        G.sim.removeItem(id);
        toast(`${G.sim.item(id).spec.name}をおろしました。`, false, 1500, true);
        refreshTray();
        refreshBelts();
        return;
      }
    }
    toast('取り消せる荷物がありません。', false, 1500, true);
  }

  function recommended() {
    clearAll();
    G.history = window.Layout.apply(G.sim, G.stage.recommended);
    toast('おすすめの無茶積みです。ベルト3本つき。', false, 2000, true);
    AU.place();
    refreshTray();
    refreshBelts();
  }

  // ---------------------------------------------------------------- belts
  const beltNodes = [];
  const partLabel = (it, part) => it.spec.name + (part !== 'root' && it.spec.kind !== 'robotbox' ? `（${PART_NAMES[part] || part}）` : part === 'robot' ? '（ロボット）' : '');
  function refreshBelts() {
    const ul = $('belt-list');
    ul.innerHTML = '';
    beltNodes.length = 0;
    for (let i = 0; i < C.belt.count; i++) {
      const b = G.sim.belts[i];
      const li = document.createElement('li');
      if (b) {
        li.innerHTML = `<i class="sw"></i><span>${HOOKS[b.hook].name}<br>→ ${partLabel(G.sim.item(b.id), b.part)}</span><button>外す</button>`;
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
    const sel = G.beltItem ? G.sim.item(G.beltItem.id) : null;
    const multi = sel && Object.keys(sel.bodies).length > 1;
    if (G.beltHook != null && !G.beltItem) hint.textContent = `${HOOKS[G.beltHook].name}を選びました。次に荷物の留めたい場所を押します。`;
    else if (sel && G.beltHook == null) hint.textContent = `${partLabel(sel, G.beltItem.part)}を選びました。${multi ? 'もう一度押すと留める部分が変わります。' : ''}次に光っているフックを押します。`;
    else if (G.sim.belts.length >= C.belt.count) hint.textContent = 'ベルトは3本とも使っています。付け直すときは「外す」を押します。';
    else hint.textContent = '光っているフックを押してから、荷物の留めたい場所を押します。扉や腕も直接留められます。';
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
      const hits = G.sim.hitTest(w);
      if (hits.length) {
        const it = hits[0].item;
        let part = hits[0].part;
        // tapping the same item again cycles through the parts it can be strapped by
        if (G.beltItem && G.beltItem.id === it.id) {
          const parts = [...new Set(hits.filter((h) => h.item === it).map((h) => h.part).concat(['root']))]
            .filter((p) => !p.startsWith('melon') || hits.some((h) => h.part === p));
          const i = parts.indexOf(G.beltItem.part);
          part = parts[(i + 1) % parts.length];
        }
        G.beltItem = { id: it.id, part, local: it.bodies[part].getLocalPoint(w) };
        AU.click();
      } else {
        G.beltHook = null;
        G.beltItem = null;
      }
    }
    if (G.beltHook != null && G.beltItem) {
      if (G.sim.belts.length >= C.belt.count) {
        toast('ベルトは3本までです。どれかを外してください。', true, 1900, true);
      } else {
        const b = G.sim.addBelt(G.beltHook, G.beltItem.id, G.beltItem.part, G.beltItem.local);
        if (b) { AU.belt(); toast(`${partLabel(G.sim.item(b.id), b.part)}を固定しました。`, false, 1600, true); }
        else toast('フックから遠すぎるか、同じ場所に掛かっています。', true, 1900, true);
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
      const hits = G.sim.hitTest(w);
      if (!hits.length) return;
      pickUp(hits[0].item);
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
    show('stages', s === 'stages');
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

  function showStages() {
    const list = $('stage-list');
    list.innerHTML = '';
    for (const st of C.stages) {
      const locked = st.id > progress.unlocked;
      const b = document.createElement('button');
      b.className = 'stage-card' + (locked ? ' locked' : '');
      b.disabled = locked;
      const best = progress.best[st.id];
      b.innerHTML = `<span class="no">${st.id}</span><span class="body"><span class="nm">${st.name}</span>` +
        `<span class="bl">${locked ? '前のステージを配達すると解禁' : st.blurb}</span>` +
        `<span class="rec"><b class="st">${stars(progress.stars[st.id] || 0)}</b>${best != null ? ` 自己ベスト ${yen(best)}` : ' まだ記録なし'}</span></span>`;
      b.addEventListener('click', () => { AU.unlock(); AU.click(); selectStage(st.id); });
      list.appendChild(b);
    }
    setState('stages');
  }

  function selectStage(id) {
    G.stage = C.stages.find((s) => s.id === id);
    enterLoading(G.snaps[id] || null);
  }

  function enterLoading(snapshot) {
    newLoadingSim(snapshot);
    buildTray();
    buildProgressMarks();
    $('stage-label').textContent = `${G.stage.id} ${G.stage.name}`;
    setState('loading');
    setMode('cargo');
    refreshTray();
    refreshBelts();
    if (!G.shownIntro[G.stage.id]) {
      G.shownIntro[G.stage.id] = true;
      toast(G.stage.intro, false, 4200, true);
    }
  }

  function depart() {
    if (G.held) G.held = null;
    G.snaps[G.stage.id] = G.sim.snapshot();
    startDrive();
    if (!G.shownDriveHint) {
      G.shownDriveHint = true;
      toast('右下アクセル、左下ブレーキ。旗の間で止まると配達です。', false, 3200, true);
    } else toast(G.sim.loadedItems().length ? '一便でいけます。' : '空のトラックで出発します。', false, 1500, true);
  }

  function startDrive() {
    const sim = new Sim(G.stage, G.snaps[G.stage.id]);
    sim.onImpact = onImpact;
    sim.startDriving();
    G.sim = sim;
    G.drive = { falls: 0, goalHold: 0, rollT: 0, stuckT: 0, stuckShown: false, highT: 0 };
    $('load-count').textContent = sim.loadedItems().length;
    setState('driving');
    AU.engineOn();
  }

  function maxStageValue() {
    return G.sim.specs.reduce((s, sp) => s + sp.units.reduce((a, u) => a + u.value, 0), 0);
  }

  function finish() {
    const sim = G.sim;
    const units = sim.scoreUnits();
    const main = units.filter((u) => !u.bonus);
    const delivered = units.filter((u) => u.delivered);
    const lost = main.filter((u) => !u.delivered);
    const bonus = units.find((u) => u.bonus);
    const loadedIds = new Set(sim.loadedItems().map((it) => it.id));
    const unloaded = sim.items.filter((it) => !loadedIds.has(it.id));
    const unloadedUnits = unloaded.reduce((n, it) => n + it.spec.units.length, 0);
    const value = delivered.reduce((s, u) => s + u.value, 0);
    const loadedValue = main.reduce((s, u) => s + u.value, 0);
    const maxV = maxStageValue();
    const cleared = value >= G.stage.norm;
    const nStars = !cleared ? 0 : value >= maxV * 0.85 ? 3 : value >= maxV * 0.55 ? 2 : 1;
    let title;
    if (!loadedIds.size) title = '何も積まずに着きました。';
    else if (!lost.length && !unloaded.length) title = '一便でいけました。';
    else if (!lost.length) title = '載せた分は全部届きました。';
    else if (value >= loadedValue * 0.6) title = 'だいたい届きました。';
    else if (cleared) title = '一部は、確かに届きました。';
    else title = 'トラックは無事です。';
    $('result-title').textContent = title;
    $('res-value').textContent = yen(value);
    $('res-max').textContent = `ノルマ ${yen(G.stage.norm)} ・ 満点 ${yen(maxV)}`;
    $('res-stars').textContent = stars(nStars);
    $('res-clear').textContent = cleared ? (G.stage.id < C.stages.length ? '配達完了。次のステージへ進めます。' : '配達完了。全ステージ制覇です。') : `ノルマ ${yen(G.stage.norm)} に届きませんでした。積み方か運転を変えてみましょう。`;
    $('res-delivered').textContent = delivered.filter((u) => !u.bonus).length;
    $('res-lost').textContent = lost.length;
    $('res-unloaded').textContent = unloadedUnits;
    $('res-bonus').textContent = bonus ? (bonus.delivered ? '受取' : sim.crane && sim.crane.state === 'released' ? '落とした' : '見送り') : '—';
    $('res-time').textContent = Math.round(sim.driveTime) + '秒';
    // notes: contents vs container
    const notes = [];
    for (const it of sim.loadedItems()) {
      if (it.spec.kind !== 'fridge') continue;
      const own = units.filter((u) => u.id === it.id);
      const fridgeOk = own.find((u) => u.key === 'main').delivered;
      const melons = own.filter((u) => u.inner);
      const okM = melons.filter((u) => u.delivered).length;
      if (fridgeOk && okM < melons.length) notes.push(`冷蔵庫は届きました（中身のスイカ ${okM}/${melons.length}）。`);
      if (!fridgeOk && okM) notes.push(`スイカだけ ${okM} 個届きました。`);
    }
    if (sim.items.some((it) => it.bodies && it.spec.kind === 'robotbox' && it.st.open)) notes.push('お掃除ロボットの空き箱は数えません。');
    $('res-notes').textContent = notes.join(' ');
    const ul = $('res-items');
    ul.innerHTML = '';
    for (const u of units) {
      const li = document.createElement('li');
      li.className = (u.delivered ? '' : 'lost') + (u.bonus ? ' bonus' : '');
      li.innerHTML = `<img alt="${u.name}" src="${spriteURL(u.sprite === 'fridge_body' ? 'fridge_door_bottom' : u.sprite)}">`;
      ul.appendChild(li);
    }
    // progress
    const id = G.stage.id;
    if (cleared) {
      progress.unlocked = Math.max(progress.unlocked, Math.min(C.stages.length, id + 1));
      progress.stars[id] = Math.max(progress.stars[id] || 0, nStars);
    }
    const newBest = progress.best[id] == null || value > progress.best[id];
    if (newBest) progress.best[id] = value;
    saveProgress();
    $('res-best').textContent = newBest ? '自己ベスト更新' : `自己ベスト ${yen(progress.best[id])}`;
    show('btn-res-next', cleared && id < C.stages.length);
    setState('result');
    if (cleared && !lost.length) AU.fanfare(); else if (cleared) AU.fanfareShort(); else AU.sad();
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
    newLoadingSim(G.snaps[G.stage.id]);
  }

  // ---------------------------------------------------------------- what happened: sounds and short lines
  const FALL_LINES = ['今のは予備です。', '今のも予備です。', 'あれは置いていく予定でした。', '想定内です。'];
  function handleEvents(sim) {
    for (const e of sim.events.splice(0)) {
      if (G.state === 'loading') {
        continue;
      }
      switch (e.type) {
        case 'fridge-open': AU.latch(); toast('冷蔵庫の留め具が外れました。', true); break;
        case 'melon-free': AU.roll(); toast('中身も込みです。'); break;
        case 'melon-fall': AU.roll(); break;
        case 'sofa-open': AU.unfold(); toast('広く使えます。'); break;
        case 'cat-bell': AU.bell(); break;
        case 'cat-swing': toast('福を招いています。'); break;
        case 'robot-on': AU.robot(); toast('お掃除を始めます。'); break;
        case 'robot-turn': AU.blip(); break;
        case 'fragile-up': AU.shimmer(); toast('天地無用です。'); break;
        case 'magnet-start': toast('対向車です。磁石です。', true, 2200); break;
        case 'magnet-pull': AU.magnet(); break;
        case 'worker-start': toast('押さえておきます！', true, 2000); AU.hey(); break;
        case 'worker-press': AU.thump(400, 60); break;
        case 'worker-release': AU.boing(); break;
        case 'worker-done': toast('完璧です！', false, 1800); break;
        case 'crane-warn': toast('あとひとつだけ！', true, 2400); AU.beep(); break;
        case 'crane-release': AU.latch(); toast('追加で一点、承りました。'); break;
        case 'crane-miss': toast('あとひとつは、見なかったことにします。'); break;
        case 'fall': {
          G.drive.falls += 1;
          AU.fall();
          toast(FALL_LINES[Math.min(G.drive.falls - 1, FALL_LINES.length - 1)]);
          break;
        }
        default: break;
      }
    }
  }

  // ---------------------------------------------------------------- per-step game logic
  function stepLoading(h) {
    const sim = G.sim;
    sim.controls.throttle = false;
    sim.controls.brake = true;
    sim.step(h);
    sim.events.length = 0;
    // anything that slid off onto the road goes back to the list
    for (const it of sim.items) {
      if (it.bodies && it.fallen) {
        sim.removeItem(it.id);
        G.history = G.history.filter((id) => id !== it.id);
        toast(`${it.spec.name}が落ちたので一覧に戻しました。`, false, 1800, true);
        refreshTray();
        refreshBelts();
      }
    }
  }

  function stepDriving(h) {
    const sim = G.sim;
    const d = G.drive;
    sim.controls.throttle = G.input.throttle;
    sim.controls.brake = G.input.brake;
    sim.step(h);
    handleEvents(sim);
    const ch = sim.chassis;
    const x = ch.getPosition().x;
    const v = sim.speed();
    const maxT = sim.belts.reduce((m, b) => Math.max(m, b.tension), 0);
    if (maxT > C.belt.tensionHigh) { d.highT += h; if (d.highT > 0.05) AU.creak(Math.min(1, maxT / C.belt.maxForce)); } else d.highT = 0;
    const c = sim.course;
    if (x > c.goalStart && x < c.goalEnd + 1 && Math.abs(v) < 0.45 && Math.abs(ch.getAngle()) < 0.8) {
      d.goalHold += h;
      if (d.goalHold > 1.2) { finish(); return; }
    } else d.goalHold = 0;
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
    if ((G.state === 'title' || G.state === 'stages') && R.w > R.h) r.l = R.w * 0.42;
    r.l += 8; r.r -= 8; r.t += 8; r.b -= 8;
    return r;
  }

  function updateCamera(dt) {
    const sim = G.sim;
    const ch = sim.chassis.getPosition();
    const g = sim.groundY(ch.x);
    if (G.state === 'driving' || G.state === 'result') {
      const top = topOfCargo((it) => !it.fallen && Math.abs(it.bodies.root.getPosition().x - ch.x) < 6);
      let y1 = Math.max(g + 3.3, top + 0.5);
      const y0 = Math.min(g, sim.groundY(ch.x + 6)) - 0.9;
      const rect = freeRect();
      rect.b -= Math.min(60, R.h * 0.08); // keep the road clear of the pedals
      let ahead = 6.5;
      if (sim.magnet) {
        const mx = sim.magnet.x - ch.x;
        if (mx > 0 && mx < 26) ahead = Math.min(12, Math.max(ahead, mx + 3));
      }
      const m = sim.course.marks;
      // show the worker on his bridge and the crane's hanging load when they are near
      if (m.worker != null && sim.worker && m.worker - ch.x < 12 && ch.x - m.worker < 6) y1 = Math.max(y1, g + C.worker.bridgeHeight + 2.4);
      if (m.crane != null && sim.crane && m.crane - ch.x < 14 && ch.x - m.crane < 6) { y1 = Math.max(y1, sim.crane.hook.getPosition().y + 1); ahead = Math.max(ahead, Math.min(10, m.crane - ch.x + 3)); }
      R.frame(ch.x - 2.6, ch.x + ahead, y0, y1, rect, 1 - Math.exp(-dt * 2.5));
    } else {
      let top = topOfCargo((it) => Math.abs(it.bodies.root.getPosition().x - ch.x) < 6);
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
    const c = sim.course;
    const f = Math.max(0, Math.min(1, (x - C.truck.startX) / (c.goalStart + 14 - C.truck.startX)));
    $('prog-truck').style.left = (f * 100).toFixed(1) + '%';
    if (hudTick > 0.25) {
      hudTick = 0;
      const sup = sim.supportedBodies();
      $('on-count').textContent = sim.loadedItems().filter((it) => sup.has(it.bodies.root) && !it.fallen).length;
    }
    AU.engineSet(Math.min(1, Math.abs(sim.speed()) / 7.5), sim.throttle);
  }

  const SIGN_LABELS = { bump: '段差', hill: '坂', crest: '頂上', magnet: '磁石', stop: '親切', crane: 'あとひとつ', down: '下り' };
  function buildProgressMarks() {
    const c = G.sim.course;
    const span = c.goalStart + 14 - C.truck.startX;
    const track = $('prog-track');
    track.querySelectorAll('.mk').forEach((n) => n.remove());
    const marks = c.signs.map((s) => [s.x + 6, SIGN_LABELS[s.kind] || '']).concat([[c.goalStart, 'ゴール']]);
    let lastX = -1e9;
    for (const [x, label] of marks) {
      if (x - lastX < 12 && label !== 'ゴール') continue; // keep labels readable
      lastX = x;
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
  on('btn-start', () => { AU.click(); showStages(); });
  on('btn-howto', () => { $('howto').hidden = !$('howto').hidden; });
  on('btn-stages-back', () => setState('title'));
  on('btn-home', showStages);
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
  on('btn-pause-reload', () => enterLoading(G.snaps[G.stage.id]));
  on('btn-pause-stages', showStages);
  on('btn-stuck-retry', startDrive);
  on('btn-stuck-reload', () => enterLoading(G.snaps[G.stage.id]));
  on('btn-stuck-close', () => { show('stuck', false); G.paused = false; });
  on('btn-res-retry', startDrive);
  on('btn-res-reload', () => enterLoading(G.snaps[G.stage.id]));
  on('btn-res-stages', showStages);
  on('btn-res-next', () => selectStage(G.stage.id + 1));
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
        if (G.state === 'result') break;
      }
      if (n >= C.physics.maxStepsPerFrame) acc = 0;
    } else acc = 0;
    updateCamera(dt);
    R.draw({
      sim: G.sim, t: now / 1000,
      mode: G.state === 'loading' ? G.mode : null,
      held: G.state === 'loading' ? G.held : null,
      highlight: G.beltItem,
      beltHook: G.state === 'loading' && G.mode === 'belt' ? G.beltHook : null,
      pointer: G.state === 'loading' && G.mode === 'belt' ? G.pointer : null,
    });
    updateHUD(dt);
  }

  // ---------------------------------------------------------------- boot
  newLoadingSim(null);
  buildTray();
  buildProgressMarks();
  setState('title');
  spritesReady.then(() => {
    last = performance.now();
    requestAnimationFrame(frame);
  });

  // exposed for automated checks
  window.__game = { G, R, progress, startDrive, enterLoading, selectStage, showStages, recommended, depart, finish, setMode, takeFromTray, dropHeld, moveHeldTo };
})();
