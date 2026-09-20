import test from "node:test";
import assert from "node:assert/strict";

import {
  HUD_MODES,
  sanitizeHudMode,
  loadHudMode,
  saveHudMode
} from "../src/ui/HudVisibility.js";

test("unknown or missing hud modes fall back to default", () => {
  assert.equal(sanitizeHudMode(undefined), "default");
  assert.equal(sanitizeHudMode(null), "default");
  assert.equal(sanitizeHudMode("full-blast"), "default");
  assert.equal(sanitizeHudMode(123), "default");
});

test("valid hud modes pass through unchanged", () => {
  for (const mode of HUD_MODES) {
    assert.equal(sanitizeHudMode(mode), mode);
  }
});

test("loadHudMode defaults to 'default' when storage is unavailable", () => {
  // No localStorage global exists in this test environment (same as
  // PresentationSettings' equivalent load/save, which this mirrors) —
  // this exercises the catch path and confirms it degrades safely.
  assert.equal(loadHudMode(), "default");
});

test("saveHudMode reports failure rather than throwing when storage is unavailable", () => {
  assert.equal(saveHudMode("simplified"), false);
});
