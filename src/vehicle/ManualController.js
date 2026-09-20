import { ManualDrivetrain } from "./ManualDrivetrain.js";

export class ManualController {
  constructor() {
    this.drivetrain = new ManualDrivetrain();
    this.reset();
  }

  reset() {
    this.drivetrain.reset();
    this.steering = 0;
    this.telemetry = null;
  }

  startEngine(input, shifter, wheelActive) {
    if (!wheelActive || !shifter?.valid) {
      this.drivetrain.message =
        "Activate the wheel and obtain a valid shifter reading first";
      return false;
    }

    return this.drivetrain.start({
      clutch: input.clutch,
      requestedGear: shifter.gear
    });
  }

  update(input, signedSpeed, shifter, wheelActive, dt) {
    if (!wheelActive) {
      // Explicit safety policy:
      // disengage drivetrain, select neutral, remove engine force,
      // and apply brakes. Do not interpret missing hardware as a gear.
      const state = this.drivetrain.update({
        throttle: 0,
        clutch: 1,
        requestedGear: 0,
        speed: signedSpeed
      }, dt);

      this.steering = 0;
      this.telemetry = {
        ...state,
        message: "Wheel inactive — drivetrain disconnected, brakes applied"
      };

      return {
        steeringAngle: 0,
        drive: 0,
        driveForcePerWheel: 0,
        brake: 1,
        handbrake: 0
      };
    }

    const blend = 1 - Math.exp(-9 * dt);
    this.steering += (input.steering - this.steering) * blend;

    // On an ambiguous shifter reading, hold the engaged gear.
    // Never replace an invalid reading with neutral implicitly.
    const requestedGear = shifter?.valid ? shifter.gear : null;

    this.telemetry = this.drivetrain.update({
      throttle: input.throttle,
      clutch: input.clutch,
      requestedGear,
      speed: signedSpeed
    }, dt);

    const speedFactor = 1 / (1 + Math.abs(signedSpeed) * 0.035);

    return {
      steeringAngle: this.steering * 0.48 * speedFactor,
      drive: 0,
      // The current vehicle has two driven rear wheels.
      driveForcePerWheel: this.telemetry.totalWheelForce / 2,
      brake: input.brake,
      handbrake: input.handbrake
    };
  }
}