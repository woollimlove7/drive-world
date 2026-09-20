import { matchesV99Layout } from "../input/V99Profile.js";

import {
  defaultCalibration,
  validateCalibration,
  saveWheelCalibration,
  sanitizeAnalogAxis
} from "../input/WheelCalibration.js";

// `title` is the short step headline; `text` is the fuller instruction
// paragraph underneath it. `visual` picks the live-input bar's labels —
// it's purely cosmetic, not a different code path per step.
const STEPS = [
  {
    title: "Center steering",
    text: "Center the steering wheel.",
    axis: 0,
    target: ["steering", "center"],
    visual: "bipolar"
  },
  {
    title: "Turn left",
    text: "Turn the steering wheel fully LEFT.",
    axis: 0,
    target: ["steering", "left"],
    visual: "bipolar"
  },
  {
    title: "Turn right",
    text: "Turn the steering wheel fully RIGHT.",
    axis: 0,
    target: ["steering", "right"],
    visual: "bipolar"
  },
  {
    title: "Release accelerator",
    text: "Center steering and RELEASE the accelerator.",
    axis: 2,
    target: ["pedals", "throttle", "released"],
    visual: "pedal"
  },
  {
    title: "Press accelerator",
    text: "Fully PRESS the accelerator. Release other pedals.",
    axis: 2,
    target: ["pedals", "throttle", "pressed"],
    visual: "pedal"
  },
  {
    title: "Release brake",
    text: "RELEASE the brake.",
    axis: 5,
    target: ["pedals", "brake", "released"],
    visual: "pedal"
  },
  {
    title: "Press brake",
    text: "Fully PRESS the brake. Release other pedals.",
    axis: 5,
    target: ["pedals", "brake", "pressed"],
    visual: "pedal"
  },
  {
    title: "Release clutch",
    text: "RELEASE the clutch.",
    axis: 6,
    target: ["pedals", "clutch", "released"],
    visual: "pedal"
  },
  {
    title: "Press clutch",
    text: "Fully PRESS the clutch. Release other pedals.",
    axis: 6,
    target: ["pedals", "clutch", "pressed"],
    visual: "pedal"
  }
];

// Maps a thrown error's `.code` to plain-language copy so the player never
// has to decode a technical message to know what to do next. `error.message`
// (and `error.technical`, when present) is still preserved on the error
// object itself for logging, even though the UI only shows the friendly copy.
const ERROR_COPY = {
  "no-device": {
    title: "Wheel not detected.",
    detail: "Connect your steering wheel and try again."
  },
  "multiple-devices": {
    title: "Multiple compatible devices detected.",
    detail: "Disconnect the extra device and try again."
  },
  "unstable": {
    title: "Input not stable.",
    detail: "Hold the control steady and capture again."
  },
  "out-of-range": {
    title: "Input out of range.",
    detail: "Release other pedals, make sure nothing is holding the " +
      "control past its normal travel, then try again."
  },
  "device-changed": {
    title: "Device changed.",
    detail: "Reconnect your steering wheel and try again."
  },
  "interrupted": {
    title: "Calibration paused.",
    detail: "Reopen settings with the wheel connected and try again."
  }
};

function friendlyError(error) {
  const copy = ERROR_COPY[error?.code];

  if (copy) return copy;

  // Unrecognized errors still get plain-language copy — the raw message
  // is for logs/devtools, not the headline the player sees.
  return {
    title: "Something went wrong.",
    detail: "Try again. If this keeps happening, reopen settings."
  };
}

export class WheelCalibrationWizard {
  constructor(input, menu) {
    this.input = input;
    this.menu = menu;

    this.stepIndex = 0;
    this.draft = null;
    this.busy = false;
    this.token = 0;
    this.lastCaptureError = null;
    this.liveFrame = null;

    this.element = document.createElement("section");
    this.element.className = "wheel-calibration";

    this.element.innerHTML = `
      <h3>V99 steering and pedal calibration</h3>

      <p class="settings-help">
        Uses your verified axis layout. The local game remains paused.
        Keep the shifter in neutral throughout calibration.
      </p>

      <div class="debug-actions">
        <button type="button" data-calibration="begin">
          Calibrate wheel
        </button>

        <button type="button" data-calibration="defaults">
          Restore default calibration
        </button>
      </div>

      <div data-calibration="device-error" class="calib-error" hidden>
        <p data-calibration="device-error-title" class="calib-error-title">
        </p>
        <p data-calibration="device-error-detail"></p>
        <div class="debug-actions">
          <button type="button" data-calibration="device-error-retry">
            Retry
          </button>
        </div>
      </div>

      <div data-calibration="wizard" class="calib-wizard" hidden>
        <div class="calib-wizard-header">
          <span class="calib-wizard-kicker">
            Steering wheel calibration
          </span>
          <span
            data-calibration="progress"
            class="calib-wizard-progress"
          ></span>
        </div>

        <div class="calib-progress-track">
          <div
            data-calibration="progress-fill"
            class="calib-progress-fill"
          ></div>
        </div>

        <h4 data-calibration="title" class="calib-wizard-title"></h4>
        <p data-calibration="instruction"></p>

        <div class="calib-live" data-calibration="live">
          <div class="calib-live-labels">
            <span data-calibration="live-label-start"></span>
            <span data-calibration="live-label-end"></span>
          </div>
          <div class="calib-live-track">
            <div class="calib-live-center"></div>
            <div
              data-calibration="live-dot"
              class="calib-live-dot"
            ></div>
          </div>
          <p data-calibration="live-value" class="calib-live-value">
            No signal
          </p>
        </div>

        <div class="debug-actions">
          <button type="button" data-calibration="capture">
            Capture position
          </button>

          <button type="button" data-calibration="save" hidden>
            Save calibration
          </button>
        </div>

        <div class="debug-actions">
          <button type="button" data-calibration="back" disabled>
            Back
          </button>

          <button type="button" data-calibration="cancel">
            Cancel
          </button>
        </div>
      </div>

      <p data-calibration="status" role="status"></p>
    `;

    document.querySelector("#menu-controls").append(this.element);

    const get = name =>
      this.element.querySelector(
        `[data-calibration="${name}"]`
      );

    this.panel = get("wizard");
    this.progress = get("progress");
    this.progressFill = get("progress-fill");
    this.titleEl = get("title");
    this.instruction = get("instruction");
    this.status = get("status");
    this.captureButton = get("capture");
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

    get("begin").addEventListener("click", () => {
      this.begin();
    });

    get("defaults").addEventListener("click", () => {
      this.restoreDefaults();
    });

    get("device-error-retry").addEventListener("click", () => {
      this.begin();
    });

    get("cancel").addEventListener("click", () => {
      this.cancel();
    });

    this.backButton.addEventListener("click", () => {
      this.back();
    });

    this.captureButton.addEventListener("click", () => {
      this.capture();
    });

    this.saveButton.addEventListener("click", () => {
      this.save();
    });

    // Cancel unfinished work when the settings dialog closes,
    // whether closed with ESC or the Resume button.
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

  // Throws a tagged error so callers can show plain-language copy
  // (see ERROR_COPY) instead of this raw message. Detection logic itself
  // (matchesV99Layout, "exactly one device") is unchanged.
  selectedPad() {
    const candidates = this.input.getGamepads()
      .filter(matchesV99Layout);

    if (candidates.length === 0) {
      const error = new Error(
        "No matching V99 wheel detected. Press a wheel button if needed."
      );
      error.code = "no-device";
      throw error;
    }

    if (candidates.length > 1) {
      const error = new Error(
        "More than one matching V99 device is connected."
      );
      error.code = "multiple-devices";
      throw error;
    }

    return candidates[0];
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

    // Invalidate any previous timed capture.
    this.token++;

    this.busy = false;
    this.stepIndex = 0;
    this.draft = defaultCalibration();
    this.lastCaptureError = null;

    this.input.disarm();

    this.panel.hidden = false;
    this.status.textContent =
      "Hold each requested position steady, then click Capture.";

    this.showStep();
    this.startLiveLoop();
  }

  showStep() {
    const step = STEPS[this.stepIndex];
    const finished = !step;

    this.captureButton.hidden = finished;
    this.captureButton.disabled = false;
    this.saveButton.hidden = !finished;
    this.backButton.disabled = this.stepIndex === 0;

    this.progress.textContent = finished
      ? "All steps captured"
      : `Step ${this.stepIndex + 1} of ${STEPS.length}`;

    this.progressFill.style.width =
      `${(Math.min(this.stepIndex, STEPS.length) / STEPS.length) * 100}%`;

    if (finished) {
      this.titleEl.textContent = "Ready to save";
      this.instruction.textContent =
        "All positions captured. Release pedals and center steering.";
      this.liveEl.hidden = true;
      return;
    }

    this.titleEl.textContent = step.title;
    this.instruction.textContent = step.text;

    this.liveEl.hidden = false;
    this.liveLabelStart.textContent =
      step.visual === "bipolar" ? "Left" : "Released";
    this.liveLabelEnd.textContent =
      step.visual === "bipolar" ? "Right" : "Pressed";
  }

  back() {
    if (!this.draft || this.stepIndex === 0) return;

    this.stepIndex--;
    this.showStep();
    this.status.textContent =
      `Back to step ${this.stepIndex + 1}. Re-capture to overwrite it.`;
  }

  // Live raw-axis readout, independent of capture(). Reads the same
  // gamepad axis the current step will capture, so the player can see
  // the control respond before committing to a capture. Stops itself
  // (rather than throwing into the UI) if the device disappears mid-read.
  startLiveLoop() {
    cancelAnimationFrame(this.liveFrame);

    const tick = () => {
      if (this.panel.hidden || !this.draft) return;

      const step = STEPS[this.stepIndex];

      if (!step) {
        this.liveFrame = requestAnimationFrame(tick);
        return;
      }

      try {
        const pad = this.selectedPad();
        const raw = sanitizeAnalogAxis(pad.axes[step.axis]);

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

  async capture() {
    if (
      this.busy ||
      !this.draft ||
      !this.menu.isOpen
    ) {
      return;
    }

    const step = STEPS[this.stepIndex];

    if (!step) return;

    this.busy = true;
    this.captureButton.disabled = true;
    this.status.textContent =
      "Measuring for 0.6 seconds—hold steady…";

    const token = ++this.token;

    try {
      const initialPad = this.selectedPad();
      const values = [];

      for (let sample = 0; sample < 7; sample++) {
        if (sample > 0) {
          await new Promise(resolve => {
            setTimeout(resolve, 100);
          });
        }

        if (
          token !== this.token ||
          !this.menu.isOpen ||
          document.hidden ||
          !document.hasFocus()
        ) {
          const error = new Error(
            "Capture interrupted. Try again with the menu open."
          );
          error.code = "interrupted";
          throw error;
        }

        const pad = this.selectedPad();

        if (pad.index !== initialPad.index) {
          const error = new Error("Device changed during capture.");
          error.code = "device-changed";
          throw error;
        }

        const rawValue = pad.axes[step.axis];
        const value = sanitizeAnalogAxis(rawValue);

        if (value === null) {
          const details = {
            step: this.stepIndex + 1,
            axis: step.axis,
            value: String(rawValue),
            deviceId: pad.id,
            deviceIndex: pad.index,
            mapping: pad.mapping,
            axes: Array.from(
              pad.axes,
              axisValue => String(axisValue)
            )
          };

          console.error(
            "Wheel calibration rejected a raw input:",
            details
          );

          this.lastCaptureError = details;

          const error = new Error(
            `Axis ${step.axis} reported ${String(rawValue)}. ` +
            "Outside the permitted endpoint tolerance. " +
            `Raw axes: [${details.axes.join(", ")}]`
          );
          error.code = "out-of-range";
          throw error;
        }

        // Tiny overshoot is sanitized before averaging and saving.
        values.push(value);
      }

      const minimum = Math.min(...values);
      const maximum = Math.max(...values);

      if (maximum - minimum > 0.03) {
        const error = new Error(
          "The control moved during capture. Hold steady and retry."
        );
        error.code = "unstable";
        throw error;
      }

      const average =
        values.reduce((sum, value) => sum + value, 0) /
        values.length;

      let destination = this.draft;

      for (const key of step.target.slice(0, -1)) {
        destination = destination[key];
      }

      destination[step.target.at(-1)] = average;

      this.stepIndex++;
      this.showStep();

      this.status.textContent =
        `Captured: ${average.toFixed(4)}. ` +
        (STEPS[this.stepIndex]
          ? "Move to the next position and capture."
          : "All steps done — review and save below.");
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

  apply(calibration) {
    const saved = saveWheelCalibration(calibration);

    this.input.v99Calibration = structuredClone(calibration);
    this.input.disarm();

    this.status.textContent = saved
      ? "Calibration saved. Resume, center steering, " +
        "release pedals, and select neutral."
      : "Calibration applied for this session. " +
        "Browser storage was unavailable.";
  }

  save() {
    if (
      !this.menu.isOpen ||
      !this.draft ||
      this.busy ||
      this.stepIndex !== STEPS.length
    ) {
      return;
    }

    const error = validateCalibration(this.draft);

    if (error) {
      this.status.textContent =
        `${error} Click Calibrate wheel to repeat the sequence.`;
      return;
    }

    this.apply(this.draft);

    this.draft = null;
    this.panel.hidden = true;
    this.stopLiveLoop();
  }

  restoreDefaults() {
    if (!this.menu.isOpen) return;

    this.cancel();
    this.apply(defaultCalibration());
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
