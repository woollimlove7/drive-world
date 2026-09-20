import * as THREE from "three";
import * as CANNON from "cannon-es";

import { createTerrain } from "./Terrain.js";
import { createRoads } from "./Roads.js";
import { createHouse } from "./Buildings.js";
import { createDestructibles } from "./Destructibles.js";

export function createWorld(scene, physics) {
  scene.background = new THREE.Color("#a8cee3");
  scene.fog = new THREE.Fog("#a8cee3", 100, 320);

  scene.add(new THREE.HemisphereLight(
    0xd9f1ff,
    0x536348,
    2.2
  ));

  const sun = new THREE.DirectionalLight(0xfff1da, 2.7);
  sun.position.set(35, 65, 25);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);

  Object.assign(sun.shadow.camera, {
    left: -140,
    right: 140,
    top: 140,
    bottom: -140,
    near: 1,
    far: 260
  });

  sun.shadow.bias = -0.0005;
  scene.add(sun);

  const terrain = createTerrain(scene, physics);
  const roads = createRoads(scene, terrain);

  function solidBox(size, position, color, slope = 0) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(...size),
      new THREE.MeshStandardMaterial({
        color,
        roughness: 0.9
      })
    );

    mesh.position.set(...position);
    mesh.rotation.x = slope;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);

    const body = new CANNON.Body({ mass: 0 });

    body.addShape(new CANNON.Box(new CANNON.Vec3(
      size[0] / 2,
      size[1] / 2,
      size[2] / 2
    )));

    body.position.set(...position);
    body.quaternion.setFromEuler(slope, 0, 0);
    body.surface = "asphalt";
    physics.addBody(body);
  }

  // Original suspension ramp, moved clear of the main road.
  solidBox([6, 0.4, 12], [19, 1, 10], 0x9a7951, -0.15);

  for (let i = 0; i < 6; i++) {
    solidBox([2, 1, 2], [10 + i * 4, 0.5, -32], 0xd7b16c);
  }

  // Visible boundaries prevent driving beyond the finite heightfield.
  solidBox([2, 20, 400], [-199, 8, 0], 0x596955);
  solidBox([2, 20, 400], [199, 8, 0], 0x596955);
  solidBox([400, 20, 2], [0, 8, -199], 0x596955);
  solidBox([400, 20, 2], [0, 8, 199], 0x596955);

  // House on the neighborhood loop, just outside the road so it doesn't
  // block the drivable circuit, and well inside the boundary walls.
  createHouse(scene, physics, terrain, 190, 35, -Math.PI / 2);

  // Deterministic placement: refreshes keep scenery in the same places.
  let seed = 123456;

  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const placements = [];

  for (let attempt = 0; attempt < 4500 && placements.length < 420; attempt++) {
    const x = (random() - 0.5) * 380;
    const z = (random() - 0.5) * 380;

    if (Math.abs(x) < 26) continue;
    if (roads.surfaceAt(x, z) !== "grass") continue;

    // Keep trunks and foliage away from road edges.
    const clear = [
      [3, 0], [-3, 0], [0, 3], [0, -3]
    ].every(([dx, dz]) =>
      roads.surfaceAt(x + dx, z + dz) === "grass"
    );

    if (!clear) continue;

    placements.push({
      x,
      z,
      y: terrain.heightAt(x, z),
      scale: 0.8 + random() * 0.6
    });
  }

  const trunks = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.15, 0.2, 2, 6),
    new THREE.MeshStandardMaterial({ color: 0x6c513c }),
    placements.length
  );

  const crowns = new THREE.InstancedMesh(
    new THREE.ConeGeometry(1.4, 3.8, 7),
    new THREE.MeshStandardMaterial({
      color: 0x355d3d,
      roughness: 1
    }),
    placements.length
  );

  const transform = new THREE.Object3D();

  placements.forEach((tree, index) => {
    transform.scale.setScalar(tree.scale);
    transform.position.set(
      tree.x,
      tree.y + tree.scale,
      tree.z
    );
    transform.updateMatrix();
    trunks.setMatrixAt(index, transform.matrix);

    transform.position.y = tree.y + tree.scale * 3;
    transform.updateMatrix();
    crowns.setMatrixAt(index, transform.matrix);

    // Simple trunk collision; foliage is decorative.
    const body = new CANNON.Body({ mass: 0 });

    body.addShape(new CANNON.Box(new CANNON.Vec3(
      0.18 * tree.scale,
      tree.scale,
      0.18 * tree.scale
    )));

    body.position.set(
      tree.x,
      tree.y + tree.scale,
      tree.z
    );

    body.surface = "grass";
    physics.addBody(body);
  });

  trunks.instanceMatrix.needsUpdate = true;
  crowns.instanceMatrix.needsUpdate = true;
  trunks.castShadow = true;
  crowns.castShadow = true;

  scene.add(trunks, crowns);

  const destructibles = createDestructibles(scene, physics, terrain, roads);

  return { terrain, roads, destructibles };
}
