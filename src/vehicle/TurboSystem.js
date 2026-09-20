// ---------------------------------------------------------------------------
// Turbo / boost state machine.
//
// One instance is owned by Game and driven once per fixed physics tick.
// Both desktop (SHIFT, see InputManager.isTurboRequested) and mobile (the
// on-screen turbo button, see MobileControls) feed the same `requested`
// boolean into update() -- there is exactly one turbo implementation, never
// two competing ones.
//
// All tunable numbers live in TURBO_CONFIG so they only need to change in
// one place.
// ---------------------------------------------------------------------------

export const TURBO_CONFIG = {
  // Seconds the player must wait after releasing turbo before it can be
  // activated again.
  cooldown: 2,

  // Maximum seconds turbo can stay active in one continuous use, even if
  // the player keeps SHIFT/the mobile button held the whole time. Once hit,
  // turbo ends exactly like a manual release (into the cooldown below) --
  // this is what stops turbo from being usable indefinitely.
  duration: 3,

  // Multiplies forward drive force while turbo is active. Kept moderate so
  // the existing acceleration/friction/handling tuning still feels like
  // itself, just quicker.
  accelerationMultiplier: 1.6,

  // Arcade-mode "throttle equivalent" turbo applies on its own so holding
  // only SHIFT/the mobile turbo button (no throttle) still moves the car,
  // not just boosts an existing throttle input. Normalized 0-1, same scale
  // as input.throttle. Only takes effect while not braking/reversing (see
  // Game.js) so turbo can't fight the player's brake input.
  soloDriveStrength: 0.55,

  // Upper bound applied to the multiplier wherever it's used, so a future
  // config change can't accidentally introduce runaway acceleration.
  maxAccelerationMultiplier: 2.2
};

export class TurboSystem {
  constructor(config = TURBO_CONFIG) {
    this.config = config;
    this.active = false;
    this.cooldownRemaining = 0;
    this.activeElapsed = 0;
  }

  get ready() {
    return this.cooldownRemaining <= 0;
  }

  // "ready" | "active" | "cooldown" -- drives both the dashboard pill and
  // the mobile turbo button's visual state.
  get state() {
    if (this.active) return "active";
    if (this.cooldownRemaining > 0) return "cooldown";
    return "ready";
  }

  get cooldownFraction() {
    return this.config.cooldown > 0
      ? Math.min(1, this.cooldownRemaining / this.config.cooldown)
      : 0;
  }

  // Seconds of continuous boost left before it force-ends on its own.
  get durationRemaining() {
    return this.active
      ? Math.max(0, this.config.duration - this.activeElapsed)
      : 0;
  }

  get multiplier() {
    return this.active
      ? Math.min(
          this.config.maxAccelerationMultiplier,
          this.config.accelerationMultiplier
        )
      : 1;
  }

  // requested: is the player currently holding the turbo control (SHIFT or
  // the mobile button)? Returns the new state for callers (Game, UI) that
  // want the same-frame result without reading properties back off.
  update(requested, dt) {
    dt = Math.max(0, Number.isFinite(dt) ? dt : 0);

    if (this.cooldownRemaining > 0) {
      this.cooldownRemaining = Math.max(0, this.cooldownRemaining - dt);
    }

    const wasActive = this.active;
    let justDeactivated = false;

    // Activate first, then advance elapsed -- so the very tick turbo turns
    // on already counts toward its duration budget instead of a free frame
    // slipping through uncounted.
    if (!this.active && requested && this.ready) {
      this.active = true;
      this.activeElapsed = 0;
    }

    if (this.active) {
      this.activeElapsed += dt;
    }

    const durationExceeded =
      this.active && this.activeElapsed >= this.config.duration;

    if (this.active && (durationExceeded || !requested)) {
      // Boost ends here -- either the player let go, or they ran out the
      // max continuous-boost duration (held or not, it stops either way).
      // Same cooldown consequence in both cases, so duration can't be
      // used to dodge the cooldown by holding through it.
      this.active = false;
      this.activeElapsed = 0;
      this.cooldownRemaining = this.config.cooldown;
      justDeactivated = true;
    }

    return {
      active: this.active,
      justActivated: this.active && !wasActive,
      justDeactivated,
      state: this.state,
      cooldownRemaining: this.cooldownRemaining,
      cooldownFraction: this.cooldownFraction,
      durationRemaining: this.durationRemaining,
      multiplier: this.multiplier
    };
  }

  reset() {
    this.active = false;
    this.cooldownRemaining = 0;
    this.activeElapsed = 0;
  }
}

// Applies an active turbo boost to a controls object returned by
// ArcadeController or ManualController, in place, and returns it.
//
// Pulled out of Game.js as a pure function so the actual boost math (in
// particular "turbo alone, with no throttle at all, still moves the car")
// can be unit-tested without a THREE/cannon-es environment.
export function applyTurboToControls(controls, turboState, config = TURBO_CONFIG) {
  if (!turboState.active) return controls;

  // Arcade mode: turbo alone (no throttle at all) still moves the car, not
  // just boosts an existing throttle input -- as long as the player isn't
  // braking, handbraking, or already reversing, so turbo can't fight the
  // player's brakes. (ManualController doesn't produce a `drive` field, so
  // this is a no-op for manual mode -- see the driveForcePerWheel handling
  // below instead.)
  if (
    Number.isFinite(controls.drive) &&
    controls.drive >= 0 &&
    !(controls.brake > 0) &&
    !(controls.handbrake > 0)
  ) {
    controls.drive = Math.max(controls.drive, config.soloDriveStrength);
  }

  if (controls.drive > 0) {
    controls.drive *= turboState.multiplier;
  }

  if (
    Number.isFinite(controls.driveForcePerWheel) &&
    controls.driveForcePerWheel > 0
  ) {
    controls.driveForcePerWheel *= turboState.multiplier;
  }

  return controls;
}
