import test from "node:test";
import assert from "node:assert/strict";

import {
  PRESENTATION_DEFAULTS,
  sanitizePresentationSettings
} from "../src/core/PresentationSettings.js";

test("missing settings use defaults", () => {
  assert.deepEqual(
    sanitizePresentationSettings(),
    { ...PRESENTATION_DEFAULTS }
  );
});

test("camera and volume settings are bounded", () => {
  const result = sanitizePresentationSettings({
    driverFov: 1000,
    cameraDistance: -20,
    masterVolume: 4,
    effectsVolume: -1
  });

  assert.equal(result.driverFov, 100);
  assert.equal(result.cameraDistance, 4);
  assert.equal(result.masterVolume, 1);
  assert.equal(result.effectsVolume, 0);
});

test("invalid numeric settings do not propagate", () => {
  const result = sanitizePresentationSettings({
    cameraHeight: NaN,
    lookSensitivity: Infinity,
    engineVolume: "loud"
  });

  assert.equal(
    result.cameraHeight,
    PRESENTATION_DEFAULTS.cameraHeight
  );

  assert.equal(
    result.lookSensitivity,
    PRESENTATION_DEFAULTS.lookSensitivity
  );

  assert.equal(
    result.engineVolume,
    PRESENTATION_DEFAULTS.engineVolume
  );
});

test("vibration can be disabled", () => {
  const result = sanitizePresentationSettings({
    vibrationEnabled: false
  });

  assert.equal(result.vibrationEnabled, false);
});