// 『一便でいけます。』 tunable parameters. Units: meters, kilograms, seconds, newtons.
// Physics world is y-up. Stages, cargo and every force/threshold live here.
window.CONFIG = {
  physics: {
    hz: 120,               // fixed physics step rate (2 sub-steps per 60fps frame)
    maxStepsPerFrame: 6,   // drop simulated time beyond this instead of spiralling
    maxFrameDt: 0.1,       // a frame longer than this (tab switch, hitch) is clamped
    velocityIterations: 10,
    positionIterations: 8,
    gravity: -9.8,
    cullBehind: 35,        // fallen bodies this far behind the truck are put to sleep for good
    maxCargoSpeed: 25,     // safety clamp for any cargo body (m/s)
  },

  // Truck sprite is 752x327 px; 221.2 px = 1 m gives a 3.4 m kei truck.
  truck: {
    spritePxPerM: 221.2,
    startX: 4.0,
    frameMass: 540,
    cabMass: 110,
    friction: 0.65,
    wheelRadius: 0.27,
    wheelMass: 18,
    wheelFriction: 1.05,
    wheelRestYpx: 316,
    rearWheelXpx: 173,
    frontWheelXpx: 600,
    suspensionK: 36000,      // N/m per wheel
    suspensionDampingNs: 2600,
    suspensionPreloadM: 0.08,
    suspensionTravelM: 0.3,  // hard limit of wheel travel around the anchor
    driveTorque: 800,
    maxWheelSpeed: 33,       // rad/s (about 8.9 m/s, 32 km/h)
    throttleRise: 1.6,
    brakeTorque: 1150,
    coastTorque: 22,
  },

  belt: {
    count: 3,
    stiffness: 9000,
    damping: 420,
    pretension: 0.025,
    hardStretch: 0.05,
    maxForce: 6500,
    tensionWarn: 900,
    tensionHigh: 2200,
    maxLength: 4.2,
  },

  magnet: {
    speed: 5.2,
    laneOffsetY: 0.55,
    laneScale: 0.9,
    depth: 2.1,              // m between lanes; keeps the force finite at closest approach
    strength: 18000,         // N*m^2 : force = strength * response / dist^2
    maxForce: 1900,          // N cap per body (times its response)
    range: 18,
    poleXpx: 345, poleYpx: 40,
  },

  // 親切すぎる作業員: a pad on a telescoping pole from a footbridge
  worker: {
    bridgeHeight: 6.2,       // pad hangs from here (m above the road)
    zone: 1.1,               // starts when the bed centre is this close to the bridge
    lowerSpeed: 1.3,         // m/s
    pressForce: 9000,        // N, motor force limit while pressing (about the weight of 900 kg)
    holdTime: 1.4,
    liftSpeed: 5,
    padSize: [0.7, 0.14],
    padMass: 12,
  },

  // 最後の荷物: a crane lowers one more item if the truck waits under it
  crane: {
    hookHeight: 6.4,
    lowerSpeed: 1.0,
    zone: 0.9,               // bed centre within this distance of the drop point and...
    maxSpeed: 0.6,           // ...slower than this, the hook comes down
    ropeLength: 0.35,
    releaseSlack: 0.35,      // s of resting on something before the hook lets go
    warnDistance: 30,
  },

  // Cargo types. size [w, h] in meters; the sprite is drawn in this box and the traced outline follows it.
  cargoTypes: {
    box:     { name: '段ボール', kind: 'simple', sprite: 'box', size: [0.6, 0.64], mass: 12, friction: 0.6, restitution: 0.04, value: 3000 },
    tire:    { name: 'タイヤ', kind: 'simple', sprite: 'tire', size: [0.62, 0.62], mass: 11, friction: 0.95, restitution: 0.38, value: 2000 },
    plank:   { name: '長い板', kind: 'simple', sprite: 'plank', size: [2.5, 0.2], mass: 16, friction: 0.6, restitution: 0.05, value: 1500 },
    bowling: { name: 'ボウリング球', kind: 'simple', sprite: 'bowling', size: [0.24, 0.24], mass: 7, friction: 0.22, restitution: 0.06, value: 4000 },
    ball:    { name: 'ゴムボール', kind: 'simple', sprite: 'rubber_ball', size: [0.34, 0.34], mass: 0.45, friction: 0.45, restitution: 0.82, value: 800 },
    shelf:   { name: 'キャスター棚', kind: 'shelf', sprite: 'shelf', size: [0.62, 0.59], mass: 14, friction: 0.5, restitution: 0.03,
               casterFriction: 0.02, value: 5000 },
    fridge:  { name: '冷蔵庫', kind: 'fridge', sprite: 'fridge_body', size: [0.775, 1.15], mass: 45, friction: 0.4, restitution: 0.02,
               value: 12000, magnet: 1.0, doorMass: 4,
               melons: 3, melonMass: 4.5, melonValue: 1500, melonFriction: 0.5, melonRestitution: 0.15,
               latchShock: 22,       // m/s^2 jolt that pops the door catch (double bumps at about 5 m/s or more)
               latchTilt: 0.6,       // rad of rocking away from the loaded angle
               doorOpen: -1.75, doorPop: 30 },  // door swing limit (rad) and the catch spring torque (N*m)
    sofabed: { name: 'ソファベッド', kind: 'sofabed', sprite: 'sofa', size: [1.6, 0.75], mass: 30, friction: 0.9, restitution: 0.02,
               value: 15000, cushionSize: [1.45, 0.27], cushionMass: 8,
               latchShock: 42, unfoldTorque: 120, unfoldSpeed: 2.2 },
    cat:     { name: '招き猫', kind: 'cat', sprite: 'cat_body', size: [0.88, 1.0], mass: 62, friction: 0.6, restitution: 0.05, value: 30000,
               partDensity: [2.2, 0.8], armMass: 3,
               period: 5.0, warnAt: 3.4, swingAt: 4.0, returnAt: 4.5,  // seconds within each cycle while driving
               swingAngle: -1.9, armTorque: 170, armSpeed: 9 },
    robotbox: { name: '箱入りロボット', kind: 'robotbox', sprite: 'box', size: [0.56, 0.6], mass: 4, friction: 0.6, restitution: 0.04,
               value: 9000, robotMass: 3.5, robotSize: [0.4, 0.155],
               openShock: 30, driveForce: 40, maxSpeed: 0.8, turnStall: 0.7 },
    fragile: { name: '天地無用の箱', kind: 'fragile', sprite: 'fragile_box', size: [0.6, 0.51], mass: 9, friction: 0.6, restitution: 0.04,
               value: 7000, flipDot: -0.35, flipTime: 1.0, restoreDot: 0.35, restoreTime: 0.6, lift: 1.7, maxUpSpeed: 1.6, maxLiftForce: 300, ceiling: 5.5 },
    bonus:   { name: '記念の大荷物', kind: 'simple', sprite: 'lift_block', size: [1.1, 0.64], mass: 40, friction: 0.7, restitution: 0.03,
               value: 20000, bonus: true, partDensity: [1, 1] },
  },

  boxSizes: { L: { size: [0.62, 0.66], mass: 13 }, M: { size: [0.52, 0.55], mass: 10 }, S: { size: [0.42, 0.45], mass: 7 } },

  // Course segments (left to right): ['flat', len], ['bump', h, w], ['step', h, w], ['slope', dh, len],
  // ['crest', h, upLen, downLen], ['sign', kind, lines], ['mark', name], ['goal', len]
  stages: [
    {
      id: 1,
      name: '近所への引っ越し',
      blurb: '平らな道と、ちょっとした坂。冷蔵庫の中身にご注意。',
      intro: '冷蔵庫には中身が入っています。「中身も込みです。」',
      norm: 15000,
      course: [
        ['flat', 30], ['sign', 'bump', ['段差あり']], ['flat', 6], ['step', 0.08, 0.4], ['flat', 22], ['step', -0.08, 0.3],
        ['flat', 18], ['bump', 0.12, 1.6], ['flat', 24], ['sign', 'hill', ['坂道']], ['flat', 8],
        ['slope', 2.6, 30], ['flat', 10], ['slope', -2.6, 30], ['flat', 16], ['sign', 'bump', ['段差', '連続']], ['flat', 6],
        ['bump', 0.17, 1.3], ['flat', 9], ['bump', 0.17, 1.3], ['flat', 26], ['goal', 40],
      ],
      manifest: [
        { type: 'fridge' }, { type: 'shelf' },
        { type: 'box', box: 'L' }, { type: 'box', box: 'L' }, { type: 'box', box: 'M' }, { type: 'box', box: 'M' }, { type: 'box', box: 'S' },
        { type: 'tire' }, { type: 'tire' }, { type: 'plank' }, { type: 'plank' },
        { type: 'bowling' }, { type: 'ball' }, { type: 'ball' },
      ],
      // ids follow the manifest order above
      recommended: {
        items: [
          { id: 0, x: 0.45, a: 0 },     // fridge at the back, doors facing the cab
          { id: 1, x: 1.18, a: 0 },     // caster shelf next to it (blocks the lower door)
          { id: 2, x: 1.81, a: 0 },     // big box at the headboard
          { id: 3, x: 1.18, a: 0 },     // big box on the shelf
          { id: 4, x: 1.80, a: 0 },
          { id: 5, x: 1.18, a: 0 },
          { id: 6, x: 1.80, a: 0 },
          { id: 7, x: 0.50, a: 0 },     // tire on the fridge
          { id: 11, x: 0.86, a: 0 },    // bowling ball in the notch between fridge and boxes
          { id: 12, x: 1.18, a: 0 },    // and a rubber ball on top, why not
        ],
        belts: [
          { hook: 2, id: 0, part: 'root', u: -0.3, v: 0.3 },  // bed middle -> fridge body (the doors stay free)
          { hook: 4, id: 7, u: 0, v: 0 },       // headboard -> tire on the fridge
          { hook: 1, id: 6, u: 0, v: 0.2 },     // rear of the bed -> top front box
        ],
      },
    },
    {
      id: 2,
      name: '親切な商店街',
      blurb: '急な坂の頂上、巨大磁石の対向車、そして親切な人。',
      intro: '頂上の手前ではアクセルを離しましょう。商店街の人はとても親切です。',
      norm: 20000,
      course: [
        ['flat', 26], ['bump', 0.13, 1.6], ['flat', 20], ['sign', 'crest', ['頂上', '見通し悪し']], ['flat', 8],
        ['crest', 2.2, 18, 8], ['flat', 34], ['sign', 'magnet', []], ['flat', 14], ['mark', 'magnetTrigger'], ['flat', 14], ['mark', 'magnetPark'],
        ['flat', 34], ['sign', 'stop', ['止まれ']], ['flat', 8], ['mark', 'worker'], ['flat', 30],
        ['bump', 0.14, 1.6], ['flat', 10], ['bump', 0.14, 1.6], ['flat', 22], ['goal', 40],
      ],
      events: { magnet: true, worker: true },
      manifest: [
        { type: 'fridge' }, { type: 'sofabed' }, { type: 'cat' }, { type: 'shelf' },
        { type: 'box', box: 'L' }, { type: 'box', box: 'L' }, { type: 'box', box: 'M' }, { type: 'box', box: 'M' }, { type: 'box', box: 'S' },
        { type: 'tire' }, { type: 'plank' }, { type: 'plank' }, { type: 'bowling' }, { type: 'ball' },
      ],
      recommended: {
        items: [
          { id: 1, x: 0.80, a: 0 },     // sofa bed on the floor, folding part on top
          { id: 8, x: 1.88, a: 0 },     // front stack at the headboard
          { id: 6, x: 1.87, a: 0 },
          { id: 0, x: 0.75, a: 90 },    // fridge lying on the sofa, doors facing up
          { id: 2, x: 0.72, a: 0 },     // the cat sitting on the fridge doors, paw towards the front stack
          { id: 4, x: 1.86, a: 0 },     // big box on top of the front stack: right in the paw's way
          { id: 13, x: 1.86, a: 0 },
        ],
        belts: [
          { hook: 2, id: 0, u: 0.1, v: 0 },      // bed middle -> fridge body
          { hook: 3, id: 2, u: -0.1, v: 0.1 },   // front rail -> cat (holds it against the launch)
          { hook: 4, id: 4, u: 0, v: 0.2 },      // headboard -> top box
        ],
      },
    },
    {
      id: 3,
      name: '本当に一便でいけます？',
      blurb: '全部盛り。最後にもうひとつ。下り坂で止まれますか。',
      intro: '最後に「あとひとつだけ！」があります。受け取らなくてもクリアできます。',
      norm: 25000,
      course: [
        ['flat', 24], ['bump', 0.13, 1.6], ['flat', 8], ['bump', 0.13, 1.6], ['flat', 22], ['sign', 'crest', ['頂上']], ['flat', 8],
        ['crest', 2.0, 18, 9], ['flat', 30], ['sign', 'magnet', []], ['flat', 12], ['mark', 'magnetTrigger'], ['flat', 14], ['mark', 'magnetPark'],
        ['flat', 34], ['sign', 'crane', ['あとひとつ', 'だけ']], ['flat', 14], ['mark', 'crane'], ['flat', 22],
        ['sign', 'down', ['急な下り']], ['flat', 6], ['slope', -3.6, 34], ['flat', 6], ['bump', 0.12, 1.6], ['flat', 8], ['goal', 36],
      ],
      events: { magnet: true, crane: true },
      manifest: [
        { type: 'fridge' }, { type: 'sofabed' }, { type: 'cat' }, { type: 'robotbox' }, { type: 'fragile' }, { type: 'shelf' },
        { type: 'box', box: 'L' }, { type: 'box', box: 'M' }, { type: 'box', box: 'M' }, { type: 'box', box: 'S' },
        { type: 'tire' }, { type: 'tire' }, { type: 'plank' }, { type: 'plank' }, { type: 'bowling' }, { type: 'ball' }, { type: 'ball' },
      ],
      bonus: { type: 'bonus' },
      recommended: {
        items: [
          { id: 1, x: 0.76, a: 0 },     // sofa bed on the floor
          { id: 3, x: 1.84, a: 0 },     // robot box at the headboard
          { id: 7, x: 1.84, a: 0 },     // box on it
          { id: 0, x: 0.75, a: 90 },    // fridge lying on the sofa, doors up
          { id: 2, x: 0.72, a: 0 },     // the cat on the fridge, paw towards the front stack
          { id: 4, x: 1.84, a: 0 },     // fragile box on top of the front stack, right where the paw lands
          { id: 14, x: 0.22, a: 0 },    // bowling ball behind the cat
        ],
        belts: [
          { hook: 2, id: 0, u: 0.1, v: 0 },      // bed middle -> fridge body
          { hook: 3, id: 2, u: -0.1, v: 0.1 },   // front rail -> cat
          { hook: 1, id: 2, u: 0.1, v: 0.1 },    // rear of the bed -> cat again (the front stack is loose)
        ],
      },
    },
  ],
};
