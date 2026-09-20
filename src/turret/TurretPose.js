import {
  phase,
  easeOutCubic,
  easeOutBack,
  clamp01
} from "./TurretMath.js";

// ---------------------------------------------------------------------------
// Applies a complete pose to a turret assembly (see TurretModel.js) as a
// pure function of:
//   - progress   : 0 (fully stowed) .. 1 (fully deployed)
//   - yaw/pitch  : current aim angles (radians), independent of progress
//   - recoil     : 0..1, decays after firing
//   - flash      : 0..1 muzzle flash opacity
//
// Because this only ever reads `progress` (never "how we got here" or "which
// direction we're moving"), calling it every frame is always safe -- reversing
// direction mid-transformation just makes progress move the other way, with
// no separate deploy/undeploy animation state to desync or corrupt.
//
// Sub-phases below stagger different mechanical parts within the overall
// sweep so panels/lift/body/barrel don't all move in lockstep.
// ---------------------------------------------------------------------------

const PANEL_OPEN_ANGLE = 1.85; // slightly past vertical -- panels swing clear

export function applyTurretPose(parts, { progress, yaw, pitch, recoil, flash }) {
  const p = clamp01(progress);

  // ---- Phase: side panels (0.00 - 0.32) ----------------------------------
  const sidePanels = easeOutCubic(phase(p, 0, 0.32));
  parts.leftPanel.rotation.z = sidePanels * PANEL_OPEN_ANGLE;
  parts.rightPanel.rotation.z = -sidePanels * PANEL_OPEN_ANGLE;

  // ---- Phase: front/rear panels (0.10 - 0.40), staggered slightly later -
  const endPanels = easeOutCubic(phase(p, 0.1, 0.4));
  parts.frontPanel.rotation.x = endPanels * PANEL_OPEN_ANGLE;
  parts.rearPanel.rotation.x = -endPanels * PANEL_OPEN_ANGLE;

  // ---- Phase: lift column rises (0.28 - 0.62) with a mechanical overshoot
  // (easeOutBack overshoots past 1 partway through, then settles back to
  // exactly 1 -- reads as the piston lifting slightly past its rest point
  // and clunking back down into the locked position).
  const liftT = easeOutBack(phase(p, 0.28, 0.62));
  parts.liftColumn.position.y = -0.16 + liftT * 0.5;

  // ---- Phase: body shell unfolds (0.42 - 0.66) ---------------------------
  const bodyT = easeOutCubic(phase(p, 0.42, 0.66));
  parts.bodyShell.scale.y = 0.35 + bodyT * 0.65;

  // ---- Phase: barrel telescopes out (0.66 - 0.9) -------------------------
  const barrelT = easeOutCubic(phase(p, 0.66, 0.9));
  parts.barrelMesh.scale.z = Math.max(0.22, 0.22 + barrelT * 0.78);

  // ---- Status light: dim red (stowed) -> pulsing amber (moving) -> green
  const statusMaterial = parts.statusLight.material;
  if (p <= 0.001) {
    statusMaterial.color.setHex(0x8a1010);
    statusMaterial.emissive.setHex(0x4a0808);
    statusMaterial.emissiveIntensity = 0.4;
  } else if (p >= 0.999) {
    statusMaterial.color.setHex(0x2fe37a);
    statusMaterial.emissive.setHex(0x1fbf5e);
    statusMaterial.emissiveIntensity = 0.9;
  } else {
    statusMaterial.color.setHex(0xf5a623);
    statusMaterial.emissive.setHex(0xc97c0a);
    statusMaterial.emissiveIntensity = 0.7;
  }

  // ---- Aiming: only meaningful once the mount has risen into place ------
  parts.turretYaw.rotation.y = yaw;
  parts.gunMountPivot.rotation.x = pitch;

  // ---- Recoil: quick kick back along the barrel's own axis ---------------
  parts.barrelGroup.position.z = 0.16 - (recoil ?? 0) * 0.09;

  // ---- Muzzle flash --------------------------------------------------------
  const flashMaterial = parts.muzzleFlash.material;
  flashMaterial.opacity = flash ?? 0;
  parts.muzzleFlash.scale.setScalar(0.7 + (flash ?? 0) * 0.6);
}
