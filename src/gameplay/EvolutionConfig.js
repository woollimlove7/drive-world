// ---------------------------------------------------------------------------
// SINGLE SOURCE OF TRUTH for vehicle/turret progression visuals.
//
// Every place that needs to know "what should this player's car/turret look
// like at level N" -- Vehicle.js, RemoteVehicle.js, Turret.js, RemoteTurret.js,
// MultiplayerClient.js, and server/server.js -- imports getEvolutionStage()
// and the two config tables below instead of re-deriving its own level
// thresholds. This is what keeps a Level 6 player looking identical (Heavy
// Combat vehicle + Dual Gatling turret) to every observer, including the
// server's own authoritative bookkeeping.
//
// Stage is intentionally decoupled from level: level climbs by 1 every
// level-up, stage only advances at the milestones in EVOLUTION_MILESTONES
// and never regresses in between (see getEvolutionStage's doc comment).
// ---------------------------------------------------------------------------

// Levels at which a new evolution stage unlocks. Index into this array *is*
// the stage number, so EVOLUTION_MILESTONES[3] === 15 means "stage 3 unlocks
// at level 15". Extending progression later (level 25, 30, ...) is just
// appending here plus one more entry in each config table below.
export const EVOLUTION_MILESTONES = [1, 5, 10, 15, 20, 25];

// Level 1 -> stage 0, level 3 -> stage 1, level 10+ -> stage 5 (max), etc.
// Deterministic and monotonic: a stage is never lost between milestones.
export function getEvolutionStage(level) {
  const lvl = Number.isFinite(level) ? Math.max(1, Math.floor(level)) : 1;
  let stage = 0;
  for (let i = 0; i < EVOLUTION_MILESTONES.length; i++) {
    if (lvl >= EVOLUTION_MILESTONES[i]) stage = i;
  }
  return stage;
}

export const MAX_EVOLUTION_STAGE = EVOLUTION_MILESTONES.length - 1;

function clampStage(stage) {
  const s = Number.isInteger(stage) ? stage : 0;
  return Math.max(0, Math.min(MAX_EVOLUTION_STAGE, s));
}

// ---------------------------------------------------------------------------
// Vehicle armor evolution. Purely cosmetic (no gameplay/physics values) --
// VehicleEvolution.js is what turns `name`/`stage` into actual geometry.
// ---------------------------------------------------------------------------
export const VEHICLE_EVOLUTION_CONFIG = [
  { stage: 0, level: 1, name: "Default", label: "DEFAULT" },
  { stage: 1, level: 5, name: "Reinforced", label: "REINFORCED" },
  { stage: 2, level: 10, name: "Armored", label: "ARMORED" },
  { stage: 3, level: 15, name: "Heavy Combat", label: "HEAVY COMBAT" },
  { stage: 4, level: 20, name: "Elite", label: "ELITE ARMORED" },
  { stage: 5, level: 25, name: "Ultimate", label: "ULTIMATE" }
];

export function getVehicleEvolutionConfig(stage) {
  return VEHICLE_EVOLUTION_CONFIG[clampStage(stage)];
}

// ---------------------------------------------------------------------------
// Turret/weapon evolution. `fireRateMultiplier` and `damageMultiplier` feed
// into Turret.js's existing TURRET_CONFIG.fireRate/damage + damageMultiplier
// pipeline (see requirement #7/#8) rather than replacing it, so the
// existing level-interval turret damage bonus (PLAYER_CONFIG) keeps working
// unchanged and just gets multiplied again per weapon stage.
//
// `mounts` is how many simultaneous, independently-aimed muzzle points fire
// each shot (2 for the dual configurations) -- each mount takes its own
// damage roll, so "dual" roughly doubles throughput rather than being
// cosmetic-only. `barrelsPerMount` is purely visual (gatling barrel count).
// ---------------------------------------------------------------------------
export const TURRET_EVOLUTION_CONFIG = [
  {
    stage: 0, level: 1, name: "Default Gun", label: "DEFAULT GUN",
    weaponType: "single", mounts: 1, barrelsPerMount: 1,
    fireRateMultiplier: 1, damageMultiplier: 1, animationDuration: 1.6
  },
  {
    stage: 1, level: 5, name: "Gatling Gun", label: "GATLING GUN",
    weaponType: "gatling", mounts: 1, barrelsPerMount: 4,
    fireRateMultiplier: 1.8, damageMultiplier: 0.6, animationDuration: 1.8
  },
  {
    stage: 2, level: 10, name: "Dual Gun", label: "DUAL GUN TURRET",
    weaponType: "dual", mounts: 2, barrelsPerMount: 1,
    fireRateMultiplier: 1, damageMultiplier: 0.65, animationDuration: 2.0
  },
  {
    stage: 3, level: 15, name: "Dual Gatling", label: "DUAL GATLING GUN",
    weaponType: "dualGatling", mounts: 2, barrelsPerMount: 4,
    fireRateMultiplier: 1.8, damageMultiplier: 0.5, animationDuration: 2.3
  },
  {
    stage: 4, level: 20, name: "Advanced Heavy Weapon", label: "ADVANCED HEAVY WEAPON",
    weaponType: "heavy", mounts: 1, barrelsPerMount: 3,
    fireRateMultiplier: 1.4, damageMultiplier: 1.6, animationDuration: 2.6
  },
  {
    stage: 5, level: 25, name: "Ultimate Missile System", label: "ULTIMATE WEAPON",
    weaponType: "missile", mounts: 1, barrelsPerMount: 0, missilePods: 2,
    fireRateMultiplier: 0.55, damageMultiplier: 3.4, animationDuration: 3.0
  }
];

export function getTurretEvolutionConfig(stage) {
  return TURRET_EVOLUTION_CONFIG[clampStage(stage)];
}
