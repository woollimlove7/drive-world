// ---------------------------------------------------------------------------
// Drives the level-up celebration: the on-screen banner (#level-up-banner)
// and a brief pulse on the combat HUD's level label / XP bar. Owns its own
// timer rather than piggybacking on Game.js's generic showNotice()/
// noticeTimer, so the two never fight over the same text element and the
// banner can carry structured content (level, subtitle, reward list)
// instead of a single line of text.
//
// All timing constants live here so nothing is a magic number scattered
// through Game.js.
// ---------------------------------------------------------------------------

const NORMAL_DURATION = 2.6;
const EVOLUTION_DURATION = 3.4;
const HUD_PULSE_DURATION = 1.1;

export class LevelUpEffect {
  constructor({
    bannerElement,
    levelElement,
    subtitleElement,
    rewardsElement,
    combatLevelLabel,
    combatXpFill
  } = {}) {
    this.bannerElement = bannerElement ?? null;
    this.levelElement = levelElement ?? null;
    this.subtitleElement = subtitleElement ?? null;
    this.rewardsElement = rewardsElement ?? null;
    this.combatLevelLabel = combatLevelLabel ?? null;
    this.combatXpFill = combatXpFill ?? null;

    this.timer = 0;
  }

  // Restarts a CSS animation on an element by forcing a reflow -- the same
  // trick Game.js already uses for #death-screen-timer.
  _restartAnimation(element) {
    if (!element) return;
    element.style.animation = "none";
    void element.offsetWidth;
    element.style.animation = "";
  }

  // level: the new player level (number)
  // rewards: string labels for whatever actually changed this level-up
  //   (e.g. ["+ MAX HP", "+ TURRET POWER"]) -- only real, earned rewards,
  //   never invented ones.
  // evolution: true if this level-up also crossed an evolution milestone
  // evolutionLabel: e.g. "HEAVY COMBAT / DUAL GATLING GUN", shown only
  //   when evolution is true
  trigger({ level, rewards = [], evolution = false, evolutionLabel = "" }) {
    this.timer = evolution ? EVOLUTION_DURATION : NORMAL_DURATION;

    if (this.bannerElement) {
      this.bannerElement.hidden = false;
      this.bannerElement.classList.toggle("level-up-banner--evolution", evolution);
      this._restartAnimation(this.bannerElement);
    }

    if (this.levelElement) {
      this.levelElement.textContent = String(level);
    }

    if (this.subtitleElement) {
      this.subtitleElement.textContent = evolution
        ? `EVOLUTION UNLOCKED — ${evolutionLabel}`
        : "VEHICLE UPGRADED";
    }

    if (this.rewardsElement) {
      this.rewardsElement.innerHTML = rewards
        .map(reward => `<span class="level-up-reward">${reward}</span>`)
        .join("");
    }

    if (this.combatLevelLabel) {
      this.combatLevelLabel.classList.remove("combat-row-label--pulse");
      void this.combatLevelLabel.offsetWidth;
      this.combatLevelLabel.classList.add("combat-row-label--pulse");
    }

    if (this.combatXpFill) {
      this.combatXpFill.classList.remove("combat-bar-xp--levelup");
      void this.combatXpFill.offsetWidth;
      this.combatXpFill.classList.add("combat-bar-xp--levelup");
    }

    this._hudPulseTimer = HUD_PULSE_DURATION;
  }

  update(dt) {
    if (this.timer > 0) {
      this.timer = Math.max(0, this.timer - dt);
      if (this.timer === 0 && this.bannerElement) {
        this.bannerElement.hidden = true;
      }
    }

    if (this._hudPulseTimer > 0) {
      this._hudPulseTimer = Math.max(0, this._hudPulseTimer - dt);
      if (this._hudPulseTimer === 0) {
        this.combatLevelLabel?.classList.remove("combat-row-label--pulse");
        this.combatXpFill?.classList.remove("combat-bar-xp--levelup");
      }
    }
  }
}
