import * as THREE from "three";
import * as CANNON from "cannon-es";
import { InputManager } from "../input/InputManager.js";
import { ArcadeController } from "../vehicle/ArcadeController.js";
import { VehiclePhysics } from "../vehicle/VehiclePhysics.js";
import { Vehicle } from "../vehicle/Vehicle.js";
import { createWorld } from "../world/World.js";
import { ManualController } from "../vehicle/ManualController.js";
import { CameraManager } from "../camera/CameraManager.js";
import { AudioManager } from "../audio/AudioManager.js";
import { loadPresentationSettings,savePresentationSettings } from "./PresentationSettings.js";
import { SettingsMenu } from "../ui/SettingsMenu.js";
import { VehicleFeedback } from "../vehicle/VehicleFeedback.js";
import { WheelCalibrationWizard } from "../ui/WheelCalibrationWizard.js";
import { ControllerCalibrationWizard } from "../ui/ControllerCalibrationWizard.js";
import { MobileControls } from "../ui/MobileControls.js";
import { HudVisibility, HUD_MODE_LABELS } from "../ui/HudVisibility.js";
import { DeliverySystem, DELIVERY_SYSTEM_ENABLED } from "../gameplay/DeliverySystem.js";
import { Turret } from "../turret/Turret.js";
import { TargetSystem } from "../turret/TargetSystem.js";
import { PLAYER_CONFIG } from "../turret/TurretConfig.js";
import { PlayerHealth } from "../gameplay/PlayerHealth.js";
import { LevelSystem } from "../gameplay/LevelSystem.js";
import { HealthBar } from "../gameplay/HealthBar.js";
import { LevelUpEffect } from "../gameplay/LevelUpEffect.js";
import { MANUAL_CONFIG } from "../vehicle/ManualDrivetrain.js";
import { TurboSystem, applyTurboToControls } from "../vehicle/TurboSystem.js";
import { ExhaustSystem } from "../vehicle/ExhaustSystem.js";
import { VehicleDestruction } from "../vehicle/VehicleDestruction.js";
import { getEvolutionStage, getVehicleEvolutionConfig, getTurretEvolutionConfig } from "../gameplay/EvolutionConfig.js";
import { BatterySystem, BATTERY_CONFIG, applyBatteryToControls } from "../vehicle/BatterySystem.js";
import { createChargingStation } from "../world/ChargingStation.js";
import { FullscreenManager } from "../ui/FullscreenManager.js";

// Tachometer scale for the dashboard's RPM arc. Redline comes straight
// from the manual drivetrain's own config, so the gauge always agrees
// with the drivetrain that actually revs it.
const DASH_RPM_MAX = MANUAL_CONFIG.revLimitRPM + 500;
const DASH_RPM_REDLINE = MANUAL_CONFIG.revLimitRPM;

const PLAYER_COLORS = [
  "#ef5350", "#4285f4", "#58b76b", "#f5ce47",
  "#aa70d6", "#f29b43", "#ee83bd", "#50cad5"
];

const FIXED_DT = 1 / 60;

export class Game {
  constructor(canvas) {
    this.presentationSettings = loadPresentationSettings();
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;

    this.scene = new THREE.Scene();

this.camera = new THREE.PerspectiveCamera(
  65,
  1,
  0.1,
  400
);

this.cameraRig = new CameraManager(
  this.camera,
  canvas,
  this.presentationSettings
);

this.audio = new AudioManager();

this.audio.volume =
  this.presentationSettings.masterVolume;

this.audio.engineVolume =
  this.presentationSettings.engineVolume;

this.audio.environmentVolume =
  this.presentationSettings.environmentVolume;

this.audio.effectsVolume =
  this.presentationSettings.effectsVolume;

    this.physics = new CANNON.World({
      gravity: new CANNON.Vec3(0, -9.81, 0)
    });
    this.physics.broadphase = new CANNON.SAPBroadphase(this.physics);
    this.physics.solver.iterations = 10;

    this.world = createWorld(this.scene, this.physics);

    // Safe-zone charging station -- visual + a plain distance-based zone
    // check (same technique TargetSystem.js already uses for the enemy-
    // free safe zone), not a new trigger/collision system. See
    // ChargingStation.js's header comment for the placement reasoning.
    this.chargingStation = createChargingStation(
      this.scene, this.physics, this.world.terrain
    );

    // multiplayer.js assigns this once the socket client connects, so the
    // delivery system can report completions for the session leaderboard.
    this.multiplayer = null;

    this.deliverySystem = new DeliverySystem(this.scene, this.world.terrain);

    this.deliverySystem.onDelivery = () => {
      this.multiplayer?.reportDelivery();
    };

    this.deliveryStatusElement = document.querySelector("#delivery-status");
    this.deliveryCountElement = document.querySelector("#delivery-count");

    // Delivery UI stays in the DOM (see DeliverySystem's own
    // DELIVERY_SYSTEM_ENABLED flag) but is hidden outright while the
    // mini-game is disabled, freeing HUD space instead of showing a
    // permanently-idle status line.
    if (!DELIVERY_SYSTEM_ENABLED) {
      if (this.deliveryStatusElement) this.deliveryStatusElement.style.display = "none";
      if (this.deliveryCountElement) this.deliveryCountElement.style.display = "none";
    }

    // Phase 2 replaces this local assignment with server session data.
    this.player = {
      playerId: "local",
      vehicleId: "local-car",
      vehicleColor: PLAYER_COLORS[0]
    };

    this.vehiclePhysics = new VehiclePhysics(this.physics);
this.vehiclePhysics.body.addEventListener("collide", event => {
  const impactSpeed = Math.abs(
    event.contact.getImpactVelocityAlongNormal()
  );

  this.audio.playImpact(impactSpeed);
  this.cameraRig.notifyImpact(impactSpeed);

  // Destructible map objects tag their cannon-es body with `onImpact`
  // (see world/Destructibles.js) rather than the game needing to know
  // about destructible geometry/visuals at all.
  event.body.onImpact?.(impactSpeed);
});

    this.vehicle = new Vehicle(
      this.scene, this.vehiclePhysics, this.player.vehicleColor
    );

    // Wreck visuals (charred materials, smoke/spark/flash, flickering
    // lights) driven by playerHealth.onDeath/onRespawn below.
    this.vehicleDestruction = new VehicleDestruction(this.scene, this.vehicle.root);

    // --- Turbo / boost + exhaust -----------------------------------------
    this.turbo = new TurboSystem();

    this.exhaust = new ExhaustSystem(
      this.scene, this.vehicle.root, this.vehicle.exhaustPoints
    );

    this.turboStatusElement = document.querySelector("#turbo-status");

    // --- Battery / energy ------------------------------------------------
    // onStateChange is wired up further below, once both `this.turret`
    // and `this.showNotice` exist (mirrors how playerHealth's callbacks
    // are wired after the things they depend on are constructed).
    this.battery = new BatterySystem();
    this.batteryStatusElement = document.querySelector("#battery-status");
    this.batteryFillElement = document.querySelector("#dash-battery-fill");
    this.batteryPercentElement = document.querySelector("#dash-battery-percent");
    // Edge-detection for charging start/stop audio (see the HUD update
    // block below) -- distinct from battery.onStateChange's state-machine
    // transitions, since "charging" can start/stop without crossing a
    // low/critical/full threshold (e.g. leaving the zone mid-charge).
    this._wasCharging = false;

    // --- Player HP / leveling ------------------------------------------
    this.playerHealth = new PlayerHealth();
    this.levelSystem = new LevelSystem();
    // Evolution stage is always re-derived from level (see EvolutionConfig.js)
    // -- this field just tracks "what stage did we last apply" so onLevelUp
    // below only fires the notice/rig update on an actual stage change, not
    // every single level-up (e.g. level 2->3 keeps stage 1).
    this.vehicleEvolutionStage = 0;

    // Compact stacked vehicle status display: HP on top, battery directly
    // underneath, both at roughly half the old bar's width (see
    // HealthBar.js's showBattery mode) -- one world-space widget instead
    // of a separate floating battery HUD.
    this.playerHealthBar = new HealthBar(this.scene, {
      width: 1.0, height: 0.16, yOffset: 2.3, showBattery: true
    });

    this.damageFlashAmount = 0;
    this.noticeTimer = 0;
    this.gameNoticeElement = document.querySelector("#game-notice");
    this.damageFlashElement = document.querySelector("#damage-flash");
    this.playerHpFillElement = document.querySelector("#player-hp-fill");
    this.playerHpTextElement = document.querySelector("#player-hp-text");
    this.playerLevelLabelElement = document.querySelector("#player-level-label");
    this.playerXpFillElement = document.querySelector("#player-xp-fill");
    this.playerXpTextElement = document.querySelector("#player-xp-text");
    this.bossHudElement = document.querySelector("#boss-hud");

    this.levelUpEffect = new LevelUpEffect({
      bannerElement: document.querySelector("#level-up-banner"),
      levelElement: document.querySelector("#level-up-banner-level"),
      subtitleElement: document.querySelector("#level-up-banner-subtitle"),
      rewardsElement: document.querySelector("#level-up-banner-rewards"),
      combatLevelLabel: this.playerLevelLabelElement,
      combatXpFill: this.playerXpFillElement
    });

    // --- Death screen (full destruction sequence UI) --------------------
    this.deathScreenElement = document.querySelector("#death-screen");
    this.deathScreenTimerElement = document.querySelector("#death-screen-timer");
    this.deathScreenSeconds = null;

    this.showNotice = (text, duration = 2.5) => {
      if (!this.gameNoticeElement) return;
      this.gameNoticeElement.textContent = text;
      this.gameNoticeElement.hidden = false;
      this.noticeTimer = duration;
    };

    this.showDeathScreen = () => {
      if (!this.deathScreenElement) return;
      this.deathScreenElement.hidden = false;
      this.deathScreenSeconds = null; // force the first countdown paint below
    };

    this.hideDeathScreen = () => {
      if (!this.deathScreenElement) return;
      this.deathScreenElement.hidden = true;
    };

    this.playerHealth.onDamage = (amount, source) => {
      this.damageFlashAmount = 1;
      this.audio.playImpact?.(6);
      this.cameraRig.notifyImpact(6);
    };

    this.playerHealth.onDeath = () => {
      // Stow the turret immediately (no more scanning/firing) and switch
      // the vehicle to its charred/smoking wreck look -- see
      // VehicleDestruction.js. Controls themselves are cut in the fixed
      // physics substep loop below by checking playerHealth.dead directly.
      this.turret.forceRetract();
      this.vehicleDestruction.activate(this.vehiclePhysics.body);
      this.showDeathScreen();
    };

    this.playerHealth.onRespawn = () => {
      this.vehiclePhysics.reset();
      this.controller.reset();
      this.manualController.reset();
      this.vehicleFeedback.reset();
      this.turbo.reset();
      this.battery.reset();
      this.engineStartRequested = false;
      this.cameraRig.reset();
      this.vehicleDestruction.deactivate();
      this.hideDeathScreen();
      this.showNotice("Back in the fight!", 1.5);

      // Defensive re-apply: evolution rigs never get hidden/rebuilt by the
      // wreck sequence (VehicleDestruction only darkens materials, it never
      // touches this.root's children), so the earned stage should already
      // be showing -- this is a no-op in that case (setStage/setEvolutionStage
      // are idempotent) and just guards against death/respawn ever losing or
      // replaying the evolution reveal animation.
      this.vehicle.setEvolutionStage(this.vehicleEvolutionStage, { animate: false });
      this.turret.setEvolutionStage(this.vehicleEvolutionStage, { animate: false });
      this.exhaust.setEvolutionStage(this.vehicleEvolutionStage);
    };

    this.levelSystem.onLevelUp = level => {
      // Only ever list a reward below if it actually happened this
      // level-up -- never an invented/always-shown entry.
      const rewards = [`+ MAX HP`];

      this.playerHealth.addMaxHealth(PLAYER_CONFIG.hpPerLevel);

      if (level % PLAYER_CONFIG.turretDamageLevelInterval === 0) {
        this.turret.damageMultiplier += PLAYER_CONFIG.turretDamageBonusPerInterval;
        rewards.push("+ TURRET POWER");
      }

      const newStage = getEvolutionStage(level);
      const evolved = newStage !== this.vehicleEvolutionStage;

      if (evolved) {
        this.vehicleEvolutionStage = newStage;
        this.vehicle.setEvolutionStage(newStage);
        this.turret.setEvolutionStage(newStage);
        this.exhaust.setEvolutionStage(newStage);
        rewards.push("VEHICLE EVOLUTION");
      }

      const vehicleConfig = getVehicleEvolutionConfig(newStage);
      const turretConfig = getTurretEvolutionConfig(newStage);

      this.levelUpEffect.trigger({
        level,
        rewards,
        evolution: evolved,
        evolutionLabel: `${vehicleConfig.label} / ${turretConfig.label}`
      });

      this.audio.playLevelUp({ evolution: evolved });
    };

    this.targetSystem = new TargetSystem(
      this.scene, this.world.terrain, this.world.roads, this.playerHealth
    );

    this.targetSystem.onEnemyDestroyed = target => {
      this.levelSystem.addXP(target.xpReward);
      this.audio.playEnemyDestroyed(target.kind === "boss");
      this.audio.playXpPickup();

      if (target.kind === "boss") {
        this.showNotice(`BOSS DEFEATED! +${target.xpReward} XP`, 3);
      }
    };

    // Multiplayer counterpart of onEnemyDestroyed above: enemy death itself
    // is server-authoritative and broadcast to everyone via TargetSystem's
    // "enemies" sync (which is presentation-only and does not award XP --
    // see applyServerState), but the server privately tells exactly the
    // player who landed the killing blow to award XP here, so credit for a
    // kill goes to whoever actually earned it even when multiple players
    // were damaging the same enemy (requirement #14's "shared damage" case).
    this.handleEnemyKilled = message => {
      this.levelSystem.addXP(message.xpReward);
      this.audio.playEnemyDestroyed(message.kind === "boss");
      this.audio.playXpPickup();

      if (message.kind === "boss") {
        this.showNotice(`BOSS DEFEATED! +${message.xpReward} XP`, 3);
      }
    };

    this.targetSystem.onBossSpawned = target => {
      this.showNotice(`⚠ BOSS INCOMING: ${target.name} ⚠`, 3);
      const bossNameElement = document.querySelector("#boss-name");
      if (bossNameElement) bossNameElement.textContent = target.name;
    };

    // Multiplayer connected: route locally-detected turret hits to the
    // server instead of applying damage ourselves (requirement #10) -- see
    // TargetSystem.applyDamage(). Harmless no-op via the `?.` below while
    // playing offline/not yet connected.
    this.targetSystem.onNetworkHit = (enemyId, amount) => {
      this.multiplayer?.sendTurretHit(enemyId, amount);
    };

    this.turret = new Turret(
      this.vehicle.root, this.scene, this.audio, this.player.vehicleColor
    );

    this.turretStatusElement = document.querySelector("#turret-status");

    // Battery state-change notices + the empty-battery turret cutoff.
    // Fires at most once per actual transition (see BatterySystem.js), so
    // this never spams showNotice() every tick the way a raw threshold
    // check in the HUD-update block would.
    this.battery.onStateChange = (newState, oldState) => {
      if (newState === "empty") {
        // Immediately offline the turret, same method playerHealth.onDeath
        // already uses to interrupt an in-progress deploy/cut a live one.
        this.turret.forceRetract();
        this.showNotice("BATTERY DEPLETED — TURRET OFFLINE · TURBO DISABLED", 3);
        this.audio.playBatteryWarning("empty");
      } else if (newState === "critical") {
        this.showNotice("CRITICAL BATTERY — HEAD TO A CHARGING STATION", 2.5);
        this.audio.playBatteryWarning("critical");
      } else if (newState === "low") {
        this.showNotice("LOW BATTERY", 2);
        this.audio.playBatteryWarning("low");
      } else if (newState === "full" && oldState !== "full") {
        this.showNotice("BATTERY FULLY CHARGED", 1.5);
      }
    };

    this.input = new InputManager();
    this.controller = new ArcadeController();

    this.manualController = new ManualController();
    this.vehicleFeedback = new VehicleFeedback();
this.drivingMode = "arcade";
this.engineStartRequested = false;

this.engineStateElement = document.querySelector("#engine-state");
this.drivingStatusElement = document.querySelector("#driving-status");

const arcadeButton = document.querySelector("#select-arcade");
const manualButton = document.querySelector("#select-manual");
const startEngineButton = document.querySelector("#start-engine");

arcadeButton.disabled = false;
manualButton.disabled = false;
startEngineButton.disabled = false;

arcadeButton.addEventListener("click", () => {
  this.setDrivingMode("arcade");
});

manualButton.addEventListener("click", () => {
  this.setDrivingMode("manual");
});

startEngineButton.addEventListener("click", () => {
  if (this.drivingMode !== "manual") {
    this.drivingStatusElement.textContent =
      "Engine starting is available in Realistic Prototype mode.";
    return;
  }

  this.engineStartRequested = true;
});

// Presentation controls: camera, audio, and visual vibration.
const cameraButton = document.querySelector("#camera-toggle");
const audioButton = document.querySelector("#enable-audio");
const volumeSlider = document.querySelector("#master-volume");
const vibrationCheckbox = document.querySelector("#camera-vibration");
const presentationStatus =
  document.querySelector("#presentation-status");

cameraButton.disabled = false;
audioButton.disabled = false;

cameraButton.addEventListener("click", () => {
  this.cameraRig.toggle();
});

// Fullscreen: one FullscreenManager instance is the single source of
// truth for fullscreen state. The settings-menu button and the mobile
// landscape corner button (wired up later, once this.mobileControls
// exists) both just call fullscreen.toggle() / read the onChange below —
// neither owns its own fullscreen logic.
const fullscreenButton = document.querySelector("#fullscreen-toggle");

this.fullscreen = new FullscreenManager({
  onChange: active => {
    if (fullscreenButton) {
      fullscreenButton.textContent = active ? "Exit fullscreen" : "Enter fullscreen";
    }
    this.mobileControls?.setFullscreenActive(active);

    // The viewport can change size (mobile browser chrome hides/shows,
    // device pixel dimensions differ from the pre-fullscreen layout).
    // Reuse the existing single resize handler instead of adding a
    // second one; the rAF lets the browser finish the transition first.
    requestAnimationFrame(() => this.resize());
  }
});

if (fullscreenButton) {
  if (this.fullscreen.isSupported) {
    fullscreenButton.disabled = false;
    fullscreenButton.addEventListener("click", () => this.fullscreen.toggle());
  } else {
    // Gracefully degrade on browsers/devices without the Fullscreen API
    // (e.g. iPhone Safari) instead of offering a control that can't work.
    fullscreenButton.remove();
  }
}

audioButton.addEventListener("click", async () => {
  try {
    const enabled = await this.audio.enable();

    audioButton.textContent = enabled
      ? "Resume audio"
      : "Enable audio";

    presentationStatus.textContent = enabled
      ? "Audio enabled · Driver View: C · Right-drag to look around"
      : "Audio is suspended. Click again to resume.";
  } catch (error) {
    presentationStatus.textContent =
      `Audio could not start: ${error.message}`;
  }
});

const settingsSaveStatus =
  document.querySelector("#settings-save-status");

const saveSettings = () => {
  const saved = savePresentationSettings(this.presentationSettings);

  settingsSaveStatus.textContent = saved
    ? "Settings saved on this browser."
    : "Storage unavailable. Settings apply for this session only.";
};

volumeSlider.value =
  String(this.presentationSettings.masterVolume);

vibrationCheckbox.checked =
  this.presentationSettings.vibrationEnabled;

volumeSlider.addEventListener("input", () => {
  const value = Number(volumeSlider.value);

  this.presentationSettings.masterVolume = value;
  this.audio.volume = value;
});

// Save when the user finishes adjusting, not on every slider event.
volumeSlider.addEventListener("change", saveSettings);

vibrationCheckbox.addEventListener("change", () => {
  this.presentationSettings.vibrationEnabled =
    vibrationCheckbox.checked;

  saveSettings();
});

document.querySelectorAll("[data-presentation]").forEach(slider => {
  const key = slider.dataset.presentation;

  slider.value = String(this.presentationSettings[key]);

  slider.addEventListener("input", () => {
    this.presentationSettings[key] = Number(slider.value);

    this.audio.engineVolume =
      this.presentationSettings.engineVolume;

    this.audio.environmentVolume =
      this.presentationSettings.environmentVolume;

    this.audio.effectsVolume =
      this.presentationSettings.effectsVolume;
  });

  slider.addEventListener("change", saveSettings);
});



    this.controlStatusElement =
  document.querySelector("#control-status");

const enableV99Button = document.querySelector("#enable-v99");
const keyboardButton = document.querySelector("#use-keyboard");
const mobileButton = document.querySelector("#use-mobile");
const controllerButton = document.querySelector("#use-controller");

enableV99Button.disabled = false;
keyboardButton.disabled = false;

enableV99Button.addEventListener("click", () => {
  this.input.enableV99();
  this.mobileControls?.setActive(false);
});

keyboardButton.addEventListener("click", () => {
  this.input.useKeyboard();
  this.mobileControls?.setActive(false);
});

if (mobileButton) {
  mobileButton.disabled = false;

  mobileButton.addEventListener("click", () => {
    this.input.enableMobile();
    this.mobileControls?.setActive(true);
  });
}

if (controllerButton) {
  controllerButton.disabled = false;

  controllerButton.addEventListener("click", () => {
    this.input.enableController();
    this.mobileControls?.setActive(false);
  });
}

    this.speedElement = document.querySelector("#speed");
    this.speedUnitElement = document.querySelector("#speed-unit");
    this.gearElement = document.querySelector("#gear");
    this.gearModeElement = document.querySelector("#gear-mode");
    this.rpmValueElement = document.querySelector("#dash-rpm-value");
    this.rpmFillElement = document.querySelector("#dash-rpm-fill");
    this.clutchRowElement = document.querySelector("#dash-clutch-row");
    this.clutchFillElement = document.querySelector("#dash-clutch-fill");
    this.boostFillElement = document.querySelector("#dash-boost-fill");
    this.dashElement = document.querySelector("#dash");
    this.warnHandbrakeElement = document.querySelector("#warn-handbrake");
    this.warnTractionElement = document.querySelector("#warn-traction");
    this.warnDamageElement = document.querySelector("#warn-damage");
    this.keyboardPanelElement = document.querySelector("#keyboard-panel");
    this.debugElement = document.querySelector("#input-debug");

    // Display unit toggle for the speedometer. The underlying game value
    // stays km/h everywhere (physics, audio, network) — this only affects
    // the dashboard readout.
    this.speedUnit = "mph";
    if (this.speedUnitElement) {
      this.speedUnitElement.addEventListener("click", () => {
        this.speedUnit = this.speedUnit === "mph" ? "kmh" : "mph";
        this.speedUnitElement.textContent = this.speedUnit === "mph" ? "mph" : "km/h";
      });
    }

    // The RPM arc is drawn as a stroke-dashoffset sweep around a full
    // circle. Computed from the SVG circle's own radius (r=52, matching
    // index.html) rather than getTotalLength(), since #hud is still
    // display:none at construction time and geometry queries on a
    // hidden element aren't reliable across browsers.
    if (this.rpmFillElement) {
      this.rpmArcLength = 2 * Math.PI * 52;
      this.rpmFillElement.style.strokeDasharray = String(this.rpmArcLength);
      this.rpmFillElement.style.strokeDashoffset = String(this.rpmArcLength);
    }

    this.accumulator = 0;
    this.lastTime = null;
    this.lastHudTime = -Infinity;

    this.resize = () => {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", this.resize);
    this.resize();

    this.frame = this.frame.bind(this);
    this.menu = new SettingsMenu();

    // HUD visibility (DEFAULT / SIMPLIFIED / HIDE ALL). Everything this
    // drives is a body[data-hud-mode] CSS rule (see style.css) — this
    // class only owns the mode itself, persistence, and the toggle
    // button's label. It never reaches into individual HUD elements.
    this.hudModeToggle = document.querySelector("#hud-mode-toggle");
    this.hudModeToggleLabel = document.querySelector("#hud-mode-toggle-label");
    this.hudModeRadios = document.querySelectorAll("input[name='hud-mode']");

    // Both the top-right toggle and the ESC > Display > HUD radios only
    // ever read/write through this.hudVisibility — neither owns its own
    // state, so they can't drift out of sync with each other.
    const syncHudModeControls = mode => {
      if (this.hudModeToggleLabel) {
        this.hudModeToggleLabel.textContent = `HUD: ${HUD_MODE_LABELS[mode]}`;
      }
      this.hudModeRadios.forEach(radio => {
        radio.checked = radio.value === mode;
      });
    };

    this.hudVisibility = new HudVisibility({ onChange: syncHudModeControls });
    syncHudModeControls(this.hudVisibility.mode);

    if (this.hudModeToggle) {
      this.hudModeToggle.hidden = false;
      this.hudModeToggle.addEventListener("click", () => {
        this.hudVisibility.cycle();
      });
    }

    this.hudModeRadios.forEach(radio => {
      radio.addEventListener("change", () => {
        if (radio.checked) this.hudVisibility.setMode(radio.value);
      });
    });

    this.wheelCalibrationWizard = new WheelCalibrationWizard(
  this.input,
  this.menu
);

    this.controllerCalibrationWizard = new ControllerCalibrationWizard(
  this.input,
  this.menu
);

    this.mobileControls = new MobileControls(this.input);

    // The mobile landscape corner cluster (fullscreen + camera) calls
    // back into the same systems the desktop settings menu uses — it
    // never owns fullscreen or camera state itself.
    this.mobileControls.setActions({
      onFullscreen: () => this.fullscreen.toggle(),
      onCamera: () => this.cameraRig.toggle()
    });
    this.mobileControls.setFullscreenActive(this.fullscreen.isActive);

    // Touch-primary devices default straight into touch controls;
    // desktop with a mouse/trackpad keeps the existing keyboard default.
    if (this.mobileControls.isTouchDevice) {
      this.input.enableMobile();
      this.mobileControls.setActive(true);
      this.mobileControls.setDrivingMode(this.drivingMode);
    }
  }

  setDrivingMode(mode) {
  if (this.vehiclePhysics.body.velocity.length() > 0.5) {
    this.drivingStatusElement.textContent =
      "Stop the vehicle before switching driving modes.";
    return;
  }

  if (mode === "manual" && !this.input.isManualCapable()) {
    this.drivingStatusElement.textContent =
      "Enable your V99 profile, a manual-capable controller profile, or touch controls before selecting Realistic Prototype.";
    return;
  }

  this.drivingMode = mode;
  this.controller.reset();
  this.manualController.reset();
  this.turbo.reset();
  this.engineStartRequested = false;

  if (this.dashElement) this.dashElement.dataset.mode = mode;

  this.drivingStatusElement.textContent = mode === "manual"
    ? "Manual selected. Activate wheel, select neutral, then start engine."
    : "Arcade selected.";

  this.mobileControls?.setDrivingMode(mode);
}

  start() {
    this.renderer.setAnimationLoop(this.frame);
  }

  frame(timeMs) {

    if (this.menu.isOpen) {
  this.lastTime = null;
  this.accumulator = 0;

  this.input.keys.clear();
  this.input.resetRequested = false;
  this.input.turretToggleRequested = false;
  this.input.disarm();

  if (this.audio.context) {
    this.audio.master.gain.setTargetAtTime(
      0,
      this.audio.context.currentTime,
      0.03
    );
  }

  // Keep drawing the initialized scene, but do not advance simulation.
  this.renderer.render(this.scene, this.camera);
  return;
}

    if (document.hidden) {
      this.lastTime = null;
      this.accumulator = 0;
      return;
    }

    const dt = this.lastTime === null
      ? 0
      : Math.min((timeMs - this.lastTime) / 1000, 0.1);

    this.lastTime = timeMs;
    this.accumulator += dt;

    const input = this.input.sample();

    if (
      this.input.consumeTurretToggle() &&
      !this.playerHealth.dead &&
      !this.battery.depleted
    ) {
      this.turret.toggle();
    }

if (this.input.consumeReset() && !this.playerHealth.dead) {
  /*
   * Collect the current positions of every other player.
   *
   * MultiplayerClient exposes remote vehicles through:
   * this.multiplayer.remotes
   *
   * We deliberately make this defensive because the game can also
   * run in offline/local mode.
   */
  const otherPlayerPositions = [];

  if (this.multiplayer?.remotes) {
    for (const remote of this.multiplayer.remotes.values()) {
      if (!remote) continue;

      /*
       * RemoteVehicle implementations can expose their position
       * through different properties. Try the most likely ones.
       */
      const object =
        remote.root ??
        remote.vehicle?.root ??
        remote.mesh ??
        remote.object ??
        remote.model;

      if (object?.position) {
        otherPlayerPositions.push({
          x: object.position.x,
          y: object.position.y,
          z: object.position.z
        });

        continue;
      }

      /*
       * Some remote implementations keep the latest network state.
       */
      const state =
        remote.currentState ??
        remote.state ??
        remote.targetState ??
        remote.latestState;

      if (state?.position?.length >= 3) {
        otherPlayerPositions.push({
          x: Number(state.position[0]),
          y: Number(state.position[1]),
          z: Number(state.position[2])
        });
      }
    }
  }

  /*
   * Choose a different spawn and make sure it is not too close
   * to another multiplayer player.
   */
  const respawn = this.vehiclePhysics.respawn(
    otherPlayerPositions
  );

  /*
   * Reset all driving systems.
   */
  this.controller.reset();
  this.manualController.reset();
  this.vehicleFeedback.reset();
  this.turbo.reset();
  this.battery.reset();

  this.engineStartRequested = false;

  /*
   * Reset camera position/orientation.
   */
  this.cameraRig.reset();

  /*
   * Prevent old accumulated simulation time from producing
   * a large physics jump after the teleport.
   */
  this.accumulator = 0;

  /*
   * Make sure the local visual vehicle immediately follows
   * the new physics position.
   */
  this.vehicle.sync();

  /*
   * Optional feedback.
   *
   * This lets the player know that R actually selected another
   * spawn location.
   */
  if (respawn?.minimumDistanceUsed > 0) {
    this.showNotice(
      "RESPAWNED AT A SAFE LOCATION",
      1.2
    );
  } else {
    this.showNotice(
      "RESPAWNED",
      1.2
    );
  }
}

    // Keep every remote player's collider where it's currently being
    // rendered before stepping physics against it this frame.
    this.multiplayer?.syncPhysics();

    while (this.accumulator >= FIXED_DT) {
  // "wheelActive" here means "a source capable of clutch + H-shifter
  // input is currently live" — the physical wheel or touch controls.
  const wheelActive =
    this.input.activeSource === "PXN V99" ||
    this.input.activeSource === "Mobile Touch";
  const signedSpeed = this.vehiclePhysics.signedSpeed;

  // Vehicle is destroyed: controls are fully cut. No engine start, no
  // driving-controller update (which would otherwise keep advancing
  // drivetrain/RPM state off dead input), no turbo -- just a neutral,
  // braked control set so the wreck coasts to a stop under physics like
  // any other unpowered object (see requirement #1).
  const alive = !this.playerHealth.dead;

  if (this.engineStartRequested) {
    this.engineStartRequested = false;

    if (alive && this.drivingMode === "manual") {
      this.manualController.startEngine(
        input,
        this.input.shifter,
        wheelActive
      );
    }
  }

  const controls = !alive
    ? { steeringAngle: 0, drive: 0, driveForcePerWheel: 0, brake: 1, handbrake: 0 }
    : this.drivingMode === "manual"
      ? this.manualController.update(
          input,
          signedSpeed,
          this.input.shifter,
          wheelActive,
          FIXED_DT
        )
      : this.controller.update(
          input,
          signedSpeed,
          FIXED_DT
        );

  // Battery / energy. Updated once per fixed physics substep -- same call
  // site pattern as turbo.update() just below -- so drain/charge is
  // frame-rate independent and only ever applied from this single place
  // (see requirement: avoid accidentally draining the battery multiple
  // times from multiple systems).
  //
  // "Driving" vs "idle" is a simple speed threshold off the same
  // signedSpeed already computed above for the driving controllers.
  // "Turret engaged" covers deploying/deployed/undeploying -- the servo
  // and weapon systems are drawing power through the whole transition,
  // not only once fully deployed. Charging requires the vehicle to be
  // alive, inside the charging zone, and the turret fully stowed (the
  // prompt's own recommended behavior, and what keeps "charge" and
  // "drain" mutually exclusive per tick -- see BatterySystem.js).
  const moving = Math.abs(signedSpeed) > BATTERY_CONFIG.movingSpeedThreshold;
  const turretEngaged = this.turret.state !== "undeployed";
  const inChargingZone = this.chargingStation.isInZone(
    this.vehiclePhysics.body.position
  );
  const canCharge = alive && inChargingZone && this.turret.state === "undeployed";

  const batteryState = this.battery.update(FIXED_DT, {
    moving, turretEngaged, canCharge
  });

  // Empty battery: the vehicle can still be driven, just very slowly (see
  // requirement -- never fully immobilized). Only touches drive/
  // driveForcePerWheel; braking, handbrake, and steering are untouched.
  if (batteryState.depleted) {
    applyBatteryToControls(controls, batteryState, this.battery.config);
  }

  // Turbo / boost. SHIFT (desktop) and the mobile turbo button both feed
  // isTurboRequested() (see InputManager) -- this is the single place the
  // resulting boost is actually applied to driving, whichever controller
  // produced `controls`. Only forward drive is affected -- braking,
  // handbrake, and reverse are untouched so turbo can't destabilize the
  // physics or fight the player's brakes.
  //
  // Gated on !battery.depleted: an active turbo sees `requested = false`
  // the instant the battery hits empty (battery is updated earlier this
  // same tick, above) and ends immediately via TurboSystem's own existing
  // "released" path straight into cooldown -- no change to TurboSystem.js
  // needed.
  const turboState = this.turbo.update(
    alive && !this.battery.depleted && this.input.isTurboRequested(), FIXED_DT
  );

  if (turboState.justActivated) {
    // Small camera kick on activation, reusing the existing impact-shake
    // system rather than adding a second one (see CameraManager.notifyImpact).
    this.cameraRig.notifyImpact(5);
    this.audio.playTurboStart();
  }

  if (turboState.justDeactivated) {
    this.audio.playTurboEnd();
  }

  this.cameraRig.setTurboActive(turboState.active);

  if (turboState.active) {
    applyTurboToControls(controls, turboState, this.turbo.config);
  }

  this.vehiclePhysics.applyControls(controls);
  this.physics.step(FIXED_DT);
  this.accumulator -= FIXED_DT;
}

    this.vehicle.sync();
    this.vehicle.update(dt);
    this.deliverySystem.update(this.vehiclePhysics.body.position, dt);
    this.world.destructibles.update(dt);

    this.targetSystem.update(dt, this.vehiclePhysics.body.position, this.camera, this.audio);
    this.turret.update(dt, this.targetSystem);
    this.playerHealth.update(dt);

    if (this.playerHealth.dead && this.deathScreenTimerElement) {
      const seconds = Math.max(0, Math.ceil(this.playerHealth.respawnTimer));
      if (seconds !== this.deathScreenSeconds) {
        this.deathScreenSeconds = seconds;
        this.deathScreenTimerElement.textContent = String(seconds);

        // Restart the CSS tick animation on every new second (see
        // style.css's #death-screen-timer) by forcing a reflow.
        this.deathScreenTimerElement.style.animation = "none";
        void this.deathScreenTimerElement.offsetWidth;
        this.deathScreenTimerElement.style.animation = "";
      }
    }

    this.playerHealthBar.setRatio(this.playerHealth.ratio);
    this.playerHealthBar.setBatteryStatus(
      this.battery.ratio, this.battery.state, this.battery.charging
    );
    this.playerHealthBar.updateTransform(this.vehicle.root.position, this.camera, dt);

    // Charging station coil/particle feedback -- purely visual, so it
    // only needs to run once per rendered frame (not per physics substep).
    this.chargingStation.update(
      dt, this.battery.charging, this.vehiclePhysics.body.position
    );

    // Charging start/stop is an edge (not a BatterySystem state-machine
    // transition -- see battery.onStateChange above), so it's detected
    // here against the previous frame's flag. "Complete" only fires when
    // charging stops because the battery actually reached full, not
    // merely because the player drove out of the zone.
    if (this.battery.charging && !this._wasCharging) {
      this.audio.playChargingStart();
    } else if (!this.battery.charging && this._wasCharging && this.battery.percent >= 100) {
      this.audio.playChargingComplete();
    }
    this._wasCharging = this.battery.charging;

    this.levelUpEffect.update(dt);

    if (this.bossHudElement) {
      this.bossHudElement.hidden = !this.targetSystem.bossActive;
    }

    if (this.damageFlashAmount > 0) {
      this.damageFlashAmount = Math.max(0, this.damageFlashAmount - dt / 0.4);
      if (this.damageFlashElement) {
        this.damageFlashElement.hidden = this.damageFlashAmount <= 0;
        this.damageFlashElement.style.opacity = String(this.damageFlashAmount * 0.45);
      }
    }

    if (this.noticeTimer > 0) {
      this.noticeTimer -= dt;
      if (this.noticeTimer <= 0 && this.gameNoticeElement) {
        this.gameNoticeElement.hidden = true;
      }
    }

    if (this.playerHpFillElement) {
      this.playerHpFillElement.style.width =
        `${Math.max(0, this.playerHealth.ratio * 100)}%`;
    }

    if (this.warnDamageElement) {
      this.warnDamageElement.classList.toggle(
        "dash-warn--on", this.playerHealth.ratio < 0.3
      );
    }
    if (this.playerHpTextElement) {
      this.playerHpTextElement.textContent =
        `${Math.round(this.playerHealth.health)} / ${Math.round(this.playerHealth.maxHealth)}`;
    }
    if (this.playerLevelLabelElement) {
      this.playerLevelLabelElement.textContent = `LV ${this.levelSystem.level}`;
    }
    if (this.playerXpFillElement) {
      const required = this.levelSystem.xpRequired();
      this.playerXpFillElement.style.width =
        `${Math.max(0, Math.min(100, (this.levelSystem.xp / required) * 100))}%`;
    }
    if (this.playerXpTextElement) {
      this.playerXpTextElement.textContent =
        `${Math.floor(this.levelSystem.xp)} / ${this.levelSystem.xpRequired()}`;
    }

const speed = this.vehiclePhysics.body.velocity.length();
const manual = this.drivingMode === "manual";
const drivetrain = this.manualController.drivetrain;

// Arcade does not simulate engine RPM yet.
// This value is only an audio/presentation estimate.
const presentationRPM = manual
  ? drivetrain.rpm
  : Math.min(5500, 900 + speed * 100 + input.throttle * 800);

const engineRunning = manual
  ? drivetrain.engineRunning
  : true;

const selectedGear = manual
  ? drivetrain.engagedGear
  : this.controller.direction;

const gearLabel = selectedGear === -1
  ? "R"
  : selectedGear === 0
    ? "N"
    : manual
      ? String(selectedGear)
      : "D";

const feedback = this.vehicleFeedback.update({
  manual,
  engineRunning,
  rpm: presentationRPM,
  engagedGear: selectedGear,
  clutchTorque: manual ? drivetrain.clutchTorque : 0,
  signedSpeed: this.vehiclePhysics.signedSpeed,
  suspensionLengths:
    this.vehiclePhysics.vehicle.wheelInfos.map(wheel =>
      wheel.isInContact ? wheel.suspensionLength : null
    )
}, dt);

const lugging = feedback.lugging;

// First grounded wheel is a simple initial surface estimate.
const contactWheel = this.vehiclePhysics.vehicle.wheelInfos.find(
  wheel => wheel.isInContact
);

const contactBody = contactWheel?.raycastResult.body;

const surface = contactBody?.surfaceAt
  ? contactBody.surfaceAt(contactWheel.raycastResult.hitPointWorld)
  : contactBody?.surface ?? "asphalt";

let slip = 0;

for (const wheel of this.vehiclePhysics.vehicle.wheelInfos) {
  if (!wheel.isInContact || !Number.isFinite(wheel.skidInfo)) {
    continue;
  }

  // Cannon's solver grip-limit indicator, not a true tire slip ratio.
  slip = Math.max(
    slip,
    Math.max(0, Math.min(1, 1 - wheel.skidInfo))
  );
}

if (this.warnTractionElement) {
  this.warnTractionElement.classList.toggle("dash-warn--on", slip > 0.55);
}

if (this.warnHandbrakeElement) {
  this.warnHandbrakeElement.classList.toggle(
    "dash-warn--on", input.handbrake > 0
  );
}

this.vehicle.updatePresentation({
  steering: input.steering,
  speedKmh: speed * 3.6,
  rpm: presentationRPM,
  gear: gearLabel,
  manual
}, timeMs);

this.cameraRig.update(
  this.vehicle,
  dt,
  timeMs / 1000,
  lugging,
  feedback.acceleration
);

// Refresh matrixWorld now (Three only does this during rendering) so
// ExhaustSystem emits from this frame's transform rather than last frame's.
this.vehicle.root.updateMatrixWorld();

this.exhaust.update(dt, this.camera, {
  running: engineRunning,
  boosting: this.turbo.active
});

this.vehicleDestruction.update(dt, this.camera);

this.audio.update({
  rpm: presentationRPM,
  throttle: input.throttle,
  speed: contactWheel ? speed : 0,
  engineRunning,
  gear: `${this.drivingMode}:${selectedGear}`,
  surface,
  driverView: this.cameraRig.mode === "driver",
  lugging,
  slip,
  charging: this.battery.charging
});

this.audio.playFeedback(feedback.events);

this.renderer.render(this.scene, this.camera);

    if (timeMs - this.lastHudTime >= 100) {
      const speedKmh = this.vehiclePhysics.body.velocity.length() * 3.6;
      const displaySpeed = this.speedUnit === "mph"
        ? speedKmh * 0.621371
        : speedKmh;
      this.speedElement.textContent = `${Math.round(displaySpeed)}`;

      if (this.keyboardPanelElement) {
        this.keyboardPanelElement.hidden = this.input.mode !== "keyboard";
        this.keyboardPanelElement.classList.toggle(
          "kbd-panel--minimal", speedKmh > 12
        );
      }

      if (this.input.mode === "keyboard" && this.keyboardPanelElement) {
        for (const keyEl of this.keyboardPanelElement.querySelectorAll("[data-key]")) {
          const code = keyEl.dataset.key;
          const altCode = keyEl.dataset.keyAlt;
          const active = this.input.keys.has(code) ||
            (altCode && this.input.keys.has(altCode));
          keyEl.classList.toggle("kbd-key--active", Boolean(active));
        }
      }

      // Tachometer arc + digital RPM readout share the same
      // presentationRPM already computed above for audio/vehicle
      // feedback this frame — just mapped onto the gauge's sweep.
      if (this.rpmFillElement && this.rpmArcLength) {
        const frac = Math.max(0, Math.min(1, presentationRPM / DASH_RPM_MAX));

        this.rpmFillElement.style.strokeDashoffset =
          String(this.rpmArcLength * (1 - frac));

        this.rpmFillElement.classList.toggle(
          "dash-rpm-redline",
          presentationRPM >= DASH_RPM_REDLINE
        );
      }

      if (this.rpmValueElement) {
        this.rpmValueElement.textContent = `${Math.round(presentationRPM)} RPM`;
      }

      if (this.drivingMode === "manual") {
  const drivetrain = this.manualController.drivetrain;
  const state = this.manualController.telemetry;

  const gearLabel = gear =>
    gear === -1 ? "R" : gear === 0 ? "N" : String(gear);

  this.gearElement.textContent = gearLabel(drivetrain.engagedGear);
  if (this.gearModeElement) this.gearModeElement.textContent = "MANUAL";

  this.engineStateElement.textContent =
    drivetrain.engineRunning ? "RUNNING" : "STOPPED";

  this.engineStateElement.classList.toggle(
    "dash-engine-pill--off",
    !drivetrain.engineRunning
  );

  if (this.clutchRowElement) this.clutchRowElement.hidden = false;

  if (this.clutchFillElement) {
    this.clutchFillElement.style.width =
      `${Math.round(input.clutch * 100)}%`;
  }

  this.drivingStatusElement.textContent =
    state?.message ?? drivetrain.message;
} else {
  this.gearElement.textContent =
    this.controller.direction === -1 ? "R" : "D";

  if (this.gearModeElement) this.gearModeElement.textContent = "ARCADE";

  this.engineStateElement.textContent = "RUNNING";
  this.engineStateElement.classList.remove("dash-engine-pill--off");

  if (this.clutchRowElement) this.clutchRowElement.hidden = true;
}

      this.controlStatusElement.textContent = [
  this.input.status,
  this.input.storageWarning
].filter(Boolean).join(" ");

if (DELIVERY_SYSTEM_ENABLED) {
  this.deliveryStatusElement.textContent = this.deliverySystem.statusText;
  this.deliveryCountElement.textContent =
    `Deliveries: ${this.deliverySystem.deliveries} · Score: ${this.deliverySystem.score}`;
}

if (this.turretStatusElement) {
  this.turretStatusElement.textContent = this.turret.statusText;
}

if (this.batteryStatusElement) {
  const batteryLabel = this.battery.charging
    ? `BATTERY: CHARGING ${Math.round(this.battery.percent)}%`
    : this.battery.state === "empty"
      ? "BATTERY: DEPLETED"
      : this.battery.state === "critical"
        ? `BATTERY: CRITICAL ${Math.round(this.battery.percent)}%`
        : this.battery.state === "low"
          ? `BATTERY: LOW ${Math.round(this.battery.percent)}%`
          : `BATTERY: ${Math.round(this.battery.percent)}%`;

  this.batteryStatusElement.textContent = batteryLabel;
  this.batteryStatusElement.classList.toggle(
    "dash-pill-battery--charging", this.battery.charging
  );
  this.batteryStatusElement.classList.toggle(
    "dash-pill-battery--low", this.battery.state === "low"
  );
  this.batteryStatusElement.classList.toggle(
    "dash-pill-battery--critical", this.battery.state === "critical"
  );
  this.batteryStatusElement.classList.toggle(
    "dash-pill-battery--empty", this.battery.state === "empty"
  );
}

if (this.batteryPercentElement) {
  this.batteryPercentElement.textContent = `${Math.round(this.battery.percent)}%`;
}

if (this.batteryFillElement) {
  this.batteryFillElement.style.width =
    `${Math.max(0, Math.min(100, this.battery.ratio * 100))}%`;

  this.batteryFillElement.classList.toggle(
    "dash-battery-fill--charging", this.battery.charging
  );
  this.batteryFillElement.classList.toggle(
    "dash-battery-fill--low", this.battery.state === "low"
  );
  this.batteryFillElement.classList.toggle(
    "dash-battery-fill--critical", this.battery.state === "critical"
  );
  this.batteryFillElement.classList.toggle(
    "dash-battery-fill--empty", this.battery.state === "empty"
  );
}

if (this.turboStatusElement) {
  const turboLabel = this.turbo.state === "active"
    ? `TURBO: BOOST ${this.turbo.durationRemaining.toFixed(1)}s`
    : this.turbo.state === "cooldown"
      ? `TURBO: COOLDOWN ${this.turbo.cooldownRemaining.toFixed(1)}s`
      : "TURBO: READY";

  this.turboStatusElement.textContent = turboLabel;
  this.turboStatusElement.classList.toggle(
    "dash-pill-turbo--active", this.turbo.state === "active"
  );
  this.turboStatusElement.classList.toggle(
    "dash-pill-turbo--cooldown", this.turbo.state === "cooldown"
  );
}

if (this.boostFillElement) {
  // Ready: full bar. Active: drains toward 0 as the boost is used up.
  // Cooldown: refills back toward full. All derived from the single
  // existing TurboSystem state — no separate boost meter is invented.
  const boostFraction = this.turbo.state === "active"
    ? this.turbo.durationRemaining / this.turbo.config.duration
    : this.turbo.state === "cooldown"
      ? 1 - this.turbo.cooldownFraction
      : 1;

  this.boostFillElement.style.width =
    `${Math.max(0, Math.min(100, boostFraction * 100))}%`;

  this.boostFillElement.classList.toggle(
    "dash-boost-fill--active", this.turbo.state === "active"
  );
  this.boostFillElement.classList.toggle(
    "dash-boost-fill--cooldown", this.turbo.state === "cooldown"
  );
}

this.mobileControls?.setTurboState(this.turbo.state, this.turbo.cooldownFraction);

this.debugElement.textContent = JSON.stringify({
  activeInput: this.input.activeSource,
  selectedMode: this.input.mode,
  controlStatus: this.input.status,
  drivingMode: this.drivingMode,
  normalized: input,
  hShifter: this.input.shifter,
  drivetrain:
    this.drivingMode === "manual"
      ? this.manualController.telemetry
      : null,
  devices: this.input.inspectDevices()
}, null, 2);

      this.lastHudTime = timeMs;
    }
  }
}