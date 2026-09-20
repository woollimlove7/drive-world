// Central HUD visibility model.
//
// Nothing else in the codebase should decide for itself whether it's
// visible based on "hud mode" — components stay dumb (they just render
// whatever data they're given). Visibility rules live here and in the
// [data-hud-mode] CSS in style.css, driven by a single attribute this
// module writes to <body>. That keeps "what shows in SIMPLIFIED" a single
// source of truth instead of scattered per-component checks.

const STORAGE_KEY = "driveworld.hud.v1";

export const HUD_MODES = Object.freeze(["default", "simplified", "hidden"]);

export const HUD_MODE_LABELS = Object.freeze({
  default: "DEFAULT",
  simplified: "SIMPLIFIED",
  hidden: "HIDE ALL"
});

export function sanitizeHudMode(value) {
  return HUD_MODES.includes(value) ? value : "default";
}

export function loadHudMode() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return sanitizeHudMode(stored?.version === 1 ? stored.mode : undefined);
  } catch {
    return "default";
  }
}

export function saveHudMode(mode) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1,
      mode: sanitizeHudMode(mode)
    }));
    return true;
  } catch {
    return false;
  }
}

// Applies a mode to the DOM. Everything downstream of this is a CSS rule
// scoped to body[data-hud-mode="..."] (see style.css) — this function's
// only job is to keep that attribute, persisted storage, and any listener
// (e.g. the settings menu, if it later wants to show the current value)
// in agreement.
export class HudVisibility {
  constructor({ root = document.body, onChange = null } = {}) {
    this.root = root;
    this.onChange = onChange;
    this.mode = loadHudMode();
    this.apply();
  }

  apply() {
    this.root.dataset.hudMode = this.mode;
  }

  setMode(mode) {
    const next = sanitizeHudMode(mode);
    if (next === this.mode) return;

    this.mode = next;
    this.apply();
    saveHudMode(this.mode);
    this.onChange?.(this.mode);
  }

  // DEFAULT -> SIMPLIFIED -> HIDE ALL -> DEFAULT, so a single button can
  // step through every mode without needing a menu open.
  cycle() {
    const index = HUD_MODES.indexOf(this.mode);
    this.setMode(HUD_MODES[(index + 1) % HUD_MODES.length]);
  }
}
