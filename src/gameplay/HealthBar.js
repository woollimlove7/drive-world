import * as THREE from "three";

// ---------------------------------------------------------------------------
// A lightweight, camera-facing HP bar rendered as plane meshes (dark
// backing + colored fill) directly in the Three.js scene -- no DOM, no
// per-instance canvas/texture allocation, no per-frame Vector3 churn.
//
// Geometry is created once at module scope and shared by every bar
// (enemies, boss, player); only each bar's own material clones (for
// independent color/opacity) and its Group transform are per-instance,
// matching the pattern already used by Target.js / TurretEffects.js.
//
// Optional `showBattery: true` turns this into a compact *stacked* vehicle
// status display (HP on top, battery directly underneath, same width) --
// used only by the player's bar (see Game.js). Enemy/remote bars never
// pass this option, so their construction, geometry, and per-frame API
// (setRatio/updateTransform/setVisible/dispose) are completely unchanged.
// ---------------------------------------------------------------------------

let sharedAssets = null;

function getSharedAssets() {
  if (sharedAssets) return sharedAssets;

  const bgGeometry = new THREE.PlaneGeometry(1, 1);

  // Fill plane's local origin sits at its own left edge (rather than
  // center) so scaling it on X shrinks the bar from the right instead of
  // from both sides at once, like a real health bar.
  const fillGeometry = new THREE.PlaneGeometry(1, 1);
  fillGeometry.translate(0.5, 0, 0);

  const bgMaterial = new THREE.MeshBasicMaterial({
    color: 0x0c1420,
    transparent: true,
    opacity: 0.85,
    depthWrite: false
  });

  const fillMaterial = new THREE.MeshBasicMaterial({
    color: 0x3ddc84,
    transparent: true,
    depthWrite: false
  });

  // A soft additive glow plane, reused for both the hit-flash pulse and
  // the charging sweep highlight -- one extra shared geometry/material
  // definition, cloned per-instance only where actually used (showBattery
  // bars), never allocated per frame.
  const glowMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });

  sharedAssets = { bgGeometry, fillGeometry, bgMaterial, fillMaterial, glowMaterial };
  return sharedAssets;
}

// Battery fill color by BatterySystem state -- a small fixed palette
// (rather than HP's continuous hue ramp) so "low/critical/empty" reads as
// a distinct, recognizable warning color rather than a fuzzy gradient.
const BATTERY_COLOR = {
  full: 0x53d8ff,
  normal: 0x53d8ff,
  low: 0xffc24d,
  critical: 0xff5a45,
  empty: 0x3a2222
};

export class HealthBar {
  constructor(scene, {
    width = 1.5,
    height = 0.16,
    yOffset = 1.25,
    showBattery = false,
    barGap = 0.05
  } = {}) {
    const assets = getSharedAssets();

    this.scene = scene;
    this.width = width;
    this.height = height;
    this.yOffset = yOffset;
    this.disposed = false;
    this.showBattery = showBattery;

    // Displayed (smoothed) ratio vs. the last value setRatio() was told to
    // reach -- updateTransform() eases the displayed value toward the
    // target each call instead of snapping instantly, per the "smooth
    // interpolation when the value changes" requirement. Enemy bars get
    // this too (it's cheap and reads better everywhere), with no change
    // to their call signature.
    this._targetRatio = 1;
    this._displayRatio = 1;
    this._hitFlash = 0;

    this.group = new THREE.Group();
    this.group.renderOrder = 15;
    this.group.visible = false; // hidden until the first setRatio() call

    this.bg = new THREE.Mesh(assets.bgGeometry, assets.bgMaterial.clone());
    this.bg.renderOrder = 15;
    this.bg.scale.set(width + 0.05, height + 0.05, 1);
    this.bg.position.x = 0;

    this.fill = new THREE.Mesh(assets.fillGeometry, assets.fillMaterial.clone());
    this.fill.renderOrder = 16;
    this.fill.scale.set(width, height, 1);
    this.fill.position.x = -width / 2;

    this.group.add(this.bg, this.fill);

    // Hit-flash: a thin additive overlay on top of the fill, faded in on a
    // sudden HP drop and eased back out -- a subtle "ouch" without any new
    // per-frame allocation (same shared glow material/geometry, just a
    // clone).
    this.hitFlashMesh = new THREE.Mesh(assets.fillGeometry, assets.glowMaterial.clone());
    this.hitFlashMesh.renderOrder = 17;
    this.hitFlashMesh.scale.set(width, height, 1);
    this.hitFlashMesh.position.x = -width / 2;
    this.group.add(this.hitFlashMesh);

    if (showBattery) {
      this._batteryTargetRatio = 1;
      this._batteryDisplayRatio = 1;
      this._batteryState = "full";
      this._charging = false;
      this._chargeAnimTime = 0;

      const batteryY = -(height / 2 + barGap + height / 2);

      this.batteryBg = new THREE.Mesh(assets.bgGeometry, assets.bgMaterial.clone());
      this.batteryBg.renderOrder = 15;
      this.batteryBg.scale.set(width + 0.05, height + 0.05, 1);
      this.batteryBg.position.y = batteryY;

      this.batteryFill = new THREE.Mesh(assets.fillGeometry, assets.fillMaterial.clone());
      this.batteryFill.renderOrder = 16;
      this.batteryFill.material.color.setHex(BATTERY_COLOR.full);
      this.batteryFill.scale.set(width, height, 1);
      this.batteryFill.position.set(-width / 2, batteryY, 0);

      // Charging sweep: a narrow bright band that travels left-to-right
      // across the battery fill while charging, plus a soft pulsing glow
      // over the whole battery bar -- both reuse the shared glow asset,
      // both fully inert (opacity 0, no per-frame cost beyond a scalar
      // lerp) whenever charging is false.
      this.chargeGlow = new THREE.Mesh(assets.fillGeometry, assets.glowMaterial.clone());
      this.chargeGlow.renderOrder = 17;
      this.chargeGlow.material.color.setHex(0x9be8ff);
      this.chargeGlow.scale.set(width, height, 1);
      this.chargeGlow.position.set(-width / 2, batteryY, 0);

      this.chargeSweep = new THREE.Mesh(assets.bgGeometry, assets.glowMaterial.clone());
      this.chargeSweep.renderOrder = 18;
      this.chargeSweep.material.color.setHex(0xe8fbff);
      const sweepWidth = Math.max(0.06, width * 0.18);
      this.chargeSweep.scale.set(sweepWidth, height * 0.92, 1);
      this.chargeSweep.position.y = batteryY;

      this.group.add(
        this.batteryBg, this.batteryFill, this.chargeGlow, this.chargeSweep
      );
    }

    scene.add(this.group);
  }

  // ratio in [0, 1]. Green -> yellow -> red as the bar drains. Sets the
  // *target* the bar eases toward (see updateTransform) rather than
  // snapping the fill immediately.
  setRatio(ratio) {
    const r = Math.max(0, Math.min(1, ratio));

    // A sudden drop (damage) triggers the hit-flash; healing/regen or a
    // tiny float-noise wobble does not.
    if (r < this._targetRatio - 0.001) {
      this._hitFlash = 1;
    }

    this._targetRatio = r;
    this.group.visible = r > 0;
  }

  // Battery HP-style status. No-op if this bar wasn't constructed with
  // showBattery: true (enemy/remote bars simply never call this).
  setBatteryStatus(ratio, state = "normal", charging = false) {
    if (!this.showBattery) return;
    this._batteryTargetRatio = Math.max(0, Math.min(1, ratio));
    this._batteryState = state;
    this._charging = !!charging;
  }

  // anchorWorldPos: THREE.Vector3 in world space (e.g. an enemy's or the
  // vehicle's current position). camera: the active render camera, so the
  // bar can billboard toward it every frame without its own lookAt math.
  // dt: optional frame delta (seconds) for the smoothing/animation below --
  // existing callers that don't pass it still work, just with a sane
  // fixed-step fallback instead of true frame-rate independence.
  updateTransform(anchorWorldPos, camera, dt = 1 / 60) {
    const step = Math.max(0, Math.min(0.1, Number.isFinite(dt) ? dt : 1 / 60));

    // Smooth HP interpolation -- exponential ease toward the target so a
    // damage/heal step visibly animates rather than popping.
    const hpLerp = 1 - Math.pow(0.001, step);
    this._displayRatio += (this._targetRatio - this._displayRatio) * hpLerp;
    if (Math.abs(this._displayRatio - this._targetRatio) < 0.0015) {
      this._displayRatio = this._targetRatio;
    }

    this.fill.scale.x = Math.max(0.0001, this.width * this._displayRatio);
    this.fill.material.color.setHSL(this._displayRatio * 0.33, 0.85, 0.5);

    // Hit-flash: quick fade back to 0 after a damage tick set it to 1.
    this._hitFlash = Math.max(0, this._hitFlash - step / 0.35);
    this.hitFlashMesh.scale.x = this.fill.scale.x;
    this.hitFlashMesh.material.opacity = this._hitFlash * 0.5;

    if (this.showBattery) {
      const battLerp = 1 - Math.pow(0.0005, step);
      this._batteryDisplayRatio +=
        (this._batteryTargetRatio - this._batteryDisplayRatio) * battLerp;
      if (Math.abs(this._batteryDisplayRatio - this._batteryTargetRatio) < 0.0015) {
        this._batteryDisplayRatio = this._batteryTargetRatio;
      }

      const baseColor = BATTERY_COLOR[this._batteryState] ?? BATTERY_COLOR.normal;
      this.batteryFill.material.color.setHex(baseColor);
      this.batteryFill.scale.x = Math.max(
        0.0001, this.width * this._batteryDisplayRatio
      );

      // Critical battery: a slow urgent pulse on the fill's own opacity
      // rather than a whole new mesh.
      if (this._batteryState === "critical" && !this._charging) {
        this._chargeAnimTime += step;
        this.batteryFill.material.opacity =
          0.65 + Math.sin(this._chargeAnimTime * 6) * 0.35;
      } else {
        this.batteryFill.material.opacity = 1;
      }

      if (this._charging) {
        this._chargeAnimTime += step;

        // Soft pulsing glow over the whole bar.
        this.chargeGlow.scale.x = this.batteryFill.scale.x;
        this.chargeGlow.material.opacity =
          0.18 + (Math.sin(this._chargeAnimTime * 5) * 0.5 + 0.5) * 0.22;

        // A bright band sweeping left -> right, looping, clipped to the
        // current fill width so it never spills past the actual charge
        // level.
        const sweepSpan = this.batteryFill.scale.x + this.chargeSweep.scale.x;
        const t = (this._chargeAnimTime * 0.7) % 1;
        this.chargeSweep.position.x =
          -this.width / 2 - this.chargeSweep.scale.x / 2 + t * sweepSpan;
        this.chargeSweep.material.opacity =
          this.batteryFill.scale.x > 0.01 ? 0.85 : 0;
        this.chargeSweep.visible = true;
        this.chargeGlow.visible = true;
      } else {
        this.chargeGlow.material.opacity = 0;
        this.chargeSweep.visible = false;
        this.chargeGlow.visible = false;
      }
    }

    this.group.position.set(
      anchorWorldPos.x,
      anchorWorldPos.y + this.yOffset,
      anchorWorldPos.z
    );
    this.group.quaternion.copy(camera.quaternion);
  }

  setVisible(visible) {
    this.group.visible = visible && this.fill.scale.x > 0.0001;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.group);
    this.bg.material.dispose();
    this.fill.material.dispose();
    this.hitFlashMesh.material.dispose();
    if (this.showBattery) {
      this.batteryBg.material.dispose();
      this.batteryFill.material.dispose();
      this.chargeGlow.material.dispose();
      this.chargeSweep.material.dispose();
    }
  }
}
