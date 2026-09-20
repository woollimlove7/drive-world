import * as THREE from "three";
import { easeOutBack, clamp01 } from "./TurretMath.js";

// ---------------------------------------------------------------------------
// Turret ARMOR evolution.
//
// This is deliberately a separate rig from TurretEvolutionRig (see
// TurretEvolution.js), which owns the *weapon* progression (gatling ->
// dual gun -> dual gatling -> heavy gatling -> missile pods) and is
// wired into firing/damage/muzzle-point logic in Turret.js/RemoteTurret.js.
// This rig only adds/removes nothing gameplay-relevant: it bolts
// cumulative armor plating onto the turret's existing static body parts
// (see TurretModel.js) so the turret visibly becomes a more heavily
// armored weapon system as it levels up, exactly mirroring
// VehicleEvolution.js's philosophy for the vehicle body:
//   - armor is ADDITIVE and cumulative (once earned, it stays -- stage 5
//     still shows stage 1-4's armor underneath/alongside it)
//   - armor plate is the dominant material at every stage; emissive tech
//     accents are introduced only at stage 4+ and kept thin/sparse
//   - built once per stage, lazily, the first time that stage is reached
//     -- never rebuilt, no per-frame geometry generation
//
// Two groups are built per stage and attached to two different existing
// parts so each half of the armor inherits the correct existing motion:
//   - `body`    -> parent parts.bodyShell (turret drum: yaws with the
//                  turret, folds during deploy/stow exactly like the vents
//                  TurretModel.js already attaches there)
//   - `mantlet` -> parent parts.gunMountPivot (the gun's own pitch pivot,
//                  so front/side gun-shield armor pitches with the barrel
//                  the way a real gun mantlet would)
// Both are ordinary children, so TurretPose.js needs zero changes.
// ---------------------------------------------------------------------------

let sharedMaterials = null;
function getArmorMaterials() {
  if (sharedMaterials) return sharedMaterials;
  sharedMaterials = {
    // Same palette family as VehicleEvolution.js's armor, so the turret
    // reads as built from the same armor stock as the vehicle body.
    plate: new THREE.MeshStandardMaterial({ color: 0x3a3f45, metalness: 0.7, roughness: 0.5 }),
    plateDark: new THREE.MeshStandardMaterial({ color: 0x1a1c20, metalness: 0.55, roughness: 0.6 }),
    blackArmor: new THREE.MeshStandardMaterial({ color: 0x101214, metalness: 0.4, roughness: 0.65 }),
    hazard: new THREE.MeshStandardMaterial({ color: 0x2b2f34, metalness: 0.3, roughness: 0.7 }),
    bolt: new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.9, roughness: 0.3 }),
    vent: new THREE.MeshStandardMaterial({ color: 0x111417, metalness: 0.2, roughness: 0.9 }),
    glow: new THREE.MeshStandardMaterial({
      color: 0xffb066, emissive: 0xff8a2c, emissiveIntensity: 0.7, metalness: 0.2, roughness: 0.4
    }),
    techCyan: new THREE.MeshStandardMaterial({
      color: 0x7fd8d0, emissive: 0x1fa89c, emissiveIntensity: 0.65, metalness: 0.3, roughness: 0.35
    }),
    warnRed: new THREE.MeshStandardMaterial({
      color: 0xd6423c, emissive: 0xb01a16, emissiveIntensity: 0.7, metalness: 0.2, roughness: 0.4
    }),
    lens: new THREE.MeshPhysicalMaterial({
      color: 0x0c1114, metalness: 0.2, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05
    })
  };
  return sharedMaterials;
}

function pulseIntensity(base, amplitude, speed = 2.0) {
  return base + Math.sin(performance.now() * 0.001 * speed) * amplitude;
}

function box(parent, size, position, material, rotation) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...position);
  if (rotation) mesh.rotation.set(...rotation);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // Same flag VehicleEvolution.js's armor uses -- VehicleDestruction.js
  // clones a private material copy for the wreck effect instead of
  // mutating this shared singleton.
  mesh.userData.sharedEvolutionMaterial = true;
  parent.add(mesh);
  return mesh;
}

function cyl(parent, radiusTop, radiusBottom, height, segments, position, material, rotation) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments), material);
  mesh.position.set(...position);
  if (rotation) mesh.rotation.set(...rotation);
  mesh.castShadow = true;
  mesh.userData.sharedEvolutionMaterial = true;
  parent.add(mesh);
  return mesh;
}

function boltRow(parent, mat, count, start, step, radius = 0.006) {
  for (let i = 0; i < count; i++) {
    cyl(
      parent, radius, radius, radius * 0.9, 6,
      [start[0] + step[0] * i, start[1] + step[1] * i, start[2] + step[2] * i],
      mat.bolt, [Math.PI / 2, 0, 0]
    );
  }
}

function sensorPod(parent, mat, position, radius = 0.018) {
  const g = new THREE.Group();
  g.position.set(...position);
  cyl(g, radius, radius, radius * 0.7, 10, [0, 0, 0], mat.plateDark, [Math.PI / 2, 0, 0]);
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.6, radius * 0.6, 0.004, 10), mat.lens);
  lens.rotation.x = Math.PI / 2;
  lens.position.z = radius * 0.4;
  g.add(lens);
  parent.add(g);
  return g;
}

function glowStrip(parent, mat, size, position, rotation, warn = false) {
  return box(parent, size, position, warn ? mat.warnRed : mat.techCyan, rotation);
}

function antenna(parent, mat, position, height, tipMat) {
  cyl(parent, 0.004, 0.006, height, 6, position, mat.plateDark);
  if (tipMat) box(parent, [0.008, 0.008, 0.008], [position[0], position[1] + height / 2 + 0.005, position[2]], tipMat);
}

// ---- Stage builders --------------------------------------------------------
// Coordinates are tuned to TurretModel.js's assembly: bodyShell is a
// cylinder of radius ~0.19-0.22, height 0.24, centered at local y=0.12;
// gunMountPivot is a ~0.16x0.16x0.2 box centered near its own origin
// (z~0.05), with the barrel emerging around local z=0.16-0.2.

function buildStage1_Reinforced(mat) {
  const body = new THREE.Group();
  // Side reinforcement plates hugging the drum.
  for (const side of [-1, 1]) {
    box(body, [0.05, 0.16, 0.09], [side * 0.21, 0.12, 0], mat.plate);
  }
  // Armored mounting collar at the base.
  cyl(body, 0.23, 0.23, 0.025, 16, [0, 0.01, 0], mat.plateDark);
  boltRow(body, mat, 8, [0.21, 0.01, 0], [0, 0, 0]);

  const mantlet = new THREE.Group();
  // First armored plate over the gun housing.
  box(mantlet, [0.2, 0.17, 0.04], [0, 0, 0.02], mat.plate);
  for (const side of [-1, 1]) {
    box(mantlet, [0.02, 0.14, 0.06], [side * 0.1, 0, 0.0], mat.hazard);
  }

  return { body, mantlet };
}

function buildStage2_Armored(mat) {
  const body = new THREE.Group();
  // Larger side armor panels, layered over stage 1's.
  for (const side of [-1, 1]) {
    box(body, [0.08, 0.2, 0.14], [side * 0.25, 0.12, 0], mat.plate);
    box(body, [0.04, 0.18, 0.13], [side * 0.29, 0.12, 0], mat.plateDark);
  }
  // Rear housing extension.
  box(body, [0.18, 0.15, 0.1], [0, 0.12, -0.23], mat.plateDark);
  boltRow(body, mat, 4, [-0.06, 0.12, -0.28], [0.04, 0, 0]);
  // Cables linking body to mount.
  for (const side of [-1, 1]) {
    cyl(body, 0.006, 0.006, 0.12, 6, [side * 0.12, 0.2, 0.08], mat.hazard, [1.1, 0, 0]);
  }

  const mantlet = new THREE.Group();
  box(mantlet, [0.28, 0.22, 0.05], [0, 0, 0.03], mat.plate);
  for (const side of [-1, 1]) {
    box(mantlet, [0.05, 0.16, 0.17], [side * 0.135, 0, 0.02], mat.plateDark);
  }
  sensorPod(mantlet, mat, [0, 0.1, 0.06], 0.02);

  return { body, mantlet };
}

function buildStage3_HeavyCombat(mat) {
  const body = new THREE.Group();
  // Large angular shield extension, merging the side plates into a wider
  // silhouette -- the turret's first major jump.
  for (const side of [-1, 1]) {
    box(body, [0.1, 0.26, 0.2], [side * 0.29, 0.12, 0], mat.blackArmor);
    boltRow(body, mat, 3, [side * 0.29, 0.05, -0.08], [0, 0.08, 0]);
  }
  // Reinforced rear housing, bigger than stage 2's, with exposed struts.
  box(body, [0.24, 0.19, 0.15], [0, 0.12, -0.28], mat.blackArmor);
  for (const side of [-1, 1]) {
    cyl(body, 0.01, 0.01, 0.14, 6, [side * 0.09, 0.12, -0.2], mat.hazard, [Math.PI / 2, 0, 0]);
  }
  // Vent/cage ring around the base collar.
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI * 2 * i) / 8;
    box(body, [0.02, 0.02, 0.03], [Math.cos(a) * 0.24, 0.01, Math.sin(a) * 0.24], mat.vent, [0, a, 0]);
  }
  sensorPod(body, mat, [0, 0.3, 0.2], 0.024);

  const mantlet = new THREE.Group();
  // Substantial angled gun-shield wedge.
  box(mantlet, [0.32, 0.24, 0.06], [0, 0, 0.04], mat.blackArmor, [-0.12, 0, 0]);
  for (const side of [-1, 1]) {
    box(mantlet, [0.06, 0.2, 0.2], [side * 0.15, 0, 0.02], mat.plate);
  }
  boltRow(mantlet, mat, 5, [-0.14, 0.12, 0.07], [0.07, 0, 0]);
  sensorPod(mantlet, mat, [0.1, 0.13, 0.08], 0.02);

  return { body, mantlet };
}

function buildStage4_Elite(mat) {
  const body = new THREE.Group();
  // Layered angular plates stacked over the body armor.
  for (let i = 0; i < 3; i++) {
    box(body, [0.5 - i * 0.09, 0.045, 0.045], [0, 0.06 + i * 0.09, -0.29 - i * 0.01], mat.blackArmor);
  }
  glowStrip(body, mat, [0.4, 0.008, 0.008], [0, 0.24, -0.3]);
  // Extra sensor/optic pair + structural braces.
  for (const side of [-1, 1]) {
    sensorPod(body, mat, [side * 0.3, 0.3, 0.05], 0.022);
    box(body, [0.02, 0.1, 0.02], [side * 0.29, 0.18, -0.1], mat.hazard);
  }

  const mantlet = new THREE.Group();
  // Reinforced layered weapon housing.
  for (let i = 0; i < 2; i++) {
    box(mantlet, [0.36 - i * 0.08, 0.26 - i * 0.06, 0.05], [0, 0, 0.05 + i * 0.04], mat.blackArmor);
  }
  glowStrip(mantlet, mat, [0.3, 0.01, 0.008], [0, 0.14, 0.09]);
  for (const side of [-1, 1]) {
    box(mantlet, [0.03, 0.22, 0.22], [side * 0.17, 0, 0.02], mat.plateDark);
  }

  return { body, mantlet };
}

function buildStage5_Ultimate(mat) {
  const body = new THREE.Group();
  // Thick layered drum wrap.
  cyl(body, 0.27, 0.27, 0.2, 18, [0, 0.12, 0], mat.plateDark, [Math.PI / 2, 0, 0]);
  cyl(body, 0.28, 0.28, 0.014, 18, [0, 0.12, 0], mat.techCyan, [Math.PI / 2, 0, 0]);
  // Armored side modules, larger than stage 3's.
  for (const side of [-1, 1]) {
    box(body, [0.12, 0.3, 0.24], [side * 0.32, 0.12, 0], mat.blackArmor);
    boltRow(body, mat, 4, [side * 0.32, 0.02, -0.09], [0, 0.09, 0]);
  }
  // Largest rear housing.
  box(body, [0.28, 0.22, 0.17], [0, 0.12, -0.32], mat.blackArmor);
  glowStrip(body, mat, [0.22, 0.01, 0.008], [0, 0.22, -0.41]);
  // Advanced optics/camera cluster + antenna.
  sensorPod(body, mat, [0, 0.34, 0.22], 0.028);
  for (const side of [-1, 1]) {
    sensorPod(body, mat, [side * 0.32, 0.3, 0.06], 0.022);
    antenna(body, mat, [side * 0.22, 0.34, -0.2], 0.16, mat.warnRed);
  }
  // Small tactical light.
  cyl(body, 0.012, 0.012, 0.01, 8, [0, 0.34, 0.05], mat.glow, [Math.PI / 2, 0, 0]);

  const mantlet = new THREE.Group();
  // Large aggressive V-wedge gun shield -- the biggest, echoing the
  // vehicle's own stage-5 front ram.
  for (const side of [-1, 1]) {
    box(mantlet, [0.22, 0.26, 0.06], [side * 0.11, 0, 0.05], mat.blackArmor, [0, side * 0.28, 0]);
  }
  box(mantlet, [0.1, 0.28, 0.05], [0, 0, 0.1], mat.plateDark);
  glowStrip(mantlet, mat, [0.3, 0.01, 0.008], [0, 0.16, 0.11]);
  // Armored side modules flanking the barrel + actuator brackets.
  for (const side of [-1, 1]) {
    box(mantlet, [0.04, 0.24, 0.24], [side * 0.19, 0, 0.02], mat.plate);
    cyl(mantlet, 0.012, 0.012, 0.1, 8, [side * 0.14, -0.1, 0.05], mat.hazard, [1.0, 0, 0.35 * side]);
  }
  // Targeting element.
  sensorPod(mantlet, mat, [0, 0.15, 0.12], 0.024);
  box(mantlet, [0.012, 0.012, 0.012], [0, 0.15, 0.14], mat.warnRed);

  return { body, mantlet };
}

const STAGE_BUILDERS = [
  null, // stage 0 = base turret, no added armor
  buildStage1_Reinforced,
  buildStage2_Armored,
  buildStage3_HeavyCombat,
  buildStage4_Elite,
  buildStage5_Ultimate
];

// ---------------------------------------------------------------------------
// Rig: owns which armor stage groups have been built/attached so far for
// one turret instance, plus the current reveal animation (if any). Mirrors
// VehicleEvolutionRig's shape closely on purpose.
// ---------------------------------------------------------------------------
export class TurretArmorRig {
  constructor(parts) {
    this.parts = parts;
    this.mat = getArmorMaterials();
    this.stageGroups = new Array(STAGE_BUILDERS.length).fill(null);
    this.currentStage = 0;

    this.animGroups = null; // { body, mantlet } for the most-recently-added stage
    this.animElapsed = 0;
    this.animDuration = 1;
  }

  setStage(stage, { animate = true } = {}) {
    const target = Math.max(0, Math.min(STAGE_BUILDERS.length - 1, stage));

    for (let s = 1; s <= target; s++) {
      if (!this.stageGroups[s]) {
        const built = STAGE_BUILDERS[s](this.mat);
        this.parts.bodyShell.add(built.body);
        this.parts.gunMountPivot.add(built.mantlet);
        this.stageGroups[s] = built;

        const isNewlyReached = s === target && s > this.currentStage;
        if (animate && isNewlyReached) this.beginReveal(built);
      }
    }

    this.currentStage = target;
  }

  beginReveal(built) {
    built.body.scale.setScalar(0.05);
    built.mantlet.scale.setScalar(0.05);
    this.animGroups = built;
    this.animElapsed = 0;
    this.animDuration = 1.1 + Math.min(0.6, this.currentStage * 0.12);
  }

  update(dt) {
    if (this.currentStage >= 4) {
      this.mat.techCyan.emissiveIntensity = pulseIntensity(0.6, 0.22, 2.0);
    }
    if (this.currentStage >= 5) {
      this.mat.warnRed.emissiveIntensity = pulseIntensity(0.6, 0.2, 1.2);
    }

    if (!this.animGroups) return;

    this.animElapsed += dt;
    const t = clamp01(this.animElapsed / this.animDuration);
    const eased = Math.max(0.05, easeOutBack(t));
    this.animGroups.body.scale.setScalar(eased);
    this.animGroups.mantlet.scale.setScalar(eased);

    if (t >= 1) {
      this.animGroups.body.scale.setScalar(1);
      this.animGroups.mantlet.scale.setScalar(1);
      this.animGroups = null;
    }
  }

  dispose() {
    for (const built of this.stageGroups) {
      if (!built) continue;
      for (const group of [built.body, built.mantlet]) {
        group.traverse(obj => {
          if (obj.geometry) obj.geometry.dispose();
        });
        group.parent?.remove(group);
      }
    }
  }
}