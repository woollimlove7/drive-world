import * as THREE from "three";

// Delivery beacons spread across the expanded map so a run touches most
// of the new road network: the original spawn pad, both new cross-street
// intersections, the original loop, the dirt trail, and the new
// neighborhood by the house.
const POINTS = [
  { id: "spawn-hub", name: "Spawn Hub", x: 0, z: -65 },
  { id: "loop-junction", name: "Loop Junction", x: 36, z: 0 },
  { id: "north-junction", name: "North Junction", x: 0, z: 100 },
  { id: "south-junction", name: "South Junction", x: 0, z: -130 },
  { id: "maple-street", name: "Maple Street", x: 150, z: 63 },
  { id: "dirt-trail-end", name: "Dirt Trail End", x: 35, z: 65 }
];

const PICKUP_RADIUS = 7;
export const DELIVERY_REWARD = 25;

// Master switch for the whole delivery mini-game. Flip back to true to
// re-enable it -- every branch below checks this flag rather than the
// system being removed, so no delivery logic needs to be rewritten.
export const DELIVERY_SYSTEM_ENABLED = false;

const PICKUP_COLOR = 0xffb347;
const PICKUP_EMISSIVE = 0x552b00;
const DROPOFF_COLOR = 0x4be3a0;
const DROPOFF_EMISSIVE = 0x0d4a33;

// Simple delivery-job loop: approach any beacon while idle to receive a
// job, drive to the highlighted destination beacon to complete it.
export class DeliverySystem {
  constructor(scene, terrain) {
    this.deliveries = 0;
    this.score = 0;
    this.status = "idle";
    this.job = null;

    // Called with (deliveries, score) whenever a delivery completes.
    this.onDelivery = null;

    this.markers = new Map();

    // Disabled: skip building beacon geometry entirely (no draw calls,
    // no scene nodes) while keeping every method below intact and callable
    // so re-enabling this is a one-line flag flip, not a rewrite.
    if (!DELIVERY_SYSTEM_ENABLED) return;

    const postGeometry = new THREE.CylinderGeometry(0.12, 0.12, 2.4, 8);
    const capGeometry = new THREE.OctahedronGeometry(0.55, 0);

    for (const point of POINTS) {
      const group = new THREE.Group();
      const y = terrain.heightAt(point.x, point.z);
      group.position.set(point.x, y, point.z);

      const material = new THREE.MeshStandardMaterial({
        color: PICKUP_COLOR,
        emissive: PICKUP_EMISSIVE,
        roughness: 0.4
      });

      const post = new THREE.Mesh(postGeometry, material);
      post.position.y = 1.2;
      post.castShadow = true;

      const cap = new THREE.Mesh(capGeometry, material);
      cap.position.y = 2.6;
      cap.castShadow = true;

      group.add(post, cap);
      scene.add(group);

      this.markers.set(point.id, { point, group, material, cap });
    }
  }

  findMarkerWithin(x, z, radius) {
    for (const point of POINTS) {
      if (Math.hypot(x - point.x, z - point.z) <= radius) return point;
    }

    return null;
  }

  assignJob(pickupId) {
    const options = POINTS.filter(point => point.id !== pickupId);
    const dropoff = options[Math.floor(Math.random() * options.length)];

    this.job = { pickupId, dropoff };
    this.status = "assigned";
    this.refreshMarkerColors();
  }

  refreshMarkerColors() {
    const dropoffId = this.job?.dropoff.id ?? null;

    for (const [id, marker] of this.markers) {
      const isDropoff = id === dropoffId;

      marker.material.color.set(isDropoff ? DROPOFF_COLOR : PICKUP_COLOR);
      marker.material.emissive.set(
        isDropoff ? DROPOFF_EMISSIVE : PICKUP_EMISSIVE
      );
    }
  }

  update(position, dt) {
    if (!DELIVERY_SYSTEM_ENABLED) return;

    for (const marker of this.markers.values()) {
      marker.cap.rotation.y += dt * 0.8;
    }

    if (this.status === "idle") {
      const pickup = this.findMarkerWithin(
        position.x, position.z, PICKUP_RADIUS
      );

      if (pickup) this.assignJob(pickup.id);
      return;
    }

    const distance = Math.hypot(
      position.x - this.job.dropoff.x,
      position.z - this.job.dropoff.z
    );

    if (distance <= PICKUP_RADIUS) {
      this.deliveries++;
      this.score += DELIVERY_REWARD;
      this.status = "idle";
      this.job = null;
      this.refreshMarkerColors();
      this.onDelivery?.(this.deliveries, this.score);
    }
  }

  get statusText() {
    if (!DELIVERY_SYSTEM_ENABLED) return "Delivery system disabled";

    return this.status === "assigned"
      ? `Deliver to ${this.job.dropoff.name}`
      : "Drive to a glowing beacon to pick up a delivery";
  }
}
