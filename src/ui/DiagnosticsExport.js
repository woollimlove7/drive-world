import { InputDiscoveryPanel } from "./InputDiscoveryPanel.js";

export function setupDiagnosticsExport() {
  const output = document.querySelector("#input-debug");
  const status = document.querySelector("#diagnostics-status");
  const copyButton = document.querySelector("#copy-diagnostics");
  const downloadButton = document.querySelector("#download-diagnostics");

  function captureSnapshot() {
    let diagnostics;

    try {
      diagnostics = JSON.parse(output.textContent);
    } catch {
      throw new Error(
        "Start the sandbox first, then try exporting diagnostics again."
      );
    }

    return JSON.stringify({
      capturedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      ...diagnostics
    }, null, 2);
  }

  copyButton.addEventListener("click", async () => {
    let snapshot;

    try {
      snapshot = captureSnapshot();
    } catch (error) {
      status.textContent = error.message;
      return;
    }

    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard API unavailable");
      }

      await navigator.clipboard.writeText(snapshot);

      status.textContent =
        "Diagnostics copied. You can paste them into chat.";
    } catch {
      status.textContent =
        "Clipboard access was blocked. Use Download JSON instead.";
    }
  });

  downloadButton.addEventListener("click", () => {
    let snapshot;

    try {
      snapshot = captureSnapshot();
    } catch (error) {
      status.textContent = error.message;
      return;
    }

    const blob = new Blob([snapshot], {
      type: "application/json;charset=utf-8"
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-");

    link.href = url;
    link.download = `driveworld-input-${timestamp}.json`;

    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 10000);

    status.textContent = "Diagnostics JSON download requested.";
  });

  if (!document.querySelector("#input-discovery")) {
    new InputDiscoveryPanel();
  }
}