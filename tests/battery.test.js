import test from "node:test";
import assert from "node:assert/strict";
import {
  BatterySystem,
  BATTERY_CONFIG,
  BATTERY_STATE,
  applyBatteryToControls
} from "../src/vehicle/BatterySystem.js";

test("starts at full battery", () => {
  const battery = new BatterySystem();
  assert.equal(battery.percent, BATTERY_CONFIG.maxBattery);
  assert.equal(battery.state, BATTERY_STATE.FULL);
  assert.equal(battery.depleted, false);
});

test("idle drains very slowly", () => {
  const battery = new BatterySystem();
  const result = battery.update(1, { moving: false, turretEngaged: false, canCharge: false });

  assert.ok(result.percent < BATTERY_CONFIG.maxBattery);
  assert.equal(
    result.percent,
    BATTERY_CONFIG.maxBattery - BATTERY_CONFIG.idleDrainRate
  );
});

test("driving drains faster than idle, but is not the primary drain", () => {
  const idleBattery = new BatterySystem();
  const drivingBattery = new BatterySystem();

  idleBattery.update(5, { moving: false });
  drivingBattery.update(5, { moving: true });

  assert.ok(drivingBattery.percent < idleBattery.percent, "driving should drain more than idle");
  assert.ok(
    BATTERY_CONFIG.drivingDrainRate < BATTERY_CONFIG.turretDrainBaseRate,
    "driving drain should be lower than turret drain"
  );
});

test("turret deployment is the primary/high drain", () => {
  const battery = new BatterySystem();
  const result = battery.update(1, { moving: false, turretEngaged: true, canCharge: false });

  const expectedDrain =
    BATTERY_CONFIG.idleDrainRate + BATTERY_CONFIG.turretDrainBaseRate;

  assert.equal(result.percent, BATTERY_CONFIG.maxBattery - expectedDrain);
});

test("turret drain rate increases the longer it stays deployed", () => {
  const battery = new BatterySystem();

  // Tick in small steps like real per-frame dt so turretEngagedTime
  // accumulates realistically.
  for (let i = 0; i < 60; i++) {
    battery.update(1 / 60, { moving: false, turretEngaged: true });
  }
  const afterOneSecond = BATTERY_CONFIG.maxBattery - battery.percent;

  const battery2 = new BatterySystem();
  for (let i = 0; i < 60 * 11; i++) {
    battery2.update(1 / 60, { moving: false, turretEngaged: true });
  }
  // Drain over the *second* 10 seconds (11th second alone) should be
  // larger than drain over the very first second, since the rate ramps.
  const before = (() => {
    const b = new BatterySystem();
    for (let i = 0; i < 60 * 10; i++) b.update(1 / 60, { moving: false, turretEngaged: true });
    return b.percent;
  })();

  const drainInFirstSecond = afterOneSecond;
  const drainInEleventhSecond = before - battery2.percent;

  assert.ok(
    drainInEleventhSecond > drainInFirstSecond,
    "later seconds of continuous turret deployment should drain more than the first second"
  );
});

test("turret drain ramp resets after the turret is stowed", () => {
  const battery = new BatterySystem();

  for (let i = 0; i < 60 * 10; i++) {
    battery.update(1 / 60, { moving: false, turretEngaged: true });
  }
  assert.ok(battery.turretEngagedTime > 0);

  battery.update(1 / 60, { moving: false, turretEngaged: false });
  assert.equal(battery.turretEngagedTime, 0);
});

test("combined driving + turret drain sums both tiers, not just the larger one", () => {
  const battery = new BatterySystem();
  const result = battery.update(1, { moving: true, turretEngaged: true, canCharge: false });

  const expectedDrain =
    BATTERY_CONFIG.drivingDrainRate + BATTERY_CONFIG.turretDrainBaseRate;

  assert.equal(result.percent, BATTERY_CONFIG.maxBattery - expectedDrain);
});

test("battery never goes negative even under heavy sustained drain", () => {
  const battery = new BatterySystem();
  battery.update(10000, { moving: true, turretEngaged: true });

  assert.equal(battery.percent, 0);
  assert.equal(battery.depleted, true);
  assert.equal(battery.state, BATTERY_STATE.EMPTY);
});

test("battery never exceeds maximum capacity while charging", () => {
  const battery = new BatterySystem();
  battery.update(10000, { canCharge: true });

  assert.equal(battery.percent, BATTERY_CONFIG.maxBattery);
});

test("charging increases battery over time and reports charging=true", () => {
  const battery = new BatterySystem();
  battery.update(5, { moving: false, turretEngaged: false });
  const drained = battery.percent;
  assert.ok(drained < BATTERY_CONFIG.maxBattery);

  const result = battery.update(1, { canCharge: true });
  assert.equal(result.charging, true);
  assert.ok(result.percent > drained);
});

test("charging never reports charging=true at full battery (no unnecessary charging)", () => {
  const battery = new BatterySystem();
  const result = battery.update(1, { canCharge: true });

  assert.equal(battery.percent, BATTERY_CONFIG.maxBattery);
  assert.equal(result.charging, false);
});

test("leaving the charging zone stops charging and battery holds its level", () => {
  const battery = new BatterySystem();
  battery.update(5, { moving: true }); // drain some first
  const beforeLeaving = battery.percent;

  battery.update(2, { canCharge: true }); // charge a bit
  const afterCharging = battery.percent;
  assert.ok(afterCharging > beforeLeaving);

  // Leave the zone: no charge, no drive/turret drain (idle, not moving).
  const result = battery.update(1, { moving: false, turretEngaged: false, canCharge: false });
  assert.equal(result.charging, false);
  // Should have only dropped by the idle drain, not jumped or stayed frozen.
  assert.equal(result.percent, afterCharging - BATTERY_CONFIG.idleDrainRate);
});

test("charging suspends drain entirely for that tick (charge XOR drain)", () => {
  const battery = new BatterySystem();
  battery.update(5, { moving: true, turretEngaged: true }); // drain heavily first
  const drained = battery.percent;

  // Even while "turretEngaged" is still reported true, canCharge=true
  // (as Game.js only ever sets canCharge when the turret is stowed, but
  // this exercises the module's own guarantee independent of the caller)
  // should mean pure charging, no partial drain mixed in.
  const result = battery.update(1, { moving: true, turretEngaged: true, canCharge: true });
  assert.equal(result.percent, Math.min(BATTERY_CONFIG.maxBattery, drained + BATTERY_CONFIG.chargingRate));
});

test("state thresholds: full, normal, low, critical, empty", () => {
  const battery = new BatterySystem();
  battery.percent = 100;
  assert.equal(battery.state, BATTERY_STATE.FULL);

  battery.percent = 99;
  assert.equal(battery.state, BATTERY_STATE.NORMAL);

  battery.percent = BATTERY_CONFIG.lowBatteryThreshold;
  assert.equal(battery.state, BATTERY_STATE.LOW);

  battery.percent = BATTERY_CONFIG.criticalBatteryThreshold;
  assert.equal(battery.state, BATTERY_STATE.CRITICAL);

  battery.percent = 0;
  assert.equal(battery.state, BATTERY_STATE.EMPTY);
});

test("onStateChange fires exactly once per transition, not every tick", () => {
  const battery = new BatterySystem();
  const transitions = [];
  battery.onStateChange = (newState, oldState) => transitions.push([oldState, newState]);

  // Drain slowly (small per-frame-sized steps) all the way down to empty.
  for (let i = 0; i < 60 * 30; i++) {
    battery.update(1 / 60, { moving: true, turretEngaged: true });
  }

  const lowTransitions = transitions.filter(([, s]) => s === BATTERY_STATE.LOW);
  assert.equal(lowTransitions.length, 1, "should transition into LOW exactly once");

  const emptyTransitions = transitions.filter(([, s]) => s === BATTERY_STATE.EMPTY);
  assert.equal(emptyTransitions.length, 1, "should transition into EMPTY exactly once");
});

test("onStateChange fires once on reaching empty", () => {
  const battery = new BatterySystem();
  let emptyCount = 0;
  battery.onStateChange = (newState) => {
    if (newState === BATTERY_STATE.EMPTY) emptyCount++;
  };

  battery.update(1000, { moving: true, turretEngaged: true });
  battery.update(1, { moving: true, turretEngaged: true }); // still empty, should not refire
  battery.update(1, { moving: true, turretEngaged: true });

  assert.equal(emptyCount, 1);
});

test("reset() restores full battery and clears internal ramp/charging state", () => {
  const battery = new BatterySystem();
  battery.update(20, { moving: true, turretEngaged: true });
  assert.ok(battery.percent < BATTERY_CONFIG.maxBattery);

  battery.reset();
  assert.equal(battery.percent, BATTERY_CONFIG.maxBattery);
  assert.equal(battery.turretEngagedTime, 0);
  assert.equal(battery.charging, false);
  assert.equal(battery.state, BATTERY_STATE.FULL);
});

test("applyBatteryToControls: no-op when battery is not depleted", () => {
  const controls = { drive: 1, driveForcePerWheel: 1000, brake: 0, handbrake: 0, steeringAngle: 0.2 };
  applyBatteryToControls(controls, { depleted: false });

  assert.equal(controls.drive, 1);
  assert.equal(controls.driveForcePerWheel, 1000);
});

test("applyBatteryToControls: scales drive and driveForcePerWheel when depleted", () => {
  const controls = { drive: 1, driveForcePerWheel: 1000, brake: 0, handbrake: 0, steeringAngle: 0.2 };
  applyBatteryToControls(controls, { depleted: true });

  assert.equal(controls.drive, BATTERY_CONFIG.emptyMovementMultiplier);
  assert.equal(controls.driveForcePerWheel, 1000 * BATTERY_CONFIG.emptyMovementMultiplier);
});

test("applyBatteryToControls: leaves brake, handbrake, and steering untouched when depleted", () => {
  const controls = { drive: 1, brake: 0.7, handbrake: 1, steeringAngle: 0.35 };
  applyBatteryToControls(controls, { depleted: true });

  assert.equal(controls.brake, 0.7);
  assert.equal(controls.handbrake, 1);
  assert.equal(controls.steeringAngle, 0.35);
});

test("applyBatteryToControls: still allows some forward movement (never fully immobilized)", () => {
  const controls = { drive: 1, brake: 0, handbrake: 0, steeringAngle: 0 };
  applyBatteryToControls(controls, { depleted: true });

  assert.ok(controls.drive > 0, "vehicle should still be able to limp forward, not be fully stopped");
});

test("emptyMovementMultiplier is configurable without editing the class", () => {
  const controls = { drive: 1 };
  applyBatteryToControls(controls, { depleted: true }, { emptyMovementMultiplier: 0.5 });

  assert.equal(controls.drive, 0.5);
});

test("custom config is respected end-to-end (drain rates, thresholds, charging rate)", () => {
  const config = {
    maxBattery: 100,
    idleDrainRate: 1,
    drivingDrainRate: 2,
    turretDrainBaseRate: 10,
    turretDrainRampRate: 0,
    turretDrainRampCapTime: 20,
    movingSpeedThreshold: 0.6,
    chargingRate: 50,
    lowBatteryThreshold: 50,
    criticalBatteryThreshold: 20,
    emptyMovementMultiplier: 0.22
  };

  const battery = new BatterySystem(config);
  battery.update(1, { turretEngaged: true });
  assert.equal(battery.percent, 100 - (1 + 10));

  battery.update(1, { canCharge: true });
  assert.equal(battery.percent, Math.min(100, 89 + 50));
});