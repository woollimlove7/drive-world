import * as THREE from "three";
import * as CANNON from "cannon-es";
import { hillHeight, WORLD_SIZE } from "./WorldGeometry.js";

export function createTerrain(scene, physics) {
  const size = WORLD_SIZE;
  const divisions = 200;
  const step = size / divisions;
  const half = size / 2;

  const data = [];

  // hillHeight() lives in WorldGeometry.js -- shared with the server (see
  // that file's header comment) so authoritative enemy spawn placement
  // samples the exact same terrain every client renders.
  for (let i = 0; i <= divisions; i++) {
    data[i] = [];

    for (let j = 0; j <= divisions; j++) {
      const x = -half + i * step;
      const z = half - j * step;
      data[i][j] = hillHeight(x, z);
    }
  }

  const shape = new CANNON.Heightfield(data, {
    elementSize: step
  });

  const body = new CANNON.Body({ mass: 0 });
  body.addShape(shape);
  body.position.set(-half, 0, half);
  body.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  body.surface = "grass";

  physics.addBody(body);

  const positions = [];
  const indices = [];

  for (let i = 0; i <= divisions; i++) {
    for (let j = 0; j <= divisions; j++) {
      positions.push(
        -half + i * step,
        data[i][j],
        half - j * step
      );
    }
  }

  const stride = divisions + 1;

  for (let i = 0; i < divisions; i++) {
    for (let j = 0; j < divisions; j++) {
      const a = i * stride + j;
      const b = (i + 1) * stride + j;
      const c = a + 1;
      const d = b + 1;

      // Match the heightfield cell diagonal.
      indices.push(a, b, c, b, d, c);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3)
  );
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      color: 0x78995b,
      roughness: 1
    })
  );

  mesh.receiveShadow = true;
  scene.add(mesh);

  return {
    body,
    size,
    heightAt(x, z) {
      const localX = THREE.MathUtils.clamp(x + half, 0, size - 0.001);
      const localY = THREE.MathUtils.clamp(half - z, 0, size - 0.001);

      // Use the collider's triangle interpolation for visual placement.
      return shape.getHeightAt(localX, localY, true);
    }
  };
}