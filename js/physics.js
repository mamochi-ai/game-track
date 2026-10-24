// Physics model built on Planck.js (a Box2D port). No DOM access here so tools/sim.js can run it
// headless in Node for tuning and regression checks.
(function (root) {
  'use strict';
  const pl = root.planck;
  const C = root.CONFIG;
  const OUT = root.OUTLINES;
  const Vec2 = pl.Vec2;

  const TS = C.truck.spritePxPerM;
  const TRUCK_PX = { w: 752, h: 327 };
  const MAG_PX = { w: 749, h: 339 };
  // truck sprite px -> chassis-local meters (origin = sprite centre, y up)
  const tpx = (px, py) => Vec2((px - TRUCK_PX.w / 2) / TS, (TRUCK_PX.h / 2 - py) / TS);

  const SHOCK_STEPS = 6; // 50 ms window at 120 Hz

  // collision categories
  const CAT = { ANY: 0x0001, DOOR: 0x0002, MELON: 0x0004, PAD: 0x0008 };

  const HOOKS = [
    { px: 22, py: 262, name: '後部フック' },
    { px: 40, py: 182, name: '荷台・後' },
    { px: 200, py: 182, name: '荷台・中' },
    { px: 360, py: 182, name: '荷台・前' },
    { px: 491, py: 14, name: '鳥居の上' },
  ].map((h) => Object.assign(h, { local: tpx(h.px, h.py) }));

  const BED = { rear: tpx(10, 178).x, front: tpx(478, 178).x, floorY: tpx(0, 178).y };
  BED.center = (BED.rear + BED.front) / 2;

  // ---------------------------------------------------------------- course
  function buildCourse(stage) {
    const pts = [];
    const marks = {};
    const signs = [];
    let x = -12, y = 0;
    const add = (px, py) => pts.push(Vec2(px, py));
    add(x, 8);
    add(x, 0);
    const smooth = (t) => t * t * (3 - 2 * t);
    const course = { goalStart: 0, goalEnd: 0, wallEndX: 0 };
    for (const seg of stage.course) {
      const [kind, a, b, c] = seg;
      if (kind === 'flat') { x += a; add(x, y); }
      else if (kind === 'bump') {
        const x0 = x;
        for (let i = 1; i < 12; i++) add(x0 + (b * i) / 12, y + a * 0.5 * (1 - Math.cos((2 * Math.PI * i) / 12)));
        x += b; add(x, y);
      } else if (kind === 'step') { x += b; y += a; add(x, y); }
      else if (kind === 'slope') {
        const x0 = x, y0 = y;
        for (let d = 1.5; d < b; d += 1.5) add(x0 + d, y0 + a * smooth(d / b));
        x += b; y += a; add(x, y);
      } else if (kind === 'crest') {
        // climb that keeps steepening up to a sharp top, then a straight drop onto the flat:
        // slow trucks roll over it, fast trucks fly and land hard at the bottom
        const x0 = x, y0 = y, up = b, down = c;
        for (let d = 1.0; d < up; d += 1.0) add(x0 + d, y0 + a * (d / up) ** 1.15);
        const top = x0 + up;
        // round the very top (about 3 m radius) so the frame clears it; above ~5.5 m/s you still fly
        const s1 = (1.15 * a) / up, s2 = -a / down;
        const L = Math.max(0.3, 3.0 * Math.abs(Math.atan(s1) - Math.atan(s2)) / 2);
        const P1 = { x: top - L, y: y0 + a - s1 * L }, P2 = { x: top + L, y: y0 + a + s2 * L };
        pts.pop(); // drop the climb sample that the arc replaces
        for (let i = 0; i <= 6; i++) {
          const t = i / 6, u = 1 - t;
          add(u * u * P1.x + 2 * u * t * top + t * t * P2.x, u * u * P1.y + 2 * u * t * (y0 + a) + t * t * P2.y);
        }
        const fillet = Math.min(1.5, down * 0.25);
        add(top + down - fillet, y0 + a * (fillet / down) * 0.5);
        add(top + down - fillet / 2, y0 + a * (fillet / down) * 0.12);
        x = top + down; y = y0; add(x, y);
        marks.crestTop = top;
      } else if (kind === 'sign') signs.push({ x, kind: a, lines: b || [] });
      else if (kind === 'mark') marks[a] = x;
      else if (kind === 'goal') {
        course.goalStart = x;
        x += a;
        course.goalEnd = x - 1.0;
        course.wallEndX = x;
        add(x, y);
        add(x, y + 6);
      }
    }
    course.pts = pts;
    course.road = pts.slice(1, -1);
    course.marks = marks;
    course.signs = signs;
    course.length = course.wallEndX;
    const road = course.road;
    course.groundY = function (px) {
      if (px <= road[0].x) return road[0].y;
      let lo = 0, hi = road.length - 1;
      if (px >= road[hi].x) return road[hi].y;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (road[m].x <= px) lo = m; else hi = m; }
      const p = road[lo], q = road[hi];
      const t = q.x - p.x < 1e-6 ? 1 : (px - p.x) / (q.x - p.x);
      return p.y + (q.y - p.y) * t;
    };
    return course;
  }

  // ---------------------------------------------------------------- geometry helpers
  function polyArea(v) {
    let a = 0;
    for (let i = 0; i < v.length; i++) {
      const p = v[i], q = v[(i + 1) % v.length];
      a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) / 2;
  }
  // traced outline of a sprite drawn in a w x h box centred at (ox, oy)
  function outlineParts(sprite, w, h, ox, oy) {
    const o = OUT[sprite];
    ox = ox || 0; oy = oy || 0;
    if (o.circle) {
      const r = o.circle.r * w;
      return [{ circle: true, c: Vec2(ox + o.circle.x * w, oy - o.circle.y * h), r, area: Math.PI * r * r }];
    }
    return o.parts.map((p) => {
      const verts = p.map(([nx, ny]) => Vec2(ox + nx * w, oy - ny * h));
      return { verts, area: polyArea(verts) };
    });
  }
  function rectPart(x0, y0, x1, y1) {
    const verts = [Vec2(x0, y0), Vec2(x1, y0), Vec2(x1, y1), Vec2(x0, y1)];
    return { verts, area: Math.abs((x1 - x0) * (y1 - y0)) };
  }
  function shapeOf(p) {
    if (!p.shape) p.shape = p.circle ? new pl.Circle(p.c, p.r) : new pl.Polygon(p.verts);
    return p.shape;
  }
  function withDensity(parts, mass, mults) {
    const weighted = parts.reduce((s, p, i) => s + p.area * ((mults && mults[i]) || 1), 0);
    parts.forEach((p, i) => (p.density = (mass * ((mults && mults[i]) || 1)) / weighted));
    return parts;
  }

  // ---------------------------------------------------------------- cargo specs
  // Each spec carries its default part layout in item-local meters (origin = main sprite centre).
  function buildSpec(entry, id) {
    const t = C.cargoTypes[entry.type];
    const box = entry.box ? C.boxSizes[entry.box] : null;
    const spec = Object.assign({}, t, { id, typeKey: entry.type });
    spec.size = (box && box.size) || entry.size || t.size;
    spec.mass = (box && box.mass) || entry.mass || t.mass;
    const [w, h] = spec.size;
    spec.draw = {};       // body name -> [{sprite, x, y, w, h}]
    spec.bodies = {};     // body name -> {parts, offset:{x,y}}  (offset = body origin in item frame)
    spec.joints = [];
    spec.units = [];      // scoring units

    if (spec.kind === 'simple' || spec.kind === 'fragile') {
      spec.bodies.root = { parts: withDensity(outlineParts(t.sprite, w, h), spec.mass, t.partDensity) };
      spec.draw.root = [{ sprite: t.sprite, x: 0, y: 0, w, h }];
      spec.outer = outlineParts(t.sprite, w, h);
      spec.units.push({ key: 'main', name: spec.name, value: spec.value, body: 'root', bonus: !!t.bonus });
      if (t.bonus) {
        const s = w / OUT[t.sprite].w;
        spec.lug = Vec2((205 - OUT[t.sprite].w / 2) * s, (OUT[t.sprite].h / 2 - 18) * s);
      }
    } else if (spec.kind === 'shelf') {
      const s = w / OUT.shelf.w;
      const parts = outlineParts('shelf', w, h);
      const casters = [40, 252].map((px) => {
        const r = 16 * s;
        return { circle: true, c: Vec2((px - OUT.shelf.w / 2) * s, (OUT.shelf.h / 2 - 262) * s), r, area: Math.PI * r * r, friction: t.casterFriction };
      });
      spec.bodies.root = { parts: withDensity(parts.concat(casters), spec.mass) };
      spec.draw.root = [{ sprite: 'shelf', x: 0, y: 0, w, h }];
      spec.outer = outlineParts('shelf', w, h).concat(casters.map((p) => Object.assign({}, p, { shape: null })));
      spec.units.push({ key: 'main', name: spec.name, value: spec.value, body: 'root' });
    } else if (spec.kind === 'fridge') {
      const SW = OUT.fridge_body.w, SH = OUT.fridge_body.h;
      const s = h / SH;
      const fx = (px) => (px - SW / 2) * s, fy = (py) => (SH / 2 - py) * s;
      const R = (x0, y0, x1, y1) => rectPart(fx(x0), fy(y1), fx(x1), fy(y0));
      const walls = [R(5, 5, 30, 378), R(5, 5, 258, 22), R(5, 140, 258, 158), R(5, 340, 258, 378), R(15, 378, 45, 391), R(215, 378, 250, 391)];
      const latches = [R(238, 22, 258, 140), R(238, 158, 258, 340)];
      latches.forEach((p) => (p.latch = true));
      spec.bodies.root = { parts: withDensity(walls.concat(latches), spec.mass) };
      spec.draw.root = [{ sprite: 'fridge_body', x: 0, y: 0, w: SW * s, h: SH * s }];
      const doors = [
        { sprite: 'fridge_door_top', cx: 123, cy: 81.5, hinge: [245, 158] },
        { sprite: 'fridge_door_bottom', cx: 126.5, cy: 282, hinge: [245, 380] },
      ];
      doors.forEach((d, i) => {
        const dw = OUT[d.sprite].w * s, dh = OUT[d.sprite].h * s;
        const name = 'door' + i;
        spec.bodies[name] = { offset: Vec2(fx(d.cx), fy(d.cy)), parts: withDensity(outlineParts(d.sprite, dw, dh), t.doorMass), door: true };
        spec.draw[name] = [{ sprite: d.sprite, x: 0, y: 0, w: dw, h: dh }];
        spec.joints.push({ name, a: 'root', b: name, anchor: Vec2(fx(d.hinge[0]), fy(d.hinge[1])), lower: 0, upper: 0 });
      });
      const r = 0.135;
      [[78, 292], [174, 292], [100, 92]].slice(0, t.melons).forEach(([px, py], i) => {
        const name = 'melon' + i;
        const p = { circle: true, c: Vec2(0, 0), r, area: Math.PI * r * r, friction: t.melonFriction, restitution: t.melonRestitution };
        spec.bodies[name] = { offset: Vec2(fx(px), fy(py)), parts: withDensity([p], t.melonMass), melon: true };
        spec.draw[name] = [{ sprite: 'watermelon', x: 0, y: 0, w: 2.08 * r, h: 2.08 * r }];
        spec.units.push({ key: name, name: 'スイカ', value: t.melonValue, body: name, inner: true });
      });
      spec.outer = outlineParts('fridge_body', SW * s, SH * s);
      spec.units.unshift({ key: 'main', name: spec.name, value: spec.value, body: 'root' });
    } else if (spec.kind === 'sofabed') {
      const s = w / OUT.sofa.w;
      const armTop = (126 - 65) * s;
      const [cw, chh] = t.cushionSize;
      spec.bodies.root = { parts: withDensity(outlineParts('sofa', w, h), spec.mass) };
      spec.draw.root = [{ sprite: 'sofa', x: 0, y: 0, w, h }];
      spec.bodies.cushion = { offset: Vec2(w / 2 - cw / 2, armTop + chh / 2), parts: withDensity(outlineParts('sofa_cushion', cw, chh), t.cushionMass) };
      spec.draw.cushion = [{ sprite: 'sofa_cushion', x: 0, y: 0, w: cw, h: chh }];
      spec.joints.push({ name: 'cushion', a: 'root', b: 'cushion', anchor: Vec2(w / 2, armTop), lower: 0, upper: 0 });
      spec.outer = outlineParts('sofa', w, h).concat(outlineParts('sofa_cushion', cw, chh, w / 2 - cw / 2, armTop + chh / 2));
      spec.units.push({ key: 'main', name: spec.name, value: spec.value, body: 'root' });
    } else if (spec.kind === 'cat') {
      const SW = OUT.cat_body.w, SH = OUT.cat_body.h;
      const s = h / SH;
      const cx = (px) => (px - SW / 2) * s, cy = (py) => (SH / 2 - py) * s;
      spec.bodies.root = { parts: withDensity(outlineParts('cat_body', SW * s, SH * s), spec.mass, t.partDensity) };
      spec.draw.root = [{ sprite: 'cat_body', x: 0, y: 0, w: SW * s, h: SH * s }];
      const aw = OUT.cat_arm.w * s, ah = OUT.cat_arm.h * s;
      spec.bodies.arm = { offset: Vec2(cx(193 + OUT.cat_arm.w / 2), cy(51 + OUT.cat_arm.h / 2)), parts: withDensity(outlineParts('cat_arm', aw, ah), t.armMass) };
      spec.draw.arm = [{ sprite: 'cat_arm', x: 0, y: 0, w: aw, h: ah }];
      spec.joints.push({ name: 'arm', a: 'root', b: 'arm', anchor: Vec2(cx(240), cy(186)), lower: t.swingAngle - 0.2, upper: 0.15, motor: true });
      spec.outer = outlineParts('cat_body', SW * s, SH * s).concat(outlineParts('cat_arm', aw, ah, cx(193 + OUT.cat_arm.w / 2), cy(51 + OUT.cat_arm.h / 2)));
      spec.units.push({ key: 'main', name: spec.name, value: spec.value, body: 'root' });
    } else if (spec.kind === 'robotbox') {
      const th = 0.035, hw = w / 2, hh = h / 2;
      const left = rectPart(-hw, -hh, -hw + th, hh);
      const front = rectPart(hw - th, -hh, hw, hh);
      const bottom = rectPart(-hw, -hh, hw, -hh + th);
      const lid = rectPart(-hw, hh - th, hw, hh);
      front.openRemove = true;
      lid.openRemove = true;
      left.openShrink = true;
      spec.bodies.root = { parts: withDensity([left, front, bottom, lid], spec.mass) };
      spec.draw.root = [{ sprite: 'box', x: 0, y: 0, w, h }];
      const [rw, rh] = t.robotSize;
      const rs = rw / OUT.robot.w;
      spec.bodies.robot = { offset: Vec2(-0.03, -hh + th + rh / 2 + 0.004), parts: withDensity(outlineParts('robot', rw, OUT.robot.h * rs), t.robotMass), robot: true };
      spec.draw.robot = [{ sprite: 'robot', x: 0, y: 0, w: rw, h: OUT.robot.h * rs }];
      spec.outer = outlineParts('box', w, h);
      spec.units.push({ key: 'main', name: 'お掃除ロボット', value: spec.value, body: 'robot' });
    }
    spec.outer.forEach(shapeOf);
    spec.radius = Math.hypot(w, h) / 2 + (spec.kind === 'sofabed' ? 0.4 : 0.05);
    return spec;
  }

  function buildSpecs(stage) {
    const specs = stage.manifest.map((e, i) => buildSpec(e, i));
    const bonus = stage.bonus ? buildSpec(stage.bonus, specs.length) : null;
    return { specs, bonus };
  }

  // ---------------------------------------------------------------- simulation
  class Sim {
    // stage: entry of CONFIG.stages; snapshot: null for a fresh truck, or the object from snapshot()
    constructor(stage, snapshot) {
      this.stage = stage;
      this.course = buildCourse(stage);
      this.groundY = this.course.groundY;
      const { specs, bonus } = buildSpecs(stage);
      this.specs = specs;
      this.world = new pl.World({ gravity: Vec2(0, C.physics.gravity) });
      this.time = 0;
      this.driveTime = 0;
      this.items = specs.map((s) => this.newItem(s));
      this.bonusItem = bonus ? this.newItem(bonus) : null;
      this.belts = [];
      this.controls = { throttle: false, brake: true };
      this.throttle = 0;
      this.phase = 'loading';
      this.onImpact = null;
      this.events = [];
      this.buildGround();
      if (snapshot) {
        this.buildTruck(snapshot.truck);
        snapshot.cargo.forEach((c) => this.placeItem(c.id, c.bodies.root, c.bodies));
        snapshot.belts.forEach((b) => this.addBelt(b.hook, b.id, b.part, Vec2(b.lx, b.ly), b.rest));
      } else {
        this.buildTruck(null);
        this.settle(1.2);
      }
      this.setupEvents();
      this.world.on('post-solve', (contact, impulse) => {
        const n = impulse.normalImpulses;
        const j = (n[0] || 0) + (n[1] || 0);
        if (j < 18) return;
        const ua = contact.getFixtureA().getBody().getUserData();
        const ub = contact.getFixtureB().getBody().getUserData();
        const it = ua.kind === 'cargo' ? ua.item : ub.kind === 'cargo' ? ub.item : null;
        if (it && this.onImpact) this.onImpact(j, it, ua.kind === 'cargo' ? ua.part : ub.part);
      });
    }

    newItem(spec) {
      return { id: spec.id, spec, bodies: null, joints: {}, st: {}, fallen: false };
    }

    emit(type, data) { this.events.push(Object.assign({ type, t: this.driveTime }, data)); }

    buildGround() {
      const g = this.world.createBody({ type: 'static' });
      g.setUserData({ kind: 'ground' });
      g.createFixture({ shape: new pl.Chain(this.course.pts, false), friction: 0.9, restitution: 0.05 });
      this.ground = g;
    }

    buildTruck(state) {
      const T = C.truck;
      const w = this.world;
      let pos, angle;
      if (state) {
        pos = Vec2(state.chassis.x, state.chassis.y);
        angle = state.chassis.a;
      } else {
        const anchorLocalY = tpx(0, T.wheelRestYpx).y - T.suspensionPreloadM;
        pos = Vec2(T.startX, this.groundY(T.startX) + T.wheelRadius - anchorLocalY + 0.01);
        angle = 0;
      }
      const ch = w.createBody({ type: 'dynamic', position: pos, angle, angularDamping: 0.1 });
      ch.setUserData({ kind: 'chassis' });
      ch.setSleepingAllowed(false);
      const boxPx = (x0, y0, x1, y1) => {
        const a = tpx(x0, y0), b = tpx(x1, y1);
        return { shape: new pl.Box((b.x - a.x) / 2, (a.y - b.y) / 2, Vec2((a.x + b.x) / 2, (a.y + b.y) / 2), 0), area: (b.x - a.x) * (a.y - b.y) };
      };
      const frame = boxPx(15, 178, 745, 300);
      ch.createFixture({ shape: frame.shape, density: T.frameMass / frame.area, friction: T.friction });
      const cabVerts = [[505, 16], [640, 20], [700, 85], [745, 160], [745, 178], [505, 178]].map(([x, y]) => tpx(x, y));
      const head = boxPx(478, 6, 505, 178);
      const lip = boxPx(10, 162, 30, 178);
      const cabD = T.cabMass / (polyArea(cabVerts) + head.area + lip.area);
      ch.createFixture({ shape: new pl.Polygon(cabVerts), density: cabD, friction: 0.4 });
      ch.createFixture({ shape: head.shape, density: cabD, friction: 0.5 });
      ch.createFixture({ shape: lip.shape, density: cabD, friction: 0.5 });
      this.chassis = ch;

      const mTotal = T.frameMass + T.cabMass;
      const mEff = 1 / (1 / mTotal + 1 / T.wheelMass);
      const omega = Math.sqrt(T.suspensionK / mEff);
      const hz = omega / (2 * Math.PI);
      const zeta = T.suspensionDampingNs / (2 * mEff * omega);

      this.wheels = [];
      this.wheelJoints = [];
      [T.rearWheelXpx, T.frontWheelXpx].forEach((xpx, i) => {
        const anchorLocal = tpx(xpx, T.wheelRestYpx);
        anchorLocal.y -= T.suspensionPreloadM;
        const ws = state && state.wheels[i];
        const wp = ws ? Vec2(ws.x, ws.y) : ch.getWorldPoint(anchorLocal);
        const wheel = w.createBody({ type: 'dynamic', position: wp, angle: ws ? ws.a : 0, angularDamping: 0.05 });
        wheel.setUserData({ kind: 'wheel' });
        wheel.setSleepingAllowed(false);
        const r = T.wheelRadius;
        wheel.createFixture({ shape: new pl.Circle(r), density: T.wheelMass / (Math.PI * r * r), friction: T.wheelFriction, restitution: 0.1 });
        const j = w.createJoint(new pl.WheelJoint({
          bodyA: ch, bodyB: wheel, localAnchorA: anchorLocal, localAnchorB: Vec2(0, 0), localAxisA: Vec2(0, 1),
          enableMotor: true, motorSpeed: 0, maxMotorTorque: T.brakeTorque, frequencyHz: hz, dampingRatio: zeta,
        }));
        w.createJoint(new pl.RopeJoint({
          bodyA: ch, bodyB: wheel, localAnchorA: anchorLocal, localAnchorB: Vec2(0, 0), maxLength: T.suspensionTravelM,
        }));
        this.wheels.push(wheel);
        this.wheelJoints.push(j);
      });
    }

    settle(seconds) {
      const h = 1 / C.physics.hz;
      for (let t = 0; t < seconds; t += h) this.step(h);
    }

    // ------------------------------------------------------------ cargo
    item(id) { return this.bonusItem && id === this.bonusItem.id ? this.bonusItem : this.items[id]; }
    allItems() { return this.bonusItem ? this.items.concat([this.bonusItem]) : this.items; }

    // pose: root {x,y,a}; poses: optional saved world pose per body name
    placeItem(id, pose, poses) {
      const it = this.item(id);
      if (it.bodies) this.removeItem(id);
      const s = it.spec;
      const group = -(id + 1);
      const c = Math.cos(pose.a), sn = Math.sin(pose.a);
      const toWorld = (o) => Vec2(pose.x + o.x * c - o.y * sn, pose.y + o.x * sn + o.y * c);
      it.bodies = {};
      for (const [name, def] of Object.entries(s.bodies)) {
        const saved = poses && poses[name];
        const off = def.offset || Vec2(0, 0);
        const p = saved ? Vec2(saved.x, saved.y) : toWorld(off);
        const body = this.world.createBody({
          type: 'dynamic', position: p, angle: saved ? saved.a : pose.a,
          angularDamping: def.melon ? 0.3 : 0.08, linearDamping: 0.02, bullet: !!(def.melon || s.typeKey === 'tire' || s.typeKey === 'ball' || s.typeKey === 'bowling'),
        });
        body.setUserData({ kind: 'cargo', item: it, part: name });
        def.parts.forEach((pt, i) => {
          const filter = { groupIndex: 0, filterCategoryBits: CAT.ANY, filterMaskBits: 0xffff };
          if (def.door) { filter.groupIndex = group; filter.filterCategoryBits = CAT.DOOR; filter.filterMaskBits = 0xffff & ~CAT.MELON; }
          else if (def.melon) { filter.filterCategoryBits = CAT.MELON; filter.filterMaskBits = 0xffff & ~CAT.DOOR; }
          else if (s.kind === 'fridge' || s.kind === 'sofabed' || s.kind === 'cat') filter.groupIndex = group;
          const fx = body.createFixture(Object.assign({
            shape: shapeOf(pt), density: pt.density,
            friction: pt.friction != null ? pt.friction : s.friction,
            restitution: pt.restitution != null ? pt.restitution : s.restitution,
          }, filter));
          fx.setUserData({ index: i, latch: pt.latch, openRemove: pt.openRemove, openShrink: pt.openShrink });
        });
        it.bodies[name] = body;
      }
      it.joints = {};
      for (const j of s.joints) {
        const A = it.bodies[j.a], B = it.bodies[j.b];
        const offB = s.bodies[j.b].offset || Vec2(0, 0);
        const joint = this.world.createJoint(new pl.RevoluteJoint({
          bodyA: A, bodyB: B, localAnchorA: j.anchor, localAnchorB: Vec2(j.anchor.x - offB.x, j.anchor.y - offB.y),
          referenceAngle: 0, enableLimit: true, lowerAngle: j.lower, upperAngle: j.upper,
          enableMotor: !!j.motor, motorSpeed: 0, maxMotorTorque: j.motor ? s.armTorque : 0,
        }));
        it.joints[j.name] = joint;
      }
      it.st = { angle0: pose.a, latched: true, open: false, shock: 0, maxShock: 0 };
      it.fallen = false;
      return it;
    }

    removeItem(id) {
      const it = this.item(id);
      if (!it.bodies) return;
      for (let i = this.belts.length - 1; i >= 0; i--) if (this.belts[i].id === id) this.removeBelt(i);
      for (const b of Object.values(it.bodies)) this.world.destroyBody(b);
      it.bodies = null;
      it.joints = {};
      it.fallen = false;
    }

    root(it) { return it.bodies && it.bodies.root; }

    // true when the item's outer silhouette at this pose would intersect anything in the world
    overlaps(id, x, y, a) {
      const it = this.item(id);
      const xf = new pl.Transform(Vec2(x, y), a);
      const r = it.spec.radius + 0.05;
      let hit = false;
      const own = it.bodies ? new Set(Object.values(it.bodies)) : null;
      const aabb = new pl.AABB(Vec2(x - r, y - r), Vec2(x + r, y + r));
      this.world.queryAABB(aabb, (f) => {
        const b = f.getBody();
        if (own && own.has(b)) return true;
        const ud = b.getUserData();
        if (ud.kind === 'pad' || ud.kind === 'hook') return true;
        const fs = f.getShape();
        const bx = b.getTransform();
        for (const p of it.spec.outer) {
          for (let c = 0; c < fs.getChildCount(); c++) {
            if (pl.testOverlap(p.shape, 0, fs, c, xf, bx)) { hit = true; return false; }
          }
        }
        return true;
      });
      if (!hit) {
        // entirely under the road surface also counts as blocked
        if (y < this.groundY(x)) hit = true;
      }
      return hit;
    }

    dropHeight(id, x, a, fromY) {
      let y = fromY != null ? fromY : this.groundY(x) + 12;
      if (this.overlaps(id, x, y, a)) return null;
      const lo = this.groundY(x) - 1;
      const step = 0.05;
      while (y - step > lo && !this.overlaps(id, x, y - step, a)) y -= step;
      let free = y, blocked = y - step;
      for (let i = 0; i < 6; i++) {
        const m = (free + blocked) / 2;
        if (this.overlaps(id, x, m, a)) blocked = m; else free = m;
      }
      return free + 0.004;
    }

    // ------------------------------------------------------------ belts
    hookWorld(i) { return this.chassis.getWorldPoint(HOOKS[i].local); }

    addBelt(hook, id, part, localPt, rest) {
      const it = this.item(id);
      const body = it.bodies && it.bodies[part];
      if (!body || this.belts.length >= C.belt.count) return null;
      if (this.belts.some((b) => b.hook === hook && b.id === id && b.part === part)) return null;
      const pa = this.hookWorld(hook);
      const pb = body.getWorldPoint(localPt);
      const dist = Vec2.distance(pa, pb);
      if (dist > C.belt.maxLength || dist < 0.05) return null;
      const restLen = rest != null ? rest : dist * (1 - C.belt.pretension);
      const rope = this.world.createJoint(new pl.RopeJoint({
        bodyA: this.chassis, bodyB: body, localAnchorA: HOOKS[hook].local, localAnchorB: localPt,
        maxLength: Math.max(dist, restLen * (1 + C.belt.hardStretch)), collideConnected: true,
      }));
      const belt = { hook, id, part, local: Vec2(localPt.x, localPt.y), rest: restLen, rope, tension: 0, stretch: 0 };
      this.belts.push(belt);
      return belt;
    }

    removeBelt(i) {
      const b = this.belts[i];
      if (!b) return;
      this.world.destroyJoint(b.rope);
      this.belts.splice(i, 1);
    }

    beltBody(b) { const it = this.item(b.id); return it.bodies && it.bodies[b.part]; }

    applyBelts(h) {
      const B = C.belt;
      for (const b of this.belts) {
        const body = this.beltBody(b);
        if (!body || !body.isActive()) { b.tension = 0; continue; }
        const pa = this.hookWorld(b.hook);
        const pb = body.getWorldPoint(b.local);
        const d = Vec2.sub(pb, pa);
        const L = d.length();
        b.stretch = (L - b.rest) / b.rest;
        let F = 0;
        if (L > b.rest && L > 1e-4) {
          const n = Vec2.mul(d, 1 / L);
          const vrel = Vec2.dot(Vec2.sub(body.getLinearVelocityFromWorldPoint(pb), this.chassis.getLinearVelocityFromWorldPoint(pa)), n);
          const c = Math.min(B.damping, (0.4 * body.getMass()) / h);
          F = Math.max(0, Math.min(B.maxForce, B.stiffness * (L - b.rest) + c * vrel));
          body.applyForce(Vec2.mul(n, -F), pb, true);
          this.chassis.applyForce(Vec2.mul(n, F), pa, true);
        }
        let ropeF = 0;
        if (b.ready) ropeF = b.rope.getReactionForce(1 / h).length();
        b.tension = F + ropeF * 0.5;
      }
    }

    // ------------------------------------------------------------ special cargo behaviour
    updateCargo(h) {
      const driving = this.phase === 'driving';
      const armed = driving && this.driveTime > 0.6;
      for (const it of this.allItems()) {
        if (!it.bodies) continue;
        const s = it.spec, st = it.st, rb = it.bodies.root;
        // jolt felt by the item (m/s^2): velocity change over a short window, so single-step
        // contact jitter does not count as an impact
        const v = rb.getLinearVelocity();
        const hist = st.vHist || (st.vHist = []);
        hist.push(Vec2(v.x, v.y));
        if (hist.length > SHOCK_STEPS) {
          const o = hist.shift();
          st.shock = Math.hypot(v.x - o.x, v.y - o.y) / (SHOCK_STEPS * h);
        }
        if (armed) st.maxShock = Math.max(st.maxShock, st.shock);
        if (s.kind === 'fridge') this.updateFridge(it, armed);
        else if (s.kind === 'sofabed') this.updateSofa(it, armed);
        else if (s.kind === 'cat') this.updateCat(it, driving);
        else if (s.kind === 'robotbox') this.updateRobot(it, armed, h);
        else if (s.kind === 'fragile') this.updateFragile(it, driving, h);
      }
    }

    updateFridge(it, armed) {
      const s = it.spec, st = it.st, rb = it.bodies.root;
      if (st.latched && armed && !it.fallen) {
        const tilt = Math.abs(rb.getAngle() - st.angle0);
        if (st.shock > s.latchShock || tilt > s.latchTilt) {
          st.latched = false;
          st.popT = 0.9;
          for (const k of ['door0', 'door1']) {
            const j = it.joints[k];
            j.setLimits(s.doorOpen, 0);
            j.enableMotor(true);
            j.setMotorSpeed(-2);
            j.setMaxMotorTorque(s.doorPop);
          }
          this.emit('fridge-open', { id: it.id, cause: tilt > s.latchTilt ? 'tilt' : 'shock' });
        }
      }
      if (!st.latched) {
        if (st.popT > 0) {
          st.popT -= 1 / C.physics.hz;
          if (st.popT <= 0) for (const k of ['door0', 'door1']) { it.joints[k].setMotorSpeed(0); it.joints[k].setMaxMotorTorque(0.4); }
        }
        // the catch spring keeps pushing for a moment; anything in front of the door can hold it shut
        // a door that actually swung open frees its compartment
        ['door0', 'door1'].forEach((k, i) => {
          if (st['free' + i]) return;
          if (it.joints[k].getJointAngle() < -0.45) {
            for (let f = rb.getFixtureList(); f; f = f.getNext()) {
              const ud = f.getUserData();
              if (ud && ud.latch && ud.index === 6 + i) { rb.destroyFixture(f); break; }
            }
            st['free' + i] = true;
            this.emit('melon-free', { id: it.id });
          }
        });
      }
    }

    updateSofa(it, armed) {
      const s = it.spec, st = it.st, j = it.joints.cushion;
      if (st.latched && armed && !it.fallen && st.shock > s.latchShock) {
        st.latched = false;
        j.setLimits(-Math.PI, 0);
        j.enableMotor(true);
        j.setMotorSpeed(-s.unfoldSpeed);
        j.setMaxMotorTorque(s.unfoldTorque);
        this.emit('sofa-open', { id: it.id });
      }
      if (!st.latched && !st.open && j.getJointAngle() < -Math.PI + 0.12) {
        st.open = true;
        j.setMotorSpeed(0);
        j.setMaxMotorTorque(s.unfoldTorque * 0.5);
      }
    }

    updateCat(it, driving) {
      const s = it.spec, st = it.st, j = it.joints.arm;
      let target = 0;
      st.shake = false;
      if (driving && !it.fallen) {
        const phase = this.driveTime % s.period;
        const cycle = Math.floor(this.driveTime / s.period);
        if (phase >= s.swingAt && phase < s.returnAt) target = s.swingAngle;
        if (phase >= s.warnAt && phase < s.swingAt) {
          st.shake = true;
          if (st.bellCycle !== cycle) { st.bellCycle = cycle; this.emit('cat-bell', { id: it.id }); }
        }
        if (phase >= s.swingAt && st.swingCycle !== cycle) { st.swingCycle = cycle; this.emit('cat-swing', { id: it.id }); }
      }
      // position servo with limited speed and torque: a blocked arm just stalls
      const err = target - j.getJointAngle();
      j.setMotorSpeed(Math.max(-s.armSpeed, Math.min(s.armSpeed, err * 10)));
      j.setMaxMotorTorque(s.armTorque);
    }

    updateRobot(it, armed, h) {
      const s = it.spec, st = it.st, rb = it.bodies.root, robot = it.bodies.robot;
      if (!st.open && armed && !it.fallen && st.shock > s.openShock) {
        st.open = true;
        st.dir = 1;
        st.stall = 0;
        st.turnCool = 0;
        const remove = [];
        let shrink = null;
        for (let f = rb.getFixtureList(); f; f = f.getNext()) {
          const ud = f.getUserData();
          if (ud && ud.openRemove) remove.push(f);
          if (ud && ud.openShrink) shrink = f;
        }
        remove.forEach((f) => rb.destroyFixture(f));
        if (shrink) {
          // the back wall tears down to the height of the opened box
          const [w, hh] = s.size;
          const d = shrink.getDensity();
          rb.destroyFixture(shrink);
          rb.createFixture({ shape: new pl.Polygon([Vec2(-w / 2, -hh / 2), Vec2(-w / 2 + 0.035, -hh / 2), Vec2(-w / 2 + 0.035, -hh / 2 + 0.34), Vec2(-w / 2, -hh / 2 + 0.34)]), density: d, friction: s.friction });
        }
        this.emit('robot-on', { id: it.id });
      }
      if (!st.open || !robot.isActive()) return;
      if (robot.getUserData().fallen) {
        st.offT = (st.offT || 0) + h;
        if (st.offT > 2) return; // left on the road: it gives up
      }
      // grounded: touching something below it
      let grounded = false;
      let wallHit = false;
      for (let ce = robot.getContactList(); ce; ce = ce.next) {
        const ct = ce.contact;
        if (!ct.isTouching()) continue;
        const wm = ct.getWorldManifold(null);
        if (!wm) continue;
        const n = wm.normal;
        const sign = ct.getFixtureA().getBody() === robot ? -1 : 1; // normal pointing into the robot
        const ny = n.y * sign, nx = n.x * sign;
        if (ny > 0.5) grounded = true;
        const ax = Math.cos(robot.getAngle()) * st.dir;
        if (nx * ax < -0.7) wallHit = true;
      }
      st.turnCool = Math.max(0, st.turnCool - h);
      if (!grounded) return;
      const fwd = Vec2(Math.cos(robot.getAngle()) * st.dir, Math.sin(robot.getAngle()) * st.dir);
      const base = this.chassis.getLinearVelocity();
      const rel = Vec2.dot(Vec2.sub(robot.getLinearVelocity(), base), fwd);
      if (rel < s.maxSpeed) robot.applyForceToCenter(Vec2.mul(fwd, s.driveForce), true);
      st.stall = rel < 0.05 ? st.stall + h : 0;
      if ((wallHit && st.stall > 0.15 || st.stall > s.turnStall) && st.turnCool <= 0) {
        st.dir = -st.dir;
        st.stall = 0;
        st.turnCool = 0.8;
        this.emit('robot-turn', { id: it.id });
      }
    }

    updateFragile(it, driving, h) {
      const s = it.spec, st = it.st, b = it.bodies.root;
      const up = Math.cos(b.getAngle()); // y of the box's own "up" arrow
      st.floating = !!st.floating;
      if (!st.floating) {
        st.flipT = up < s.flipDot ? (st.flipT || 0) + h : 0;
        if (driving && st.flipT > s.flipTime) { st.floating = true; st.backT = 0; this.emit('fragile-up', { id: it.id }); }
      } else {
        st.backT = up > s.restoreDot ? (st.backT || 0) + h : 0;
        if (st.backT > s.restoreTime) { st.floating = false; st.flipT = 0; this.emit('fragile-down', { id: it.id }); }
        else if (b.getLinearVelocity().y < s.maxUpSpeed) {
          // the pull fades out high above the road, so a loose box hovers instead of leaving the sky
          const alt = b.getPosition().y - this.groundY(b.getPosition().x);
          const fade = Math.max(0, Math.min(1, (s.ceiling - alt) / 1.5));
          const F = Math.min(s.maxLiftForce, b.getMass() * -C.physics.gravity * (1 + (s.lift - 1) * fade));
          b.applyForceToCenter(Vec2(0, F), true);
        }
      }
    }

    // ------------------------------------------------------------ stage events
    setupEvents() {
      const ev = this.stage.events || {};
      const m = this.course.marks;
      this.magnet = ev.magnet ? { x: m.magnetPark, triggerX: m.magnetTrigger, moving: false, wheelAngle: 0, announced: false } : null;
      this.worker = null;
      this.crane = null;
    }

    // events with physical bodies only exist while driving
    startDriving() {
      this.phase = 'driving';
      const ev = this.stage.events || {};
      const m = this.course.marks;
      if (ev.worker) {
        const W = C.worker;
        const x = m.worker;
        const top = this.groundY(x) + W.bridgeHeight;
        const anchor = this.world.createBody({ type: 'static', position: Vec2(x, top) });
        anchor.setUserData({ kind: 'hook' });
        const pad = this.world.createBody({ type: 'dynamic', position: Vec2(x, top - 0.2) });
        pad.setUserData({ kind: 'pad' });
        pad.setSleepingAllowed(false);
        pad.createFixture({
          shape: new pl.Box(W.padSize[0] / 2, W.padSize[1] / 2), density: W.padMass / (W.padSize[0] * W.padSize[1]), friction: 0.35,
          filterCategoryBits: CAT.PAD, filterMaskBits: 0xffff,
        });
        const joint = this.world.createJoint(new pl.PrismaticJoint({
          bodyA: anchor, bodyB: pad, localAnchorA: Vec2(0, -0.2), localAnchorB: Vec2(0, 0), localAxisA: Vec2(0, 1),
          referenceAngle: 0, enableLimit: true, lowerTranslation: -(W.bridgeHeight - 0.5), upperTranslation: 0,
          enableMotor: true, motorSpeed: 0, maxMotorForce: 4000,
        }));
        this.worker = { x, top, anchor, pad, joint, state: 'idle', t: 0 };
      }
      if (ev.crane && this.bonusItem) {
        const K = C.crane;
        const x = m.crane;
        const hy = this.groundY(x) + K.hookHeight;
        const hook = this.world.createBody({ type: 'kinematic', position: Vec2(x, hy) });
        hook.setUserData({ kind: 'hook' });
        const it = this.bonusItem;
        const lug = it.spec.lug;
        this.placeItem(it.id, { x: x - lug.x, y: hy - K.ropeLength - lug.y, a: 0 });
        const rope = this.world.createJoint(new pl.RopeJoint({
          bodyA: hook, bodyB: it.bodies.root, localAnchorA: Vec2(0, 0), localAnchorB: lug, maxLength: K.ropeLength,
        }));
        this.crane = { x, hook, rope, state: 'waiting', slackT: 0, top: hy, warned: false };
      }
    }

    updateEvents(h) {
      if (this.phase !== 'driving') return;
      const ch = this.chassis;
      const cx = ch.getPosition().x;
      const bedX = ch.getWorldPoint(Vec2(BED.center, 0)).x;
      const v = ch.getLinearVelocity().x;
      // magnet truck
      const mg = this.magnet;
      if (mg) {
        const M = C.magnet;
        if (!mg.moving && cx > mg.triggerX) { mg.moving = true; this.emit('magnet-start', {}); }
        if (mg.moving && mg.x > -30) {
          mg.x -= M.speed * h;
          mg.wheelAngle += (M.speed * h) / (C.truck.wheelRadius * M.laneScale);
        }
        const mp = this.magnetPoint();
        let strongest = 0;
        for (const it of this.allItems()) {
          if (!it.bodies) continue;
          const resp = it.spec.magnet;
          const b = it.bodies.root;
          it.magnetForce = 0;
          if (!resp || !b.isActive()) continue;
          const p = b.getWorldCenter();
          const dx = mp.x - p.x, dy = mp.y - p.y;
          const d2 = dx * dx + dy * dy + M.depth * M.depth;
          const d = Math.sqrt(d2);
          if (d > M.range) continue;
          const F = Math.min((M.strength * resp) / d2, M.maxForce * resp);
          b.applyForceToCenter(Vec2((F * dx) / d, (F * dy) / d), true);
          it.magnetForce = F;
          strongest = Math.max(strongest, F);
        }
        if (strongest > M.maxForce * 0.5 && !mg.announced) { mg.announced = true; this.emit('magnet-pull', {}); }
      }
      // over-helpful worker
      const wk = this.worker;
      if (wk) {
        const W = C.worker;
        const near = Math.abs(bedX - wk.x) < W.zone;
        const away = Math.abs(bedX - wk.x) > W.zone + 0.6;
        const padTouch = () => {
          for (let ce = wk.pad.getContactList(); ce; ce = ce.next) {
            if (!ce.contact.isTouching()) continue;
            const k = ce.other.getUserData().kind;
            if (k === 'cargo' || k === 'chassis') return true;
          }
          return false;
        };
        wk.t += h;
        if (wk.state === 'idle' && near) {
          wk.state = 'lowering'; wk.t = 0;
          wk.joint.setMotorSpeed(-W.lowerSpeed);
          wk.joint.setMaxMotorForce(W.pressForce);
          this.emit('worker-start', {});
        } else if (wk.state === 'lowering') {
          if (padTouch()) { wk.state = 'pressing'; wk.t = 0; this.emit('worker-press', {}); }
          else if (away || wk.joint.getJointTranslation() < -(W.bridgeHeight - 0.6)) this.workerLift();
        } else if (wk.state === 'pressing') {
          if (wk.t > W.holdTime || away) this.workerLift();
        } else if (wk.state === 'lifting' && wk.joint.getJointTranslation() > -0.05) {
          wk.state = 'done'; wk.t = 0;
          wk.joint.setMotorSpeed(0);
          wk.joint.setMaxMotorForce(4000);
          this.emit('worker-done', {});
        }
      }
      // crane with one more item
      const cr = this.crane;
      if (cr) {
        const K = C.crane;
        const hp = cr.hook.getPosition();
        if (!cr.warned && cr.x - cx < K.warnDistance) { cr.warned = true; this.emit('crane-warn', {}); }
        if (cr.state === 'waiting' || cr.state === 'lowering') {
          const b = this.bonusItem.bodies.root;
          const lugW = b.getWorldPoint(this.bonusItem.spec.lug);
          const under = Math.abs(bedX - cr.x) < K.zone && Math.abs(v) < K.maxSpeed;
          // the hook never goes below the load's lifting eye: it can only let it down, not pull it
          if (under && hp.y > this.groundY(cr.x) + 0.8 && hp.y > lugW.y + 0.1) { cr.state = 'lowering'; cr.hook.setLinearVelocity(Vec2(0, -K.lowerSpeed)); }
          else cr.hook.setLinearVelocity(Vec2(0, 0));
          // resting on the truck or its load for a moment: let go
          let resting = false;
          for (let ce = b.getContactList(); ce; ce = ce.next) {
            if (!ce.contact.isTouching()) continue;
            const k = ce.other.getUserData().kind;
            if (k === 'cargo' || k === 'chassis') { resting = true; break; }
          }
          const slack = Vec2.distance(lugW, hp) < K.ropeLength - 0.03;
          cr.slackT = resting || slack ? cr.slackT + h : 0;
          if (cr.slackT > K.releaseSlack) {
            this.world.destroyJoint(cr.rope);
            cr.rope = null;
            cr.state = 'released';
            cr.hook.setLinearVelocity(Vec2(0, 1.5));
            this.emit('crane-release', {});
          } else if (cr.state === 'waiting' && bedX > cr.x + 6 && !cr.missed) {
            cr.missed = true;
            this.emit('crane-miss', {});
          }
        } else if (cr.state === 'released' && hp.y > cr.top) cr.hook.setLinearVelocity(Vec2(0, 0));
      }
    }

    workerLift() {
      const wk = this.worker;
      wk.state = 'lifting'; wk.t = 0;
      wk.joint.setMotorSpeed(C.worker.liftSpeed);
      wk.joint.setMaxMotorForce(C.worker.pressForce);
      this.emit('worker-release', {});
    }

    magnetPoint() {
      const M = C.magnet;
      const mg = this.magnet;
      const k = M.laneScale / TS;
      const roadY = this.groundY(mg.x) + M.laneOffsetY;
      const cy = roadY + (322 + 60 - MAG_PX.h / 2) * k;
      return { x: mg.x + (M.poleXpx - MAG_PX.w / 2) * k, y: cy + (MAG_PX.h / 2 - M.poleYpx) * k, cx: mg.x, cy, k };
    }

    // ------------------------------------------------------------ driving
    applyDrive(h) {
      const T = C.truck;
      const [rear, front] = this.wheelJoints;
      const target = this.controls.throttle && !this.controls.brake ? 1 : 0;
      if (target > this.throttle) this.throttle = Math.min(target, this.throttle + T.throttleRise * h);
      else this.throttle = Math.max(target, this.throttle - T.throttleRise * 2 * h);
      if (this.controls.brake) {
        for (const j of this.wheelJoints) { j.setMotorSpeed(0); j.setMaxMotorTorque(T.brakeTorque); }
      } else if (this.throttle > 0.01) {
        rear.setMotorSpeed(-T.maxWheelSpeed);
        rear.setMaxMotorTorque(T.driveTorque * this.throttle);
        front.setMotorSpeed(0);
        front.setMaxMotorTorque(T.coastTorque);
      } else {
        for (const j of this.wheelJoints) { j.setMotorSpeed(0); j.setMaxMotorTorque(T.coastTorque); }
      }
    }

    step(h) {
      this.applyDrive(h);
      this.applyBelts(h);
      this.updateCargo(h);
      this.updateEvents(h);
      this.world.step(h, C.physics.velocityIterations, C.physics.positionIterations);
      for (const b of this.belts) b.ready = true; // joint impulses exist only after a solver pass
      this.time += h;
      if (this.phase === 'driving') this.driveTime += h;
      const cx = this.chassis.getPosition().x;
      const vmax = C.physics.maxCargoSpeed;
      for (const it of this.allItems()) {
        if (!it.bodies) continue;
        for (const b of Object.values(it.bodies)) {
          if (!b.isActive()) continue;
          const ud = b.getUserData();
          if (!ud.fallen) {
            for (let ce = b.getContactList(); ce; ce = ce.next) {
              if (ce.contact.isTouching() && ce.other === this.ground) {
                ud.fallen = true;
                if (b === it.bodies.root) { it.fallen = true; this.emit('fall', { id: it.id }); }
                else if (ud.part.startsWith('melon')) this.emit('melon-fall', { id: it.id });
                break;
              }
            }
          }
          const v = b.getLinearVelocity();
          const sp = v.length();
          if (sp > vmax) b.setLinearVelocity(Vec2.mul(v, vmax / sp));
          // fallen bodies far behind the truck are frozen (no more simulation cost)
          if (ud.fallen && b.getPosition().x < cx - C.physics.cullBehind) b.setActive(false);
        }
      }
    }

    // ------------------------------------------------------------ queries
    // bodies resting on the truck: connected to the chassis through touching contacts, item hinges
    // or belts, never through the road
    supportedBodies() {
      const seen = new Set();
      const queue = [];
      const push = (b) => {
        if (!b || seen.has(b) || !b.isActive()) return;
        const ud = b.getUserData();
        if (ud.kind !== 'cargo' || ud.fallen) return;
        seen.add(b);
        queue.push(b);
      };
      const visit = (body) => {
        for (let ce = body.getContactList(); ce; ce = ce.next) if (ce.contact.isTouching()) push(ce.other);
        if (body !== this.chassis) {
          for (let je = body.getJointList(); je; je = je.next) {
            const ud = je.other.getUserData();
            if (ud.kind === 'cargo' && ud.item === body.getUserData().item) push(je.other);
          }
        }
      };
      visit(this.chassis);
      for (const b of this.belts) push(this.beltBody(b));
      while (queue.length) visit(queue.shift());
      return seen;
    }

    loadedItems() { return this.items.filter((it) => it.bodies); }

    // per scoring unit: delivered / lost
    scoreUnits() {
      const sup = this.supportedBodies();
      const out = [];
      for (const it of this.allItems()) {
        if (!it.bodies) continue;
        for (const u of it.spec.units) {
          const b = it.bodies[u.body];
          const ok = sup.has(b) && !b.getUserData().fallen;
          out.push({ uid: `${it.id}:${u.key}`, id: it.id, key: u.key, name: u.name, value: u.value, bonus: !!u.bonus, inner: !!u.inner, delivered: ok, sprite: it.spec.draw[u.body][0].sprite });
        }
      }
      return out;
    }

    speed() { return this.chassis.getLinearVelocity().x; }

    // all cargo bodies under a point, front-most part first
    hitTest(p) {
      const hits = [];
      const aabb = new pl.AABB(Vec2(p.x - 0.01, p.y - 0.01), Vec2(p.x + 0.01, p.y + 0.01));
      this.world.queryAABB(aabb, (f) => {
        const ud = f.getBody().getUserData();
        if (ud.kind === 'cargo' && f.testPoint(p) && !hits.some((h) => h.body === f.getBody())) hits.push({ item: ud.item, part: ud.part, body: f.getBody() });
        return true;
      });
      hits.sort((a, b) => (a.part === 'root' ? 1 : 0) - (b.part === 'root' ? 1 : 0));
      return hits;
    }

    snapshot() {
      const pose = (b) => ({ x: b.getPosition().x, y: b.getPosition().y, a: b.getAngle() });
      return {
        stage: this.stage.id,
        truck: { chassis: pose(this.chassis), wheels: this.wheels.map(pose) },
        cargo: this.loadedItems().map((it) => {
          const bodies = {};
          for (const [k, b] of Object.entries(it.bodies)) bodies[k] = pose(b);
          return { id: it.id, bodies };
        }),
        belts: this.belts.map((b) => ({ hook: b.hook, id: b.id, part: b.part, lx: b.local.x, ly: b.local.y, rest: b.rest })),
      };
    }
  }

  root.Phys = { Sim, HOOKS, BED, TRUCK_PX, MAG_PX, CAT, tpx, TS, buildCourse, buildSpecs };
})(typeof window !== 'undefined' ? window : globalThis);
