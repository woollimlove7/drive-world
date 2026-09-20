import * as THREE from "three";
import { easeOutBack, easeOutCubic, clamp01 } from "../turret/TurretMath.js";
import { MAX_EVOLUTION_STAGE } from "../gameplay/EvolutionConfig.js";

// ---------------------------------------------------------------------------
// Vehicle armor evolution.
//
// Each milestone stage is its own small THREE.Group of plates / brackets /
// vents built from primitives (boxes, cylinders, shared materials created
// once). Stages are ADDITIVE and never rebuilt: reaching stage 3 means
// stages 1, 2 and 3's groups are all attached and visible at once.
//
// DESIGN PHILOSOPHY (redesign pass): the base civilian vehicle is
// progressively converted into a believable armored battle vehicle --
// post-apoc battle truck x modern MRAP x futuristic tactical vehicle. Armor
// is the dominant visual language at every stage; it is built as thick,
// overlapping, bolted/braced plates that wrap the body (front, sides,
// wheels, roof, rear, underbody), not as small decorative strips. Emissive
// "tech" accents (cyan/red) are a minor accent introduced only at stage 4+
// and kept small/sparse -- sensors, seams, status tips -- never the
// dominant read.
//
// Visual arc across the six stages (0 = base vehicle from VehicleVisual.js):
//   0 Base          -- rugged, functional, minimal tech (see VehicleVisual.js)
//   1 Reinforced     -- first real armor conversion: bumper, grille guard,
//                       door plates, wheel-arch guards, skid strip
//   2 Armored        -- large door armor, deeper skirts, bigger fenders,
//                       protected lights, roof armor platform
//   3 Heavy Combat   -- major jump: angled plow, full-length layered side
//                       armor, armored wheel discs, roof equipment rig,
//                       underbody skid plate
//   4 Elite War Machine -- layered angular front, extended skirts, roof
//                       sensor/antenna array, rear equipment boxes, first
//                       (sparse) emissive tech accents
//   5 Ultimate       -- full wrap-around wide-body armor, heavy V-wedge ram,
//                       substantial roof turret-mount platform, armored
//                       rear doors + storage, underbody diffuser guard,
//                       thin emissive seams (not neon)
//
// Used identically by the local Vehicle and every RemoteVehicle -- pass in
// whatever THREE.Group the vehicle body is parented to (`root`) and this
// attaches armor directly to it in the same local space the body panels
// already use. Optionally also pass the vehicle's wheel meshes (`wheels`)
// so stage 3+ can add a wheel-mounted armor accent that moves with the
// wheel's own per-frame physics transform.
// ---------------------------------------------------------------------------

let sharedMaterials = null;
function getArmorMaterials() {
  if (sharedMaterials) return sharedMaterials;
  sharedMaterials = {
    // Primary armor plate -- worn dark gunmetal, the dominant surface at
    // every stage.
    plate: new THREE.MeshStandardMaterial({
      color: 0x3a3f45, metalness: 0.7, roughness: 0.5
    }),
    // Secondary/underlying plate -- near-black, used for layered panels
    // sitting behind/beneath the primary plate so armor reads as stacked,
    // not flat.
    plateDark: new THREE.MeshStandardMaterial({
      color: 0x1a1c20, metalness: 0.55, roughness: 0.6
    }),
    // Black armor -- the heaviest/outermost plating on high stages (plow,
    // mantlet-style front faces, door slabs).
    blackArmor: new THREE.MeshStandardMaterial({
      color: 0x101214, metalness: 0.4, roughness: 0.65
    }),
    // Exposed structural/mechanical steel -- braces, struts, brackets.
    hazard: new THREE.MeshStandardMaterial({
      color: 0x2b2f34, metalness: 0.3, roughness: 0.7
    }),
    bolt: new THREE.MeshStandardMaterial({
      color: 0x9aa0a6, metalness: 0.9, roughness: 0.3
    }),
    vent: new THREE.MeshStandardMaterial({
      color: 0x111417, metalness: 0.2, roughness: 0.9
    }),
    // Matte rubber -- mud/wheel-arch guards, skirts' lower rubber lip.
    rubber: new THREE.MeshStandardMaterial({
      color: 0x151516, metalness: 0.05, roughness: 0.95
    }),
    // Small warm tactical light -- used sparingly from stage 3 on (not a
    // neon accent, just a functional-looking indicator/work light).
    glow: new THREE.MeshStandardMaterial({
      color: 0xffb066, emissive: 0xff8a2c, emissiveIntensity: 0.7,
      metalness: 0.2, roughness: 0.4
    }),
    // Cool cyan tech accent -- introduced at stage 4, kept thin/sparse
    // (seams, sensor rims, status ticks) so armor stays dominant.
    techCyan: new THREE.MeshStandardMaterial({
      color: 0x7fd8d0, emissive: 0x1fa89c, emissiveIntensity: 0.65,
      metalness: 0.3, roughness: 0.35
    }),
    // Small red warning accents on the highest stages (sensor status,
    // antenna tips) -- used very sparingly against the cyan.
    warnRed: new THREE.MeshStandardMaterial({
      color: 0xd6423c, emissive: 0xb01a16, emissiveIntensity: 0.7,
      metalness: 0.2, roughness: 0.4
    }),
    // Dark glossy lens for sensor/camera pods introduced from stage 3 on.
    lens: new THREE.MeshPhysicalMaterial({
      color: 0x0c1114, metalness: 0.2, roughness: 0.12,
      clearcoat: 1, clearcoatRoughness: 0.05
    })
  };
  return sharedMaterials;
}

// Wall-clock based pulse, deliberately stateless (no per-instance
// accumulator): every vehicle's tech-cyan/warn-red accents breathe in sync
// with each other. Kept subtle (small amplitude) since these are accents,
// not the primary visual language.
function pulseIntensity(base, amplitude, speed = 2.0) {
  return base + Math.sin(performance.now() * 0.001 * speed) * amplitude;
}

function box(parent, size, position, material, rotation) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...position);
  if (rotation) mesh.rotation.set(...rotation);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // Flags this mesh as using a module-level material shared across every
  // vehicle instance (see getArmorMaterials() above) -- VehicleDestruction.js
  // checks this before darkening anything, so it clones a private copy for
  // the wreck effect instead of mutating the singleton every vehicle points
  // at (see VehicleDestruction._darkenMaterials()).
  mesh.userData.sharedEvolutionMaterial = true;
  parent.add(mesh);
  return mesh;
}

function cyl(parent, radiusTop, radiusBottom, height, segments, position, material, rotation) {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments),
    material
  );
  mesh.position.set(...position);
  if (rotation) mesh.rotation.set(...rotation);
  mesh.castShadow = true;
  mesh.userData.sharedEvolutionMaterial = true;
  parent.add(mesh);
  return mesh;
}

// A row of small bolt heads along one edge of a plate -- the "physically
// fastened" read the brief asks for, used throughout instead of leaving
// plate edges bare.
function boltRow(parent, mat, count, start, step, radius = 0.014) {
  for (let i = 0; i < count; i++) {
    cyl(
      parent, radius, radius, radius * 0.9, 6,
      [start[0] + step[0] * i, start[1] + step[1] * i, start[2] + step[2] * i],
      mat.bolt, [Math.PI / 2, 0, 0]
    );
  }
}

// One angled plate bolted onto the body at `side` (-1/1/0 for centered).
function angledPlate(parent, mat, { size, position, tilt = 0.18, side = 0, material }) {
  const g = new THREE.Group();
  g.position.set(...position);
  g.rotation.z = tilt * side;
  box(g, size, [0, 0, 0], material || mat.plate);
  for (const bx of [-size[0] / 2 + 0.03, size[0] / 2 - 0.03]) {
    cyl(g, 0.014, 0.014, size[2] * 0.9, 6, [bx, size[1] / 2 + 0.006, 0], mat.bolt, [Math.PI / 2, 0, 0]);
  }
  parent.add(g);
  return g;
}

// A small camera/sensor pod: dark lens + gunmetal-ish housing, used from
// stage 3 onward to build up the "this vehicle is watching" tactical read.
function sensorPod(parent, mat, position, radius = 0.045) {
  const g = new THREE.Group();
  g.position.set(...position);
  cyl(g, radius, radius, radius * 0.7, 10, [0, 0, 0], mat.plateDark, [Math.PI / 2, 0, 0]);
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.6, radius * 0.6, 0.01, 10), mat.lens);
  lens.rotation.x = Math.PI / 2;
  lens.position.z = radius * 0.4;
  g.add(lens);
  parent.add(g);
  return g;
}

// A thin emissive seam -- the accent building block for stages 4-5. Kept
// thin and used sparingly (armor stays dominant, this is a highlight).
function glowStrip(parent, mat, size, position, rotation, warn = false) {
  return box(parent, size, position, warn ? mat.warnRed : mat.techCyan, rotation);
}

// A rugged external equipment/storage box (spare-parts crate, ammo box,
// roof/rear stowage) -- flat panel + frame + a couple of latch bolts, used
// from stage 3 on for roof/rear militarization.
function storageBox(parent, mat, size, position, rotation) {
  const g = new THREE.Group();
  g.position.set(...position);
  if (rotation) g.rotation.set(...rotation);
  box(g, size, [0, 0, 0], mat.plateDark);
  box(g, [size[0] * 0.94, 0.015, size[2] * 0.94], [0, size[1] / 2 + 0.004, 0], mat.plate);
  for (const sx of [-size[0] / 2 + 0.04, size[0] / 2 - 0.04]) {
    cyl(g, 0.012, 0.012, size[1] * 0.6, 6, [sx, 0, size[2] / 2 + 0.006], mat.bolt, [Math.PI / 2, 0, 0]);
  }
  parent.add(g);
  return g;
}

// A rigid whip antenna / sensor rod with an optional colored tip.
function antenna(parent, mat, position, height, tipMat) {
  cyl(parent, 0.012, 0.018, height, 6, position, mat.plateDark);
  if (tipMat) box(parent, [0.022, 0.022, 0.022], [position[0], position[1] + height / 2 + 0.012, position[2]], tipMat);
}

// A flat skid/underbody plate -- low, wide, nearly invisible from a normal
// camera angle but reads correctly from low/side shots and grounds the
// "protected underside" requirement without adding heavy geometry.
function skidPlate(parent, mat, zCenter, width, length) {
  box(parent, [width, 0.05, length], [0, -0.24, zCenter], mat.plateDark);
}

// ---- Stage builders --------------------------------------------------------
// Each returns a fresh THREE.Group of *only that stage's new pieces*.
// Positions are tuned to VehicleVisual.js's shared body footprint (~1.78
// wide, ~3.98 long, wheel arches around z=+-1.15, fender flares out to
// about x=+-1.08).

function buildStage1_Reinforced(mat) {
  const g = new THREE.Group();

  // FRONT -- heavy bumper bar + reinforced grille guard, the first "this
  // vehicle is built to hit something" statement.
  box(g, [1.9, 0.16, 0.16], [0, -0.02, 2.16], mat.plate);
  box(g, [1.0, 0.34, 0.06], [0, 0.2, 2.16], mat.plateDark);
  boltRow(g, mat, 5, [-0.76, -0.02, 2.24], [0.38, 0, 0]);
  // Headlight guard brackets.
  for (const side of [-1, 1]) {
    box(g, [0.05, 0.22, 0.22], [side * 0.62, 0.1, 2.2], mat.hazard);
  }

  // SIDE -- first real door plates (not just a skirt strip).
  for (const side of [-1, 1]) {
    box(g, [0.06, 0.42, 1.7], [side * 1.0, 0.32, -0.1], mat.plate);
    boltRow(g, mat, 4, [side * 1.03, 0.32, -0.75], [0, 0, 0.5]);
    // Lower rocker skirt.
    box(g, [0.07, 0.16, 3.2], [side * 0.99, -0.1, 0], mat.plate);
  }

  // WHEEL / FENDER -- subtle guards just outside VehicleVisual.js's fender
  // flares.
  for (const side of [-1, 1]) {
    for (const zf of [1.15, -1.15]) {
      box(g, [0.06, 0.1, 0.42], [side * 1.1, 0.14, zf], mat.plateDark);
    }
  }

  // ROOF -- a modest mounting frame, the first hint of a future weapon
  // platform.
  box(g, [0.9, 0.05, 1.0], [0, 1.38, -0.35], mat.plateDark);
  boltRow(g, mat, 4, [-0.4, 1.41, 0.1], [0.27, 0, 0]);

  // REAR -- reinforcement bar.
  box(g, [1.7, 0.16, 0.12], [0, -0.02, -2.2], mat.plate);
  box(g, [1.5, 0.1, 0.06], [0, 0.16, -2.22], mat.plateDark);

  // UNDERBODY -- first skid strip.
  skidPlate(g, mat, 0, 1.5, 2.6);

  return g;
}

function buildStage2_Armored(mat) {
  const g = new THREE.Group();

  // FRONT -- larger ram/bull-bar with angled lower lip + tow hooks.
  box(g, [1.75, 0.22, 0.18], [0, 0.16, 2.32], mat.plate);
  box(g, [1.6, 0.14, 0.2], [0, 0.0, 2.4], mat.plateDark, [-0.25, 0, 0]);
  for (const side of [-1, 1]) {
    box(g, [0.14, 0.3, 0.18], [side * 0.72, 0.04, 2.32], mat.plateDark);
    cyl(g, 0.03, 0.03, 0.12, 8, [side * 0.55, -0.1, 2.5], mat.hazard, [Math.PI / 2, 0, 0]);
  }
  boltRow(g, mat, 6, [-0.8, 0.16, 2.41], [0.32, 0, 0]);

  // SIDE -- full armored door panels, layered over the stage-1 plate.
  for (const side of [-1, 1]) {
    box(g, [0.1, 0.62, 2.0], [side * 1.04, 0.42, -0.1], mat.plate);
    box(g, [0.05, 0.58, 1.9], [side * 1.09, 0.42, -0.1], mat.plateDark);
    boltRow(g, mat, 5, [side * 1.1, 0.42, -0.95], [0, 0, 0.42]);
    // Deeper lower side skirt.
    box(g, [0.1, 0.2, 3.3], [side * 1.02, -0.14, 0], mat.plate);
    box(g, [0.11, 0.06, 3.3], [side * 1.02, -0.25, 0], mat.rubber);
  }

  // WHEEL / FENDER -- larger armored fender flares with a rubber lip.
  for (const side of [-1, 1]) {
    for (const zf of [1.15, -1.15]) {
      cyl(g, 0.5, 0.5, 0.09, 16, [side * 1.12, 0.1, zf], mat.plateDark, [Math.PI / 2, 0, 0]);
      cyl(g, 0.52, 0.52, 0.03, 16, [side * 1.16, 0.1, zf], mat.rubber, [Math.PI / 2, 0, 0]);
    }
  }

  // Protected lights -- small cage over the headlight guard brackets.
  for (const side of [-1, 1]) {
    for (let i = -1; i <= 1; i++) {
      box(g, [0.03, 0.24, 0.03], [side * 0.62 + i * 0.06, 0.1, 2.28], mat.hazard);
    }
  }

  // ROOF -- armor platform base, wider than stage 1, with side brackets.
  box(g, [1.1, 0.06, 1.3], [0, 1.42, -0.3], mat.plateDark);
  for (const side of [-1, 1]) {
    box(g, [0.05, 0.12, 0.16], [side * 0.55, 1.4, 0.3], mat.bolt);
  }

  // REAR -- armored door/panel + bumper.
  box(g, [1.86, 0.28, 0.14], [0, 0.06, -2.26], mat.plate);
  box(g, [1.7, 0.16, 0.08], [0, 0.24, -2.24], mat.plateDark);
  boltRow(g, mat, 6, [-0.75, 0.06, -2.33], [0.3, 0, 0]);

  // UNDERBODY -- wider skid plate.
  skidPlate(g, mat, -0.2, 1.65, 3.0);

  // First sensor pods -- roofline, restrained.
  for (const side of [-1, 1]) {
    sensorPod(g, mat, [side * 0.5, 1.42, 0.5], 0.035);
  }

  return g;
}

function buildStage3_HeavyCombat(mat) {
  const g = new THREE.Group();

  // FRONT -- heavy angled plow (the clearest "hit something and survive"
  // silhouette change), braced back to the bumper with exposed struts.
  const plow = new THREE.Group();
  plow.position.set(0, 0.02, 2.46);
  box(plow, [1.65, 0.44, 0.12], [0, 0, 0], mat.blackArmor, [-0.36, 0, 0]);
  box(plow, [1.65, 0.08, 0.12], [0, 0.24, -0.08], mat.plateDark, [-0.36, 0, 0]);
  boltRow(plow, mat, 7, [-0.72, -0.18, 0.06], [0.24, 0.08, 0]);
  g.add(plow);
  for (const side of [-1, 1]) {
    cyl(g, 0.028, 0.028, 0.5, 6, [side * 0.68, 0.12, 2.28], mat.hazard, [0.95, 0, 0]);
    cyl(g, 0.028, 0.028, 0.42, 6, [side * 0.4, 0.02, 2.3], mat.hazard, [1.0, 0, 0.4 * side]);
  }
  // Recovery/tow hardware -- a low bracket + shackle-like ring, grounding
  // the "built to survive combat" read.
  cyl(g, 0.06, 0.06, 0.05, 10, [0, -0.16, 2.62], mat.bolt, [Math.PI / 2, 0, 0]);

  // SIDE -- full-length layered side plating replacing the door-only
  // panels with continuous armor from front fender to rear fender.
  for (const side of [-1, 1]) {
    box(g, [0.1, 0.66, 2.85], [side * 1.09, 0.4, -0.1], mat.plate);
    box(g, [0.05, 0.6, 2.75], [side * 1.14, 0.4, -0.1], mat.blackArmor);
    for (let i = -2; i <= 2; i++) {
      boltRow(g, mat, 1, [side * 1.17, 0.4 + i * 0.2, -0.1], [0, 0, 0]);
    }
    // Lower skirt, deeper again, rubber lip.
    box(g, [0.12, 0.22, 3.3], [side * 1.06, -0.16, 0], mat.plate);
    box(g, [0.13, 0.07, 3.3], [side * 1.06, -0.28, 0], mat.rubber);
    // Roofline sensor pod at the leading edge of the side plate.
    sensorPod(g, mat, [side * 1.04, 0.78, 1.1], 0.05);
  }
  // Mechanical support struts under the sides.
  for (const side of [-1, 1]) {
    for (const zf of [0.9, -0.9]) {
      box(g, [0.05, 0.2, 0.05], [side * 1.1, 0.04, zf], mat.hazard);
    }
  }

  // WHEEL / FENDER -- armored wheel-arch discs, larger than stage 2's,
  // wheel still clearly readable inside them.
  for (const side of [-1, 1]) {
    for (const zf of [1.15, -1.15]) {
      cyl(g, 0.58, 0.58, 0.1, 18, [side * 1.16, 0.1, zf], mat.plateDark, [Math.PI / 2, 0, 0]);
      cyl(g, 0.6, 0.6, 0.035, 18, [side * 1.2, 0.1, zf], mat.rubber, [Math.PI / 2, 0, 0]);
    }
  }

  // ROOF -- a real equipment rig: raised armored collar (future turret
  // mount) with vents, plus a strapped storage box.
  cyl(g, 0.62, 0.62, 0.07, 16, [0, 1.42, -0.5], mat.plateDark, [Math.PI / 2, 0, 0]);
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI * 2 * i) / 6;
    box(g, [0.05, 0.03, 0.09], [Math.cos(a) * 0.58, 1.42, -0.5 + Math.sin(a) * 0.58], mat.vent, [0, a, 0]);
  }
  storageBox(g, mat, [0.5, 0.22, 0.7], [0.6, 1.44, 0.55]);

  // REAR -- heavier rear armor + exhaust guard + a rear storage box.
  box(g, [1.92, 0.3, 0.14], [0, 0.1, -2.32], mat.blackArmor);
  boltRow(g, mat, 7, [-0.8, 0.1, -2.4], [0.27, 0, 0]);
  storageBox(g, mat, [1.3, 0.32, 0.4], [0, 0.02, -2.55]);
  cyl(g, 0.06, 0.06, 0.1, 8, [0.55, -0.14, -2.4], mat.hazard, [Math.PI / 2, 0, 0]);

  // UNDERBODY -- reinforced skid running most of the wheelbase.
  skidPlate(g, mat, -0.3, 1.75, 3.4);

  return g;
}

function buildStage4_Elite(mat) {
  const g = new THREE.Group();

  // FRONT -- layered angular armor: a stacked wedge of plates over the
  // stage-3 plow, edged with a thin cyan seam (the first tech accent).
  for (let i = 0; i < 3; i++) {
    box(g, [1.5 - i * 0.16, 0.1, 0.1], [0, 0.5 + i * 0.13, 2.5 - i * 0.06], mat.blackArmor);
  }
  glowStrip(g, mat, [1.2, 0.012, 0.012], [0, 0.62, 2.46]);
  // Reinforced nose cap tying the wedge into the plow below.
  box(g, [0.6, 0.3, 0.14], [0, 0.3, 2.58], mat.plateDark);

  // SIDE -- an outer angular layer over the stage-3 plating, extending the
  // skirts deeper.
  for (const side of [-1, 1]) {
    angledPlate(g, mat, {
      size: [0.06, 0.5, 2.6], position: [side * 1.21, 0.5, -0.1],
      side, tilt: 0.04, material: mat.blackArmor
    });
    box(g, [0.13, 0.24, 3.4], [side * 1.1, -0.26, 0], mat.plate);
  }

  // WHEEL / FENDER -- extended flare skirting connecting the wheel arch to
  // the side armor, closing the gap the plain discs left.
  for (const side of [-1, 1]) {
    for (const zf of [1.15, -1.15]) {
      box(g, [0.1, 0.16, 0.55], [side * 1.24, 0.12, zf], mat.plateDark);
    }
  }

  // ROOF -- sensor/antenna array replacing the single roofline hint, plus a
  // wider armored platform.
  box(g, [1.3, 0.05, 1.7], [0, 1.46, -0.32], mat.plateDark);
  boltRow(g, mat, 5, [-0.55, 1.49, 0.4], [0.28, 0, 0]);
  for (const side of [-1, 1]) {
    antenna(g, mat, [side * 0.45, 1.6, -0.85], 0.24, mat.warnRed);
  }
  storageBox(g, mat, [0.55, 0.22, 0.7], [-0.6, 1.48, 0.5]);

  // REAR -- larger armor slab + a thin cyan seam, more wheel-arch coverage.
  box(g, [1.9, 0.32, 0.12], [0, 0.2, -2.36], mat.blackArmor);
  glowStrip(g, mat, [1.6, 0.02, 0.012], [0, 0.34, -2.4]);
  for (const side of [-1, 1]) {
    for (const zf of [1.15, -1.15]) {
      cyl(g, 0.6, 0.6, 0.08, 18, [side * 1.22, 0.1, zf], mat.plate, [Math.PI / 2, 0, 0]);
    }
  }

  // Side sensor cluster -- two pods per side, an obvious step up from
  // stage 3's single pod.
  for (const side of [-1, 1]) {
    sensorPod(g, mat, [side * 1.16, 0.85, 0.6], 0.045);
    sensorPod(g, mat, [side * 1.16, 0.85, -0.6], 0.045);
  }

  // UNDERBODY.
  skidPlate(g, mat, -0.4, 1.85, 3.6);

  return g;
}

function buildStage5_Ultimate(mat) {
  const g = new THREE.Group();

  // FRONT -- aggressive V-wedge ram, the vehicle's heaviest front-facing
  // mass, still braced to the plow/bumper stack beneath it.
  for (const side of [-1, 1]) {
    box(g, [0.9, 0.46, 0.16], [side * 0.42, 0.18, 2.58], mat.blackArmor, [0, side * 0.32, 0]);
  }
  box(g, [0.42, 0.48, 0.14], [0, 0.18, 2.7], mat.plateDark);
  glowStrip(g, mat, [1.1, 0.02, 0.015], [0, 0.4, 2.66]);
  boltRow(g, mat, 5, [-0.7, -0.02, 2.6], [0.35, 0.1, 0]);

  // SIDE -- heavy multi-layer wrap-around armor connecting front to rear,
  // with a thin cyan energy seam between the two outer layers -- the
  // clearest single "this is the max stage" signature, but still thin
  // relative to the armor mass around it.
  for (const side of [-1, 1]) {
    box(g, [0.16, 0.74, 3.3], [side * 1.2, 0.46, -0.1], mat.plate);
    box(g, [0.07, 0.7, 3.2], [side * 1.26, 0.46, -0.1], mat.blackArmor);
    glowStrip(g, mat, [0.02, 0.05, 3.0], [side * 1.3, 0.46, -0.1]);
    // Wide side-skirt closing the gap to the ground.
    box(g, [0.18, 0.3, 3.6], [side * 1.14, -0.28, 0], mat.plate);
    box(g, [0.19, 0.08, 3.6], [side * 1.14, -0.42, 0], mat.rubber);
  }

  // WHEEL / FENDER -- the largest armored discs, wheel still readable
  // inside them, with a thin cyan rim light.
  for (const side of [-1, 1]) {
    for (const zf of [1.15, -1.15]) {
      cyl(g, 0.66, 0.66, 0.11, 20, [side * 1.28, 0.1, zf], mat.plateDark, [Math.PI / 2, 0, 0]);
      cyl(g, 0.68, 0.68, 0.014, 20, [side * 1.33, 0.1, zf], mat.techCyan, [Math.PI / 2, 0, 0]);
    }
    box(g, [0.08, 0.24, 0.08], [side * 1.16, -0.05, 0], mat.hazard);
  }

  // ROOF -- substantial turret-mount platform with a full sensor/antenna
  // array and dome sensor at the leading edge.
  box(g, [1.5, 0.07, 2.0], [0, 1.52, -0.32], mat.plateDark);
  boltRow(g, mat, 7, [-0.65, 1.56, 0.55], [0.22, 0, 0]);
  for (const side of [-1, 1]) {
    antenna(g, mat, [side * 0.55, 1.7, -0.9], 0.32, mat.warnRed);
  }
  sensorPod(g, mat, [0, 1.57, 0.6], 0.07);
  glowStrip(g, mat, [0.5, 0.015, 0.015], [0, 1.555, 0.68]);
  storageBox(g, mat, [0.6, 0.24, 0.8], [0.72, 1.55, -0.75]);
  storageBox(g, mat, [0.6, 0.24, 0.8], [-0.72, 1.55, -0.75]);

  // REAR -- armored double-door read, heavier bumper, exhaust guard cage,
  // wider storage boxes.
  box(g, [1.98, 0.4, 0.16], [0, 0.22, -2.44], mat.blackArmor);
  glowStrip(g, mat, [1.6, 0.02, 0.015], [0, 0.4, -2.53]);
  boltRow(g, mat, 8, [-0.85, 0.22, -2.52], [0.24, 0, 0]);
  for (const side of [-0.5, 0.5]) {
    box(g, [0.02, 0.36, 0.02], [side, 0.22, -2.4], mat.hazard);
  }
  storageBox(g, mat, [1.5, 0.34, 0.4], [0, 0.0, -2.68]);
  for (let i = -1; i <= 1; i += 2) {
    box(g, [0.02, 0.14, 0.02], [i * 0.5, -0.2, -2.32], mat.hazard);
  }

  // UNDERBODY -- reinforced full-length skid plate + rear diffuser-style
  // guard fins.
  skidPlate(g, mat, -0.5, 1.98, 3.8);
  for (let i = -3; i <= 3; i++) {
    box(g, [0.03, 0.09, 0.2], [i * 0.24, -0.28, -2.15], mat.plateDark);
  }

  return g;
}

const STAGE_BUILDERS = [
  null, // stage 0 = default vehicle, nothing added
  buildStage1_Reinforced,
  buildStage2_Armored,
  buildStage3_HeavyCombat,
  buildStage4_Elite,
  buildStage5_Ultimate
];

// Adds a small wheel-mounted armor accent as a child of an existing wheel
// group. It inherits the wheel's own per-frame physics transform (position
// + full spin quaternion) automatically since it's just another child mesh
// -- no extra per-frame code needed anywhere. `tier` 0 = stage 3-ish accent
// (dark reinforcement ring), `tier` 1 = stage 5 accent (ring + hub cap with
// a thin cyan rim).
function addWheelAccent(wheelGroup, mat, tier) {
  if (!wheelGroup || wheelGroup.userData.evolutionAccentTier >= tier) return;
  wheelGroup.userData.evolutionAccentTier = tier;

  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.245, tier === 1 ? 0.016 : 0.01, 8, 24),
    tier === 1 ? mat.techCyan : mat.plateDark
  );
  ring.rotation.y = Math.PI / 2;
  ring.userData.sharedEvolutionMaterial = true;
  wheelGroup.add(ring);

  if (tier === 1) {
    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 0.02, 16),
      mat.plateDark
    );
    cap.rotation.z = Math.PI / 2;
    cap.userData.sharedEvolutionMaterial = true;
    wheelGroup.add(cap);
  }
}

// ---------------------------------------------------------------------------
// Rig: owns the per-vehicle instance state (which stage groups have been
// built/attached so far, and the current reveal animation, if any).
// ---------------------------------------------------------------------------
export class VehicleEvolutionRig {
  // `wheels`: optional array of the vehicle's 4 wheel THREE.Groups (from
  // Vehicle.js/RemoteVehicle.js). Purely additive -- existing callers that
  // only pass `root` keep working exactly as before, just without the
  // stage 3/5 wheel accent rings.
  constructor(root, wheels = []) {
    this.root = root;
    this.wheels = wheels;
    this.mat = getArmorMaterials();
    this.stageGroups = new Array(STAGE_BUILDERS.length).fill(null);
    this.currentStage = 0;

    // Reveal animation for the most-recently-added stage group only --
    // everything below it is already fully settled and untouched.
    this.animGroup = null;
    this.animElapsed = 0;
    this.animDuration = 1;
    this.animTargetPos = new THREE.Vector3();
    this.animStartPos = new THREE.Vector3();
  }

  // Ensures stage groups 1..stage exist and are visible; animates the newly
  // revealed one(s) in. Safe to call repeatedly with the same stage (no-op)
  // -- see requirement "evolution does not happen again every frame".
  setStage(stage, { animate = true } = {}) {
    const target = Math.max(0, Math.min(STAGE_BUILDERS.length - 1, stage));

    for (let s = 1; s <= target; s++) {
      if (!this.stageGroups[s]) {
        const stageGroup = STAGE_BUILDERS[s](this.mat);
        this.root.add(stageGroup);
        this.stageGroups[s] = stageGroup;

        const isNewlyReached = s === target && s > this.currentStage;
        if (animate && isNewlyReached) {
          this.beginReveal(stageGroup);
        }
      }
    }

    // Wheel armor accents track the same cumulative-stage rule as the body
    // armor: once earned, they stay. Tier 0 at stage 3 (heavy combat wheel
    // guards imply reinforced hubs), tier 1 (brighter rim + hub cap) at
    // stage 5.
    if (this.wheels && this.wheels.length) {
      const tier = target >= 5 ? 1 : target >= 3 ? 0 : -1;
      if (tier >= 0) {
        for (const wheel of this.wheels) addWheelAccent(wheel, this.mat, tier);
      }
    }

    this.currentStage = target;
  }

  beginReveal(stageGroup) {
    // Small mechanical "installed" pop: scale up from near-zero with an
    // overshoot ease, while also rising slightly from below into position
    // -- reads as armor being bolted/deployed rather than popping into
    // existence -- over roughly 1.5-2.5s depending on the stage.
    stageGroup.scale.setScalar(0.05);
    this.animStartPos.set(0, -0.4, 0);
    this.animTargetPos.set(0, 0, 0);
    stageGroup.position.copy(this.animStartPos);

    this.animGroup = stageGroup;
    this.animElapsed = 0;
    this.animDuration = 1.6 + Math.min(1, this.currentStage * 0.15);
  }

  update(dt) {
    // Cyan/red tech accents breathe gently from stage 4 onward -- cheap
    // (two shared-material writes, not per-mesh) and kept low-amplitude so
    // armor still reads as the dominant surface, not the lighting.
    if (this.currentStage >= 4) {
      this.mat.techCyan.emissiveIntensity = pulseIntensity(0.6, 0.22, 2.0);
    }
    if (this.currentStage >= 5) {
      this.mat.warnRed.emissiveIntensity = pulseIntensity(0.6, 0.2, 1.2);
    }

    if (!this.animGroup) return;

    this.animElapsed += dt;
    const t = clamp01(this.animElapsed / this.animDuration);
    const eased = easeOutBack(t);

    this.animGroup.scale.setScalar(Math.max(0.05, eased));
    this.animGroup.position.lerpVectors(
      this.animStartPos, this.animTargetPos, easeOutCubic(t)
    );

    if (t >= 1) {
      this.animGroup.scale.setScalar(1);
      this.animGroup.position.copy(this.animTargetPos);
      this.animGroup = null;
    }
  }

  dispose() {
    for (const stageGroup of this.stageGroups) {
      if (!stageGroup) continue;
      stageGroup.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose();
      });
      stageGroup.parent?.remove(stageGroup);
    }
  }
}

export { MAX_EVOLUTION_STAGE };
