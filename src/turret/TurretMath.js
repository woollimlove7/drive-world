// ---------------------------------------------------------------------------
// Small, dependency-free math helpers used by the turret's pose function and
// its aiming logic. Kept separate from Turret.js so TurretPose.js (which
// must stay a pure function of "progress") never needs to import the
// stateful controller.
// ---------------------------------------------------------------------------

export const clamp01 = value => Math.max(0, Math.min(1, value));

export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// Remaps `progress` (0..1 overall) onto a sub-window [start, end], clamped.
// Used to stagger different mechanical parts within one deploy sweep.
export const phase = (progress, start, end) =>
  clamp01((progress - start) / (end - start));

export const easeOutCubic = t => 1 - Math.pow(1 - t, 3);

export const easeInOutCubic = t =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

// A slight overshoot-then-settle, used for the final mechanical "lock".
export function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

// Shortest-path angle interpolation (handles the -PI/PI wraparound), moving
// `current` toward `target` by at most `maxDelta` radians.
export function stepAngle(current, target, maxDelta) {
  let diff = target - current;
  diff = ((diff + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;

  if (Math.abs(diff) <= maxDelta) return current + diff;

  return current + Math.sign(diff) * maxDelta;
}

export function angleDifference(a, b) {
  let diff = a - b;
  diff = ((diff + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return diff;
}

export function stepToward(current, target, maxDelta) {
  if (current < target) return Math.min(target, current + maxDelta);
  if (current > target) return Math.max(target, current - maxDelta);
  return current;
}
