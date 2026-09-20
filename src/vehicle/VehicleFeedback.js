const clamp = (value, min, max) =>
  Math.min(max, Math.max(min, value));

export class VehicleFeedback {
  constructor() {
    this.reset();
  }

  reset() {
    this.previousMode = null;
    this.previousEngineRunning = null;
    this.previousSpeed = null;
    this.previousSuspension = [];

    this.acceleration = 0;
    this.suspensionCooldown = 0;
  }

  update({
    manual,
    engineRunning,
    rpm,
    engagedGear,
    clutchTorque,
    signedSpeed,
    suspensionLengths
  }, dt) {
    const events = [];

    // Clamp long presentation intervals; physics already uses fixed steps.
    dt = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;

    const modeChanged =
      this.previousMode !== null &&
      this.previousMode !== manual;

    // Switching driving modes is not an engine start or stall event.
    if (
      manual &&
      !modeChanged &&
      this.previousEngineRunning !== null
    ) {
      if (!this.previousEngineRunning && engineRunning) {
        events.push({ type: "engine-start" });
      }

      if (this.previousEngineRunning && !engineRunning) {
        events.push({ type: "engine-stop" });
      }
    }

    if (modeChanged) {
      this.previousSpeed = null;
      this.acceleration = 0;
    }

    if (dt > 0 && this.previousSpeed !== null) {
      const measuredAcceleration = clamp(
        (signedSpeed - this.previousSpeed) / dt,
        -15,
        15
      );

      const blend = 1 - Math.exp(-8 * dt);

      this.acceleration +=
        (measuredAcceleration - this.acceleration) * blend;
    }

    this.suspensionCooldown = Math.max(
      0,
      this.suspensionCooldown - dt
    );

    let strongestCompression = 0;

    suspensionLengths.forEach((length, index) => {
      const previous = this.previousSuspension[index];

      // Null indicates an airborne wheel. Landing is not measured as an
      // enormous suspension-speed jump from an unrelated previous length.
      if (
        dt > 0 &&
        Number.isFinite(length) &&
        Number.isFinite(previous)
      ) {
        const compressionSpeed = (previous - length) / dt;
        strongestCompression = Math.max(
          strongestCompression,
          compressionSpeed
        );
      }
    });

    if (
      strongestCompression > 0.7 &&
      Math.abs(signedSpeed) > 1 &&
      this.suspensionCooldown === 0
    ) {
      events.push({
        type: "suspension",
        strength: clamp(
          (strongestCompression - 0.7) / 2.5,
          0.1,
          1
        )
      });

      this.suspensionCooldown = 0.16;
    }

    this.previousMode = manual;
    this.previousEngineRunning = engineRunning;
    this.previousSpeed = signedSpeed;
    this.previousSuspension = suspensionLengths.slice();

    const lugging =
      manual && engineRunning && engagedGear !== 0
        ? clamp((850 - rpm) / 450, 0, 1) *
          clamp(Math.abs(clutchTorque) / 120, 0, 1)
        : 0;

    return {
      acceleration: this.acceleration,
      lugging,
      events
    };
  }
}