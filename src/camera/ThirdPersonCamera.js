import * as THREE from "three";

export class ThirdPersonCamera {
  constructor(camera) {
    this.camera = camera;
    this.offset = new THREE.Vector3(0, 3.2, -7.5);
    this.lookOffset = new THREE.Vector3(0, 0.8, 3);
    this.desired = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.lookPoint = new THREE.Vector3();
    this.initialized = false;
  }

  update(vehicle, dt) {
    this.desired.copy(this.offset)
      .applyQuaternion(vehicle.quaternion)
      .add(vehicle.position);

    this.target.copy(this.lookOffset)
      .applyQuaternion(vehicle.quaternion)
      .add(vehicle.position);

    // Flat-ground safety only; not a general terrain collision solution.
    this.desired.y = Math.max(0.8, this.desired.y);

    if (!this.initialized) {
      this.camera.position.copy(this.desired);
      this.lookPoint.copy(this.target);
      this.initialized = true;
    }

    const blend = 1 - Math.exp(-6 * dt);
    this.camera.position.lerp(this.desired, blend);
    this.lookPoint.lerp(this.target, blend);
    this.camera.lookAt(this.lookPoint);
  }

  reset() {
    this.initialized = false;
  }
}