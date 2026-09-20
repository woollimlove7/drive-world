// Touch driving controls layer. Feeds the same InputManager the
// keyboard/wheel already use (see InputManager.enableMobile/sample) —
// this module never talks to the vehicle/transmission directly.

const GEAR_LABEL = gear =>
  gear === -1 ? "R" : gear === 0 ? "N" : String(gear);

// Column layout for the H-pattern: [up gear, down gear|null].
const SHIFTER_LANES = [
  [1, 2],
  [3, 4],
  [5, 6],
  [-1, null]
];

export class MobileControls {
  constructor(input) {
    this.input = input;
    this.active = false;
    this.mode = "arcade";

    this.isTouchDevice = Boolean(
      window.matchMedia?.("(pointer: coarse)").matches ||
      navigator.maxTouchPoints > 0
    );

    this.pointers = new Map(); // pointerId -> control name, for isolation
    this.steeringValue = 0;
    this.steeringTarget = 0;
    this.steeringLeftHeld = false;
    this.steeringRightHeld = false;
    this.steeringAnimId = null;
    this.shifterGear = 0;

    this.buildDOM();
    this.bindSteering();
    this.bindCornerActions();
    this.bindPedal(this.accelEl, "throttle");
    this.bindPedal(this.brakeEl, "brake");
    this.bindPedal(this.clutchEl, "clutch");
    this.bindPedal(this.handbrakeEl, "handbrake");
    this.bindShifter();
    this.bindTurret();
    this.bindTurbo();
    this.bindOrientation();
    this.bindFocusLoss();

    this.root.hidden = true;
  }

  buildDOM() {
    this.root = document.createElement("div");
    this.root.id = "mobile-controls";
    this.root.setAttribute("aria-hidden", "true");

    // ---------------------------------------------------------------
    // LEFT: STEERING
    // ---------------------------------------------------------------

    const ICON_ARROW_LEFT =
      '<svg viewBox="0 0 24 24"><path d="M15 4 7 12l8 8" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    const ICON_ARROW_RIGHT =
      '<svg viewBox="0 0 24 24"><path d="M9 4l8 8-8 8" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    this.steeringEl = document.createElement("div");
    this.steeringEl.className = "mc-steer-cluster";

    this.steerLeftEl = document.createElement("div");
    this.steerLeftEl.className = "mc-steer-btn mc-steer-btn--left";
    this.steerLeftEl.setAttribute("role", "button");
    this.steerLeftEl.setAttribute("aria-label", "Steer left");
    this.steerLeftEl.innerHTML =
      `<span class="mc-steer-icon" aria-hidden="true">${ICON_ARROW_LEFT}</span>`;

    this.steerRightEl = document.createElement("div");
    this.steerRightEl.className = "mc-steer-btn mc-steer-btn--right";
    this.steerRightEl.setAttribute("role", "button");
    this.steerRightEl.setAttribute("aria-label", "Steer right");
    this.steerRightEl.innerHTML =
      `<span class="mc-steer-icon" aria-hidden="true">${ICON_ARROW_RIGHT}</span>`;

    this.steeringEl.append(
      this.steerLeftEl,
      this.steerRightEl
    );

    // ---------------------------------------------------------------
    // TOP-RIGHT: FULLSCREEN + CAMERA
    // ---------------------------------------------------------------

    this.fullscreenBtnEl = document.createElement("button");
    this.fullscreenBtnEl.type = "button";
    this.fullscreenBtnEl.className =
      "mc-corner-btn mc-corner-btn--fullscreen";
    this.fullscreenBtnEl.setAttribute(
      "aria-label",
      "Toggle fullscreen"
    );
    this.fullscreenBtnEl.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    this.cameraBtnEl = document.createElement("button");
    this.cameraBtnEl.type = "button";
    this.cameraBtnEl.className =
      "mc-corner-btn mc-corner-btn--camera";
    this.cameraBtnEl.setAttribute(
      "aria-label",
      "Change camera"
    );
    this.cameraBtnEl.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-2h6l2 2h3v11H4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="13.5" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/></svg>';

    this.cornerActionsEl = document.createElement("div");
    this.cornerActionsEl.className = "mc-corner-actions";

    this.cornerActionsEl.append(
      this.fullscreenBtnEl,
      this.cameraBtnEl
    );

    // ---------------------------------------------------------------
    // HUD TOP ACTIONS
    //
    // Groups:
    // .mc-corner-actions
    // #hud-mode-toggle
    //
    // The HUD mode toggle is an existing element created elsewhere.
    // We move it into this wrapper instead of creating a duplicate.
    // ---------------------------------------------------------------

    this.pedal_clusters = document.createElement("div");
    this.pedal_clusters.className = "mc-hud-pedal_clusters";

    this.hudTopActionsEl = document.createElement("div");
    this.hudTopActionsEl.className = "mc-hud-top-actions";

    this.hudModeToggleEl =
      document.getElementById("hud-mode-toggle");

    this.hudTopActionsEl.append(
      this.cornerActionsEl
    );

    if (this.hudModeToggleEl) {
      this.hudTopActionsEl.append(
        this.hudModeToggleEl
      );
    }

    // ---------------------------------------------------------------
    // RIGHT: PEDALS
    // ---------------------------------------------------------------



    this.pedalsEl = document.createElement("div");
    this.pedalsEl.className = "mc-pedals";
    

    const ICON_ACCEL =
      '<svg viewBox="0 0 24 24"><path d="M12 3 3 19h18L12 3z"/></svg>';

    const ICON_BRAKE =
      '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>';

    const ICON_CLUTCH =
      '<svg viewBox="0 0 24 24"><path d="M12 2 2 12l10 10 10-10L12 2z"/></svg>';

    const ICON_HANDBRAKE =
      '<svg viewBox="0 0 24 24"><path d="M12 2 4 6v6c0 5.2 3.4 9 8 10 4.6-1 8-4.8 8-10V6l-8-4z"/></svg>';

    this.clutchEl = this.makePedal(
      "CLUTCH",
      "mc-pedal-clutch",
      ICON_CLUTCH
    );

    this.brakeEl = this.makePedal(
      "BRAKE",
      "mc-pedal-brake",
      ICON_BRAKE
    );

    this.accelEl = this.makePedal(
      "GAS",
      "mc-pedal-accel",
      ICON_ACCEL
    );

    this.pedalsEl.append(
      this.clutchEl,
      this.brakeEl,
      this.accelEl
    );

    this.pedal_clusters.append(this.pedalsEl);

    

    // ---------------------------------------------------------------
    // ACTION CLUSTER
    //
    // Handbrake + Turbo + Turret are intentionally grouped together
    // inside one container.
    // ---------------------------------------------------------------

    this.actionClusterEl = document.createElement("div");
    this.actionClusterEl.className = "mc-action-cluster";
    

    // Handbrake
    this.handbrakeEl = this.makePedal(
      "HANDBRAKE",
      "mc-handbrake-btn",
      ICON_HANDBRAKE
    );

    this.handbrakeEl.setAttribute(
      "role",
      "button"
    );

    this.handbrakeEl.setAttribute(
      "aria-label",
      "Handbrake"
    );

    this.handbrakeEl.tabIndex = 0;

    // Turret
    this.turretEl = document.createElement("button");
    this.turretEl.type = "button";
    this.turretEl.className = "mc-turret-btn";
    this.turretEl.setAttribute(
      "aria-label",
      "Deploy turret"
    );

    this.turretEl.innerHTML =
      '<span class="mc-turret-icon" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24"><path d="M12 2 4 6v6c0 5.2 3.4 9 8 10 4.6-1 8-4.8 8-10V6l-8-4z"/></svg>' +
      '</span>' +
      '<span class="mc-turret-text">TURRET</span>';

    // Turbo
    this.turboEl = document.createElement("button");
    this.turboEl.type = "button";
    this.turboEl.className = "mc-turbo-btn";
    this.turboEl.setAttribute(
      "aria-label",
      "Turbo boost"
    );

    this.turboEl.innerHTML =
      '<span class="mc-turbo-icon" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24"><path d="M13 2 3 14h7l-1 8 11-14h-8z"/></svg>' +
      '</span>' +
      '<span class="mc-turbo-text">TURBO</span>';

    // ---------------------------------------------------------------
    // IMPORTANT:
    //
    // These three controls are now siblings inside the same div:
    //
    // .mc-action-cluster
    // ├── .mc-handbrake-btn
    // ├── .mc-turbo-btn
    // └── .mc-turret-btn
    // ---------------------------------------------------------------

    this.actionClusterEl.append(
      this.handbrakeEl,
      this.turboEl,
      this.turretEl
    );


    this.pedal_clusters.append(this.actionClusterEl);

    // ---------------------------------------------------------------
    // BOTTOM CENTER: H-SHIFTER
    // ---------------------------------------------------------------

    this.shifterEl = document.createElement("div");
    this.shifterEl.className = "mc-shifter";

    this.shifterEl.innerHTML = `
      <svg class="mc-shifter-track" viewBox="0 0 200 130" aria-hidden="true">
        <line x1="25" y1="65" x2="175" y2="65" class="mc-shifter-rail"/>
        <line x1="25" y1="25" x2="25" y2="105" class="mc-shifter-rail"/>
        <line x1="75" y1="25" x2="75" y2="105" class="mc-shifter-rail"/>
        <line x1="125" y1="25" x2="125" y2="105" class="mc-shifter-rail"/>
        <line x1="175" y1="25" x2="175" y2="65" class="mc-shifter-rail"/>

        <text x="25" y="18" class="mc-shifter-label">1</text>
        <text x="25" y="118" class="mc-shifter-label">2</text>

        <text x="75" y="18" class="mc-shifter-label">3</text>
        <text x="75" y="118" class="mc-shifter-label">4</text>

        <text x="125" y="18" class="mc-shifter-label">5</text>
        <text x="125" y="118" class="mc-shifter-label">6</text>

        <text x="175" y="18" class="mc-shifter-label">R</text>
      </svg>

      <div class="mc-shifter-knob"></div>
      <div class="mc-shifter-gear">N</div>
    `;

    this.shifterKnob =
      this.shifterEl.querySelector(
        ".mc-shifter-knob"
      );

    this.shifterGearLabel =
      this.shifterEl.querySelector(
        ".mc-shifter-gear"
      );

    // ---------------------------------------------------------------
    // ORIENTATION OVERLAY
    // ---------------------------------------------------------------

    this.orientationEl = document.createElement("div");
    this.orientationEl.className =
      "mc-orientation-overlay";

    this.orientationEl.innerHTML = `
      <div class="mc-orientation-icon">⟳</div>
      <p>
        Rotate your device<br>
        <span>for the best driving experience</span>
      </p>
    `;

    // ---------------------------------------------------------------
    // ROOT DOM
    // ---------------------------------------------------------------

    this.root.append(
      this.steeringEl,
      this.pedal_clusters,
      // this.pedalsEl,
      // this.actionClusterEl,
      this.shifterEl,
      this.hudTopActionsEl,
      this.orientationEl
    );

    document.body.append(this.root);
  }

  makePedal(label, className, icon = "") {
    const el = document.createElement("div");

    el.className = `mc-pedal ${className}`;

    el.innerHTML =
      `<span class="mc-pedal-cap">` +
      `<span class="mc-pedal-icon" aria-hidden="true">${icon}</span>` +
      `</span>` +
      `<span class="mc-pedal-label">${label}</span>`;

    return el;
  }

  // ---------------------------------------------------------------
  // ACTIVE STATE
  // ---------------------------------------------------------------

    setActive(active) {
    this.active = active;

    this.root.hidden = !this.active;
    // Keep aria-hidden in sync with actual visibility -- it was only ever
    // set once (to "true") when the layer was built, so once the controls
    // became active their focusable buttons (e.g. the fullscreen corner
    // button) would still sit under an ancestor claiming to be hidden
    // from assistive tech.
    this.root.setAttribute("aria-hidden", this.active ? "false" : "true");

    document.body.classList.toggle(
      "mobile-controls-active",
      this.active
    );

    if (!this.active) {
      this.releaseAllPedals();
      this.resetSteering();
      this.input.setMobileTurboHeld(false);
    } else {
      requestAnimationFrame(() =>
        this.centerShifterKnob?.()
      );
    }
  }

  // ---------------------------------------------------------------
  // DRIVING MODE
  // ---------------------------------------------------------------

  setDrivingMode(mode) {
    this.mode = mode;

    const manual = mode === "manual";

    this.clutchEl.hidden = !manual;
    this.shifterEl.hidden = !manual;

    if (!manual) {
      this.clutchEl.classList.remove(
        "mc-pressed"
      );

      this.input.setMobileInput({
        clutch: 0
      });

      this.snapShifterTo(0);
    }
  }

  // ---------------------------------------------------------------
  // STEERING
  // ---------------------------------------------------------------

  bindSteering() {
    const updateTarget = () => {
      this.steeringTarget =
        (this.steeringRightHeld ? 1 : 0) -
        (this.steeringLeftHeld ? 1 : 0);

      if (this.steeringAnimId === null) {
        this.runSteeringLoop();
      }
    };

    const bindHeldButton = (
      el,
      setHeld
    ) => {
      let pointerId = null;

      const press = event => {
        if (pointerId !== null) return;

        pointerId = event.pointerId;

        el.setPointerCapture(
          pointerId
        );

        el.classList.add(
          "mc-pressed"
        );

        setHeld(true);
        updateTarget();
      };

      const release = event => {
        if (
          event.pointerId !==
          pointerId
        ) {
          return;
        }

        pointerId = null;

        el.classList.remove(
          "mc-pressed"
        );

        setHeld(false);
        updateTarget();
      };

      el.addEventListener(
        "pointerdown",
        press
      );

      el.addEventListener(
        "pointerup",
        release
      );

      el.addEventListener(
        "pointercancel",
        release
      );

      el.addEventListener(
        "lostpointercapture",
        release
      );
    };

    bindHeldButton(
      this.steerLeftEl,
      held => {
        this.steeringLeftHeld = held;
      }
    );

    bindHeldButton(
      this.steerRightEl,
      held => {
        this.steeringRightHeld = held;
      }
    );

    this._updateSteeringTarget =
      updateTarget;
  }

  runSteeringLoop() {
    const ATTACK = 0.35;
    const RETURN = 0.22;

    const step = () => {
      const factor =
        this.steeringTarget === 0
          ? RETURN
          : ATTACK;

      this.steeringValue +=
        (
          this.steeringTarget -
          this.steeringValue
        ) *
        factor;

      if (
        this.steeringTarget === 0 &&
        Math.abs(
          this.steeringValue
        ) < 0.01
      ) {
        this.steeringValue = 0;

        this.input.setMobileInput({
          steering: 0
        });

        this.steeringAnimId =
          null;

        return;
      }

      if (
        this.steeringTarget !== 0 &&
        Math.abs(
          this.steeringValue -
          this.steeringTarget
        ) < 0.01
      ) {
        this.steeringValue =
          this.steeringTarget;
      }

      this.input.setMobileInput({
        steering:
          this.steeringValue
      });

      this.steeringAnimId =
        requestAnimationFrame(
          step
        );
    };

    this.steeringAnimId =
      requestAnimationFrame(
        step
      );
  }

  resetSteering() {
    cancelAnimationFrame(
      this.steeringAnimId
    );

    this.steeringAnimId = null;

    this.steeringLeftHeld = false;
    this.steeringRightHeld = false;

    this.steeringTarget = 0;
    this.steeringValue = 0;

    this.steerLeftEl.classList.remove(
      "mc-pressed"
    );

    this.steerRightEl.classList.remove(
      "mc-pressed"
    );

    this.input.setMobileInput({
      steering: 0
    });
  }

  // ---------------------------------------------------------------
  // CORNER ACTIONS
  // ---------------------------------------------------------------

  bindCornerActions() {
    this._onFullscreen = null;
    this._onCamera = null;

    this.fullscreenBtnEl.addEventListener(
      "click",
      () => this._onFullscreen?.()
    );

    this.cameraBtnEl.addEventListener(
      "click",
      () => this._onCamera?.()
    );
  }

  setActions({
    onFullscreen,
    onCamera
  } = {}) {
    this._onFullscreen =
      onFullscreen ??
      this._onFullscreen;

    this._onCamera =
      onCamera ??
      this._onCamera;
  }

  setFullscreenActive(active) {
    this.fullscreenBtnEl.classList.toggle(
      "mc-corner-btn--active",
      active
    );

    this.fullscreenBtnEl.setAttribute(
      "aria-label",
      active
        ? "Exit fullscreen"
        : "Enter fullscreen"
    );
  }

  // ---------------------------------------------------------------
  // PEDALS
  // ---------------------------------------------------------------

  bindPedal(
    el,
    axisName
  ) {
    let pointerId = null;

    const press = event => {
      if (pointerId !== null) return;

      pointerId = event.pointerId;

      el.setPointerCapture(
        pointerId
      );

      el.classList.add(
        "mc-pressed"
      );

      this.input.setMobileInput({
        [axisName]: 1
      });
    };

    const release = event => {
      if (
        event.pointerId !==
        pointerId
      ) {
        return;
      }

      pointerId = null;

      el.classList.remove(
        "mc-pressed"
      );

      this.input.setMobileInput({
        [axisName]: 0
      });
    };

    el.addEventListener(
      "pointerdown",
      press
    );

    el.addEventListener(
      "pointerup",
      release
    );

    el.addEventListener(
      "pointercancel",
      release
    );

    el.addEventListener(
      "lostpointercapture",
      release
    );
  }

  releaseAllPedals() {
    for (const [
      el,
      axis
    ] of [
      [this.accelEl, "throttle"],
      [this.brakeEl, "brake"],
      [this.clutchEl, "clutch"],
      [this.handbrakeEl, "handbrake"]
    ]) {
      el.classList.remove(
        "mc-pressed"
      );

      this.input.setMobileInput({
        [axis]: 0
      });
    }
  }

  // ---------------------------------------------------------------
  // FOCUS LOSS
  // ---------------------------------------------------------------

  bindFocusLoss() {
    const releaseEverything = () => {
      if (!this.active) return;

      this.releaseAllPedals();
      this.resetSteering();

      this.input.setMobileTurboHeld(
        false
      );

      this.turboEl.classList.remove(
        "mc-pressed"
      );
    };

    window.addEventListener(
      "blur",
      releaseEverything
    );

    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.hidden) {
          releaseEverything();
        }
      }
    );
  }

  // ---------------------------------------------------------------
  // TURRET
  // ---------------------------------------------------------------

  bindTurret() {
    const el = this.turretEl;

    let pointerId = null;

    const press = event => {
      if (pointerId !== null) return;

      pointerId = event.pointerId;

      el.setPointerCapture(
        pointerId
      );

      el.classList.add(
        "mc-pressed"
      );

      this.input.requestTurretToggle();
    };

    const release = event => {
      if (
        event.pointerId !==
        pointerId
      ) {
        return;
      }

      pointerId = null;

      el.classList.remove(
        "mc-pressed"
      );
    };

    el.addEventListener(
      "pointerdown",
      press
    );

    el.addEventListener(
      "pointerup",
      release
    );

    el.addEventListener(
      "pointercancel",
      release
    );

    el.addEventListener(
      "lostpointercapture",
      release
    );
  }

  // ---------------------------------------------------------------
  // TURBO
  // ---------------------------------------------------------------

  bindTurbo() {
    const el = this.turboEl;

    let pointerId = null;

    const press = event => {
      if (pointerId !== null) return;

      pointerId = event.pointerId;

      el.setPointerCapture(
        pointerId
      );

      el.classList.add(
        "mc-pressed"
      );

      this.input.setMobileTurboHeld(
        true
      );
    };

    const release = event => {
      if (
        event.pointerId !==
        pointerId
      ) {
        return;
      }

      pointerId = null;

      el.classList.remove(
        "mc-pressed"
      );

      this.input.setMobileTurboHeld(
        false
      );
    };

    el.addEventListener(
      "pointerdown",
      press
    );

    el.addEventListener(
      "pointerup",
      release
    );

    el.addEventListener(
      "pointercancel",
      release
    );

    el.addEventListener(
      "lostpointercapture",
      release
    );
  }

  setTurboState(
    state,
    cooldownFraction = 0
  ) {
    this.turboEl.classList.toggle(
      "mc-turbo-btn--active",
      state === "active"
    );

    this.turboEl.classList.toggle(
      "mc-turbo-btn--cooldown",
      state === "cooldown"
    );

    this.turboEl.style.setProperty(
      "--mc-turbo-cooldown-frac",
      String(
        state === "cooldown"
          ? cooldownFraction
          : 0
      )
    );
  }

  // ---------------------------------------------------------------
  // H-SHIFTER
  // ---------------------------------------------------------------

  bindShifter() {
    const track =
      this.shifterEl.querySelector(
        ".mc-shifter-track"
      );

    let pointerId = null;

    const geometry = () => {
      const rect =
        track.getBoundingClientRect();

      return {
        rect,
        colWidth:
          rect.width /
          SHIFTER_LANES.length
      };
    };

    const positionKnob = (
      col,
      rowFrac
    ) => {
      const {
        rect,
        colWidth
      } = geometry();

      const x =
        (col + 0.5) *
        colWidth;

      const y =
        rowFrac *
        rect.height;

      this.shifterKnob.style.left =
        `${x}px`;

      this.shifterKnob.style.top =
        `${y}px`;
    };

    const gearAtPointer = (
      clientX,
      clientY
    ) => {
      const {
        rect,
        colWidth
      } = geometry();

      const col = Math.max(
        0,
        Math.min(
          SHIFTER_LANES.length - 1,
          Math.floor(
            (clientX - rect.left) /
            colWidth
          )
        )
      );

      const rowFrac = Math.max(
        0,
        Math.min(
          1,
          (clientY - rect.top) /
          rect.height
        )
      );

      const [
        upGear,
        downGear
      ] = SHIFTER_LANES[col];

      const NEUTRAL_BAND = 0.28;

      let gear = 0;

      if (
        rowFrac <
        0.5 - NEUTRAL_BAND
      ) {
        gear = upGear;
      } else if (
        downGear !== null &&
        rowFrac >
        0.5 + NEUTRAL_BAND
      ) {
        gear = downGear;
      }

      positionKnob(
        col,
        rowFrac
      );

      return gear;
    };

    const preview = gear => {
      this.shifterGearLabel.textContent =
        GEAR_LABEL(gear);

      this.shifterEl.classList.toggle(
        "mc-shifter-engaged",
        gear !== 0
      );
    };

    track.addEventListener(
      "pointerdown",
      event => {
        if (pointerId !== null) return;

        pointerId =
          event.pointerId;

        track.setPointerCapture(
          pointerId
        );

        preview(
          gearAtPointer(
            event.clientX,
            event.clientY
          )
        );
      }
    );

    track.addEventListener(
      "pointermove",
      event => {
        if (
          event.pointerId !==
          pointerId
        ) {
          return;
        }

        preview(
          gearAtPointer(
            event.clientX,
            event.clientY
          )
        );
      }
    );

    const release = event => {
      if (
        event.pointerId !==
        pointerId
      ) {
        return;
      }

      pointerId = null;

      const gear =
        gearAtPointer(
          event.clientX,
          event.clientY
        );

      this.shifterGear = gear;

      this.input.setMobileGear(
        gear
      );

      preview(gear);

      const col =
        SHIFTER_LANES.findIndex(
          ([up, down]) =>
            up === gear ||
            down === gear
        );

      positionKnob(
        col === -1
          ? 1.5
          : col,
        0.5
      );
    };

    track.addEventListener(
      "pointerup",
      release
    );

    track.addEventListener(
      "pointercancel",
      release
    );

    this.centerShifterKnob =
      () =>
        positionKnob(
          1.5,
          0.5
        );

    requestAnimationFrame(
      this.centerShifterKnob
    );
  }

  snapShifterTo(gear) {
    this.shifterGear = gear;

    this.input.setMobileGear(
      gear
    );

    this.shifterGearLabel.textContent =
      GEAR_LABEL(gear);

    this.shifterEl.classList.remove(
      "mc-shifter-engaged"
    );
  }

  // ---------------------------------------------------------------
  // ORIENTATION
  // ---------------------------------------------------------------

  bindOrientation() {
    const check = () => {
      if (!this.active) {
        this.orientationEl.classList.remove(
          "mc-visible"
        );

        return;
      }

      const portrait =
        window.innerHeight >
        window.innerWidth;

      const needsLandscape =
        this.mode === "manual";

      this.orientationEl.classList.toggle(
        "mc-visible",
        portrait &&
        needsLandscape
      );
    };

    window.addEventListener(
      "resize",
      check
    );

    window.addEventListener(
      "orientationchange",
      check
    );

    this._checkOrientation =
      check;

    const originalSetActive =
      this.setActive.bind(this);

    this.setActive = active => {
      originalSetActive(active);
      check();
    };

    const originalSetMode =
      this.setDrivingMode.bind(this);

    this.setDrivingMode = mode => {
      originalSetMode(mode);
      check();
    };
  }
}