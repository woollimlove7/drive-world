import * as THREE from "three";

// ---------------------------------------------------------------------------
// Shared "wreck" visual state for a destroyed vehicle: charred materials,
// smoke/spark/flash particles, and flickering damaged lights. Used by both
// the local player's Vehicle.js (which also gets a one-shot physics tilt via
// the optional `body` passed to activate()) and every RemoteVehicle.js
// (purely presentational -- remote cars are kinematic/network-driven, so
// `body` is simply omitted there). Geometry and base materials are created
// once at module scope and shared across every instance -- same pattern as
// ExhaustSystem.js / TurretEffects.js -- so up to 8 simultaneous wrecks in a
// multiplayer match stay cheap (see requirement: pooling / no per-frame
// allocations, minimal physics work).
// ---------------------------------------------------------------------------

const MAX_SMOKE = 18;
const SMOKE_EMIT_INTERVAL = 0.12;
const SMOKE_LIFETIME = 1.6;

const SPARK_COUNT = 14;
const SPARK_LIFETIME = 0.5;

const FLASH_DURATION = 0.3;

// Fraction of original color kept after "charring" -- close to black but not
// pure black, so different vehicle paint colors still read as distinct wrecks.
const CHAR_DARKEN = 0.16;

const FLICKER_INTERVAL = 0.09;

let sharedAssets = null;

function getSharedAssets() {
  if (sharedAssets) return sharedAssets;

  sharedAssets = {
    quad: new THREE.PlaneGeometry(1, 1),

    smokeMaterial: new THREE.MeshBasicMaterial({
      color: 0x262626,
      transparent: true,
      opacity: 0.42,
      depthWrite: false
    }),

    sparkMaterial: new THREE.MeshBasicMaterial({
      color: 0xffaa33,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    }),

    flashMaterial: new THREE.MeshBasicMaterial({
      color: 0xffcf7a,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  };

  return sharedAssets;
}

class SmokePuff {
  constructor(worldPosition) {
    const assets = getSharedAssets();
    this.age = 0;
    this.lifetime = SMOKE_LIFETIME * (0.8 + Math.random() * 0.4);

    this.mesh = new THREE.Mesh(assets.quad, assets.smokeMaterial.clone());
    this.mesh.position.copy(worldPosition);
    this.mesh.scale.setScalar(0.35);
    this.mesh.renderOrder = 14;

    this.velocity = new THREE.Vector3(
      (Math.random() - 0.5) * 0.4,
      0.6 + Math.random() * 0.5,
      (Math.random() - 0.5) * 0.4
    );
  }

  update(dt, camera) {
    this.age += dt;
    const life = 1 - this.age / this.lifetime;
    if (life <= 0) return false;

    this.velocity.y += dt * 0.15;
    this.mesh.position.addScaledVector(this.velocity, dt);

    const growth = 1 + this.age * 1.6;
    this.mesh.scale.setScalar(0.35 * growth);
    this.mesh.material.opacity = 0.42 * Math.max(0, life);

    if (camera) this.mesh.quaternion.copy(camera.quaternion);
    return true;
  }

  dispose(scene) {
    scene.remove(this.mesh);
    this.mesh.material.dispose();
  }
}

class Spark {
  constructor(worldPosition) {
    const assets = getSharedAssets();
    this.age = 0;
    this.lifetime = SPARK_LIFETIME * (0.6 + Math.random() * 0.6);

    this.mesh = new THREE.Mesh(assets.quad, assets.sparkMaterial.clone());
    this.mesh.position.copy(worldPosition);
    this.mesh.scale.setScalar(0.05 + Math.random() * 0.04);
    this.mesh.renderOrder = 15;

    const angle = Math.random() * Math.PI * 2;
    const speed = 1.5 + Math.random() * 3;
    this.velocity = new THREE.Vector3(
      Math.cos(angle) * speed,
      2 + Math.random() * 3,
      Math.sin(angle) * speed
    );
  }

  update(dt, camera) {
    this.age += dt;
    const life = 1 - this.age / this.lifetime;
    if (life <= 0) return false;

    this.velocity.y -= dt * 9; // gravity
    this.mesh.position.addScaledVector(this.velocity, dt);
    this.mesh.material.opacity = Math.max(0, life);

    if (camera) this.mesh.quaternion.copy(camera.quaternion);
    return true;
  }

  dispose(scene) {
    scene.remove(this.mesh);
    this.mesh.material.dispose();
  }
}

export class VehicleDestruction {
  // root: THREE.Group whose world matrix positions the vehicle (Vehicle.js's
  // or RemoteVehicle.js's `.root`).
  constructor(scene, root) {
    this.scene = scene;
    this.root = root;

    this.active = false;
    this.smoke = [];
    this.sparks = [];
    this.timeSinceSmoke = 0;
    this.flickerTimer = 0;

    this.originalMaterials = new Map(); // material -> saved {color, emissiveIntensity, metalness, roughness}

    // Evolution armor/weapon meshes (see VehicleEvolution.js/TurretEvolution.js)
    // use a module-level material shared by every vehicle instance in the
    // scene, flagged via userData.sharedEvolutionMaterial. Those never go
    // into originalMaterials above -- they get a private per-activation
    // clone swapped onto the mesh instead (see _darkenMaterials()), tracked
    // here as { object, originalMaterial } so _restoreMaterials() can put
    // each mesh straight back on its real (shared, untouched) material and
    // dispose the clone.
    this._sharedSwaps = [];

    this.flash = null;
    this.flashAge = 0;

    this._worldPoint = new THREE.Vector3();
  }

  _darkenMaterial(material) {
    if (material.color) material.color.multiplyScalar(CHAR_DARKEN);
    if (typeof material.metalness === "number") material.metalness = 0;
    if (typeof material.roughness === "number") material.roughness = 1;
  }

  // Traverses the vehicle mesh tree once per activation, caching + darkening
  // every unique material found (many meshes share the same material
  // instance -- see Vehicle.js's createMaterials -- so each is only touched
  // once). Covers paint, trim, glass, and the dashboard display alike: a
  // charred, powered-down look is correct for all of them.
  //
  // Evolution meshes are handled separately (see class-level comment above)
  // -- their material is a cross-vehicle singleton, so it's cloned once per
  // unique shared material per activation (sharedClones below) rather than
  // mutated in place, and the clone is what actually gets darkened.
  _darkenMaterials() {
    const sharedClones = new Map(); // shared original material -> this activation's private clone

    this.root.traverse(object => {
      if (!object.material) return;

      const isArray = Array.isArray(object.material);
      const materials = isArray ? object.material : [object.material];

      if (object.userData?.sharedEvolutionMaterial === true) {
        const swapped = materials.map(material => {
          let clone = sharedClones.get(material);
          if (!clone) {
            clone = material.clone();
            sharedClones.set(material, clone);
            this._darkenMaterial(clone);
          }
          return clone;
        });

        this._sharedSwaps.push({
          object,
          originalMaterial: object.material // single value or array, exactly as it was
        });
        object.material = isArray ? swapped : swapped[0];
        return;
      }

      for (const material of materials) {
        if (this.originalMaterials.has(material)) continue;

        this.originalMaterials.set(material, {
          color: material.color ? material.color.clone() : null,
          emissiveIntensity:
            typeof material.emissiveIntensity === "number"
              ? material.emissiveIntensity
              : null,
          metalness:
            typeof material.metalness === "number" ? material.metalness : null,
          roughness:
            typeof material.roughness === "number" ? material.roughness : null
        });

        this._darkenMaterial(material);
      }
    });
  }

  _restoreMaterials() {
    for (const [material, saved] of this.originalMaterials) {
      if (saved.color) material.color.copy(saved.color);
      if (saved.emissiveIntensity !== null) {
        material.emissiveIntensity = saved.emissiveIntensity;
      }
      if (saved.metalness !== null) material.metalness = saved.metalness;
      if (saved.roughness !== null) material.roughness = saved.roughness;
    }
    this.originalMaterials.clear();

    // Put every evolution mesh back on its real (shared, never-mutated)
    // material and dispose the private clone that stood in for it. Each
    // clone is only ever referenced by the one or two meshes swapped onto
    // it during this activation, so once every swap referencing it has been
    // reverted, it's safe to dispose -- tracked via disposedClones so a
    // clone shared by several meshes (e.g. every "plate" armor piece) is
    // only disposed once, not once per mesh.
    const disposedClones = new Set();
    for (const { object, originalMaterial } of this._sharedSwaps) {
      const clones = Array.isArray(object.material) ? object.material : [object.material];
      for (const clone of clones) {
        if (!disposedClones.has(clone)) {
          clone.dispose();
          disposedClones.add(clone);
        }
      }
      object.material = originalMaterial;
    }
    this._sharedSwaps.length = 0;
  }

  // body: optional CANNON.Body (local player only). Gets a one-shot random
  // angular kick so the wreck settles at a slightly tilted rest angle as the
  // existing suspension/physics solver plays out naturally, instead of
  // sitting perfectly level -- no extra rendering work needed for the
  // "vehicle tilts / suspension collapses" look. Remote vehicles are
  // kinematic and skip this (no `body` passed).
  activate(body = null) {
    if (this.active) return;
    this.active = true;

    this._darkenMaterials();

    if (body) {
      body.angularVelocity.set(
        (Math.random() - 0.5) * 1.4,
        (Math.random() - 0.5) * 0.6,
        (Math.random() - 0.5) * 1.4
      );
      body.wakeUp();
    }

    this._worldPoint.set(0, 0.4, 0).applyMatrix4(this.root.matrixWorld);

    for (let i = 0; i < SPARK_COUNT; i++) {
      const spark = new Spark(this._worldPoint);
      this.scene.add(spark.mesh);
      this.sparks.push(spark);
    }

    const assets = getSharedAssets();
    this.flash = new THREE.Mesh(assets.quad, assets.flashMaterial.clone());
    this.flash.position.copy(this._worldPoint);
    this.flash.scale.setScalar(0.2);
    this.flash.renderOrder = 16;
    this.scene.add(this.flash);
    this.flashAge = 0;
  }

  deactivate() {
    if (!this.active) return;
    this.active = false;

    this._restoreMaterials();

    for (const puff of this.smoke) puff.dispose(this.scene);
    this.smoke.length = 0;

    for (const spark of this.sparks) spark.dispose(this.scene);
    this.sparks.length = 0;

    if (this.flash) {
      this.scene.remove(this.flash);
      this.flash.material.dispose();
      this.flash = null;
    }

    this.timeSinceSmoke = 0;
  }

  update(dt, camera = null) {
    dt = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.1)) : 0;

    if (this.active) {
      this.timeSinceSmoke += dt;
      while (
        this.timeSinceSmoke >= SMOKE_EMIT_INTERVAL &&
        this.smoke.length < MAX_SMOKE
      ) {
        this.timeSinceSmoke -= SMOKE_EMIT_INTERVAL;
        this._worldPoint
          .set(0, 0.35 + Math.random() * 0.2, 0)
          .applyMatrix4(this.root.matrixWorld);
        const puff = new SmokePuff(this._worldPoint);
        this.scene.add(puff.mesh);
        this.smoke.push(puff);
      }

      // Flickering damaged lights: a few times a second, nudge every
      // emissive material cached above toward a random low/off intensity.
      this.flickerTimer -= dt;
      if (this.flickerTimer <= 0) {
        this.flickerTimer = FLICKER_INTERVAL;
        for (const [material, saved] of this.originalMaterials) {
          if (saved.emissiveIntensity === null) continue;
          material.emissiveIntensity =
            Math.random() < 0.5
              ? 0
              : saved.emissiveIntensity * (0.3 + Math.random() * 0.7);
        }
      }
    }

    if (this.flash) {
      this.flashAge += dt;
      const life = 1 - this.flashAge / FLASH_DURATION;
      if (life <= 0) {
        this.scene.remove(this.flash);
        this.flash.material.dispose();
        this.flash = null;
      } else {
        this.flash.scale.setScalar(0.2 + (1 - life) * 3.5);
        this.flash.material.opacity = 0.9 * life;
        if (camera) this.flash.quaternion.copy(camera.quaternion);
      }
    }

    for (let i = this.smoke.length - 1; i >= 0; i--) {
      if (!this.smoke[i].update(dt, camera)) {
        this.smoke[i].dispose(this.scene);
        this.smoke.splice(i, 1);
      }
    }

    for (let i = this.sparks.length - 1; i >= 0; i--) {
      if (!this.sparks[i].update(dt, camera)) {
        this.sparks[i].dispose(this.scene);
        this.sparks.splice(i, 1);
      }
    }
  }

  dispose() {
    this.deactivate();
  }
}
