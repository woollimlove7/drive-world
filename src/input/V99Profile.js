import { decodeV99Shifter } from "./HShifterInput.js";
import {
  defaultCalibration,
  calibratedSteering,
  calibratedPedal
} from "./WheelCalibration.js";

const DEFAULT_CALIBRATION = defaultCalibration();

export const V99_PROFILE_ID = "pxn-v99-user-verified-dinput-v1";

export const V99_DEVICE_ID =
  "PXN-V99 (Vendor: 11ff Product: 3245)";

const DEADZONE = 0.02;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function matchesV99Layout(gamepad) {
  return Boolean(
    gamepad?.connected &&
    gamepad.id === V99_DEVICE_ID &&
    ["", "non-standard"].includes(gamepad.mapping) &&
    gamepad.axes?.length === 10 &&
    gamepad.buttons?.length === 24
  );
}

function isValidAxis(value) {
  return Number.isFinite(value) && value >= -1 && value <= 1;
}

export function normalizeSteering(
  value,
  calibration = DEFAULT_CALIBRATION.steering
) {
  return calibratedSteering(value, calibration);
}

export function normalizePedal(
  value,
  calibration = DEFAULT_CALIBRATION.pedals.throttle
) {
  return calibratedPedal(value, calibration);
}

/**
 * Apply only after the user confirms this observed layout.
 * Matching an ID and input counts alone is not universal verification.
 */
export function readV99Input(
  gamepad,
  calibration = DEFAULT_CALIBRATION
) {
  if (!matchesV99Layout(gamepad)) {
    return {
      valid: false,
      reason: "Device disconnected or layout changed",
      input: null,
      shifter: null
    };
  }

const steering = normalizeSteering(
  gamepad.axes[0],
  calibration.steering
);

const throttle = normalizePedal(
  gamepad.axes[2],
  calibration.pedals.throttle
);

const brake = normalizePedal(
  gamepad.axes[5],
  calibration.pedals.brake
);

const clutch = normalizePedal(
  gamepad.axes[6],
  calibration.pedals.clutch
);

  if ([steering, throttle, brake, clutch].some(value => value === null)) {
    return {
      valid: false,
      reason: "Invalid value on a mapped steering/pedal axis",
      input: null,
      shifter: null
    };
  }

  const shifter = decodeV99Shifter(gamepad, {
    shifterVerified: true,
    neutralVerified: true
  });

  return {
    valid: true,
    reason: null,
    input: {
      steering,
      throttle,
      brake,
      clutch,
      handbrake: 0,
      // Placeholder only when the shifter reading is invalid.
      // A manual controller MUST also check shifter.valid.
      gear: shifter.valid ? shifter.gear : 0,
      gearUp: false,
      gearDown: false
    },
    shifter
  };
}

export function isV99ReadyToArm(reading) {
  if (!reading.valid) return false;

  const input = reading.input;

  return (
    Math.abs(input.steering) <= 0.1 &&
    input.throttle <= 0.05 &&
    input.brake <= 0.05 &&
    input.clutch <= 0.05 &&
    reading.shifter?.valid === true &&
    reading.shifter.gear === 0
  );
}