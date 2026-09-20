import * as CANNON from "cannon-es";
import {
  COLLISION_GROUPS,
  VEHICLE_CANNON_MATERIAL,
  VEHICLE_VEHICLE_CONTACT
} from "./CollisionGroups.js";

/*
 * Respawn system
 *
 * These are local spawn locations used by the client.
 *
 * IMPORTANT:
 * The first point matches your original spawn:
 *   (-3, 1.2, -65)
 *
 * You can easily adjust/add points later if you change the map.
 */
const SPAWN_POINTS = [
  { x: -3,  y: 1.2, z: -65, yaw: 0 },

  { x:  12, y: 1.2, z: -65, yaw: 0 },
  { x: -18, y: 1.2, z: -65, yaw: 0 },

  { x: -3,  y: 1.2, z: -45, yaw: Math.PI },
  { x:  12, y: 1.2, z: -45, yaw: Math.PI },
  { x: -18, y: 1.2, z: -45, yaw: Math.PI },

  { x:  30, y: 1.2, z: -65, yaw: 0 },
  { x: -36, y: 1.2, z: -65, yaw: Math.PI },

  { x:  30, y: 1.2, z: -45, yaw: Math.PI },
  { x: -36, y: 1.2, z: -45, yaw: 0 },

  { x:  12, y: 1.2, z: -85, yaw: 0 },
  { x: -18, y: 1.2, z: -85, yaw: Math.PI }
];

/*
 * How far away another player should be before a spawn is considered safe.
 *
 * 15 meters gives enough room for a car to spawn without immediately
 * overlapping another player.
 */
const MIN_RESPAWN_DISTANCE = 15;

/*
 * If every spawn is occupied, we progressively relax the distance.
 *
 * We still try very hard to avoid spawning directly on another vehicle.
 */
const FALLBACK_DISTANCES = [
  MIN_RESPAWN_DISTANCE,
  12,
  9,
  6,
  3
];

export class VehiclePhysics {
  constructor(world) {
    this.world = world;

    this.body = new CANNON.Body({
      mass: 1050,
      linearDamping: 0.025,
      angularDamping: 0.35,
      material: VEHICLE_CANNON_MATERIAL
    });

    // The collider sits above the center of mass for prototype stability.
    this.body.addShape(
      new CANNON.Box(new CANNON.Vec3(0.9, 0.3, 2)),
      new CANNON.Vec3(0, 0.15, 0)
    );

    // Collide with the static world and remote players.
    this.body.collisionFilterGroup = COLLISION_GROUPS.VEHICLE;
    this.body.collisionFilterMask =
      COLLISION_GROUPS.WORLD | COLLISION_GROUPS.REMOTE;

    this.vehicle = new CANNON.RaycastVehicle({
      chassisBody: this.body,
      indexRightAxis: 0,
      indexUpAxis: 1,
      indexForwardAxis: 2
    });

    for (const [x, z, isFrontWheel] of [
      [-0.95, 1.35, true],
      [0.95, 1.35, true],
      [-0.95, -1.35, false],
      [0.95, -1.35, false]
    ]) {
      this.vehicle.addWheel({
        radius: 0.36,
        directionLocal: new CANNON.Vec3(0, -1, 0),
        axleLocal: new CANNON.Vec3(-1, 0, 0),
        chassisConnectionPointLocal: new CANNON.Vec3(x, 0, z),
        suspensionRestLength: 0.35,
        suspensionStiffness: 35,
        dampingRelaxation: 2.3,
        dampingCompression: 4.4,
        maxSuspensionForce: 50000,
        maxSuspensionTravel: 0.25,
        frictionSlip: 3.2,
        rollInfluence: 0.06,
        customSlidingRotationalSpeed: -30,
        useCustomSlidingRotationalSpeed: true,
        isFrontWheel
      });
    }

    this.vehicle.addToWorld(world);

    if (!world.contactmaterials.includes(VEHICLE_VEHICLE_CONTACT)) {
      world.addContactMaterial(VEHICLE_VEHICLE_CONTACT);
    }

    this.forward = new CANNON.Vec3();

    /*
     * Respawn state.
     *
     * previousSpawnIndex starts at -1 so the first reset can use any point.
     */
    this.previousSpawnIndex = -1;
    this.currentSpawnIndex = -1;

    /*
     * Initial vehicle placement.
     *
     * This intentionally uses the original spawn position.
     */
    this.reset();
  }

  get signedSpeed() {
    this.body.vectorToWorldFrame(
      new CANNON.Vec3(0, 0, 1),
      this.forward
    );

    return this.body.velocity.dot(this.forward);
  }

  applyControls(control) {
    // Arcade supplies normalized drive.
    // Manual supplies an actual per-driven-wheel force in newtons.
    const driveForcePerWheel =
      Number.isFinite(control.driveForcePerWheel)
        ? control.driveForcePerWheel
        : control.drive * 1800;

    for (let i = 0; i < 4; i++) {
      const wheel = this.vehicle.wheelInfos[i];
      const contactBody = wheel.raycastResult.body;

      const surface = contactBody?.surfaceAt
        ? contactBody.surfaceAt(wheel.raycastResult.hitPointWorld)
        : contactBody?.surface ?? "grass";

      wheel.frictionSlip =
        surface === "asphalt"
          ? 3.2
          : surface === "dirt"
            ? 1.8
            : 1.35;

      this.vehicle.setSteeringValue(
        i < 2 ? -control.steeringAngle : 0,
        i
      );

      this.vehicle.applyEngineForce(
        i >= 2 ? -driveForcePerWheel : 0,
        i
      );

      this.vehicle.setBrake(
        control.brake * 35 +
          (i >= 2 ? control.handbrake * 65 : 0),
        i
      );
    }
  }

  /*
   * Return the configured spawn points.
   *
   * A copy is returned so outside code cannot accidentally modify
   * our internal spawn configuration.
   */
  getSpawnPoints() {
    return SPAWN_POINTS.map(spawn => ({ ...spawn }));
  }

  /*
   * Find a spawn point that is:
   *
   * 1. NOT the previous spawn.
   * 2. NOT too close to another player.
   *
   * otherPlayerPositions should be:
   *
   * [
   *   { x: 10, y: 1, z: 20 },
   *   { x: -5, y: 1, z: 30 }
   * ]
   */
  chooseRespawnPoint(otherPlayerPositions = []) {
    const players = Array.isArray(otherPlayerPositions)
      ? otherPlayerPositions
      : [];

    /*
     * First shuffle the candidates.
     *
     * This prevents every player from repeatedly choosing the same
     * "first available" spawn.
     */
    const candidates = SPAWN_POINTS
      .map((spawn, index) => ({
        spawn,
        index
      }))
      .filter(({ index }) => index !== this.previousSpawnIndex)
      .sort(() => Math.random() - 0.5);

    /*
     * Try increasingly relaxed distances.
     *
     * Normally we require 15m.
     */
    for (const minimumDistance of FALLBACK_DISTANCES) {
      const safeCandidates = candidates.filter(({ spawn }) => {
        return players.every(player => {
          if (!player) return true;

          const px = Number(player.x);
          const pz = Number(player.z);

          if (!Number.isFinite(px) || !Number.isFinite(pz)) {
            return true;
          }

          const dx = spawn.x - px;
          const dz = spawn.z - pz;

          return Math.sqrt(dx * dx + dz * dz) >= minimumDistance;
        });
      });

      if (safeCandidates.length > 0) {
        /*
         * If several locations are safe, choose randomly.
         */
        const selected =
          safeCandidates[
            Math.floor(Math.random() * safeCandidates.length)
          ];

        return {
          ...selected.spawn,
          index: selected.index,
          minimumDistanceUsed: minimumDistance
        };
      }
    }

    /*
     * Extreme fallback:
     *
     * Every spawn is occupied.
     *
     * We still never use the previous spawn if another point exists.
     */
    if (candidates.length > 0) {
      const selected = candidates[0];

      return {
        ...selected.spawn,
        index: selected.index,
        minimumDistanceUsed: 0
      };
    }

    /*
     * This should practically never happen, but protects against
     * a malformed/empty spawn list.
     */
    const fallbackIndex =
      this.previousSpawnIndex >= 0
        ? (this.previousSpawnIndex + 1) % SPAWN_POINTS.length
        : 0;

    const fallback = SPAWN_POINTS[fallbackIndex];

    return {
      ...fallback,
      index: fallbackIndex,
      minimumDistanceUsed: 0
    };
  }

  /*
   * Reset all physical state without choosing a new location.
   *
   * Used for initial construction and other situations where the
   * game explicitly wants the default spawn.
   */
  reset() {
    this.setVehicleTransform(
      -3,
      1.2,
      -65,
      0
    );

    this.currentSpawnIndex = 0;
    this.previousSpawnIndex = -1;
  }

  /*
   * The new multiplayer-aware respawn method.
   *
   * otherPlayerPositions is supplied by Game / MultiplayerClient.
   */
  respawn(otherPlayerPositions = []) {
    const spawn = this.chooseRespawnPoint(
      otherPlayerPositions
    );

    /*
     * Remember the spawn BEFORE changing the vehicle.
     *
     * This means the next R press knows which location must be avoided.
     */
    this.previousSpawnIndex = spawn.index;
    this.currentSpawnIndex = spawn.index;

    this.setVehicleTransform(
      spawn.x,
      spawn.y,
      spawn.z,
      spawn.yaw
    );

    return {
      ...spawn
    };
  }

  /*
   * Completely reset the vehicle physics state.
   */
  setVehicleTransform(x, y, z, yaw = 0) {
    this.body.position.set(x, y, z);

    /*
     * Y-axis rotation.
     *
     * Using setFromEuler avoids manually calculating quaternion values.
     */
    this.body.quaternion.setFromEuler(
      0,
      yaw,
      0,
      "YZX"
    );

    // Stop all movement.
    this.body.velocity.setZero();
    this.body.angularVelocity.setZero();

    // Clear accumulated forces.
    this.body.force.setZero();
    this.body.torque.setZero();

    /*
     * Clear sleeping state so Cannon immediately resumes simulation.
     */
    this.body.wakeUp();

    /*
     * Tell Cannon that the body's bounds changed.
     */
    this.body.aabbNeedsUpdate = true;

    /*
     * Reset wheel state.
     */
    for (const wheel of this.vehicle.wheelInfos) {
      wheel.rotation = 0;
      wheel.deltaRotation = 0;
      wheel.engineForce = 0;
      wheel.brake = 0;
      wheel.steering = 0;

      if (wheel.raycastResult) {
        wheel.raycastResult.reset();
      }
    }

    /*
     * Clear vehicle wheel transforms/state if Cannon has generated
     * wheel bodies/transforms already.
     */
    for (const wheel of this.vehicle.wheelInfos) {
      wheel.worldTransform?.position?.set(
        x,
        y,
        z
      );
    }
  }

  snapshot() {
    const b = this.body;

    return {
      position: [
        b.position.x,
        b.position.y,
        b.position.z
      ],

      rotation: [
        b.quaternion.x,
        b.quaternion.y,
        b.quaternion.z,
        b.quaternion.w
      ],

      velocity: [
        b.velocity.x,
        b.velocity.y,
        b.velocity.z
      ],

      angularVelocity: [
        b.angularVelocity.x,
        b.angularVelocity.y,
        b.angularVelocity.z
      ]
    };
  }
}