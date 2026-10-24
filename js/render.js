// Canvas renderer: residential street background, road, signs, trucks, cargo, belts, magnet field.
(function (root) {
  'use strict';
  const C = root.CONFIG;
  const { HOOKS, TRUCK_PX, MAG_PX, TS } = root.Phys;

  const INK = '#2b2a33';
  const ROAD_DEPTH = 1.35;   // visible road surface band (both lanes)
  const SIDEWALK = 0.28;
  const WALL_H = 0.85;

  // ---------------------------------------------------------------- deterministic scenery
  function rng(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }
  const HOUSE_WALLS = ['#efe9dc', '#e2e6e4', '#e9dcc6', '#d9cdb8', '#e6e0d0', '#cfd8da'];
  const HOUSE_ROOFS = ['#4f5a68', '#6b4f43', '#8a5a44', '#3f4a52', '#5d6b5c'];
  function makeHouses(seed, from, to, minGap) {
    const r = rng(seed);
    const out = [];
    for (let x = from; x < to;) {
      const kind = r() < 0.18 ? 'apt' : 'house';
      const w = kind === 'apt' ? 9 + r() * 4 : 6 + r() * 3.5;
      const h = kind === 'apt' ? 6.5 + r() * 2 : 4.2 + r() * 1.6;
      out.push({
        x, w, h, kind,
        wall: HOUSE_WALLS[Math.floor(r() * HOUSE_WALLS.length)],
        roof: HOUSE_ROOFS[Math.floor(r() * HOUSE_ROOFS.length)],
        floors: kind === 'apt' ? 3 : (h > 5 ? 2 : 1),
        tree: r() < 0.45, ac: r() < 0.5, lit: r(),
      });
      x += w + minGap + r() * 3;
    }
    return out;
  }
  const FAR_HOUSES = makeHouses(7, -60, 260, 0.5);
  const NEAR_HOUSES = makeHouses(42, -40, 420, 1.2);
  const POLE_GAP = 28;

  // ---------------------------------------------------------------- renderer
  class Renderer {
    constructor(canvas, sprites) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
      this.sp = sprites;
      this.cam = { x: 0, y: 1.5, s: 60 };
      this.w = 1; this.h = 1; this.dpr = 1;
      this.debug = false;
      this.t = 0;
    }

    resize() {
      const dpr = Math.min(2, root.devicePixelRatio || 1);
      const w = this.cv.clientWidth, h = this.cv.clientHeight;
      if (w !== this.w || h !== this.h || dpr !== this.dpr) {
        this.w = w; this.h = h; this.dpr = dpr;
        this.cv.width = Math.round(w * dpr);
        this.cv.height = Math.round(h * dpr);
      }
    }

    // world <-> CSS px
    sx(x) { return (x - this.cam.x) * this.cam.s + this.w / 2; }
    sy(y) { return (this.cam.y - y) * this.cam.s + this.h / 2; }
    toWorld(px, py) { return { x: (px - this.w / 2) / this.cam.s + this.cam.x, y: this.cam.y - (py - this.h / 2) / this.cam.s }; }

    // frame [x0,x1]x[y0,y1] inside the free screen rect, smoothing by k (0..1)
    frame(x0, x1, y0, y1, rect, k) {
      const rw = Math.max(80, rect.r - rect.l), rh = Math.max(80, rect.b - rect.t);
      const s = Math.min(rw / (x1 - x0), rh / (y1 - y0));
      const cxPx = (rect.l + rect.r) / 2, cyPx = (rect.t + rect.b) / 2;
      const tx = (x0 + x1) / 2 - (cxPx - this.w / 2) / s;
      const ty = (y0 + y1) / 2 + (cyPx - this.h / 2) / s;
      const c = this.cam;
      c.s += (s - c.s) * k;
      c.x += (tx - c.x) * k;
      c.y += (ty - c.y) * k;
    }

    // ------------------------------------------------------------ main draw
    draw(view) {
      const { sim } = view;
      this.t = view.t;
      this.g = sim.groundY;
      this.road = sim.course.road;
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.drawSky();
      this.drawHouses(FAR_HOUSES, 0.25, 0.32, 0.55);
      this.drawHouses(NEAR_HOUSES, 0.55, 0.62, 0.0);
      this.drawPoles();
      this.drawStreet();
      this.drawSigns(sim);
      this.drawGoal(sim);
      this.drawBridge(sim);
      this.drawCrane(sim);
      this.drawMagnetTruck(sim);
      this.drawTruck(sim, view);
      this.drawCargo(sim, view);
      this.drawWorkerPad(sim);
      this.drawCraneLoad(sim);
      this.drawMagnetField(sim);
      this.drawBelts(sim, view);
      if (view.mode === 'belt') this.drawHooks(sim, view);
      if (view.held) this.drawGhost(sim, view.held);
      this.drawFrontGround();
      if (this.debug) this.drawDebug(sim);
    }

    drawSky() {
      const ctx = this.ctx;
      const g = ctx.createLinearGradient(0, 0, 0, this.h);
      g.addColorStop(0, '#8fb9cf');
      g.addColorStop(0.55, '#cfe0e3');
      g.addColorStop(1, '#efe6cf');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, this.w, this.h);
      // soft clouds drifting with a slow parallax
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      const s = this.cam.s * 0.35;
      for (let i = 0; i < 7; i++) {
        const cx = ((i * 37 - this.cam.x * 0.08) % 260 + 260) % 260;
        const x = (cx - 40) * s * 0.6 + this.w * 0.1;
        const y = this.h * (0.08 + (i % 3) * 0.07);
        const r = s * (1.2 + (i % 2) * 0.6);
        ctx.beginPath();
        ctx.ellipse(x, y, r * 2.2, r * 0.7, 0, 0, Math.PI * 2);
        ctx.ellipse(x + r * 1.2, y - r * 0.35, r * 1.3, r * 0.6, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // parallax layer: p = how much it follows the camera, k = size relative to the street
    drawHouses(list, p, k, lift) {
      const ctx = this.ctx;
      // scenery size is kept within a band so close-ups (title, loading) don't blow houses up
      const s = Math.min(this.cam.s, 64) * k;
      const baseY = this.sy(this.g(this.cam.x) + ROAD_DEPTH + SIDEWALK + 0.4) - lift * s * 4;
      const camX = this.cam.x * p;
      const fade = k < 0.4;
      for (const hs of list) {
        const x0 = (hs.x - camX) * s + this.w / 2;
        const ww = hs.w * s;
        if (x0 > this.w + 20 || x0 + ww < -20) continue;
        const hh = hs.h * s;
        const y0 = baseY - hh;
        ctx.save();
        if (fade) ctx.globalAlpha = 0.55;
        ctx.lineWidth = Math.max(1, s * 0.05);
        ctx.strokeStyle = INK;
        // wall
        ctx.fillStyle = hs.wall;
        ctx.fillRect(x0, y0, ww, hh);
        ctx.strokeRect(x0, y0, ww, hh);
        // roof
        ctx.fillStyle = hs.roof;
        ctx.beginPath();
        if (hs.kind === 'apt') {
          ctx.rect(x0 - s * 0.2, y0 - s * 0.35, ww + s * 0.4, s * 0.35);
        } else {
          ctx.moveTo(x0 - s * 0.6, y0 + s * 0.1);
          ctx.lineTo(x0 + ww * 0.5, y0 - s * 1.9);
          ctx.lineTo(x0 + ww + s * 0.6, y0 + s * 0.1);
          ctx.closePath();
        }
        ctx.fill();
        ctx.stroke();
        // windows
        const floors = hs.floors;
        const fh = hh / floors;
        for (let f = 0; f < floors; f++) {
          const n = hs.kind === 'apt' ? 4 : 2;
          for (let i = 0; i < n; i++) {
            const wx = x0 + ww * ((i + 0.5) / n) - s * 0.45;
            const wy = y0 + fh * f + fh * 0.28;
            ctx.fillStyle = hs.lit > 0.7 && (f + i) % 3 === 0 ? '#f6e3a6' : '#a9c6d2';
            ctx.fillRect(wx, wy, s * 0.9, fh * 0.38);
            ctx.strokeRect(wx, wy, s * 0.9, fh * 0.38);
          }
          if (hs.kind === 'apt' && f > 0) {
            ctx.beginPath();
            ctx.moveTo(x0, y0 + fh * f);
            ctx.lineTo(x0 + ww, y0 + fh * f);
            ctx.stroke();
          }
        }
        if (hs.ac && hs.kind === 'house') {
          ctx.fillStyle = '#f2f2ee';
          ctx.fillRect(x0 + ww - s * 1.2, baseY - s * 0.8, s * 0.9, s * 0.6);
          ctx.strokeRect(x0 + ww - s * 1.2, baseY - s * 0.8, s * 0.9, s * 0.6);
        }
        if (hs.tree) {
          ctx.fillStyle = '#7d9a6a';
          ctx.beginPath();
          ctx.arc(x0 - s * 0.3, baseY - s * 1.6, s * 1.1, 0, Math.PI * 2);
          ctx.arc(x0 + s * 0.6, baseY - s * 2.1, s * 0.9, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    drawPoles() {
      const ctx = this.ctx;
      const p = 0.82, k = 0.85;
      const s = Math.min(this.cam.s, 70) * k;
      const baseY = this.sy(this.g(this.cam.x) + ROAD_DEPTH + SIDEWALK);
      const camX = this.cam.x * p;
      const first = Math.floor((camX - this.w / 2 / s) / POLE_GAP) - 1;
      const last = Math.ceil((camX + this.w / 2 / s) / POLE_GAP) + 1;
      const tops = [];
      ctx.save();
      ctx.strokeStyle = INK;
      for (let i = first; i <= last; i++) {
        const x = (i * POLE_GAP - camX) * s + this.w / 2;
        const top = baseY - s * 7.5;
        tops.push([x, top]);
        ctx.fillStyle = '#9a978f';
        ctx.lineWidth = Math.max(1, s * 0.04);
        ctx.fillRect(x - s * 0.13, top, s * 0.26, baseY - top);
        ctx.strokeRect(x - s * 0.13, top, s * 0.26, baseY - top);
        ctx.fillRect(x - s * 0.9, top + s * 0.5, s * 1.8, s * 0.14);
      }
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(43,42,51,0.55)';
      for (let j = 0; j < 2; j++) {
        ctx.beginPath();
        for (let i = 0; i + 1 < tops.length; i++) {
          const [x1, y1] = tops[i], [x2] = tops[i + 1];
          const yy = y1 + s * (0.55 + j * 0.3);
          ctx.moveTo(x1 + (j ? 0.8 : -0.8) * s, yy);
          ctx.quadraticCurveTo((x1 + x2) / 2, yy + s * 0.9, x2 + (j ? 0.8 : -0.8) * s, yy);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    roadPoints(x0, x1) {
      const pts = [{ x: x0, y: this.g(x0) }];
      for (const p of this.road) if (p.x > x0 && p.x < x1) pts.push(p);
      pts.push({ x: x1, y: this.g(x1) });
      return pts;
    }

    // a band following the road profile between offsets a and b (meters above the road line)
    band(pts, a, b, fill, stroke) {
      const ctx = this.ctx;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, this.sx(p.x), this.sy(p.y + b)));
      for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(this.sx(pts[i].x), this.sy(pts[i].y + a));
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.2; ctx.stroke(); }
    }

    line(pts, off, color, width, dash) {
      const ctx = this.ctx;
      ctx.save();
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, this.sx(p.x), this.sy(p.y + off)));
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      if (dash) { ctx.setLineDash(dash.map((d) => d * this.cam.s)); ctx.lineDashOffset = this.cam.x * this.cam.s; }
      ctx.stroke();
      ctx.restore();
    }

    viewX() {
      const half = this.w / 2 / this.cam.s;
      return [this.cam.x - half - 1, this.cam.x + half + 1];
    }

    drawStreet() {
      const [x0, x1] = this.viewX();
      const pts = this.roadPoints(x0, x1);
      const top = ROAD_DEPTH + SIDEWALK;
      // block wall behind the far sidewalk
      this.band(pts, top, top + WALL_H, '#c9c4b8', INK);
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = 'rgba(43,42,51,0.25)';
      ctx.lineWidth = 1;
      for (let row = 1; row < 4; row++) this.line(pts, top + (WALL_H * row) / 4, 'rgba(43,42,51,0.22)', 1);
      const bw = 0.8;
      ctx.beginPath();
      for (let x = Math.floor(x0 / bw) * bw; x < x1; x += bw) {
        const g = this.g(x);
        ctx.moveTo(this.sx(x), this.sy(g + top));
        ctx.lineTo(this.sx(x), this.sy(g + top + WALL_H));
      }
      ctx.stroke();
      ctx.restore();
      this.band(pts, ROAD_DEPTH, top, '#d8d3c6', INK);       // far sidewalk
      this.band(pts, 0, ROAD_DEPTH, '#6f7175', null);         // asphalt, both lanes
      this.band(pts, ROAD_DEPTH - 0.06, ROAD_DEPTH, '#5c5e62', null);
      this.line(pts, C.magnet.laneOffsetY + 0.1, '#f3efe2', Math.max(1.5, this.cam.s * 0.045), [1.6, 1.4]); // centre line
      this.line(pts, ROAD_DEPTH - 0.12, '#e9e5d8', Math.max(1, this.cam.s * 0.03));
      this.line(pts, 0.1, '#e9e5d8', Math.max(1, this.cam.s * 0.03));
    }

    drawFrontGround() {
      const [x0, x1] = this.viewX();
      const pts = this.roadPoints(x0, x1);
      const ctx = this.ctx;
      this.band(pts, -0.16, 0.0, '#bdb7a8', INK);             // kerb
      this.band(pts, -0.75, -0.16, '#d9d3c3', null);           // near sidewalk
      this.band(pts, -40, -0.75, '#8a9a6c', null);             // verge
      this.line(pts, -0.75, INK, 1.2);
      // tile joints on the near sidewalk
      ctx.save();
      ctx.strokeStyle = 'rgba(43,42,51,0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = Math.floor(x0); x < x1; x += 1) {
        const g = this.g(x);
        ctx.moveTo(this.sx(x), this.sy(g - 0.16));
        ctx.lineTo(this.sx(x - 0.15), this.sy(g - 0.75));
      }
      ctx.stroke();
      ctx.restore();
    }

    // ------------------------------------------------------------ signs and goal
    signPost(x, h) {
      const g = this.g(x) + ROAD_DEPTH + 0.1;
      const ctx = this.ctx;
      ctx.fillStyle = '#8d8f93';
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1;
      const w = 0.07 * this.cam.s;
      ctx.fillRect(this.sx(x) - w / 2, this.sy(g + h), w, h * this.cam.s);
      ctx.strokeRect(this.sx(x) - w / 2, this.sy(g + h), w, h * this.cam.s);
      return { x: this.sx(x), y: this.sy(g + h), s: this.cam.s };
    }

    diamond(cx, cy, r, s) {
      const ctx = this.ctx;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.fillStyle = '#f2c230';
      ctx.strokeStyle = INK;
      ctx.lineWidth = Math.max(1.5, s * 0.05);
      ctx.beginPath();
      ctx.moveTo(0, -r); ctx.lineTo(r, 0); ctx.lineTo(0, r); ctx.lineTo(-r, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    plate(cx, cy, s, lines, bg, fg) {
      const ctx = this.ctx;
      const fs = Math.max(8, s * 0.2);
      ctx.save();
      ctx.font = `700 ${fs}px "Zen Maru Gothic", "Hiragino Maru Gothic ProN", sans-serif`;
      const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + fs * 0.9;
      const h = lines.length * fs * 1.25 + fs * 0.5;
      ctx.fillStyle = bg;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.rect(cx - w / 2, cy, w, h);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = fg;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      lines.forEach((l, i) => ctx.fillText(l, cx, cy + fs * 0.35 + i * fs * 1.25));
      ctx.restore();
    }

    drawSigns(sim) {
      const [x0, x1] = this.viewX();
      const ctx = this.ctx;
      for (const sg of sim.course.signs) {
        if (sg.x < x0 - 4 || sg.x > x1 + 8) continue;
        if (sg.kind === 'magnet') {
          const g = this.g(sg.x) + ROAD_DEPTH + 0.1;
          this.sprite('magnet_sign', sg.x, g + 1.25, 0, 1.5, 2.52);
          this.plate(this.sx(sg.x + 1.4), this.sy(g + 2.3), this.cam.s * 1.05, ['対向車に', '巨大磁石'], '#c8452f', '#fff7ea');
          const q = this.signPost(sg.x + 7, 1.9);
          this.plate(q.x, q.y - q.s * 0.25, q.s, ['冷蔵庫を', 'お持ちの方は', 'ご注意ください'], '#fbf8f0', INK);
          continue;
        }
        if (sg.kind === 'stop') {
          const p = this.signPost(sg.x, 2.3);
          const r = p.s * 0.5;
          ctx.save();
          ctx.fillStyle = '#c8452f';
          ctx.strokeStyle = INK;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(p.x - r, p.y - r * 0.6); ctx.lineTo(p.x + r, p.y - r * 0.6); ctx.lineTo(p.x, p.y + r * 0.9);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = '#fff7ea';
          ctx.font = `700 ${Math.max(8, r * 0.42)}px "Zen Maru Gothic", sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText('止まれ', p.x, p.y - r * 0.05);
          ctx.restore();
          continue;
        }
        const p = this.signPost(sg.x, 2.2);
        const r = p.s * 0.42;
        this.diamond(p.x, p.y, r, p.s);
        ctx.save();
        ctx.fillStyle = INK;
        ctx.strokeStyle = INK;
        ctx.beginPath();
        if (sg.kind === 'bump') {
          ctx.ellipse(p.x, p.y + r * 0.2, r * 0.42, r * 0.22, 0, Math.PI, 0);
          ctx.fill();
          ctx.fillRect(p.x - r * 0.6, p.y + r * 0.2, r * 1.2, r * 0.08);
        } else if (sg.kind === 'hill') {
          ctx.moveTo(p.x - r * 0.55, p.y + r * 0.35); ctx.lineTo(p.x + r * 0.55, p.y + r * 0.35); ctx.lineTo(p.x + r * 0.55, p.y - r * 0.25);
          ctx.closePath(); ctx.fill();
        } else if (sg.kind === 'crest') {
          ctx.moveTo(p.x - r * 0.6, p.y + r * 0.35); ctx.lineTo(p.x, p.y - r * 0.35); ctx.lineTo(p.x + r * 0.6, p.y + r * 0.35);
          ctx.closePath(); ctx.fill();
        } else if (sg.kind === 'down') {
          ctx.moveTo(p.x - r * 0.55, p.y + r * 0.35); ctx.lineTo(p.x + r * 0.55, p.y + r * 0.35); ctx.lineTo(p.x - r * 0.55, p.y - r * 0.25);
          ctx.closePath(); ctx.fill();
        } else {
          ctx.font = `700 ${Math.max(8, r)}px "Zen Maru Gothic", sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('!', p.x, p.y + r * 0.05);
        }
        ctx.restore();
        if (sg.lines.length) this.plate(p.x, p.y + r * 1.05, p.s, sg.lines, '#fbf8f0', INK);
      }
    }

    magnetIcon(cx, cy, r) {
      const ctx = this.ctx;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.lineCap = 'butt';
      ctx.lineWidth = r * 0.45;
      ctx.strokeStyle = INK;
      ctx.beginPath();
      ctx.arc(0, -r * 0.05, r * 0.55, Math.PI, 0, false);
      ctx.moveTo(-r * 0.55, -r * 0.05); ctx.lineTo(-r * 0.55, r * 0.55);
      ctx.moveTo(r * 0.55, -r * 0.05); ctx.lineTo(r * 0.55, r * 0.55);
      ctx.stroke();
      ctx.restore();
    }

    drawGoal(sim) {
      const c = sim.course;
      const [x0, x1] = this.viewX();
      if (x1 < c.goalStart - 25 || x0 > c.wallEndX + 5) return;
      const ctx = this.ctx;
      // the destination house behind the wall
      const hx = (c.goalStart + c.goalEnd) / 2 + 2;
      const g = this.g(hx) + ROAD_DEPTH + SIDEWALK;
      const s = this.cam.s;
      const bx = this.sx(hx - 6), by = this.sy(g + 5.2), bw = 12 * s, bh = 5.2 * s;
      ctx.save();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2;
      ctx.fillStyle = '#f3ead6';
      ctx.fillRect(bx, by, bw, bh);
      ctx.strokeRect(bx, by, bw, bh);
      ctx.fillStyle = '#b5543b';
      ctx.beginPath();
      ctx.moveTo(bx - s * 0.8, by + s * 0.1);
      ctx.lineTo(bx + bw / 2, by - s * 2.2);
      ctx.lineTo(bx + bw + s * 0.8, by + s * 0.1);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#a9c6d2';
      for (let i = 0; i < 3; i++) {
        ctx.fillRect(bx + bw * (0.12 + i * 0.3), by + s * 0.8, s * 1.6, s * 1.2);
        ctx.strokeRect(bx + bw * (0.12 + i * 0.3), by + s * 0.8, s * 1.6, s * 1.2);
      }
      ctx.restore();
      this.plate(this.sx(hx), by + s * 2.5, s * 1.3, ['お届け先'], '#fbf8f0', '#c8452f');
      // painted stop zone on the road
      const pts = this.roadPoints(Math.max(c.goalStart, x0), Math.min(c.goalEnd, x1));
      if (pts.length > 1 && pts[pts.length - 1].x > pts[0].x) {
        ctx.save();
        ctx.globalAlpha = 0.5;
        this.band(pts, 0.02, ROAD_DEPTH - 0.2, '#e8b04a', null);
        ctx.restore();
      }
      for (const fx of [c.goalStart, c.goalEnd]) {
        if (fx < x0 - 2 || fx > x1 + 2) continue;
        const p = this.signPost(fx, 2.4);
        ctx.fillStyle = '#c8452f';
        ctx.strokeStyle = INK;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + p.s * 0.9, p.y + p.s * 0.25);
        ctx.lineTo(p.x, p.y + p.s * 0.5);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      const p = this.signPost(c.goalStart + 3, 1.8);
      this.plate(p.x, p.y - p.s * 0.2, p.s, ['ここで停車'], '#fbf8f0', INK);
      // end wall
      const ex = c.wallEndX;
      const eg = this.g(ex - 0.1);
      ctx.fillStyle = '#c9c4b8';
      ctx.strokeStyle = INK;
      ctx.fillRect(this.sx(ex), this.sy(eg + 2.4), 3 * s, 2.4 * s + 0.75 * s);
      ctx.strokeRect(this.sx(ex), this.sy(eg + 2.4), 3 * s, 2.4 * s + 0.75 * s);
    }

    // ------------------------------------------------------------ vehicles
    sprite(name, x, y, a, w, h, alpha) {
      const img = this.sp[name];
      if (!img) return;
      const ctx = this.ctx;
      ctx.save();
      ctx.translate(this.sx(x), this.sy(y));
      ctx.rotate(-a);
      if (alpha != null) ctx.globalAlpha = alpha;
      ctx.drawImage(img, (-w / 2) * this.cam.s, (-h / 2) * this.cam.s, w * this.cam.s, h * this.cam.s);
      ctx.restore();
    }

    drawMagnetTruck(sim) {
      if (!sim.magnet) return;
      const mp = sim.magnetPoint();
      const k = mp.k; // meters per sprite px
      const [x0, x1] = this.viewX();
      if (mp.cx < x0 - 5 || mp.cx > x1 + 5) return;
      const wr = 60 * k;
      const wd = wr * 2 * 269 / 262;
      for (const wx of [150, 585]) {
        const x = mp.cx + (wx - MAG_PX.w / 2) * k;
        const y = mp.cy + (MAG_PX.h / 2 - 322) * k;
        this.sprite('wheel', x, y, sim.magnet.wheelAngle, wd, wd);
      }
      this.sprite('magnet_truck', mp.cx, mp.cy, 0, MAG_PX.w * k, MAG_PX.h * k);
    }

    drawTruck(sim) {
      const ctx = this.ctx;
      const ch = sim.chassis;
      const p = ch.getPosition();
      // shadow
      const g = this.g(p.x);
      ctx.save();
      ctx.fillStyle = 'rgba(30,30,40,0.25)';
      ctx.beginPath();
      ctx.ellipse(this.sx(p.x), this.sy(g + 0.04), 1.8 * this.cam.s, 0.12 * this.cam.s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      const r = C.truck.wheelRadius;
      const wd = r * 2 * 269 / 262;
      for (const w of sim.wheels) this.sprite('wheel', w.getPosition().x, w.getPosition().y, w.getAngle(), wd, wd);
      this.sprite('truck', p.x, p.y, ch.getAngle(), TRUCK_PX.w / TS, TRUCK_PX.h / TS);
    }

    // draw order of an item's bodies (later = in front)
    bodyOrder(it) {
      const k = it.spec.kind;
      if (k === 'fridge') return ['root', 'melon0', 'melon1', 'melon2', 'door0', 'door1'];
      if (k === 'cat') return ['root', 'arm'];
      if (k === 'sofabed') return ['root', 'cushion'];
      if (k === 'robotbox') return ['root', 'robot'];
      return ['root'];
    }

    drawItemBody(it, name, b) {
      const s = it.spec, st = it.st;
      const p = b.getPosition();
      let a = b.getAngle(), x = p.x, y = p.y;
      if (s.kind === 'cat' && st.shake) x += Math.sin(this.t * 70) * 0.008;
      if (s.kind === 'robotbox' && name === 'root') {
        if (!st.open) {
          for (const d of s.draw.root) this.sprite(d.sprite, x, y, a, d.w, d.h);
          // the product picture printed on the box
          this.sprite('robot', x + Math.cos(a) * 0.02, y + Math.sin(a) * 0.02, a, s.size[0] * 0.62, s.size[0] * 0.24, 0.85);
        } else {
          const w = s.size[0] / 270 * 393, h = s.size[0] / 270 * 257;
          const ox = -0.018, oy = -s.size[1] / 2 + h / 2;
          this.sprite('open_box', x + ox * Math.cos(a) - oy * Math.sin(a), y + ox * Math.sin(a) + oy * Math.cos(a), a, w, h);
        }
        return;
      }
      if (s.kind === 'robotbox' && name === 'robot' && !st.open) return; // still in its box
      if (s.kind === 'fragile' && st.floating) this.glow(x, y, Math.max(...s.size));
      for (const d of s.draw[name]) {
        if (name === 'robot' && st.dir < 0) this.spriteFlip(d.sprite, x, y, a, d.w, d.h);
        else this.sprite(d.sprite, x, y, a, d.w, d.h);
      }
    }

    drawCargo(sim, view) {
      for (const it of sim.allItems()) {
        if (!it.bodies) continue;
        for (const name of this.bodyOrder(it)) {
          const b = it.bodies[name];
          if (b) this.drawItemBody(it, name, b);
        }
        if (view.highlight && view.highlight.id === it.id) {
          const b = it.bodies[view.highlight.part];
          if (b) this.outlineBody(b, 'rgba(242,194,48,0.95)', 3);
        }
      }
    }

    spriteFlip(name, x, y, a, w, h) {
      const img = this.sp[name];
      if (!img) return;
      const ctx = this.ctx;
      ctx.save();
      ctx.translate(this.sx(x), this.sy(y));
      ctx.rotate(-a);
      ctx.scale(-1, 1);
      ctx.drawImage(img, (-w / 2) * this.cam.s, (-h / 2) * this.cam.s, w * this.cam.s, h * this.cam.s);
      ctx.restore();
    }

    // the upside-down box's odd pull: a soft glow and rising chevrons
    glow(x, y, size) {
      const ctx = this.ctx;
      const cx = this.sx(x), cy = this.sy(y), r = size * this.cam.s;
      ctx.save();
      const g = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * 1.1);
      g.addColorStop(0, 'rgba(255,236,140,0.75)');
      g.addColorStop(1, 'rgba(255,236,140,0)');
      ctx.fillStyle = g;
      ctx.fillRect(cx - r * 1.2, cy - r * 1.2, r * 2.4, r * 2.4);
      ctx.strokeStyle = 'rgba(214,120,20,0.9)';
      ctx.lineWidth = Math.max(2, r * 0.06);
      for (let i = 0; i < 3; i++) {
        const ph = (this.t * 1.2 + i / 3) % 1;
        const yy = cy + r * 0.9 - ph * r * 1.9;
        const xx = cx + (i - 1) * r * 0.45;
        ctx.globalAlpha = 1 - ph;
        ctx.beginPath();
        ctx.moveTo(xx - r * 0.12, yy + r * 0.08); ctx.lineTo(xx, yy - r * 0.04); ctx.lineTo(xx + r * 0.12, yy + r * 0.08);
        ctx.stroke();
      }
      ctx.restore();
    }

    outlineBody(b, color, width) {
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      for (let f = b.getFixtureList(); f; f = f.getNext()) {
        const sh = f.getShape();
        ctx.beginPath();
        if (sh.getType() === 'circle') {
          const c = b.getWorldPoint(sh.getCenter());
          ctx.arc(this.sx(c.x), this.sy(c.y), sh.getRadius() * this.cam.s, 0, Math.PI * 2);
        } else {
          sh.m_vertices.forEach((v, i) => { const p = b.getWorldPoint(v); (i ? ctx.lineTo : ctx.moveTo).call(ctx, this.sx(p.x), this.sy(p.y)); });
          ctx.closePath();
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    partsPath(parts, x, y, a) {
      const ctx = this.ctx;
      const c = Math.cos(a), s = Math.sin(a);
      ctx.beginPath();
      for (const p of parts) {
        if (p.circle) {
          const px = x + p.c.x * c - p.c.y * s, py = y + p.c.x * s + p.c.y * c;
          ctx.moveTo(this.sx(px) + p.r * this.cam.s, this.sy(py));
          ctx.arc(this.sx(px), this.sy(py), p.r * this.cam.s, 0, Math.PI * 2);
        } else {
          p.verts.forEach((v, i) => {
            const px = x + v.x * c - v.y * s, py = y + v.x * s + v.y * c;
            (i ? ctx.lineTo : ctx.moveTo).call(ctx, this.sx(px), this.sy(py));
          });
          ctx.closePath();
        }
      }
    }

    drawGhost(sim, held) {
      const it = sim.item(held.id);
      const s = it.spec;
      const ctx = this.ctx;
      const col = held.valid ? 'rgba(76,160,96,0.95)' : 'rgba(214,64,52,0.95)';
      ctx.save();
      ctx.setLineDash([4, 5]);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(this.sx(held.x), this.sy(held.y));
      ctx.lineTo(this.sx(held.x), this.sy(this.g(held.x)));
      ctx.stroke();
      ctx.restore();
      const c = Math.cos(held.a), sn = Math.sin(held.a);
      const fake = { spec: s, st: {} };
      for (const name of this.bodyOrder(it)) {
        const def = s.bodies[name];
        if (!def) continue;
        const o = def.offset || { x: 0, y: 0 };
        const px = held.x + o.x * c - o.y * sn, py = held.y + o.x * sn + o.y * c;
        ctx.save();
        ctx.globalAlpha = 0.82;
        this.drawItemBody(fake, name, { getPosition: () => ({ x: px, y: py }), getAngle: () => held.a });
        ctx.restore();
      }
      if (!held.valid) {
        ctx.save();
        ctx.globalAlpha = 0.28;
        ctx.fillStyle = '#d64034';
        this.partsPath(s.outer, held.x, held.y, held.a);
        ctx.fill();
        ctx.restore();
      }
      ctx.save();
      ctx.strokeStyle = col;
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      this.partsPath(s.outer, held.x, held.y, held.a);
      ctx.stroke();
      ctx.restore();
      if (held.finger) {
        ctx.save();
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(held.finger.px, held.finger.py, 16, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }

    // ------------------------------------------------------------ the over-helpful worker's footbridge
    drawBridge(sim) {
      const x = sim.course.marks.worker;
      if (x == null || !(sim.stage.events || {}).worker) return;
      const [x0, x1] = this.viewX();
      if (x < x0 - 8 || x > x1 + 8) return;
      const W = C.worker;
      const base = this.g(x) + ROAD_DEPTH + SIDEWALK;
      const deck = this.g(x) + W.bridgeHeight + 0.2;
      const ctx = this.ctx;
      const s = this.cam.s;
      ctx.save();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2;
      ctx.fillStyle = '#7f9a8e';
      for (const px of [x - 4.6, x + 4.2]) {
        ctx.fillRect(this.sx(px), this.sy(deck), 0.4 * s, (deck - base) * s);
        ctx.strokeRect(this.sx(px), this.sy(deck), 0.4 * s, (deck - base) * s);
      }
      ctx.fillStyle = '#93ad9f';
      ctx.fillRect(this.sx(x - 5.5), this.sy(deck + 0.45), 11 * s, 0.45 * s);
      ctx.strokeRect(this.sx(x - 5.5), this.sy(deck + 0.45), 11 * s, 0.45 * s);
      // railing
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(this.sx(x - 5.5), this.sy(deck + 1.4));
      ctx.lineTo(this.sx(x + 5.5), this.sy(deck + 1.4));
      for (let i = 0; i <= 22; i++) { const px = x - 5.5 + i * 0.5; ctx.moveTo(this.sx(px), this.sy(deck + 0.45)); ctx.lineTo(this.sx(px), this.sy(deck + 1.4)); }
      ctx.stroke();
      ctx.restore();
      const wk = sim.worker;
      const state = wk ? wk.state : 'idle';
      const name = state === 'done' ? 'worker_thumb' : state === 'idle' ? 'worker_push' : 'worker_press';
      const h = 1.75;
      const img = this.sp[name];
      const w = img ? (h * img.width) / img.height : 1.5;
      this.sprite(name, x - 0.75, deck + 0.45 + h / 2, 0, w, h);
    }

    drawWorkerPad(sim) {
      const wk = sim.worker;
      if (!wk) return;
      const p = wk.pad.getPosition();
      const ctx = this.ctx;
      const s = this.cam.s;
      const deck = this.g(wk.x) + C.worker.bridgeHeight + 0.55;
      ctx.save();
      ctx.strokeStyle = INK;
      ctx.lineWidth = Math.max(3, 0.09 * s) + 2;
      ctx.beginPath();
      ctx.moveTo(this.sx(p.x), this.sy(deck));
      ctx.lineTo(this.sx(p.x), this.sy(p.y));
      ctx.stroke();
      ctx.strokeStyle = '#b8bec4';
      ctx.lineWidth = Math.max(3, 0.09 * s);
      ctx.stroke();
      const [pw, ph] = C.worker.padSize;
      ctx.translate(this.sx(p.x), this.sy(p.y));
      ctx.rotate(-wk.pad.getAngle());
      ctx.fillStyle = '#e8742a';
      ctx.lineWidth = 2;
      ctx.strokeStyle = INK;
      ctx.beginPath();
      ctx.rect((-pw / 2) * s, (-ph / 2) * s, pw * s, ph * s);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    // ------------------------------------------------------------ crane with one more item
    craneGeom(sim) {
      const x = sim.course.marks.crane;
      const K = C.crane;
      const sc = 4.4 / 562;            // crane sprites: m per px
      const cy = this.g(x) + ROAD_DEPTH + SIDEWALK + (246 * sc) / 2;
      const boomL = (680 - 45) * sc;
      const ty = this.g(x) + K.hookHeight + 0.7;
      const pivotY = cy + (246 / 2 - 15) * sc;
      const ang = Math.asin(Math.max(-0.95, Math.min(0.95, (ty - pivotY) / boomL)));
      const pivotX = x - boomL * Math.cos(ang);
      const bodyX = pivotX - (330 - 281) * sc;
      return { x, sc, cy, pivotX, pivotY, ang, bodyX, tip: { x, y: pivotY + boomL * Math.sin(ang) } };
    }

    drawCrane(sim) {
      const x = sim.course.marks.crane;
      if (x == null || !(sim.stage.events || {}).crane) return;
      const [x0, x1] = this.viewX();
      if (x < x0 - 12 || x > x1 + 12) return;
      const k = this.craneGeom(sim);
      this.sprite('crane_body', k.bodyX, k.cy, 0, 562 * k.sc, 246 * k.sc);
      // boom drawn around its pivot (sprite px 45,45)
      const bw = 692 * k.sc, bh = 138 * k.sc;
      const ox = (692 / 2 - 45) * k.sc, oy = (45 - 138 / 2) * k.sc;
      const ca = Math.cos(k.ang), sa = Math.sin(k.ang);
      this.sprite('crane_boom', k.pivotX + ox * ca - oy * sa, k.pivotY + ox * sa + oy * ca, k.ang, bw, bh);
    }

    drawCraneLoad(sim) {
      const cr = sim.crane;
      if (!cr) return;
      const k = this.craneGeom(sim);
      const hp = cr.hook.getPosition();
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(this.sx(k.tip.x), this.sy(k.tip.y));
      ctx.lineTo(this.sx(hp.x), this.sy(hp.y + 0.75));
      ctx.stroke();
      const it = sim.bonusItem;
      if (cr.rope && it && it.bodies) {
        const lug = it.bodies.root.getWorldPoint(it.spec.lug);
        ctx.beginPath();
        ctx.moveTo(this.sx(hp.x), this.sy(hp.y));
        ctx.lineTo(this.sx(lug.x), this.sy(lug.y));
        ctx.stroke();
        // where it will land: a shadow on whatever is below
        let hitY = this.g(hp.x);
        sim.world.rayCast({ x: hp.x, y: lug.y - 0.7 }, { x: hp.x, y: hitY - 0.1 }, (f, pt, n, frac) => {
          const ud = f.getBody().getUserData();
          if (f.getBody() === it.bodies.root || ud.kind === 'hook') return -1;
          hitY = pt.y;
          return frac;
        });
        ctx.fillStyle = 'rgba(30,30,40,0.35)';
        ctx.beginPath();
        ctx.ellipse(this.sx(hp.x), this.sy(hitY), 0.6 * this.cam.s, 0.1 * this.cam.s, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = 'rgba(200,69,47,0.8)';
        ctx.beginPath();
        ctx.moveTo(this.sx(hp.x), this.sy(lug.y - 0.7));
        ctx.lineTo(this.sx(hp.x), this.sy(hitY));
        ctx.stroke();
      }
      ctx.restore();
      this.sprite('crane_hook', hp.x, hp.y + 0.38, 0, 0.33, 0.76);
    }

    // ------------------------------------------------------------ belts, hooks, magnet field
    beltColor(T) {
      const B = C.belt;
      if (T >= B.tensionHigh) return '#d23a2a';
      if (T >= B.tensionWarn) return '#ef8a24';
      return '#e9c23a';
    }

    drawBelts(sim) {
      const ctx = this.ctx;
      for (const b of sim.belts) {
        const body = sim.beltBody(b);
        if (!body) continue;
        const pa = sim.hookWorld(b.hook);
        const pb = body.getWorldPoint(b.local);
        const L = Math.hypot(pb.x - pa.x, pb.y - pa.y);
        const slack = Math.max(0, b.rest * 1.0 - L);
        const sag = Math.sqrt(Math.max(0, (L + slack) ** 2 - L * L)) * 0.5;
        const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2 - sag;
        const col = this.beltColor(b.tension);
        const wpx = Math.max(3, 0.05 * this.cam.s);
        ctx.save();
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(this.sx(pa.x), this.sy(pa.y));
        ctx.quadraticCurveTo(this.sx(mx), this.sy(my), this.sx(pb.x), this.sy(pb.y));
        ctx.strokeStyle = INK;
        ctx.lineWidth = wpx + 2.5;
        ctx.stroke();
        ctx.strokeStyle = col;
        ctx.lineWidth = wpx;
        ctx.stroke();
        // ratchet buckle
        const bx = this.sx((pa.x * 0.6 + pb.x * 0.4)), by = this.sy((pa.y * 0.6 + pb.y * 0.4)) + this.cam.s * sag * 0.48;
        ctx.fillStyle = '#9aa0a6';
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1.2;
        ctx.fillRect(bx - wpx, by - wpx * 0.8, wpx * 2, wpx * 1.6);
        ctx.strokeRect(bx - wpx, by - wpx * 0.8, wpx * 2, wpx * 1.6);
        // anchor on the item
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.arc(this.sx(pb.x), this.sy(pb.y), wpx * 0.9, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }

    drawHooks(sim, view) {
      const ctx = this.ctx;
      const pulse = 0.5 + 0.5 * Math.sin(this.t * 6);
      HOOKS.forEach((h, i) => {
        const p = sim.hookWorld(i);
        const x = this.sx(p.x), y = this.sy(p.y);
        const sel = view.beltHook === i;
        ctx.save();
        ctx.fillStyle = sel ? 'rgba(242,194,48,0.95)' : `rgba(255,255,255,${0.55 + pulse * 0.3})`;
        ctx.strokeStyle = INK;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, sel ? 13 : 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = INK;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });
      if (view.beltHook != null && view.pointer) {
        const p = sim.hookWorld(view.beltHook);
        ctx.save();
        ctx.setLineDash([6, 6]);
        ctx.strokeStyle = 'rgba(43,42,51,0.7)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(this.sx(p.x), this.sy(p.y));
        ctx.lineTo(view.pointer.px, view.pointer.py);
        ctx.stroke();
        ctx.restore();
      }
    }

    drawMagnetField(sim) {
      if (!sim.magnet) return;
      const mp = sim.magnetPoint();
      const ctx = this.ctx;
      for (const it of sim.allItems()) {
        if (!it.bodies || !(it.magnetForce > 25)) continue;
        const a = Math.min(1, it.magnetForce / C.magnet.maxForce);
        const p = it.bodies.root.getWorldCenter();
        const x0 = this.sx(mp.x), y0 = this.sy(mp.y), x1 = this.sx(p.x), y1 = this.sy(p.y);
        ctx.save();
        ctx.strokeStyle = `rgba(200,69,47,${0.25 + a * 0.6})`;
        ctx.lineWidth = 2 + a * 2;
        ctx.setLineDash([10, 8]);
        ctx.lineDashOffset = -this.t * 60;
        for (let k = -1; k <= 1; k++) {
          const nx = -(y1 - y0), ny = x1 - x0;
          const nl = Math.hypot(nx, ny) || 1;
          const bend = k * 0.25 * Math.hypot(x1 - x0, y1 - y0);
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.quadraticCurveTo((x0 + x1) / 2 + (nx / nl) * bend, (y0 + y1) / 2 + (ny / nl) * bend, x1, y1);
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    drawDebug(sim) {
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,0,255,0.9)';
      ctx.lineWidth = 1;
      for (let b = sim.world.getBodyList(); b; b = b.getNext()) {
        for (let f = b.getFixtureList(); f; f = f.getNext()) {
          const sh = f.getShape();
          ctx.beginPath();
          if (sh.getType() === 'circle') {
            const c = b.getWorldPoint(sh.getCenter());
            ctx.arc(this.sx(c.x), this.sy(c.y), sh.getRadius() * this.cam.s, 0, Math.PI * 2);
          } else if (sh.getType() === 'polygon') {
            sh.m_vertices.forEach((v, i) => { const p = b.getWorldPoint(v); (i ? ctx.lineTo : ctx.moveTo).call(ctx, this.sx(p.x), this.sy(p.y)); });
            ctx.closePath();
          } else continue;
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }

  root.Renderer = Renderer;
})(window);
