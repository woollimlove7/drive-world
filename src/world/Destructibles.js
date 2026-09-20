import * as THREE from "three";
import * as CANNON from "cannon-es";

// A player has to actually be driving into the crate for this, not just
// resting against it -- keeps a parked/idle car from ever triggering it.
const IMPACT_THRESHOLD = 3.5;

const CRATE_SIZE = [1.1, 1.1, 1.1];
const DEBRIS_LIFETIME = 0.9;
const DEBRIS_PER_CRATE = 5;
const DEBRIS_SIZE = 0.32;

// Shared across every crate and every debris piece: nothing here is ever
// mutated per-instance, so nothing here is ever disposed until the whole
// module is torn down (it isn't -- the world lives for the whole session).
function createSharedAssets() {
  const crateGeometry = new THREE.BoxGeometry(...CRATE_SIZE);
  const crateMaterial = new THREE.MeshStandardMaterial({
    color: 0xa9743c,
    roughness: 0.95
  });

  const bandMaterial = new THREE.MeshStandardMaterial({
    color: 0x3d2a1a,
    roughness: 0.9
  });

  const bandGeometry = new THREE.BoxGeometry(1.16, 0.14, 1.16);
  const debrisGeometry = new THREE.BoxGeometry(DEBRIS_SIZE, DEBRIS_SIZE, DEBRIS_SIZE);

  return { crateGeometry, crateMaterial, bandGeometry, bandMaterial, debrisGeometry };
}

// One flying, fading, spinning splinter. Plain kinematics (no physics
// body) since these are purely decorative and short-lived -- adding them
// to cannon-es would mean N more collidable bodies for every destroyed
// crate, for an effect nobody needs physics fidelity from.
class Debris {
  constructor(geometry, baseColor, position) {
    this.material = new THREE.MeshStandardMaterial({
      color: baseColor,
      roughness: 0.95,
      transparent: true
    });

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.position.copy(position);
    this.mesh.castShadow = true;

    const angle = Math.random() * Math.PI * 2;
    const speed = 2 + Math.random() * 3;

    this.velocity = new THREE.Vector3(
      Math.cos(angle) * speed,
      3 + Math.random() * 3,
      Math.sin(angle) * speed
    );

    this.spin = new THREE.Vector3(
      (Math.random() - 0.5) * 10,
      (Math.random() - 0.5) * 10,
      (Math.random() - 0.5) * 10
    );

    this.age = 0;
  }

  update(dt) {
    this.age += dt;

    this.velocity.y -= 9.81 * dt;
    this.mesh.position.addScaledVector(this.velocity, dt);

    this.mesh.rotation.x += this.spin.x * dt;
    this.mesh.rotation.y += this.spin.y * dt;
    this.mesh.rotation.z += this.spin.z * dt;

    const life = 1 - this.age / DEBRIS_LIFETIME;
    this.material.opacity = Math.max(0, life);

    return this.age < DEBRIS_LIFETIME;
  }

  dispose(scene) {
    scene.remove(this.mesh);
    // Geometry is shared (see createSharedAssets) -- only this instance's
    // own material clone needs disposing.
    this.material.dispose();
  }
}

class Crate {
  constructor(scene, physics, assets, position) {
    this.scene = scene;
    this.physics = physics;
    this.assets = assets;
    this.destroyed = false;

    this.group = new THREE.Group();
    this.group.position.copy(position);

    const box = new THREE.Mesh(assets.crateGeometry, assets.crateMaterial);
    box.castShadow = true;
    box.receiveShadow = true;
    this.group.add(box);

    const band = new THREE.Mesh(assets.bandGeometry, assets.bandMaterial);
    band.castShadow = true;
    this.group.add(band);

    scene.add(this.group);

    this.body = new CANNON.Body({ mass: 0 });
    this.body.addShape(new CANNON.Box(new CANNON.Vec3(
      CRATE_SIZE[0] / 2, CRATE_SIZE[1] / 2, CRATE_SIZE[2] / 2
    )));
    this.body.position.copy(position);
    this.body.surface = "asphalt";

    // Read by Game.js's existing vehicle "collide" listener. Keeping the
    // hook on the body itself means Game doesn't need to know destructible
    // objects exist as a concept, and World doesn't need to expose its
    // internal Crate class to Game.
    this.body.onImpact = impactSpeed => this.tryDestroy(impactSpeed);

    physics.addBody(this.body);
  }

  tryDestroy(impactSpeed) {
    // Called synchronously from Game.js's vehicle "collide" listener, which
    // fires *during* physics.step() (inside cannon-es's internalStep, mid
    // contact-processing). internalStep caches the world's body count once
    // at the top of the step and reuses it in several loops that run later
    // in that same step (wake-up, damping, integrate). Removing a body here
    // -- physics.removeBody() shrinks the live bodies array immediately --
    // leaves those later loops indexing past the array's new (shorter)
    // length, so `bodies[i]` comes back `undefined` and the next call on it
    // throws, killing the frame's requestAnimationFrame loop entirely. Only
    // flag the crate as destroyed here; the actual body/mesh removal is
    // deferred to Destructibles.update(), which Game.js calls once per
    // frame *after* physics.step() has fully returned (see Game.js's main
    // loop), where removing a body is safe.
    if (this.destroyed || impactSpeed < IMPACT_THRESHOLD) return;
    this.destroyed = true;

    return true;
  }

  // Called from Destructibles.update(), outside of physics.step() -- safe
  // to mutate the physics world and scene graph here.
  remove() {
    this.physics.removeBody(this.body);
    this.scene.remove(this.group);
  }
}

// Manages every crate's lifecycle plus the currently-flying debris. A
// single flat array of debris (rather than one per crate) keeps the
// per-frame update loop trivial regardless of how many crates exist.
export class Destructibles {
  constructor(scene, physics) {
    this.scene = scene;
    this.physics = physics;
    this.assets = createSharedAssets();
    this.crates = [];
    this.debris = [];
  }

  spawnCrate(position) {
    this.crates.push(new Crate(this.scene, this.physics, this.assets, position));
  }

  update(dt) {
    for (const crate of this.crates) {
      if (crate.destroyed && !crate.debrisSpawned) {
        crate.debrisSpawned = true;
        // Safe here: this runs after physics.step() has fully returned for
        // the frame (see Game.js), unlike tryDestroy() above.
        crate.remove();
        this.spawnDebris(crate.group.position);
      }
    }

    // Iterate backwards so mid-loop removal (splice) never skips an entry.
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const piece = this.debris[i];

      if (!piece.update(dt)) {
        piece.dispose(this.scene);
        this.debris.splice(i, 1);
      }
    }
  }

  spawnDebris(position) {
    for (let i = 0; i < DEBRIS_PER_CRATE; i++) {
      const piece = new Debris(
        this.assets.debrisGeometry,
        this.assets.crateMaterial.color,
        position
      );

      this.scene.add(piece.mesh);
      this.debris.push(piece);
    }
  }
}

export function createDestructibles(scene, physics, terrain, roads) {
  const destructibles = new Destructibles(scene, physics);

  // A cluster of crates just off the road near the starting area -- easy
  // for a player to find and bump into without hunting the whole map.
  const spots = [
    [6, -26], [8, -23], [4, -23], [10, -20], [6, -20],
    [-8, -26], [-6, -23], [-10, -20]
  ];

  for (const [x, z] of spots) {
    if (roads.surfaceAt(x, z) !== "grass") continue;

    const y = terrain.heightAt(x, z) + CRATE_SIZE[1] / 2;
    destructibles.spawnCrate(new THREE.Vector3(x, y, z));
  }

  return destructibles;
}
