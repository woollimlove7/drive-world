// ---------------------------------------------------------------------------
// Central, easy-to-tune configuration for the transforming roof turret and
// the practice targets it engages. Values are scaled to Driveworld's own
// world units (see world/World.js / Terrain.js -- a 400x400 unit map, cars
// a couple of meters long) rather than picked arbitrarily.
// ---------------------------------------------------------------------------

export const TURRET_CONFIG = {
  // Mechanical transformation timing (seconds for a full 0 -> 1 sweep).
  deployDuration: 1.15,
  undeployDuration: 0.85,

  // Aiming.
  range: 55,
  rotationSpeed: 3.2, // rad/s, yaw tracking speed
  elevationSpeed: 2.6, // rad/s, pitch tracking speed
  maxElevation: 1.0, // ~57 deg up
  minElevation: -0.2, // ~11 deg down
  aimTolerance: 0.035, // rad, how "on target" before firing is allowed

  // Firing.
  fireRate: 3.5, // rounds per second
  damage: 20,
  muzzleFlashDuration: 0.06,
  recoilDuration: 0.14,
  recoilKick: 0.06,
  tracerSpeed: 140, // world units/sec, purely visual travel speed

  // Target detection cadence. Aiming/tracking still happens every frame;
  // only *scanning for a new target* is throttled.
  targetScanInterval: 0.12
};

export const TARGET_CONFIG = {
  maxTargets: 10,
  minSpawnDistance: 18,
  maxSpawnDistance: 48,
  // Enemies are now ground-based mechanical units, not hovering orbs --
  // this is the vertical offset from terrain height to the model's feet
  // (kept as a config knob rather than always assuming exactly 0, in case
  // a future variant needs a small ground clearance).
  hoverHeight: 0,
  maxHealth: 60,
  respawnDelay: 4
};

// ---------------------------------------------------------------------------
// Enemy/boss gameplay tuning. The "Target" entity (Target.js) is the same
// class for both -- `kind: "normal" | "boss"` picks which half of this
// config it reads. Kept separate from TARGET_CONFIG above (still used for
// hover height / spawn distances / respawn) so nothing there needs to move.
// ---------------------------------------------------------------------------
export const ENEMY_CONFIG = {
  maxEnemies: 10,

  // -------------------------------------------------------------------
  // MECHANICAL ENEMY / BOSS OVERHAUL -- single source of truth for every
  // tunable used by the melee grunt AI (EnemyAI/EnemyCombat, both in
  // Target.js locally and server/EnemyWorld.js authoritatively) and the
  // boss's melee + rocket special. Nothing below is hardcoded anywhere
  // else -- see PROJECT_PROGRESS.md's "Architecture decisions".
  // -------------------------------------------------------------------
  normal: {
    name: "MECHANICAL SENTINEL",
    maxHealth: 90,
    xpReward: 25,
    detectionRange: 32, // grounded melee unit -- shorter than the old ranged 45
    attackRange: 3.4, // melee reach
    attackDamage: 12,
    attackCooldown: 1.6, // seconds between melee swings once in range
    windupDuration: 0.45, // NOTICE -> STRIKE anticipation
    strikeDuration: 0.18, // the actual damage window
    recoveryDuration: 0.55, // STRIKE -> back to CHASE
    moveSpeed: 2.6, // idle roam speed, m/s
    chaseSpeed: 5.2, // aggro chase speed, m/s
    turnSpeed: 4.0, // rad/s facing turn rate
    idleRadius: 9, // max distance from spawnPosition while roaming
    idlePauseMin: 1.5, // seconds paused between idle roam legs
    idlePauseMax: 4.0,
    leashRadius: 45 // give up the chase and return to spawn beyond this
  },

  boss: {
    name: "APEX ARACHNID",
    maxHealth: 1400,
    xpReward: 750,
    detectionRange: 70,
    // Bumped from 7.5 alongside `scale` below -- the front legs' actual
    // world-space reach grows with the model, so the melee hit-check radius
    // needs to grow too or a visually-connecting strike would whiff. Kept
    // just under rocketMinRange (10) so the melee/rocket range split below
    // still behaves the same as before (attack still wins under 10, rocket
    // still owns 10-60) -- a full proportional scale-up (~10.8) would have
    // eaten into that band and made the boss rocket noticeably rarer.
    attackRange: 9.0, // melee leg-strike reach
    attackDamage: 30,
    attackCooldown: 2.4,
    windupDuration: 0.6,
    strikeDuration: 0.22,
    recoveryDuration: 0.7,
    moveSpeed: 2.0,
    chaseSpeed: 4.2,
    turnSpeed: 2.4,
    idleRadius: 14,
    idlePauseMin: 2.0,
    idlePauseMax: 5.0,
    leashRadius: 130,
    respawnDelay: 60,
    initialSpawnDelay: 20, // grace period before the first boss appears
    // Bumped from 3.2 -- "substantially bigger, dominates the battlefield"
    // (see brief). Safe to scale as a single uniform multiplier because the
    // whole model is built with its root at the ground-contact plane (see
    // BossSpiderModel.js's header comment) and every joint/limb is
    // positioned/animated in local space via rotations and relative
    // offsets, not absolute world heights -- so ground contact, leg
    // proportions, and animations all remain correct at any scale. The
    // health bar / name label y-offset (Target.js) and rocket spawn height
    // (Target.js's _scale()) already read this value dynamically, so they
    // scale up automatically too.
    scale: 4.6,

    // ---- rocket launcher special attack ----
    rocketMinRange: 10, // won't bother rocketing a target this close (melee instead)
    rocketMaxRange: 60, // won't rocket a target farther than this -- will chase in
    rocketDamage: 40,
    rocketRadius: 6, // AoE splash radius at impact
    rocketCooldown: 8, // seconds between rocket attacks
    rocketWarningDuration: 2.0, // the required 2-second telegraph countdown
    rocketTravelSpeed: 26 // m/s, visual/logical travel speed after launch
  },

  spawn: {
    minDistance: 18,
    maxDistance: 48,
    bossMinDistance: 60,
    bossMaxDistance: 110,

    // Matches VehiclePhysics.reset()'s spawn point -- fixed in world space,
    // never re-derived from the player's current position, so the zone
    // stays protected even after the player drives away and comes back.
    protectedSpawnCenter: { x: -3, z: -65 },
    protectedSpawnRadius: 35,

    // Extra minimum distance from the fixed player spawn point, deliberately
    // larger than protectedSpawnRadius above so enemies never appear
    // immediately outside the safe zone edge (see requirement #3).
    minDistanceFromPlayerSpawn: 200,
    bossMinDistanceFromPlayerSpawn: 300,

    // Keeps enemies from bunching into a single cluster (requirement #3).
    minDistanceBetweenEnemies: 14,

    // Kept a little inside World.js's boundary walls (+-199).
    worldLimit: 185
  }
};

// ---------------------------------------------------------------------------
// Player HP, leveling and progression. Centralized here alongside the
// enemy config since both feed the same combat loop.
// ---------------------------------------------------------------------------
export const PLAYER_CONFIG = {
  maxHealth: 100,
  respawnDelay: 3, // seconds spent in the death state before respawning -- gives the destruction sequence (explosion, wreck, death screen countdown) room to read
  hpPerLevel: 10, // + max HP each level
  turretDamageLevelInterval: 3, // every N levels...
  turretDamageBonusPerInterval: 0.05 // ...+5% turret damage
};

export const LEVEL_CONFIG = {
  baseXP: 1,
  curveExponent: 1 // xpRequired(level) = baseXP * level^curveExponent
};

// Roof anchor points, in each vehicle's own local space. The local player's
// Vehicle.js roof sits a little higher (panoramic glass roof) than the
// lighter-weight RemoteVehicle.js body, so each gets its own anchor. Both
// are positioned toward the rear of the roof, clear of the sunroof glass
// panel and just ahead of the roof's trailing edge.
export const LOCAL_TURRET_ANCHOR = { x: 0, y: 1.34, z: -0.65 };
export const REMOTE_TURRET_ANCHOR = { x: 0, y: 1.34, z: -0.65 };

export const TURRET_WIRE_STATES = [
  "undeployed",
  "deploying",
  "deployed",
  "undeploying"
];