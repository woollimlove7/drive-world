// ---------------------------------------------------------------------------
// Pure-math world geometry helpers.
//
// Deliberately has ZERO dependency on three.js/cannon-es so this same file
// can be imported both by the browser client (Terrain.js / Roads.js use it
// to build the visible/collidable world) AND by the authoritative
// multiplayer server (server/server.js / server/EnemyWorld.js), which runs
// as a plain Node process with no rendering libraries loaded.
//
// The server needs to know the same terrain height and road/grass surface
// classification the client uses so that authoritative enemy spawn points
// are valid (on grass, outside the safe zone, inside world bounds) for
// every connected client -- if client and server disagreed here, an enemy
// could spawn "inside a building" or "underwater" for some players.
// ---------------------------------------------------------------------------

export const WORLD_SIZE = 400;
export const WORLD_HALF = WORLD_SIZE / 2;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(x, edge0, edge1) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// Matches Terrain.js's `hillHeight` exactly -- the terrain collision mesh
// is just this function sampled onto a heightfield grid, so evaluating it
// directly (rather than re-deriving a heightfield) is both simpler and
// exact for any x/z, not just grid points.
export function hillHeight(x, z) {
  const fade = smoothstep(Math.abs(x), 150, 195);

  return fade * (
    3.5 +
    Math.sin(x * 0.06) * 2 +
    Math.cos(z * 0.07) * 1.5 +
    Math.sin((x + z) * 0.035)
  );
}

export function heightAt(x, z) {
  return hillHeight(x, z);
}

// ---------------------------------------------------------------------------
// ROAD ROUTES
// ---------------------------------------------------------------------------
// Same point generation Roads.js used to build inline. Centralized here so
// the visual mesh builder (Roads.js) and the surface classifier below can
// never drift apart, and so the server can classify grass/asphalt/dirt at
// any (x, z) without needing three.js.
// ---------------------------------------------------------------------------
export function buildRoadRoutes() {
  const routes = [];

  const straight = [];
  for (let z = -170; z <= 170; z += 2) {
    straight.push({ x: 0, z });
  }
  routes.push({ points: straight, width: 12, surface: "asphalt", color: 0x353d44 });

  const loop = [];
  for (let i = 0; i <= 160; i++) {
    const angle = (i / 160) * Math.PI * 2;
    loop.push({ x: Math.sin(angle) * 36, z: Math.cos(angle) * 70 });
  }
  routes.push({ points: loop, width: 8, surface: "asphalt", color: 0x394148 });

  const dirt = [];
  for (let i = 0; i <= 100; i++) {
    const t = i / 100;
    dirt.push({ x: 35 + Math.sin(t * Math.PI) * 40, z: -65 + t * 130 });
  }
  routes.push({ points: dirt, width: 6, surface: "dirt", color: 0xa5875c });

  const crossNorth = [];
  for (let x = -170; x <= 170; x += 2) {
    crossNorth.push({ x, z: 100 });
  }
  routes.push({ points: crossNorth, width: 10, surface: "asphalt", color: 0x3a424a });

  const crossSouth = [];
  for (let x = -150; x <= 150; x += 2) {
    crossSouth.push({ x, z: -130 });
  }
  routes.push({ points: crossSouth, width: 10, surface: "asphalt", color: 0x3a424a });

  const connector = [];
  for (let i = 0; i <= 120; i++) {
    const t = i / 120;
    connector.push({ x: 36 + t * 114, z: Math.sin(t * Math.PI) * 45 + t * 10 });
  }
  routes.push({ points: connector, width: 8, surface: "asphalt", color: 0x3a424a });

  const neighborhood = [];
  for (let i = 0; i <= 120; i++) {
    const angle = (i / 120) * Math.PI * 2;
    neighborhood.push({ x: 150 + Math.cos(angle) * 30, z: 35 + Math.sin(angle) * 28 });
  }
  routes.push({ points: neighborhood, width: 7, surface: "asphalt", color: 0x3f474e });

  return routes;
}

const ROAD_ROUTES = buildRoadRoutes();

function distanceToSegment(x, z, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSquared = dx * dx + dz * dz;

  const t = lengthSquared === 0 ? 0 : clamp(
    ((x - a.x) * dx + (z - a.z) * dz) / lengthSquared,
    0,
    1
  );

  return Math.hypot(x - (a.x + t * dx), z - (a.z + t * dz));
}

// Matches Roads.js's flat test pad covering the spawn location.
export function surfaceAt(x, z) {
  if (Math.abs(x) <= 22 && Math.abs(z + 65) <= 17) {
    return "asphalt";
  }

  for (let r = ROAD_ROUTES.length - 1; r >= 0; r--) {
    const route = ROAD_ROUTES[r];

    for (let i = 0; i < route.points.length - 1; i++) {
      if (
        distanceToSegment(x, z, route.points[i], route.points[i + 1]) <=
        route.width / 2
      ) {
        return route.surface;
      }
    }
  }

  return "grass";
}
