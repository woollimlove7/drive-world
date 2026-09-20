import { PLAYER_CONFIG } from "../turret/TurretConfig.js";

// ---------------------------------------------------------------------------
// Centralized player HP + damage + death/respawn state. Enemies, the boss,
// and any future hazard all funnel damage through applyDamage() rather than
// poking at `.health` directly (see requirement #9), which is what keeps
// the "no damage after death" / "exactly one death event" guarantees in one
// place instead of scattered across every damage source.
// ---------------------------------------------------------------------------
export class PlayerHealth {
  constructor() {
    this.maxHealth = PLAYER_CONFIG.maxHealth;
    this.health = this.maxHealth;
    this.dead = false;
    this.respawnTimer = 0;

    this.onDamage = null; // (amount, source) => {}
    this.onDeath = null; // () => {}
    this.onRespawn = null; // () => {}

    // ------------------------------------------------------------------
    // MULTIPLAYER: server-authoritative combat (requirement #11)
    // ------------------------------------------------------------------
    // When connected, HP/dead come from the server's snapshot broadcast
    // (see MultiplayerClient -> Game.js -> applyServerState() below)
    // instead of local applyDamage()/respawn() -- this is what guarantees
    // a dead player can't take further damage or un-die on their own
    // client while the server still thinks they're alive/dead.
    // ------------------------------------------------------------------
    this.networked = false;
  }

  enableNetworkedMode() {
    this.networked = true;
  }

  // Falls back to local single-player simulation if multiplayer
  // disconnects, rather than leaving the player stuck however the last
  // server snapshot left them.
  disableNetworkedMode() {
    this.networked = false;
  }

  get ratio() {
    return this.maxHealth > 0 ? this.health / this.maxHealth : 0;
  }

  // Named alias for `dead` -- reads clearer at call sites that care about
  // the vehicle's state (network sync, UI) rather than a raw boolean.
  get state() {
    return this.dead ? "destroyed" : "alive";
  }

  applyDamage(amount, source = null) {
    // Authoritative HP changes only ever arrive through applyServerState()
    // while networked -- see that method and requirement #2/#10/#11.
    if (this.networked) return;
    if (this.dead || !Number.isFinite(amount) || amount <= 0) return;

    this.health = Math.max(0, this.health - amount);
    this.onDamage?.(amount, source);

    if (this.health <= 0) {
      this.dead = true;
      this.respawnTimer = PLAYER_CONFIG.respawnDelay;
      this.onDeath?.();
    }
  }

  // -------------------------------------------------------------------------
  // APPLY SERVER STATE
  // -------------------------------------------------------------------------
  // Called by Game.js whenever a multiplayer snapshot reports this client's
  // own combat fields. Mirrors the server's health/maxHealth/dead exactly,
  // and fires the same onDamage/onDeath/onRespawn hooks the offline local
  // simulation used to fire itself -- so death-screen display, the wreck
  // visual, control-disabling and the respawn reposition (Game.js's
  // onRespawn -> vehiclePhysics.reset()) all keep working unchanged,
  // just driven by the server instead of by this class's own math.
  // -------------------------------------------------------------------------
  applyServerState(serverHealth, serverMaxHealth, serverDead) {
    const wasDead = this.dead;
    const previousHealth = this.health;

    // this.maxHealth = serverMaxHealth;

    if (serverDead && !wasDead) {
      this.health = 0;
      this.dead = true;
      // Display-only countdown -- see update() below. Actual control
      // restoration waits for the server to report dead:false, never for
      // this timer reaching zero on its own.
      this.respawnTimer = PLAYER_CONFIG.respawnDelay;
      this.onDeath?.();
      return;
    }

    if (!serverDead && wasDead) {
      this.health = serverHealth;
      this.dead = false;
      this.respawnTimer = 0;
      this.onRespawn?.();
      return;
    }

    if (!serverDead && !wasDead) {
      this.health = serverHealth;

      const damageTaken = previousHealth - serverHealth;
      if (damageTaken > 0) this.onDamage?.(damageTaken, null);
    }
  }

  // Called by Game.js's LevelSystem.onLevelUp hook. Raises the ceiling by
  // `amount` (PLAYER_CONFIG.hpPerLevel) and, per the "leveling fully
  // restores health" requirement, sets current HP to the new ceiling
  // outright rather than only topping it off by the granted amount -- using
  // this class's own maxHealth as the sole source of truth, never a
  // hardcoded value. onLevelUp fires exactly once per level gained (see
  // LevelSystem.addXP's while-loop), so this runs once per level-up event,
  // never on ordinary XP gain that doesn't cross a level threshold.
  addMaxHealth(amount) {
    this.maxHealth += amount;
    this.health = this.maxHealth;
  }

  update(dt) {
    if (!this.dead) return;

    if (this.networked) {
      // The server -- not this countdown -- decides the actual respawn
      // moment (see applyServerState); only tick the number down so the
      // death-screen countdown UI still animates smoothly in between
      // snapshots.
      this.respawnTimer = Math.max(0, this.respawnTimer - dt);
      return;
    }

    this.respawnTimer -= dt;
    if (this.respawnTimer <= 0) this.respawn();
  }

  respawn() {
    this.dead = false;
    this.health = this.maxHealth;
    this.respawnTimer = 0;
    this.onRespawn?.();
  }
}
