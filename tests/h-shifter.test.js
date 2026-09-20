import test from "node:test";
import assert from "node:assert/strict";
import { decodeV99Shifter } from "../src/input/HShifterInput.js";

function makeGamepad(activeButtons = []) {
  return {
    connected: true,
    buttons: Array.from({ length: 24 }, (_, index) => ({
      value: activeButtons.includes(index) ? 1 : 0,
      pressed: activeButtons.includes(index)
    }))
  };
}

const verified = {
  shifterVerified: true,
  neutralVerified: true
};

test("decodes all six forward gears and reverse", () => {
  for (const [button, gear] of [
    [16, 1],
    [17, 2],
    [18, 3],
    [19, 4],
    [20, 5],
    [21, 6],
    [22, -1]
  ]) {
    const result = decodeV99Shifter(makeGamepad([button]), verified);

    assert.equal(result.valid, true);
    assert.equal(result.gear, gear);
  }
});

test("all gear buttons released produces verified neutral", () => {
  const result = decodeV99Shifter(makeGamepad(), verified);

  assert.equal(result.valid, true);
  assert.equal(result.gear, 0);
});

test("neutral requires explicit verification", () => {
  const result = decodeV99Shifter(makeGamepad(), {
    shifterVerified: true,
    neutralVerified: false
  });

  assert.equal(result.valid, false);
  assert.equal(result.gear, null);
});

test("conflicting gears are invalid, not neutral", () => {
  const result = decodeV99Shifter(makeGamepad([16, 17]), verified);

  assert.equal(result.valid, false);
  assert.equal(result.gear, null);
});

test("disconnect does not produce a valid neutral reading", () => {
  const pad = makeGamepad();
  pad.connected = false;

  const result = decodeV99Shifter(pad, verified);

  assert.equal(result.detected, false);
  assert.equal(result.valid, false);
  assert.equal(result.gear, null);
});

test("wheel presence alone does not verify an attached shifter", () => {
  const result = decodeV99Shifter(makeGamepad());

  assert.equal(result.detected, false);
  assert.equal(result.valid, false);
});

test("missing gear buttons invalidate the layout", () => {
  const pad = makeGamepad();
  pad.buttons.length = 22;

  const result = decodeV99Shifter(pad, verified);

  assert.equal(result.valid, false);
  assert.equal(result.gear, null);
});