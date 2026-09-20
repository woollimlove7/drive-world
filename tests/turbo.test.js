import test from "node:test";
import assert from "node:assert/strict";
import { TurboSystem, TURBO_CONFIG, applyTurboToControls } from "../src/vehicle/TurboSystem.js";

test("turbo activates on request and applies the configured multiplier", () => {
  const turbo = new TurboSystem();
  const result = turbo.update(true, 1 / 60);

  assert.equal(result.active, true);
  assert.equal(result.state, "active");
  assert.equal(result.multiplier, TURBO_CONFIG.accelerationMultiplier);
});

test("turbo does not activate while not requested", () => {
  const turbo = new TurboSystem();
  const result = turbo.update(false, 1 / 60);

  assert.equal(result.active, false);
  assert.equal(result.state, "ready");
  assert.equal(result.multiplier, 1);
});

test("releasing turbo starts an approximately 2 second cooldown", () => {
  const turbo = new TurboSystem();
  turbo.update(true, 1 / 60);

  const released = turbo.update(false, 1 / 60);
  assert.equal(released.active, false);
  assert.equal(released.state, "cooldown");
  assert.ok(released.cooldownRemaining > 1.9);
});

test("turbo cannot be reactivated (spammed) during cooldown", () => {
  const turbo = new TurboSystem();
  turbo.update(true, 1 / 60);
  turbo.update(false, 1 / 60);

  // Immediately try to reactivate while still cooling down.
  const spam = turbo.update(true, 1 / 60);
  assert.equal(spam.active, false);
  assert.equal(spam.state, "cooldown");
});

test("turbo becomes ready again once the cooldown elapses", () => {
  const turbo = new TurboSystem();
  turbo.update(true, 1 / 60);
  turbo.update(false, 1 / 60);

  // Advance well past the cooldown duration.
  const result = turbo.update(false, TURBO_CONFIG.cooldown + 0.1);
  assert.equal(result.state, "ready");

  const reactivated = turbo.update(true, 1 / 60);
  assert.equal(reactivated.active, true);
});

test("reset() clears active and cooldown state", () => {
  const turbo = new TurboSystem();
  turbo.update(true, 1 / 60);
  turbo.reset();

  assert.equal(turbo.active, false);
  assert.equal(turbo.cooldownRemaining, 0);
  assert.equal(turbo.state, "ready");
});

test("applyTurboToControls: pressing only turbo (no throttle) still moves the car forward", () => {
  const turbo = new TurboSystem();
  const turboState = turbo.update(true, 1 / 60);

  // Mirrors ArcadeController's idle output: no throttle, no brake.
  const controls = { drive: 0, brake: 0, handbrake: 0, steeringAngle: 0 };
  applyTurboToControls(controls, turboState);

  assert.ok(controls.drive > 0, "turbo alone should produce forward drive");
});

test("applyTurboToControls: does nothing when turbo is not active", () => {
  const turbo = new TurboSystem();
  const turboState = turbo.update(false, 1 / 60); // never requested -> inactive

  const controls = { drive: 0, brake: 0, handbrake: 0, steeringAngle: 0 };
  applyTurboToControls(controls, turboState);

  assert.equal(controls.drive, 0);
});

test("applyTurboToControls: still boosts an existing throttle input on top of the solo minimum", () => {
  const turbo = new TurboSystem();
  const turboState = turbo.update(true, 1 / 60);

  const controls = { drive: 1, brake: 0, handbrake: 0, steeringAngle: 0 };
  applyTurboToControls(controls, turboState);

  assert.equal(controls.drive, 1 * TURBO_CONFIG.accelerationMultiplier);
});

test("applyTurboToControls: turbo alone does not override active braking", () => {
  const turbo = new TurboSystem();
  const turboState = turbo.update(true, 1 / 60);

  const controls = { drive: 0, brake: 0.8, handbrake: 0, steeringAngle: 0 };
  applyTurboToControls(controls, turboState);

  assert.equal(controls.drive, 0, "turbo should not fight an active brake input");
});

test("applyTurboToControls: turbo alone does not override the handbrake", () => {
  const turbo = new TurboSystem();
  const turboState = turbo.update(true, 1 / 60);

  const controls = { drive: 0, brake: 0, handbrake: 1, steeringAngle: 0 };
  applyTurboToControls(controls, turboState);

  assert.equal(controls.drive, 0, "turbo should not fight the handbrake");
});

test("applyTurboToControls: turbo alone does not force the car into reverse", () => {
  const turbo = new TurboSystem();
  const turboState = turbo.update(true, 1 / 60);

  // Negative drive == reversing (see ArcadeController).
  const controls = { drive: -0.5, brake: 0, handbrake: 0, steeringAngle: 0 };
  applyTurboToControls(controls, turboState);

  assert.equal(controls.drive, -0.5, "reverse drive should be left untouched");
});

test("applyTurboToControls: boosts manual mode's driveForcePerWheel the same way", () => {
  const turbo = new TurboSystem();
  const turboState = turbo.update(true, 1 / 60);

  const controls = {
    steeringAngle: 0, brake: 0, handbrake: 0, driveForcePerWheel: 1000
  };
  applyTurboToControls(controls, turboState);

  assert.equal(controls.driveForcePerWheel, 1000 * TURBO_CONFIG.accelerationMultiplier);
});

test("cooldown duration is configurable without editing the class", () => {
  const turbo = new TurboSystem({
    cooldown: 5,
    duration: 3,
    accelerationMultiplier: 1.6,
    maxAccelerationMultiplier: 2.2
  });

  turbo.update(true, 1 / 60);
  const released = turbo.update(false, 1 / 60);

  assert.ok(released.cooldownRemaining > 4.9);
});

test("turbo automatically ends once the max duration is reached, even while still held", () => {
  const turbo = new TurboSystem({
    cooldown: 2,
    duration: 1,
    accelerationMultiplier: 1.6,
    maxAccelerationMultiplier: 2.2
  });

  turbo.update(true, 0.5);
  const stillHeld = turbo.update(true, 0.4);
  assert.equal(stillHeld.active, true, "should still be boosting under the duration cap");

  // Keep holding past the 1 second duration cap.
  const expired = turbo.update(true, 0.2);
  assert.equal(expired.active, false, "turbo should force-end once duration is exceeded");
  assert.equal(expired.state, "cooldown", "hitting the duration cap should start the cooldown");
  assert.ok(expired.cooldownRemaining > 1.9);
});

test("continuing to hold through the cooldown does not reactivate turbo early", () => {
  const turbo = new TurboSystem({
    cooldown: 2,
    duration: 1,
    accelerationMultiplier: 1.6,
    maxAccelerationMultiplier: 2.2
  });

  turbo.update(true, 1.1); // exceeds duration, forces cooldown
  const stillHeldDuringCooldown = turbo.update(true, 0.5);
  assert.equal(stillHeldDuringCooldown.active, false);
  assert.equal(stillHeldDuringCooldown.state, "cooldown");

  // Advance the rest of the cooldown in small steps (like real per-frame
  // dt) while still held, then confirm turbo fires again right after.
  turbo.update(true, 0.5);
  turbo.update(true, 0.5);
  const afterCooldown = turbo.update(true, 0.5);
  assert.equal(afterCooldown.active, true);
});

test("durationRemaining counts down while active and is 0 when inactive", () => {
  const turbo = new TurboSystem({
    cooldown: 2,
    duration: 3,
    accelerationMultiplier: 1.6,
    maxAccelerationMultiplier: 2.2
  });

  assert.equal(turbo.durationRemaining, 0);

  const active = turbo.update(true, 1);
  assert.ok(active.durationRemaining <= 2 && active.durationRemaining > 1.9);
});
