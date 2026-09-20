import { deviceSignature } from "./InputDiscovery.js";
import { calibratedSteering, calibratedPedal } from "./WheelCalibration.js";
import { readRawControl, isButtonHeld } from "./ControllerCalibration.js";

// Same spirit as V99Profile's matchesV99Layout, but the profile carries
// its own signature (id + mapping/axis/button counts) instead of one
// hardcoded device string, since this path supports any device.
export function matchesControllerProfile(gamepad, profile) {
  return Boolean(
    gamepad?.connected &&
    profile &&
    deviceSignature(gamepad) === profile.deviceSignature
  );
}

/**
 * Apply only after the user confirms this observed layout via the
 * calibration wizard. A device signature match alone is not universal
 * verification (see V99Profile.js's identical caveat).
 */
export function readControllerInput(gamepad, profile) {
  if (!matchesControllerProfile(gamepad, profile)) {
    return {
      valid: false,
      reason: "Device disconnected or layout changed",
      input: null,
      gearUpHeld: false,
      gearDownHeld: false
    };
  }

  const { mapping, calibration } = profile;
  const manualCapable = Boolean(mapping.clutch);

  const steeringRaw = readRawControl(gamepad, mapping.steering);
  const throttleRaw = readRawControl(gamepad, mapping.throttle);
  const brakeRaw = readRawControl(gamepad, mapping.brake);
  const handbrakeRaw = readRawControl(gamepad, mapping.handbrake);
  const clutchRaw = manualCapable
    ? readRawControl(gamepad, mapping.clutch)
    : 0;

  const steering = steeringRaw === null
    ? null
    : calibratedSteering(steeringRaw, calibration.steering);

  const throttle = throttleRaw === null
    ? null
    : calibratedPedal(throttleRaw, calibration.pedals.throttle);

  const brake = brakeRaw === null
    ? null
    : calibratedPedal(brakeRaw, calibration.pedals.brake);

  const handbrake = handbrakeRaw === null
    ? null
    : calibratedPedal(handbrakeRaw, calibration.pedals.handbrake);

  const clutch = !manualCapable
    ? 0
    : (clutchRaw === null
      ? null
      : calibratedPedal(clutchRaw, calibration.pedals.clutch));

  if ([steering, throttle, brake, handbrake, clutch].some(v => v === null)) {
    return {
      valid: false,
      reason: "Invalid value on a mapped control",
      input: null,
      gearUpHeld: false,
      gearDownHeld: false
    };
  }

  return {
    valid: true,
    reason: null,
    input: { steering, throttle, brake, handbrake, clutch },
    gearUpHeld: manualCapable
      ? isButtonHeld(gamepad, mapping.gearUp)
      : false,
    gearDownHeld: manualCapable
      ? isButtonHeld(gamepad, mapping.gearDown)
      : false
  };
}

// Same safety gate as isV99ReadyToArm: nothing engages until steering is
// centered, every pedal is released, and (for a manual-capable profile)
// the virtual gear is neutral — all held steady for the caller's timer.
export function isControllerReadyToArm(reading, gear) {
  if (!reading.valid) return false;

  const { steering, throttle, brake, clutch } = reading.input;

  return (
    Math.abs(steering) <= 0.1 &&
    throttle <= 0.05 &&
    brake <= 0.05 &&
    clutch <= 0.05 &&
    gear === 0
  );
}
