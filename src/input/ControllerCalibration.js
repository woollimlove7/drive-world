// Generic (non-V99) gamepad calibration. Unlike WheelCalibration.js, the
// wheel/pedal/button LAYOUT itself is unknown ahead of time for an
// arbitrary controller, so a saved profile stores both a `mapping`
// (which axis/button index plays which role) and a `calibration`
// (that control's measured endpoints), keyed to one specific device via
// deviceSignature (see InputDiscovery.js).
import { sanitizeAnalogAxis } from "./WheelCalibration.js";

const STORAGE_KEY = "driveworld.controller.v1";

function validControlRef(control) {
  return Boolean(
    control &&
    (control.type === "axis" || control.type === "button") &&
    Number.isInteger(control.index) &&
    control.index >= 0
  );
}

// Read a control's raw value regardless of whether it's an analog axis
// (range [-1, 1]) or a button reported as analog pressure (range [0, 1]).
// sanitizeAnalogAxis's tolerance band comfortably covers both domains, so
// the same validation/clamping serves either kind without a second path.
export function readRawControl(gamepad, control) {
  if (!control) return null;

  const raw = control.type === "axis"
    ? gamepad.axes[control.index]
    : gamepad.buttons[control.index]?.value;

  return sanitizeAnalogAxis(raw);
}

// Digital press state for a button-mapped control (gear paddles). Only
// meaningful for type "button" — steering/pedals stay analog even when
// physically mapped to a button (e.g. a trigger reported as a button).
export function isButtonHeld(gamepad, control) {
  if (!control || control.type !== "button") return false;
  return Boolean(gamepad.buttons[control.index]?.pressed);
}

function validAxisEndpoint(value) {
  return Number.isFinite(value) && value >= -1 && value <= 1;
}

function validDeadzone(value) {
  return Number.isFinite(value) && value >= 0 && value <= 0.2;
}

// Manual (clutch + sequential gears) is optional — a profile with no
// `clutch`/`gearUp`/`gearDown` mapping is still valid, just Arcade-only.
// clutch and the gear paddles are a package: either all three are present
// (manual-capable) or none are (arcade-only). Partial manual mapping is
// rejected rather than silently degraded.
export function validateControllerProfile(profile) {
  if (!profile?.deviceSignature || typeof profile.deviceSignature !== "string") {
    return "Missing device signature.";
  }

  const mapping = profile.mapping;
  const calibration = profile.calibration;

  if (!mapping || !calibration) {
    return "Missing mapping or calibration.";
  }

  if (!validControlRef(mapping.steering) || mapping.steering.type !== "axis") {
    return "Steering must be mapped to an analog axis.";
  }

  for (const name of ["throttle", "brake", "handbrake"]) {
    if (!validControlRef(mapping[name])) {
      return `Missing or invalid ${name} mapping.`;
    }
  }

  const manualControls = [mapping.clutch, mapping.gearUp, mapping.gearDown];
  const manualPresent = manualControls.filter(Boolean).length;

  if (manualPresent !== 0 && manualPresent !== 3) {
    return "Clutch, shift up, and shift down must all be mapped together, " +
      "or all left unmapped for Arcade-only.";
  }

  if (manualPresent === 3) {
    if (!validControlRef(mapping.clutch)) return "Invalid clutch mapping.";

    if (
      !validControlRef(mapping.gearUp) ||
      mapping.gearUp.type !== "button"
    ) {
      return "Shift up must be mapped to a button.";
    }

    if (
      !validControlRef(mapping.gearDown) ||
      mapping.gearDown.type !== "button"
    ) {
      return "Shift down must be mapped to a button.";
    }

    if (
      mapping.gearUp.type === mapping.gearDown.type &&
      mapping.gearUp.index === mapping.gearDown.index
    ) {
      return "Shift up and shift down cannot be the same button.";
    }
  }

  const steer = calibration.steering;

  if (
    !steer ||
    ![steer.left, steer.center, steer.right].every(validAxisEndpoint) ||
    !validDeadzone(steer.deadzone)
  ) {
    return "Invalid steering calibration.";
  }

  const leftRange = steer.left - steer.center;
  const rightRange = steer.right - steer.center;

  if (
    Math.abs(leftRange) < 0.2 ||
    Math.abs(rightRange) < 0.2 ||
    leftRange * rightRange >= 0
  ) {
    return "Steering endpoints must lie on opposite sides of center.";
  }

  const pedalNames = manualPresent === 3
    ? ["throttle", "brake", "handbrake", "clutch"]
    : ["throttle", "brake", "handbrake"];

  for (const name of pedalNames) {
    const pedal = calibration.pedals?.[name];

    if (
      !pedal ||
      !validAxisEndpoint(pedal.released) ||
      !validAxisEndpoint(pedal.pressed) ||
      !validDeadzone(pedal.deadzone)
    ) {
      return `Invalid ${name} calibration.`;
    }

    if (Math.abs(pedal.pressed - pedal.released) < 0.2) {
      return `${name}: pressed and released positions are too similar.`;
    }
  }

  return null;
}

export function saveControllerProfile(profile) {
  const error = validateControllerProfile(profile);

  if (error) {
    throw new Error(error);
  }

  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, profile })
    );

    return true;
  } catch {
    return false;
  }
}

export function loadControllerProfile() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));

    if (
      saved?.version === 1 &&
      validateControllerProfile(saved.profile) === null
    ) {
      return saved.profile;
    }
  } catch {
    // Missing, blocked, or invalid storage: no saved profile.
  }

  return null;
}

export function clearControllerProfile() {
  try {
    localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
