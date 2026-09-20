import * as THREE from "three";

// ---------------------------------------------------------------------------
// Reusable layered explosion effect for turret/projectile impacts.
//
// The effect is intentionally self-contained so TurretEffectsPool can treat
// it exactly like the existing tracer/impact effects:
//   const explosion = new Explosion(position, CONFIG);
//   scene.add(explosion.group);
//   effects.push(explosion);
//
// Shared geometries are created once. Materials are cloned per effect so the
// active particles/meshes can fade independently without mutating shared
// materials. All temporary objects are removed and their per-instance
// materials disposed by dispose().
// ---------------------------------------------------------------------------

export const PLAYER_MISSILE_EXPLOSION_CONFIG = Object.freeze({
  radius: 2.6,
  duration: 0.55,
  flashDuration: 0.09,
  shockwaveRadius: 4.2,
  shockwaveDuration: 0.38,
  particleCount: 18,
  debrisCount: 7,
  smokeCount: 7,
  gravity: 7.5,
  particleSpeedMin: 2.5,
  particleSpeedMax: 6.0,
  debrisSpeedMin: 2.0,
  debrisSpeedMax: 4.5,
  smokeRiseSpeedMin: 0.6,
  smokeRiseSpeedMax: 1.4,
  groundDust: true,
  scorch: true,
  groundScale: 1.0,
  coreOpacity: 0.98,
  shockwaveOpacity: 0.75
});

export const APEX_ROCKET_EXPLOSION_CONFIG = Object.freeze({
  radius: 6.5,
  duration: 0.95,
  flashDuration: 0.14,
  shockwaveRadius: 10.5,
  shockwaveDuration: 0.68,
  particleCount: 34,
  debrisCount: 13,
  smokeCount: 13,
  gravity: 8.5,
  particleSpeedMin: 4.0,
  particleSpeedMax: 10.0,
  debrisSpeedMin: 3.0,
  debrisSpeedMax: 7.5,
  smokeRiseSpeedMin: 0.8,
  smokeRiseSpeedMax: 1.9,
  groundDust: true,
  scorch: true,
  groundScale: 1.25,
  coreOpacity: 1.0,
  shockwaveOpacity: 0.9
});

export const APEX_ROCKET_LAUNCH_FLASH_CONFIG = Object.freeze({
  radius: 1.15,
  duration: 0.16,
  flashDuration: 0.1,
  shockwaveRadius: 1.8,
  shockwaveDuration: 0.16,
  particleCount: 6,
  debrisCount: 0,
  smokeCount: 3,
  gravity: 2.0,
  particleSpeedMin: 1.0,
  particleSpeedMax: 2.5,
  debrisSpeedMin: 0.5,
  debrisSpeedMax: 1.0,
  smokeRiseSpeedMin: 0.3,
  smokeRiseSpeedMax: 0.7,
  groundDust: false,
  scorch: false,
  groundScale: 1.0,
  coreOpacity: 1.0,
  shockwaveOpacity: 0.55
});

let sharedAssets = null;

function getSharedAssets() {
  if (sharedAssets) return sharedAssets;

  sharedAssets = {
    coreGeometry: new THREE.SphereGeometry(1, 14, 10),
    innerGeometry: new THREE.SphereGeometry(1, 10, 8),
    shockwaveGeometry: new THREE.TorusGeometry(1, 0.045, 6, 32),
    particleGeometry: new THREE.BoxGeometry(0.10, 0.10, 0.10),
    debrisGeometry: new THREE.BoxGeometry(0.18, 0.18, 0.18),
    smokeGeometry: new THREE.SphereGeometry(0.22, 8, 6),
    groundRingGeometry: new THREE.RingGeometry(0.78, 1.0, 40),
    scorchGeometry: new THREE.CircleGeometry(0.92, 40)
  };

  return sharedAssets;
}

function makeMaterial(type, options = {}) {
  const base = type === "standard"
    ? new THREE.MeshStandardMaterial({
        color: options.color ?? 0xff7b23,
        emissive: options.emissive ?? 0xff3b08,
        emissiveIntensity: options.emissiveIntensity ?? 1.5,
        metalness: 0.05,
        roughness: 0.45,
        transparent: true,
        depthWrite: false
      })
    : new THREE.MeshBasicMaterial({
        color: options.color ?? 0xff7b23,
        transparent: true,
        opacity: options.opacity ?? 1,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      });
  return base;
}

function randomDirection(out) {
  const y = Math.random() * 2 - 0.25;
  const angle = Math.random() * Math.PI * 2;
  const horizontal = Math.sqrt(Math.max(0, 1 - Math.min(1, y * y)));
  out.set(Math.cos(angle) * horizontal, y, Math.sin(angle) * horizontal).normalize();
  return out;
}

function randomRange(min, max) {
  return min + Math.random() * (max - min);
}

class ExplosionParticleSet {
  constructor(group, config, shared) {
    this.particles = [];
    this.debris = [];
    this.smoke = [];
    this.config = config;

    const particleMaterial = makeMaterial("basic", {
      color: 0xffb347,
      opacity: 0.95
    });
    const emberMaterial = makeMaterial("basic", {
      color: 0xffe8b0,
      opacity: 1
    });
    const debrisMaterial = new THREE.MeshStandardMaterial({
      color: 0x545a60,
      emissive: 0x2b1d14,
      emissiveIntensity: 0.35,
      metalness: 0.7,
      roughness: 0.55
    });
    const smokeMaterial = new THREE.MeshBasicMaterial({
      color: 0x4d5157,
      transparent: true,
      opacity: 0.32,
      depthWrite: false
    });

    for (let i = 0; i < (config.particleCount ?? 0); i++) {
      const mesh = new THREE.Mesh(
        shared.particleGeometry,
        (i % 3 === 0 ? emberMaterial : particleMaterial).clone()
      );
      const dir = randomDirection(new THREE.Vector3());
      const speed = randomRange(config.particleSpeedMin ?? 2, config.particleSpeedMax ?? 6);
      mesh.position.set(0, 0.2, 0);
      mesh.scale.setScalar(randomRange(0.65, 1.45));
      mesh.rotation.set(Math.random(), Math.random(), Math.random());
      group.add(mesh);
      this.particles.push({
        mesh,
        velocity: dir.multiplyScalar(speed),
        spin: new THREE.Vector3(
          randomRange(-9, 9),
          randomRange(-9, 9),
          randomRange(-9, 9)
        )
      });
    }

    for (let i = 0; i < (config.debrisCount ?? 0); i++) {
      const mesh = new THREE.Mesh(shared.debrisGeometry, debrisMaterial.clone());
      const dir = randomDirection(new THREE.Vector3());
      const speed = randomRange(config.debrisSpeedMin ?? 2, config.debrisSpeedMax ?? 5);
      mesh.position.set(0, 0.15, 0);
      mesh.scale.setScalar(randomRange(0.7, 1.5));
      mesh.rotation.set(Math.random(), Math.random(), Math.random());
      group.add(mesh);
      this.debris.push({
        mesh,
        velocity: dir.multiplyScalar(speed),
        spin: new THREE.Vector3(
          randomRange(-7, 7),
          randomRange(-7, 7),
          randomRange(-7, 7)
        )
      });
    }

    for (let i = 0; i < (config.smokeCount ?? 0); i++) {
      const mesh = new THREE.Mesh(shared.smokeGeometry, smokeMaterial.clone());
      mesh.position.set(
        randomRange(-0.25, 0.25),
        randomRange(0.05, 0.35),
        randomRange(-0.25, 0.25)
      );
      mesh.scale.setScalar(randomRange(0.7, 1.15));
      group.add(mesh);
      this.smoke.push({
        mesh,
        velocity: new THREE.Vector3(
          randomRange(-0.35, 0.35),
          randomRange(config.smokeRiseSpeedMin ?? 0.5, config.smokeRiseSpeedMax ?? 1.5),
          randomRange(-0.35, 0.35)
        ),
        phase: Math.random() * Math.PI * 2,
        baseScale: mesh.scale.x
      });
    }
  }

  update(dt, age) {
    const gravity = this.config.gravity ?? 7;

    for (const particle of this.particles) {
      particle.velocity.y -= gravity * dt;
      particle.mesh.position.addScaledVector(particle.velocity, dt);
      particle.mesh.rotation.x += particle.spin.x * dt;
      particle.mesh.rotation.y += particle.spin.y * dt;
      particle.mesh.rotation.z += particle.spin.z * dt;
      const fade = Math.max(0, 1 - age / Math.max(0.001, this.config.duration ?? 0.6));
      particle.mesh.material.opacity = fade;
      particle.mesh.scale.setScalar(Math.max(0.08, 0.65 + fade * 0.55));
    }

    for (const piece of this.debris) {
      piece.velocity.y -= gravity * dt;
      piece.mesh.position.addScaledVector(piece.velocity, dt);
      piece.mesh.rotation.x += piece.spin.x * dt;
      piece.mesh.rotation.y += piece.spin.y * dt;
      piece.mesh.rotation.z += piece.spin.z * dt;
      const fade = Math.max(0, 1 - age / Math.max(0.001, this.config.duration ?? 0.9));
      piece.mesh.material.opacity = fade;
    }

    for (const smoke of this.smoke) {
      smoke.mesh.position.addScaledVector(smoke.velocity, dt);
      const progress = Math.min(1, age / Math.max(0.001, this.config.duration ?? 0.8));
      const pulse = 1 + Math.sin(age * 5 + smoke.phase) * 0.08;
      smoke.mesh.scale.setScalar(smoke.baseScale * (1 + progress * 2.2) * pulse);
      smoke.mesh.material.opacity = Math.max(0, 0.32 * (1 - progress));
    }
  }

  dispose() {
    const disposeMaterials = list => {
      for (const item of list) item.mesh.material.dispose();
    };
    disposeMaterials(this.particles);
    disposeMaterials(this.debris);
    disposeMaterials(this.smoke);
  }
}

export class Explosion {
  constructor(position, config = PLAYER_MISSILE_EXPLOSION_CONFIG) {
    this.config = { ...PLAYER_MISSILE_EXPLOSION_CONFIG, ...config };
    const shared = getSharedAssets();

    this.group = new THREE.Group();
    this.group.position.copy(position);
    this.age = 0;

    this.flash = new THREE.Mesh(
      shared.innerGeometry,
      makeMaterial("basic", { color: 0xfff4c4, opacity: 1 })
    );
    this.group.add(this.flash);

    this.core = new THREE.Mesh(
      shared.coreGeometry,
      makeMaterial("standard", {
        color: 0xff6a1f,
        emissive: 0xff3300,
        emissiveIntensity: 2.8,
        opacity: this.config.coreOpacity
      })
    );
    this.group.add(this.core);

    this.innerCore = new THREE.Mesh(
      shared.innerGeometry,
      makeMaterial("basic", { color: 0xfff0a6, opacity: 0.9 })
    );
    this.group.add(this.innerCore);

    this.shockwave = new THREE.Mesh(
      shared.shockwaveGeometry,
      makeMaterial("basic", {
        color: 0xffb12b,
        opacity: this.config.shockwaveOpacity
      })
    );
    this.shockwave.rotation.x = Math.PI / 2;
    this.group.add(this.shockwave);

    this.particles = new ExplosionParticleSet(this.group, this.config, shared);

    this.groundRing = null;
    if (this.config.groundDust) {
      this.groundRing = new THREE.Mesh(
        shared.groundRingGeometry,
        makeMaterial("basic", { color: 0xff6a24, opacity: 0.7 })
      );
      this.groundRing.rotation.x = -Math.PI / 2;
      this.group.add(this.groundRing);
    }

    this.scorch = null;
    if (this.config.scorch) {
      this.scorch = new THREE.Mesh(
        shared.scorchGeometry,
        new THREE.MeshBasicMaterial({
          color: 0x181818,
          transparent: true,
          opacity: 0.28,
          depthWrite: false
        })
      );
      this.scorch.rotation.x = -Math.PI / 2;
      this.scorch.position.y = 0.012;
      this.group.add(this.scorch);
    }

    const scale = Math.max(0.25, this.config.groundScale ?? 1);
    if (this.groundRing) this.groundRing.scale.setScalar(scale);
    if (this.scorch) this.scorch.scale.setScalar(scale);
  }

  update(dt) {
    this.age += dt;

    const duration = Math.max(0.05, this.config.duration ?? 0.6);
    const flashDuration = Math.max(0.02, this.config.flashDuration ?? 0.1);
    const shockDuration = Math.max(0.05, this.config.shockwaveDuration ?? 0.4);

    const p = Math.min(1, this.age / duration);
    const flashP = Math.min(1, this.age / flashDuration);
    const shockP = Math.min(1, this.age / shockDuration);

    // Fast white flash, then immediate fade.
    const flashOpacity = Math.max(0, 1 - flashP);
    this.flash.material.opacity = flashOpacity;
    const flashScale = (0.25 + Math.min(1, flashP) * this.config.radius * 0.38) * (1 + (1 - flashP) * 0.8);
    this.flash.scale.setScalar(flashScale);

    // Main hot core: expands quickly and then burns out.
    const corePulse = Math.sin(Math.min(1, p) * Math.PI);
    const coreScale = this.config.radius * (0.18 + p * 0.82) * (0.92 + corePulse * 0.12);
    this.core.scale.setScalar(coreScale);
    this.core.material.opacity = this.config.coreOpacity * Math.max(0, 1 - p * 0.92);
    this.core.material.emissiveIntensity = 2.8 * Math.max(0.1, 1 - p * 0.85);

    const innerScale = this.config.radius * (0.08 + Math.min(1, p * 1.8) * 0.36);
    this.innerCore.scale.setScalar(innerScale);
    this.innerCore.material.opacity = 0.9 * Math.max(0, 1 - p * 1.5);

    // Ground shockwave.
    const shockFade = Math.max(0, 1 - shockP);
    this.shockwave.scale.setScalar(this.config.shockwaveRadius * (0.05 + shockP * 0.95));
    this.shockwave.material.opacity = this.config.shockwaveOpacity * shockFade;
    this.shockwave.rotation.z += dt * 0.8;

    if (this.groundRing) {
      this.groundRing.scale.setScalar((this.config.groundScale ?? 1) * (0.45 + shockP * 1.15));
      this.groundRing.material.opacity = 0.65 * shockFade;
    }

    if (this.scorch) {
      this.scorch.material.opacity = 0.28 * Math.min(1, this.age / 0.12) * Math.max(0, 1 - p * 0.35);
      this.scorch.scale.setScalar((this.config.groundScale ?? 1) * (0.45 + p * 0.85));
    }

    this.particles.update(dt, this.age);

    return this.age < duration;
  }

  dispose(scene) {
    scene.remove(this.group);

    const materialMeshes = [
      this.flash,
      this.core,
      this.innerCore,
      this.shockwave,
      this.groundRing,
      this.scorch
    ].filter(Boolean);

    for (const mesh of materialMeshes) mesh.material.dispose();
    this.particles.dispose();
  }
}
