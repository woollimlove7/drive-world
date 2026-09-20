// ---------------------------------------------------------------------------
// EnemyWorld -- the single authoritative source of truth for every enemy
// in the game (requirement #6).
//
// MECHANICAL ENEMY + BOSS OVERHAUL: enemies are now ground-based melee
// mechanical units (see src/turret/Target.js for the client-side/offline
// mirror of this exact state machine, and src/turret/TurretConfig.js's
// ENEMY_CONFIG for every tunable both sides read). The boss additionally
// has a rocket-launcher special attack with a server-locked telegraph
// position, broadcast to every client so the red warning circle is
// perfectly in sync (requirement #5/#6).
//
// This runs ONCE, on the server, for every connected player at once -- not
// once per client -- so every player necessarily sees the same enemy IDs,
// positions, HP, states, and deaths. Clients only render whatever this
// reports (see Target.applyNetworkState on the client).
// ---------------------------------------------------------------------------

import { heightAt, surfaceAt, clamp } from "../src/world/WorldGeometry.js";
import { stepAngle } from "../src/turret/TurretMath.js";
import { ENEMY_CONFIG, TARGET_CONFIG } from "../src/turret/TurretConfig.js";

const SPAWN_ATTEMPTS = 100;
const HOVER_HEIGHT = TARGET_CONFIG.hoverHeight;
const WORLD_LIMIT = ENEMY_CONFIG.spawn?.worldLimit ?? 185;
const MIN_DISTANCE_FROM_PLAYER_SPAWN = ENEMY_CONFIG.spawn?.minDistanceFromPlayerSpawn ?? 200;
const BOSS_MIN_DISTANCE_FROM_PLAYER_SPAWN = ENEMY_CONFIG.spawn?.bossMinDistanceFromPlayerSpawn ?? 300;
const MIN_DISTANCE_BETWEEN_ENEMIES = ENEMY_CONFIG.spawn?.minDistanceBetweenEnemies ?? 14;
const PLAYER_SPAWN_CENTER = {
  x: ENEMY_CONFIG.spawn?.protectedSpawnCenter?.x ?? 0,
  z: ENEMY_CONFIG.spawn?.protectedSpawnCenter?.z ?? 0
};
const SAFE_ZONE_RADIUS = ENEMY_CONFIG.spawn?.protectedSpawnRadius ?? 30;

// How long a dead enemy stays in the broadcast list (with alive:false)
// before being fully removed -- gives every client one guaranteed frame to
// play the death animation before the id disappears (see
// Target.js#applyNetworkState / TargetSystem.applyServerState).
const CORPSE_LINGER_SECONDS = 1.1;

const AI_STATE = {
  IDLE: "idle",
  CHASE: "chase",
  ATTACK: "attack",
  RETURN: "return",
  ROCKET: "rocket"
};

export class EnemyWorld {
  constructor() {
    this.enemies = new Map();
    this.respawnTimers = []; // seconds remaining, one per pending normal-enemy respawn
    this.bossActive = false;
    this.bossRespawnTimer = ENEMY_CONFIG.boss.initialSpawnDelay;
    this.nextNormalIndex = 1;
    this.nextBossIndex = 1;

    // Deterministic seed -- clients just render whatever this produces, so
    // this only needs to be reproducible for this server run's own
    // debugging, not matched against any client-side seed.
    this.seed = 908070;

    // Set once by server.js right after construction (see that file).
    this.onPlayerDamage = null; // (playerId, amount, enemyId) => {}
    this.onEnemyKilled = null; // (killerPlayerId, enemy) => {}
  }

  random() {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  distanceFromPlayerSpawn(x, z) {
    return Math.hypot(x - PLAYER_SPAWN_CENTER.x, z - PLAYER_SPAWN_CENTER.z);
  }

  // -------------------------------------------------------------------------
  // FIND SPAWN POSITION -- unchanged constraints from before the overhaul
  // (see brief's original spec, still valid for ground-based units):
  //   1. Inside the world boundary.
  //   2. Outside the safe zone around the fixed player spawn point.
  //   3. Far enough from the original player spawn.
  //   4. Far enough from every currently connected, alive player.
  //   5. Far enough from every other currently-alive enemy.
  //   6. On grass.
  // -------------------------------------------------------------------------
  findSpawnPosition(players, minDistance, maxDistance, minimumDistanceFromPlayerSpawn) {
    const alivePlayers = Array.from(players.values()).filter(
      p => p.combat && !p.combat.dead
    );

    const anchor = alivePlayers.length > 0
      ? alivePlayers[Math.floor(this.random() * alivePlayers.length)]
      : null;

    const anchorPos = anchor?.state?.position;
    const centerX = Number.isFinite(anchorPos?.[0]) ? anchorPos[0] : PLAYER_SPAWN_CENTER.x;
    const centerZ = Number.isFinite(anchorPos?.[2]) ? anchorPos[2] : PLAYER_SPAWN_CENTER.z;

    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
      const angle = this.random() * Math.PI * 2;
      const distance = minDistance + this.random() * (maxDistance - minDistance);

      const x = centerX + Math.cos(angle) * distance;
      const z = centerZ + Math.sin(angle) * distance;

      if (Math.abs(x) > WORLD_LIMIT || Math.abs(z) > WORLD_LIMIT) continue;
      if (this.distanceFromPlayerSpawn(x, z) < SAFE_ZONE_RADIUS) continue;
      if (this.distanceFromPlayerSpawn(x, z) < minimumDistanceFromPlayerSpawn) continue;

      const tooCloseToAPlayer = alivePlayers.some(p => {
        const pos = p.state?.position;
        if (!pos) return false;
        return Math.hypot(x - pos[0], z - pos[2]) < minDistance;
      });
      if (tooCloseToAPlayer) continue;

      const tooCloseToAnotherEnemy = Array.from(this.enemies.values()).some(enemy =>
        enemy.alive &&
        Math.hypot(x - enemy.x, z - enemy.z) < MIN_DISTANCE_BETWEEN_ENEMIES
      );
      if (tooCloseToAnotherEnemy) continue;

      if (surfaceAt(x, z) !== "grass") continue;

      const y = heightAt(x, z) + HOVER_HEIGHT;
      return { x, y, z };
    }

    return null;
  }

  spawnOne(players) {
    const position = this.findSpawnPosition(
      players,
      ENEMY_CONFIG.spawn.minDistance,
      ENEMY_CONFIG.spawn.maxDistance,
      MIN_DISTANCE_FROM_PLAYER_SPAWN
    );

    if (!position) return;

    const stats = ENEMY_CONFIG.normal;
    const id = `enemy_${String(this.nextNormalIndex++).padStart(3, "0")}`;

    this.enemies.set(id, this._makeEnemy(id, "normal", position, stats));
  }

  spawnBoss(players) {
    const position = this.findSpawnPosition(
      players,
      ENEMY_CONFIG.spawn.bossMinDistance,
      ENEMY_CONFIG.spawn.bossMaxDistance,
      BOSS_MIN_DISTANCE_FROM_PLAYER_SPAWN
    );

    if (!position) return;

    const stats = ENEMY_CONFIG.boss;
    const id = `boss_${String(this.nextBossIndex++).padStart(3, "0")}`;

    const enemy = this._makeEnemy(id, "boss", position, stats);
    enemy.rocketCooldownTimer = stats.rocketCooldown * 0.4; // brief grace period after spawn
    this.enemies.set(id, enemy);
    this.bossActive = true;
  }

  _makeEnemy(id, kind, position, stats) {
    return {
      id,
      kind,
      x: position.x,
      y: position.y,
      z: position.z,
      spawnX: position.x,
      spawnZ: position.z,
      facingYaw: 0,
      hp: stats.maxHealth,
      maxHp: stats.maxHealth,
      alive: true,

      aiState: AI_STATE.IDLE,
      targetPlayerId: null,
      aggroPlayerId: null,

      attackPhase: null,
      attackPhaseTimer: 0,
      attackCooldownTimer: 0,

      idleRoamX: null,
      idleRoamZ: null,
      idlePauseTimer: stats.idlePauseMin + this.random() * (stats.idlePauseMax - stats.idlePauseMin),
      moving: false,
      meleeFireSeq: 0,

      // Boss-only rocket fields -- harmless no-ops for normal enemies.
      rocketPhase: null,
      rocketPhaseTimer: 0,
      rocketCooldownTimer: 0,
      rocketTargetX: null,
      rocketTargetY: null,
      rocketTargetZ: null,
      rocketFireSeq: 0,
      telegraph: false,
      telegraphProgress: 0,

      corpseTimer: 0
    };
  }

  // -------------------------------------------------------------------------
  // NEAREST ALIVE, TARGETABLE PLAYER -- a dead player is invisible to
  // enemy AI: never selected as a new target.
  // -------------------------------------------------------------------------
  findNearestPlayer(enemy, players) {
    let best = null;
    let bestDistance = Infinity;

    for (const player of players.values()) {
      if (!player.combat || player.combat.dead) continue;

      const pos = player.state?.position;
      if (!pos) continue;

      const distance = Math.hypot(enemy.x - pos[0], enemy.z - pos[2]);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = player;
      }
    }

    return best ? { player: best, distance: bestDistance } : null;
  }

  // -------------------------------------------------------------------------
  // TARGET SELECTION -- prefers a live "aggro" lock (the player who most
  // recently damaged this enemy -- see applyDamage()) over a fresh nearest-
  // player scan, so an attacking player isn't randomly dropped mid-chase
  // just because another player happens to be a little closer this tick
  // (brief's "TARGETING LOGIC": no random switching every frame).
  // -------------------------------------------------------------------------
  findTargetPlayer(enemy, players, detectionRange) {
    if (enemy.aggroPlayerId) {
      const player = players.get(enemy.aggroPlayerId);
      const pos = player?.state?.position;

      if (player?.combat && !player.combat.dead && pos) {
        return { player, distance: Math.hypot(enemy.x - pos[0], enemy.z - pos[2]) };
      }

      // Attacker died/disconnected -- the lock is no longer valid.
      enemy.aggroPlayerId = null;
    }

    const nearest = this.findNearestPlayer(enemy, players);
    if (nearest && nearest.distance <= detectionRange) return nearest;
    return null;
  }

  // -------------------------------------------------------------------------
  // UPDATE -- one authoritative simulation tick.
  // -------------------------------------------------------------------------
  update(dt, players) {
    for (const [id, enemy] of this.enemies) {
      if (!enemy.alive) {
        enemy.corpseTimer -= dt;
        if (enemy.corpseTimer <= 0) this.enemies.delete(id);
        continue;
      }

      const stats = enemy.kind === "boss" ? ENEMY_CONFIG.boss : ENEMY_CONFIG.normal;
      const found = this.findTargetPlayer(enemy, players, stats.detectionRange);
      const targetPlayer = found?.player ?? null;
      const distanceToTarget = found?.distance ?? Infinity;
      enemy.targetPlayerId = targetPlayer?.id ?? null;

      const distanceFromSpawn = Math.hypot(enemy.x - enemy.spawnX, enemy.z - enemy.spawnZ);

      // ---- state transitions -------------------------------------------
      if (enemy.aiState === AI_STATE.IDLE) {
        if (targetPlayer) enemy.aiState = AI_STATE.CHASE;
      } else if (enemy.aiState === AI_STATE.CHASE) {
        if (distanceFromSpawn > stats.leashRadius) {
          enemy.aiState = AI_STATE.RETURN;
          enemy.aggroPlayerId = null;
        } else if (!targetPlayer) {
          enemy.aiState = AI_STATE.IDLE;
        } else if (enemy.attackCooldownTimer <= 0 && distanceToTarget <= stats.attackRange) {
          enemy.aiState = AI_STATE.ATTACK;
          enemy.attackPhase = "windup";
          enemy.attackPhaseTimer = 0;
        } else if (
          enemy.kind === "boss" &&
          enemy.rocketCooldownTimer <= 0 &&
          distanceToTarget > stats.rocketMinRange &&
          distanceToTarget <= stats.rocketMaxRange
        ) {
          enemy.aiState = AI_STATE.ROCKET;
          enemy.rocketPhase = "telegraph";
          enemy.rocketPhaseTimer = 0;
          const pos = targetPlayer.state.position;
          // Lock target position NOW -- see Target.js's matching comment
          // for why (Option A: fair, unambiguous 2-second warning).
          enemy.rocketTargetX = pos[0];
          enemy.rocketTargetZ = pos[2];
          enemy.rocketTargetY = heightAt(pos[0], pos[2]);
        }
      } else if (enemy.aiState === AI_STATE.RETURN) {
        if (distanceFromSpawn < 1.5) {
          enemy.aiState = AI_STATE.IDLE;
        } else if (targetPlayer && distanceToTarget <= stats.attackRange) {
          enemy.aiState = AI_STATE.CHASE;
        }
      }

      if (enemy.attackCooldownTimer > 0) enemy.attackCooldownTimer -= dt;
      if (enemy.kind === "boss" && enemy.rocketCooldownTimer > 0) enemy.rocketCooldownTimer -= dt;

      enemy.moving = false;

      // ---- per-state behavior --------------------------------------------
      if (enemy.aiState === AI_STATE.IDLE) {
        this.updateIdleRoam(dt, enemy, stats);
      } else if (enemy.aiState === AI_STATE.RETURN) {
        this.faceToward(enemy, enemy.spawnX, enemy.spawnZ, dt, stats.turnSpeed);
        this.moveToward(enemy, enemy.spawnX, enemy.spawnZ, stats.moveSpeed, dt);
        enemy.moving = true;
      } else if (enemy.aiState === AI_STATE.CHASE && targetPlayer) {
        const pos = targetPlayer.state.position;
        this.faceToward(enemy, pos[0], pos[2], dt, stats.turnSpeed);
        this.moveToward(enemy, pos[0], pos[2], stats.chaseSpeed, dt);
        enemy.moving = true;
      } else if (enemy.aiState === AI_STATE.ATTACK) {
        if (targetPlayer) {
          const pos = targetPlayer.state.position;
          this.faceToward(enemy, pos[0], pos[2], dt, stats.turnSpeed);
        }
        this.updateAttackPhase(dt, enemy, stats, targetPlayer);
      } else if (enemy.aiState === AI_STATE.ROCKET) {
        this.updateRocket(dt, enemy, stats, players);
      }
    }

    // ---- respawn normal enemies -----------------------------------------
    for (let i = this.respawnTimers.length - 1; i >= 0; i--) {
      this.respawnTimers[i] -= dt;
      if (this.respawnTimers[i] <= 0) {
        this.respawnTimers.splice(i, 1);
        this.spawnOne(players);
      }
    }

    const aliveNormal = Array.from(this.enemies.values()).filter(
      e => e.alive && e.kind === "normal"
    ).length;

    if (aliveNormal + this.respawnTimers.length < ENEMY_CONFIG.maxEnemies) {
      this.spawnOne(players);
    }

    if (!this.bossActive) {
      this.bossRespawnTimer -= dt;
      if (this.bossRespawnTimer <= 0) {
        this.spawnBoss(players);
      }
    }
  }

  // -------------------------------------------------------------------------
  // IDLE ROAM -- wander near spawn, never past idleRadius (brief's "IDLE
  // BEHAVIOR" / "SPAWN POINT BEHAVIOR").
  // -------------------------------------------------------------------------
  updateIdleRoam(dt, enemy, stats) {
    if (enemy.idleRoamX === null) {
      if (enemy.idlePauseTimer > 0) {
        enemy.idlePauseTimer -= dt;
        return;
      }
      const angle = this.random() * Math.PI * 2;
      const dist = this.random() * stats.idleRadius;
      enemy.idleRoamX = enemy.spawnX + Math.cos(angle) * dist;
      enemy.idleRoamZ = enemy.spawnZ + Math.sin(angle) * dist;
    }

    this.faceToward(enemy, enemy.idleRoamX, enemy.idleRoamZ, dt, stats.turnSpeed);
    const step = this.moveToward(enemy, enemy.idleRoamX, enemy.idleRoamZ, stats.moveSpeed, dt);
    enemy.moving = step > 0;

    const dist = Math.hypot(enemy.idleRoamX - enemy.x, enemy.idleRoamZ - enemy.z);
    if (dist < 0.15 || step === 0) {
      enemy.idleRoamX = null;
      enemy.idleRoamZ = null;
      enemy.idlePauseTimer = stats.idlePauseMin + this.random() * (stats.idlePauseMax - stats.idlePauseMin);
    }
  }

  faceToward(enemy, tx, tz, dt, turnSpeed) {
    const dx = tx - enemy.x;
    const dz = tz - enemy.z;
    if (Math.abs(dx) < 1e-4 && Math.abs(dz) < 1e-4) return;
    const desiredYaw = Math.atan2(dx, dz);
    enemy.facingYaw = stepAngle(enemy.facingYaw, desiredYaw, dt * turnSpeed);
  }

  moveToward(enemy, tx, tz, speed, dt) {
    const dx = tx - enemy.x;
    const dz = tz - enemy.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.05) return 0;
    const step = Math.min(dist, speed * dt);
    enemy.x += (dx / dist) * step;
    enemy.z += (dz / dist) * step;
    enemy.y = heightAt(enemy.x, enemy.z);
    return step;
  }

  // -------------------------------------------------------------------------
  // MELEE ATTACK PHASE MACHINE -- shared shape for grunt + boss melee.
  // Damage is applied exactly once, at the instant STRIKE begins.
  // -------------------------------------------------------------------------
  updateAttackPhase(dt, enemy, stats, targetPlayer) {
    enemy.attackPhaseTimer += dt;

    if (enemy.attackPhase === "windup") {
      if (enemy.attackPhaseTimer >= stats.windupDuration) {
        enemy.attackPhase = "strike";
        enemy.attackPhaseTimer = 0;
        enemy.meleeFireSeq = (enemy.meleeFireSeq + 1) % 65536;

        // Re-check range AT the moment of impact, not just at windup
        // start -- a player who backs off during the windup should be
        // able to actually dodge the hit instead of it being guaranteed
        // the instant windup began. Small leeway keeps the strike from
        // feeling unfair on ordinary lag/frame-timing jitter.
        if (targetPlayer) {
          const pos = targetPlayer.state.position;
          const hitDist = Math.hypot(pos[0] - enemy.x, pos[2] - enemy.z);
          if (hitDist <= stats.attackRange * 1.2) {
            this.onPlayerDamage?.(targetPlayer.id, stats.attackDamage, enemy.id);
          }
        }
      }
    } else if (enemy.attackPhase === "strike") {
      if (enemy.attackPhaseTimer >= stats.strikeDuration) {
        enemy.attackPhase = "recovery";
        enemy.attackPhaseTimer = 0;
      }
    } else if (enemy.attackPhase === "recovery") {
      if (enemy.attackPhaseTimer >= stats.recoveryDuration) {
        enemy.attackPhase = null;
        enemy.attackPhaseTimer = 0;
        enemy.attackCooldownTimer = stats.attackCooldown;
        enemy.aiState = AI_STATE.CHASE;
      }
    }
  }

  // -------------------------------------------------------------------------
  // ROCKET SPECIAL ATTACK (boss only) -- telegraph -> launch -> travel ->
  // impact, per the brief's "ROCKET LAUNCH SEQUENCE". The telegraph fields
  // (telegraph/telegraphProgress/rocketTargetX/Y/Z) are broadcast every
  // tick via serialize() so every client draws the exact same red circle
  // at the exact same spot for the exact same countdown.
  // -------------------------------------------------------------------------
  updateRocket(dt, enemy, stats, players) {
    enemy.rocketPhaseTimer += dt;

    if (enemy.rocketPhase === "telegraph") {
      enemy.telegraph = true;
      enemy.telegraphProgress = clamp(enemy.rocketPhaseTimer / stats.rocketWarningDuration, 0, 1);

      if (enemy.rocketPhaseTimer >= stats.rocketWarningDuration) {
        enemy.rocketPhase = "launching";
        enemy.rocketPhaseTimer = 0;
        enemy.telegraph = false;
        enemy.rocketFireSeq = (enemy.rocketFireSeq + 1) % 65536;
      }
      return;
    }

    if (enemy.rocketPhase === "launching") {
      const totalDist = Math.hypot(enemy.rocketTargetX - enemy.x, enemy.rocketTargetZ - enemy.z);
      const travelTime = Math.max(0.15, totalDist / stats.rocketTravelSpeed);

      if (enemy.rocketPhaseTimer >= travelTime) {
        this.resolveRocketImpact(enemy, stats, players);
      }
      return;
    }
  }

  resolveRocketImpact(enemy, stats, players) {
    for (const player of players.values()) {
      if (!player.combat || player.combat.dead) continue;
      const pos = player.state?.position;
      if (!pos) continue;

      const distance = Math.hypot(pos[0] - enemy.rocketTargetX, pos[2] - enemy.rocketTargetZ);
      if (distance <= stats.rocketRadius) {
        this.onPlayerDamage?.(player.id, stats.rocketDamage, enemy.id);
      }
    }

    enemy.rocketPhase = null;
    enemy.rocketPhaseTimer = 0;
    enemy.rocketCooldownTimer = stats.rocketCooldown;
    enemy.aiState = AI_STATE.CHASE;
  }

  resetAttackPhase(enemy) {
    enemy.attackPhase = null;
    enemy.attackPhaseTimer = 0;
    enemy.attackCooldownTimer = 0;
    enemy.telegraph = false;
    enemy.rocketPhase = null;
    enemy.rocketPhaseTimer = 0;
  }

  // -------------------------------------------------------------------------
  // APPLY DAMAGE (from a player's weapon)
  // -------------------------------------------------------------------------
  // DAMAGE-TRIGGERED AGGRO (brief requirement): the attacking player is
  // immediately locked as this enemy's target, regardless of current
  // distance/detection range, and an IDLE/RETURN enemy immediately starts
  // chasing. Centralized here -- the single place damage is ever applied --
  // so no individual weapon needs its own aggro logic.
  // -------------------------------------------------------------------------
  applyDamage(enemyId, amount, attackerPlayerId) {
    const enemy = this.enemies.get(enemyId);
    if (!enemy || !enemy.alive || !Number.isFinite(amount) || amount <= 0) {
      return false;
    }

    enemy.hp = Math.max(0, enemy.hp - amount);

    if (attackerPlayerId) {
      enemy.aggroPlayerId = attackerPlayerId;
      if (enemy.aiState === AI_STATE.IDLE || enemy.aiState === AI_STATE.RETURN) {
        enemy.aiState = AI_STATE.CHASE;
      }
    }

    if (enemy.hp <= 0) {
      enemy.alive = false;
      enemy.corpseTimer = CORPSE_LINGER_SECONDS;
      enemy.targetPlayerId = null;
      enemy.aggroPlayerId = null;
      this.resetAttackPhase(enemy);

      if (enemy.kind === "boss") {
        this.bossActive = false;
        this.bossRespawnTimer = ENEMY_CONFIG.boss.respawnDelay;
      } else {
        this.respawnTimers.push(TARGET_CONFIG.respawnDelay);
      }

      this.onEnemyKilled?.(attackerPlayerId, enemy);
      return true;
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // SERIALIZE -- what gets sent to clients (welcome + periodic "enemies").
  // -------------------------------------------------------------------------
  serialize(players) {
    return Array.from(this.enemies.values()).map(enemy => ({
      id: enemy.id,
      kind: enemy.kind,
      x: enemy.x,
      y: enemy.y,
      z: enemy.z,
      yaw: enemy.facingYaw,
      hp: enemy.hp,
      maxHp: enemy.maxHp,
      alive: enemy.alive,
      state: enemy.aiState,
      attackPhase: enemy.attackPhase,
      moving: enemy.moving === true,
      telegraph: enemy.telegraph === true,
      telegraphProgress: enemy.telegraphProgress ?? 0,
      rtx: enemy.rocketTargetX ?? undefined,
      rty: enemy.rocketTargetY ?? undefined,
      rtz: enemy.rocketTargetZ ?? undefined,
      rocketFireSeq: enemy.rocketFireSeq ?? 0,
      meleeFireSeq: enemy.meleeFireSeq ?? 0
    }));
  }
}