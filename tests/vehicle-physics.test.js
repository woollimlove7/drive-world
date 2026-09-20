import test from "node:test";
import assert from "node:assert/strict";
import * as CANNON from "cannon-es";

import { normalizeInput } from "../src/input/InputManager.js";
import { ArcadeController } from "../src/vehicle/ArcadeController.js";
import { VehiclePhysics } from "../src/vehicle/VehiclePhysics.js";

const DT = 1 / 60;

function createFixture() {
  const world = new CANNON.World({
    gravity: new CANNON.Vec3(0, -9.81, 0)
  });

  world.solver.iterations = 10;

  const ground = new CANNON.Body({ mass: 0 });
  ground.addShape(new CANNON.Plane());
  ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  ground.surface = "asphalt";
  world.addBody(ground);

  const vehicle = new VehiclePhysics(world);
  const controller = new ArcadeController();

  function step(rawInput, count) {
    const input = normalizeInput(rawInput);

    for (let i = 0; i < count; i++) {
      const controls = controller.update(
        input,
        vehicle.signedSpeed,
        DT
      );

      vehicle.applyControls(controls);
      world.step(DT);
    }
  }

  // Let gravity settle the vehicle onto its suspension before driving.
  step({}, 180);

  return { vehicle, controller, step };
}

test("W intent drives forward along chassis-local +Z", () => {
  const { vehicle, controller, step } = createFixture();
  const startZ = vehicle.body.position.z;

  step({ throttle: 1 }, 120);

  assert.ok(
    vehicle.signedSpeed > 0.5,
    `Expected forward speed; received ${vehicle.signedSpeed}`
  );

  assert.ok(
    vehicle.body.position.z > startZ,
    "Expected the vehicle to move toward +Z"
  );

  assert.equal(controller.direction, 1);
});

test("S intent from rest drives backward along chassis-local -Z", () => {
  const { vehicle, controller, step } = createFixture();
  const startZ = vehicle.body.position.z;

  step({ brake: 1 }, 120);

  assert.ok(
    vehicle.signedSpeed < -0.5,
    `Expected reverse speed; received ${vehicle.signedSpeed}`
  );

  assert.ok(
    vehicle.body.position.z < startZ,
    "Expected the vehicle to move toward -Z"
  );

  assert.equal(controller.direction, -1);
});