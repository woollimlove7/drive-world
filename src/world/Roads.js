import * as THREE from "three";
import { buildRoadRoutes, surfaceAt as classifySurfaceAt } from "./WorldGeometry.js";

export function createRoads(scene, terrain) {
  const routes = [];

  function addRoute(points, width, surface, color) {
    const route = { points, width, surface };
    routes.push(route);

    const vertices = [];
    const indices = [];

    points.forEach((point, index) => {
      const previous = points[Math.max(0, index - 1)];
      const next = points[Math.min(points.length - 1, index + 1)];

      const dx = next.x - previous.x;
      const dz = next.z - previous.z;
      const length = Math.hypot(dx, dz) || 1;

      const nx = -dz / length;
      const nz = dx / length;

      for (const side of [-1, 1]) {
        const x = point.x + nx * width * 0.5 * side;
        const z = point.z + nz * width * 0.5 * side;

        vertices.push(x, terrain.heightAt(x, z) + 0.035, z);
      }

      if (index < points.length - 1) {
        const a = index * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(vertices, 3)
    );
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({
        color,
        roughness: 1,
        side: THREE.DoubleSide
      })
    );

    mesh.receiveShadow = true;
    scene.add(mesh);
  }

  // Route point generation itself lives in WorldGeometry.js (shared with
  // the server -- see that file's header comment); this just draws them.
  for (const route of buildRoadRoutes()) {
    addRoute(route.points, route.width, route.surface, route.color);
  }

  // Flat test pad covering the existing spawn location.
  const pad = new THREE.Mesh(
    new THREE.PlaneGeometry(44, 34),
    new THREE.MeshStandardMaterial({
      color: 0x353d44,
      roughness: 1
    })
  );

  pad.rotation.x = -Math.PI / 2;
  pad.position.set(0, 0.04, -65);
  pad.receiveShadow = true;
  scene.add(pad);

  for (let z = -85; z <= 85; z += 10) {
    const stripe = new THREE.Mesh(
      new THREE.PlaneGeometry(0.15, 4),
      new THREE.MeshStandardMaterial({ color: 0xf0ead2 })
    );

    stripe.rotation.x = -Math.PI / 2;
    stripe.position.set(0, 0.06, z);
    scene.add(stripe);
  }

  // classifySurfaceAt (WorldGeometry.js) implements the exact same
  // "later-painted routes win" search this used to do inline -- kept as a
  // single shared implementation so the server's grass/asphalt/dirt
  // classification for enemy spawn validation can never drift from what's
  // actually drawn here.
  terrain.body.surfaceAt = point => classifySurfaceAt(point.x, point.z);

  return { surfaceAt: classifySurfaceAt };
}