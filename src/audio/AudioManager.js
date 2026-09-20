const clamp = (value, min, max) =>
  Math.min(max, Math.max(min, value));

export class AudioManager {
  constructor() {
    this.context = null;

    // Audio is ON by default.
    this.enabled = true;

    this.volume = 0.3;
    this.engineVolume = 1;
    this.environmentVolume = 1;
    this.effectsVolume = 1;

    this.lastImpactTime = -Infinity;
    this.previousGear = null;

    const muteWhenUnfocused = () => {
      if (!this.context || !this.master) return;

      if (document.hidden || !document.hasFocus()) {
        this.master.gain.setTargetAtTime(
          0,
          this.context.currentTime,
          0.03
        );
      } else if (this.context.state === "running") {
        this.master.gain.setTargetAtTime(
          this.volume,
          this.context.currentTime,
          0.03
        );
      }
    };

    document.addEventListener(
      "visibilitychange",
      muteWhenUnfocused
    );

    window.addEventListener(
      "blur",
      muteWhenUnfocused
    );

    window.addEventListener(
      "focus",
      muteWhenUnfocused
    );

    /*
     * Browsers usually block Web Audio from playing
     * before the user interacts with the page.
     *
     * We prepare the audio system immediately, then
     * resume it automatically on the user's first
     * click, tap, or key press.
     */
    const startAudioOnInteraction = async () => {
      try {
        if (!this.context) {
          this.initialize();
        }

        if (this.context.state !== "running") {
          await this.context.resume();
        }

        if (this.context.state === "running") {
          this.enabled = true;

          this.master.gain.setTargetAtTime(
            this.volume,
            this.context.currentTime,
            0.03
          );
        }
      } catch (error) {
        console.warn(
          "Unable to start Web Audio:",
          error
        );
      }

      document.removeEventListener(
        "pointerdown",
        startAudioOnInteraction
      );

      document.removeEventListener(
        "keydown",
        startAudioOnInteraction
      );

      document.removeEventListener(
        "touchstart",
        startAudioOnInteraction
      );
    };

    document.addEventListener(
      "pointerdown",
      startAudioOnInteraction,
      { once: true }
    );

    document.addEventListener(
      "keydown",
      startAudioOnInteraction,
      { once: true }
    );

    document.addEventListener(
      "touchstart",
      startAudioOnInteraction,
      { once: true }
    );

    // Prepare the audio system immediately.
    try {
      this.initialize();
    } catch (error) {
      console.warn(
        "Audio initialization failed:",
        error
      );

      this.enabled = false;
    }
  }

  async enable() {
    try {
      if (!this.context) {
        this.initialize();
      }

      await this.context.resume();

      this.enabled =
        this.context.state === "running";

      if (this.enabled && this.master) {
        this.master.gain.setTargetAtTime(
          this.volume,
          this.context.currentTime,
          0.03
        );
      }

      return this.enabled;
    } catch (error) {
      console.warn(
        "Audio could not be enabled:",
        error
      );

      return false;
    }
  }

  initialize() {
    if (this.context) return;

    const AudioContextClass =
      window.AudioContext ||
      window.webkitAudioContext;

    if (!AudioContextClass) {
      throw new Error(
        "Web Audio is unavailable in this browser."
      );
    }

    this.context = new AudioContextClass();

    const ctx = this.context;

    /*
     * MASTER
     *
     * Previously this was 0, which means completely
     * muted. It now starts at the configured volume.
     */
    this.master = ctx.createGain();

    this.master.gain.value = this.volume;

    this.master.connect(
      ctx.destination
    );

    /*
     * AUDIO BUSES
     */
    this.engineBus = ctx.createGain();
    this.environmentBus = ctx.createGain();
    this.effectsBus = ctx.createGain();

    this.engineBus.connect(
      this.master
    );

    this.environmentBus.connect(
      this.master
    );

    this.effectsBus.connect(
      this.master
    );

    /*
     * ENGINE FILTER
     */
    this.engineFilter =
      ctx.createBiquadFilter();

    this.engineFilter.type = "lowpass";

    this.engineFilter.frequency.value = 1800;

    this.engineFilter.connect(
      this.engineBus
    );

    /*
     * ENGINE OSCILLATOR
     */
    this.engineGain =
      ctx.createGain();

    this.engineGain.gain.value = 0;

    this.engineGain.connect(
      this.engineFilter
    );

    this.engineOscillator =
      ctx.createOscillator();

    this.engineOscillator.type =
      "sawtooth";

    this.engineOscillator.frequency.value =
      30;

    this.engineOscillator.connect(
      this.engineGain
    );

    this.engineOscillator.start();

    /*
     * ENGINE HARMONIC
     */
    this.harmonicGain =
      ctx.createGain();

    this.harmonicGain.gain.value = 0;

    this.harmonicGain.connect(
      this.engineFilter
    );

    this.harmonic =
      ctx.createOscillator();

    this.harmonic.type =
      "triangle";

    this.harmonic.frequency.value =
      60;

    this.harmonic.connect(
      this.harmonicGain
    );

    this.harmonic.start();

    /*
     * NOISE BUFFER
     */
    const noiseBuffer =
      ctx.createBuffer(
        1,
        ctx.sampleRate * 2,
        ctx.sampleRate
      );

    const samples =
      noiseBuffer.getChannelData(0);

    for (
      let i = 0;
      i < samples.length;
      i++
    ) {
      samples[i] =
        Math.random() * 2 - 1;
    }

    this.noiseBuffer =
      noiseBuffer;

    /*
     * ROAD / ROLLING SOUND
     */
    this.rolling =
      this.createNoiseLayer(
        "bandpass",
        650,
        0.7,
        this.effectsBus
      );

    /*
     * WIND
     */
    this.wind =
      this.createNoiseLayer(
        "lowpass",
        240,
        0.7,
        this.environmentBus
      );

    /*
     * TIRE SKID
     */
    this.skid =
      this.createNoiseLayer(
        "bandpass",
        1500,
        1.8,
        this.effectsBus
      );

    /*
     * CHARGING LOOP
     *
     * A quiet, subtle electrical hum used only while the vehicle is
     * actively charging (see update()'s `charging` flag). Created once
     * here, alongside the other continuous layers, and just ramped up/down
     * per frame -- never a new node per charging session.
     */
    this.chargingLoop =
      this.createNoiseLayer(
        "bandpass",
        2200,
        4,
        this.effectsBus
      );

    /*
     * If the browser initially creates the context
     * in a suspended state, that's okay.
     *
     * The first user interaction will call resume().
     */
    if (ctx.state === "suspended") {
      console.log(
        "Audio ready — waiting for first user interaction."
      );
    }
  }

  createNoiseLayer(
    type,
    frequency,
    q,
    destination
  ) {
    const ctx =
      this.context;

    const source =
      ctx.createBufferSource();

    source.buffer =
      this.noiseBuffer;

    source.loop = true;

    const filter =
      ctx.createBiquadFilter();

    filter.type = type;

    filter.frequency.value =
      frequency;

    filter.Q.value = q;

    const gain =
      ctx.createGain();

    gain.gain.value = 0;

    source.connect(filter);

    filter.connect(gain);

    gain.connect(destination);

    source.start();

    return {
      source,
      filter,
      gain
    };
  }

  shiftClick() {
    if (
      !this.context ||
      !this.enabled ||
      this.context.state !== "running"
    ) {
      return;
    }

    const ctx =
      this.context;

    const source =
      ctx.createBufferSource();

    source.buffer =
      this.noiseBuffer;

    const filter =
      ctx.createBiquadFilter();

    filter.type =
      "bandpass";

    filter.frequency.value =
      1100;

    const gain =
      ctx.createGain();

    const now =
      ctx.currentTime;

    gain.gain.setValueAtTime(
      0.035,
      now
    );

    gain.gain.exponentialRampToValueAtTime(
      0.0001,
      now + 0.065
    );

    source.connect(filter);

    filter.connect(gain);

    gain.connect(
      this.effectsBus
    );

    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
    };

    source.start(now);

    source.stop(
      now + 0.08
    );
  }

  playImpact(impactSpeed) {
    if (
      !this.context ||
      !this.enabled ||
      this.context.state !== "running" ||
      document.hidden ||
      !document.hasFocus()
    ) {
      return;
    }

    if (
      !Number.isFinite(impactSpeed) ||
      impactSpeed < 1.5
    ) {
      return;
    }

    const ctx =
      this.context;

    const now =
      ctx.currentTime;

    /*
     * Collision contacts can generate several
     * events for one impact.
     */
    if (
      now - this.lastImpactTime <
      0.15
    ) {
      return;
    }

    this.lastImpactTime =
      now;

    const strength =
      clamp(
        (impactSpeed - 1.5) / 12,
        0,
        1
      );

    const source =
      ctx.createBufferSource();

    source.buffer =
      this.noiseBuffer;

    const filter =
      ctx.createBiquadFilter();

    filter.type =
      "lowpass";

    filter.frequency.value =
      250 + strength * 650;

    const gain =
      ctx.createGain();

    gain.gain.setValueAtTime(
      0.03 + strength * 0.14,
      now
    );

    gain.gain.exponentialRampToValueAtTime(
      0.0001,
      now + 0.2
    );

    source.connect(filter);

    filter.connect(gain);

    gain.connect(
      this.effectsBus
    );

    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
    };

    source.start(now);

    source.stop(
      now + 0.22
    );
  }

  playFeedback(events) {
    if (
      !this.context ||
      !this.enabled ||
      this.context.state !== "running" ||
      document.hidden ||
      !document.hasFocus()
    ) {
      return;
    }

    for (const event of events) {
      /*
       * ENGINE START
       */
      if (
        event.type ===
        "engine-start"
      ) {
        this.playToneEffect({
          startFrequency: 45,
          endFrequency: 95,
          duration: 0.28,
          volume: 0.035,
          type: "triangle",
          destination:
            this.engineBus
        });
      }

      /*
       * ENGINE STOP
       */
      if (
        event.type ===
        "engine-stop"
      ) {
        this.playToneEffect({
          startFrequency: 60,
          endFrequency: 22,
          duration: 0.22,
          volume: 0.03,
          type: "triangle",
          destination:
            this.engineBus
        });
      }

      /*
       * SUSPENSION
       */
      if (
        event.type ===
        "suspension"
      ) {
        this.playToneEffect({
          startFrequency: 95,
          endFrequency: 38,
          duration: 0.09,
          volume:
            0.008 +
            event.strength * 0.022,
          type: "sine",
          destination:
            this.effectsBus
        });
      }
    }
  }

  playToneEffect({
    startFrequency,
    endFrequency,
    duration,
    volume,
    type,
    destination
  }) {
    if (
      !this.context ||
      !this.enabled ||
      this.context.state !== "running"
    ) {
      return;
    }

    const ctx =
      this.context;

    const now =
      ctx.currentTime;

    const oscillator =
      ctx.createOscillator();

    const envelope =
      ctx.createGain();

    oscillator.type =
      type;

    oscillator.frequency.setValueAtTime(
      startFrequency,
      now
    );

    oscillator.frequency.exponentialRampToValueAtTime(
      endFrequency,
      now + duration
    );

    envelope.gain.setValueAtTime(
      0.0001,
      now
    );

    envelope.gain.exponentialRampToValueAtTime(
      volume,
      now + 0.01
    );

    envelope.gain.exponentialRampToValueAtTime(
      0.0001,
      now + duration
    );

    oscillator.connect(
      envelope
    );

    envelope.connect(
      destination
    );

    oscillator.onended = () => {
      oscillator.disconnect();
      envelope.disconnect();
    };

    oscillator.start(now);

    oscillator.stop(
      now + duration + 0.02
    );
  }

  update({
    rpm,
    throttle,
    speed,
    engineRunning,
    gear,
    surface,
    driverView,
    lugging,
    slip = 0,
    charging = false
  }) {
    if (
      !this.context ||
      !this.enabled
    ) {
      return;
    }

    const ctx =
      this.context;

    const now =
      ctx.currentTime;

    const audible =
      !document.hidden &&
      document.hasFocus() &&
      ctx.state === "running";

    const set = (
      parameter,
      value,
      smoothing = 0.06
    ) => {
      parameter.setTargetAtTime(
        value,
        now,
        smoothing
      );
    };

    /*
     * MASTER VOLUME
     */
    set(
      this.master.gain,
      audible
        ? this.volume
        : 0
    );

    /*
     * AUDIO BUS VOLUMES
     */
    set(
      this.engineBus.gain,
      this.engineVolume
    );

    set(
      this.environmentBus.gain,
      this.environmentVolume
    );

    set(
      this.effectsBus.gain,
      this.effectsVolume
    );

    /*
     * ENGINE
     *
     * Four-cylinder-inspired firing
     * frequency, not a recorded engine.
     */
    const fundamental =
      clamp(
        rpm / 30,
        15,
        260
      );

    set(
      this.engineOscillator.frequency,
      fundamental
    );

    set(
      this.harmonic.frequency,
      fundamental * 2
    );

    const engineLevel =
      engineRunning
        ? 0.045 +
          throttle * 0.055 +
          lugging * 0.015
        : 0;

    set(
      this.engineGain.gain,
      engineLevel
    );

    set(
      this.harmonicGain.gain,
      engineLevel * 0.4
    );

    /*
     * ENGINE FILTER
     */
    set(
      this.engineFilter.frequency,
      driverView
        ? 650 +
          throttle * 600
        : 1400 +
          throttle * 1800
    );

    /*
     * ROAD SURFACE
     */
    const roughness =
      surface === "asphalt"
        ? 0.5
        : surface === "dirt"
        ? 1
        : 0.8;

    const rollingLevel =
      clamp(
        speed / 25,
        0,
        1
      ) *
      roughness *
      (
        driverView
          ? 0.035
          : 0.065
      );

    set(
      this.rolling.gain.gain,
      rollingLevel
    );

    set(
      this.rolling.filter.frequency,
      surface === "asphalt"
        ? 650
        : 350
    );

    /*
     * TIRE SKID
     */
    const slipAmount =
      clamp(
        slip,
        0,
        1
      );

    const slipSpeedFactor =
      clamp(
        speed / 5,
        0,
        1
      );

    set(
      this.skid.gain.gain,
      slipAmount *
        slipSpeedFactor *
        (
          driverView
            ? 0.035
            : 0.07
        )
    );

    set(
      this.skid.filter.frequency,
      surface === "asphalt"
        ? 1700
        : 550
    );

    /*
     * WIND
     *
     * Quiet ambient wind remains
     * audible even at rest.
     */
    set(
      this.wind.gain.gain,
      (
        0.006 +
        clamp(
          speed / 40,
          0,
          1
        ) * 0.035
      ) *
      (
        driverView
          ? 0.45
          : 1
      )
    );

    /*
     * CHARGING LOOP
     *
     * Subtle electrical shimmer, only audible while `charging` is true.
     * Frequency wobbles gently so it doesn't read as a flat drone.
     */
    set(
      this.chargingLoop.gain.gain,
      charging ? 0.018 : 0,
      0.15
    );

    set(
      this.chargingLoop.filter.frequency,
      2200 + Math.sin(now * 3) * 220
    );

    /*
     * GEAR SHIFT SOUND
     */
    if (
      audible &&
      this.previousGear !== null &&
      gear !== this.previousGear
    ) {
      this.shiftClick();
    }

    this.previousGear =
      gear;
  }

  // ---------------------------------------------------------------------
  // One-shot feedback sounds for battery, charging, and leveling. These
  // are all edge-triggered by the caller (Game.js detects the actual
  // state transition -- not-charging -> charging, battery reaching a new
  // threshold, level-up firing) so none of them can spam every frame; each
  // method here just plays a single short envelope through playToneEffect
  // and returns, reusing that helper rather than duplicating oscillator
  // setup.
  // ---------------------------------------------------------------------

  _guarded() {
    return (
      this.context &&
      this.enabled &&
      this.context.state === "running" &&
      !document.hidden &&
      document.hasFocus()
    );
  }

  playChargingStart() {
    if (!this._guarded()) return;
    this.playToneEffect({
      startFrequency: 220,
      endFrequency: 720,
      duration: 0.22,
      volume: 0.04,
      type: "sine",
      destination: this.effectsBus
    });
  }

  playChargingComplete() {
    if (!this._guarded()) return;
    // A short two-note rising confirmation chime.
    this.playToneEffect({
      startFrequency: 520,
      endFrequency: 780,
      duration: 0.14,
      volume: 0.045,
      type: "triangle",
      destination: this.effectsBus
    });
    setTimeout(() => {
      this.playToneEffect({
        startFrequency: 780,
        endFrequency: 1040,
        duration: 0.18,
        volume: 0.045,
        type: "triangle",
        destination: this.effectsBus
      });
    }, 90);
  }

  // kind: "low" | "critical" | "empty"
  playBatteryWarning(kind) {
    if (!this._guarded()) return;

    if (kind === "empty") {
      this.playToneEffect({
        startFrequency: 180,
        endFrequency: 60,
        duration: 0.4,
        volume: 0.05,
        type: "sawtooth",
        destination: this.effectsBus
      });
    } else if (kind === "critical") {
      this.playToneEffect({
        startFrequency: 900,
        endFrequency: 500,
        duration: 0.09,
        volume: 0.04,
        type: "square",
        destination: this.effectsBus
      });
    } else {
      this.playToneEffect({
        startFrequency: 700,
        endFrequency: 450,
        duration: 0.14,
        volume: 0.03,
        type: "sine",
        destination: this.effectsBus
      });
    }
  }

  playXpPickup() {
    if (!this._guarded()) return;
    this.playToneEffect({
      startFrequency: 880,
      endFrequency: 1180,
      duration: 0.07,
      volume: 0.02,
      type: "sine",
      destination: this.effectsBus
    });
  }

  playLevelUp({ evolution = false } = {}) {
    if (!this._guarded()) return;

    this.playToneEffect({
      startFrequency: 440,
      endFrequency: 880,
      duration: 0.18,
      volume: evolution ? 0.07 : 0.05,
      type: "triangle",
      destination: this.effectsBus
    });

    setTimeout(() => {
      this.playToneEffect({
        startFrequency: 880,
        endFrequency: evolution ? 1760 : 1320,
        duration: evolution ? 0.32 : 0.2,
        volume: evolution ? 0.08 : 0.05,
        type: evolution ? "sawtooth" : "triangle",
        destination: this.effectsBus
      });
    }, 100);

    if (evolution) {
      setTimeout(() => {
        this.playToneEffect({
          startFrequency: 220,
          endFrequency: 110,
          duration: 0.3,
          volume: 0.06,
          type: "sine",
          destination: this.effectsBus
        });
      }, 60);
    }
  }

  playTurboStart() {
    if (!this._guarded()) return;
    this.playToneEffect({
      startFrequency: 90,
      endFrequency: 320,
      duration: 0.16,
      volume: 0.045,
      type: "sawtooth",
      destination: this.effectsBus
    });
  }

  playTurboEnd() {
    if (!this._guarded()) return;
    this.playToneEffect({
      startFrequency: 260,
      endFrequency: 90,
      duration: 0.14,
      volume: 0.03,
      type: "sine",
      destination: this.effectsBus
    });
  }

  playEnemyDestroyed(isBoss = false) {
    if (!this._guarded()) return;
    this.playToneEffect({
      startFrequency: isBoss ? 260 : 340,
      endFrequency: isBoss ? 40 : 90,
      duration: isBoss ? 0.5 : 0.22,
      volume: isBoss ? 0.09 : 0.045,
      type: "sawtooth",
      destination: this.effectsBus
    });
  }
}