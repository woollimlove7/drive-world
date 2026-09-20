import test from "node:test";
import assert from "node:assert/strict";

import {
  deviceSignature,
  summarizeSamples,
  compareCapture
} from "../src/input/InputDiscovery.js";

function makeSample() {
  return {
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

function summarize(sample) {
  return summarizeSamples(
    Array.from({ length: 7 }, () => structuredClone(sample))
  );
}

test("invalid unused axis is excluded without discarding other axes", () => {
  const result = summarize(makeSample());

  assert.equal(result.axes[0], 0.004);
  assert.equal(result.axes[9], null);

  assert.ok(result.excluded.some(entry =>
    entry.type === "axis" &&
    entry.index === 9 &&
    entry.reason === "Invalid analog value"
  ));
});

test("detects the observed V99 accelerator axis", () => {
  const baseline = summarize(makeSample());

  const pressed = makeSample();
  pressed.axes[2] = 1;

  const result = compareCapture(baseline, summarize(pressed));

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].type, "axis");
  assert.equal(result.candidates[0].index, 2);
});

test("accepts small full-left endpoint overshoot", () => {
  const baseline = summarize(makeSample());

  const left = makeSample();
  left.axes[0] = -1.000030517578125;

  const result = compareCapture(baseline, summarize(left));

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].index, 0);
  assert.equal(result.candidates[0].captured, -1);
});

test("detects a physical gear button", () => {
  const baseline = summarize(makeSample());

  const firstGear = makeSample();
  firstGear.buttons[16] = {
    value: 1,
    pressed: true
  };

  const result = compareCapture(baseline, summarize(firstGear));

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].type, "button");
  assert.equal(result.candidates[0].index, 16);
});

test("multiple changing inputs remain multiple candidates", () => {
  const baseline = summarize(makeSample());

  const pressed = makeSample();
  pressed.axes[2] = 1;
  pressed.axes[5] = 1;

  const result = compareCapture(baseline, summarize(pressed));

  assert.deepEqual(
    result.candidates.map(candidate => candidate.index),
    [2, 5]
  );
});

test("unstable axes are excluded", () => {
  const samples = Array.from({ length: 7 }, (_, index) => {
    const sample = makeSample();
    sample.axes[0] = index * 0.1;
    return sample;
  });

  const result = summarizeSamples(samples);

  assert.equal(result.axes[0], null);
  assert.ok(result.excluded.some(entry =>
    entry.index === 0 &&
    entry.reason === "Moved during capture"
  ));
});

test("return to baseline has no changed candidates", () => {
  const baseline = summarize(makeSample());
  const neutral = summarize(makeSample());

  assert.deepEqual(
    compareCapture(baseline, neutral).candidates,
    []
  );
});

test("layout changes during capture are rejected", () => {
  const first = makeSample();
  const second = makeSample();

  second.axes.pop();

  assert.throws(
    () => summarizeSamples([first, second]),
    /layout changed/
  );
});

test("device signature includes ID, mapping and input counts", () => {
  const sample = makeSample();

  const signature = JSON.parse(deviceSignature({
    id: "Test wheel",
    mapping: "",
    ...sample
  }));

  assert.deepEqual(signature, {
    id: "Test wheel",
    mapping: "",
    axes: 10,
    buttons: 24
  });
});