// Headless physics checks: node tools/sim.js <scenario> [args]
// Loads the same scripts the browser loads into a VM context.
//   units                 special cargo one by one (fridge, sofa, cat, robot, fragile, magnet, worker, crane)
//   stage <n> [layout]    drive stage n with the recommended load: floored vs careful driving
//   snap <n> <file> [x]   dump the recommended load (and optionally the scene at truck x) for tools/snap.py
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
const { Phys, CONFIG: C, Layout, planck: pl } = ctx;
const H = 1 / C.physics.hz;
const STAGE = (n) => C.stages[n - 1];

function loaded(stage, layout, settle = 2.5) {
  const sim = new Phys.Sim(stage, null);
  if (layout) Layout.apply(sim, layout);
  sim.settle(settle);
  const s2 = new Phys.Sim(stage, sim.snapshot()); // depart from a clean rebuild, like the game
  s2.startDriving();
  return s2;
}

function result(sim) {
  const units = sim.scoreUnits();
  const del = units.filter((u) => u.delivered);
  return { value: del.reduce((s, u) => s + u.value, 0), delivered: del.length, total: units.length, bonus: del.some((u) => u.bonus) };
}

// drive until stopped in the goal (or timeout); returns summary
function drive(sim, policy, maxT = 200, quiet = false) {
  const c = sim.course;
  let hold = 0;
  const log = [];
  while (sim.driveTime < maxT) {
    const x = sim.chassis.getPosition().x;
    Object.assign(sim.controls, policy(sim, x));
    sim.step(H);
    for (const e of sim.events.splice(0)) {
      if (e.type === 'cat-bell' || e.type === 'cat-swing' || e.type === 'robot-turn') continue;
      const nm = e.id != null ? sim.item(e.id).spec.name : '';
      log.push(`${e.type}${nm ? '(' + nm + ')' : ''}@x${x.toFixed(0)}`);
    }
    if (x > c.goalStart && x < c.goalEnd + 1 && Math.abs(sim.speed()) < 0.45 && Math.abs(sim.chassis.getAngle()) < 0.8) {
      hold += H;
      if (hold > 1.2) break;
    } else hold = 0;
    if (Math.abs(sim.chassis.getAngle()) > 1.4) { log.push('ROLLED'); break; }
  }
  const r = result(sim);
  if (!quiet) console.log(`   t=${sim.driveTime.toFixed(0)}s x=${sim.chassis.getPosition().x.toFixed(0)} value=¥${r.value} delivered ${r.delivered}/${r.total}${r.bonus ? ' +bonus' : ''}\n   ${log.join(' ')}`);
  return r;
}

const floored = () => ({ throttle: true, brake: false });
// a reasonable driver: cruise, ease off over the crest and downhill, stop in the goal, optionally wait for the crane
const careful = (v, opts = {}) => (sim, x) => {
  const c = sim.course, m = c.marks;
  const speed = sim.speed();
  let target = v;
  if (m.crestTop && x > m.crestTop - 14 && x < m.crestTop + 16) target = Math.min(target, 2.5);
  if (x > c.goalStart - 45) target = Math.min(target, 3.2);
  if (m.worker && opts.stopForWorker && Math.abs(x - 0.6 - m.worker) < 6) target = Math.min(target, 1.2);
  if (m.crane && opts.waitCrane && sim.crane && sim.crane.state !== 'released' && x < m.crane + 3) {
    const bed = sim.chassis.getWorldPoint(pl.Vec2(Phys.BED.center, 0)).x;
    target = Math.min(target, Math.max(0, (m.crane - bed) * 0.8));
  }
  if (x > c.goalStart + 8) target = 0;
  return { throttle: speed < target - 0.15, brake: speed > target + 0.9 || (target === 0 && speed > 0.05) };
};

const scenario = process.argv[2] || 'units';

// ------------------------------------------------------------------ unit checks
function unitStage(manifest, events) {
  return { id: 99, name: 'test', norm: 0, manifest, events: events || {}, course: [['flat', 200], ['goal', 30]] };
}
function bedPose(sim, u, a = 0) {
  const p = sim.chassis.getWorldPoint(pl.Vec2(Phys.BED.rear + u, Phys.BED.floorY));
  return p;
}
function place(sim, id, u, deg = 0) {
  const p = bedPose(sim, u);
  const a = (deg * Math.PI) / 180;
  const y = sim.dropHeight(id, p.x, a);
  sim.placeItem(id, { x: p.x, y, a });
}
function run(sim, secs, ctrl) {
  const ev = [];
  for (let t = 0; t < secs; t += H) {
    if (ctrl) Object.assign(sim.controls, ctrl(sim.driveTime));
    sim.step(H);
    ev.push(...sim.events.splice(0).map((e) => e.type));
  }
  return ev;
}
// jolt: brake hard from speed
const launchBrake = (tb) => (t) => (t < tb ? { throttle: true, brake: false } : { throttle: false, brake: true });

if (scenario === 'units') {
  // fridge: hard stop pops the catch; melons roll out; blocked door keeps them in
  for (const blocked of [false, true]) {
    const st = unitStage([{ type: 'fridge' }, { type: 'box', box: 'L' }]);
    let sim = new Phys.Sim(st, null);
    place(sim, 0, 0.5);
    if (blocked) place(sim, 1, 1.25);
    sim.settle(1);
    sim = new Phys.Sim(st, sim.snapshot()); sim.startDriving();
    const ev = run(sim, 6, launchBrake(2.6));
    const it = sim.item(0);
    const melonsOut = Object.keys(it.bodies).filter((k) => k.startsWith('melon')).filter((k) => {
      const l = it.bodies.root.getLocalPoint(it.bodies[k].getPosition());
      return Math.abs(l.x) > 0.4 || Math.abs(l.y) > 0.6;
    }).length;
    console.log(`fridge ${blocked ? 'door blocked' : 'free      '}: maxShock=${it.st.maxShock.toFixed(0)} events=[${[...new Set(ev)].join(',')}] door angles=${['door0', 'door1'].map((k) => it.joints[k].getJointAngle().toFixed(2))} melons out=${melonsOut}`);
  }
  // sofa bed: jolt unfolds, a box on the right blocks it partway
  for (const blocked of [false, true]) {
    const st = unitStage([{ type: 'sofabed' }, { type: 'box', box: 'L' }]);
    let sim = new Phys.Sim(st, null);
    place(sim, 0, 0.82);
    if (blocked) { const p = bedPose(sim, 1.85); sim.placeItem(1, { x: p.x, y: sim.dropHeight(1, p.x, 0), a: 0 }); }
    sim.settle(1);
    sim = new Phys.Sim(st, sim.snapshot()); sim.startDriving();
    const ev = run(sim, 6, launchBrake(2.6));
    const it = sim.item(0);
    console.log(`sofabed ${blocked ? 'blocked' : 'free   '}: maxShock=${it.st.maxShock.toFixed(0)} events=[${[...new Set(ev)].join(',')}] cushion angle=${it.joints.cushion.getJointAngle().toFixed(2)}`);
  }
  // cat: arm pushes a box; with a plank wedged the arm stalls without blowing up
  {
    const st = unitStage([{ type: 'cat' }, { type: 'box', box: 'L' }, { type: 'box', box: 'M' }]);
    let sim = new Phys.Sim(st, null);
    place(sim, 0, 0.6);
    place(sim, 1, 1.42);
    place(sim, 2, 1.42); // a stack as tall as the cat's shoulder
    sim.settle(1);
    sim = new Phys.Sim(st, sim.snapshot()); sim.startDriving();
    const box = sim.item(2).bodies.root;
    const x0 = sim.chassis.getLocalPoint(box.getPosition()).x;
    const ev = run(sim, 5.2, () => ({ throttle: false, brake: true }));
    const x1 = sim.chassis.getLocalPoint(box.getPosition()).x;
    let maxV = 0;
    run(sim, 10, () => ({ throttle: false, brake: true }));
    for (const b of Object.values(sim.item(0).bodies)) maxV = Math.max(maxV, b.getAngularVelocity());
    console.log(`cat: events=[${[...new Set(ev)].join(',')}] box pushed ${(x1 - x0).toFixed(2)} m, arm angle now ${sim.item(0).joints.arm.getJointAngle().toFixed(2)}`);
  }
  // robot box: jolt opens it, robot drives out and turns at the headboard
  {
    const st = unitStage([{ type: 'robotbox' }]);
    let sim = new Phys.Sim(st, null);
    place(sim, 0, 0.6);
    sim.settle(1);
    sim = new Phys.Sim(st, sim.snapshot()); sim.startDriving();
    const ev = run(sim, 3.2, launchBrake(2.0));
    const r = sim.item(0).bodies.robot;
    const xs = [];
    for (let i = 0; i < 12; i++) { run(sim, 0.5, () => ({ throttle: false, brake: true })).forEach((e) => ev.push(e)); xs.push(sim.chassis.getLocalPoint(r.getPosition()).x.toFixed(2)); }
    console.log(`robot: maxShock=${sim.item(0).st.maxShock.toFixed(0)} events=[${[...new Set(ev)].join(',')}] robot local x: ${xs.join(' ')}`);
  }
  // fragile: upside down floats up after a second; a belt holds it
  for (const belted of [false, true]) {
    const st = unitStage([{ type: 'fragile' }]);
    let sim = new Phys.Sim(st, null);
    place(sim, 0, 1.0, 180);
    if (belted) sim.addBelt(2, 0, 'root', pl.Vec2(0, -0.2));
    sim.settle(1);
    sim = new Phys.Sim(st, sim.snapshot()); sim.startDriving();
    const y0 = sim.item(0).bodies.root.getPosition().y;
    const ev = run(sim, 3, () => ({ throttle: false, brake: true }));
    const b = sim.item(0).bodies.root;
    console.log(`fragile ${belted ? 'belted' : 'loose '}: events=[${[...new Set(ev)].join(',')}] rose ${(b.getPosition().y - y0).toFixed(2)} m, vy=${b.getLinearVelocity().y.toFixed(2)}${belted ? ' belt tension=' + sim.belts[0].tension.toFixed(0) + 'N' : ''}`);
  }
  // magnet: only the fridge feels it
  {
    const st = unitStage([{ type: 'fridge' }, { type: 'box', box: 'L' }, { type: 'bowling' }], { magnet: true });
    st.course = [['flat', 20], ['mark', 'magnetTrigger'], ['flat', 10], ['mark', 'magnetPark'], ['flat', 200], ['goal', 30]];
    let sim = new Phys.Sim(st, null);
    place(sim, 0, 0.5); place(sim, 1, 1.5); place(sim, 2, 1.0);
    sim.settle(1);
    sim = new Phys.Sim(st, sim.snapshot()); sim.startDriving();
    sim.magnet.moving = true; sim.magnet.x = sim.chassis.getPosition().x + 14;
    const maxF = {};
    for (let t = 0; t < 6; t += H) { sim.controls = { throttle: false, brake: true }; sim.step(H); for (const it of sim.items) if (it.magnetForce) maxF[it.spec.name] = Math.max(maxF[it.spec.name] || 0, it.magnetForce); }
    console.log(`magnet: max force by item ${JSON.stringify(maxF)} (fridge only expected)`);
  }
  // worker: stop under the bridge, he presses, suspension sinks, release bounces the load
  {
    const st = unitStage([{ type: 'box', box: 'L' }, { type: 'box', box: 'M' }, { type: 'ball' }], { worker: true });
    st.course = [['flat', 20], ['mark', 'worker'], ['flat', 200], ['goal', 30]];
    let sim = new Phys.Sim(st, null);
    place(sim, 0, 1.0); place(sim, 1, 1.0); place(sim, 2, 1.0);
    sim.settle(1);
    sim = new Phys.Sim(st, sim.snapshot());
    // park the bed centre under the bridge
    sim.startDriving();
    const ev = [];
    let minTravel = 1, maxBoxVy = 0, maxBallVy = 0;
    for (let t = 0; t < 14; t += H) {
      const bed = sim.chassis.getWorldPoint(pl.Vec2(Phys.BED.center, 0)).x;
      sim.controls = bed < sim.course.marks.worker - 0.2 ? { throttle: sim.speed() < 1.5, brake: false } : { throttle: false, brake: true };
      sim.step(H);
      ev.push(...sim.events.splice(0).map((e) => e.type));
      minTravel = Math.min(minTravel, sim.wheelJoints[0].getJointTranslation());
      if (sim.worker.state === 'lifting' || sim.worker.state === 'done') {
        maxBoxVy = Math.max(maxBoxVy, sim.item(0).bodies.root.getLinearVelocity().y);
        maxBallVy = Math.max(maxBallVy, sim.item(2).bodies.root.getLinearVelocity().y);
      }
    }
    const r = result(sim);
    console.log(`worker: events=[${[...new Set(ev)].join(',')}] rear wheel travel min=${minTravel.toFixed(3)} (rest ~0.13) bounce vy box=${maxBoxVy.toFixed(2)} ball=${maxBallVy.toFixed(2)} delivered ${r.delivered}/${r.total}`);
  }
  // crane: wait under it -> caught; drive through -> missed
  for (const wait of [true, false]) {
    const st = unitStage([{ type: 'box', box: 'L' }], { crane: true });
    st.course = [['flat', 30], ['mark', 'crane'], ['flat', 200], ['goal', 30]];
    st.bonus = { type: 'bonus' };
    let sim = new Phys.Sim(st, null);
    place(sim, 0, 0.4);
    sim.settle(1);
    sim = new Phys.Sim(st, sim.snapshot()); sim.startDriving();
    const ev = [];
    for (let t = 0; t < 20; t += H) {
      const bed = sim.chassis.getWorldPoint(pl.Vec2(Phys.BED.center, 0)).x;
      if (wait) sim.controls = sim.crane.state !== 'released' && bed > sim.crane.x - 0.3 ? { throttle: false, brake: true } : { throttle: sim.speed() < 2, brake: false };
      else sim.controls = { throttle: true, brake: false };
      sim.step(H);
      ev.push(...sim.events.splice(0).map((e) => e.type));
      if (!wait && sim.chassis.getPosition().x > 60) break;
    }
    const r = result(sim);
    console.log(`crane ${wait ? 'wait ' : 'drive'}: events=[${[...new Set(ev)].join(',')}] bonus on truck=${r.bonus}`);
  }
}

// ------------------------------------------------------------------ stage runs
if (scenario === 'stage') {
  const n = Number(process.argv[3] || 1);
  const st = STAGE(n);
  const lay = st.recommended;
  const s0 = loaded(st, lay);
  console.log(`stage ${n}: loaded ${s0.loadedItems().length}/${st.manifest.length}, course ${s0.course.length.toFixed(0)} m`);
  for (const [label, pol] of [['floored', floored], ['careful 4', careful(4)], ['careful 6', careful(6)], ['careful 5 +stops', careful(5, { stopForWorker: true, waitCrane: true })]]) {
    console.log(label + ':');
    drive(loaded(st, lay), pol);
  }
}

// dump poses for tools/snap.py (renders a PNG of the scene)
function dumpScene(sim, file) {
  const out = [];
  const T = Phys.TRUCK_PX;
  sim.wheels.forEach((w) => out.push({ sprite: 'wheel', x: w.getPosition().x, y: w.getPosition().y, a: w.getAngle(), w: C.truck.wheelRadius * 2 * 269 / 262, h: C.truck.wheelRadius * 2 * 269 / 262 }));
  const c = sim.chassis;
  out.push({ sprite: 'truck', x: c.getPosition().x, y: c.getPosition().y, a: c.getAngle(), w: T.w / Phys.TS, h: T.h / Phys.TS });
  for (const it of sim.allItems()) {
    if (!it.bodies) continue;
    for (const [name, b] of Object.entries(it.bodies)) {
      for (const d of it.spec.draw[name]) out.push({ sprite: d.sprite, x: b.getPosition().x, y: b.getPosition().y, a: b.getAngle(), w: d.w, h: d.h });
    }
  }
  const belts = sim.belts.map((b) => { const p = sim.hookWorld(b.hook); const q = sim.beltBody(b).getWorldPoint(b.local); return [p.x, p.y, q.x, q.y]; });
  const polys = [];
  for (let b = sim.world.getBodyList(); b; b = b.getNext()) {
    if (b === sim.ground) continue;
    for (let f = b.getFixtureList(); f; f = f.getNext()) {
      const sh = f.getShape();
      if (sh.getType() === 'polygon') polys.push(sh.m_vertices.map((v) => { const p = b.getWorldPoint(v); return [p.x, p.y]; }));
    }
  }
  fs.writeFileSync(file, JSON.stringify({ cx: c.getPosition().x, gy: sim.groundY(c.getPosition().x), items: out, belts, polys }));
}
if (scenario === 'snap') {
  const n = Number(process.argv[3] || 1);
  const st = STAGE(n);
  const sim = new Phys.Sim(st, null);
  Layout.apply(sim, st.recommended);
  dumpScene(sim, process.argv[4] + '.placed.json');
  sim.settle(2.5);
  dumpScene(sim, process.argv[4] + '.settled.json');
  const until = Number(process.argv[5] || 0);
  if (until) {
    const s2 = loaded(st, st.recommended);
    const pol = process.argv[6] === 'floored' ? floored : careful(Number(process.argv[6] || 5));
    while (s2.chassis.getPosition().x < until && s2.driveTime < 150) { Object.assign(s2.controls, pol(s2, s2.chassis.getPosition().x)); s2.step(H); s2.events.length = 0; }
    dumpScene(s2, process.argv[4] + '.drive.json');
  }
}

module.exports = { loaded, drive, careful, floored };
if (scenario === 'shock') {
  // how big are jolts in ordinary driving vs. abuse? (box on the bed)
  const mk = () => { const st = unitStage([{ type: 'box', box: 'M' }]); st.course = [['flat', 30], ['bump', 0.14, 1.0], ['flat', 40], ['crest', 2.3, 24, 13], ['flat', 60], ['goal', 30]]; let s = new Phys.Sim(st, null); place(s, 0, 1.0); s.settle(1); s = new Phys.Sim(st, s.snapshot()); s.startDriving(); return s; };
  const track = (sim, secs, ctrl) => { let m = 0; const at = []; for (let t = 0; t < secs; t += H) { Object.assign(sim.controls, ctrl(sim)); sim.step(H); const sh = sim.item(0).st.shock; if (sim.driveTime > 0.6 && sh > m) { m = sh; } } return m; };
  console.log('gentle launch+cruise 3 m/s to x=30:', track(mk(), 6, (s) => ({ throttle: s.speed() < 3, brake: false })).toFixed(0));
  console.log('floor to x=25 then hard brake:', track(mk(), 6, (s) => s.chassis.getPosition().x < 25 ? { throttle: true, brake: false } : { throttle: false, brake: true }).toFixed(0));
  for (const v of [3, 5, 7, 9]) console.log(`bump at ${v} m/s:`, (() => { const s = mk(); let m = 0; for (let t = 0; t < 14 && s.chassis.getPosition().x < 30; t += H) { s.controls = { throttle: s.speed() < v, brake: false }; s.step(H); if (s.chassis.getPosition().x > 12) m = Math.max(m, s.item(0).st.shock); } return m.toFixed(0); })());
  for (const v of [2.5, 4, 6, 8.5]) console.log(`crest at ${v} m/s:`, (() => { const s = mk(); let m = 0; for (let t = 0; t < 30 && s.chassis.getPosition().x < 115; t += H) { s.controls = { throttle: s.speed() < v, brake: false }; s.step(H); if (s.chassis.getPosition().x > 50) m = Math.max(m, s.item(0).st.shock); } return m.toFixed(0); })());
}
if (scenario === 'catdbg') {
  const st = unitStage([{ type: 'cat' }, { type: 'box', box: 'L' }, { type: 'box', box: 'M' }]);
  let sim = new Phys.Sim(st, null);
  place(sim, 0, 0.6); place(sim, 1, 1.42); place(sim, 2, 1.42); sim.settle(1);
  sim = new Phys.Sim(st, sim.snapshot()); sim.startDriving();
  const j = sim.item(0).joints.arm;
  for (let t = 0; t < 5.2; t += H) { sim.controls = { throttle: false, brake: true }; sim.step(H); if (Math.abs(t - 4.2) < H / 2) dumpScene(sim, process.argv[3]); if (Math.round(t * 120) % 12 === 0 && t > 3.5) console.log(t.toFixed(2), 'arm', j.getJointAngle().toFixed(2), 'speed', j.getMotorSpeed().toFixed(2), 'motorOn', j.isMotorEnabled(), 'limit', j.isLimitEnabled(), j.getLowerLimit().toFixed(2), 'torque', j.getMotorTorque(120).toFixed(1), 'box x', sim.chassis.getLocalPoint(sim.item(1).bodies.root.getPosition()).x.toFixed(2)); }
  const arm = sim.item(0).bodies.arm; const p = arm.getPosition(); console.log('arm pos', p.x.toFixed(2), p.y.toFixed(2), 'cat', sim.item(0).bodies.root.getPosition().x.toFixed(2));
}
if (scenario === 'shockmap') {
  // max jolt felt by one item along the course, per cruise speed: where would a catch pop?
  const n = Number(process.argv[3] || 1), id = Number(process.argv[4] || 0);
  const st = STAGE(n);
  for (const v of [2, 3, 4, 5, 6, 8]) {
    const sim = loaded(st, st.recommended);
    sim.item(id).spec = Object.assign({}, sim.item(id).spec, { latchShock: 1e9, latchTilt: 1e9 }); // observe only
    const bins = {};
    const pol = (s) => ({ throttle: s.speed() < v, brake: s.speed() > v + 1.2 });
    while (sim.driveTime < 120 && sim.chassis.getPosition().x < sim.course.goalStart) {
      Object.assign(sim.controls, pol(sim));
      sim.step(H); sim.events.length = 0;
      const k = Math.floor(sim.chassis.getPosition().x / 20) * 20;
      bins[k] = Math.max(bins[k] || 0, sim.item(id).st.shock);
    }
    console.log(`v=${v}: ` + Object.entries(bins).map(([k, m]) => `${k}:${m.toFixed(0)}`).join(' '));
  }
}
if (scenario === 'air') {
  const n = Number(process.argv[3] || 2);
  const st = STAGE(n);
  for (const v of [1.5, 2.5, 3, 5, 7, 9]) {
    const sim = loaded(st, process.argv[4] === 'reco' ? st.recommended : { items: [], belts: [] });
    let air = 0, maxAir = 0, landV = 0, maxSpd = 0;
    const top = sim.course.marks.crestTop;
    while (sim.driveTime < 100 && sim.chassis.getPosition().x < top + 30) {
      sim.controls = { throttle: sim.speed() < v, brake: false };
      sim.step(H); sim.events.length = 0;
      const x = sim.chassis.getPosition().x;
      if (x > top - 20) maxSpd = Math.max(maxSpd, sim.speed());
      const touching = sim.wheels.some((w) => { for (let ce = w.getContactList(); ce; ce = ce.next) if (ce.contact.isTouching() && ce.other === sim.ground) return true; return false; });
      if (!touching && x > top - 5) { air += H; maxAir = Math.max(maxAir, air); landV = Math.min(landV, sim.chassis.getLinearVelocity().y); } else air = 0;
    }
    console.log(`v=${v}: reached x=${sim.chassis.getPosition().x.toFixed(1)} (top ${top.toFixed(1)}) t=${sim.driveTime.toFixed(0)} max airtime ${maxAir.toFixed(2)}s, min vy ${landV.toFixed(1)}, max speed near crest ${maxSpd.toFixed(1)}`);
  }
}
if (scenario === 'trace') {
  const n = Number(process.argv[3] || 2), v = Number(process.argv[4] || 4);
  const st = STAGE(n);
  const sim = loaded(st, st.recommended);
  const pol = careful(v);
  let last = 0;
  while (sim.driveTime < 60) {
    const x = sim.chassis.getPosition().x;
    const c = pol(sim, x);
    Object.assign(sim.controls, c);
    sim.step(H); sim.events.length = 0;
    if (sim.driveTime - last > 1 && x > 40) { last = sim.driveTime; console.log(`t=${sim.driveTime.toFixed(0)} x=${x.toFixed(2)} v=${sim.speed().toFixed(2)} thr=${c.throttle} brk=${c.brake} ang=${(sim.chassis.getAngle() * 57.3).toFixed(1)} wheelsW=${sim.wheels.map((w) => w.getAngularVelocity().toFixed(1))}`); }
  }
}
if (scenario === 'stuckdbg') {
  // what is touching the truck's wheels / frame when it stops?
  const n = Number(process.argv[3] || 3), v = Number(process.argv[4] || 7);
  const st = STAGE(n);
  const sim = loaded(st, st.recommended);
  while (sim.driveTime < 40) { sim.controls = { throttle: sim.speed() < v, brake: false }; sim.step(H); for (const e of sim.events.splice(0)) console.log('ev', e.type, e.id, sim.chassis.getPosition().x.toFixed(1)); }
  console.log('x', sim.chassis.getPosition().x.toFixed(2), 'ang', (sim.chassis.getAngle() * 57.3).toFixed(0));
  for (const b of [sim.chassis, ...sim.wheels]) for (let ce = b.getContactList(); ce; ce = ce.next) if (ce.contact.isTouching()) { const ud = ce.other.getUserData(); console.log(b.getUserData().kind, 'touches', ud.kind, ud.item ? ud.item.spec.name + ':' + ud.part : ''); }
  dumpScene(sim, process.argv[5]);
}
if (scenario === 'cranedbg') {
  const st = STAGE(3);
  const sim = loaded(st, st.recommended);
  const pol = careful(5, { waitCrane: true });
  let last = 0;
  while (sim.driveTime < 90) {
    const x = sim.chassis.getPosition().x;
    Object.assign(sim.controls, pol(sim, x));
    sim.step(H); sim.events.length = 0;
    if (sim.driveTime - last > 1 && x > 170) {
      last = sim.driveTime;
      const cr = sim.crane, b = sim.bonusItem.bodies.root;
      const lug = b.getWorldPoint(sim.bonusItem.spec.lug), hp = cr.hook.getPosition();
      const bed = sim.chassis.getWorldPoint(pl.Vec2(Phys.BED.center, 0)).x;
      if (Math.round(sim.driveTime) === 56 && process.argv[3]) dumpScene(sim, process.argv[3]);
      console.log(`t=${sim.driveTime.toFixed(0)} x=${x.toFixed(2)} bed=${bed.toFixed(2)} crane=${cr.x.toFixed(2)} v=${sim.speed().toFixed(2)} state=${cr.state} hookY=${(hp.y - sim.groundY(cr.x)).toFixed(2)} ropeDist=${pl.Vec2.distance(lug, hp).toFixed(3)} slackT=${cr.slackT.toFixed(2)}`);
    }
  }
}
