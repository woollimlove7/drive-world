import * as THREE from "three";
import { Explosion } from "./ExplosionEffect.js";

// ---------------------------------------------------------------------------
// Shared, reusable visual effects for turret fire. Geometries/materials are
// created once (module scope) and every tracer/spark reuses them -- only
// each active effect's own Mesh instance (transform + fade timer) is
// per-shot, matching the pattern used by world/Destructibles.js.
// ---------------------------------------------------------------------------

const TRACER_LIFETIME = 0.09;
const SPARK_LIFETIME = 0.35;
const SPARK_COUNT = 6;

let sharedAssets = null;

function getSharedAssets() {
  if (sharedAssets) return sharedAssets;

  sharedAssets = {
    tracerGeometry: new THREE.CylinderGeometry(0.02, 0.02, 1, 6),
    tracerMaterial: new THREE.MeshBasicMaterial({
      color: 0xfff2c0,
      transparent: true,
      opacity: 0.9,
      depthWrite: false
    }),
    sparkGeometry: new THREE.BoxGeometry(0.06, 0.06, 0.06),
    sparkMaterial: new THREE.MeshBasicMaterial({
      color: 0xffb35c,
      transparent: true,
      depthWrite: false
    })
  };

  // Cylinder is built along Y; tracers are oriented by aiming +Y at the
  // target, so no extra rotation bookkeeping is needed per shot.
  return sharedAssets;
}

class Tracer {
  constructor(from, to) {
    const assets = getSharedAssets();

    this.mesh = new THREE.Mesh(assets.tracerGeometry, assets.tracerMaterial.clone());
    this.age = 0;

    const delta = new THREE.Vector3().subVectors(to, from);
    const length = Math.max(0.05, delta.length());

    this.mesh.position.copy(from).addScaledVector(delta, 0.5);
    this.mesh.scale.set(1, length, 1);
    this.mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      delta.normalize()
    );
  }

  update(dt) {
    this.age += dt;
    this.mesh.material.opacity = Math.max(0, 0.9 * (1 - this.age / TRACER_LIFETIME));
    return this.age < TRACER_LIFETIME;
  }

  dispose(scene) {
    scene.remove(this.mesh);
    this.mesh.material.dispose();
  }
}

class ImpactBurst {
  constructor(position) {
    const assets = getSharedAssets();
    this.group = new THREE.Group();
    this.group.position.copy(position);
    this.age = 0;
    this.sparks = [];

    for (let i = 0; i < SPARK_COUNT; i++) {
      const mesh = new THREE.Mesh(assets.sparkGeometry, assets.sparkMaterial.clone());
      const angle = Math.random() * Math.PI * 2;
      const elevation = Math.random() * Math.PI * 0.5;
      const speed = 2 + Math.random() * 3;

      const velocity = new THREE.Vector3(
        Math.cos(angle) * Math.cos(elevation),
        Math.sin(elevation),
        Math.sin(angle) * Math.cos(elevation)
      ).multiplyScalar(speed);

      this.group.add(mesh);
      this.sparks.push({ mesh, velocity });
    }
  }

  update(dt) {
    this.age += dt;
    const life = Math.max(0, 1 - this.age / SPARK_LIFETIME);

    for (const spark of this.sparks) {
      spark.velocity.y -= 6 * dt;
      spark.mesh.position.addScaledVector(spark.velocity, dt);
      spark.mesh.material.opacity = life;
    }

    return this.age < SPARK_LIFETIME;
  }

  dispose(scene) {
    scene.remove(this.group);
    for (const spark of this.sparks) spark.mesh.material.dispose();
  }
}

// Manages every in-flight tracer/impact effect for one turret (local or
// remote). update() is called once per render frame.
export class TurretEffectsPool {
  constructor(scene) {
    this.scene = scene;
    this.effects = [];
  }

  spawnTracer(from, to) {
    const tracer = new Tracer(from, to);
    this.scene.add(tracer.mesh);
    this.effects.push(tracer);
  }

  spawnImpact(position) {
    const burst = new ImpactBurst(position);
    this.scene.add(burst.group);
    this.effects.push(burst);
  }

  // Layered flash+fireball+shockwave+particles explosion (see
  // ExplosionEffect.js) -- used for the level-10 player missile and the
  // APEX Spider's rocket, in place of the small spawnImpact() burst above.
  // Drops straight into this same pool/update loop, so callers never need
  // to track it separately.
  spawnExplosion(position, config) {
    const explosion = new Explosion(position, config);
    this.scene.add(explosion.group);
    this.effects.push(explosion);
  }

  update(dt) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      if (!this.effects[i].update(dt)) {
        this.effects[i].dispose(this.scene);
        this.effects.splice(i, 1);
      }
    }
  }

  dispose() {
    for (const effect of this.effects) effect.dispose(this.scene);
    this.effects.length = 0;
  }
}