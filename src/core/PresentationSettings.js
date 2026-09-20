const STORAGE_KEY = "driveworld.presentation.v1";

export const PRESENTATION_DEFAULTS = Object.freeze({
  driverFov: 72,
  chaseFov: 65,
  cameraDistance: 7.5,
  cameraHeight: 3.2,
  lookSensitivity: 0.003,
  vibrationEnabled: true,

  masterVolume: 0.3,
  engineVolume: 1,
  environmentVolume: 1,
  effectsVolume: 1
});

const RANGES = {
  driverFov: [50, 100],
  chaseFov: [50, 100],
  cameraDistance: [4, 14],
  cameraHeight: [1.5, 6],
  lookSensitivity: [0.001, 0.008],

  masterVolume: [0, 1],
  engineVolume: [0, 1],
  environmentVolume: [0, 1],
  effectsVolume: [0, 1]
};

export function sanitizePresentationSettings(raw = {}) {
  const result = { ...PRESENTATION_DEFAULTS };

  for (const [key, [min, max]] of Object.entries(RANGES)) {
    const value = raw[key];

    if (typeof value === "number" && Number.isFinite(value)) {
      result[key] = Math.min(max, Math.max(min, value));
    }
  }

  if (typeof raw.vibrationEnabled === "boolean") {
    result.vibrationEnabled = raw.vibrationEnabled;
  }

  return result;
}

export function loadPresentationSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));

    return sanitizePresentationSettings(
      stored?.version === 1 ? stored.values : {}
    );
  } catch {
    return { ...PRESENTATION_DEFAULTS };
  }
}

export function savePresentationSettings(values) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      values: sanitizePresentationSettings(values)
    }));

    return true;
  } catch {
    return false;
  }
}