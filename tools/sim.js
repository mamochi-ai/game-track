// Headless physics checks: node tools/sim.js [scenario]
// Loads the same scripts the browser loads (planck, config, outlines, physics) into a VM context.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const ctx = { console, Math, Date, performance: { now: () => Date.now() } };
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of ['js/vendor/planck.min.js', 'js/outlines.js', 'js/config.js', 'js/physics.js', 'js/layout.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const { Phys, CONFIG: C, Layout } = ctx;
const H = 1 / C.physics.hz;

function summary(sim, label) {
  const sup = sim.supportedIds();
  const loaded = sim.loadedItems();
  const fallen = loaded.filter((it) => it.fallen).length;
  const ch = sim.chassis.getPosition();
  console.log(`${label}: t=${sim.time.toFixed(1)}s x=${ch.x.toFixed(1)} v=${sim.speed().toFixed(2)} ang=${(sim.chassis.getAngle() * 57.3).toFixed(1)}deg loaded=${loaded.length} onTruck=${sup.size} fallen=${fallen}`);
}

function pileTop(sim) {
  let top = -1e9;
  for (const it of sim.loadedItems()) {
    const p = it.body.getPosition();
    top = Math.max(top, p.y + it.spec.size[1] / 2);
  }
  return top;
}

function drive(sim, policy, maxT = 150, log = true) {
  sim.phase = 'driving';
  let hold = 0;
  let lastLog = 0;
  const events = [];
  const wasFallen = new Set();
  while (sim.time < maxT) {
    const x = sim.chassis.getPosition().x;
    Object.assign(sim.controls, policy(sim, x));
    sim.step(H);
    for (const it of sim.loadedItems()) {
      if (it.fallen && !wasFallen.has(it.id)) {
        wasFallen.add(it.id);
        events.push(`${it.spec.name}#${it.id} fell at x=${x.toFixed(1)} t=${sim.time.toFixed(1)}`);
      }
    }
    if (log && sim.time - lastLog > 10) { lastLog = sim.time; summary(sim, '  drive'); }
    if (x > C.course.goalStart && x < C.course.goalEnd && Math.abs(sim.speed()) < C.course.goalSpeed) {
      hold += H;
      if (hold > C.course.goalHold) break;
    } else hold = 0;
    if (Math.abs(sim.chassis.getAngle()) > 1.4) { events.push('ROLLED OVER'); break; }
  }
  events.forEach((e) => console.log('   ', e));
  summary(sim, 'END');
  return sim;
}

// cruise at target speed, slow for the magnet, brake into the goal
const careful = (vmax) => (sim, x) => {
  const v = sim.speed();
  let target = vmax;
  if (x > C.course.goalStart - 25) target = Math.min(target, Math.max(0, (C.course.goalStart + 12 - x) * 0.35));
  // gentle: hold the pedal below target, coast above it, brake only when clearly too fast
  return { throttle: v < target - 0.2, brake: v > target + 1.5 };
};
// floor it, then slam the brakes
const reckless = (sim, x) => {
  if (x > C.course.goalStart + 4) return { throttle: false, brake: true };
  return { throttle: true, brake: false };
};

function freshLoaded(layout) {
  const sim = new Phys.Sim(null);
  Layout.apply(sim, layout || C.recommended);
  sim.settle(2.5);
  // depart from a clean rebuild, exactly like the game does
  return new Phys.Sim(sim.snapshot());
}

const scenario = process.argv[2] || 'all';
if (scenario === 'empty' || scenario === 'all') {
  const sim = new Phys.Sim(null);
  const j = sim.wheelJoints.map((w) => w.getJointTranslation().toFixed(3));
  console.log('empty truck chassis y', sim.chassis.getPosition().y.toFixed(3), 'wheel travel', j, 'mass', sim.chassis.getMass().toFixed(0));
  drive(sim, careful(6), 120, false);
}
if (scenario === 'recommended' || scenario === 'all') {
  const sim = freshLoaded();
  console.log('recommended: loaded', sim.loadedItems().length, 'pile top', pileTop(sim).toFixed(2), 'wheel travel', sim.wheelJoints.map((w) => w.getJointTranslation().toFixed(3)));
  const sup = sim.supportedIds();
  console.log('  settled on truck:', sup.size, 'belts', sim.belts.length);
  for (const v of [3, 4, 5, 6, 7, 8]) { console.log(`careful ${v} m/s:`); drive(freshLoaded(), careful(v), 150, false); }
  console.log('reckless:'); drive(freshLoaded(), reckless, 150, false);
}
if (scenario === 'inertia' || scenario === 'all') {
  // a lone box on the bed: launch pushes it back, braking pushes it forward
  const sim = new Phys.Sim(null);
  const x0 = sim.chassis.getPosition().x;
  const id = 11;
  const y = sim.dropHeight(id, x0 - 0.6, 0);
  sim.placeItem(id, x0 - 0.6, y, 0);
  sim.settle(1);
  sim.phase = 'driving';
  const rel = () => sim.items[id].body.getPosition().x - sim.chassis.getPosition().x;
  const r0 = rel();
  sim.controls = { throttle: true, brake: false };
  for (let t = 0; t < 1.2; t += H) sim.step(H);
  const r1 = rel();
  sim.controls = { throttle: false, brake: true };
  for (let t = 0; t < 1.5; t += H) sim.step(H);
  const r2 = rel();
  console.log(`inertia: box rel x start ${r0.toFixed(3)} after launch ${r1.toFixed(3)} after brake ${r2.toFixed(3)} (launch should move back, brake forward)`);
}
if (scenario === 'magnet' || scenario === 'all') {
  const sim = freshLoaded();
  sim.phase = 'driving';
  let maxF = {};
  sim.controls = { throttle: false, brake: true };
  // teleport-free check: run the oncoming truck past a parked loaded truck
  sim.magnet.moving = true;
  sim.magnet.x = sim.chassis.getPosition().x + 25;
  for (let t = 0; t < 10; t += H) {
    sim.step(H);
    for (const it of sim.items) if (it.magnetForce) maxF[it.spec.name] = Math.max(maxF[it.spec.name] || 0, it.magnetForce);
  }
  console.log('magnet: max force by item type', JSON.stringify(maxF));
  summary(sim, '  after pass (parked)');
}
if (scenario === 'heavytop' || scenario === 'all') {
  const run = (order, label) => {
    const sim = new Phys.Sim(null);
    Layout.apply(sim, { items: order, belts: [] });
    sim.settle(2);
    const s2 = new Phys.Sim(sim.snapshot());
    console.log(label);
    drive(s2, careful(6.5), 150, false);
  };
  // same items, fridge on the bottom vs on top of the boxes
  run([{ id: 0, x: 0.5, a: 90 }, { id: 11, x: 0.4, a: 0 }, { id: 12, x: 1.1, a: 0 }, { id: 13, x: 0.75, a: 0 }], 'heavy bottom:');
  run([{ id: 11, x: 0.4, a: 0 }, { id: 12, x: 1.1, a: 0 }, { id: 13, x: 0.75, a: 0 }, { id: 0, x: 0.75, a: 0 }], 'heavy top:');
}

// dump poses for tools/snap.py (renders a PNG of the scene)
function dumpScene(sim, file) {
  const out = [];
  const T = Phys.TRUCK_PX;
  sim.wheels.forEach((w) => out.push({ sprite: 'wheel', x: w.getPosition().x, y: w.getPosition().y, a: w.getAngle(), w: C.truck.wheelRadius * 2 * 269 / 262, h: C.truck.wheelRadius * 2 * 269 / 262 }));
  const c = sim.chassis;
  out.push({ sprite: 'truck', x: c.getPosition().x, y: c.getPosition().y, a: c.getAngle(), w: T.w / Phys.TS, h: T.h / Phys.TS });
  for (const it of sim.loadedItems()) out.push({ sprite: it.spec.sprite, x: it.body.getPosition().x, y: it.body.getPosition().y, a: it.body.getAngle(), w: it.spec.size[0], h: it.spec.size[1] });
  const belts = sim.belts.map((b) => { const p = sim.hookWorld(b.hook); const q = sim.items[b.id].body.getWorldPoint(b.local); return [p.x, p.y, q.x, q.y]; });
  const polys = [];
  for (let b = sim.world.getBodyList(); b; b = b.getNext()) {
    if (b === sim.ground) continue;
    for (let f = b.getFixtureList(); f; f = f.getNext()) {
      const sh = f.getShape();
      if (sh.getType() === 'polygon') polys.push(sh.m_vertices.map((v) => { const p = b.getWorldPoint(v); return [p.x, p.y]; }));
    }
  }
  fs.writeFileSync(file, JSON.stringify({ cx: c.getPosition().x, items: out, belts, polys }));
}
if (scenario === 'snap') {
  const sim = new Phys.Sim(null);
  Layout.apply(sim, C.recommended);
  dumpScene(sim, process.argv[3] + '.placed.json');
  sim.settle(3);
  dumpScene(sim, process.argv[3] + '.settled.json');
  const s2 = new Phys.Sim(sim.snapshot());
  const until = Number(process.argv[4] || 0);
  if (until) {
    s2.phase = 'driving';
    const pol = process.argv[5] === 'reckless' ? reckless : careful(Number(process.argv[5] || 6));
    while (s2.chassis.getPosition().x < until && s2.time < 100) { Object.assign(s2.controls, pol(s2, s2.chassis.getPosition().x)); s2.step(H); }
    dumpScene(s2, process.argv[3] + '.drive.json');
    summary(s2, 'snap drive');
  }
}
if (scenario === 'trace') {
  const sim = freshLoaded();
  sim.phase = 'driving';
  const id = Number(process.argv[3] || 11);
  const pol = careful(Number(process.argv[4] || 3.5));
  for (let i = 0; i < 400; i++) {
    Object.assign(sim.controls, pol(sim, sim.chassis.getPosition().x));
    sim.step(H);
    if (i % 20 === 0) {
      const b = sim.items[id].body, ch = sim.chassis;
      const l = ch.getLocalPoint(b.getPosition());
      console.log(`t=${sim.time.toFixed(2)} v=${sim.speed().toFixed(2)} thr=${sim.throttle.toFixed(2)} brk=${sim.controls.brake} pitch=${(ch.getAngle() * 57.3).toFixed(2)} item local=(${l.x.toFixed(2)},${l.y.toFixed(2)}) ang=${((b.getAngle() - ch.getAngle()) * 57.3).toFixed(1)} fallen=${sim.items[id].fallen}`);
    }
  }
}
if (scenario === 'magnet2') {
  // the recommended pile with the fridge strap moved elsewhere vs kept
  for (const [label, belts] of [['fridge strapped', C.recommended.belts], ['fridge loose', C.recommended.belts.filter((b) => b.id !== 0)]]) {
    for (const v of [3, 5, 7]) {
      const sim = freshLoaded({ items: C.recommended.items, belts });
      sim.phase = 'driving';
      const pol = careful(v);
      let maxF = 0;
      const startPos = () => sim.chassis.getLocalPoint(sim.items[0].body.getPosition());
      let p0 = null;
      let fellAt = null;
      while (sim.time < 150) {
        const x = sim.chassis.getPosition().x;
        // cruise at v through the magnet zone, otherwise 5 m/s
        Object.assign(sim.controls, (x > 200 && x < 270 ? pol : careful(5))(sim, x));
        sim.step(H);
        if (x > 200 && !p0) p0 = startPos();
        maxF = Math.max(maxF, sim.items[0].magnetForce);
        if (sim.items[0].fallen && fellAt == null) fellAt = x;
        if (x > 290) break;
      }
      const p1 = sim.items[0].fallen ? null : startPos();
      console.log(`${label} @${v}m/s: fridge maxF=${maxF.toFixed(0)}N fallen=${sim.items[0].fallen}${fellAt != null ? '@x=' + fellAt.toFixed(0) : ''} moved=${p1 ? Math.hypot(p1.x - p0.x, p1.y - p0.y).toFixed(2) + 'm' : '-'}; total fallen ${sim.loadedItems().filter((i) => i.fallen).length}`);
    }
  }
}
if (scenario === 'magnet3' || scenario === 'magnet4') {
  // magnet3: fridge standing at the front of the bed, boxes behind it
  // magnet4: fridge lying on top of a row of boxes
  const items = scenario === 'magnet3'
    ? [{ id: 0, x: 1.72, a: 0 }, { id: 11, x: 0.4, a: 0 }, { id: 12, x: 1.05, a: 0 }, { id: 14, x: 0.7, a: 0 }]
    : [{ id: 11, x: 0.35, a: 0 }, { id: 12, x: 1.0, a: 0 }, { id: 13, x: 1.65, a: 0 }, { id: 0, x: 1.0, a: 90 }];
  for (const [label, belts] of [['no belt', []], ['belt', [{ hook: 2, id: 0, u: -0.2, v: 0.4 }]]]) {
    for (const v of [3, 6, 8]) {
      const sim = freshLoaded({ items, belts });
      sim.phase = 'driving';
      let maxF = 0, fellAt = null, p0 = null, maxMove = 0;
      while (sim.time < 150) {
        const x = sim.chassis.getPosition().x;
        Object.assign(sim.controls, careful(x > 200 && x < 280 ? v : 5)(sim, x));
        sim.step(H);
        const it = sim.items[0];
        if (x > 200 && !p0) p0 = sim.chassis.getLocalPoint(it.body.getPosition());
        if (p0 && !it.fallen) { const l = sim.chassis.getLocalPoint(it.body.getPosition()); maxMove = Math.max(maxMove, Math.hypot(l.x - p0.x, l.y - p0.y)); }
        maxF = Math.max(maxF, it.magnetForce);
        if (it.fallen && fellAt == null) fellAt = x;
        if (x > 290) break;
      }
      console.log(`${label} @${v}: maxF=${maxF.toFixed(0)} fridge fell ${fellAt != null ? 'at x=' + fellAt.toFixed(0) : 'no'} maxMove=${maxMove.toFixed(2)} totalFallen=${sim.loadedItems().filter((i) => i.fallen).length}`);
    }
  }
}
