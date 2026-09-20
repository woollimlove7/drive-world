import test from "node:test";
import assert from "node:assert/strict";

import { VehicleFeedback } from "../src/vehicle/VehicleFeedback.js";

const baseline = {
  manual: true,
  engineRunning: false,
  rpm: 0,
  engagedGear: 0,
  clutchTorque: 0,
  signedSpeed: 0,
  suspensionLengths: [0.35, 0.35, 0.35, 0.35]
};

test("initial observation does not invent an engine event", () => {
  const feedback = new VehicleFeedback();
  const result = feedback.update(baseline, 1 / 60);

  assert.deepEqual(result.events, []);
});

test("engine start produces one event", () => {
  const feedback = new VehicleFeedback();

  feedback.update(baseline, 1 / 60);

  const started = {
    ...baseline,
    engineRunning: true,
    rpm: 900
  };

  const first = feedback.update(started, 1 / 60);
  const second = feedback.update(started, 1 / 60);

  assert.deepEqual(first.events, [{ type: "engine-start" }]);
  assert.deepEqual(second.events, []);
});

test("running-to-stopped transition produces a stop event", () => {
  const feedback = new VehicleFeedback();

  feedback.update({
    ...baseline,
    engineRunning: true,
    rpm: 900
  }, 1 / 60);

  const result = feedback.update(baseline, 1 / 60);

  assert.deepEqual(result.events, [{ type: "engine-stop" }]);
});

test("switching from arcade to manual does not invent a stall", () => {
  const feedback = new VehicleFeedback();

  feedback.update({
    ...baseline,
    manual: false,
    engineRunning: true,
    rpm: 900
  }, 1 / 60);

  const result = feedback.update(baseline, 1 / 60);

  assert.deepEqual(result.events, []);
});

test("lugging requires a running engine loaded in gear", () => {
  const feedback = new VehicleFeedback();

  const loaded = feedback.update({
    ...baseline,
    engineRunning: true,
    rpm: 500,
    engagedGear: 1,
    clutchTorque: 200
  }, 1 / 60);

  assert.ok(loaded.lugging > 0);

  const neutral = feedback.update({
    ...baseline,
    engineRunning: true,
    rpm: 500,
    engagedGear: 0,
    clutchTorque: 200
  }, 1 / 60);

  assert.equal(neutral.lugging, 0);
});

test("fast suspension compression produces a limited event", () => {
  const feedback = new VehicleFeedback();

  feedback.update({
    ...baseline,
    signedSpeed: 5
  }, 1 / 60);

  const compressed = {
    ...baseline,
    signedSpeed: 5,
    suspensionLengths: [0.30, 0.35, 0.35, 0.35]
  };

  const first = feedback.update(compressed, 1 / 60);

  assert.equal(first.events[0]?.type, "suspension");
  assert.ok(first.events[0].strength <= 1);

  const second = feedback.update({
    ...compressed,
    suspensionLengths: [0.25, 0.35, 0.35, 0.35]
  }, 1 / 60);

  assert.equal(second.events.length, 0);
});

test("airborne-to-ground transition is not treated as compression speed", () => {
  const feedback = new VehicleFeedback();

  feedback.update({
    ...baseline,
    signedSpeed: 5,
    suspensionLengths: [null, null, null, null]
  }, 1 / 60);

  const result = feedback.update({
    ...baseline,
    signedSpeed: 5
  }, 1 / 60);

  assert.deepEqual(result.events, []);
});

test("zero delta time does not generate invalid acceleration", () => {
  const feedback = new VehicleFeedback();

  feedback.update(baseline, 0);

  const result = feedback.update({
    ...baseline,
    signedSpeed: 10
  }, 0);

  assert.equal(Number.isFinite(result.acceleration), true);
});

test("reset clears presentation history", () => {
  const feedback = new VehicleFeedback();

  feedback.update({
    ...baseline,
    engineRunning: true,
    rpm: 900
  }, 1 / 60);

  feedback.reset();

  const result = feedback.update(baseline, 1 / 60);

  assert.deepEqual(result.events, []);
  assert.equal(result.acceleration, 0);
});