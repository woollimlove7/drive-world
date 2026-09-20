import { sanitizeAnalogAxis } from "./WheelCalibration.js";

export function deviceSignature(gamepad) {
  return JSON.stringify({
    id: gamepad.id,
    mapping: gamepad.mapping || "",
    axes: gamepad.axes.length,
    buttons: gamepad.buttons.length
  });
}

export function snapshotGamepad(gamepad) {
  return {
    axes: Array.from(gamepad.axes),
    buttons: gamepad.buttons.map(button => ({
      value: button.value,
      pressed: button.pressed
    }))
  };
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function spread(values) {
  return Math.max(...values) - Math.min(...values);
}

/**
 * Convert multiple samples into stable values.
 *
 * Invalid or moving controls become null. Raw samples are retained
 * separately by the discovery panel for diagnosis.
 */
export function summarizeSamples(samples) {
  if (!samples.length) {
    throw new Error("No input samples were captured.");
  }

  const axisCount = samples[0].axes.length;
  const buttonCount = samples[0].buttons.length;

  if (samples.some(sample =>
    sample.axes.length !== axisCount ||
    sample.buttons.length !== buttonCount
  )) {
    throw new Error("Device layout changed during capture.");
  }

  const excluded = [];

  const axes = Array.from({ length: axisCount }, (_, index) => {
    const values = samples.map(sample =>
      sanitizeAnalogAxis(sample.axes[index])
    );

    if (values.some(value => value === null)) {
      excluded.push({
        type: "axis",
        index,
        reason: "Invalid analog value"
      });
      return null;
    }

    if (spread(values) > 0.03) {
      excluded.push({
        type: "axis",
        index,
        reason: "Moved during capture"
      });
      return null;
    }

    return average(values);
  });

  const buttons = Array.from({ length: buttonCount }, (_, index) => {
    const readings = samples.map(sample => sample.buttons[index]);

    if (readings.some(button =>
      !button ||
      typeof button.pressed !== "boolean" ||
      !Number.isFinite(button.value) ||
      button.value < 0 ||
      button.value > 1
    )) {
      excluded.push({
        type: "button",
        index,
        reason: "Invalid button data"
      });
      return null;
    }

    const values = readings.map(button => button.value);
    const pressed = readings[0].pressed;

    if (
      spread(values) > 0.03 ||
      readings.some(button => button.pressed !== pressed)
    ) {
      excluded.push({
        type: "button",
        index,
        reason: "Moved during capture"
      });
      return null;
    }

    return {
      value: average(values),
      pressed
    };
  });

  return { axes, buttons, excluded };
}

/**
 * Report changed inputs without assigning their meaning automatically.
 * Several simultaneous changes remain several candidates.
 */
export function compareCapture(baseline, capture) {
  if (
    baseline.axes.length !== capture.axes.length ||
    baseline.buttons.length !== capture.buttons.length
  ) {
    throw new Error("Baseline and capture layouts do not match.");
  }

  const candidates = [];

  capture.axes.forEach((value, index) => {
    const before = baseline.axes[index];

    if (value === null || before === null) return;

    const delta = value - before;

    if (Math.abs(delta) >= 0.25) {
      candidates.push({
        type: "axis",
        index,
        baseline: before,
        captured: value,
        delta
      });
    }
  });

  capture.buttons.forEach((button, index) => {
    const before = baseline.buttons[index];

    if (!button || !before) return;

    const delta = button.value - before.value;

    if (
      Math.abs(delta) >= 0.25 ||
      button.pressed !== before.pressed
    ) {
      candidates.push({
        type: "button",
        index,
        baseline: before,
        captured: button
      });
    }
  });

  return {
    candidates,
    excluded: capture.excluded,
    baselineExcluded: baseline.excluded
  };
}