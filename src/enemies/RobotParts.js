import * as THREE from "three";

// ---------------------------------------------------------------------------
// Shared, reusable geometry + material building blocks for the mechanical
// enemy faction (grunt humanoids + the spider boss). Kept in one place so
// both models share a consistent industrial-armor look and so geometries
// are created ONCE and reused across every enemy instance (perf -- see
// brief's PERFORMANCE section), never rebuilt per-instance or per-frame.
//
// Only cheap per-instance material CLONES are made where an enemy needs
// independent damage-flash / hue -- everything else (geometry, base
// materials) is shared module-level state, matching the pattern already
// used by Target.js's createSharedTargetAssets().
// ---------------------------------------------------------------------------

let cache = null;

export function getRobotMaterials() {
  if (cache) return cache;

  const armor = new THREE.MeshStandardMaterial({
    color: 0x6b7078,
    metalness: 0.75,
    roughness: 0.42
  });

  const armorDark = new THREE.MeshStandardMaterial({
    color: 0x2b2e33,
    metalness: 0.6,
    roughness: 0.5
  });

  const jointMetal = new THREE.MeshStandardMaterial({
    color: 0x94989e,
    metalness: 0.9,
    roughness: 0.25
  });

  const hydraulic = new THREE.MeshStandardMaterial({
    color: 0x3a3d42,
    metalness: 0.4,
    roughness: 0.6
  });

  // Hostile red-orange sensor glow -- shared base, cloned per-instance so
  // damage-flash / hp-color tinting doesn't leak across enemies.
  const eyeGlow = new THREE.MeshStandardMaterial({
    color: 0xff3b1f,
    emissive: 0xff2a10,
    emissiveIntensity: 1.4,
    metalness: 0.1,
    roughness: 0.3
  });

  const bossArmor = new THREE.MeshStandardMaterial({
    color: 0x545a52,
    metalness: 0.7,
    roughness: 0.48
  });

  const bossArmorDark = new THREE.MeshStandardMaterial({
    color: 0x24261f,
    metalness: 0.55,
    roughness: 0.55
  });

  const bossCore = new THREE.MeshStandardMaterial({
    color: 0xffb020,
    emissive: 0xff7a10,
    emissiveIntensity: 1.6,
    metalness: 0.2,
    roughness: 0.25
  });

  cache = {
    armor,
    armorDark,
    jointMetal,
    hydraulic,
    eyeGlow,
    bossArmor,
    bossArmorDark,
    bossCore,
    // Geometries -- primitives only, reused across every part that needs
    // "a box" / "a cylinder joint" / etc, scaled per-use via mesh.scale
    // rather than allocating a new BufferGeometry per part.
    unitBox: new THREE.BoxGeometry(1, 1, 1),
    unitCylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 12),
    unitSphere: new THREE.SphereGeometry(0.5, 14, 10)
  };

  return cache;
}

// A single armor-plate box mesh, sized and positioned in one call.
export function makeBox(mat, sx, sy, sz, material = null) {
  const { unitBox, armor } = getRobotMaterials();
  const mesh = new THREE.Mesh(unitBox, material ?? mat ?? armor);
  mesh.scale.set(sx, sy, sz);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// A cylindrical joint/limb segment, oriented along local Y by default.
export function makeCylinder(radiusScale, length, material) {
  const { unitCylinder } = getRobotMaterials();
  const mesh = new THREE.Mesh(unitCylinder, material);
  mesh.scale.set(radiusScale, length, radiusScale);
  mesh.castShadow = true;
  return mesh;
}

export function makeSphere(radius, material) {
  const { unitSphere } = getRobotMaterials();
  const mesh = new THREE.Mesh(unitSphere, material);
  mesh.scale.setScalar(radius * 2);
  mesh.castShadow = true;
  return mesh;
}

// A THREE.Group positioned at `origin` (local space) that everything
// passed as children pivots around -- the standard "joint" pattern used
// throughout both models so animation just sets joint.rotation.
export function makeJoint(origin = [0, 0, 0]) {
  const joint = new THREE.Group();
  joint.position.set(origin[0], origin[1], origin[2]);
  return joint;
}