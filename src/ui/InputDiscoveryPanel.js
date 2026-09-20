import {
  deviceSignature,
  snapshotGamepad,
  summarizeSamples,
  compareCapture
} from "../input/InputDiscovery.js";

const ACTIONS = [
  ["steering-left", "Steering fully left"],
  ["steering-right", "Steering fully right"],
  ["throttle", "Accelerator fully pressed"],
  ["brake", "Brake fully pressed"],
  ["clutch", "Clutch fully pressed"],
  ["handbrake", "Handbrake fully applied"],
  ["gear-1", "Shifter: 1st"],
  ["gear-2", "Shifter: 2nd"],
  ["gear-3", "Shifter: 3rd"],
  ["gear-4", "Shifter: 4th"],
  ["gear-5", "Shifter: 5th"],
  ["gear-6", "Shifter: 6th"],
  ["gear-reverse", "Shifter: reverse"],
  ["gear-neutral", "Shifter: return to neutral"],
  ["gear-up", "Paddle / sequential up"],
  ["gear-down", "Paddle / sequential down"],
  ["horn", "Horn button"]
];

function getGamepads() {
  try {
    return Array.from(navigator.getGamepads?.() ?? [])
      .filter(gamepad => gamepad?.connected);
  } catch {
    return [];
  }
}

function downloadJSON(value, filename) {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json;charset=utf-8"
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;

  document.body.append(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export class InputDiscoveryPanel {
  constructor() {
    this.busy = false;
    this.token = 0;
    this.report = null;

    this.element = document.createElement("details");
    this.element.id = "input-discovery";

    this.element.innerHTML = `
      <summary>Hardware discovery read only</summary>

      <p>
        Use Keyboard mode, stop the car, and select Arcade before testing.
        Discovery does not disable existing vehicle bindings.
      </p>

      <p>
        Baseline: center steering, release all pedals and buttons,
        and put the shifter in neutral.
      </p>

      <label>
        Device
        <select data-discovery="device"></select>
      </label>

      <div class="debug-actions">
        <button type="button" data-discovery="refresh">
          Refresh devices
        </button>
        <button type="button" data-discovery="baseline">
          Capture baseline
        </button>
      </div>

      <label>
        Control to identify
        <select data-discovery="action"></select>
      </label>

      <div class="debug-actions">
        <button type="button" data-discovery="capture">
          Capture held control
        </button>
        <button type="button" data-discovery="download">
          Download discovery JSON
        </button>
      </div>

      <p data-discovery="status" role="status"></p>
      <pre data-discovery="result">No captures yet.</pre>
    `;

    const get = name =>
      this.element.querySelector(`[data-discovery="${name}"]`);

    this.deviceSelect = get("device");
    this.actionSelect = get("action");
    this.status = get("status");
    this.result = get("result");

    for (const [value, label] of ACTIONS) {
      this.actionSelect.add(new Option(label, value));
    }

    const debug = document.querySelector("#debug");

    if (!debug) {
      throw new Error("Input diagnostics panel was not found.");
    }

    debug.append(this.element);

    get("refresh").addEventListener("click", () => {
      this.refreshDevices();
    });

    get("baseline").addEventListener("click", () => {
      this.capture(true);
    });

    get("capture").addEventListener("click", () => {
      this.capture(false);
    });

    get("download").addEventListener("click", () => {
      if (!this.report) {
        this.status.textContent = "Capture a baseline first.";
        return;
      }

      downloadJSON(
        this.report,
        `driveworld-discovery-${Date.now()}.json`
      );

      this.status.textContent = "Discovery report download requested.";
    });

    this.deviceSelect.addEventListener("change", () => {
      this.clearReport("Device selection changed. Capture a new baseline.");
    });

    window.addEventListener("gamepaddisconnected", () => {
      if (this.busy) {
        this.token++;
        this.setBusy(false);
        this.status.textContent =
          "Device disconnected during capture. Capture a new baseline.";
      }

      // Do not reuse a baseline across reconnects without verification.
      this.report = null;
    });

    this.refreshDevices();
  }

  setBusy(value) {
    this.busy = value;

    this.element.querySelectorAll("button, select").forEach(element => {
      element.disabled = value;
    });
  }

  clearReport(message) {
    this.token++;
    this.report = null;
    this.result.textContent = "No captures yet.";
    this.status.textContent = message;
  }

  refreshDevices() {
    if (this.busy) return;

    const previousIndex = this.deviceSelect.value;
    this.deviceSelect.replaceChildren();

    for (const pad of getGamepads()) {
      this.deviceSelect.add(new Option(
        `[${pad.index}] ${pad.id}`,
        String(pad.index)
      ));
    }

    const previousStillPresent = Array.from(this.deviceSelect.options)
      .some(option => option.value === previousIndex);

    if (previousStillPresent) {
      this.deviceSelect.value = previousIndex;
    }

    this.clearReport(
      this.deviceSelect.options.length
        ? "Select a device, then capture its neutral baseline."
        : "No devices visible. Press a wheel button, then refresh devices."
    );
  }

  selectedPad() {
    if (this.deviceSelect.value === "") {
      throw new Error("Select a browser-visible device first.");
    }

    const index = Number(this.deviceSelect.value);
    const pad = getGamepads().find(device => device.index === index);

    if (!pad) {
      throw new Error("Selected device is disconnected or unavailable.");
    }

    return pad;
  }

  async capture(isBaseline) {
    if (this.busy) return;

    if (!isBaseline && !this.report) {
      this.status.textContent = "Capture a neutral baseline first.";
      return;
    }

    this.setBusy(true);
    const token = ++this.token;

    const action = this.actionSelect.value;

    this.status.textContent =
      "Hold the requested position steady for 0.6 seconds…";

    try {
      const initialPad = this.selectedPad();
      const signature = deviceSignature(initialPad);

      if (
        !isBaseline &&
        signature !== this.report.device.signature
      ) {
        throw new Error("Device layout changed. Capture a new baseline.");
      }

      const samples = [];

      for (let i = 0; i < 7; i++) {
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }

        if (
          token !== this.token ||
          document.hidden ||
          !document.hasFocus()
        ) {
          throw new Error("Capture interrupted. Focus the game and retry.");
        }

        const pad = this.selectedPad();

        if (
          pad.index !== initialPad.index ||
          deviceSignature(pad) !== signature
        ) {
          throw new Error("Device changed during capture.");
        }

        samples.push(snapshotGamepad(pad));
      }

      const summary = summarizeSamples(samples);

      if (isBaseline) {
        this.report = {
          version: 1,
          purpose: "Discovery evidence not an enabled control profile",
          capturedAt: new Date().toISOString(),
          userAgent: navigator.userAgent,
          device: {
            id: initialPad.id,
            index: initialPad.index,
            mapping: initialPad.mapping || "",
            axisCount: initialPad.axes.length,
            buttonCount: initialPad.buttons.length,
            signature
          },
          baseline: {
            summary,
            samples
          },
          captures: {}
        };

        this.result.textContent = JSON.stringify(summary, null, 2);

        this.status.textContent =
          "Baseline captured. Now hold one named control and capture it. " +
          "Excluded inputs are listed below.";
      } else {
        const comparison = compareCapture(
          this.report.baseline.summary,
          summary
        );

        this.report.captures[action] = {
          capturedAt: new Date().toISOString(),
          summary,
          comparison,
          samples
        };

        this.result.textContent = JSON.stringify({
          action,
          ...comparison
        }, null, 2);

        this.status.textContent = comparison.candidates.length
          ? `Recorded ${comparison.candidates.length} changed input(s). ` +
            "Release the control before testing another."
          : "No significant stable change found. For neutral this may be " +
            "expected; otherwise retry and check the selected device.";
      }
    } catch (error) {
      if (token === this.token) {
        this.status.textContent = error.message;
      }
    } finally {
      if (token === this.token) {
        this.setBusy(false);
      }
    }
  }
}