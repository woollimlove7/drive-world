import test from "node:test";
import assert from "node:assert/strict";
import { ManualDrivetrain } from "../src/vehicle/ManualDrivetrain.js";

const DT = 1 / 60;

function advance(drivetrain, input, seconds) {
  let state;

  for (let i = 0; i < Math.ceil(seconds / DT); i++) {
    state = drivetrain.update(input, DT);
  }

  return state;
}

test("neutral disconnects engine torque from wheels", () => {
  const drivetrain = new ManualDrivetrain();
  drivetrain.start();

  const state = advance(drivetrain, {
    throttle: 0.7,
    clutch: 0,
    requestedGear: 0,
    speed: 0
  }, 0.5);

  assert.equal(state.engagedGear, 0);
  assert.equal(state.totalWheelForce, 0);
  assert.ok(state.rpm > 900);
});

test("gear engagement requires clutch unloading", () => {
  const drivetrain = new ManualDrivetrain();
  drivetrain.start();

  let state = drivetrain.update({
    throttle: 0,
    clutch: 0,
    requestedGear: 1,
    speed: 0
  }, DT);

  assert.equal(state.engagedGear, 0);

  state = drivetrain.update({
    throttle: 0,
    clutch: 1,
    requestedGear: 1,
    speed: 0
  }, DT);

  assert.equal(state.engagedGear, 1);
  assert.equal(state.totalWheelForce, 0);
});

test("partial clutch engagement transfers forward torque", () => {
  const drivetrain = new ManualDrivetrain();
  drivetrain.start();

  drivetrain.update({
    throttle: 0,
    clutch: 1,
    requestedGear: 1,
    speed: 0
  }, DT);

  const state = drivetrain.update({
    throttle: 0.4,
    clutch: 0.6,
    requestedGear: 1,
    speed: 0
  }, DT);

  assert.ok(state.clutchTorque > 0);
  assert.ok(state.totalWheelForce > 0);
});

test("reverse produces negative wheel force", () => {
  const drivetrain = new ManualDrivetrain();
  drivetrain.start();

  drivetrain.update({
    throttle: 0,
    clutch: 1,
    requestedGear: -1,
    speed: 0
  }, DT);

  const state = drivetrain.update({
    throttle: 0.3,
    clutch: 0.6,
    requestedGear: -1,
    speed: 0
  }, DT);

  assert.equal(state.engagedGear, -1);
  assert.ok(state.totalWheelForce < 0);
});

test("dumping the clutch against stationary wheels can stall", () => {
  const drivetrain = new ManualDrivetrain();
  drivetrain.start();

  drivetrain.update({
    throttle: 0,
    clutch: 1,
    requestedGear: 1,
    speed: 0
  }, DT);

  const state = advance(drivetrain, {
    throttle: 0,
    clutch: 0,
    requestedGear: 1,
    speed: 0
  }, 1);

  assert.equal(state.engineRunning, false);
  assert.ok(state.rpm < 430);
});

test("closed throttle in gear produces engine braking", () => {
  const drivetrain = new ManualDrivetrain();
  drivetrain.start();

  drivetrain.update({
    throttle: 0,
    clutch: 1,
    requestedGear: 3,
    speed: 15
  }, DT);

  const state = advance(drivetrain, {
    throttle: 0,
    clutch: 0,
    requestedGear: 3,
    speed: 15
  }, 1);

  assert.ok(state.totalWheelForce < 0);
  assert.ok(state.rpm > 900);
});

test("reverse engagement is blocked while moving forward", () => {
  const drivetrain = new ManualDrivetrain();

  const state = drivetrain.update({
    throttle: 0,
    clutch: 1,
    requestedGear: -1,
    speed: 10
  }, DT);

  assert.equal(state.engagedGear, 0);
});

test("unsafe downshift is rejected", () => {
  const drivetrain = new ManualDrivetrain();

  const state = drivetrain.update({
    throttle: 0,
    clutch: 1,
    requestedGear: 1,
    speed: 30
  }, DT);

  assert.equal(state.engagedGear, 0);
  assert.match(state.message, /overspeed/);
});

test("invalid shifter reading does not silently select neutral", () => {
  const drivetrain = new ManualDrivetrain();

  drivetrain.update({
    throttle: 0,
    clutch: 1,
    requestedGear: 2,
    speed: 0
  }, DT);

  const state = drivetrain.update({
    throttle: 0,
    clutch: 1,
    requestedGear: null,
    speed: 0
  }, DT);

  assert.equal(state.engagedGear, 2);
});

test("starting in gear requires a pressed clutch", () => {
  const drivetrain = new ManualDrivetrain();

  assert.equal(
    drivetrain.start({ clutch: 0, requestedGear: 1 }),
    false
  );

  assert.equal(
    drivetrain.start({ clutch: 1, requestedGear: 1 }),
    true
  );
});