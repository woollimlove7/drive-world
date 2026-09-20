import test from "node:test";
import assert from "node:assert/strict";
import { normalizeInput } from "../src/input/InputManager.js";
import { ArcadeController } from "../src/vehicle/ArcadeController.js";

test("normalized inputs remain finite and bounded", () => {
  const input = normalizeInput({
    steering: -9,
    throttle: 4,
    brake: -2,
    clutch: NaN,
    handbrake: Infinity,
    gear: 99
  });

  assert.equal(input.steering, -1);
  assert.equal(input.throttle, 1);
  assert.equal(input.brake, 0);
  assert.equal(input.clutch, 0);
  assert.equal(input.handbrake, 0);
  assert.equal(input.gear, 0);
});

test("normalization preserves valid H-pattern gear values", () => {
  for (const gear of [-1, 0, 1, 2, 3, 4, 5, 6]) {
    assert.equal(normalizeInput({ gear }).gear, gear);
  }
});

test("arcade S brakes before reversing", () => {
  const controller = new ArcadeController();
  const input = normalizeInput({ brake: 1 });

  const moving = controller.update(input, 10, 1 / 60);
  assert.equal(moving.drive, 0);
  assert.equal(moving.brake, 1);

  const stopped = controller.update(input, 0, 1 / 60);
  assert.equal(stopped.drive, -1);
  assert.equal(stopped.brake, 0);
});

test("arcade W brakes backward motion before driving forward", () => {
  const controller = new ArcadeController();
  const input = normalizeInput({ throttle: 1 });

  const reversing = controller.update(input, -5, 1 / 60);
  assert.equal(reversing.drive, 0);
  assert.equal(reversing.brake, 1);

  const stopped = controller.update(input, 0, 1 / 60);
  assert.equal(stopped.drive, 1);
});

test("steering smoothing is approximately timestep-independent", () => {
  const a = new ArcadeController();
  const b = new ArcadeController();
  const input = normalizeInput({ steering: 1 });

  a.update(input, 0, 1 / 30);
  b.update(input, 0, 1 / 60);
  b.update(input, 0, 1 / 60);

  assert.ok(Math.abs(a.steering - b.steering) < 1e-10);
});