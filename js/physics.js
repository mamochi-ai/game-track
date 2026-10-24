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

  // Belt hooks on the truck (sprite px) and their labels.
  const HOOKS = [
    { px: 22, py: 262, name: '後部フック' },
    { px: 40, py: 182, name: '荷台・後' },
    { px: 200, py: 182, name: '荷台・中' },
    { px: 360, py: 182, name: '荷台・前' },
    { px: 491, py: 14, name: '鳥居の上' },
  ].map((h) => Object.assign(h, { local: tpx(h.px, h.py) }));

  const BED = { rear: tpx(10, 178).x, front: tpx(478, 178).x, floorY: tpx(0, 178).y };

  // ---------------------------------------------------------------- course
  function buildCoursePoints() {
    const c = C.course;
    const pts = [];
    const add = (x, y) => pts.push(Vec2(x, y));
    add(c.wallStartX, 8);
    add(c.wallStartX, 0);
    // speed bump
    const b0 = c.bumpX - c.bumpW / 2;
    add(b0, 0);
    for (let i = 1; i < 12; i++) {
      const t = i / 12;
      add(b0 + c.bumpW * t, c.bumpH * 0.5 * (1 - Math.cos(2 * Math.PI * t)));
    }
    add(b0 + c.bumpW, 0);
    // kerb step
    add(c.stepX, 0);
    add(c.stepX + c.stepW, c.stepH);
    const base = c.stepH;
    // hill: smoothstep up, flat top, smoothstep down
    add(c.hillStart, base);
    const smooth = (t) => t * t * (3 - 2 * t);
    for (let x = 1.5; x < c.hillUpLen; x += 1.5) add(c.hillStart + x, base + c.hillTop * smooth(x / c.hillUpLen));
    const topStart = c.hillStart + c.hillUpLen;
    add(topStart, base + c.hillTop);
    add(topStart + c.hillFlat, base + c.hillTop);
    const downStart = topStart + c.hillFlat;
    for (let x = 1.5; x < c.hillDownLen; x += 1.5) add(downStart + x, base + c.hillTop * (1 - smooth(x / c.hillDownLen)));
    add(downStart + c.hillDownLen, base);
    add(c.wallEndX, base);
    add(c.wallEndX, base + 6);
    return pts;
  }
  const COURSE_PTS = buildCoursePoints();
  const ROAD_PTS = COURSE_PTS.slice(1, -1); // without the end walls

  function groundY(x) {
    const p = ROAD_PTS;
    if (x <= p[0].x) return p[0].y;
    for (let i = 1; i < p.length; i++) {
      if (x <= p[i].x) {
        const a = p[i - 1], b = p[i];
        const t = b.x - a.x < 1e-6 ? 1 : (x - a.x) / (b.x - a.x);
        return a.y + (b.y - a.y) * t;
      }
    }
    return p[p.length - 1].y;
  }

  // ---------------------------------------------------------------- cargo specs
  function buildItemSpecs() {
    return C.cargoList.map((entry, id) => {
      const t = C.cargoTypes[entry.type];
      const spec = Object.assign({}, t, entry, { id, typeKey: entry.type });
      spec.size = entry.size || t.size;
      spec.mass = entry.mass || t.mass;
      const [w, h] = spec.size;
      const o = OUT[t.sprite];
      // shapes in body-local meters, origin at sprite centre
      const parts = [];
      if (o.circle) {
        parts.push({ circle: true, c: Vec2(o.circle.x * w, -o.circle.y * h), r: o.circle.r * w, mult: 1 });
      } else {
        o.parts.forEach((p, i) => {
          const verts = p.map(([nx, ny]) => Vec2(nx * w, -ny * h));
          parts.push({ verts, mult: (t.partDensity && t.partDensity[i]) || 1 });
        });
      }
      parts.forEach((p) => {
        p.area = p.circle ? Math.PI * p.r * p.r : polyArea(p.verts);
        p.shape = p.circle ? new pl.Circle(p.c, p.r) : new pl.Polygon(p.verts);
      });
      const weighted = parts.reduce((s, p) => s + p.area * p.mult, 0);
      parts.forEach((p) => (p.density = (spec.mass * p.mult) / weighted));
      spec.parts = parts;
      spec.radius = Math.hypot(w, h) / 2;
      return spec;
    });
  }
  function polyArea(v) {
    let a = 0;
    for (let i = 0; i < v.length; i++) {
      const p = v[i], q = v[(i + 1) % v.length];
      a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) / 2;
  }
  const SPECS = buildItemSpecs();

  // ---------------------------------------------------------------- simulation
  class Sim {
    // snapshot: null for a fresh truck, or the object returned by snapshot()
    constructor(snapshot) {
      this.world = new pl.World({ gravity: Vec2(0, C.physics.gravity) });
      this.time = 0;
      this.items = SPECS.map((s) => ({ id: s.id, spec: s, body: null, fallen: false, magnetForce: 0 }));
      this.belts = [];
      this.controls = { throttle: false, brake: true };
      this.throttle = 0;
      this.phase = 'loading';
      this.onImpact = null;
      this.magnet = { x: C.magnet.parkedX, moving: false, wheelAngle: 0 };
      this.buildGround();
      if (snapshot) {
        this.buildTruck(snapshot.truck);
        snapshot.cargo.forEach((c) => this.placeItem(c.id, c.x, c.y, c.a));
        snapshot.belts.forEach((b) => this.addBelt(b.hook, b.id, Vec2(b.lx, b.ly), b.rest));
      } else {
        this.buildTruck(null);
        this.settle(1.2);
      }
      this.world.on('post-solve', (contact, impulse) => {
        if (!this.onImpact) return;
        const n = impulse.normalImpulses;
        const j = (n[0] || 0) + (n[1] || 0);
        if (j < 18) return;
        const ua = contact.getFixtureA().getBody().getUserData();
        const ub = contact.getFixtureB().getBody().getUserData();
        if (ua.kind !== 'cargo' && ub.kind !== 'cargo') return;
        this.onImpact(j, ua.kind === 'cargo' ? ua.item : ub.item);
      });
    }

    buildGround() {
      const g = this.world.createBody({ type: 'static' });
      g.setUserData({ kind: 'ground' });
      g.createFixture({ shape: new pl.Chain(COURSE_PTS, false), friction: C.course.friction, restitution: 0.05 });
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
        pos = Vec2(T.startX, groundY(T.startX) + T.wheelRadius - anchorLocalY + 0.01);
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
      const cabArea = polyArea(cabVerts) + head.area + lip.area;
      const cabD = T.cabMass / cabArea;
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

    // run the world without rendering (used to let a fresh truck sit down on its springs)
    settle(seconds) {
      const h = 1 / C.physics.hz;
      for (let t = 0; t < seconds; t += h) this.step(h);
    }

    // ------------------------------------------------------------ cargo
    item(id) { return this.items[id]; }

    placeItem(id, x, y, a) {
      const it = this.items[id];
      if (it.body) this.removeItem(id);
      const s = it.spec;
      const body = this.world.createBody({ type: 'dynamic', position: Vec2(x, y), angle: a, angularDamping: 0.08, linearDamping: 0.02 });
      body.setUserData({ kind: 'cargo', item: it });
      s.parts.forEach((p) => {
        body.createFixture({ shape: p.shape, density: p.density, friction: s.friction, restitution: s.restitution });
      });
      if (s.typeKey === 'tire') body.setBullet(true);
      it.body = body;
      it.fallen = false;
      return it;
    }

    removeItem(id) {
      const it = this.items[id];
      if (!it.body) return;
      for (let i = this.belts.length - 1; i >= 0; i--) if (this.belts[i].id === id) this.removeBelt(i);
      this.world.destroyBody(it.body);
      it.body = null;
      it.fallen = false;
    }

    // true when the item at this pose would intersect anything in the world
    overlaps(id, x, y, a) {
      const it = this.items[id];
      const xf = new pl.Transform(Vec2(x, y), a);
      const r = it.spec.radius + 0.05;
      if (y - r < groundY(x) - 0.5 && y < groundY(x)) return true;
      let hit = false;
      const aabb = new pl.AABB(Vec2(x - r, y - r), Vec2(x + r, y + r));
      this.world.queryAABB(aabb, (f) => {
        const b = f.getBody();
        if (b === it.body) return true;
        const fs = f.getShape();
        const bx = b.getTransform();
        for (const p of it.spec.parts) {
          for (let c = 0; c < fs.getChildCount(); c++) {
            if (pl.testOverlap(p.shape, 0, fs, c, xf, bx)) { hit = true; return false; }
          }
        }
        return true;
      });
      return hit;
    }

    // lowest free resting height for the item at x/angle, dropped from above (no simulation)
    dropHeight(id, x, a, fromY) {
      let y = fromY != null ? fromY : groundY(x) + 12;
      if (this.overlaps(id, x, y, a)) return null;
      let lo = groundY(x) - 1;
      const step = 0.05;
      while (y - step > lo && !this.overlaps(id, x, y - step, a)) y -= step;
      // refine
      let free = y, blocked = y - step;
      for (let i = 0; i < 6; i++) {
        const m = (free + blocked) / 2;
        if (this.overlaps(id, x, m, a)) blocked = m; else free = m;
      }
      return free + 0.004;
    }

    // ------------------------------------------------------------ belts
    hookWorld(i) { return this.chassis.getWorldPoint(HOOKS[i].local); }

    addBelt(hook, id, localPt, rest) {
      const it = this.items[id];
      if (!it.body || this.belts.length >= C.belt.count) return null;
      if (this.belts.some((b) => b.hook === hook && b.id === id)) return null;
      const pa = this.hookWorld(hook);
      const pb = it.body.getWorldPoint(localPt);
      const dist = Vec2.distance(pa, pb);
      if (dist > C.belt.maxLength || dist < 0.05) return null;
      const restLen = rest != null ? rest : dist * (1 - C.belt.pretension);
      const rope = this.world.createJoint(new pl.RopeJoint({
        bodyA: this.chassis, bodyB: it.body, localAnchorA: HOOKS[hook].local, localAnchorB: localPt,
        maxLength: Math.max(dist, restLen * (1 + C.belt.hardStretch)), collideConnected: true,
      }));
      const belt = { hook, id, local: Vec2(localPt.x, localPt.y), rest: restLen, rope, tension: 0, stretch: 0 };
      this.belts.push(belt);
      return belt;
    }

    removeBelt(i) {
      const b = this.belts[i];
      if (!b) return;
      this.world.destroyJoint(b.rope);
      this.belts.splice(i, 1);
    }

    applyBelts(h) {
      const B = C.belt;
      for (const b of this.belts) {
        const body = this.items[b.id].body;
        const pa = this.hookWorld(b.hook);
        const pb = body.getWorldPoint(b.local);
        const d = Vec2.sub(pb, pa);
        const L = d.length();
        b.stretch = (L - b.rest) / b.rest;
        let F = 0;
        if (L > b.rest && L > 1e-4) {
          const n = Vec2.mul(d, 1 / L);
          const vrel = Vec2.dot(Vec2.sub(body.getLinearVelocityFromWorldPoint(pb), this.chassis.getLinearVelocityFromWorldPoint(pa)), n);
          // explicit damping is limited so a light box on a stiff strap stays stable
          const c = Math.min(B.damping, (0.4 * body.getMass()) / h);
          F = Math.max(0, Math.min(B.maxForce, B.stiffness * (L - b.rest) + c * vrel));
          body.applyForce(Vec2.mul(n, -F), pb, true);
          this.chassis.applyForce(Vec2.mul(n, F), pa, true);
        }
        b.tension = F;
      }
    }

    // ------------------------------------------------------------ magnet (oncoming truck)
    magnetPoint() {
      const M = C.magnet;
      const k = M.laneScale / TS;
      const roadY = groundY(this.magnet.x) + M.laneOffsetY;
      const cy = roadY + (322 + 60 - MAG_PX.h / 2) * k; // sprite centre: wheels touch the far lane
      return {
        x: this.magnet.x + (M.poleXpx - MAG_PX.w / 2) * k,
        y: cy + (MAG_PX.h / 2 - M.poleYpx) * k,
        cx: this.magnet.x, cy, k,
      };
    }

    updateMagnet(h) {
      const M = C.magnet;
      const mg = this.magnet;
      if (this.phase !== 'driving') return;
      if (!mg.moving && this.chassis.getPosition().x > M.triggerX) mg.moving = true;
      if (mg.moving && mg.x > -30) {
        mg.x -= M.speed * h;
        mg.wheelAngle += (M.speed * h) / (C.truck.wheelRadius * M.laneScale);
      }
      const mp = this.magnetPoint();
      for (const it of this.items) {
        it.magnetForce = 0;
        const resp = it.spec.magnet;
        if (!it.body || !resp) continue;
        const p = it.body.getWorldCenter();
        const dx = mp.x - p.x, dy = mp.y - p.y;
        const d2 = dx * dx + dy * dy + M.depth * M.depth;
        const d = Math.sqrt(d2);
        if (d > M.range) continue;
        const F = Math.min((M.strength * resp) / d2, M.maxForce * resp);
        // only the in-plane part of the pull acts in this 2D world
        it.body.applyForceToCenter(Vec2((F * dx) / d, (F * dy) / d), true);
        it.magnetForce = F;
      }
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
      this.updateMagnet(h);
      this.world.step(h, C.physics.velocityIterations, C.physics.positionIterations);
      this.time += h;
      for (const it of this.items) {
        if (!it.body || it.fallen) continue;
        for (let ce = it.body.getContactList(); ce; ce = ce.next) {
          if (ce.contact.isTouching() && ce.other === this.ground) { it.fallen = true; break; }
        }
      }
    }

    // ------------------------------------------------------------ queries
    // items resting on the truck: connected to the chassis through touching contacts or belts,
    // never through the road.
    supportedIds() {
      const seen = new Set();
      const queue = [];
      const visit = (body) => {
        for (let ce = body.getContactList(); ce; ce = ce.next) {
          if (!ce.contact.isTouching()) continue;
          const ud = ce.other.getUserData();
          if (ud.kind === 'cargo' && !ud.item.fallen && !seen.has(ud.item.id)) {
            seen.add(ud.item.id);
            queue.push(ud.item.body);
          }
        }
      };
      visit(this.chassis);
      for (const b of this.belts) {
        const it = this.items[b.id];
        if (!it.fallen && !seen.has(b.id)) { seen.add(b.id); queue.push(it.body); }
      }
      while (queue.length) visit(queue.shift());
      return seen;
    }

    loadedItems() { return this.items.filter((it) => it.body); }

    speed() { return this.chassis.getLinearVelocity().x; }

    hitTest(p) {
      let found = null;
      const aabb = new pl.AABB(Vec2(p.x - 0.01, p.y - 0.01), Vec2(p.x + 0.01, p.y + 0.01));
      this.world.queryAABB(aabb, (f) => {
        const ud = f.getBody().getUserData();
        if (ud.kind === 'cargo' && f.testPoint(p)) { found = ud.item; return false; }
        return true;
      });
      return found;
    }

    snapshot() {
      const pose = (b) => ({ x: b.getPosition().x, y: b.getPosition().y, a: b.getAngle() });
      return {
        truck: { chassis: pose(this.chassis), wheels: this.wheels.map(pose) },
        cargo: this.loadedItems().map((it) => Object.assign({ id: it.id }, pose(it.body))),
        belts: this.belts.map((b) => ({ hook: b.hook, id: b.id, lx: b.local.x, ly: b.local.y, rest: b.rest })),
      };
    }
  }

  root.Phys = { Sim, SPECS, HOOKS, BED, TRUCK_PX, MAG_PX, COURSE_PTS, ROAD_PTS, groundY, tpx, TS };
})(typeof window !== 'undefined' ? window : globalThis);
