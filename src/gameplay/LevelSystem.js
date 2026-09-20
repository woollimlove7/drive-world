import { LEVEL_CONFIG } from "../turret/TurretConfig.js";

// ---------------------------------------------------------------------------
// Player XP + level progression. addXP() is the single entry point enemy
// kills funnel through (see TargetSystem's onEnemyDestroyed in Game.js),
// which is what keeps "XP awarded exactly once per death" a property of
// the caller rather than something this class has to re-derive.
// ---------------------------------------------------------------------------
export class LevelSystem {
  constructor() {
    this.level = 1;
    this.xp = 0;

    this.onLevelUp = null; // (newLevel) => {}
    this.onXPChange = null; // () => {}
  }

  xpRequired(level = this.level) {
    return Math.round(
      LEVEL_CONFIG.baseXP * Math.pow(level, LEVEL_CONFIG.curveExponent)
    );
  }

  addXP(amount) {
    if (!Number.isFinite(amount) || amount <= 0) return;

    this.xp += amount;

    while (this.xp >= this.xpRequired()) {
      this.xp -= this.xpRequired();
      this.level += 1;
      this.onLevelUp?.(this.level);
    }

    this.onXPChange?.();
  }
}
