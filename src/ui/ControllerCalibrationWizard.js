import {
  deviceSignature,
  snapshotGamepad,
  summarizeSamples,
  compareCapture
} from "../input/InputDiscovery.js";
import {
  readRawControl,
  saveControllerProfile,
  validateControllerProfile,
  clearControllerProfile
} from "../input/ControllerCalibration.js";

// Unlike WheelCalibrationWizard's STEPS (fixed axis per step, since the
// V99 layout is already known), most steps here don't know which
// axis/button they're capturing until the player moves it — "detect"
// steps identify the control by diffing against the neutral baseline;
// "confirm" steps re-read a control a previous step already identified.
const STEPS = [
  {
    key: "baseline",
    kind: "baseline",
    title: "Neutral position",
    text: "Center the steering stick and release every pedal, trigger, " +
      "and button — including any paddles you plan to use for shifting."
  },
  {
    key: "steer-left",
    kind: "detect",
    mappingKey: "steering",
    axisOnly: true,
    sign: "negative",
    title: "Steer fully LEFT",
    text: "Push the steering stick (or wheel) fully to the LEFT and hold."
  },
  {
    key: "steer-right",
    kind: "confirm",
    mappingKey: "steering",
    title: "Steer fully RIGHT",
    text: "Push the steering stick (or wheel) fully to the RIGHT and hold."
  },
  {
    key: "throttle-press",
    kind: "detect",
    mappingKey: "throttle",
    title: "Press the accelerator",
    text: "Fully press the accelerator control and hold."
  },
  {
    key: "throttle-release",
    kind: "confirm",
    mappingKey: "throttle",
    title: "Release the accelerator",
    text: "Release the accelerator."
  },
  {
    key: "brake-press",
    kind: "detect",
    mappingKey: "brake",
    title: "Press the brake",
    text: "Fully press the brake control and hold."
  },
  {
    key: "brake-release",
    kind: "confirm",
    mappingKey: "brake",
    title: "Release the brake",
    text: "Release the brake."
  },
  {
    key: "handbrake-press",
    kind: "detect",
    mappingKey: "handbrake",
    title: "Apply the handbrake",
    text: "Fully apply the handbrake control and hold."
  },
  {
    key: "handbrake-release",
    kind: "confirm",
    mappingKey: "handbrake",
    title: "Release the handbrake",
    text: "Release the handbrake."
  },
  {
    key: "clutch-press",
    kind: "detect",
    mappingKey: "clutch",
    title: "Press the clutch",
    text: "Fully press the clutch control and hold."
  },
  {
    key: "clutch-release",
    kind: "confirm",
    mappingKey: "clutch",
    title: "Release the clutch",
    text: "Release the clutch."
  },
  {
    key: "gear-up",
    kind: "detect-button",
    mappingKey: "gearUp",
    title: "Shift up",
    text: "Press and hold the paddle or button you want to use for " +
      "shifting UP a gear."
  },
  {
    key: "gear-down",
    kind: "detect-button",
    mappingKey: "gearDown",
    title: "Shift down",
    text: "Press and hold the paddle or button you want to use for " +
      "shifting DOWN a gear. Must be different from the shift-up control."
  }
];

const DEADZONE = 0.05;

const ERROR_COPY = {
  "no-device": {
    title: "Controller not detected.",
    detail: "Connect a controller and press a button, then try again."
  },
  "multiple-devices": {
    title: "Multiple devices detected.",
    detail: "Disconnect the extra device and try again."
  },
  "unstable": {
    title: "Input not stable.",
    detail: "Hold the control steady and capture again."
  },
  "out-of-range": {
    title: "Input out of range.",
    detail: "Release other controls, make sure nothing is holding this " +
      "one past its normal travel, then try again."
  },
  "device-changed": {
    title: "Device changed.",
    detail: "Reconnect your controller and try again."
  },
  "interrupted": {
    title: "Calibration paused.",
    detail: "Reopen settings with the controller connected and try again."
  },
  "no-change": {
    title: "No change detected.",
    detail: "Move or press the requested control fully, and make sure " +
      "nothing else moved at the same time."
  },
  "ambiguous": {
    title: "More than one control changed.",
    detail: "Release every other control and try again, moving only the " +
      "one requested."
  },
  "same-control": {
    title: "That control is already assigned.",
    detail: "Choose a different physical control for this step."
  }
};

function friendlyError(error) {
  const copy = ERROR_COPY[error?.code];

  if (copy) return copy;

  return {
    title: "Something went wrong.",
    detail: "Try again. If this keeps happening, reopen settings."
  };
}

function taggedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Ranks compareCapture() candidates by how much they moved, on a common
// scale — axis candidates carry `.delta` already; button candidates only
// carry before/after readings, so their magnitude is computed the same way.
function magnitude(candidate) {
  return candidate.type === "axis"
    ? Math.abs(candidate.delta)
    : Math.abs(candidate.captured.value - candidate.baseline.value);
}

function controlKey(control) {
  return `${control.type}:${control.index}`;
}

export class ControllerCalibrationWizard {
  constructor(input, menu) {
    this.input = input;
    this.menu = menu;

    this.stepIndex = 0;
    this.draft = null;
    this.usedControls = null;
    this.baselineSummary = null;
    this.deviceSignature = null;
    this.deviceIndex = null;
    this.busy = false;
    this.token = 0;
    this.liveFrame = null;

    this.element = document.createElement("section");
    this.element.className = "controller-calibration wheel-calibration";

    this.element.innerHTML = `
      <h3>Controller calibration</h3>

      <p class="settings-help">
        Works with any gamepad — steering, pedals, and (optionally)
        paddle/shoulder buttons for sequential shifting are discovered by
        watching what changes as you move each control. The local game
        remains paused.
      </p>

      <div class="debug-actions">
        <button type="button" data-ccalib="begin">
          Calibrate controller
        </button>

        <button type="button" data-ccalib="clear">
          Clear saved controller profile
        </button>
      </div>

      <div data-ccalib="device-error" class="calib-error" hidden>
        <p data-ccalib="device-error-title" class="calib-error-title"></p>
        <p data-ccalib="device-error-detail"></p>
        <div class="debug-actions">
          <button type="button" data-ccalib="device-error-retry">
            Retry
          </button>
        </div>
      </div>

      <div data-ccalib="wizard" class="calib-wizard" hidden>
        <div class="calib-wizard-header">
          <span class="calib-wizard-kicker">Controller calibration</span>
          <span data-ccalib="progress" class="calib-wizard-progress"></span>
        </div>

        <div class="calib-progress-track">
          <div data-ccalib="progress-fill" class="calib-progress-fill"></div>
        </div>

        <h4 data-ccalib="title" class="calib-wizard-title"></h4>
        <p data-ccalib="instruction"></p>

        <div class="calib-live" data-ccalib="live">
          <div class="calib-live-labels">
            <span data-ccalib="live-label-start"></span>
            <span data-ccalib="live-label-end"></span>
          </div>
          <div class="calib-live-track">
            <div class="calib-live-center"></div>
            <div data-ccalib="live-dot" class="calib-live-dot"></div>
          </div>
          <p data-ccalib="live-value" class="calib-live-value">
            No signal
          </p>
        </div>

        <div class="debug-actions">
          <button type="button" data-ccalib="capture">
            Capture
          </button>

          <button type="button" data-ccalib="skip-manual" hidden>
            Skip shifting — Arcade only
          </button>

          <button type="button" data-ccalib="save" hidden>
            Save controller profile
          </button>
        </div>

        <div class="debug-actions">
          <button type="button" data-ccalib="back" disabled>
            Back
          </button>

          <button type="button" data-ccalib="cancel">
            Cancel
          </button>
        </div>
      </div>

      <p data-ccalib="status" role="status"></p>
    `;

    document.querySelector("#menu-controls").append(this.element);

    const get = name =>
      this.element.querySelector(`[data-ccalib="${name}"]`);

    this.panel = get("wizard");
    this.progress = get("progress");
    this.progressFill = get("progress-fill");
    this.titleEl = get("title");
    this.instruction = get("instruction");
    this.status = get("status");
    this.captureButton = get("capture");
    this.skipManualButton = get("skip-manual");
    this.saveButton = get("save");
    this.backButton = get("back");

    this.liveEl = get("live");
    this.liveLabelStart = get("live-label-start");
    this.liveLabelEnd = get("live-label-end");
    this.liveDot = get("live-dot");
    this.liveValue = get("live-value");

    this.deviceError = get("device-error");
    this.deviceErrorTitle = get("device-error-title");
    this.deviceErrorDetail = get("device-error-detail");

    get("begin").addEventListener("click", () => this.begin());
    get("clear").addEventListener("click", () => this.clearSaved());
    get("device-error-retry").addEventListener("click", () => this.begin());
    get("cancel").addEventListener("click", () => this.cancel());
    this.backButton.addEventListener("click", () => this.back());
    this.captureButton.addEventListener("click", () => this.capture());
    this.skipManualButton.addEventListener("click", () => this.skipManual());
    this.saveButton.addEventListener("click", () => this.save());

    // Same convention as WheelCalibrationWizard: unfinished work is
    // dropped if the settings dialog closes underneath it.
    this.menuObserver = new MutationObserver(() => {
      if (this.menu.element.hidden && this.draft) {
        this.cancel();
      }
    });

    this.menuObserver.observe(this.menu.element, {
      attributes: true,
      attributeFilter: ["hidden"]
    });
  }

  // Any connected gamepad is a candidate to calibrate — unlike the V99
  // wizard's selectedPad(), there's no layout to filter by yet. Locks
  // onto whichever device answers the FIRST capture (the baseline step)
  // and requires every step after that to come from the same device.
  selectedPad() {
    const pads = this.input.getGamepads();

    if (!this.deviceSignature) {
      if (pads.length === 0) {
        throw taggedError("No controller detected.", "no-device");
      }

      if (pads.length > 1) {
        throw taggedError(
          "More than one controller is connected. Disconnect all but " +
          "the one you want to calibrate.",
          "multiple-devices"
        );
      }

      return pads[0];
    }

    const pad = pads.find(candidate => candidate.index === this.deviceIndex);

    if (!pad) {
      throw taggedError(
        "Controller disconnected mid-calibration.",
        "device-changed"
      );
    }

    return pad;
  }

  showDeviceError(error) {
    const { title, detail } = friendlyError(error);
    this.deviceErrorTitle.textContent = title;
    this.deviceErrorDetail.textContent = detail;
    this.deviceError.hidden = false;
  }

  begin() {
    if (!this.menu.isOpen) return;

    this.deviceError.hidden = true;

    try {
      this.selectedPad();
    } catch (error) {
      this.showDeviceError(error);
      return;
    }

    this.token++;
    this.busy = false;
    this.stepIndex = 0;
    this.draft = {
      mapping: {
        steering: null, throttle: null, brake: null, handbrake: null,
        clutch: null, gearUp: null, gearDown: null
      },
      calibration: {
        steering: { left: null, center: null, right: null, deadzone: DEADZONE },
        pedals: {
          throttle: { released: null, pressed: null, deadzone: DEADZONE },
          brake: { released: null, pressed: null, deadzone: DEADZONE },
          handbrake: { released: null, pressed: null, deadzone: DEADZONE },
          clutch: { released: null, pressed: null, deadzone: DEADZONE }
        }
      }
    };
    this.usedControls = new Set();
    this.baselineSummary = null;
    this.deviceSignature = null;
    this.deviceIndex = null;
    this.manualSkipped = false;

    this.input.disarm();

    this.panel.hidden = false;
    this.status.textContent =
      "Follow each prompt and click Capture. A neutral baseline comes first.";

    this.showStep();
    this.startLiveLoop();
  }

  currentSteps() {
    return this.manualSkipped
      ? STEPS.filter(step => !["clutch-press", "clutch-release", "gear-up", "gear-down"].includes(step.key))
      : STEPS;
  }

  showStep() {
    const steps = this.currentSteps();
    const step = steps[this.stepIndex];
    const finished = !step;

    this.captureButton.hidden = finished;
    this.captureButton.disabled = false;
    this.saveButton.hidden = !finished;
    this.backButton.disabled = this.stepIndex <= 1;

    // Offer the Arcade-only shortcut right up until the clutch step
    // starts — once a manual control is captured, going back is how to
    // change your mind (mirrors the "Back re-captures" convention).
    this.skipManualButton.hidden =
      this.manualSkipped || finished || step.key !== "clutch-press";

    this.progress.textContent = finished
      ? "All steps captured"
      : `Step ${this.stepIndex + 1} of ${steps.length}`;

    this.progressFill.style.width =
      `${(Math.min(this.stepIndex, steps.length) / steps.length) * 100}%`;

    if (finished) {
      this.titleEl.textContent = "Ready to save";
      this.instruction.textContent = this.manualSkipped
        ? "All positions captured (Arcade only). Release every control."
        : "All positions captured. Release every control.";
      this.liveEl.hidden = true;
      return;
    }

    this.titleEl.textContent = step.title;
    this.instruction.textContent = step.text;

    if (step.kind === "baseline" || step.kind === "detect-button") {
      // Nothing meaningful to plot yet — the control isn't identified,
      // or (for a button) a live dot doesn't convey anything useful.
      this.liveEl.hidden = true;
      return;
    }

    if (step.kind === "detect") {
      // The whole point of a detect step is that we don't know the axis
      // yet, so there's nothing to live-plot until AFTER capture.
      this.liveEl.hidden = true;
      return;
    }

    // "confirm" steps read an already-known control — show it live,
    // exactly like WheelCalibrationWizard does for its fixed axes.
    const control = this.draft.mapping[step.mappingKey];

    if (!control) {
      this.liveEl.hidden = true;
      return;
    }

    this.liveEl.hidden = false;
    this.liveLabelStart.textContent =
      step.mappingKey === "steering" ? "Left" : "Released";
    this.liveLabelEnd.textContent =
      step.mappingKey === "steering" ? "Right" : "Pressed";
  }

  back() {
    if (!this.draft || this.stepIndex <= 1) return;

    this.stepIndex--;
    const steps = this.currentSteps();
    const step = steps[this.stepIndex];

    // Re-entering a detect step clears its previous assignment so the
    // player can point it at a different physical control if they want.
    if (step.kind === "detect" || step.kind === "detect-button") {
      const existing = this.draft.mapping[step.mappingKey];

      if (existing) {
        this.usedControls.delete(controlKey(existing));
        this.draft.mapping[step.mappingKey] = null;
      }
    }

    this.showStep();
    this.status.textContent =
      `Back to step ${this.stepIndex + 1}. Re-capture to overwrite it.`;
  }

  skipManual() {
    if (!this.draft || this.busy) return;

    this.manualSkipped = true;
    this.draft.mapping.clutch = null;
    this.draft.mapping.gearUp = null;
    this.draft.mapping.gearDown = null;

    this.showStep();
    this.status.textContent =
      "Shifting skipped — this profile will be Arcade only.";
  }

  startLiveLoop() {
    cancelAnimationFrame(this.liveFrame);

    const tick = () => {
      if (this.panel.hidden || !this.draft) return;

      const steps = this.currentSteps();
      const step = steps[this.stepIndex];
      const control = step?.kind === "confirm"
        ? this.draft.mapping[step.mappingKey]
        : null;

      if (!control) {
        this.liveFrame = requestAnimationFrame(tick);
        return;
      }

      try {
        const pad = this.selectedPad();
        const raw = readRawControl(pad, control);

        if (raw === null) {
          this.liveValue.textContent = "No signal";
          this.liveDot.style.left = "50%";
        } else {
          const percent = ((raw + 1) / 2) * 100;
          this.liveDot.style.left = `${percent}%`;
          this.liveValue.textContent = raw.toFixed(2);
        }
      } catch {
        this.liveValue.textContent = "No signal";
      }

      this.liveFrame = requestAnimationFrame(tick);
    };

    this.liveFrame = requestAnimationFrame(tick);
  }

  stopLiveLoop() {
    cancelAnimationFrame(this.liveFrame);
    this.liveFrame = null;
  }

  // Shared 7-samples-over-~0.6s capture loop, same timing/interruption
  // checks as WheelCalibrationWizard.capture(). Returns a summarizeSamples()
  // result; callers decide what to do with it (baseline / detect / confirm).
  async collectSummary(token) {
    const initialPad = this.selectedPad();

    if (!this.deviceSignature) {
      this.deviceSignature = deviceSignature(initialPad);
      this.deviceIndex = initialPad.index;
    } else if (deviceSignature(initialPad) !== this.deviceSignature) {
      throw taggedError("Device layout changed mid-calibration.", "device-changed");
    }

    const samples = [];

    for (let i = 0; i < 7; i++) {
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (
        token !== this.token ||
        !this.menu.isOpen ||
        document.hidden ||
        !document.hasFocus()
      ) {
        throw taggedError(
          "Capture interrupted. Try again with the menu open.",
          "interrupted"
        );
      }

      const pad = this.selectedPad();

      if (pad.index !== this.deviceIndex) {
        throw taggedError("Device changed during capture.", "device-changed");
      }

      samples.push(snapshotGamepad(pad));
    }

    return summarizeSamples(samples);
  }

  async capture() {
    if (this.busy || !this.draft || !this.menu.isOpen) return;

    const steps = this.currentSteps();
    const step = steps[this.stepIndex];
    if (!step) return;

    this.busy = true;
    this.captureButton.disabled = true;
    this.status.textContent = "Measuring for 0.6 seconds—hold steady…";

    const token = ++this.token;

    try {
      const summary = await this.collectSummary(token);

      if (step.kind === "baseline") {
        this.baselineSummary = summary;
        this.stepIndex++;
        this.showStep();
        this.status.textContent =
          "Baseline captured. Follow the next prompt and capture.";
        return;
      }

      if (step.kind === "detect" || step.kind === "detect-button") {
        this.applyDetectStep(step, summary);
        this.stepIndex++;
        this.showStep();
        this.status.textContent =
          `Captured. ${steps[this.stepIndex]
            ? "Move to the next control and capture."
            : "All steps done — review and save below."}`;
        return;
      }

      // "confirm": re-read the already-known control.
      this.applyConfirmStep(step, summary);
      this.stepIndex++;
      this.showStep();
      this.status.textContent =
        `Captured. ${steps[this.stepIndex]
          ? "Move to the next control and capture."
          : "All steps done — review and save below."}`;
    } catch (error) {
      if (token === this.token) {
        const { title, detail } = friendlyError(error);
        this.status.textContent = `${title} ${detail}`;
      }
    } finally {
      if (token === this.token) {
        this.busy = false;
        this.captureButton.disabled = false;
      }
    }
  }

  applyDetectStep(step, summary) {
    if (!this.baselineSummary) {
      throw taggedError("No baseline captured yet.", "interrupted");
    }

    const comparison = compareCapture(this.baselineSummary, summary);

    const candidates = comparison.candidates.filter(candidate => {
      if (step.kind === "detect-button" && candidate.type !== "button") {
        return false;
      }

      if (step.axisOnly && candidate.type !== "axis") {
        return false;
      }

      if (candidate.type === "axis" && step.sign === "negative" && !(candidate.delta < 0)) {
        return false;
      }

      if (candidate.type === "axis" && step.sign === "positive" && !(candidate.delta > 0)) {
        return false;
      }

      return !this.usedControls.has(controlKey(candidate));
    });

    if (!candidates.length) {
      throw taggedError(
        "No unused control changed during capture.",
        "no-change"
      );
    }

    candidates.sort((a, b) => magnitude(b) - magnitude(a));

    if (
      candidates.length > 1 &&
      magnitude(candidates[1]) > magnitude(candidates[0]) * 0.6
    ) {
      throw taggedError(
        "More than one control changed by a similar amount.",
        "ambiguous"
      );
    }

    const winner = candidates[0];
    const control = { type: winner.type, index: winner.index };
    const capturedValue = winner.type === "axis"
      ? winner.captured
      : winner.captured.value;

    this.draft.mapping[step.mappingKey] = control;
    this.usedControls.add(controlKey(control));

    if (step.kind === "detect-button") {
      // Digital control — no analog endpoint to record.
      return;
    }

    if (step.mappingKey === "steering") {
      const baselineValue = winner.type === "axis"
        ? this.baselineSummary.axes[control.index]
        : this.baselineSummary.buttons[control.index]?.value;

      this.draft.calibration.steering.left = capturedValue;
      this.draft.calibration.steering.center = baselineValue ?? 0;
    } else {
      this.draft.calibration.pedals[step.mappingKey].pressed = capturedValue;
    }
  }

  applyConfirmStep(step, summary) {
    const control = this.draft.mapping[step.mappingKey];

    if (!control) {
      throw taggedError(
        "That control hasn't been identified yet.",
        "interrupted"
      );
    }

    const value = control.type === "axis"
      ? summary.axes[control.index]
      : (summary.buttons[control.index]
        ? summary.buttons[control.index].value
        : null);

    if (value === null || value === undefined) {
      throw taggedError(
        "Could not get a stable reading for this control.",
        "unstable"
      );
    }

    if (step.mappingKey === "steering") {
      this.draft.calibration.steering.right = value;
    } else {
      this.draft.calibration.pedals[step.mappingKey].released = value;
    }
  }

  apply(profile) {
    const saved = saveControllerProfile(profile);

    this.input.controllerProfile = structuredClone(profile);
    this.input.disarm();

    this.status.textContent = saved
      ? "Controller profile saved. Resume, center steering, and release " +
        "every pedal before selecting it."
      : "Profile applied for this session. Browser storage was unavailable.";
  }

  save() {
    const steps = this.currentSteps();

    if (
      !this.menu.isOpen ||
      !this.draft ||
      this.busy ||
      this.stepIndex !== steps.length
    ) {
      return;
    }

    const profile = {
      deviceSignature: this.deviceSignature,
      mapping: this.draft.mapping,
      calibration: this.draft.calibration
    };

    const error = validateControllerProfile(profile);

    if (error) {
      this.status.textContent =
        `${error} Click Calibrate controller to repeat the sequence.`;
      return;
    }

    this.apply(profile);

    this.draft = null;
    this.panel.hidden = true;
    this.stopLiveLoop();
  }

  clearSaved() {
    if (!this.menu.isOpen || this.draft) return;

    this.input.controllerProfile = null;
    clearControllerProfile();

    this.status.textContent = "Saved controller profile cleared.";
  }

  cancel() {
    this.token++;
    this.busy = false;
    this.draft = null;
    this.panel.hidden = true;
    this.stopLiveLoop();

    this.status.textContent =
      "Calibration cancelled. Existing settings retained.";
  }
}
