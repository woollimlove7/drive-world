// Wraps the browser Fullscreen API behind one small state machine, in the
// same spirit as HudVisibility.js: everything that cares whether the game
// is fullscreen (the settings-menu button, the mobile landscape corner
// button, Game.js's resize handling) reads/writes through this one object
// instead of each separately polling document.fullscreenElement.
//
// This never touches pause, camera, HUD, chat, input, or multiplayer —
// it only requests/exits fullscreen on the document root and reports
// state changes via a callback.

function currentFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function requestFullscreen(element) {
  const request = element.requestFullscreen || element.webkitRequestFullscreen;
  if (!request) return Promise.reject(new Error("Fullscreen API unavailable"));

  // Safari's webkit-prefixed method doesn't return a Promise.
  const result = request.call(element);
  return result instanceof Promise ? result : Promise.resolve(result);
}

function exitFullscreenApi() {
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (!exit) return Promise.reject(new Error("Fullscreen API unavailable"));

  const result = exit.call(document);
  return result instanceof Promise ? result : Promise.resolve(result);
}

export class FullscreenManager {
  constructor({ target = document.documentElement, onChange = null } = {}) {
    this.target = target;
    this.onChange = onChange;

    // Devices like iPhone Safari expose no element-level fullscreen
    // method at all — detect support up front so callers (the settings
    // button, the mobile corner button) can hide/disable themselves
    // instead of offering a control that will silently do nothing.
    this.isSupported = Boolean(
      target.requestFullscreen || target.webkitRequestFullscreen
    );

    this.isActive = Boolean(currentFullscreenElement());

    this._handleChange = () => {
      this.isActive = Boolean(currentFullscreenElement());
      this.onChange?.(this.isActive);
    };

    document.addEventListener("fullscreenchange", this._handleChange);
    document.addEventListener("webkitfullscreenchange", this._handleChange);
  }

  async enter() {
    if (!this.isSupported || this.isActive) return;

    try {
      await requestFullscreen(this.target);
    } catch {
      // Some browsers/devices report support but still reject the
      // request (permission policy, not called from a direct user
      // gesture, etc). Fail quietly — state simply stays "not active".
    }
  }

  async exit() {
    if (!this.isActive) return;

    try {
      await exitFullscreenApi();
    } catch {
      // As above — nothing useful to surface to the player here.
    }
  }

  async toggle() {
    if (this.isActive) await this.exit();
    else await this.enter();
  }

  dispose() {
    document.removeEventListener("fullscreenchange", this._handleChange);
    document.removeEventListener("webkitfullscreenchange", this._handleChange);
  }
}
