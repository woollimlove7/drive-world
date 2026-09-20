import * as THREE from "three";
import { ENEMY_CONFIG } from "./TurretConfig.js";
import { stepAngle } from "./TurretMath.js";
import { HealthBar } from "../gameplay/HealthBar.js";
import { NameLabel } from "../gameplay/NameLabel.js";
import { buildMechanicalEnemyModel, MECHANICAL_ENEMY_HEIGHT } from "../enemies/MechanicalEnemyModel.js";
import { buildBossSpiderModel, BOSS_SPIDER_STANCE_HEIGHT } from "../enemies/BossSpiderModel.js";
import { animateMechanicalEnemy } from "../enemies/EnemyAnimator.js";
import { animateBossSpider } from "../enemies/SpiderAnimator.js";
import {
  APEX_ROCKET_EXPLOSION_CONFIG,
  APEX_ROCKET_LAUNCH_FLASH_CONFIG
} from "./ExplosionEffect.js";

// ---------------------------------------------------------------------------
// MECHANICAL ENEMY + BOSS OVERHAUL
//
// `Target` is the enemy entity class for BOTH normal grunts and the boss --
// `kind` picks which half of ENEMY_CONFIG it reads and which model/animator
// it uses, matching the project's existing pattern of one shared class for
// both (see the original file header this replaces).
//
// Ground-based MELEE state machine (offline/local-sim path -- see
// `update()`):
//
//   IDLE (roam near spawnPosition)
//     -> CHASE (player detected, or damaged from anywhere -> aggro)
//        -> ATTACK (windup -> strike [damage window] -> recovery) -> CHASE
//        -> RETURN (leashed too far from spawn) -> IDLE
//   Boss additionally has a ROCKET branch off CHASE (telegraph -> launch ->
//   impact) instead of melee when the target is at rocket range.
//
// In multiplayer, this class is a pure PRESENTATION layer (see
// `updateCosmetic()` / `applyNetworkState()`): every field above is decided
// authoritatively by server/EnemyWorld.js and streamed down; this class
// only renders whatever it's told.
// ---------------------------------------------------------------------------

const AI_STATE = {
  IDLE: "idle",
  CHASE: "chase",
  ATTACK: "attack",
  RETURN: "return",
  ROCKET: "rocket",
  DEAD: "dead"
};

const DEATH_LINGER = 1.1; // seconds the corpse stays before local-sim disposes it

// ---------------------------------------------------------------------------
// Shared countdown-digit textures for the rocket telegraph (2, 1) -- built
// once at module scope, matching the perf pattern used everywhere else in
// this file (no per-instance/per-frame canvas work).
// ---------------------------------------------------------------------------
let countdownTextures = null;
function getCountdownTexture(n) {
  if (!countdownTextures) countdownTextures = new Map();
  if (countdownTextures.has(n)) return countdownTextures.get(n);

  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, 128, 128);
  ctx.font = "bold 96px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 10;
  ctx.strokeStyle = "rgba(0,0,0,0.9)";
  ctx.strokeText(String(n), 64, 68);
  ctx.fillStyle = "#ff2a1a";
  ctx.fillText(String(n), 64, 68);

  const texture = new THREE.CanvasTexture(canvas);
  countdownTextures.set(n, texture);
  return texture;
}

let sharedCircleGeometry = null;
function getCircleGeometry() {
  if (!sharedCircleGeometry) {
    sharedCircleGeometry = new THREE.RingGeometry(0.0, 1, 32);
  }
  return sharedCircleGeometry;
}

let sharedPlaneGeometry = null;
function getPlaneGeometry() {
  if (!sharedPlaneGeometry) sharedPlaneGeometry = new THREE.PlaneGeometry(1, 1);
  return sharedPlaneGeometry;
}

// Kept exported for backward compatibility with any external caller that
// still imports these -- the new models build their own geometry/materials
// internally via RobotParts.js, so these are no longer needed for that, but
// TargetSystem.js's constructor still calls them once at startup.
export function createSharedTargetAssets() {
  return {};
}

export function createSharedBossAssets() {
  return {};
}

export class Target {
  constructor(scene, position, kind = "normal", spawnPosition = null) {
    this.scene = scene;
    this.kind = kind;
    this.alive = true;
    this.disposed = false;

    const stats = kind === "boss" ? ENEMY_CONFIG.boss : ENEMY_CONFIG.normal;
    this.maxHealth = stats.maxHealth;
    this.health = this.maxHealth;
    this.xpReward = stats.xpReward;
    this.detectionRange = stats.detectionRange;
    this.attackRange = stats.attackRange;
    this.attackDamage = stats.attackDamage;
    this.attackCooldownDuration = stats.attackCooldown;
    this.windupDuration = stats.windupDuration;
    this.strikeDuration = stats.strikeDuration;
    this.recoveryDuration = stats.recoveryDuration;
    this.moveSpeed = stats.moveSpeed;
    this.chaseSpeed = stats.chaseSpeed;
    this.turnSpeed = stats.turnSpeed;
    this.idleRadius = stats.idleRadius;
    this.idlePauseMin = stats.idlePauseMin;
    this.idlePauseMax = stats.idlePauseMax;
    this.leashRadius = stats.leashRadius;
    this.name = stats.name;

    if (kind === "boss") {
      this.rocketMinRange = stats.rocketMinRange;
      this.rocketMaxRange = stats.rocketMaxRange;
      this.rocketDamage = stats.rocketDamage;
      this.rocketRadius = stats.rocketRadius;
      this.rocketCooldownDuration = stats.rocketCooldown;
      this.rocketWarningDuration = stats.rocketWarningDuration;
      this.rocketTravelSpeed = stats.rocketTravelSpeed;
    }

    this.spawnPosition = (spawnPosition ?? position).clone();

    this.group = new THREE.Group();
    this.group.position.copy(position);
    this.facingYaw = 0;

    const built = kind === "boss" ? buildBossSpiderModel() : buildMechanicalEnemyModel();
    this.parts = built.parts;
    if (kind === "boss") this.group.scale.setScalar(ENEMY_CONFIG.boss.scale);
    this.group.add(built.root);
    scene.add(this.group);

    // ---- AI state ----
    this.aiState = AI_STATE.IDLE;
    this.attackPhase = null;
    this.attackPhaseTimer = 0;
    this.attackCooldownTimer = 0;
    this.idleRoamTarget = null;
    this.idlePauseTimer = this._randomIdlePause();
    this.moveT = 0;
    this.hurtTimer = 0;
    this.deathT = 0;
    this.corpseTimer = 0;

    // Boss rocket state.
    this.rocketPhase = null;
    this.rocketPhaseTimer = 0;
    this.rocketCooldownTimer = stats.rocketCooldown ? stats.rocketCooldown * 0.4 : 0;
    this.rocketTargetPos = null;
    this.rocketProjectile = null;

    // ---- UI ----
    const height =
      kind === "boss" ? BOSS_SPIDER_STANCE_HEIGHT * ENEMY_CONFIG.boss.scale : MECHANICAL_ENEMY_HEIGHT;

    // Boss width bumped alongside ENEMY_CONFIG.boss.scale (3.2 -> 4.6, same
    // ~1.44x ratio) so the bar/label stay proportionate to the now-bigger
    // model instead of looking undersized floating above it. yOffset is
    // already scale-aware (computed from `height` above), so only the
    // literal widths needed a manual bump here.
    this.healthBar = new HealthBar(scene, kind === "boss"
      ? { width: 8.6, height: 0.42, yOffset: height + 0.9 }
      : { width: 1.6, height: 0.16, yOffset: height + 0.35 });
    this.healthBar.setRatio(1);

    this.nameLabel = new NameLabel(scene, this.name, kind === "boss"
      ? { width: 9.3, yOffset: height + 1.5 }
      : { width: 2.0, yOffset: height + 0.7 });

    if (kind === "boss") this._buildTelegraphVisuals(scene);
  }

  get position() {
    return this.group.position;
  }

  _randomIdlePause() {
    return this.idlePauseMin + Math.random() * (this.idlePauseMax - this.idlePauseMin);
  }

  _buildTelegraphVisuals(scene) {
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xff2a1a,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    this.telegraphRing = new THREE.Mesh(getCircleGeometry(), ringMat);
    this.telegraphRing.rotation.x = -Math.PI / 2;
    this.telegraphRing.visible = false;
    this.telegraphRing.renderOrder = 10;
    scene.add(this.telegraphRing);

    const countdownMat = new THREE.MeshBasicMaterial({
      map: getCountdownTexture(2),
      transparent: true,
      depthWrite: false
    });
    this.telegraphCountdown = new THREE.Mesh(getPlaneGeometry(), countdownMat);
    this.telegraphCountdown.scale.set(2, 2, 1);
    this.telegraphCountdown.visible = false;
    this.telegraphCountdown.renderOrder = 11;
    scene.add(this.telegraphCountdown);
  }

  // -------------------------------------------------------------------------
  // DAMAGE-TRIGGERED AGGRO (offline/local-sim path only -- see brief's
  // "DAMAGE-TRIGGERED AGGRO" section). Multiplayer's equivalent lives
  // server-side in EnemyWorld.applyDamage().
  // -------------------------------------------------------------------------
  onDamagedByPlayer() {
    if (this.aiState === AI_STATE.IDLE || this.aiState === AI_STATE.RETURN) {
      this.aiState = AI_STATE.CHASE;
    }
  }

  resetAttackPhase() {
    this.attackPhase = null;
    this.attackPhaseTimer = 0;
  }

  _faceToward(targetX, targetZ, dt) {
    const dx = targetX - this.position.x;
    const dz = targetZ - this.position.z;
    if (Math.abs(dx) < 1e-4 && Math.abs(dz) < 1e-4) return;
    const desiredYaw = Math.atan2(dx, dz);
    this.facingYaw = stepAngle(this.facingYaw, desiredYaw, dt * this.turnSpeed);
    this.group.rotation.y = this.facingYaw;
  }

  _moveToward(targetX, targetZ, speed, dt, terrain) {
    const dx = targetX - this.position.x;
    const dz = targetZ - this.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.05) return 0;
    const step = Math.min(dist, speed * dt);
    const nx = this.position.x + (dx / dist) * step;
    const nz = this.position.z + (dz / dist) * step;
    this.position.x = nx;
    this.position.z = nz;
    if (terrain) this.position.y = terrain.heightAt(nx, nz);
    return step;
  }

  // -------------------------------------------------------------------------
  // MELEE ATTACK PHASE MACHINE -- shared by grunt and boss. Damage is
  // applied exactly once, at the instant STRIKE begins (the "damage
  // window"), never continuously across the animation (brief requirement).
  // -------------------------------------------------------------------------
  _updateAttackPhase(dt, ctx, targetPos) {
    this.attackPhaseTimer += dt;

    if (this.attackPhase === "windup") {
      if (this.attackPhaseTimer >= this.windupDuration) {
        this.attackPhase = "strike";
        this.attackPhaseTimer = 0;

        // Damage window: apply once, right as the strike begins -- but
        // re-check range AT impact (not just at windup start) so a
        // player who backs out of range during the windup can actually
        // dodge, matching server/EnemyWorld.js's equivalent check.
        const hitDist = Math.hypot(targetPos.x - this.position.x, targetPos.z - this.position.z);
        const hit = hitDist <= this.attackRange * 1.2;

        if (hit) ctx.applyPlayerDamage?.(this.attackDamage, this);
        ctx.effectsPool?.spawnImpact(targetPos.clone());
        ctx.audio?.playToneEffect?.({
          startFrequency: this.kind === "boss" ? 180 : 300,
          endFrequency: this.kind === "boss" ? 60 : 120,
          duration: 0.1,
          volume: hit ? 0.05 : 0.03,
          type: "square",
          destination: ctx.audio.effectsBus
        });
      }
    } else if (this.attackPhase === "strike") {
      if (this.attackPhaseTimer >= this.strikeDuration) {
        this.attackPhase = "recovery";
        this.attackPhaseTimer = 0;
      }
    } else if (this.attackPhase === "recovery") {
      if (this.attackPhaseTimer >= this.recoveryDuration) {
        this.resetAttackPhase();
        this.attackCooldownTimer = this.attackCooldownDuration;
        this.aiState = AI_STATE.CHASE;
      }
    }
  }

  get attackPhaseProgress() {
    const duration =
      this.attackPhase === "windup" ? this.windupDuration :
      this.attackPhase === "strike" ? this.strikeDuration :
      this.attackPhase === "recovery" ? this.recoveryDuration : 1;
    return Math.min(1, this.attackPhaseTimer / Math.max(0.0001, duration));
  }

  // -------------------------------------------------------------------------
  // IDLE ROAM -- wander near spawnPosition, never past idleRadius (brief's
  // "SPAWN POINT BEHAVIOR" / "IDLE BEHAVIOR").
  // -------------------------------------------------------------------------
  _updateIdle(dt, terrain) {
    if (!this.idleRoamTarget) {
      if (this.idlePauseTimer > 0) {
        this.idlePauseTimer -= dt;
        return;
      }
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * this.idleRadius;
      this.idleRoamTarget = new THREE.Vector3(
        this.spawnPosition.x + Math.cos(angle) * dist,
        0,
        this.spawnPosition.z + Math.sin(angle) * dist
      );
    }

    this._faceToward(this.idleRoamTarget.x, this.idleRoamTarget.z, dt);
    const remaining = this._moveToward(this.idleRoamTarget.x, this.idleRoamTarget.z, this.moveSpeed, dt, terrain);
    this.moveT = (this.moveT + dt * 0.9) % 1;

    const dist = Math.hypot(this.idleRoamTarget.x - this.position.x, this.idleRoamTarget.z - this.position.z);
    if (dist < 0.15 || remaining === 0) {
      this.idleRoamTarget = null;
      this.idlePauseTimer = this._randomIdlePause();
    }
  }

  // ctx: { playerPosition, playerDead, applyPlayerDamage(amount, source),
  //        effectsPool, camera, audio, terrain }
  update(dt, elapsed, ctx) {
    if (!this.alive) {
      this._updateDeath(dt, elapsed, ctx?.camera);
      return;
    }

    const terrain = ctx?.terrain;
    const distanceToPlayer =
      ctx?.playerPosition && !ctx.playerDead
        ? Math.hypot(ctx.playerPosition.x - this.position.x, ctx.playerPosition.z - this.position.z)
        : Infinity;
    const distanceFromSpawn = Math.hypot(
      this.position.x - this.spawnPosition.x,
      this.position.z - this.spawnPosition.z
    );

    // ---- state transitions ------------------------------------------------
    if (this.aiState === AI_STATE.IDLE) {
      if (distanceToPlayer <= this.detectionRange) this.aiState = AI_STATE.CHASE;
    } else if (this.aiState === AI_STATE.CHASE) {
      if (distanceFromSpawn > this.leashRadius) {
        this.aiState = AI_STATE.RETURN;
      } else if (!Number.isFinite(distanceToPlayer)) {
        this.aiState = AI_STATE.IDLE;
      } else if (this.attackCooldownTimer <= 0 && distanceToPlayer <= this.attackRange) {
        this.aiState = AI_STATE.ATTACK;
        this.attackPhase = "windup";
        this.attackPhaseTimer = 0;
      } else if (
        this.kind === "boss" &&
        this.rocketCooldownTimer <= 0 &&
        distanceToPlayer > this.rocketMinRange &&
        distanceToPlayer <= this.rocketMaxRange
      ) {
        this.aiState = AI_STATE.ROCKET;
        this.rocketPhase = "telegraph";
        this.rocketPhaseTimer = 0;
        // Lock the target position NOW (Option A from the brief) -- the
        // red circle appears at one fixed spot for the player to read and
        // react to for the full warning duration, not a moving target.
        this.rocketTargetPos = ctx.playerPosition.clone();
      }
    } else if (this.aiState === AI_STATE.RETURN) {
      if (distanceFromSpawn < 1.5) this.aiState = AI_STATE.IDLE;
      else if (distanceToPlayer <= this.attackRange) this.aiState = AI_STATE.CHASE;
    }

    if (this.attackCooldownTimer > 0) this.attackCooldownTimer -= dt;
    if (this.rocketCooldownTimer > 0) this.rocketCooldownTimer -= dt;

    // ---- per-state behavior -------------------------------------------
    if (this.aiState === AI_STATE.IDLE) {
      this._updateIdle(dt, terrain);
    } else if (this.aiState === AI_STATE.RETURN) {
      this._faceToward(this.spawnPosition.x, this.spawnPosition.z, dt);
      this._moveToward(this.spawnPosition.x, this.spawnPosition.z, this.moveSpeed, dt, terrain);
      this.moveT = (this.moveT + dt * 0.9) % 1;
    } else if (this.aiState === AI_STATE.CHASE) {
      if (ctx?.playerPosition) {
        this._faceToward(ctx.playerPosition.x, ctx.playerPosition.z, dt);
        this._moveToward(ctx.playerPosition.x, ctx.playerPosition.z, this.chaseSpeed, dt, terrain);
      }
      this.moveT = (this.moveT + dt * 1.6) % 1;
    } else if (this.aiState === AI_STATE.ATTACK) {
      if (ctx?.playerPosition) this._faceToward(ctx.playerPosition.x, ctx.playerPosition.z, dt);
      this._updateAttackPhase(dt, ctx, ctx?.playerPosition ?? this.position);
    } else if (this.aiState === AI_STATE.ROCKET) {
      this._updateRocket(dt, ctx);
    }

    if (this.hurtTimer > 0) this.hurtTimer = Math.max(0, this.hurtTimer - dt * 2);

    this._runAnimator(elapsed);
    this.healthBar.setRatio(this.health / this.maxHealth);
    if (ctx?.camera) {
      this.healthBar.updateTransform(this.position, ctx.camera);
      this.nameLabel.updateTransform(this.position, ctx.camera);
    }
  }

  // -------------------------------------------------------------------------
  // ROCKET SPECIAL ATTACK (boss only) -- telegraph -> launch -> travel ->
  // impact, per the brief's "ROCKET LAUNCH SEQUENCE".
  // -------------------------------------------------------------------------
  _updateRocket(dt, ctx) {
    this.rocketPhaseTimer += dt;

    if (this.rocketPhase === "telegraph") {
      if (this.telegraphRing) {
        this.telegraphRing.visible = true;
        this.telegraphRing.position.set(this.rocketTargetPos.x, this.rocketTargetPos.y + 0.05, this.rocketTargetPos.z);
        const scale = this.rocketRadius * (0.85 + 0.15 * Math.sin(this.rocketPhaseTimer * 10));
        this.telegraphRing.scale.set(scale, scale, 1);
        this.telegraphRing.material.opacity = 0.4 + 0.35 * Math.abs(Math.sin(this.rocketPhaseTimer * 9));
      }
      if (this.telegraphCountdown) {
        const remaining = Math.max(0, this.rocketWarningDuration - this.rocketPhaseTimer);
        const digit = Math.max(1, Math.min(2, Math.ceil(remaining)));
        this.telegraphCountdown.visible = true;
        this.telegraphCountdown.material.map = getCountdownTexture(digit);
        this.telegraphCountdown.material.needsUpdate = true;
        this.telegraphCountdown.position.set(
          this.rocketTargetPos.x,
          this.rocketTargetPos.y + 2.2,
          this.rocketTargetPos.z
        );
        if (ctx?.camera) this.telegraphCountdown.quaternion.copy(ctx.camera.quaternion);
      }

      if (this.rocketPhaseTimer >= this.rocketWarningDuration) {
        this.rocketPhase = "launching";
        this.rocketPhaseTimer = 0;
        if (this.telegraphRing) this.telegraphRing.visible = false;
        if (this.telegraphCountdown) this.telegraphCountdown.visible = false;
        this._spawnRocketProjectile(ctx.effectsPool);
        ctx.audio?.playToneEffect?.({
          startFrequency: 140,
          endFrequency: 40,
          duration: 0.3,
          volume: 0.08,
          type: "sawtooth",
          destination: ctx.audio.effectsBus
        });
      }
      return;
    }

    if (this.rocketPhase === "launching") {
      const launchPos = new THREE.Vector3(this.position.x, this.position.y + 1.5 * this._scale(), this.position.z);
      const totalDist = launchPos.distanceTo(this.rocketTargetPos);
      const travelTime = Math.max(0.15, totalDist / this.rocketTravelSpeed);
      const t = Math.min(1, this.rocketPhaseTimer / travelTime);

      if (this.rocketProjectile) {
        this.rocketProjectile.position.lerpVectors(launchPos, this.rocketTargetPos, t);
        this.rocketProjectile.position.y += Math.sin(t * Math.PI) * 3; // lofted arc
      }

      if (t >= 1) {
        this._impactRocket(ctx);
      }
      return;
    }
  }

  _scale() {
    return this.kind === "boss" ? ENEMY_CONFIG.boss.scale : 1;
  }

  _spawnRocketProjectile(effectsPool) {
    const geo = new THREE.CylinderGeometry(0.14, 0.18, 0.9, 8);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x8a8f96,
      emissive: 0xff5522,
      emissiveIntensity: 0.6,
      metalness: 0.6,
      roughness: 0.4
    });
    const launchPos = new THREE.Vector3(this.position.x, this.position.y + 1.5 * this._scale(), this.position.z);
    this.rocketProjectile = new THREE.Mesh(geo, mat);
    this.rocketProjectile.position.copy(launchPos);
    this.scene.add(this.rocketProjectile);

    // Quick muzzle flash at the moment the rocket actually leaves the
    // launcher -- separate from (and much smaller/cheaper than) the impact
    // explosion below.
    effectsPool?.spawnExplosion(launchPos, APEX_ROCKET_LAUNCH_FLASH_CONFIG);
  }

  _impactRocket(ctx) {
    if (this.rocketProjectile) {
      this.scene.remove(this.rocketProjectile);
      this.rocketProjectile.geometry.dispose();
      this.rocketProjectile.material.dispose();
      this.rocketProjectile = null;
    }

    // Boss-level explosion (see ExplosionEffect.js) -- deliberately bigger
    // on every axis than the player's level-10 missile explosion. Called
    // exactly once here, right as the rocket's flight ends -- this replaces
    // (not adds to) the old spawnImpact() call, so it can never
    // double-trigger.
    ctx.effectsPool?.spawnExplosion(this.rocketTargetPos.clone(), APEX_ROCKET_EXPLOSION_CONFIG);

    // Area damage -- only the local player exists offline, so this is a
    // simple radius check; the networked/authoritative version (server)
    // loops every connected player (see EnemyWorld.js).
    if (ctx?.playerPosition && !ctx.playerDead) {
      const dist = ctx.playerPosition.distanceTo(this.rocketTargetPos);
      if (dist <= this.rocketRadius) {
        ctx.applyPlayerDamage?.(this.rocketDamage, this);
      }
    }

    this.rocketPhase = null;
    this.rocketPhaseTimer = 0;
    this.rocketTargetPos = null;
    this.rocketCooldownTimer = this.rocketCooldownDuration;
    this.aiState = AI_STATE.CHASE;
  }

  _runAnimator(elapsed) {
    const moving =
      this.aiState === AI_STATE.CHASE ||
      this.aiState === AI_STATE.RETURN ||
      (this.aiState === AI_STATE.IDLE && this.idleRoamTarget !== null);

    const animState = {
      mode: moving ? "walk" : "idle",
      attackPhase: this.aiState === AI_STATE.ATTACK ? this.attackPhase : null,
      attackPhaseT: this.attackPhaseProgress,
      moveT: this.moveT,
      hurtT: this.hurtTimer,
      deathT: this.deathT,
      rocketPhase: this.aiState === AI_STATE.ROCKET ? this.rocketPhase : null,
      rocketPhaseT:
        this.rocketPhase === "telegraph"
          ? this.rocketPhaseTimer / this.rocketWarningDuration
          : this.rocketPhase === "launching"
          ? this.rocketPhaseTimer
          : 0
    };

    if (this.kind === "boss") animateBossSpider(this.parts, elapsed, animState);
    else animateMechanicalEnemy(this.parts, elapsed, animState);
  }

  _updateDeath(dt, elapsed, camera) {
    this.deathT = Math.min(1, this.deathT + dt / 0.6);
    this._runAnimator(elapsed);
    this.corpseTimer += dt;
    if (camera) {
      this.healthBar.updateTransform(this.position, camera);
    }
    this.healthBar.setRatio(0);
    if (this.telegraphRing) this.telegraphRing.visible = false;
    if (this.telegraphCountdown) this.telegraphCountdown.visible = false;
    this.nameLabel.setVisible(false);
    if (this.corpseTimer >= DEATH_LINGER) this.dispose();
  }

  // -------------------------------------------------------------------------
  // COSMETIC-ONLY UPDATE (multiplayer "networked" mode) -- see file header.
  // No AI, no HP mutation, no damage application -- 100% driven by the
  // latest applyNetworkState() call.
  // -------------------------------------------------------------------------
  updateCosmetic(dt, elapsed, camera, effectsPool) {
    if (this.disposed) return;

    if (!this.alive) {
      this._updateDeath(dt, elapsed, camera);
      return;
    }

    if (this.netTargetPos) {
      const followRate = 1 - Math.exp(-dt * 8);
      this.position.lerp(this.netTargetPos, followRate);
    }

    if (Number.isFinite(this.netFacingYaw)) {
      this.facingYaw = stepAngle(this.facingYaw, this.netFacingYaw, dt * this.turnSpeed);
      this.group.rotation.y = this.facingYaw;
    }

    this.aiState = this.netAiState ?? this.aiState;
    this.attackPhase = this.netAttackPhase ?? null;
    this.moveT = (this.moveT + dt * (this.netMoving ? 1.4 : 0.9)) % 1;

    if (this.hurtTimer > 0) this.hurtTimer = Math.max(0, this.hurtTimer - dt * 2);

    // ---- rocket telegraph (networked) ----
    if (this.telegraphRing) {
      if (this.netTelegraph && this.netRocketTargetPos) {
        this.telegraphRing.visible = true;
        this.telegraphRing.position.set(
          this.netRocketTargetPos.x,
          this.netRocketTargetPos.y + 0.05,
          this.netRocketTargetPos.z
        );
        const scale = this.rocketRadius * (0.85 + 0.15 * Math.sin(elapsed * 10));
        this.telegraphRing.scale.set(scale, scale, 1);
        this.telegraphRing.material.opacity = 0.4 + 0.35 * Math.abs(Math.sin(elapsed * 9));

        if (this.telegraphCountdown) {
          const remaining = Math.max(0, this.rocketWarningDuration * (1 - (this.netTelegraphProgress ?? 0)));
          const digit = Math.max(1, Math.min(2, Math.ceil(remaining)));
          this.telegraphCountdown.visible = true;
          this.telegraphCountdown.material.map = getCountdownTexture(digit);
          this.telegraphCountdown.material.needsUpdate = true;
          this.telegraphCountdown.position.set(
            this.netRocketTargetPos.x,
            this.netRocketTargetPos.y + 2.2,
            this.netRocketTargetPos.z
          );
          if (camera) this.telegraphCountdown.quaternion.copy(camera.quaternion);
        }
      } else {
        this.telegraphRing.visible = false;
        if (this.telegraphCountdown) this.telegraphCountdown.visible = false;
      }
    }

    // Rising edge on the server's rocket-launch counter -- spawn the
    // traveling visual, same pattern as the old tracer fireSeq handling.
    if (
      Number.isFinite(this.netRocketFireSeq) &&
      this.lastRocketFireSeq !== undefined &&
      this.netRocketFireSeq !== this.lastRocketFireSeq &&
      this.netRocketTargetPos
    ) {
      this.rocketTargetPos = this.netRocketTargetPos.clone();
      this._spawnRocketProjectile(effectsPool);
      this.rocketPhase = "launching";
      this.rocketPhaseTimer = 0;
      this.rocketLaunchOrigin = this.position.clone();
    }
    this.lastRocketFireSeq = this.netRocketFireSeq ?? this.lastRocketFireSeq ?? 0;

    if (this.rocketPhase === "launching" && this.rocketProjectile) {
      this.rocketPhaseTimer += dt;
      const launchPos = this.rocketLaunchOrigin ?? this.position;
      const totalDist = launchPos.distanceTo(this.rocketTargetPos);
      const travelTime = Math.max(0.15, totalDist / this.rocketTravelSpeed);
      const t = Math.min(1, this.rocketPhaseTimer / travelTime);
      this.rocketProjectile.position.lerpVectors(launchPos, this.rocketTargetPos, t);
      this.rocketProjectile.position.y += Math.sin(t * Math.PI) * 3;
      if (t >= 1) {
        this.scene.remove(this.rocketProjectile);
        this.rocketProjectile.geometry.dispose();
        this.rocketProjectile.material.dispose();
        this.rocketProjectile = null;
        this.rocketPhase = null;

        // Client-side impact VFX only -- damage/timing stay authoritative
        // on the server (see server/EnemyWorld.js's resolveRocketImpact,
        // which computes this exact same travelTime independently and
        // applies damage there). This purely cosmetic explosion is driven
        // off the same rocketFireSeq rising edge that spawned the
        // projectile above, so every connected client renders it exactly
        // once per launch, in sync with (not duplicating) the server's own
        // damage resolution.
        effectsPool?.spawnExplosion(this.rocketTargetPos.clone(), APEX_ROCKET_EXPLOSION_CONFIG);
      }
    }

    // Rising edge on melee-hit counter -- reserved for a future cosmetic
    // hit-flash hook (e.g. camera shake); no-op today beyond bookkeeping.
    this.lastMeleeFireSeq = this.netMeleeFireSeq ?? this.lastMeleeFireSeq ?? 0;

    this._runAnimator(elapsed);

    this.healthBar.setRatio(this.maxHealth > 0 ? this.health / this.maxHealth : 0);
    if (camera) {
      this.healthBar.updateTransform(this.position, camera);
      this.nameLabel.updateTransform(this.position, camera);
    }
  }

  // -------------------------------------------------------------------------
  // APPLY NETWORK STATE -- from the server's "enemies" broadcast (see
  // EnemyWorld.serialize() and MultiplayerClient / TargetSystem.applyServerState).
  // -------------------------------------------------------------------------
  applyNetworkState(data) {
    this.health = data.hp;
    this.maxHealth = data.maxHp;

    const wasAlive = this.alive;
    this.alive = data.alive;

    this.netTargetPos = this.netTargetPos ?? new THREE.Vector3();
    this.netTargetPos.set(data.x, data.y, data.z);

    if (!this.netInitialized) {
      this.position.copy(this.netTargetPos);
      this.netInitialized = true;
    }

    this.netFacingYaw = Number.isFinite(data.yaw) ? data.yaw : null;
    this.netAiState = data.state ?? null;
    this.netAttackPhase = data.attackPhase ?? null;
    this.netMoving = data.moving === true;

    this.netTelegraph = data.telegraph === true;
    this.netTelegraphProgress = data.telegraphProgress ?? 0;
    if (Number.isFinite(data.rtx) && Number.isFinite(data.rtz)) {
      this.netRocketTargetPos = this.netRocketTargetPos ?? new THREE.Vector3();
      this.netRocketTargetPos.set(data.rtx, data.rty ?? data.y, data.rtz);
    }
    this.netRocketFireSeq = data.rocketFireSeq;
    this.netMeleeFireSeq = data.meleeFireSeq;

    if (wasAlive && !this.alive) {
      this.aiState = AI_STATE.DEAD;
    }
  }

  // Returns true the instant this hit destroys the target (offline mode
  // only -- see TargetSystem.applyDamage()).
  applyDamage(amount) {
    if (!this.alive) return false;

    this.health -= amount;
    this.hurtTimer = 1;
    this.onDamagedByPlayer();

    if (this.health <= 0) {
      this.alive = false;
      this.aiState = AI_STATE.DEAD;
      this.deathT = 0.0001;
      return true;
    }

    return false;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.group);
    this.healthBar.dispose();
    this.nameLabel.dispose();
    if (this.telegraphRing) {
      this.scene.remove(this.telegraphRing);
      this.telegraphRing.material.dispose();
    }
    if (this.telegraphCountdown) {
      this.scene.remove(this.telegraphCountdown);
      this.telegraphCountdown.material.dispose();
    }
    if (this.rocketProjectile) {
      this.scene.remove(this.rocketProjectile);
      this.rocketProjectile.geometry.dispose();
      this.rocketProjectile.material.dispose();
    }
  }
}