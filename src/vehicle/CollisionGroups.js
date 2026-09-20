import * as CANNON from "cannon-es";

// Shared cannon-es collision filter bits.
//
// Why this exists: remote players are visual-only (interpolated from
// network snapshots) and were previously not part of the physics world at
// all ("Remote cars are non-colliding"). Giving them a kinematic body lets
// the local player's car bump into other players, but that body must not
// be allowed to interfere with the local RaycastVehicle's downward wheel
// rays (which by default test against every body in the world) or the
// local car would get phantom "ground" contact whenever it got close to
// another player. Explicit groups keep that separation without touching
// cannon-es internals.
export const COLLISION_GROUPS = {
  // Terrain, roads, buildings, boundary walls, trees, destructibles.
  // Left at cannon-es's own default (group 1) so no existing static body
  // needs to be touched.
  WORLD: 1,
  // The local player's own dynamic chassis body.
  VEHICLE: 2,
  // Other players' kinematic proxy bodies.
  REMOTE: 4
};

// Dedicated cannon-es Materials (not to be confused with THREE materials)
// for the car-vs-car contact only. Keeping these separate from the
// default material used by terrain/buildings/trees means tuning
// restitution/friction here can't change how the car already feels when
// it hits existing static scenery.
export const VEHICLE_CANNON_MATERIAL = new CANNON.Material("vehicle");
export const REMOTE_VEHICLE_CANNON_MATERIAL = new CANNON.Material("remoteVehicle");

// Low restitution and moderate friction: cars should stop against each
// other, not bounce or fling apart.
export const VEHICLE_VEHICLE_CONTACT = new CANNON.ContactMaterial(
  VEHICLE_CANNON_MATERIAL,
  REMOTE_VEHICLE_CANNON_MATERIAL,
  {
    friction: 0.35,
    restitution: 0.05,
    contactEquationStiffness: 1e7,
    contactEquationRelaxation: 4
  }
);
