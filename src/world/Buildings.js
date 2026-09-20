import * as THREE from "three";
import * as CANNON from "cannon-es";

// A small procedural house built from the same primitives the rest of the
// world uses (boxes + a simple roof). Keeps the neighborhood loop from
// feeling like an empty test track.
export function createHouse(scene, physics, terrain, x, z, rotationY = 0) {
  const group = new THREE.Group();
  const y = terrain.heightAt(x, z);

  group.position.set(x, y, z);
  group.rotation.y = rotationY;

  const wallMaterial = new THREE.MeshStandardMaterial({
    color: 0xd8c6a5,
    roughness: 0.85
  });

  const roofMaterial = new THREE.MeshStandardMaterial({
    color: 0x7a3b32,
    roughness: 0.8
  });

  const trimMaterial = new THREE.MeshStandardMaterial({
    color: 0x5c4a3a,
    roughness: 0.7
  });

  const width = 9;
  const depth = 7;
  const wallHeight = 3.2;

  const walls = new THREE.Mesh(
    new THREE.BoxGeometry(width, wallHeight, depth),
    wallMaterial
  );

  walls.position.y = wallHeight / 2;
  walls.castShadow = true;
  walls.receiveShadow = true;
  group.add(walls);

  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(Math.hypot(width, depth) * 0.62, 2.6, 4),
    roofMaterial
  );

  roof.position.y = wallHeight + 1.3;
  roof.rotation.y = Math.PI / 4;
  roof.castShadow = true;
  group.add(roof);

  const door = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 2, 0.15),
    trimMaterial
  );

  door.position.set(0, 1, depth / 2 + 0.08);
  group.add(door);

  // A couple of simple windows for visual interest.
  const windowMaterial = new THREE.MeshStandardMaterial({
    color: 0x9fd3e8,
    roughness: 0.3,
    metalness: 0.1
  });

  for (const side of [-1, 1]) {
    const window = new THREE.Mesh(
      new THREE.BoxGeometry(1.1, 1.1, 0.1),
      windowMaterial
    );

    window.position.set(side * width * 0.28, 1.8, depth / 2 + 0.06);
    group.add(window);
  }

  scene.add(group);

  // Static collision so the house is solid rather than walk/drive-through.
  const body = new CANNON.Body({ mass: 0 });

  body.addShape(new CANNON.Box(new CANNON.Vec3(
    width / 2, wallHeight / 2, depth / 2
  )));

  body.position.set(x, y + wallHeight / 2, z);
  body.quaternion.setFromEuler(0, rotationY, 0);
  body.surface = "asphalt";
  physics.addBody(body);

  return group;
}
