const clamp = (value, min, max) =>
  Math.min(max, Math.max(min, value));

const RPM_TO_RAD = Math.PI / 30;
const RAD_TO_RPM = 30 / Math.PI;

export const MANUAL_CONFIG = Object.freeze({
  ratios: Object.freeze({
    "-1": -3.2,
    "0": 0,
    "1": 3.5,
    "2": 2.2,
    "3": 1.5,
    "4": 1.1,
    "5": 0.88,
    "6": 0.72
  }),

  finalDrive: 3.9,
  efficiency: 0.9,
  wheelRadius: 0.36,

  engineInertia: 0.3,
  idleRPM: 900,
  stallRPM: 430,
  revLimitRPM: 6500,

  maxClutchTorque: 260,
  clutchSlipStiffness: 5
});

export class ManualDrivetrain {
  constructor() {
    this.reset();
  }

  reset() {
    this.engineRunning = false;
    this.engineOmega = 0;
    this.engagedGear = 0;
    this.requestedGear = 0;
    this.stallTimer = 0;
    this.message = "Engine stopped";
    this.clutchTorque = 0;
  }

  get rpm() {
    return this.engineOmega * RAD_TO_RPM;
  }

  start({ clutch = 0, requestedGear = 0 } = {}) {
    if (this.engineRunning) return true;

    // Do not start with an engaged drivetrain unless the clutch is down.
    const inGear =
      this.engagedGear !== 0 || requestedGear !== 0;

    if (inGear && clutch < 0.9) {
      this.message = "Press clutch fully before starting in gear";
      return false;
    }

    this.engineRunning = true;
    this.engineOmega = MANUAL_CONFIG.idleRPM * RPM_TO_RAD;
    this.stallTimer = 0;
    this.message = "Engine running";
    return true;
  }

  selectGear(requestedGear, clutch, speed) {
    if (
      !Number.isInteger(requestedGear) ||
      requestedGear < -1 ||
      requestedGear > 6
    ) {
      this.message = "Invalid shifter reading — holding engaged gear";
      return;
    }

    this.requestedGear = requestedGear;

    if (requestedGear === this.engagedGear) {
      this.message = this.engineRunning
        ? "Engine running"
        : "Engine stopped";
      return;
    }

    // Genuine neutral: there is no engine-to-wheel torque path.
    if (requestedGear === 0) {
      this.engagedGear = 0;
      this.message = "Neutral";
      return;
    }

    if (clutch < 0.85) {
      this.message = "Press clutch fully to engage requested gear";
      return;
    }

    // Reject selecting a gear that would drive opposite current motion.
    if (
      (requestedGear === -1 && speed > 0.5) ||
      (requestedGear > 0 && speed < -0.5)
    ) {
      this.message = "Stop before changing driving direction";
      return;
    }

    const totalRatio =
      MANUAL_CONFIG.ratios[requestedGear] *
      MANUAL_CONFIG.finalDrive;

    const projectedRPM = Math.abs(
      (speed / MANUAL_CONFIG.wheelRadius) *
      totalRatio *
      RAD_TO_RPM
    );

    // Prototype protection, not a damage/synchronizer simulation.
    if (projectedRPM > MANUAL_CONFIG.revLimitRPM * 1.08) {
      this.message = "Downshift rejected — projected engine overspeed";
      return;
    }

    this.engagedGear = requestedGear;
    this.message = "Gear engaged";
  }

  update({ throttle, clutch, requestedGear, speed }, dt) {
    throttle = clamp(throttle, 0, 1);
    clutch = clamp(clutch, 0, 1);

    this.selectGear(requestedGear, clutch, speed);

    const config = MANUAL_CONFIG;
    const totalRatio =
      config.ratios[this.engagedGear] * config.finalDrive;

    // Ground-speed approximation. Later replaced by driven-wheel shaft
    // speed from a rotational wheel/drivetrain model.
    const gearboxOmega =
      (speed / config.wheelRadius) * totalRatio;

    // Pressed pedal = disengaged clutch.
    // The nonlinear curve creates a controllable bite region.
    const capacity =
      config.maxClutchTorque * Math.pow(1 - clutch, 2);

    // Substep the stiff clutch/engine interaction for numerical stability.
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;

    let accumulatedClutchTorque = 0;

    for (let i = 0; i < steps; i++) {
      const rpm = this.rpm;

      // Simple broad torque curve; replaceable with a vehicle data curve.
      const curvePosition = (rpm - 3500) / 3500;
      const availableTorque =
        185 * clamp(1 - 0.35 * curvePosition * curvePosition, 0.45, 1);

      const belowRevLimit = rpm < config.revLimitRPM;

      // Idle assistance can support idle, but cannot prevent a harsh
      // clutch release from overloading the engine.
      const idleAssist = clamp(
        (config.idleRPM - rpm) * 0.18,
        0,
        65
      );

      const combustionTorque =
        this.engineRunning && belowRevLimit
          ? throttle * availableTorque + idleAssist
          : 0;

      const engineDrag = this.engineOmega > 0
        ? 12 +
          0.018 * this.engineOmega +
          0.00004 * this.engineOmega * this.engineOmega
        : 0;

      const slip = this.engineOmega - gearboxOmega;

      const clutchTorque = totalRatio === 0
        ? 0
        : clamp(
            slip * config.clutchSlipStiffness,
            -capacity,
            capacity
          );

      // Clutch torque reacts against the engine as well as driving
      // the wheels. Negative clutch torque back-drives the engine.
      const angularAcceleration =
        (combustionTorque - engineDrag - clutchTorque) /
        config.engineInertia;

      this.engineOmega = Math.max(
        0,
        this.engineOmega + angularAcceleration * h
      );

      if (this.engineRunning && this.rpm < config.stallRPM) {
        this.stallTimer += h;

        if (this.stallTimer >= 0.12) {
          this.engineRunning = false;
          this.message = "Engine stalled — press clutch and restart";
        }
      } else {
        this.stallTimer = 0;
      }

      accumulatedClutchTorque += clutchTorque;
    }

    this.clutchTorque = accumulatedClutchTorque / steps;

    const totalWheelForce =
      this.clutchTorque *
      totalRatio *
      config.efficiency /
      config.wheelRadius;

    return {
      rpm: this.rpm,
      engineRunning: this.engineRunning,
      engagedGear: this.engagedGear,
      requestedGear: this.requestedGear,
      clutchTorque: this.clutchTorque,
      totalWheelForce,
      message: this.message
    };
  }
}