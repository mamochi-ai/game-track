// 『一便でいけます。』 tunable parameters. Units: meters, kilograms, seconds, newtons.
// Physics world is y-up. Edit values here to tune the feel; nothing else should hold magic numbers
// that matter for balance.
window.CONFIG = {
  physics: {
    hz: 120,               // fixed physics step rate (2 sub-steps per 60fps frame)
    maxStepsPerFrame: 6,   // drop simulated time beyond this instead of spiralling
    maxFrameDt: 0.1,       // a frame longer than this (tab switch, hitch) is clamped
    velocityIterations: 10,
    positionIterations: 8,
    gravity: -9.8,
  },

  // Truck sprite is 752x327 px; 221.2 px = 1 m gives a 3.4 m kei truck.
  truck: {
    spritePxPerM: 221.2,
    startX: 4.0,
    frameMass: 380,          // lower frame + bed (carries most of the weight, low CG)
    cabMass: 110,
    friction: 0.65,          // bed floor friction
    wheelRadius: 0.27,
    wheelMass: 18,
    wheelFriction: 1.05,
    wheelRestYpx: 316,       // wheel centre (sprite px) on an unloaded truck at rest
    rearWheelXpx: 173,
    frontWheelXpx: 600,
    suspensionK: 36000,      // N/m per wheel
    suspensionDampingNs: 2600, // N*s/m per wheel
    suspensionPreloadM: 0.08,  // joint anchor sits this far below the rest position
    suspensionTravelM: 0.22,   // hard limit of wheel travel around the anchor
    driveTorque: 640,        // rear-wheel drive, N*m at full throttle
    maxWheelSpeed: 33,       // rad/s (about 8.9 m/s, 32 km/h)
    throttleRise: 1.6,       // per second, 0 -> 1 (holding the pedal builds up power)
    brakeTorque: 1150,       // N*m per wheel
    coastTorque: 22,         // rolling resistance when no pedal is pressed
  },

  belt: {
    count: 3,
    stiffness: 9000,         // N/m, only pulls (a strap cannot push)
    damping: 420,            // N*s/m along the strap
    pretension: 0.025,       // rest length = attach distance * (1 - pretension)
    hardStretch: 0.05,       // a rope joint stops the strap beyond this stretch
    maxForce: 6500,
    tensionWarn: 900,        // N: colour turns orange
    tensionHigh: 2200,       // N: colour turns red
    maxLength: 4.2,
  },

  magnet: {
    triggerX: 238,           // the oncoming truck starts when the player passes this x
    parkedX: 251,            // where it waits (visible from the sign onward)
    speed: 5.2,              // m/s toward the player
    laneOffsetY: 0.55,       // far lane is drawn this much higher
    laneScale: 0.9,          // and slightly smaller
    depth: 2.1,              // m between lanes; keeps the force finite at closest approach
    strength: 18000,          // N*m^2 : force = strength * response / dist^2
    maxForce: 1900,           // N cap per body (times its response)
    range: 18,               // no force beyond this distance
    poleXpx: 345, poleYpx: 40, // magnet face on the flipped magnet_truck sprite
  },

  course: {
    wallStartX: -12,
    bumpX: 40, bumpH: 0.14, bumpW: 1.0,     // speed bump
    stepX: 64, stepH: 0.08, stepW: 0.14,     // small kerb step up (bevelled so it can be climbed slowly)
    hillStart: 92, hillTop: 3.0, hillUpLen: 36, hillFlat: 10, hillDownLen: 42,
    signX: 214,
    goalStart: 286, goalEnd: 335, wallEndX: 336,
    goalSpeed: 0.45, goalHold: 1.2,
    friction: 0.9,
  },

  // Cargo types. size: [width, height] in meters (sprite is stretched to this box and the traced
  // outline follows it). partDensity: optional density multiplier per outline part.
  cargoTypes: {
    box:    { name: '段ボール', sprite: 'box',    mass: 11, friction: 0.55, restitution: 0.04, value: 3000,  magnet: 0 },
    fridge: { name: '冷蔵庫',   sprite: 'fridge', size: [0.66, 1.15], mass: 55, friction: 0.38, restitution: 0.02, value: 12000, magnet: 1.0 },
    sofa:   { name: 'ソファ',   sprite: 'sofa',   size: [1.6, 0.75], mass: 36, friction: 0.9, restitution: 0.02, value: 15000, magnet: 0 },
    tire:   { name: 'タイヤ',   sprite: 'tire',   size: [0.62, 0.62], mass: 11, friction: 0.95, restitution: 0.38, value: 2000, magnet: 0 },
    plank:  { name: '長い板',   sprite: 'plank',  size: [2.5, 0.2], mass: 16, friction: 0.6, restitution: 0.05, value: 1500, magnet: 0 },
    cat:    { name: '招き猫',   sprite: 'cat',    size: [0.92, 1.0], mass: 70, friction: 0.6, restitution: 0.05, value: 30000, magnet: 0,
              partDensity: [2.4, 1.6, 0.8] }, // head / paw / body: heavy head = high centre of mass
  },

  // The manifest: 20 items. Boxes come in three sizes.
  cargoList: [
    { type: 'fridge' }, { type: 'fridge' },
    { type: 'sofa' },
    { type: 'cat' },
    { type: 'plank' }, { type: 'plank' }, { type: 'plank' },
    { type: 'tire' }, { type: 'tire' }, { type: 'tire' }, { type: 'tire' },
    { type: 'box', size: [0.62, 0.66], mass: 13 }, { type: 'box', size: [0.62, 0.66], mass: 13 },
    { type: 'box', size: [0.62, 0.66], mass: 13 },
    { type: 'box', size: [0.52, 0.55], mass: 10 }, { type: 'box', size: [0.52, 0.55], mass: 10 },
    { type: 'box', size: [0.52, 0.55], mass: 10 },
    { type: 'box', size: [0.42, 0.45], mass: 7 }, { type: 'box', size: [0.42, 0.45], mass: 7 },
    { type: 'box', size: [0.42, 0.45], mass: 7 },
  ],

  // おすすめの無茶積み: items are dropped in this order at bed x (0 = rear end of bed, meters)
  // with the given angle (degrees), each resting on what is already there.
  // ids follow cargoList: 0-1 fridge, 2 sofa, 3 cat, 4-6 plank, 7-10 tire, 11-13 big box,
  // 14-16 mid box, 17-19 small box. Belt points are (u, v) fractions of the item size from its centre.
  recommended: {
    items: [
      { id: 2, x: 0.90, a: 0 },     // sofa on the floor
      { id: 5, x: 1.99, a: 90 },    // a plank standing against the headboard like a wall
      { id: 1, x: 0.74, a: 90 },    // fridge lying on the sofa
      { id: 14, x: 1.60, a: 0 },    // box on the sofa arm
      { id: 4, x: 0.62, a: 0 },     // plank deck, hanging out the back
      { id: 3, x: 1.38, a: 0 },     // the cat, up high
      { id: 0, x: 0.52, a: 0 },     // second fridge standing on the deck (the magnet will want it)
      { id: 11, x: -0.12, a: 0 },   // loose box on the overhang
      { id: 8, x: 0.90, a: 0 },     // tire wedged between fridge and cat
    ],
    belts: [
      { hook: 4, id: 3, u: -0.15, v: 0.15 },  // headboard -> cat
      { hook: 0, id: 4, u: -0.45, v: 0 },     // rear hook -> end of the plank deck
      { hook: 2, id: 0, u: 0.2, v: 0.3 },     // bed middle -> standing fridge
    ],
  },
};
