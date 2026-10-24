// Places a list of items on the truck by "dropping" each one straight down at a bed position.
// Used by おすすめの無茶積み and by tools/sim.js.
(function (root) {
  'use strict';
  const { BED } = root.Phys;

  function apply(sim, layout) {
    const ch = sim.chassis;
    const placed = [];
    for (const e of layout.items) {
      const it = sim.item(e.id);
      if (it.body) continue;
      const a = ((e.a || 0) * Math.PI) / 180 + ch.getAngle();
      const p = ch.getWorldPoint({ x: BED.rear + e.x, y: BED.floorY });
      const y = sim.dropHeight(e.id, p.x, a);
      if (y == null) continue;
      sim.placeItem(e.id, p.x, y, a);
      placed.push(e.id);
    }
    for (const b of layout.belts || []) {
      const it = sim.item(b.id);
      if (!it.body) continue;
      const [w, h] = it.spec.size;
      sim.addBelt(b.hook, b.id, { x: b.u * w, y: b.v * h });
    }
    return placed;
  }

  root.Layout = { apply };
})(typeof window !== 'undefined' ? window : globalThis);
