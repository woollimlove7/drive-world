import * as THREE from "three";
import {
  Target,
  createSharedTargetAssets,
  createSharedBossAssets
} from "./Target.js";
import { TARGET_CONFIG, ENEMY_CONFIG } from "./TurretConfig.js";
import { TurretEffectsPool } from "./TurretEffects.js";

// ---------------------------------------------------------------------------
// WORLD BOUNDS
// ---------------------------------------------------------------------------
// Keep enemies well inside the boundary walls.
// World.js walls sit around +-199.
// ---------------------------------------------------------------------------
const WORLD_LIMIT = ENEMY_CONFIG.spawn?.worldLimit ?? 185;

// ---------------------------------------------------------------------------
// SPAWN SEARCH SETTINGS
// ---------------------------------------------------------------------------

const SPAWN_ATTEMPTS = 100;

// ---------------------------------------------------------------------------
// TargetSystem
// ---------------------------------------------------------------------------
// Owns every enemy (normal + boss) rendered by THIS client.
//
// IMPORTANT -- two modes:
//
// 1. Multiplayer connected: this class becomes a pure PRESENTATION layer.
//    Enemy identity, position, HP, alive/dead state, targeting and attack
//    timing are all decided by the authoritative server (see
//    server/EnemyWorld.js) and streamed down as "enemies" messages. This
//    class just creates/updates/removes the local Target visuals to match
//    (see applyServerState()) so that every connected player renders the
//    exact same enemy world -- same IDs, same positions, same HP, same
//    deaths (requirement #5/#6).
//
// 2. Offline/local play (no multiplayer connection): this class falls back
//    to running the original local spawn/AI/attack simulation itself, so
//    the game remains fully playable without a server.
// ---------------------------------------------------------------------------
export class TargetSystem {
  constructor(scene, terrain, roads, playerHealth) {
    this.scene = scene;
    this.terrain = terrain;
    this.roads = roads;
    this.playerHealth = playerHealth;

    // Kept for backward compatibility -- the mechanical models build their
    // own geometry/materials internally (see RobotParts.js) so these no
    // longer carry real assets, but nothing else needs to change.
    this.assets = createSharedTargetAssets();
    this.bossAssets = createSharedBossAssets();

    // Enemy projectile/effect pool.
    this.effectsPool = new TurretEffectsPool(scene);

    this.targets = [];
    this.respawnTimers = [];
    this.elapsed = 0;

    this.bossActive = false;
    this.bossRespawnTimer = ENEMY_CONFIG.boss.initialSpawnDelay;

    // Callbacks used by Game.js.
    this.onEnemyDestroyed = null;
    this.onBossSpawned = null;

    // Callback used by MultiplayerClient to send a turret hit to the
    // server when in networked mode (see applyDamage() below).
    this.onNetworkHit = null;

    // Deterministic random generator.
    this.seed = 908070;

    // -----------------------------------------------------------------------
    // FIXED PLAYER SPAWN
    // -----------------------------------------------------------------------
    // Always use the configured world-space player spawn point.
    //
    // We clone this so the object cannot accidentally be modified by another
    // system.
    // -----------------------------------------------------------------------
    const configuredSpawn = ENEMY_CONFIG.spawn?.protectedSpawnCenter;

    this.playerSpawnCenter = new THREE.Vector3(
      configuredSpawn?.x ?? 0,
      0,
      configuredSpawn?.z ?? 0
    );

    // -----------------------------------------------------------------------
    // SAFE ZONE
    // -----------------------------------------------------------------------
    this.safeZoneRadius =
      ENEMY_CONFIG.spawn?.protectedSpawnRadius ??
      30;

    // -----------------------------------------------------------------------
    // EXTRA SPAWN DISTANCE FROM PLAYER SPAWN
    // -----------------------------------------------------------------------
    //
    // This is deliberately larger than the safe-zone radius.
    //
    // Safe zone:
    //       0 ---------------- 30
    //
    // Enemy minimum:
    //       0 ------------------------------- 75
    //
    // Therefore enemies will never appear immediately outside the safe zone.
    // -----------------------------------------------------------------------
    this.minDistanceFromPlayerSpawn =
      ENEMY_CONFIG.spawn?.minDistanceFromPlayerSpawn ?? 200;

    this.bossMinDistanceFromPlayerSpawn =
      ENEMY_CONFIG.spawn?.bossMinDistanceFromPlayerSpawn ?? 300;

    this.minDistanceBetweenEnemies =
      ENEMY_CONFIG.spawn?.minDistanceBetweenEnemies ?? 14;

    // ------------------------------------------------------------------
    // MULTIPLAYER PRESENTATION MODE
    // ------------------------------------------------------------------
    // When a MultiplayerClient is attached (see Game.js), this system
    // stops running its own local spawn timers/RNG/AI and instead mirrors
    // whatever the authoritative server reports. `byId` lets incoming
    // server updates find/update/remove the matching local Target visual
    // in O(1) instead of a linear scan (requirement #9 -- never create a
    // duplicate when the server reports an enemy we already have).
    // ------------------------------------------------------------------
    this.networked = false;
    this.byId = new Map();
  }

  // Called once by Game.js right after a MultiplayerClient successfully
  // connects. From this point on, update() no longer spawns/simulates
  // anything locally -- see applyServerState().
  enableNetworkedMode() {
    this.networked = true;
    this.clearTargets();
  }

  // Called by Game.js if multiplayer disconnects, so offline play still
  // works (falls back to local simulation rather than leaving the world
  // permanently empty).
  disableNetworkedMode() {
    this.networked = false;
    this.clearTargets();

    // Local sim starts from a clean slate rather than resuming whatever
    // timers happened to be mid-flight before connecting.
    this.respawnTimers.length = 0;
    this.bossActive = false;
    this.bossRespawnTimer = ENEMY_CONFIG.boss.initialSpawnDelay;
  }

  // Disposes every current Target visual without tearing down the shared
  // effects pool/assets -- used when switching between networked and local
  // modes. Full teardown (including the pool) is dispose() below, used only
  // when the whole game/scene is going away.
  clearTargets() {
    for (const target of this.targets) {
      target.dispose();
    }

    this.targets.length = 0;
    this.byId.clear();
  }

  // -------------------------------------------------------------------------
  // APPLY SERVER STATE
  // -------------------------------------------------------------------------
  // `enemies`: array of { id, kind, x, y, z, hp, maxHp, alive, telegraph,
  //            telegraphProgress, fireSeq } from the server's "enemies"
  //            broadcast (see MultiplayerClient.handleMessage).
  //
  // Reconciles the local visual set against it: updates existing Targets by
  // id, creates new ones for ids we haven't seen, and disposes/removes any
  // local Target whose id the server no longer reports (dead & fully
  // despawned, or otherwise gone) -- this is what keeps every client's
  // enemy list free of duplicates and free of "ghost" enemies (requirement
  // #9).
  // -------------------------------------------------------------------------
  applyServerState(enemies, camera, audio) {
    const seen = new Set();

    for (const data of enemies) {
      seen.add(data.id);

      let target = this.byId.get(data.id);

      if (!target) {
        target = new Target(
          this.scene,
          new THREE.Vector3(data.x, data.y, data.z),
          data.kind
        );

        target.id = data.id;
        target.maxHealth = data.maxHp;

        this.byId.set(data.id, target);
        this.targets.push(target);

        if (data.kind === "boss") this.onBossSpawned?.(target);
      }

      target.applyNetworkState(data);
    }

    // Anything previously known but no longer present server-side has
    // despawned/died -- remove the local visual so it doesn't linger.
    for (const [id, target] of this.byId) {
      if (seen.has(id)) continue;

      target.dispose();
      this.byId.delete(id);
    }

    if (this.targets.some(t => t.disposed)) {
      this.targets = this.targets.filter(t => !t.disposed);
    }

    // Drives Game.js's boss HUD element, same flag the local/offline
    // simulation sets for itself.
    this.bossActive = enemies.some(e => e.kind === "boss" && e.alive);
  }

  // -------------------------------------------------------------------------
  // DETERMINISTIC RANDOM
  // -------------------------------------------------------------------------
  random() {
    this.seed =
      (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;

    return this.seed / 4294967296;
  }

  // -------------------------------------------------------------------------
  // DISTANCE FROM PLAYER SPAWN
  // -------------------------------------------------------------------------
  //
  // Uses X/Z only because this is a ground-based spawn check.
  // Y/terrain height should not affect the safe-zone radius.
  // -------------------------------------------------------------------------
  distanceFromPlayerSpawn(x, z) {
    const dx = x - this.playerSpawnCenter.x;
    const dz = z - this.playerSpawnCenter.z;

    return Math.sqrt(dx * dx + dz * dz);
  }

  // -------------------------------------------------------------------------
  // SAFE ZONE CHECK
  // -------------------------------------------------------------------------
  //
  // Returns true if a position is physically inside the protected player
  // spawn area.
  // -------------------------------------------------------------------------
  isInsideProtectedSpawn(x, z) {
    const distance = this.distanceFromPlayerSpawn(x, z);

    return distance < this.safeZoneRadius;
  }

  // -------------------------------------------------------------------------
  // FAR-ENOUGH-FROM-PLAYER-SPAWN CHECK
  // -------------------------------------------------------------------------
  //
  // This is separate from the safe-zone check.
  //
  // An enemy can technically be outside the safe zone but still be too close
  // to the player's spawn. This prevents that.
  // -------------------------------------------------------------------------
  isFarEnoughFromPlayerSpawn(x, z, minimumDistance) {
    const distance = this.distanceFromPlayerSpawn(x, z);

    return distance >= minimumDistance;
  }

  // -------------------------------------------------------------------------
  // FAR-ENOUGH-FROM-CURRENT-PLAYER CHECK
  // -------------------------------------------------------------------------
  //
  // Prevents enemies from spawning directly beside the player while the
  // player is driving around the map.
  //
  // This is particularly important for respawns.
  // -------------------------------------------------------------------------
  isFarEnoughFromPlayer(x, z, center, minimumDistance) {
    if (!center) return true;

    const dx = x - center.x;
    const dz = z - center.z;

    const distanceSquared = dx * dx + dz * dz;

    return distanceSquared >= minimumDistance * minimumDistance;
  }

  // -------------------------------------------------------------------------
  // FIND SPAWN POSITION
  // -------------------------------------------------------------------------
  //
  // `center`
  //     Usually the player's CURRENT position.
  //
  // `minDistance / maxDistance`
  //     Desired distance around the current player.
  //
  // `minimumDistanceFromPlayerSpawn`
  //     Absolute minimum distance from the original player spawn.
  //
  // The candidate must satisfy ALL of the following:
  //
  // 1. Inside world boundary
  // 2. Outside safe zone
  // 3. Far enough from original player spawn
  // 4. Far enough from current player
  // 5. Located on grass
  //
  // -------------------------------------------------------------------------
  findSpawnPosition(
    center,
    minDistance,
    maxDistance,
    minimumDistanceFromPlayerSpawn
  ) {
    const spawnCenter = center ?? this.playerSpawnCenter;

    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
      const angle =
        this.random() * Math.PI * 2;

      const distance =
        minDistance +
        this.random() * (maxDistance - minDistance);

      const x =
        spawnCenter.x +
        Math.cos(angle) * distance;

      const z =
        spawnCenter.z +
        Math.sin(angle) * distance;

      // ---------------------------------------------------------------
      // WORLD BOUNDARY
      // ---------------------------------------------------------------
      if (
        Math.abs(x) > WORLD_LIMIT ||
        Math.abs(z) > WORLD_LIMIT
      ) {
        continue;
      }

      // ---------------------------------------------------------------
      // SAFE ZONE
      // ---------------------------------------------------------------
      if (this.isInsideProtectedSpawn(x, z)) {
        continue;
      }

      // ---------------------------------------------------------------
      // EXTRA DISTANCE FROM ORIGINAL PLAYER SPAWN
      // ---------------------------------------------------------------
      if (
        !this.isFarEnoughFromPlayerSpawn(
          x,
          z,
          minimumDistanceFromPlayerSpawn
        )
      ) {
        continue;
      }

      // ---------------------------------------------------------------
      // DISTANCE FROM CURRENT PLAYER
      // ---------------------------------------------------------------
      if (
        !this.isFarEnoughFromPlayer(
          x,
          z,
          spawnCenter,
          minDistance
        )
      ) {
        continue;
      }

      // ---------------------------------------------------------------
      // ONLY SPAWN ON GRASS
      // ---------------------------------------------------------------
      if (
        !this.roads ||
        this.roads.surfaceAt(x, z) !== "grass"
      ) {
        continue;
      }

      // ---------------------------------------------------------------
      // MINIMUM DISTANCE FROM OTHER ENEMIES
      // ---------------------------------------------------------------
      // Prevents one giant cluster of enemies in a single spot (see
      // requirement #3) -- every existing, still-alive enemy must be at
      // least minDistanceBetweenEnemies away from this candidate.
      // ---------------------------------------------------------------
      const tooCloseToAnotherEnemy = this.targets.some(other =>
        other.alive &&
        Math.hypot(x - other.position.x, z - other.position.z) <
          this.minDistanceBetweenEnemies
      );

      if (tooCloseToAnotherEnemy) {
        continue;
      }

      // ---------------------------------------------------------------
      // TERRAIN HEIGHT
      // ---------------------------------------------------------------
      const y =
        this.terrain.heightAt(x, z) +
        TARGET_CONFIG.hoverHeight;

      return new THREE.Vector3(x, y, z);
    }

    // No valid position was found.
    return null;
  }

  // -------------------------------------------------------------------------
  // SPAWN NORMAL ENEMY
  // -------------------------------------------------------------------------
  spawnOne(center) {
    const position = this.findSpawnPosition(
      center,
      ENEMY_CONFIG.spawn.minDistance,
      ENEMY_CONFIG.spawn.maxDistance,
      this.minDistanceFromPlayerSpawn
    );

    if (!position) {
      return;
    }

    const target = new Target(
      this.scene,
      position,
      "normal"
    );

    this.targets.push(target);
  }

  // -------------------------------------------------------------------------
  // SPAWN BOSS
  // -------------------------------------------------------------------------
  spawnBoss(center) {
    const position = this.findSpawnPosition(
      center,
      ENEMY_CONFIG.spawn.bossMinDistance,
      ENEMY_CONFIG.spawn.bossMaxDistance,
      this.bossMinDistanceFromPlayerSpawn
    );

    if (!position) {
      return;
    }

    const boss = new Target(
      this.scene,
      position,
      "boss"
    );

    this.targets.push(boss);

    this.bossActive = true;

    this.onBossSpawned?.(boss);
  }

  // -------------------------------------------------------------------------
  // UPDATE
  // -------------------------------------------------------------------------
  update(dt, playerPosition, camera, audio) {
    // Multiplayer connected: enemies are driven entirely by
    // applyServerState() (called from MultiplayerClient when an "enemies"
    // message arrives). Still tick cosmetic per-frame animation (bob,
    // ring spin, damage flash, health bar billboarding) so remote-driven
    // enemies don't look frozen between network updates, but never spawn,
    // respawn, or run AI/attack logic locally -- that would risk exactly
    // the per-client divergence requirement #5/#6 rule out.
    if (this.networked) {
      for (const target of this.targets) {
        target.updateCosmetic(dt, this.elapsed, camera, this.effectsPool);
      }

      this.effectsPool.update(dt);
      this.elapsed += dt;
      return;
    }

    this.elapsed += dt;

    const ctx = {
      playerPosition,
      playerDead: this.playerHealth?.dead === true,

      // playerHealth.applyDamage() already no-ops while dead (see
      // PlayerHealth.js), but guarding here too means a dead player
      // strictly never reaches that call in the first place, matching
      // requirement #2's "dead players must not receive damage" at the
      // source rather than relying on a single downstream check.
      applyPlayerDamage: (amount, source) =>
        !this.playerHealth?.dead && this.playerHealth?.applyDamage(amount, source),

      effectsPool: this.effectsPool,

      camera,

      audio,

      // Ground-based melee movement needs to keep enemies' feet glued to
      // terrain height while they chase/roam (see Target.js's _moveToward).
      terrain: this.terrain
    };

    // -----------------------------------------------------------------------
    // UPDATE ALL TARGETS
    // -----------------------------------------------------------------------
    for (const target of this.targets) {
      target.update(
        dt,
        this.elapsed,
        ctx
      );
    }

    // -----------------------------------------------------------------------
    // UPDATE EFFECTS
    // -----------------------------------------------------------------------
    this.effectsPool.update(dt);

    // -----------------------------------------------------------------------
    // REMOVE DISPOSED TARGETS
    // -----------------------------------------------------------------------
    if (this.targets.some(t => t.disposed)) {
      this.targets =
        this.targets.filter(t => !t.disposed);
    }

    // -----------------------------------------------------------------------
    // RESPAWN NORMAL ENEMIES
    // -----------------------------------------------------------------------
    //
    // Respawned enemies go through the exact same safe/far spawn system.
    // -----------------------------------------------------------------------
    for (
      let i = this.respawnTimers.length - 1;
      i >= 0;
      i--
    ) {
      this.respawnTimers[i] -= dt;

      if (this.respawnTimers[i] <= 0) {
        this.respawnTimers.splice(i, 1);

        this.spawnOne(playerPosition);
      }
    }

    // -----------------------------------------------------------------------
    // NORMAL ENEMY COUNT
    // -----------------------------------------------------------------------
    const aliveNormal =
      this.targets.filter(
        t =>
          t.alive &&
          t.kind === "normal"
      ).length;

    const pendingNormal =
      aliveNormal +
      this.respawnTimers.length;

    if (
      pendingNormal <
      ENEMY_CONFIG.maxEnemies
    ) {
      this.spawnOne(playerPosition);
    }

    // -----------------------------------------------------------------------
    // BOSS
    // -----------------------------------------------------------------------
    //
    // Only one boss can exist at a time.
    // -----------------------------------------------------------------------
    if (!this.bossActive) {
      this.bossRespawnTimer -= dt;

      if (this.bossRespawnTimer <= 0) {
        this.spawnBoss(playerPosition);
      }
    }
  }

  // -------------------------------------------------------------------------
  // GET ACTIVE TARGETS
  // -------------------------------------------------------------------------
  getActiveTargets() {
    return this.targets.filter(
      target => target.alive
    );
  }

  // -------------------------------------------------------------------------
  // APPLY DAMAGE
  // -------------------------------------------------------------------------
  //
  // Applies damage and handles target destruction.
  // -------------------------------------------------------------------------
  applyDamage(target, amount) {
    // Multiplayer connected: HP/death are authoritative server-side (see
    // requirement #10). Report the hit to the server instead of mutating
    // HP locally, and let the next "enemies" broadcast (applyServerState)
    // be the thing that actually changes target.health/alive -- this is
    // what keeps every player seeing the exact same HP after damage
    // (requirement #5), rather than each client racing ahead with its own
    // locally-computed value.
    if (this.networked) {
      this.onNetworkHit?.(target.id, amount);

      // A small, purely cosmetic local flash so the shooter gets instant
      // feedback even before the server's confirmation round-trips back --
      // never treated as authoritative (see Target.js's flashTimer usage).
      target.flashTimer = 0.12;

      return false;
    }

    const destroyed =
      target.applyDamage(amount);

    if (destroyed) {
      const kind = target.kind;

      target.dispose();

      if (kind === "boss") {
        this.bossActive = false;

        this.bossRespawnTimer =
          ENEMY_CONFIG.boss.respawnDelay;
      } else {
        this.respawnTimers.push(
          TARGET_CONFIG.respawnDelay
        );
      }

      this.onEnemyDestroyed?.(target);
    }

    return destroyed;
  }

  // -------------------------------------------------------------------------
  // DISPOSE
  // -------------------------------------------------------------------------
  dispose() {
    for (const target of this.targets) {
      target.dispose();
    }

    this.targets.length = 0;

    this.respawnTimers.length = 0;

    this.effectsPool.dispose();
  }
}