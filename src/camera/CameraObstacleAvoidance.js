import * as THREE from "three";
import * as CANNON from "cannon-es";

export class CameraObstacleAvoidance {
  constructor() {
    this.anchor = new THREE.Vector3();
    this.direction = new THREE.Vector3();
    this.right = new THREE.Vector3();
    this.up = new THREE.Vector3();
    this.referenceUp = new THREE.Vector3();

    this.offset = new THREE.Vector3();
    this.start = new THREE.Vector3();
    this.end = new THREE.Vector3();

    this.rayStart = new CANNON.Vec3();
    this.rayEnd = new CANNON.Vec3();

    this.ignoredBody = null;
    this.nearestDistance = Infinity;

    this.clearance = 0.18;
    this.wallMargin = 0.2;

    this.sampleOffsets = [
      [0, 0],
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1]
    ];

    this.options = {
      skipBackfaces: false
    };

    this.onHit = result => {
      if (result.body === this.ignoredBody) return;

      if (
        Number.isFinite(result.distance) &&
        result.distance >= 0
      ) {
        this.nearestDistance = Math.min(
          this.nearestDistance,
          result.distance
        );
      }
    };
  }

  resolve(camera, vehicle) {
    const body = vehicle.physics.body;
    const world = body.world;

    if (!world) return;

    this.anchor.set(0, 0.8, 0)
      .applyQuaternion(vehicle.root.quaternion)
      .add(vehicle.root.position);

    this.direction.subVectors(camera.position, this.anchor);

    const desiredDistance = this.direction.length();

    if (desiredDistance < 0.001) return;

    this.direction.divideScalar(desiredDistance);

    // Build a perpendicular sampling plane around the camera path.
    this.referenceUp.set(0, 1, 0);

    if (Math.abs(this.direction.dot(this.referenceUp)) > 0.98) {
      this.referenceUp.set(1, 0, 0);
    }

    this.right.crossVectors(
      this.direction,
      this.referenceUp
    ).normalize();

    this.up.crossVectors(
      this.right,
      this.direction
    ).normalize();

    this.ignoredBody = body;
    this.nearestDistance = Infinity;

    for (const [horizontal, vertical] of this.sampleOffsets) {
      this.offset.copy(this.right)
        .multiplyScalar(horizontal * this.clearance)
        .addScaledVector(
          this.up,
          vertical * this.clearance
        );

      this.start.copy(this.anchor).add(this.offset);
      this.end.copy(camera.position).add(this.offset);

      this.rayStart.set(
        this.start.x,
        this.start.y,
        this.start.z
      );

      this.rayEnd.set(
        this.end.x,
        this.end.y,
        this.end.z
      );

      world.raycastAll(
        this.rayStart,
        this.rayEnd,
        this.options,
        this.onHit
      );
    }

    if (this.nearestDistance < desiredDistance) {
      const safeDistance = Math.max(
        0.05,
        this.nearestDistance - this.wallMargin
      );

      // Pull inward immediately. The chase camera's existing damping
      // moves it back out smoothly once the obstruction disappears.
      camera.position.copy(this.anchor)
        .addScaledVector(this.direction, safeDistance);
    }
  }
}