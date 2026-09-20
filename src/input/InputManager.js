import {
  V99_PROFILE_ID,
  matchesV99Layout,
  readV99Input,
  isV99ReadyToArm
} from "./V99Profile.js";
import { loadWheelCalibration } from "./WheelCalibration.js";
import { loadControllerProfile } from "./ControllerCalibration.js";
import {
  matchesControllerProfile,
  readControllerInput,
  isControllerReadyToArm
} from "./ControllerProfile.js";

const STORAGE_KEY = "driveworld.controls.v1";

const clamp = (value, min, max) =>
  Math.min(
    max,
    Math.max(min, Number.isFinite(value) ? value : 0)
  );

export function normalizeInput(raw = {}) {
  return {
    steering: clamp(raw.steering, -1, 1),
    throttle: clamp(raw.throttle, 0, 1),
    brake: clamp(raw.brake, 0, 1),
    clutch: clamp(raw.clutch, 0, 1),
    handbrake: clamp(raw.handbrake, 0, 1),
    gear:
      Number.isInteger(raw.gear) &&
      raw.gear >= -1 &&
      raw.gear <= 6
        ? raw.gear
        : 0,
    gearUp: raw.gearUp === true,
    gearDown: raw.gearDown === true
  };
}

function identifyFamily(id) {
  if (/pxn.*v99/i.test(id)) return "PXN V99 candidate";
  if (/pxn.*v9\b/i.test(id)) return "PXN V9 candidate";
  if (/\bg29\b/i.test(id)) return "Logitech G29 candidate";
  return "Unrecognized device";
}

export class InputManager {
  constructor() {
    this.v99Calibration = loadWheelCalibration();
    // Unlike v99Calibration (fixed layout, only endpoints stored), a
    // generic controller's mapping is discovered per-device by the
    // calibration wizard — see ControllerCalibration.js/ControllerProfile.js.
    this.controllerProfile = loadControllerProfile();
    // Virtual sequential-shifter position for controller mode (paddle/
    // button up-down instead of an H-pattern). Starts neutral; only ever
    // touched while mode === "controller".
    this.controllerGear = 0;
    this._prevGearUpHeld = false;
    this._prevGearDownHeld = false;
    this.keys = new Set();
    this.resetRequested = false;
    this.turretToggleRequested = false;
    this.devices = [];

    this.mode = "keyboard";
    this.activeSource = "Keyboard";
    this.status = "Keyboard controls active";
    this.storageWarning = "";
    this.shifter = null;

    this.armed = false;
    this.armedIndex = null;
    this.readySince = null;

    // Mutated directly by MobileControls; sample() reads it while
    // mode === "mobile". A touch H-shifter reading is deterministic
    // (no debounce ambiguity like real hardware), so it is always valid.
    this.mobileState = {
      steering: 0,
      throttle: 0,
      brake: 0,
      clutch: 0,
      handbrake: 0
    };
    this.mobileGear = 0;

    // Turbo request state. Desktop reads straight off the held SHIFT
    // key(s) below; MobileControls sets this directly via
    // setMobileTurboHeld(), the same way it drives mobileState/mobileGear.
    // isTurboRequested() below is the single place both are combined, so
    // Game only ever asks one thing "is turbo requested right now" instead
    // of juggling two separate input sources itself.
    this.mobileTurboHeld = false;

    this.restorePreference();

    const handled = new Set([
      "KeyW", "KeyS", "KeyA", "KeyD", "Space", "KeyR", "KeyF",
      "ShiftLeft", "ShiftRight"
    ]);

    // Same convention as CameraManager: never hijack keys while the
    // player is typing into chat or another text field.
    const isEditingTarget = element =>
      element instanceof HTMLElement &&
      (
        element.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)
      );

    window.addEventListener("keydown", (event) => {
      if (!handled.has(event.code)) return;
      if (isEditingTarget(event.target)) return;

      event.preventDefault();
      this.keys.add(event.code);

      if (event.code === "KeyR" && !event.repeat) {
        this.resetRequested = true;
      }

      // Edge-triggered: only the initial keydown sets this, so holding F
      // never repeatedly toggles the turret (event.repeat guards against
      // the browser's own key-repeat firing more keydown events).
      if (event.code === "KeyF" && !event.repeat) {
        this.turretToggleRequested = true;
      }
    });

    window.addEventListener("keyup", (event) => {
      // Always release, even if focus moved to a text field mid-press,
      // so a key can never get stuck "held" in this.keys.
      if (handled.has(event.code)) event.preventDefault();
      this.keys.delete(event.code);
    });

    const clear = () => {
      this.keys.clear();
      this.resetRequested = false;
      this.turretToggleRequested = false;
      this.mobileTurboHeld = false;
      this.disarm();
    };

    window.addEventListener("blur", clear);

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) clear();
    });

    // Never retain armed state through a disconnect, even when an index
    // is later reused by a reconnected device.
    window.addEventListener("gamepaddisconnected", () => {
      this.disarm();
    });
  }

  restorePreference() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));

      if (
        saved?.version === 1 &&
        saved.mode === "v99" &&
        saved.profileId === V99_PROFILE_ID
      ) {
        this.mode = "v99";
        this.status = "Saved V99 profile restored; waiting for device";
      } else if (
        saved?.version === 1 &&
        saved.mode === "controller" &&
        this.controllerProfile
      ) {
        this.mode = "controller";
        this.status = "Saved controller profile restored; waiting for device";
      }
    } catch {
      this.storageWarning =
        "Saved settings unavailable; select a control mode again.";
    }
  }

  savePreference() {
    try {
      // This versioned profile ID refers to the complete mapping in
      // V99Profile.js. Controller mode has no equivalent fixed ID — its
      // saved profile (device signature + discovered mapping) already
      // lives under its own storage key, loaded via controllerProfile.
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        version: 1,
        mode: this.mode,
        profileId: this.mode === "v99" ? V99_PROFILE_ID : undefined
      }));

      this.storageWarning = "";
    } catch {
      this.storageWarning =
        "Storage unavailable. Selection works for this session only.";
    }
  }

  getGamepads() {
    try {
      return Array.from(navigator.getGamepads?.() ?? [])
        .filter(gamepad => gamepad?.connected);
    } catch {
      return [];
    }
  }

  enableV99() {
    const candidates = this.getGamepads().filter(matchesV99Layout);

    if (candidates.length !== 1) {
      this.status = candidates.length > 1
        ? "Multiple matching V99 devices: device selection is required."
        : "Matching V99 not visible. Press a wheel button and try again.";

      return;
    }

    this.mode = "v99";
    this.keys.clear();
    this.controllerGear = 0;
    this.disarm();
    this.savePreference();

    this.status =
      "V99 profile selected. Center wheel, release pedals, select neutral.";
  }

  // Selects a previously-calibrated generic controller (see
  // ControllerCalibrationWizard). Requires a saved profile AND exactly
  // one currently-connected device matching that profile's signature —
  // same "exactly one candidate" safety convention as enableV99().
  enableController() {
    if (!this.controllerProfile) {
      this.status =
        "No controller profile saved. Calibrate a controller first.";
      return;
    }

    const candidates = this.getGamepads()
      .filter(pad => matchesControllerProfile(pad, this.controllerProfile));

    if (candidates.length !== 1) {
      this.status = candidates.length > 1
        ? "Multiple matching controllers detected: device selection is required."
        : "Calibrated controller not visible. Press a button and try again.";

      return;
    }

    this.mode = "controller";
    this.keys.clear();
    this.controllerGear = 0;
    this.disarm();
    this.savePreference();

    this.status = this.controllerProfile.mapping.clutch
      ? "Controller profile selected. Center stick, release pedals, neutral gear."
      : "Controller profile selected. Center stick, release pedals.";
  }

  useKeyboard() {
    this.mode = "keyboard";
    this.keys.clear();
    this.controllerGear = 0;
    this.shifter = null;
    this.disarm();
    this.savePreference();
    this.activeSource = "Keyboard";
    this.status = "Keyboard controls active";
  }

  enableMobile() {
    this.mode = "mobile";
    this.keys.clear();
    this.controllerGear = 0;
    this.disarm();
    this.mobileState = {
      steering: 0, throttle: 0, brake: 0, clutch: 0, handbrake: 0
    };
    this.mobileGear = 0;
    this.mobileTurboHeld = false;
    this.activeSource = "Mobile Touch";
    this.status = "Touch controls active";
  }

  // Whether the current input source can drive Manual/Simulation mode
  // (i.e. it can provide clutch + H-shifter/sequential-gear readings).
  isManualCapable() {
    return (
      this.mode === "v99" ||
      this.mode === "mobile" ||
      (this.mode === "controller" &&
        Boolean(this.controllerProfile?.mapping.clutch))
    );
  }

  setMobileInput(partial) {
    Object.assign(this.mobileState, partial);
  }

  setMobileGear(gear) {
    this.mobileGear = gear;
  }

  // Called by MobileControls while the touch turbo button is held/released.
  setMobileTurboHeld(held) {
    this.mobileTurboHeld = held === true;
  }

  // Desktop SHIFT and the mobile turbo button both funnel through here --
  // TurboSystem.update() (see Game.js) is the only thing that actually
  // decides whether a boost happens, so this is purely "is the player
  // asking for one right now", regardless of which control they used.
  // Deliberately reads the held key directly (like keyboardInput() does)
  // rather than an edge-triggered flag, since turbo needs to stay active
  // for as long as SHIFT/the button stays down.
  isTurboRequested() {
    return (
      this.keys.has("ShiftLeft") ||
      this.keys.has("ShiftRight") ||
      this.mobileTurboHeld
    );
  }

  // Edge-triggered, same semantics as the KeyF keydown handler above (see
  // turretToggleRequested there): a single tap always requests exactly one
  // toggle, regardless of how long the mobile button is held. Feeds the
  // same consumeTurretToggle() the keyboard/gamepad paths already use, so
  // there is exactly one turret-deployment trigger in the codebase.
  requestTurretToggle() {
    this.turretToggleRequested = true;
  }

  disarm() {
    this.armed = false;
    this.armedIndex = null;
    this.readySince = null;
  }

  keyboardInput() {
    const pressed = code => Number(this.keys.has(code));

    return normalizeInput({
      steering: pressed("KeyD") - pressed("KeyA"),
      throttle: pressed("KeyW"),
      brake: pressed("KeyS"),
      handbrake: pressed("Space")
    });
  }

  sample() {
    if (this.mode === "keyboard") {
      this.activeSource = "Keyboard";
      return this.keyboardInput();
    }

    if (this.mode === "mobile") {
      // Same "unattended input on an unfocused page" guard as the wheel.
      if (document.hidden || !document.hasFocus()) {
        this.activeSource = "None — waiting";
        this.status = "Touch controls paused while the page is unfocused";
        this.shifter = null;
        return normalizeInput();
      }

      this.activeSource = "Mobile Touch";
      this.status = "Touch controls active";

      this.shifter = {
        type: "H_PATTERN",
        detected: true,
        valid: true,
        gear: this.mobileGear,
        reason: null
      };

      return normalizeInput({
        ...this.mobileState,
        gear: this.mobileGear
      });
    }

    if (this.mode === "controller") {
      return this.sampleController();
    }

    // Do not apply unattended gamepad input to an unfocused page.
    if (document.hidden || !document.hasFocus()) {
      this.disarm();
      this.activeSource = "None — waiting";
      this.status = "Wheel paused while the page is unfocused";
      return normalizeInput();
    }

    const candidates = this.getGamepads().filter(matchesV99Layout);

    if (candidates.length !== 1) {
      this.disarm();
      this.shifter = null;
      this.activeSource = "None — waiting";
      this.status = candidates.length > 1
        ? "Multiple matching devices; wheel input disabled"
        : "Waiting for saved V99 device; wheel input disabled";

      return normalizeInput();
    }

    const gamepad = candidates[0];

    if (this.armed && gamepad.index !== this.armedIndex) {
      this.disarm();
    }

    const reading = readV99Input(gamepad, this.v99Calibration);
    this.shifter = reading.shifter;

    if (!reading.valid) {
      this.disarm();
      this.activeSource = "None — invalid input";
      this.status = reading.reason;
      return normalizeInput();
    }

    if (!this.armed) {
      if (!isV99ReadyToArm(reading)) {
        this.readySince = null;
      } else {
        this.readySince ??= performance.now();

        if (performance.now() - this.readySince >= 500) {
          this.armed = true;
          this.armedIndex = gamepad.index;
        }
      }

      if (!this.armed) {
        this.activeSource = "None — safety check";
        this.status =
          "Center wheel, release ALL pedals, and select neutral for ½ second.";

        return normalizeInput();
      }
    }

    this.activeSource = "PXN V99";
    this.status = reading.shifter.valid
      ? "Saved V99 profile active · Arcade driving"
      : "Arcade driving active · conflicting/invalid shifter reading";

    return normalizeInput({
      ...reading.input,
      // Keyboard handbrake remains available until hardware is mapped.
      handbrake: Number(this.keys.has("Space"))
    });
  }

  // Mirrors the v99 branch of sample() above, but against a discovered
  // mapping instead of the fixed V99 axis layout, and with a virtual
  // sequential gear counter (paddle/button up-down) instead of reading a
  // physical H-shifter.
  sampleController() {
    if (document.hidden || !document.hasFocus()) {
      this.disarm();
      this.activeSource = "None — waiting";
      this.status = "Controller paused while the page is unfocused";
      this.shifter = null;
      return normalizeInput();
    }

    const candidates = this.getGamepads()
      .filter(pad => matchesControllerProfile(pad, this.controllerProfile));

    if (candidates.length !== 1) {
      this.disarm();
      this.shifter = null;
      this.activeSource = "None — waiting";
      this.status = candidates.length > 1
        ? "Multiple matching devices; controller input disabled"
        : "Waiting for calibrated controller; controller input disabled";

      return normalizeInput();
    }

    const gamepad = candidates[0];

    if (this.armed && gamepad.index !== this.armedIndex) {
      this.disarm();
    }

    const reading = readControllerInput(gamepad, this.controllerProfile);

    if (!reading.valid) {
      this.disarm();
      this.activeSource = "None — invalid input";
      this.status = reading.reason;
      this.shifter = null;
      return normalizeInput();
    }

    const manualCapable = Boolean(this.controllerProfile.mapping.clutch);

    // Edge-triggered, same convention as the KeyF turret toggle above:
    // only a fresh press advances the gear, so holding a paddle down
    // never repeatedly shifts.
    if (manualCapable) {
      if (reading.gearUpHeld && !this._prevGearUpHeld) {
        this.controllerGear = Math.min(6, this.controllerGear + 1);
      }
      if (reading.gearDownHeld && !this._prevGearDownHeld) {
        this.controllerGear = Math.max(-1, this.controllerGear - 1);
      }
    }
    this._prevGearUpHeld = reading.gearUpHeld;
    this._prevGearDownHeld = reading.gearDownHeld;

    this.shifter = manualCapable
      ? {
        type: "SEQUENTIAL",
        detected: true,
        valid: true,
        gear: this.controllerGear,
        reason: null
      }
      : null;

    if (!this.armed) {
      const gearForArmCheck = manualCapable ? this.controllerGear : 0;

      if (!isControllerReadyToArm(reading, gearForArmCheck)) {
        this.readySince = null;
      } else {
        this.readySince ??= performance.now();

        if (performance.now() - this.readySince >= 500) {
          this.armed = true;
          this.armedIndex = gamepad.index;
        }
      }

      if (!this.armed) {
        this.activeSource = "None — safety check";
        this.status = manualCapable
          ? "Center steering, release ALL pedals, and select neutral for ½ second."
          : "Center steering and release ALL pedals for ½ second.";

        return normalizeInput();
      }
    }

    this.activeSource = "Controller";
    this.status = manualCapable
      ? "Calibrated controller active · Realistic Prototype ready"
      : "Calibrated controller active · Arcade driving";

    return normalizeInput({
      ...reading.input,
      gear: manualCapable ? this.controllerGear : 0
    });
  }

  consumeReset() {
    const requested = this.resetRequested;
    this.resetRequested = false;
    return requested;
  }

  consumeTurretToggle() {
    const requested = this.turretToggleRequested;
    this.turretToggleRequested = false;
    return requested;
  }

  inspectDevices() {
    this.devices = this.getGamepads().map(gamepad => ({
      id: gamepad.id,
      index: gamepad.index,
      mapping: gamepad.mapping || "non-standard",
      family: identifyFamily(gamepad.id),
      status:
        (this.mode === "v99" && matchesV99Layout(gamepad)) ||
        (this.mode === "controller" &&
          matchesControllerProfile(gamepad, this.controllerProfile))
          ? this.status
          : "Diagnostic only — no enabled binding",
      axes: Array.from(
        gamepad.axes,
        value => Number(value.toFixed(3))
      ),
      invalidAnalogAxes: Array.from(gamepad.axes)
        .map((value, index) => ({ index, value }))
        .filter(({ value }) =>
          !Number.isFinite(value) || value < -1 || value > 1
        ),
      buttons: gamepad.buttons.map((button, index) => ({
        index,
        value: Number(button.value.toFixed(3)),
        pressed: button.pressed
      }))
    }));

    return this.devices;
  }
}