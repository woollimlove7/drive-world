import * as THREE from "three";
import { createTurretAssembly } from "./TurretModel.js";
import { applyTurretPose } from "./TurretPose.js";
import { TurretEffectsPool } from "./TurretEffects.js";
import { TURRET_CONFIG, REMOTE_TURRET_ANCHOR } from "./TurretConfig.js";
import { stepAngle, stepToward } from "./TurretMath.js";
import { TurretEvolutionRig } from "./TurretEvolution.js";
import { TurretArmorRig } from "./TurretArmor.js";
import { PLAYER_MISSILE_EXPLOSION_CONFIG } from "./ExplosionEffect.js";

// ---------------------------------------------------------------------------
// The remote counterpart to Turret.js. It never scans for targets, never
// selects, never decides to fire -- it only reproduces what the network says
// happened (deploy state, aim angles, and discrete fire events), using the
// exact same mechanical pose function as the local turret so every player
// sees the same transformation. See requirement: remote turrets replay
// state/events locally rather than receiving per-part transforms.
// ---------------------------------------------------------------------------

const VISUAL_TRACER_LENGTH = 22;

export class RemoteTurret {
  constructor(vehicleRoot, scene, color) {
    this.vehicleRoot = vehicleRoot;
    this.scene = scene;

    const assembly = createTurretAssembly(color ?? 0x9aa0a6);
    this.parts = assembly.parts;

    assembly.root.position.set(
      REMOTE_TURRET_ANCHOR.x,
      REMOTE_TURRET_ANCHOR.y,
      REMOTE_TURRET_ANCHOR.z
    );
    vehicleRoot.add(assembly.root);

    this.progress = 0;
    this.targetProgress = 0;

    this.yaw = 0;
    this.pitch = 0;
    this.targetYaw = 0;
    this.targetPitch = 0;

    this.lastFireSeq = 0;
    this.recoil = 0;
    this.flash = 0;

    this.effects = new TurretEffectsPool(scene);

    this.evolution = new TurretEvolutionRig(this.parts);
    this.armor = new TurretArmorRig(this.parts);
    this.evolutionStage = 0;

    applyTurretPose(this.parts, {
      progress: 0, yaw: 0, pitch: 0, recoil: 0, flash: 0
    });
  }

  // Called by RemoteVehicle.js when the remote player's level (and thus
  // derived evolution stage) changes -- see EvolutionConfig.getEvolutionStage.
  setEvolutionStage(stage, { animate = true } = {}) {
    if (stage === this.evolutionStage) return;
    this.evolutionStage = stage;
    this.evolution.setStage(stage, { animate });
    this.armor.setStage(stage, { animate });
  }

  // Called whenever a fresh network sample for this player arrives.
  // `turret` matches Turret.getNetworkState()'s shape; missing/malformed
  // data (older protocol, packet loss) falls back to a safe default rather
  // than throwing.
  setNetworkState(turret) {
    const deployed = turret?.state === "deployed" || turret?.state === "deploying";
    this.targetProgress = deployed ? 1 : 0;

    this.targetYaw = Number.isFinite(turret?.yaw) ? turret.yaw : 0;
    this.targetPitch = Number.isFinite(turret?.pitch) ? turret.pitch : 0;

    const fireSeq = Number.isInteger(turret?.fireSeq) ? turret.fireSeq : this.lastFireSeq;

    if (fireSeq !== this.lastFireSeq) {
      this.lastFireSeq = fireSeq;
      this.playFireEffect();
    }
  }

  playFireEffect() {
    this.recoil = 1;
    this.flash = 1;
    this.evolution.onFire();

    // Same source of truth Turret.js's local tryFire() uses -- so a remote
    // player's level-10 missile reads as the same big explosion for
    // everyone watching, not just for the shooter.
    const weapon = this.evolution.getDamageConfig();

    for (const muzzle of this.evolution.getMuzzlePoints()) {
      muzzle.updateWorldMatrix(true, false);
      const origin = new THREE.Vector3();
      muzzle.getWorldPosition(origin);

      const forward = new THREE.Vector3(0, 0, 1)
        .applyQuaternion(muzzle.getWorldQuaternion(new THREE.Quaternion()));

      const endpoint = origin.clone().addScaledVector(forward, VISUAL_TRACER_LENGTH);

      this.effects.spawnTracer(origin, endpoint);
      if (weapon.weaponType === "missile") {
        this.effects.spawnExplosion(endpoint, PLAYER_MISSILE_EXPLOSION_CONFIG);
      } else {
        this.effects.spawnImpact(endpoint);
      }
    }
  }

  update(dt) {
    // Progress simply chases whatever the network last said, using the same
    // durations as the local turret so both players see a comparable-speed
    // transformation.
    const duration = this.targetProgress > this.progress
      ? TURRET_CONFIG.deployDuration
      : TURRET_CONFIG.undeployDuration;

    this.progress = stepToward(
      this.progress,
      this.targetProgress,
      dt / duration
    );

    this.yaw = stepAngle(this.yaw, this.targetYaw, TURRET_CONFIG.rotationSpeed * dt);
    this.pitch = stepToward(this.pitch, this.targetPitch, TURRET_CONFIG.elevationSpeed * dt);

    this.recoil = Math.max(0, this.recoil - dt / TURRET_CONFIG.recoilDuration);
    this.flash = Math.max(0, this.flash - dt / TURRET_CONFIG.muzzleFlashDuration);

    applyTurretPose(this.parts, {
      progress: this.progress,
      yaw: this.yaw,
      pitch: this.pitch,
      recoil: this.recoil,
      flash: this.flash
    });

    this.evolution.update(dt, {
      deployed: this.progress > 0.9,
      firing: this.recoil > 0
    });
    this.armor.update(dt);

    this.effects.update(dt);
  }

  dispose() {
    this.effects.dispose();
    this.evolution.dispose();
    this.armor.dispose();
  }
}