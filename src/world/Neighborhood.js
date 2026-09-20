import * as THREE from "three";
import * as CANNON from "cannon-es";
import { createHouse, createStore } from "./Buildings.js";

// Everything in this module builds out the residential neighborhood
// around the loop + branch streets defined in Roads.js: houses, mailboxes,
// small stores, and low-poly street props (streetlights, fences, trash
// bins, utility poles). Repeated simple props use InstancedMesh (same
// pattern as World.js's tree placement) so adding dozens of them costs a
// handful of draw calls, not dozens.

// Face a group positioned at (fromX, fromZ) toward (toX, toZ), using the
// same convention the original hand-placed house already relied on
// (rotationY = -PI/2 for a house east of the loop center, facing west).
function faceTowards(fromX, fromZ, toX, toZ) {
  return Math.atan2(toX - fromX, toZ - fromZ);
}

function pointAlong(points, t) {
  const lengths = [];
  let total = 0;

  for (let i = 0; i < points.length - 1; i++) {
    const d = Math.hypot(
      points[i + 1].x - points[i].x,
      points[i + 1].z - points[i].z
    );
    lengths.push(d);
    total += d;
  }

  let target = THREE.MathUtils.clamp(t, 0, 1) * total;

  for (let i = 0; i < lengths.length; i++) {
    if (target <= lengths[i] || i === lengths.length - 1) {
      const segT = lengths[i] === 0 ? 0 : target / lengths[i];
      const a = points[i];
      const b = points[i + 1];

      return {
        x: a.x + (b.x - a.x) * segT,
        z: a.z + (b.z - a.z) * segT,
        // Perpendicular to the segment's direction -- used to offset a
        // house/mailbox sideways off the road centerline.
        nx: -(b.z - a.z) / (lengths[i] || 1),
        nz: (b.x - a.x) / (lengths[i] || 1)
      };
    }

    target -= lengths[i];
  }

  return { x: points[0].x, z: points[0].z, nx: 0, nz: 1 };
}

// Simple deterministic PRNG, same algorithm World.js already uses for
// tree placement -- keeps a refresh from reshuffling the neighborhood.
function makeRandom(seed) {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function createNeighborhood(scene, physics, terrain) {
  const random = makeRandom(998877);

  const LOOP_CENTER = { x: 150, z: 35 };
  const LOOP_RX = 30;
  const LOOP_RZ = 28;
  const LOT_SETBACK = 12;

  const branchStreets = [
    [{ x: 150, z: 7 }, { x: 150, z: -6 }, { x: 168, z: -18 }, { x: 190, z: -20 }],
    [{ x: 180, z: 35 }, { x: 192, z: 42 }, { x: 194, z: 58 }],
    [{ x: 128, z: 58 }, { x: 115, z: 72 }, { x: 118, z: 90 }]
  ];

  const houseSpots = []; // { x, z, rotationY, scale }
  const mailboxSpots = []; // { x, z, rotationY }

  // Houses around the neighborhood loop, skipping the arc near angle 0
  // where World.js already places the original hand-placed house
  // (roughly at x=190, z=35).
  const loopAngles = [
    40, 80, 120, 160, 200, 240, 280, 320
  ];

  for (const deg of loopAngles) {
    const angle = THREE.MathUtils.degToRad(deg);
    const roadX = LOOP_CENTER.x + Math.cos(angle) * LOOP_RX;
    const roadZ = LOOP_CENTER.z + Math.sin(angle) * LOOP_RZ;

    // Outward unit-ish normal from the loop center through the road point.
    const nx = Math.cos(angle);
    const nz = Math.sin(angle) * (LOOP_RZ / LOOP_RX);
    const nLen = Math.hypot(nx, nz) || 1;

    const houseX = roadX + (nx / nLen) * LOT_SETBACK;
    const houseZ = roadZ + (nz / nLen) * LOT_SETBACK;

    houseSpots.push({
      x: houseX,
      z: houseZ,
      rotationY: faceTowards(houseX, houseZ, roadX, roadZ),
      scale: 0.9 + random() * 0.35
    });

    mailboxSpots.push({
      x: roadX + (nx / nLen) * (LOT_SETBACK * 0.3),
      z: roadZ + (nz / nLen) * (LOT_SETBACK * 0.3),
      rotationY: faceTowards(roadX, roadZ, houseX, houseZ)
    });
  }

  // Houses along each residential branch street, alternating sides.
  for (const street of branchStreets) {
    const stops = [0.28, 0.6, 0.9];

    stops.forEach((t, index) => {
      if (t > 1) return;

      const { x: roadX, z: roadZ, nx, nz } = pointAlong(street, t);
      const side = index % 2 === 0 ? 1 : -1;

      const houseX = roadX + nx * LOT_SETBACK * side;
      const houseZ = roadZ + nz * LOT_SETBACK * side;

      houseSpots.push({
        x: houseX,
        z: houseZ,
        rotationY: faceTowards(houseX, houseZ, roadX, roadZ),
        scale: 0.9 + random() * 0.35
      });

      mailboxSpots.push({
        x: roadX + nx * LOT_SETBACK * side * 0.3,
        z: roadZ + nz * LOT_SETBACK * side * 0.3,
        rotationY: faceTowards(roadX, roadZ, houseX, houseZ)
      });
    });
  }

  for (const spot of houseSpots) {
    createHouse(scene, physics, terrain, spot.x, spot.z, spot.rotationY, spot.scale);
  }

  // Two small stores near the neighborhood entrance (where the connector
  // road from the main loop feeds into the residential loop), each with a
  // different accent color so they read as separate businesses.
  createStore(
    scene, physics, terrain,
    LOOP_CENTER.x - LOOP_RX - 14, LOOP_CENTER.z - 6,
    faceTowards(LOOP_CENTER.x - LOOP_RX - 14, LOOP_CENTER.z - 6, LOOP_CENTER.x - LOOP_RX, LOOP_CENTER.z - 6),
    0xd65f4a
  );

  createStore(
    scene, physics, terrain,
    LOOP_CENTER.x - LOOP_RX - 14, LOOP_CENTER.z + 10,
    faceTowards(LOOP_CENTER.x - LOOP_RX - 14, LOOP_CENTER.z + 10, LOOP_CENTER.x - LOOP_RX, LOOP_CENTER.z + 10),
    0x4a9dd6
  );

  // ---- Instanced street props -----------------------------------------
  // Every prop type below shares one geometry + material across every
  // instance in the neighborhood; this is the same trade-off World.js
  // already makes for trees, and keeps the richer environment from
  // costing extra draw calls per mailbox/post/light.

  function buildInstanced(count, geometry, material, place) {
    if (count === 0) return null;

    const mesh = new THREE.InstancedMesh(geometry, material, count);
    const transform = new THREE.Object3D();

    for (let i = 0; i < count; i++) {
      place(transform, i);
      transform.updateMatrix();
      mesh.setMatrixAt(i, transform.matrix);
    }

    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    scene.add(mesh);
    return mesh;
  }

  // Mailboxes: a post + a small angled box "body", one per house lot.
  const mailboxPostGeom = new THREE.CylinderGeometry(0.05, 0.05, 0.9, 6);
  const mailboxBoxGeom = new THREE.BoxGeometry(0.35, 0.28, 0.6);
  const mailboxMaterial = new THREE.MeshStandardMaterial({
    color: 0x8a8f96, roughness: 0.6, metalness: 0.2
  });

  buildInstanced(mailboxSpots.length, mailboxPostGeom, mailboxMaterial, (t, i) => {
    const spot = mailboxSpots[i];
    const y = terrain.heightAt(spot.x, spot.z);
    t.position.set(spot.x, y + 0.45, spot.z);
    t.rotation.set(0, spot.rotationY, 0);
  });

  buildInstanced(mailboxSpots.length, mailboxBoxGeom, mailboxMaterial, (t, i) => {
    const spot = mailboxSpots[i];
    const y = terrain.heightAt(spot.x, spot.z);
    t.position.set(spot.x, y + 0.9, spot.z);
    t.rotation.set(0, spot.rotationY, 0);

    // Register a light physics box per mailbox so it's a small obstacle
    // rather than an invisible/drive-through prop.
    const body = new CANNON.Body({ mass: 0 });
    body.addShape(new CANNON.Box(new CANNON.Vec3(0.18, 0.45, 0.3)));
    body.position.set(spot.x, y + 0.45, spot.z);
    body.quaternion.setFromEuler(0, spot.rotationY, 0);
    body.surface = "grass";
    physics.addBody(body);
  });

  // Streetlights along the neighborhood loop -- decorative only (no
  // collision), evenly spaced.
  const lampCount = 10;
  const lampPoleGeom = new THREE.CylinderGeometry(0.09, 0.09, 4.2, 6);
  const lampHeadGeom = new THREE.SphereGeometry(0.28, 8, 6);
  const lampPoleMaterial = new THREE.MeshStandardMaterial({
    color: 0x2c2f33, roughness: 0.7, metalness: 0.3
  });
  const lampHeadMaterial = new THREE.MeshStandardMaterial({
    color: 0xfff2c2, emissive: 0x7a6a2c, roughness: 0.5
  });

  buildInstanced(lampCount, lampPoleGeom, lampPoleMaterial, (t, i) => {
    const angle = (i / lampCount) * Math.PI * 2;
    const x = LOOP_CENTER.x + Math.cos(angle) * (LOOP_RX + 5);
    const z = LOOP_CENTER.z + Math.sin(angle) * (LOOP_RZ + 5);
    const y = terrain.heightAt(x, z);
    t.position.set(x, y + 2.1, z);
  });

  buildInstanced(lampCount, lampHeadGeom, lampHeadMaterial, (t, i) => {
    const angle = (i / lampCount) * Math.PI * 2;
    const x = LOOP_CENTER.x + Math.cos(angle) * (LOOP_RX + 5);
    const z = LOOP_CENTER.z + Math.sin(angle) * (LOOP_RZ + 5);
    const y = terrain.heightAt(x, z);
    t.position.set(x, y + 4.2, z);
  });

  // Low fence segments flanking a few of the house lots -- purely
  // decorative low-poly boxes, no collision (avoids nickel-and-diming the
  // physics world over waist-high fencing).
  const fenceSpots = houseSpots.filter((_, i) => i % 2 === 0);
  const fenceGeom = new THREE.BoxGeometry(2.4, 0.5, 0.1);
  const fenceMaterial = new THREE.MeshStandardMaterial({
    color: 0xcfc2a3, roughness: 0.9
  });

  buildInstanced(fenceSpots.length * 2, fenceGeom, fenceMaterial, (t, i) => {
    const spot = fenceSpots[Math.floor(i / 2)];
    const side = i % 2 === 0 ? -1 : 1;
    const perpX = Math.cos(spot.rotationY);
    const perpZ = -Math.sin(spot.rotationY);
    const x = spot.x + perpX * 3.2 * side;
    const z = spot.z + perpZ * 3.2 * side;
    const y = terrain.heightAt(x, z);

    t.position.set(x, y + 0.25, z);
    t.rotation.set(0, spot.rotationY, 0);
  });

  // Trash bins near a handful of houses.
  const binSpots = houseSpots.filter((_, i) => i % 3 === 1);
  const binGeom = new THREE.CylinderGeometry(0.28, 0.24, 0.6, 8);
  const binMaterial = new THREE.MeshStandardMaterial({
    color: 0x3f6b4a, roughness: 0.8
  });

  buildInstanced(binSpots.length, binGeom, binMaterial, (t, i) => {
    const spot = binSpots[i];
    const x = spot.x + Math.sin(spot.rotationY) * 1.6;
    const z = spot.z + Math.cos(spot.rotationY) * 1.6;
    const y = terrain.heightAt(x, z);
    t.position.set(x, y + 0.3, z);
  });

  // Utility poles set back along the loop, opposite the streetlights so
  // the two alternate rather than stacking at the same spot.
  const poleCount = 8;
  const poleGeom = new THREE.CylinderGeometry(0.12, 0.15, 6, 6);
  const poleMaterial = new THREE.MeshStandardMaterial({
    color: 0x5a4a3a, roughness: 0.95
  });

  buildInstanced(poleCount, poleGeom, poleMaterial, (t, i) => {
    const angle = ((i + 0.5) / poleCount) * Math.PI * 2;
    const x = LOOP_CENTER.x + Math.cos(angle) * (LOOP_RX + 8);
    const z = LOOP_CENTER.z + Math.sin(angle) * (LOOP_RZ + 8);
    const y = terrain.heightAt(x, z);
    t.position.set(x, y + 3, z);
  });
}
