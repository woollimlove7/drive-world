import test from "node:test";
import assert from "node:assert/strict";

import {
  defaultCalibration,
  validateCalibration,
  calibratedSteering,
  calibratedPedal,
  sanitizeAnalogAxis
} from "../src/input/WheelCalibration.js";

test("default calibration is valid", () => {
  assert.equal(
    validateCalibration(defaultCalibration()),
    null
  );
});

test("default calibration returns independent objects", () => {
  const first = defaultCalibration();
  const second = defaultCalibration();

  first.pedals.throttle.pressed = 0.8;

  assert.equal(second.pedals.throttle.pressed, 1);
});

test("steering uses separately calibrated left and right ranges", () => {
  const steering = {
    left: -0.85,
    center: 0.04,
    right: 0.95,
    deadzone: 0.02
  };

  assert.equal(calibratedSteering(-0.85, steering), -1);
  assert.equal(calibratedSteering(0.04, steering), 0);
  assert.equal(calibratedSteering(0.95, steering), 1);
});

test("steering calibration can normalize an inverted axis", () => {
  const steering = {
    left: 1,
    center: 0,
    right: -1,
    deadzone: 0.02
  };

  assert.equal(calibratedSteering(1, steering), -1);
  assert.equal(calibratedSteering(-1, steering), 1);
});

test("pedal calibration supports inverted endpoints", () => {
  const pedal = {
    released: 1,
    pressed: -1,
    deadzone: 0.02
  };

  assert.equal(calibratedPedal(1, pedal), 0);
  assert.equal(calibratedPedal(-1, pedal), 1);
});

test("small resting steering noise is removed", () => {
  const calibration = defaultCalibration();

  assert.equal(
    calibratedSteering(0.004, calibration.steering),
    0
  );
});

test("identical pedal endpoints are rejected", () => {
  const calibration = defaultCalibration();

  calibration.pedals.clutch.pressed = -1;

  assert.match(
    validateCalibration(calibration),
    /clutch.*too similar/
  );
});

test("steering endpoints on the same side of center are rejected", () => {
  const calibration = defaultCalibration();

  calibration.steering.left = 0.4;
  calibration.steering.right = 1;

  assert.match(
    validateCalibration(calibration),
    /opposite sides/
  );
});

test("invalid raw analog values are rejected, not clamped", () => {
  const calibration = defaultCalibration();

  assert.equal(
    calibratedPedal(
      1227133568,
      calibration.pedals.throttle
    ),
    null
  );

  assert.equal(
    calibratedSteering(NaN, calibration.steering),
    null
  );
});

test("observed V99 endpoint overshoot is accepted narrowly", () => {
  assert.equal(
    sanitizeAnalogAxis(-1.000030517578125),
    -1
  );

  assert.equal(
    sanitizeAnalogAxis(1.000030517578125),
    1
  );
});

test("normal driving accepts the observed full-left endpoint", () => {
  const calibration = defaultCalibration();

  assert.equal(
    calibratedSteering(
      -1.000030517578125,
      calibration.steering
    ),
    -1
  );
});

test("pedal endpoint overshoot normalizes correctly", () => {
  const calibration = defaultCalibration();

  assert.equal(
    calibratedPedal(
      -1.000030517578125,
      calibration.pedals.throttle
    ),
    0
  );

  assert.equal(
    calibratedPedal(
      1.000030517578125,
      calibration.pedals.throttle
    ),
    1
  );
});

test("meaningfully out-of-range inputs remain rejected", () => {
  for (const value of [
    -1.001,
    1.001,
    1227133568,
    NaN,
    Infinity,
    -Infinity,
    undefined,
    null,
    "-1"
  ]) {
    assert.equal(sanitizeAnalogAxis(value), null);
  }
});

test("ordinary analog values are preserved", () => {
  for (const value of [-1, -0.5, 0, 0.004, 0.5, 1]) {
    assert.equal(sanitizeAnalogAxis(value), value);
  }
});

test("saved calibration endpoints must remain within the normal range", () => {
  const calibration = defaultCalibration();

  // Raw readings receive tolerance, but stored endpoints should
  // already have been sanitized by the wizard.
  calibration.steering.left = -1.000030517578125;

  assert.equal(
    validateCalibration(calibration),
    "Invalid steering values."
  );
});

test("sanitized captured endpoints form a valid calibration", () => {
  const calibration = defaultCalibration();

  calibration.steering.left =
    sanitizeAnalogAxis(-1.000030517578125);

  calibration.steering.right =
    sanitizeAnalogAxis(1.000030517578125);

  assert.equal(validateCalibration(calibration), null);
});