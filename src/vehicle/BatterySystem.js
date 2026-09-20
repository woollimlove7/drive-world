// ---------------------------------------------------------------------------
// Vehicle battery / energy state machine.
//
// Mirrors TurboSystem.js's shape on purpose: a single CONFIG object, a
// small class that owns its own state and is advanced with update(dt, ...)
// once per fixed physics substep (see Game.js's `while (this.accumulator
// >= FIXED_DT)` loop -- the same place turbo.update() is called), and a
// pure `applyBatteryToControls()` helper for the one gameplay effect
// (movement slowdown) that needs to reach into the drive-controls object,
// exactly like `applyTurboToControls()` does for turbo.
//
// All tunable numbers live in BATTERY_CONFIG so nothing is hardcoded
// elsewhere -- Game.js only ever reads this module's constants/results.
// ---------------------------------------------------------------------------

export const BATTERY_CONFIG = {
  maxBattery: 100,

  // --- drain, in percent/second -------------------------------------------
  // Very slow baseline drain while the vehicle is powered on but parked.
  idleDrainRate: 0.25,

  // Substantially higher than idle, but still much lower than turret drain
  // -- driving around should cost meaningfully less than fighting.
  drivingDrainRate: 0.10,

  // Turret is the primary/high drain. It ramps up the longer it stays
  // continuously deployed (rather than an unbounded runaway rate, the ramp
  // is capped after turretDrainRampCapTime seconds of continuous use).
  turretDrainBaseRate: 1.0,
  turretDrainRampRate: 0.15, // extra %/s drain per second continuously deployed
  turretDrainRampCapTime: 20, // seconds -- ramp bonus stops growing here

  // Speed (m/s) above which the vehicle counts as "driving" rather than
  // "idle" for drain purposes.
  movingSpeedThreshold: 0.3,

  // --- charging ------------------------------------------------------------
  chargingRate: 10, // percent/second while parked in a charging zone

  // --- states ---------------------------------------------------------------
  // battery <= criticalThreshold -> CRITICAL, <= lowThreshold -> LOW,
  // < maxBattery -> NORMAL, otherwise FULL. 0 is always EMPTY regardless of
  // these thresholds.
  lowBatteryThreshold: 40,
  criticalBatteryThreshold: 10,

  // --- empty-battery behavior ------------------------------------------------
  // Multiplies forward/reverse drive force while the battery is fully
  // depleted -- the vehicle can still limp toward a charging station, it
  // just becomes very slow. Turret and turbo are fully gated elsewhere
  // (Game.js) rather than scaled, since "offline"/"disabled" are binary.
  emptyMovementMultiplier: 0.22
};

export const BATTERY_STATE = {
  FULL: "full",
  NORMAL: "normal",
  LOW: "low",
  CRITICAL: "critical",
  EMPTY: "empty"
};

export class BatterySystem {
  constructor(config = BATTERY_CONFIG) {
    this.config = config;
    this.percent = config.maxBattery;

    // Seconds the turret has been continuously engaged (deploying, deployed,
    // or undeploying all count -- the servo/weapon systems are drawing
    // power through the whole transition, not just once fully deployed).
    // Reset to 0 the instant the turret is fully stowed or the vehicle
    // starts charging (see update()).
    this.turretEngagedTime = 0;

    // Whether energy was actually added to the battery on the most recent
    // update() call -- distinct from merely being inside a charging zone,
    // so a vehicle sitting in the zone at 100% correctly reports "not
    // charging" (see requirement: no unnecessary charging at full battery).
    this.charging = false;

    // (newState, oldState) => {} -- fired at most once per actual state
    // transition, never every tick, so callers (Game.js) can drive
    // one-shot effects (forceRetract the turret, show a notice) off it
    // without needing their own edge-detection bookkeeping.
    this.onStateChange = null;

    this._previousState = this.state;
  }

  get depleted() {
    return this.percent <= 0;
  }

  get ratio() {
    return this.config.maxBattery > 0
      ? this.percent / this.config.maxBattery
      : 0;
  }

  get state() {
    const { maxBattery, lowBatteryThreshold, criticalBatteryThreshold } =
      this.config;

    if (this.percent <= 0) return BATTERY_STATE.EMPTY;
    if (this.percent <= criticalBatteryThreshold) return BATTERY_STATE.CRITICAL;
    if (this.percent <= lowBatteryThreshold) return BATTERY_STATE.LOW;
    if (this.percent < maxBattery) return BATTERY_STATE.NORMAL;
    return BATTERY_STATE.FULL;
  }

  // moving: is the vehicle currently driving (vs idle)?
  // turretEngaged: is the turret deploying/deployed/undeploying (vs fully
  //   stowed)?
  // canCharge: is the vehicle currently eligible to recharge this tick
  //   (inside the charging zone, turret stowed, vehicle alive -- decided by
  //   the caller, since only Game.js knows about zones/turret/health)?
  //
  // Returns a small snapshot so callers don't need to read multiple
  // properties back off this instance every tick.
  update(dt, { moving = false, turretEngaged = false, canCharge = false } = {}) {
    dt = Math.max(0, Number.isFinite(dt) ? dt : 0);

    const { maxBattery } = this.config;

    // Charge XOR drain in any given tick -- simplest, most predictable rule,
    // and guarantees the battery is never both drained and charged in the
    // same update (see requirement: avoid accidentally draining/charging
    // the battery multiple times from multiple conditions at once).
    //
    // Being *eligible* to charge (canCharge) always suspends drain, even if
    // the battery happens to already be full -- otherwise a vehicle idling
    // at 100% inside the charging zone would fall through to the drain
    // branch below and start losing charge, which is exactly backwards.
    // `this.charging` (the reported flag) is narrower: it only reflects
    // whether energy is actually being added this tick, so a full battery
    // in the zone correctly reports charging=false (no unnecessary
    // charging) while still not draining.
    if (canCharge) {
      this.charging = this.percent < maxBattery;

      this.percent = Math.min(
        maxBattery,
        this.percent + this.config.chargingRate * dt
      );

      // Charging always implies the turret is stowed (canCharge requires
      // it), so there is nothing to ramp -- keep the ramp timer at 0 so a
      // subsequent deployment starts from the base drain rate again.
      this.turretEngagedTime = 0;
    } else {
      this.charging = false;

      const movementDrainRate = moving
        ? this.config.drivingDrainRate
        : this.config.idleDrainRate;

      let turretDrainRate = 0;

      if (turretEngaged) {
        turretDrainRate =
          this.config.turretDrainBaseRate +
          this.config.turretDrainRampRate *
            Math.min(this.turretEngagedTime, this.config.turretDrainRampCapTime);

        this.turretEngagedTime += dt;
      } else {
        this.turretEngagedTime = 0;
      }

      const totalDrainRate = movementDrainRate + turretDrainRate;
      this.percent = Math.max(0, this.percent - totalDrainRate * dt);
    }

    // Never let floating point drift push it outside [0, maxBattery].
    this.percent = Math.max(0, Math.min(maxBattery, this.percent));

    const newState = this.state;
    if (newState !== this._previousState) {
      const oldState = this._previousState;
      this._previousState = newState;
      this.onStateChange?.(newState, oldState);
    }

    return {
      percent: this.percent,
      ratio: this.ratio,
      state: newState,
      depleted: this.depleted,
      charging: this.charging
    };
  }

  reset() {
    this.percent = this.config.maxBattery;
    this.turretEngagedTime = 0;
    this.charging = false;
    this._previousState = this.state;
  }

  // Compact payload suitable for merging into the player's network state
  // message, matching TurboSystem's `active` field / Turret's
  // getNetworkState() -- not currently wired into MultiplayerClient (see
  // PROJECT_PROGRESS.md's architecture decisions: battery is client-
  // simulated only, same trust boundary as turbo), but kept available for
  // a future remote-presentation use without needing to touch this class.
  getNetworkState() {
    return {
      percent: Math.round(this.percent),
      depleted: this.depleted
    };
  }
}

// Applies the empty-battery movement slowdown to a controls object
// returned by ArcadeController or ManualController, in place, and returns
// it -- mirrors applyTurboToControls() in TurboSystem.js. Only touches
// drive/driveForcePerWheel; brake, handbrake, and steering are left alone
// so the vehicle can still be steered and stopped normally while limping.
export function applyBatteryToControls(controls, batteryState, config = BATTERY_CONFIG) {
  if (!batteryState?.depleted) return controls;

  if (Number.isFinite(controls.drive)) {
    controls.drive *= config.emptyMovementMultiplier;
  }

  if (Number.isFinite(controls.driveForcePerWheel)) {
    controls.driveForcePerWheel *= config.emptyMovementMultiplier;
  }

  return controls;
}