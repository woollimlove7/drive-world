import * as THREE from "three";
import { easeOutBack, clamp01 } from "./TurretMath.js";
import { getTurretEvolutionConfig, MAX_EVOLUTION_STAGE } from "../gameplay/EvolutionConfig.js";

// ---------------------------------------------------------------------------
// Turret weapon evolution.
//
// Reuses the existing turret assembly (see TurretModel.js) as the
// foundation: extra barrels/pods are attached as siblings of the existing
// `barrelMesh` inside `parts.barrelGroup`, so they automatically inherit the
// exact same telescoping deploy animation and recoil kick the base weapon
// already has (see TurretPose.js) with zero extra pose-code. Missile pods
// (stage 5) attach to `parts.gunMountPivot` instead, since they don't
// telescope.
//
// Weapon groups for every stage are built once per turret instance (lazily,
// the first time that stage is reached) and simply shown/hidden after that
// -- consistent with VehicleEvolution.js's approach and this project's
// "build geometry once, don't rebuild every frame" performance requirement.
// ---------------------------------------------------------------------------

let sharedMaterials = null;
function getWeaponMaterials() {
  if (sharedMaterials) return sharedMaterials;
  sharedMaterials = {
    gunmetal: new THREE.MeshStandardMaterial({ color: 0x2a2f36, metalness: 0.8, roughness: 0.35 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x15171b, metalness: 0.6, roughness: 0.5 }),
    barrel: new THREE.MeshStandardMaterial({ color: 0x1b1e22, metalness: 0.85, roughness: 0.3 }),
    warn: new THREE.MeshStandardMaterial({
      color: 0xff6a3d, emissive: 0xd94f22, emissiveIntensity: 0.7
    })
  };
  return sharedMaterials;
}

function barrelMesh(mat, length = 0.5, radius = 0.045) {
  const geo = new THREE.CylinderGeometry(radius, radius * 1.1, length, 10);
  geo.rotateX(Math.PI / 2);
  geo.translate(0, 0, length / 2);
  const mesh = new THREE.Mesh(geo, mat.barrel);
  mesh.castShadow = true;
  return mesh;
}

// A rotating cluster of `count` parallel barrels around a center hub --
// the shared building block for every "gatling" style stage.
function buildGatlingCluster(mat, count, length, radius) {
  const cluster = new THREE.Group();
  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 1.3, radius * 1.3, length * 0.3, 10),
    mat.gunmetal
  );
  hub.rotation.x = Math.PI / 2;
  hub.position.z = length * 0.15;
  cluster.add(hub);

  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count;
    const b = barrelMesh(mat, length, 0.03);
    b.position.set(Math.cos(angle) * radius, Math.sin(angle) * radius, 0);
    cluster.add(b);
  }

  return cluster;
}

// One "mount" = an independently-aimed muzzle point + its own barrel(s).
// Used for stage 2 (dual gun) and stage 3 (dual gatling): two of these,
// offset left/right, both firing every shot cycle.
function buildMount({ mat, gatling, barrelCount, length, offsetX }) {
  const mount = new THREE.Group();
  mount.position.set(offsetX, 0, 0);

  const support = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, 0.05, length * 0.5), mat.dark
  );
  support.position.z = length * 0.15;
  mount.add(support);

  let weapon;
  if (gatling) {
    weapon = buildGatlingCluster(mat, barrelCount, length, 0.045);
  } else {
    weapon = new THREE.Group();
    weapon.add(barrelMesh(mat, length, 0.05));
  }
  mount.add(weapon);

  const muzzle = new THREE.Group();
  muzzle.position.z = length;
  mount.add(muzzle);

  return { mount, weapon, muzzle };
}

function buildStage1_Gatling(mat) {
  const { mount, weapon, muzzle } = buildMount({
    mat, gatling: true, barrelCount: 4, length: 0.55, offsetX: 0
  });
  return { group: mount, muzzles: [muzzle], spinners: [weapon] };
}

function buildStage2_DualGun(mat) {
  const group = new THREE.Group();
  const muzzles = [];
  for (const side of [-1, 1]) {
    const { mount, muzzle } = buildMount({
      mat, gatling: false, barrelCount: 1, length: 0.48, offsetX: side * 0.09
    });
    group.add(mount);
    muzzles.push(muzzle);
  }
  return { group, muzzles, spinners: [] };
}

function buildStage3_DualGatling(mat) {
  const group = new THREE.Group();
  const muzzles = [];
  const spinners = [];
  for (const side of [-1, 1]) {
    const { mount, weapon, muzzle } = buildMount({
      mat, gatling: true, barrelCount: 4, length: 0.55, offsetX: side * 0.12
    });
    group.add(mount);
    muzzles.push(muzzle);
    spinners.push(weapon);
  }
  return { group, muzzles, spinners };
}

function buildStage4_Heavy(mat) {
  const { mount, weapon, muzzle } = buildMount({
    mat, gatling: true, barrelCount: 3, length: 0.62, offsetX: 0
  });
  // Reinforced housing + ammo feed block make it read as "advanced/heavy"
  // rather than just a bigger gatling gun.
  const housing = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.14, 0.2), mat.gunmetal);
  housing.position.z = 0.08;
  mount.add(housing);
  const feed = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.22), mat.dark);
  feed.position.set(0.12, 0.05, 0.05);
  mount.add(feed);

  return { group: mount, muzzles: [muzzle], spinners: [weapon] };
}

function buildStage5_Missile(mat) {
  const group = new THREE.Group();
  // Heavy central barrel stays (still a gun, plus missiles).
  const centerBarrel = barrelMesh(mat, 0.55, 0.05);
  group.add(centerBarrel);
  const centerMuzzle = new THREE.Group();
  centerMuzzle.position.z = 0.55;
  group.add(centerMuzzle);

  const pods = [];
  for (const side of [-1, 1]) {
    const pod = new THREE.Group();
    pod.position.set(side * 0.16, 0.02, -0.02);

    const housing = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.3), mat.gunmetal);
    pod.add(housing);

    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 2; col++) {
        const missile = new THREE.Mesh(
          new THREE.CylinderGeometry(0.025, 0.025, 0.26, 8), mat.dark
        );
        missile.rotation.x = Math.PI / 2;
        missile.position.set((col - 0.5) * 0.06, (row - 0.5) * 0.06, 0.02);
        pod.add(missile);
      }
    }

    const warnLight = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.01, 8), mat.warn);
    warnLight.rotation.x = Math.PI / 2;
    warnLight.position.set(0, 0.07, 0.16);
    pod.add(warnLight);

    group.add(pod);
    pods.push(pod);
  }

  return { group, muzzles: [centerMuzzle], spinners: [], pods };
}

const STAGE_BUILDERS = [
  null, // stage 0 = the turret's original default gun, built by TurretModel.js
  buildStage1_Gatling,
  buildStage2_DualGun,
  buildStage3_DualGatling,
  buildStage4_Heavy,
  buildStage5_Missile
];

const GATLING_SPIN_SPEED = 14; // rad/s while actively deployed+targeting

// ---------------------------------------------------------------------------
// Rig: attaches to a turret assembly's `parts` (from createTurretAssembly)
// and manages which weapon stage is currently shown.
// ---------------------------------------------------------------------------
export class TurretEvolutionRig {
  constructor(parts) {
    this.parts = parts;
    this.mat = getWeaponMaterials();
    this.built = new Array(STAGE_BUILDERS.length).fill(null);
    this.currentStage = 0;
    this.spinAngle = 0;

    this.animGroup = null;
    this.animElapsed = 0;
    this.animDuration = 1.6;

    this.fireFlashTimer = 0; // used for missile pod launch pulse
  }

  setStage(stage, { animate = true } = {}) {
    const target = Math.max(0, Math.min(MAX_EVOLUTION_STAGE, stage));

    // Base default barrel only shown at stage 0.
    this.parts.barrelMesh.visible = target === 0;

    for (let s = 1; s <= target; s++) {
      if (!this.built[s]) {
        const parent = s === MAX_EVOLUTION_STAGE
          ? this.parts.gunMountPivot // missile pods: don't telescope
          : this.parts.barrelGroup; // everything else rides the barrel group

        const built = STAGE_BUILDERS[s](this.mat);

        // Every mesh in a stage group uses one of this rig's shared,
        // module-level materials (getWeaponMaterials() above) -- tag them
        // all in one pass here rather than at each of the many individual
        // mesh-creation call sites in the stage builders below.
        // VehicleDestruction.js checks this flag before darkening anything,
        // so it clones a private copy for the wreck effect instead of
        // mutating the singleton every turret points at (see
        // VehicleDestruction._darkenMaterials()).
        built.group.traverse(obj => {
          if (obj.isMesh) obj.userData.sharedEvolutionMaterial = true;
        });

        parent.add(built.group);
        built.group.visible = false;
        this.built[s] = built;
      }
    }

    // Only the active stage's group is visible; earlier ones are hidden
    // (armor stacks visually on the vehicle, but a turret only ever wields
    // one weapon configuration at a time).
    for (let s = 1; s < this.built.length; s++) {
      if (this.built[s]) this.built[s].group.visible = s === target;
    }

    if (animate && target !== this.currentStage && target > 0 && this.built[target]) {
      this.beginReveal(this.built[target].group, getTurretEvolutionConfig(target).animationDuration);
    }

    this.currentStage = target;
  }

  beginReveal(group, duration) {
    group.scale.setScalar(0.05);
    this.animGroup = group;
    this.animElapsed = 0;
    this.animDuration = duration;
  }

  // Returns the world-space muzzle points to fire from this frame (1 or 2
  // depending on stage). Falls back to the base turret's own muzzleTip at
  // stage 0.
  getMuzzlePoints() {
    if (this.currentStage === 0 || !this.built[this.currentStage]) {
      return [this.parts.muzzleTip];
    }
    return this.built[this.currentStage].muzzles;
  }

  getDamageConfig() {
    return getTurretEvolutionConfig(this.currentStage);
  }

  onFire() {
    this.fireFlashTimer = 1;
  }

  // deployed/aiming: whether gatling barrels should be actively spinning.
  update(dt, { deployed, firing } = {}) {
    if (this.animGroup) {
      this.animElapsed += dt;
      const t = clamp01(this.animElapsed / this.animDuration);
      this.animGroup.scale.setScalar(Math.max(0.05, easeOutBack(t)));
      if (t >= 1) {
        this.animGroup.scale.setScalar(1);
        this.animGroup = null;
      }
    }

    const active = this.built[this.currentStage];
    if (active?.spinners?.length) {
      const speed = deployed ? (firing ? GATLING_SPIN_SPEED : GATLING_SPIN_SPEED * 0.25) : 0;
      this.spinAngle += speed * dt;
      for (const spinner of active.spinners) spinner.rotation.z = this.spinAngle;
    }

    if (this.fireFlashTimer > 0) {
      this.fireFlashTimer = Math.max(0, this.fireFlashTimer - dt / 0.15);
      if (active?.pods) {
        const kick = 1 + this.fireFlashTimer * 0.4;
        for (const pod of active.pods) pod.scale.setScalar(kick);
      }
    }
  }

  dispose() {
    for (const built of this.built) {
      if (!built) continue;
      built.group.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose();
      });
      built.group.parent?.remove(built.group);
    }
  }
}
