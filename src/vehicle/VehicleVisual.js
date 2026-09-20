import * as THREE from "three";
import { DEFAULT_VEHICLE_TYPE } from "./VehicleConfig.js";

// ---------------------------------------------------------------------------
// VehicleVisual.js
//
// Single source of truth for vehicle APPEARANCE: body geometry, materials,
// wheels (tire/rim/spokes/hub/lug nuts/brake disc/caliper), and the interior
// (seats/dashboard/steering wheel/cockpit trim). Both the local player's
// Vehicle.js and every RemoteVehicle.js call into this module instead of
// maintaining their own copies of the geometry, so there is exactly one
// place that defines what a car looks like.
//
// Visual direction: a rugged, high-clearance off-road chassis at stage 0
// that already reads as "built for a fight" -- flared arches, a skid-plated
// nose, exposed structural brackets -- so VehicleEvolution.js's armor stages
// read as upgrades to a real vehicle rather than plates glued onto a plain
// sedan. See VehicleEvolution.js for the cumulative armor/cyberpunk stages
// that build on top of this base.
//
// This module intentionally knows nothing about:
//   - driving physics / input / collision (stays in Vehicle.js)
//   - network state / interpolation (stays in RemoteVehicle.js)
//   - evolution/armor stages (stays in VehicleEvolution.js, which already
//     operates generically on whatever `root` group is handed to it and is
//     used identically by both Vehicle.js and RemoteVehicle.js)
//
// `buildVehicleBody(root, color)` attaches every body/interior mesh directly
// to `root` and returns the handful of objects callers need a live reference
// to (materials, exhaust emission points, driver eye anchor, steering wheel,
// dashboard canvas/texture, status canvas/texture). `buildWheelGeometries()`
// + `createWheel(...)` are separate because local and remote vehicles wire
// wheels up very differently: the local vehicle adds each wheel directly to
// the scene and positions it every frame from the real per-wheel cannon-es
// physics transform, while a remote vehicle wraps each wheel in a small
// pivot group parented under `root` and drives it from interpolated network
// state. Only the wheel's *visual construction* is shared here -- not that
// wiring.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------
// All materials are created once per vehicle instance and shared across
// every mesh that needs them, so adding visual detail does not multiply
// material (shader program) count. Called once per Vehicle/RemoteVehicle
// instance so each car keeps its own paint color and its own instances for
// VehicleDestruction.js to darken without affecting any other car.

export function createVehicleMaterials(color) {
  return {
    // Clear-coated body paint. MeshPhysicalMaterial's clearcoat gives the
    // subtle two-layer reflection of real automotive paint without pushing
    // metalness/roughness into "chrome" territory.
    paint: new THREE.MeshPhysicalMaterial({
      color,
      metalness: 0.55,
      roughness: 0.32,
      clearcoat: 1,
      clearcoatRoughness: 0.12
    }),

    // Lower bumpers / skirts / diffuser: same paint tone but flatter, as on
    // a real bumper cover.
    paintLower: new THREE.MeshStandardMaterial({
      color,
      metalness: 0.25,
      roughness: 0.55
    }),

    // Unpainted structural cladding (fender flares, skid plate, side
    // cladding) -- textured dark grey plastic/composite rather than body
    // paint, the way real off-road trims contrast with the painted panels.
    cladding: new THREE.MeshStandardMaterial({
      color: 0x2a2d31,
      roughness: 0.82,
      metalness: 0.08
    }),

    // Matte black plastic (grille backing, vents, interior trim, tires' hub
    // surroundings).
    dark: new THREE.MeshStandardMaterial({
      color: 0x14181d,
      roughness: 0.88,
      metalness: 0.05
    }),

    // Dark gloss trim (window surrounds, pillars, badges backing).
    trim: new THREE.MeshStandardMaterial({
      color: 0x2b333c,
      metalness: 0.4,
      roughness: 0.42
    }),

    // Exposed structural steel -- brackets, tow points, roll-cage bracing.
    // Rougher and darker than chrome so it reads as raw metal, not jewelry.
    gunmetal: new THREE.MeshStandardMaterial({
      color: 0x565d64,
      metalness: 0.88,
      roughness: 0.42
    }),

    // Bright chrome accents (grille frame, exhaust tips, badge ring).
    chrome: new THREE.MeshStandardMaterial({
      color: 0xe4e8ec,
      metalness: 1,
      roughness: 0.12
    }),

    // Brushed aluminium look (rims, brake discs).
    brushedMetal: new THREE.MeshStandardMaterial({
      color: 0x9aa0a6,
      metalness: 0.85,
      roughness: 0.32
    }),

    // Tire rubber.
    rubber: new THREE.MeshStandardMaterial({
      color: 0x101214,
      roughness: 0.95,
      metalness: 0
    }),

    // Wheel alloy face.
    alloy: new THREE.MeshStandardMaterial({
      color: 0xb7bcc0,
      metalness: 0.88,
      roughness: 0.28
    }),

    brakeDisc: new THREE.MeshStandardMaterial({
      color: 0x8a8d90,
      metalness: 0.75,
      roughness: 0.4
    }),

    brakeCaliper: new THREE.MeshStandardMaterial({
      color: 0xa8121f,
      metalness: 0.25,
      roughness: 0.5
    }),

    // Window glass: kept as a translucent, non-shadow-casting surface with a
    // faint tint and slight reflectivity.
    glass: new THREE.MeshPhysicalMaterial({
      color: 0xcfe7f2,
      transparent: true,
      opacity: 0.16,
      roughness: 0.08,
      metalness: 0,
      clearcoat: 0.6,
      clearcoatRoughness: 0.2,
      depthWrite: false,
      side: THREE.DoubleSide
    }),

    // Dark glossy sensor/camera lens (mirrors, roof pods, front sensor
    // cluster) -- reads as an optical element rather than a light.
    lens: new THREE.MeshPhysicalMaterial({
      color: 0x0c1114,
      metalness: 0.2,
      roughness: 0.15,
      clearcoat: 1,
      clearcoatRoughness: 0.05
    }),

    headlightLens: new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.35,
      roughness: 0.08,
      metalness: 0,
      depthWrite: false
    }),

    tailLightLens: new THREE.MeshPhysicalMaterial({
      color: 0x8a1015,
      transparent: true,
      opacity: 0.45,
      roughness: 0.1,
      metalness: 0,
      depthWrite: false
    }),

    lampWarm: new THREE.MeshStandardMaterial({
      color: 0xfff6da,
      emissive: 0xffdf9e,
      emissiveIntensity: 0.55
    }),

    drl: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xdfeeff,
      emissiveIntensity: 0.9
    }),

    tailLamp: new THREE.MeshStandardMaterial({
      color: 0xb61925,
      emissive: 0xff1420,
      emissiveIntensity: 0.35
    }),

    reverseLamp: new THREE.MeshStandardMaterial({
      color: 0xf2f2e8,
      emissive: 0xffffff,
      emissiveIntensity: 0.3
    }),

    indicator: new THREE.MeshStandardMaterial({
      color: 0xff9d2e,
      emissive: 0xff8c00,
      emissiveIntensity: 0.4
    }),

    // Low-key cyan tech accent used sparingly on the base vehicle (sensor
    // rings, a thin console strip) so the highest evolution stages -- which
    // lean on the same color much harder -- read as an intensification of
    // an established language rather than a color that appears from
    // nowhere at stage 4.
    techCyan: new THREE.MeshStandardMaterial({
      color: 0x8fe9e0,
      emissive: 0x36d6c8,
      emissiveIntensity: 0.5,
      metalness: 0.2,
      roughness: 0.35
    }),

    // Interior warning-red accent (distinct instance from the exterior
    // indicator lamp so cockpit brightness can be tuned independently).
    warnRed: new THREE.MeshStandardMaterial({
      color: 0xff4a44,
      emissive: 0xff2a24,
      emissiveIntensity: 0.55
    }),

    seat: new THREE.MeshStandardMaterial({
      color: 0x2c313a,
      roughness: 0.78,
      metalness: 0
    }),

    seatTrim: new THREE.MeshStandardMaterial({
      color: 0x454c56,
      roughness: 0.6,
      metalness: 0
    }),

    interiorTrim: new THREE.MeshStandardMaterial({
      color: 0x1c2128,
      roughness: 0.7,
      metalness: 0.1
    })
  };
}

// ---------------------------------------------------------------------------
// Small geometry helpers
// ---------------------------------------------------------------------------

function addBox(parent, size, position, material, rotation) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...position);
  if (rotation) mesh.rotation.set(...rotation);
  mesh.castShadow = !material.transparent;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function addMesh(parent, geometry, material, position, rotation) {
  const mesh = new THREE.Mesh(geometry, material);
  if (position) mesh.position.set(...position);
  if (rotation) mesh.rotation.set(...rotation);
  mesh.castShadow = !material.transparent;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function group(parent, position, rotation) {
  const g = new THREE.Group();
  if (position) g.position.set(...position);
  if (rotation) g.rotation.set(...rotation);
  parent.add(g);
  return g;
}

// ---------------------------------------------------------------------------
// Exterior detail builders
// ---------------------------------------------------------------------------

function createGrille(mat, parent, z) {
  const g = group(parent, [0, 0.12, z]);

  // Recessed backing so the slats read as having real depth.
  addBox(g, [0.9, 0.26, 0.05], [0, 0, -0.03], mat.dark);

  // Chrome frame around the opening.
  addBox(g, [0.94, 0.03, 0.03], [0, 0.13, 0], mat.gunmetal);
  addBox(g, [0.94, 0.03, 0.03], [0, -0.13, 0], mat.gunmetal);
  addBox(g, [0.03, 0.28, 0.03], [-0.455, 0, 0], mat.gunmetal);
  addBox(g, [0.03, 0.28, 0.03], [0.455, 0, 0], mat.gunmetal);

  // Angled slats (skewed, not flat) -- reads as a functional intake rather
  // than a decorative grid.
  const slatCount = 5;
  for (let i = 0; i < slatCount; i++) {
    const t = i / (slatCount - 1) - 0.5;
    addBox(g, [0.86, 0.03, 0.05], [0, t * 0.22, 0.01], mat.trim, [0, 0, 0.12]);
  }

  // Center sensor boss (small dark lens rather than a chrome badge -- this
  // is a working vehicle, not a showroom car).
  addMesh(
    g,
    new THREE.CylinderGeometry(0.055, 0.055, 0.02, 16),
    mat.lens,
    [0, 0, 0.045],
    [Math.PI / 2, 0, 0]
  );

  return g;
}

// Skid plate + lower fascia intake, mounted under the front bumper. This is
// the "already built for rough terrain" cue that makes the stage-0 vehicle
// look intentional instead of unfinished.
function createSkidPlate(mat, root) {
  const g = group(root, [0, -0.19, 2.05]);
  addBox(g, [1.55, 0.06, 0.55], [0, 0, -0.15], mat.gunmetal);
  // Diamond-plate style ridges (a handful of angled bars, not a texture).
  for (let i = -3; i <= 3; i++) {
    addBox(g, [0.14, 0.012, 0.5], [i * 0.2, 0.035, -0.15], mat.dark, [0, 0, i % 2 === 0 ? 0.3 : -0.3]);
  }
  // Forward lip.
  addBox(g, [1.4, 0.05, 0.08], [0, 0.01, 0.12], mat.dark);
  return g;
}

function createHeadlightAssembly(mat, side, parent) {
  const g = group(parent, [side * 0.68, 0.33, 1.95]);

  // Angular housing recess -- wedge-shaped instead of a plain rectangle.
  addBox(g, [0.4, 0.19, 0.05], [0, 0, -0.02], mat.dark);
  addBox(g, [0.14, 0.19, 0.05], [0.13 * side, 0, -0.015], mat.dark, [0, 0, side * 0.35]);

  // Main projector lamp.
  addMesh(
    g,
    new THREE.CylinderGeometry(0.055, 0.055, 0.06, 16),
    mat.lampWarm,
    [-0.1 * side, -0.02, 0.02],
    [Math.PI / 2, 0, 0]
  );

  // Secondary small lamp element.
  addMesh(
    g,
    new THREE.CylinderGeometry(0.03, 0.03, 0.05, 12),
    mat.lampWarm,
    [0.08 * side, -0.02, 0.02],
    [Math.PI / 2, 0, 0]
  );

  // L-shaped DRL strip, angled to match the wedge housing.
  addBox(g, [0.3, 0.02, 0.02], [0.02 * side, 0.06, 0.028], mat.drl, [0, 0, side * 0.06]);
  addBox(g, [0.02, 0.07, 0.02], [-0.14 * side, 0.02, 0.028], mat.drl);

  // Clear lens cover over the whole assembly, for depth/gloss.
  addBox(g, [0.4, 0.19, 0.015], [0, 0, 0.045], mat.headlightLens);

  return g;
}

function createTaillightAssembly(mat, side, parent) {
  const g = group(parent, [side * 0.68, 0.33, -1.97]);

  addBox(g, [0.4, 0.19, 0.05], [0, 0, 0.02], mat.dark);

  // Segmented LED strip (three short bars read as a continuous light bar
  // from a normal viewing distance, without needing extra shader work).
  for (const t of [-0.14, 0, 0.14]) {
    addBox(g, [0.11, 0.05, 0.02], [t * side, 0.02, 0.04], mat.tailLamp);
  }

  // Small reverse-light insert.
  addBox(g, [0.09, 0.035, 0.02], [0.15 * side, -0.06, 0.04], mat.reverseLamp);

  // Translucent red lens over the assembly.
  addBox(g, [0.4, 0.19, 0.015], [0, 0, 0.055], mat.tailLightLens);

  return g;
}

// Full-width thin light bar linking the two taillight assemblies -- reads
// as one signature at a glance, the way modern light-bar tail designs do,
// without needing a custom lathe/extrude geometry.
function createRearLightBar(mat, root) {
  addBox(root, [1.2, 0.025, 0.02], [0, 0.36, -1.985], mat.tailLamp);
  addBox(root, [1.24, 0.03, 0.03], [0, 0.36, -2.0], mat.tailLightLens);
}

// Camera-pod style mirror: a stalk into a compact housing with a dark lens
// on the rear face, rather than a flat glass rectangle -- cheap to justify
// visually as "already digital" once evolution stages start adding sensors.
function createMirror(mat, side, parent) {
  const g = group(parent, [side * 1.0, 0.76, 0.72]);

  addBox(g, [0.05, 0.03, 0.16], [-side * 0.06, -0.01, 0], mat.paint); // stalk
  addBox(g, [0.19, 0.11, 0.2], [0, 0, 0], mat.paint); // housing
  addMesh(
    g,
    new THREE.CylinderGeometry(0.045, 0.045, 0.02, 16),
    mat.lens,
    [0, 0, -0.105],
    [Math.PI / 2, 0, 0]
  );
  addBox(g, [0.03, 0.02, 0.02], [side * 0.1, 0.035, -0.02], mat.indicator);

  return g;
}

function createDoorHandle(mat, side, z, parent) {
  addBox(
    parent,
    [0.03, 0.03, 0.14],
    [side * 0.925, 0.55, z],
    mat.gunmetal
  );
}

// Flared fender cladding -- a distinct unpainted panel wrapping the top of
// each wheel arch, wider than the painted body beneath it. This is the
// single biggest contributor to the "rugged high-clearance" silhouette
// requirement, and it deliberately sits just outside the physics chassis
// box (cosmetic overhang only; wheel physics/collision are untouched).
function createFenderFlare(mat, side, zCenter, parent) {
  const g = group(parent, [side * 1.0, 0.14, zCenter]);

  // Main arch cap, curved impression via three angled segments.
  addBox(g, [0.16, 0.1, 0.62], [0, 0.16, 0], mat.cladding);
  addBox(g, [0.2, 0.08, 0.34], [0.05 * side, 0.08, 0.16], mat.cladding, [0, 0, side * 0.18]);
  addBox(g, [0.2, 0.08, 0.34], [0.05 * side, 0.08, -0.16], mat.cladding, [0, 0, -side * 0.18]);

  // Vertical rivet-look strip along the seam where it meets the door/quarter
  // panel.
  for (const zf of [-0.22, 0, 0.22]) {
    addMesh(
      g,
      new THREE.CylinderGeometry(0.012, 0.012, 0.02, 8),
      mat.gunmetal,
      [-0.1 * side, 0.14, zf],
      [Math.PI / 2, 0, 0]
    );
  }

  return g;
}

function createSeat(mat, x, parent, isFront) {
  const g = group(parent, [x, 0, 0]);
  const depth = isFront ? -0.28 : -0.9;

  // Cushion.
  addBox(g, [0.55, 0.15, 0.55], [0, 0.43, depth], mat.seat);
  // Backrest.
  addBox(g, [0.55, 0.56, 0.14], [0, 0.72, depth - 0.27], mat.seat);
  // Side bolsters.
  addBox(g, [0.05, 0.5, 0.16], [-0.27, 0.73, depth - 0.27], mat.seatTrim);
  addBox(g, [0.05, 0.5, 0.16], [0.27, 0.73, depth - 0.27], mat.seatTrim);
  // Headrest.
  addBox(g, [0.28, 0.2, 0.13], [0, 1.07, depth - 0.27], mat.seat);
  addMesh(
    g,
    new THREE.CylinderGeometry(0.012, 0.012, 0.1, 8),
    mat.dark,
    [-0.08, 0.96, depth - 0.31]
  );
  addMesh(
    g,
    new THREE.CylinderGeometry(0.012, 0.012, 0.1, 8),
    mat.dark,
    [0.08, 0.96, depth - 0.31]
  );
  // Center seam stitching line (subtle, thin trim strip rather than a
  // heavy black gap), picked out with a thin cyan piping accent to tie the
  // cabin into the vehicle's tech language.
  addBox(g, [0.02, 0.5, 0.13], [0, 0.73, depth - 0.26], mat.seatTrim);
  addBox(g, [0.006, 0.46, 0.006], [0, 0.73, depth - 0.19], mat.techCyan);

  return g;
}

// Integrated cockpit-style wheel: flat-top two-spoke grip with a digital
// insert plate in the hub rather than a plain airbag cover, closer to the
// interior reference's control-heavy dashboard language.
function enhanceSteeringWheel(steeringWheel, mat) {
  // Flat-top rim -- two arcs instead of a full torus.
  addMesh(
    steeringWheel,
    new THREE.TorusGeometry(0.19, 0.022, 10, 24, Math.PI * 1.5),
    mat.dark,
    [0, 0, 0],
    [0, 0, Math.PI * 0.75]
  );
  addBox(steeringWheel, [0.24, 0.03, 0.03], [0, 0.185, 0], mat.dark);

  // Center hub / digital insert.
  addMesh(
    steeringWheel,
    new THREE.CylinderGeometry(0.085, 0.085, 0.045, 16),
    mat.dark,
    [0, 0, -0.005],
    [Math.PI / 2, 0, 0]
  );
  addMesh(
    steeringWheel,
    new THREE.CylinderGeometry(0.05, 0.05, 0.05, 4),
    mat.techCyan,
    [0, 0, -0.012],
    [Math.PI / 2, 0, Math.PI / 4]
  );

  // Two lower spokes.
  for (const side of [-1, 1]) {
    const angle = side > 0 ? -Math.PI / 4 : Math.PI + Math.PI / 4;
    const spoke = group(steeringWheel, [0, 0, 0], [0, 0, angle]);
    addBox(spoke, [0.03, 0.15, 0.026], [0, -0.13, 0], mat.trim);
    // Small paddle/button on the right-hand spoke.
    if (side === 1) {
      addBox(spoke, [0.032, 0.022, 0.014], [0, -0.08, 0.015], mat.techCyan);
    } else {
      addBox(spoke, [0.032, 0.022, 0.014], [0, -0.08, 0.015], mat.warnRed);
    }
  }

  return steeringWheel;
}

// Thin ambient light strip -- used along the dash top, door cards and
// footwell to give the cabin a lit, high-tech feel without simulating real
// point lights (cheap: one emissive box per strip, no extra THREE.Light).
function ambientStrip(mat, parent, size, position, rotation, warm = false) {
  addBox(parent, size, position, warm ? mat.warnRed : mat.techCyan, rotation);
}

// Small physical control greebles (buttons/toggles/knobs) scattered across
// the center console and door cards -- cheap boxes/cylinders, but their
// density is what reads as "high-tech control-heavy cockpit" rather than a
// dashboard with a couple of glowing rectangles.
function createConsoleGreebles(mat, parent) {
  const g = group(parent, [0.16, 0.52, -0.05]);
  const buttonMats = [mat.techCyan, mat.warnRed, mat.trim, mat.dark];
  let i = 0;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const m = buttonMats[i % buttonMats.length];
      addMesh(
        g,
        new THREE.CylinderGeometry(0.012, 0.012, 0.012, 10),
        m,
        [col * 0.035, 0, row * -0.035],
        [Math.PI / 2, 0, 0]
      );
      i++;
    }
  }
  // A couple of toggle switches beside the button grid.
  for (let i = 0; i < 2; i++) {
    addBox(g, [0.018, 0.03, 0.018], [-0.06, 0.02, i * -0.05], mat.trim);
  }
  return g;
}

// ---------------------------------------------------------------------------
// Wheel assembly
// ---------------------------------------------------------------------------
// Geometries are created once and reused for all four wheels of a given
// vehicle instance; only their containing groups differ per corner. Chunkier
// off-road-leaning proportions than a road-car wheel (wider tire, heavier
// hub, thicker spokes) so the wheel already matches the fender flares above
// before any evolution stage adds armor discs.

export function buildWheelGeometries() {
  const tire = new THREE.CylinderGeometry(0.37, 0.37, 0.29, 24);
  tire.rotateZ(Math.PI / 2);

  const sidewall = new THREE.CylinderGeometry(0.35, 0.35, 0.292, 24, 1, true);
  sidewall.rotateZ(Math.PI / 2);

  // Chunky tread blocks around the tire's circumference -- a handful of
  // shallow radial bars read as knobby off-road tread from driving distance
  // at a fraction of the cost of a displaced/bump-mapped tire.
  const treadBlock = new THREE.BoxGeometry(0.045, 0.05, 0.3);

  const rimOuter = new THREE.CylinderGeometry(0.27, 0.27, 0.24, 24);
  rimOuter.rotateZ(Math.PI / 2);

  const rimFace = new THREE.CylinderGeometry(0.27, 0.27, 0.02, 24);
  rimFace.rotateZ(Math.PI / 2);

  const hub = new THREE.CylinderGeometry(0.085, 0.085, 0.25, 16);
  hub.rotateZ(Math.PI / 2);

  // Wider, trapezoidal spoke rather than a thin box -- a heavier, more
  // mechanical-looking wheel face.
  const spoke = new THREE.BoxGeometry(0.06, 0.23, 0.026);

  const lugNut = new THREE.CylinderGeometry(0.016, 0.016, 0.022, 8);
  lugNut.rotateZ(Math.PI / 2);

  const disc = new THREE.CylinderGeometry(0.23, 0.23, 0.02, 20);
  disc.rotateZ(Math.PI / 2);

  const caliper = new THREE.BoxGeometry(0.1, 0.15, 0.18);

  return {
    tire, sidewall, treadBlock, rimOuter, rimFace, hub, spoke, lugNut, disc, caliper
  };
}

// Detailed wheel: tire (with tread blocks), sidewall, alloy rim + face, hub,
// 5 spokes, 5 lug nuts, brake disc, brake caliper. Used identically by the
// local vehicle (added straight to the scene, positioned every frame from
// the real per-wheel physics transform) and every remote vehicle (parented
// under a small steering/spin pivot group instead).
//
// Evolution accents (see VehicleEvolution.js's wheel accent helper) are
// added later as additional children of the returned group, so they inherit
// the exact same per-frame physics transform as the rest of the wheel with
// no extra wiring required.
export function createWheel(geo, mat, inboardSign) {
  const wheel = new THREE.Group();

  const tireMesh = new THREE.Mesh(geo.tire, mat.rubber);
  tireMesh.castShadow = true;
  tireMesh.receiveShadow = true;
  wheel.add(tireMesh);

  const sidewallMesh = new THREE.Mesh(geo.sidewall, mat.rubber);
  wheel.add(sidewallMesh);

  // Tread blocks fanned around the tire circumference.
  const treadCount = 16;
  for (let i = 0; i < treadCount; i++) {
    const angle = (Math.PI * 2 * i) / treadCount;
    const block = new THREE.Mesh(geo.treadBlock, mat.rubber);
    block.position.set(0, Math.cos(angle) * 0.37, Math.sin(angle) * 0.37);
    block.rotation.x = angle;
    wheel.add(block);
  }

  // Alloy rim face + outer lip.
  const rimOuterMesh = new THREE.Mesh(geo.rimOuter, mat.alloy);
  rimOuterMesh.castShadow = true;
  wheel.add(rimOuterMesh);

  const rimFaceMesh = new THREE.Mesh(geo.rimFace, mat.alloy);
  rimFaceMesh.position.x = 0.11 * inboardSign * -1;
  wheel.add(rimFaceMesh);

  // Five heavier spokes fanned around the hub.
  for (let i = 0; i < 5; i++) {
    const angle = (Math.PI * 2 * i) / 5;
    const spokeMesh = new THREE.Mesh(geo.spoke, mat.alloy);
    spokeMesh.position.set(0.1 * inboardSign * -1, 0, 0);
    spokeMesh.rotation.x = angle;
    wheel.add(spokeMesh);
  }

  const hubMesh = new THREE.Mesh(geo.hub, mat.gunmetal);
  wheel.add(hubMesh);

  // Lug nuts around the hub.
  for (let i = 0; i < 5; i++) {
    const angle = (Math.PI * 2 * i) / 5;
    const lug = new THREE.Mesh(geo.lugNut, mat.brushedMetal);
    lug.position.set(0.14 * inboardSign * -1, Math.cos(angle) * 0.1, Math.sin(angle) * 0.1);
    wheel.add(lug);
  }

  // Brake disc + caliper, sitting inboard of the rim, visible through the
  // spokes as on a real alloy wheel.
  const discMesh = new THREE.Mesh(geo.disc, mat.brakeDisc);
  discMesh.position.x = 0.09 * inboardSign;
  wheel.add(discMesh);

  const caliperMesh = new THREE.Mesh(geo.caliper, mat.brakeCaliper);
  caliperMesh.position.set(0.09 * inboardSign, 0.19, 0.03);
  caliperMesh.castShadow = true;
  wheel.add(caliperMesh);

  return wheel;
}

// ---------------------------------------------------------------------------
// Vehicle body
// ---------------------------------------------------------------------------
// Attaches the full body/interior construction directly to `root` (a
// THREE.Group already added to the scene by the caller). Returns the live
// objects a caller needs to keep a reference to:
//   - mat: the material set (so the caller can e.g. keep `mat.paint`)
//   - exhaustPoints: vehicle-local Vector3s for ExhaustSystem
//   - driverEye: camera anchor Object3D (used by CameraManager for the
//     local vehicle only; harmless to ignore for remote vehicles)
//   - steeringWheel: THREE.Group so callers can animate rotation.z from
//     steering input/state
//   - dashboardCanvas/dashboardContext/dashboardTexture: canvas-backed
//     primary instrument cluster display (speed/gear/rpm -- driven live by
//     Vehicle.js.updatePresentation())
//   - statusCanvas/statusContext/statusTexture: canvas-backed secondary
//     console display (system/turbo status readout) -- drawn once here;
//     callers may repaint it the same way as the dashboard if they want it
//     data-driven later, but it already looks correct with no extra wiring.

// ---------------------------------------------------------------------------
// buildVehicleBody(root, color, vehicleType) dispatches to the builder for
// the requested type (see VehicleConfig.js). There is only one builder today
// -- buildSedanBody -- but callers already pass a type through, so adding a
// second one later is additive here, not a change to every call site.
// ---------------------------------------------------------------------------
export function buildVehicleBody(root, color, vehicleType = DEFAULT_VEHICLE_TYPE) {
  switch (vehicleType) {
    case "sedan":
    default:
      return buildSedanBody(root, color);
  }
}

function buildSedanBody(root, color) {
  const mat = createVehicleMaterials(color);

  // +Z = front, +Y = up. Chassis origin and physics footprint (see
  // VehiclePhysics.js: half-extents 0.9/0.3/2, wheel connection points at
  // x=+-0.95, z=+-1.35) remain unchanged. Fender flares/skid plate/bumpers
  // are cosmetic overhang beyond that box, which is normal for vehicle art
  // vs. a collision box and does not affect handling.

  // ---- Lower body / floor pan -----------------------------------------
  addBox(root, [1.78, 0.34, 3.98], [0, 0.05, 0], mat.paint);

  // Rugged side cladding (unpainted, sits proud of the door skin) instead of
  // a painted rocker panel -- the first "this is built for off-road, not
  // showroom" cue.
  for (const side of [-1, 1]) {
    addBox(root, [0.1, 0.13, 2.6], [side * 0.92, -0.08, -0.1], mat.cladding);
    for (let i = -2; i <= 2; i++) {
      addBox(root, [0.11, 0.03, 0.16], [side * 0.925, -0.02, i * 0.42], mat.dark);
    }
  }

  // Front and rear lower lips.
  addBox(root, [1.7, 0.08, 0.1], [0, -0.1, 2.1], mat.paintLower);
  addBox(root, [1.66, 0.08, 0.14], [0, -0.1, -2.15], mat.paintLower);

  // ---- Cabin belt / greenhouse base ------------------------------------
  addBox(root, [1.7, 0.12, 2.1], [0, 0.3, -0.1], mat.dark);

  // ---- Hood: power-dome center + intake vents --------------------------
  addBox(root, [1.72, 0.2, 1.1], [0, 0.34, 1.36], mat.paint);
  addBox(root, [0.86, 0.06, 1.0], [0, 0.45, 1.36], mat.paint);
  // Vent slats cut into the power dome shoulders.
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      addBox(root, [0.16, 0.015, 0.05], [side * 0.55, 0.455, 1.6 - i * 0.16], mat.dark);
    }
  }

  // Trunk lid.
  addBox(root, [1.72, 0.2, 0.62], [0, 0.34, -1.62], mat.paint);
  // Subtle trunk lip / spoiler.
  addBox(root, [1.6, 0.03, 0.1], [0, 0.46, -1.92], mat.trim);

  // ---- Fender flares (front + rear, both sides) -------------------------
  for (const side of [-1, 1]) {
    createFenderFlare(mat, side, 1.15, root);
    createFenderFlare(mat, side, -1.15, root);

    // Painted fender surface beneath the cladding cap.
    addBox(root, [0.14, 0.34, 0.9], [side * 0.93, 0.26, 1.15], mat.paint);
    addBox(root, [0.14, 0.34, 0.9], [side * 0.93, 0.26, -1.15], mat.paint);
  }

  // ---- Front fascia: skid plate + angled bumper + intakes ---------------
  createSkidPlate(mat, root);
  addBox(root, [1.86, 0.2, 0.16], [0, -0.02, 2.03], mat.paintLower);
  addBox(root, [1.5, 0.1, 0.06], [0, -0.14, 2.09], mat.dark); // lower splitter
  createGrille(mat, root, 2.06);

  // Lower side intakes.
  for (const side of [-1, 1]) {
    addBox(root, [0.3, 0.1, 0.05], [side * 0.62, -0.06, 2.08], mat.dark);
    addBox(root, [0.24, 0.06, 0.02], [side * 0.62, -0.06, 2.1], mat.trim);
  }

  // Structural tow hook, now a visible gunmetal loop rather than a thin
  // chrome ring -- matches the exposed-bracket language the evolution
  // stages will build on.
  addMesh(
    root,
    new THREE.TorusGeometry(0.04, 0.012, 6, 10),
    mat.gunmetal,
    [0, -0.13, 2.14],
    [Math.PI / 2, 0, 0]
  );

  // ---- Rear bumper & diffuser -------------------------------------------
  addBox(root, [1.86, 0.2, 0.16], [0, -0.02, -2.03], mat.paintLower);
  addBox(root, [1.5, 0.09, 0.14], [0, -0.15, -2.1], mat.dark); // diffuser body
  for (let i = -3; i <= 3; i++) {
    addBox(root, [0.03, 0.07, 0.14], [i * 0.2, -0.15, -2.14], mat.gunmetal);
  }

  // Exhaust outlets. Their positions are also exposed as `exhaustPoints`
  // (vehicle-local space) so ExhaustSystem can emit particles from the
  // actual tailpipe tips instead of a guessed offset.
  const exhaustPoints = [];
  for (const side of [-1, 1]) {
    const position = [side * 0.55, -0.16, -2.14];

    addMesh(
      root,
      new THREE.CylinderGeometry(0.055, 0.05, 0.1, 14),
      mat.gunmetal,
      position,
      [Math.PI / 2, 0, 0]
    );
    addMesh(
      root,
      new THREE.CylinderGeometry(0.038, 0.038, 0.02, 14),
      mat.dark,
      [position[0], position[1], position[2] - 0.05],
      [Math.PI / 2, 0, 0]
    );

    // Slightly behind the visible tip so puffs originate just outside the
    // tailpipe geometry rather than inside it.
    exhaustPoints.push(
      new THREE.Vector3(position[0], position[1], position[2] - 0.1)
    );
  }
  createRearLightBar(mat, root);
  // Rear reflectors.
  for (const side of [-1, 1]) {
    addBox(root, [0.09, 0.03, 0.02], [side * 0.85, -0.06, -2.11], mat.indicator);
  }

  // ---- Headlights & taillights ------------------------------------------
  for (const side of [-1, 1]) {
    createHeadlightAssembly(mat, side, root);
    createTaillightAssembly(mat, side, root);
  }

  // ---- Doors, sills, mirrors, handles, pillars --------------------------
  for (const side of [-1, 1]) {
    // Door skin.
    addBox(root, [0.1, 0.38, 2.02], [side * 0.86, 0.43, -0.15], mat.paint);
    // Subtle seam rather than a heavy black gap.
    addBox(root, [0.012, 0.36, 2.02], [side * 0.91, 0.43, -0.15], mat.trim);
    // Lower door / rocker trim.
    addBox(root, [0.055, 0.28, 1.85], [side * 0.795, 0.45, -0.15], mat.dark);
    addBox(root, [0.12, 0.06, 2.2], [side * 0.9, 0.02, -0.12], mat.gunmetal);

    // Character line.
    addBox(root, [0.02, 0.03, 2.4], [side * 0.905, 0.55, -0.1], mat.trim);

    // Door handles (front + rear doors).
    createDoorHandle(mat, side, 0.55, root);
    createDoorHandle(mat, side, -0.75, root);

    // Roof pillars: A, B, C. Gaps between them remain the window openings.
    addBox(root, [0.07, 0.7, 0.1], [side * 0.77, 0.93, 0.83], mat.paint);
    addBox(root, [0.06, 0.7, 0.07], [side * 0.79, 0.93, -0.3], mat.paint);
    addBox(root, [0.07, 0.7, 0.1], [side * 0.77, 0.93, -1.15], mat.paint);

    // Window trim strip along the beltline.
    addBox(root, [0.02, 0.02, 2.2], [side * 0.79, 0.62, -0.15], mat.trim);

    createMirror(mat, side, root);
  }

  // ---- Roof: panoramic glass panel + roof-rail mounting points -----------
  addBox(root, [1.64, 0.09, 2.14], [0, 1.3, -0.16], mat.paint);
  addBox(root, [1.02, 0.012, 1.3], [0, 1.35, -0.2], mat.trim); // sunroof surround
  addBox(root, [0.94, 0.01, 1.2], [0, 1.352, -0.2], mat.glass);

  // Low roof rails -- functional-looking mounting rails that later
  // evolution stages can visually "use" for roof-mounted tech instead of it
  // appearing to float above bare paint.
  for (const side of [-1, 1]) {
    addBox(root, [0.04, 0.03, 1.7], [side * 0.62, 1.365, -0.2], mat.gunmetal);
    for (const zf of [0.5, -0.1, -0.7]) {
      addBox(root, [0.045, 0.025, 0.03], [side * 0.62, 1.365, zf], mat.dark);
    }
  }

  // Small forward sensor bump at the windshield header -- reads as "this
  // vehicle already has driver-assist hardware" before any evolution stage
  // adds a full sensor cluster.
  addBox(root, [0.14, 0.05, 0.08], [0, 1.34, 0.62], mat.dark);
  addMesh(
    root,
    new THREE.CylinderGeometry(0.02, 0.02, 0.03, 10),
    mat.lens,
    [0, 1.335, 0.66],
    [Math.PI / 2, 0, 0]
  );

  // ---- Windows: individual panels instead of two giant slabs -----------
  // Windshield (angled).
  addMesh(
    root,
    new THREE.PlaneGeometry(1.4, 0.66),
    mat.glass,
    [0, 0.95, 0.87],
    [-0.18, 0, 0]
  );

  // Rear windshield.
  addMesh(
    root,
    new THREE.PlaneGeometry(1.4, 0.55),
    mat.glass,
    [0, 0.97, -1.2],
    [0.22, 0, 0]
  );

  // Front + rear side windows, separated by the B-pillar gap.
  for (const side of [-1, 1]) {
    const rotY = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    addMesh(
      root,
      new THREE.PlaneGeometry(1.0, 0.42),
      mat.glass,
      [side * 0.795, 0.62, 0.28],
      [0, rotY, 0]
    );
    addMesh(
      root,
      new THREE.PlaneGeometry(0.75, 0.42),
      mat.glass,
      [side * 0.795, 0.62, -0.75],
      [0, rotY, 0]
    );
  }

  // ---- Interior / cockpit -------------------------------------------------
  createSeat(mat, -0.43, root, true);
  createSeat(mat, 0.43, root, true);
  // Simple rear bench.
  addBox(root, [1.37, 0.16, 0.5], [0, 0.44, -0.95], mat.seat);
  addBox(root, [1.37, 0.5, 0.14], [0, 0.72, -1.22], mat.seat);
  addBox(root, [1.37, 0.16, 0.13], [0, 0.98, -1.22], mat.seat);

  // Dashboard body: a hooded binnacle over the instrument cluster (deeper
  // shroud than a flat dash slab) plus a lower console shelf, closer to the
  // interior reference's layered cockpit silhouette.
  addBox(root, [1.5, 0.18, 0.34], [0, 0.68, 0.74], mat.dark);
  addBox(root, [0.56, 0.1, 0.14], [0.43, 0.8, 0.9], mat.dark); // instrument hood, deeper
  addBox(root, [0.5, 0.02, 0.02], [0.43, 0.855, 0.83], mat.trim); // hood lip
  addBox(root, [1.46, 0.02, 0.02], [0, 0.6, 0.58], mat.trim); // dash trim strip
  // Ambient strip along the base of the dash, echoing the reference photo's
  // thin lit seams.
  ambientStrip(mat, root, [1.3, 0.008, 0.008], [0, 0.615, 0.6]);

  // Center console + status readout.
  addBox(root, [0.2, 0.25, 0.72], [0, 0.4, -0.03], mat.interiorTrim);
  addBox(root, [0.22, 0.03, 0.3], [0, 0.53, -0.1], mat.dark); // raised console shelf
  createConsoleGreebles(mat, root);
  addBox(root, [0.025, 0.2, 0.025], [0, 0.62, 0.04], mat.trim); // gear selector stem
  addMesh(root, new THREE.SphereGeometry(0.045, 12, 8), mat.dark, [0, 0.74, 0.04]);
  // Cupholder detail.
  addMesh(
    root,
    new THREE.TorusGeometry(0.035, 0.006, 6, 14),
    mat.trim,
    [0.12, 0.535, 0.05],
    [Math.PI / 2, 0, 0]
  );

  // Door interior panels + armrests, with a thin cyan strip along the top of
  // each panel to match the console's tech accents.
  for (const side of [-1, 1]) {
    addBox(root, [0.06, 0.3, 1.7], [side * 0.78, 0.45, -0.2], mat.interiorTrim);
    addBox(root, [0.08, 0.06, 0.4], [side * 0.78, 0.55, 0.1], mat.seatTrim);
    ambientStrip(mat, root, [0.02, 0.008, 1.5], [side * 0.805, 0.61, -0.2]);
  }

  // Driver anchor -- a GLB rig could replace this later.
  const driverEye = new THREE.Object3D();
  // Vehicle-local +X is the driver's left when looking along +Z.
  driverEye.position.set(0.43, 1.04, -0.08);
  root.add(driverEye);

  // Steering wheel faces toward the driver, who looks along +Z.
  const steeringWheel = new THREE.Group();
  steeringWheel.position.set(0.43, 0.78, 0.47);
  root.add(steeringWheel);
  enhanceSteeringWheel(steeringWheel, mat);

  // ---- Canvas-backed primary instrument cluster --------------------------
  const dashboardCanvas = document.createElement("canvas");
  dashboardCanvas.width = 512;
  dashboardCanvas.height = 192;
  const dashboardContext = dashboardCanvas.getContext("2d");
  const dashboardTexture = new THREE.CanvasTexture(dashboardCanvas);
  dashboardTexture.colorSpace = THREE.SRGBColorSpace;

  const display = new THREE.Mesh(
    new THREE.PlaneGeometry(0.45, 0.17),
    new THREE.MeshBasicMaterial({
      map: dashboardTexture,
      side: THREE.DoubleSide
    })
  );

  display.position.set(0.43, 0.83, 0.83);
  display.rotation.y = Math.PI;
  root.add(display);

  // Thin bezel around the display so it reads as a mounted instrument
  // cluster rather than a floating plane.
  addBox(root, [0.47, 0.02, 0.012], [0.43, 0.917, 0.835], mat.dark);
  addBox(root, [0.47, 0.02, 0.012], [0.43, 0.743, 0.835], mat.dark);

  // ---- Canvas-backed secondary console display ---------------------------
  // A small square status panel mounted in the center console, drawn once
  // with a decorative system/HUD graphic. Not fed live gameplay data today
  // (no turbo/health state is threaded this far down) but painted so that a
  // caller can start writing to `statusContext`/`statusTexture` exactly the
  // same way Vehicle.js already does for the main dashboard, with no
  // further plumbing required here.
  const statusCanvas = document.createElement("canvas");
  statusCanvas.width = 256;
  statusCanvas.height = 256;
  const statusContext = statusCanvas.getContext("2d");
  paintStatusPanel(statusContext);
  const statusTexture = new THREE.CanvasTexture(statusCanvas);
  statusTexture.colorSpace = THREE.SRGBColorSpace;

  const statusDisplay = new THREE.Mesh(
    new THREE.PlaneGeometry(0.16, 0.16),
    new THREE.MeshBasicMaterial({ map: statusTexture, side: THREE.DoubleSide })
  );
  statusDisplay.position.set(0, 0.535, -0.08);
  statusDisplay.rotation.x = -Math.PI / 2.4;
  root.add(statusDisplay);
  addBox(root, [0.18, 0.01, 0.18], [0, 0.528, -0.08], mat.dark, [-Math.PI / 2.4, 0, 0]);

  return {
    mat,
    exhaustPoints,
    driverEye,
    steeringWheel,
    dashboardCanvas,
    dashboardContext,
    dashboardTexture,
    statusCanvas,
    statusContext,
    statusTexture
  };
}

// One-time decorative paint pass for the console status panel: a hex-grid
// backdrop, a couple of static bar readouts, and a ring gauge, all in the
// vehicle's cyan/red tech accent colors.
function paintStatusPanel(ctx) {
  const w = 256, h = 256;
  ctx.fillStyle = "#070c10";
  ctx.fillRect(0, 0, w, h);

  // Faint hex-grid backdrop.
  ctx.strokeStyle = "rgba(80, 210, 200, 0.12)";
  ctx.lineWidth = 1;
  const hexR = 14;
  for (let row = -1; row < 10; row++) {
    for (let col = -1; col < 10; col++) {
      const x = col * hexR * 1.7 + (row % 2 ? hexR * 0.85 : 0);
      const y = row * hexR * 1.5;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i;
        const px = x + Math.cos(a) * hexR * 0.5;
        const py = y + Math.sin(a) * hexR * 0.5;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }

  // Ring gauge.
  ctx.strokeStyle = "#2b3944";
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.arc(w / 2, 96, 60, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = "#3fe0cf";
  ctx.beginPath();
  ctx.arc(w / 2, 96, 60, -Math.PI / 2, -Math.PI / 2 + Math.PI * 1.4);
  ctx.stroke();

  ctx.fillStyle = "#8ff2e6";
  ctx.font = "bold 22px monospace";
  ctx.textAlign = "center";
  ctx.fillText("SYS", w / 2, 92);
  ctx.font = "12px monospace";
  ctx.fillStyle = "#5fb9ae";
  ctx.fillText("ONLINE", w / 2, 110);

  // Status bars.
  const labels = ["PWR", "TMP", "AUX"];
  const colors = ["#3fe0cf", "#ff9d2e", "#3fe0cf"];
  const values = [0.86, 0.42, 0.63];
  labels.forEach((label, i) => {
    const y = 175 + i * 26;
    ctx.fillStyle = "#8aa0a8";
    ctx.font = "11px monospace";
    ctx.textAlign = "left";
    ctx.fillText(label, 20, y - 4);
    ctx.fillStyle = "#1c262b";
    ctx.fillRect(20, y, 216, 8);
    ctx.fillStyle = colors[i];
    ctx.fillRect(20, y, 216 * values[i], 8);
  });

  ctx.textAlign = "left";
}
