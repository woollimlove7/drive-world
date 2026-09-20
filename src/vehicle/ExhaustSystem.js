import * as THREE from "three";

// ---------------------------------------------------------------------------
// Exhaust puffs, emitted from one or more fixed local-space points on a
// vehicle's root Group. Geometry/materials are created once at module scope
// and shared by every instance (local player + every remote car); only each
// puff's own material clone (for independent opacity/color fade) and
// transform are per-instance -- the same pattern already used by
// gameplay/HealthBar.js and turret/TurretEffects.js.
//
// Two visual modes:
//   - normal driving: small, slow, subtle grey smoke puffs
//   - turbo active:   larger, faster, brighter flame puffs
// so the turbo effect on its own communicates "turbo is active" without any
// separate UI.
//
// The turbo flame's color also reflects the vehicle's evolution stage (see
// VehicleEvolution.js): stock/mid stages get the classic orange flame, while
// Elite/Ultimate stages (4-5) burn hotter cyan-white, matching the tech
// accent color those stages already use on the body. This never changes
// turbo *gameplay* (duration/cooldown/force -- see TurboSystem.js), only the
// look of the particles it triggers. Call `setEvolutionStage(stage)` on this
// instance whenever the owning vehicle's stage changes (mirrors
// Vehicle.js/RemoteVehicle.js's own setEvolutionStage) to opt in; if it's
// never called, exhaust looks exactly as before.
// ---------------------------------------------------------------------------

const MAX_PUFFS = 40;

const NORMAL_EMIT_INTERVAL = 0.1;
const TURBO_EMIT_INTERVAL = 0.025;

const NORMAL_LIFETIME = 0.55;
const TURBO_LIFETIME = 0.32;

const NORMAL_SIZE = 0.09;
const TURBO_SIZE = 0.15;

let sharedAssets = null;

function getSharedAssets() {
  if (sharedAssets) return sharedAssets;

  sharedAssets = {
    geometry: new THREE.PlaneGeometry(1, 1),

    smokeMaterial: new THREE.MeshBasicMaterial({
      color: 0xaeb8c2,
      transparent: true,
      opacity: 0.32,
      depthWrite: false
    }),

    flameMaterial: new THREE.MeshBasicMaterial({
      color: 0xff9a3c,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    }),

    // Hotter cyan-white flame used for Elite/Ultimate evolution stages (see
    // ExhaustSystem's class-level comment above). Same lifetime/size/motion
    // as the normal flame -- only the color changes.
    eliteFlameMaterial: new THREE.MeshBasicMaterial({
      color: 0x9ff4ea,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
  };

  return sharedAssets;
}

class Puff {
  constructor(worldPosition, boosted, elite = false) {
    const assets = getSharedAssets();

    this.boosted = boosted;
    this.age = 0;
    this.lifetime = boosted ? TURBO_LIFETIME : NORMAL_LIFETIME;
    this.baseSize = boosted ? TURBO_SIZE : NORMAL_SIZE;

    const sourceMaterial = boosted
      ? (elite ? assets.eliteFlameMaterial : assets.flameMaterial)
      : assets.smokeMaterial;

    this.mesh = new THREE.Mesh(assets.geometry, sourceMaterial.clone());
    this.baseOpacity = sourceMaterial.opacity;

    this.mesh.position.copy(worldPosition);
    this.mesh.scale.setScalar(this.baseSize);
    this.mesh.renderOrder = 12;

    // Drifts backward (and a little up/sideways) off the tailpipe. Turbo
    // puffs shoot back noticeably faster than idle smoke.
    this.velocity = new THREE.Vector3(
      (Math.random() - 0.5) * 0.2,
      0.15 + Math.random() * 0.2,
      -(boosted ? 3 + Math.random() * 1.5 : 0.6 + Math.random() * 0.4)
    );
  }

  // camera: for billboarding the flat quad toward the viewer, same approach
  // as HealthBar.updateTransform.
  update(dt, camera) {
    this.age += dt;
    const life = 1 - this.age / this.lifetime;
    if (life <= 0) return false;

    this.mesh.position.addScaledVector(this.velocity, dt);

    const growth = this.boosted ? 1 + this.age * 3.5 : 1 + this.age * 1.8;
    this.mesh.scale.setScalar(this.baseSize * growth);
    this.mesh.material.opacity = this.baseOpacity * Math.max(0, life);

    if (camera) this.mesh.quaternion.copy(camera.quaternion);

    return true;
  }

  dispose(scene) {
    scene.remove(this.mesh);
    this.mesh.material.dispose();
  }
}

export class ExhaustSystem {
  // root: THREE.Group whose world matrix positions the vehicle.
  // localOffsets: array of THREE.Vector3, exhaust tip positions in the
  // vehicle's own local space (one entry per tailpipe).
  constructor(scene, root, localOffsets) {
    this.scene = scene;
    this.root = root;
    this.offsets = localOffsets.length > 0
      ? localOffsets
      : [new THREE.Vector3(0, -0.16, -2.1)];

    this.puffs = [];
    this.timeSinceEmit = 0;
    this._worldPoint = new THREE.Vector3();

    // 0 by default (classic orange flame) -- see class-level comment.
    // ELITE_FLAME_STAGE mirrors VehicleEvolution.js's stage 4 (Elite).
    this.evolutionStage = 0;
  }

  // Mirrors Vehicle.js/RemoteVehicle.js's own setEvolutionStage -- call this
  // from whatever owns both the vehicle and its ExhaustSystem whenever the
  // vehicle's evolution stage changes, e.g.:
  //   vehicle.setEvolutionStage(stage);
  //   exhaustSystem.setEvolutionStage(vehicle.currentEvolutionStage);
  // Safe to never call: exhaust then just keeps its stage-0 orange flame.
  setEvolutionStage(stage) {
    this.evolutionStage = stage;
  }

  // running: is the engine on / car "alive" (skip entirely for a
  // disconnected/disposed player). boosting: is turbo currently active.
  update(dt, camera, { running = true, boosting = false } = {}) {
    dt = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.1)) : 0;

    if (running) {
      this.timeSinceEmit += dt;
      const interval = boosting ? TURBO_EMIT_INTERVAL : NORMAL_EMIT_INTERVAL;

      while (
        this.timeSinceEmit >= interval &&
        this.puffs.length < MAX_PUFFS
      ) {
        this.timeSinceEmit -= interval;
        this.emit(boosting);
      }
    } else {
      this.timeSinceEmit = 0;
    }

    for (let i = this.puffs.length - 1; i >= 0; i--) {
      if (!this.puffs[i].update(dt, camera)) {
        this.puffs[i].dispose(this.scene);
        this.puffs.splice(i, 1);
      }
    }
  }

  emit(boosting) {
    const elite = boosting && this.evolutionStage >= 4;
    for (const offset of this.offsets) {
      this._worldPoint.copy(offset).applyMatrix4(this.root.matrixWorld);

      const puff = new Puff(this._worldPoint, boosting, elite);
      this.scene.add(puff.mesh);
      this.puffs.push(puff);
    }
  }

  dispose() {
    for (const puff of this.puffs) puff.dispose(this.scene);
    this.puffs.length = 0;
  }
}
