const STORAGE_KEY = "driveworld.v99-calibration.v1";
const PROFILE_ID = "pxn-v99-user-verified-dinput-v1";

// Small tolerance for observed browser/device endpoint overshoot.
// This is deliberately much smaller than ordinary control movement.
const AXIS_ENDPOINT_TOLERANCE = 0.0001;

const clamp = (value, min, max) =>
  Math.min(max, Math.max(min, value));

export function defaultCalibration() {
  return {
    steering: {
      left: -1,
      center: 0,
      right: 1,
      deadzone: 0.02
    },
    pedals: {
      throttle: {
        released: -1,
        pressed: 1,
        deadzone: 0.02
      },
      brake: {
        released: -1,
        pressed: 1,
        deadzone: 0.02
      },
      clutch: {
        released: -1,
        pressed: 1,
        deadzone: 0.02
      }
    }
  };
}

/**
 * Accept tiny endpoint overshoot, then normalize it to [-1, 1].
 *
 * Large out-of-range values, NaN, Infinity, and unavailable axes
 * remain invalid. Never convert arbitrary device data into a
 * fully pressed control.
 */
export function sanitizeAnalogAxis(value) {
  if (
    !Number.isFinite(value) ||
    value < -1 - AXIS_ENDPOINT_TOLERANCE ||
    value > 1 + AXIS_ENDPOINT_TOLERANCE
  ) {
    return null;
  }

  return clamp(value, -1, 1);
}

function validAxis(value) {
  // Stored calibration endpoints must already be sanitized.
  return Number.isFinite(value) && value >= -1 && value <= 1;
}

function validDeadzone(value) {
  return Number.isFinite(value) && value >= 0 && value <= 0.2;
}

export function validateCalibration(calibration) {
  const steering = calibration?.steering;

  if (!steering) {
    return "Missing steering calibration.";
  }

  if (
    ![
      steering.left,
      steering.center,
      steering.right
    ].every(validAxis) ||
    !validDeadzone(steering.deadzone)
  ) {
    return "Invalid steering values.";
  }

  const leftRange = steering.left - steering.center;
  const rightRange = steering.right - steering.center;

  if (
    Math.abs(leftRange) < 0.2 ||
    Math.abs(rightRange) < 0.2 ||
    leftRange * rightRange >= 0
  ) {
    return "Steering endpoints must lie on opposite sides of center.";
  }

  for (const name of ["throttle", "brake", "clutch"]) {
    const pedal = calibration?.pedals?.[name];

    if (
      !pedal ||
      !validAxis(pedal.released) ||
      !validAxis(pedal.pressed) ||
      !validDeadzone(pedal.deadzone)
    ) {
      return `Invalid ${name} calibration.`;
    }

    if (Math.abs(pedal.pressed - pedal.released) < 0.25) {
      return `${name}: released and pressed positions are too similar.`;
    }
  }

  return null;
}

export function calibratedSteering(value, calibration) {
  value = sanitizeAnalogAxis(value);

  if (value === null) return null;

  const {
    left,
    center,
    right,
    deadzone
  } = calibration;

  const delta = value - center;

  if (delta === 0) return 0;

  const onRightSide = delta * (right - center) > 0;
  const endpoint = onRightSide ? right : left;

  const magnitude = clamp(
    Math.abs(delta / (endpoint - center)),
    0,
    1
  );

  const adjusted = clamp(
    (magnitude - deadzone) / (1 - deadzone),
    0,
    1
  );

  // Avoid returning negative zero.
  return adjusted === 0
    ? 0
    : adjusted * (onRightSide ? 1 : -1);
}

export function calibratedPedal(value, calibration) {
  value = sanitizeAnalogAxis(value);

  if (value === null) return null;

  const {
    released,
    pressed,
    deadzone
  } = calibration;

  // Supports pedals whose raw value decreases when pressed.
  const position = clamp(
    (value - released) / (pressed - released),
    0,
    1
  );

  return clamp(
    (position - deadzone) / (1 - deadzone),
    0,
    1
  );
}

export function loadWheelCalibration() {
  try {
    const saved = JSON.parse(
      localStorage.getItem(STORAGE_KEY)
    );

    if (
      saved?.version === 1 &&
      saved.profileId === PROFILE_ID &&
      validateCalibration(saved.calibration) === null
    ) {
      return saved.calibration;
    }
  } catch {
    // Missing, blocked, or invalid storage uses verified defaults.
  }

  return defaultCalibration();
}

export function saveWheelCalibration(calibration) {
  const error = validateCalibration(calibration);

  if (error) {
    throw new Error(error);
  }

  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        profileId: PROFILE_ID,
        calibration
      })
    );

    return true;
  } catch {
    return false;
  }
}