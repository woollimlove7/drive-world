const PXN_V99_GEAR_BUTTONS = Object.freeze([
  { gear: 1, button: 16 },
  { gear: 2, button: 17 },
  { gear: 3, button: 18 },
  { gear: 4, button: 19 },
  { gear: 5, button: 20 },
  { gear: 6, button: 21 },
  { gear: -1, button: 22 }
]);

/**
 * Observed mapping:
 * PXN V99, Windows 10, Chrome, DInput mode.
 *
 * Use only with an explicitly selected/verified device.
 * This is not a universal mapping for every PXN V99 configuration.
 *
 * Neutral is valid only after its all-released pattern is verified.
 * "detected" must come from prior shifter verification, not a wheel ID.
 */
export function decodeV99Shifter(
  gamepad,
  {
    shifterVerified = false,
    neutralVerified = false
  } = {}
) {
  const invalid = (reason) => ({
    type: "H_PATTERN",
    detected: Boolean(shifterVerified && gamepad?.connected),
    valid: false,
    gear: null,
    reason
  });

  if (!gamepad?.connected) {
    return invalid("Device disconnected");
  }

  if (!shifterVerified) {
    return invalid("Shifter mapping not verified");
  }

  const activeGears = [];

  for (const { gear, button: index } of PXN_V99_GEAR_BUTTONS) {
    const button = gamepad.buttons?.[index];

    if (
      !button ||
      typeof button.pressed !== "boolean" ||
      !Number.isFinite(button.value) ||
      button.value < 0 ||
      button.value > 1
    ) {
      return invalid(`Missing or invalid gear button ${index}`);
    }

    if (button.pressed || button.value >= 0.5) {
      activeGears.push(gear);
    }
  }

  if (activeGears.length > 1) {
    return invalid("Conflicting gear buttons");
  }

  if (activeGears.length === 0 && !neutralVerified) {
    return invalid("Neutral pattern not verified");
  }

  return {
    type: "H_PATTERN",
    detected: true,
    valid: true,
    gear: activeGears[0] ?? 0,
    reason: null
  };
}