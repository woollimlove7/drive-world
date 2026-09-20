import * as THREE from "three";
import * as CANNON from "cannon-es";

// ---------------------------------------------------------------------------
// Safe-zone charging station.
//
// Built from the same primitive-mesh + CANNON.Body style already used
// throughout world/World.js and world/Buildings.js -- no new asset
// pipeline, no external dependencies.
//
// "Safe zone" in this project is not a placed structure -- it's a radius
// check around a fixed world point (see turret/TurretConfig.js's
// ENEMY_CONFIG.spawn.protectedSpawnCenter/protectedSpawnRadius, consumed by
// turret/TargetSystem.js's isInSafeZone-style distance check). The charging
// zone below reuses that exact technique (a plain distance check against a
// fixed world position) instead of introducing a new trigger/collision
// system.
//
// Placement: (0, -77) sits on Roads.js's existing flat asphalt "test pad"
// (centered (0,-65), 44x34 -- z range roughly -82..-48, x range -22..22)
// and is comfortably clear of every entry in VehiclePhysics.js's
// SPAWN_POINTS (closest is ~12m away, more than a car length), and well
// inside the safe zone (protectedSpawnCenter (-3,-65), radius 35 -- this
// point is ~12.4 units from that center).
// ---------------------------------------------------------------------------

export const CHARGING_STATION_CONFIG = {
  position: { x: 0, z: -77 },

  // Circular charging zone radius, in world units. A vehicle counts as
  // "in the zone" when its distance from `position` (on the ground plane)
  // is within this radius -- same distance-check technique as the
  // existing safe-zone radius, not a new system.
  zoneRadius: 5.5
};

export function createChargingStation(
  scene,
  physics,
  terrain,
  config = CHARGING_STATION_CONFIG
) {
  const { x, z } = config.position;
  const y = terrain.heightAt(x, z);

  const group = new THREE.Group();
  group.position.set(x, y, z);
  scene.add(group);

  // ---- Green charging area (the important gameplay element) -------------
  // A simple emissive-tinted circular decal on the ground, easy to read at
  // a glance -- matches the flat "test pad" style already used in
  // Roads.js (a plane offset slightly above the terrain to avoid z-
  // fighting) rather than inventing a new ground-marking technique.
  const zoneMesh = new THREE.Mesh(
    new THREE.CircleGeometry(config.zoneRadius, 32),
    new THREE.MeshStandardMaterial({
      color: 0x2ee672,
      emissive: 0x0f6b34,
      emissiveIntensity: 0.9,
      roughness: 0.7,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide
    })
  );

  zoneMesh.rotation.x = -Math.PI / 2;
  zoneMesh.position.y = 0.045;
  zoneMesh.receiveShadow = true;
  group.add(zoneMesh);

  // A brighter ring at the zone's edge so the boundary itself is legible,
  // not just the fill.
  const zoneRing = new THREE.Mesh(
    new THREE.RingGeometry(config.zoneRadius - 0.18, config.zoneRadius, 40),
    new THREE.MeshStandardMaterial({
      color: 0x8dffc0,
      emissive: 0x3ddc84,
      emissiveIntensity: 1.4,
      roughness: 0.5,
      side: THREE.DoubleSide
    })
  );

  zoneRing.rotation.x = -Math.PI / 2;
  zoneRing.position.y = 0.05;
  group.add(zoneRing);

  // ---- Charger station prop ----------------------------------------------
  // Kept deliberately simple (per the brief) and offset to the zone's back
  // edge so it reads as "the thing you park in front of" without blocking
  // the drivable area of the green pad itself.
  const stationOffset = new THREE.Vector3(0, 0, -(config.zoneRadius - 1.1));

  const baseMaterial = new THREE.MeshStandardMaterial({
    color: 0x3a4750,
    roughness: 0.6,
    metalness: 0.3
  });

  const accentMaterial = new THREE.MeshStandardMaterial({
    color: 0x1f2933,
    roughness: 0.5,
    metalness: 0.4
  });

  const glowMaterial = new THREE.MeshStandardMaterial({
    color: 0x6dffb0,
    emissive: 0x3ddc84,
    emissiveIntensity: 1.6,
    roughness: 0.3
  });

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.65, 0.25, 12),
    accentMaterial
  );
  base.position.set(stationOffset.x, 0.125, stationOffset.z);
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.2, 2.1, 10),
    baseMaterial
  );
  pole.position.set(stationOffset.x, 1.25, stationOffset.z);
  pole.castShadow = true;
  group.add(pole);

  // Glowing charging coil/head on top -- a simple torus reads clearly as
  // "charger" without needing custom geometry.
  const coil = new THREE.Mesh(
    new THREE.TorusGeometry(0.32, 0.09, 10, 20),
    glowMaterial
  );
  coil.position.set(stationOffset.x, 2.35, stationOffset.z);
  coil.rotation.x = Math.PI / 2;
  group.add(coil);

  // Small point light so the station reads at night/in shadow without
  // relying purely on emissive material.
  const glowLight = new THREE.PointLight(0x4be3a0, 1.1, 7, 2);
  glowLight.position.set(stationOffset.x, 2.35, stationOffset.z);
  group.add(glowLight);

  // A couple of short bollards around the pad edge, purely decorative,
  // to reinforce "this area is interactive" at a glance.
  const bollardMaterial = new THREE.MeshStandardMaterial({
    color: 0x2ee672,
    emissive: 0x1a7a44,
    emissiveIntensity: 0.8,
    roughness: 0.5
  });

  const bollardAngles = [0.35, 1.05, 1.95, 2.65, 3.4, 4.1, 5.05, 5.85];
  for (const angle of bollardAngles) {
    const bx = Math.sin(angle) * (config.zoneRadius - 0.3);
    const bz = Math.cos(angle) * (config.zoneRadius - 0.3);

    const bollard = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.09, 0.45, 8),
      bollardMaterial
    );
    bollard.position.set(bx, 0.225, bz);
    bollard.castShadow = true;
    group.add(bollard);
  }

  // ---- Static collision, pole only ---------------------------------------
  // Only the charger prop itself is solid (matches World.js/Buildings.js's
  // existing pattern of small static CANNON.Box colliders for props) --
  // the green pad stays fully drivable, which is the whole point.
  const poleBody = new CANNON.Body({ mass: 0 });
  poleBody.addShape(new CANNON.Cylinder(0.4, 0.5, 2.2, 10));
  poleBody.position.set(
    x + stationOffset.x,
    y + 1.1,
    z + stationOffset.z
  );
  poleBody.surface = "asphalt";
  physics.addBody(poleBody);

  // ---- Charging feedback (coil pulse + energy particles) -----------------
  // Purely cosmetic, driven by update(dt, charging, carPosition) below.
  // Everything here is allocated once, right now, and only ever mutated
  // per frame -- no new geometries/materials while charging is active.
  const baseCoilEmissive = glowMaterial.emissiveIntensity;
  const baseZoneRingEmissive = zoneRing.material.emissiveIntensity;
  const baseGlowLightIntensity = glowLight.intensity;

  const coilWorldPos = new THREE.Vector3(
    x + stationOffset.x, y + 2.35, z + stationOffset.z
  );

  const PARTICLE_COUNT = 6;
  const particleGeometry = new THREE.SphereGeometry(0.07, 8, 8);
  const particleMaterial = new THREE.MeshBasicMaterial({
    color: 0x9dffdb,
    transparent: true,
    opacity: 0,
    depthWrite: false
  });

  const particlesGroup = new THREE.Group();
  scene.add(particlesGroup);

  const particles = [];
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const mesh = new THREE.Mesh(particleGeometry, particleMaterial.clone());
    mesh.visible = false;
    particlesGroup.add(mesh);
    particles.push({ mesh, t: i / PARTICLE_COUNT });
  }

  let chargeAnimTime = 0;

  const zoneWorldPosition = new THREE.Vector2(x, z);
  const scratch = new THREE.Vector2();

  return {
    group,
    position: { x, y, z },
    radius: config.zoneRadius,

    // Accepts a CANNON.Vec3, THREE.Vector3, or {x,z} -- only the ground
    // plane (x/z) matters, matching the existing safe-zone radius check's
    // "Y/terrain height should not affect the safe-zone radius" convention
    // (see TargetSystem.js).
    isInZone(pointLike) {
      scratch.set(pointLike.x, pointLike.z);
      return scratch.distanceTo(zoneWorldPosition) <= config.zoneRadius;
    },

    // Call once per rendered frame (not per physics substep -- this is
    // pure visual feedback) while the vehicle may be charging. carPosition
    // is only needed while charging is true; pass null/undefined
    // otherwise. Makes it obvious at a glance that "my car is charging
    // right now": the coil brightens and pulses, and a handful of small
    // energy particles travel from the coil toward the vehicle.
    update(dt, charging, carPosition) {
      const step = Math.max(0, Math.min(0.1, Number.isFinite(dt) ? dt : 0));
      chargeAnimTime += step;

      const pulse = charging
        ? Math.sin(chargeAnimTime * 6) * 0.5 + 0.5
        : 0;

      glowMaterial.emissiveIntensity = baseCoilEmissive + (charging ? pulse * 1.3 : 0);
      glowLight.intensity = baseGlowLightIntensity + (charging ? pulse * 1.1 : 0);
      zoneRing.material.emissiveIntensity =
        baseZoneRingEmissive + (charging ? pulse * 0.8 : 0);

      for (const particle of particles) {
        if (!charging || !carPosition) {
          particle.mesh.visible = false;
          continue;
        }

        particle.t = (particle.t + step * 0.55) % 1;
        particle.mesh.visible = true;
        particle.mesh.position.lerpVectors(coilWorldPos, carPosition, particle.t);
        particle.mesh.position.y += Math.sin(particle.t * Math.PI) * 0.3 + 0.2;
        particle.mesh.material.opacity = (1 - particle.t) * 0.85;
      }
    }
  };
}