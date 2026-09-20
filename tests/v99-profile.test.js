import test from "node:test";
import assert from "node:assert/strict";

import {
  V99_DEVICE_ID,
  matchesV99Layout,
  readV99Input,
  isV99ReadyToArm
} from "../src/input/V99Profile.js";

function makeGamepad() {
  return {
    id: V99_DEVICE_ID,
    connected: true,
    mapping: "",
    index: 0,
    axes: [
      0.004, -1, -1, -1, -1,
      -1, -1, 0, 0, 1227133568
    ],
    buttons: Array.from({ length: 24 }, () => ({
      value: 0,
      pressed: false
    }))
  };
}

test("matches the observed layout", () => {
  assert.equal(matchesV99Layout(makeGamepad()), true);
});

test("resting controls normalize to zero and verified neutral", () => {
  const reading = readV99Input(makeGamepad());

  assert.equal(reading.valid, true);
  assert.equal(reading.input.steering, 0);
  assert.equal(reading.input.throttle, 0);
  assert.equal(reading.input.brake, 0);
  assert.equal(reading.input.clutch, 0);
  assert.equal(reading.shifter.gear, 0);
  assert.equal(isV99ReadyToArm(reading), true);
});

test("steering endpoints preserve left/right conventions", () => {
  const pad = makeGamepad();

  pad.axes[0] = -1;
  assert.equal(readV99Input(pad).input.steering, -1);

  pad.axes[0] = 1;
  assert.equal(readV99Input(pad).input.steering, 1);
});

test("pedals use the observed individual axis mappings", () => {
  for (const [axis, control] of [
    [2, "throttle"],
    [5, "brake"],
    [6, "clutch"]
  ]) {
    const pad = makeGamepad();
    pad.axes[axis] = 1;

    const reading = readV99Input(pad);

    assert.equal(reading.input[control], 1);

    for (const other of ["throttle", "brake", "clutch"]) {
      if (other !== control) {
        assert.equal(reading.input[other], 0);
      }
    }

    assert.equal(isV99ReadyToArm(reading), false);
  }
});

test("invalid unused axis 9 does not disable valid mapped inputs", () => {
  assert.equal(readV99Input(makeGamepad()).valid, true);
});

test("invalid mapped axis is rejected rather than clamped", () => {
  const pad = makeGamepad();
  pad.axes[2] = 1227133568;

  assert.equal(readV99Input(pad).valid, false);
});

test("an engaged shifter prevents initial arming", () => {
  const pad = makeGamepad();
  pad.buttons[16] = { value: 1, pressed: true };

  const reading = readV99Input(pad);

  assert.equal(reading.shifter.gear, 1);
  assert.equal(isV99ReadyToArm(reading), false);
});

test("changed layout is not silently accepted", () => {
  const pad = makeGamepad();
  pad.axes.pop();

  assert.equal(readV99Input(pad).valid, false);
});