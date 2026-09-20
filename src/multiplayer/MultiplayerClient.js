import * as THREE from "three";
import { RemoteVehicle } from "./RemoteVehicle.js";
import { ChatBubble } from "./ChatBubble.js";

// Clearance above the local car's roofline. The local vehicle has no
// nameplate sprite (the driver doesn't need to read their own name), so
// this sits directly above the bodywork instead of above a label.
const LOCAL_BUBBLE_ANCHOR_Y = 1.85;

export class MultiplayerClient {
  constructor(game, playerName = "") {
    this.game = game;
    this.playerName = playerName;
    this.chatPanel = null;

    this.socket = null;
    this.selfId = null;
    this.sequence = 0;
    this.remotes = new Map();

    this.running = true;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;

    this.lastRenderTime = performance.now();
    this.animationId = null;

    this.createStatusPanel();
    this.collectPaintMaterials();

    this.localBubble = new ChatBubble(
      this.game.vehicle.root,
      LOCAL_BUBBLE_ANCHOR_Y
    );

    this.connect();

    // Networking is deliberately much slower than rendering.
    this.sendTimer = setInterval(() => this.sendState(), 50);

    this.animate = this.animate.bind(this);
    this.animationId = requestAnimationFrame(this.animate);
  }

  createStatusPanel() {
    // Real multiplayer-game "player list" widget: a small always-visible
    // pill (icon + live player count) that expands into the full status/
    // leaderboard panel on demand. Starts minimized so it never competes
    // with the driving HUD for attention or screen space.
    this.panel = document.createElement("section");
    this.panel.className = "op-panel";
    this.panel.setAttribute("aria-label", "Online players");

    // --- Header: always visible, holds the minimize/expand toggle -------
    this.toggleButton = document.createElement("button");
    this.toggleButton.type = "button";
    this.toggleButton.className = "op-toggle";
    this.toggleButton.setAttribute("aria-expanded", "false");
    this.toggleButton.setAttribute("aria-label", "Expand online players panel");

    this.toggleIcon = document.createElement("span");
    this.toggleIcon.className = "op-toggle-icon";
    this.toggleIcon.setAttribute("aria-hidden", "true");
    this.toggleIcon.textContent = "👥";

    this.badgeCount = document.createElement("span");
    this.badgeCount.className = "op-toggle-count";

    this.toggleChevron = document.createElement("span");
    this.toggleChevron.className = "op-toggle-chevron";
    this.toggleChevron.setAttribute("aria-hidden", "true");
    this.toggleChevron.textContent = "▾";

    this.toggleButton.append(this.toggleIcon, this.badgeCount, this.toggleChevron);

    this.toggleButton.addEventListener("click", () => {
      const expanded = this.panel.classList.toggle("op-panel--expanded");
      this.toggleButton.setAttribute("aria-expanded", String(expanded));
      this.toggleButton.setAttribute(
        "aria-label",
        expanded ? "Minimize online players panel" : "Expand online players panel"
      );
      this.syncPanelHeight();
    });

    // --- Body: everything that only matters once expanded ----------------
    this.body = document.createElement("div");
    this.body.className = "op-body";

    this.bodyInner = document.createElement("div");
    this.bodyInner.className = "op-body-inner";

    this.status = document.createElement("div");
    this.status.className = "op-status";

    this.count = document.createElement("div");
    this.count.className = "op-count";

    this.details = document.createElement("small");
    this.details.className = "op-details";
    this.details.textContent = "Remote cars are solid but simulated locally.";

    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "op-disconnect";
    this.button.textContent = "Disconnect multiplayer";

    this.button.addEventListener("click", () => {
      if (this.running) {
        this.running = false;
        clearTimeout(this.reconnectTimer);

        this.socket?.close(1000, "Player disconnected");
        this.selfId = null;
        this.clearRemotes();

        this.status.textContent = "Offline — local driving available";
        this.button.textContent = "Connect multiplayer";
      } else {
        this.running = true;
        this.reconnectAttempts = 0;
        this.button.textContent = "Disconnect multiplayer";
        this.connect();
      }
    });

    // this.leaderboardHeading = document.createElement("strong");
    // this.leaderboardHeading.className = "op-leaderboard-heading";
    // this.leaderboardHeading.textContent = "Delivery leaderboard";

    // this.leaderboardList = document.createElement("ol");
    // this.leaderboardList.className = "op-leaderboard-list";

    // this.leaderboardEmpty = document.createElement("small");
    // this.leaderboardEmpty.className = "op-leaderboard-empty";
    // this.leaderboardEmpty.textContent = "No deliveries yet this session.";

    this.bodyInner.append(
      this.status,
      this.count,
      this.details,
      this.button
    );

    
      // this.leaderboardHeading,
      // this.leaderboardList,
      // this.leaderboardEmpty

    this.body.append(this.bodyInner);
    this.panel.append(this.toggleButton, this.body);

    document.body.append(this.panel);
    this.updateCount();
    // this.updateLeaderboard([]);

    // Keeps other UI (the mobile HUD in particular) from ever sitting
    // underneath this panel, in either state, at any viewport size — see
    // the body.mobile-controls-active #hud rule in style.css, which reads
    // the --op-reserved variable this sets.
    if (typeof ResizeObserver !== "undefined") {
      this._panelResizeObserver = new ResizeObserver(() => this.syncPanelHeight());
      this._panelResizeObserver.observe(this.panel);
    }

    this.syncPanelHeight();
  }

  syncPanelHeight() {
    requestAnimationFrame(() => {
      if (!this.panel?.isConnected) return;

      const bottom = this.panel.getBoundingClientRect().bottom;
      document.documentElement.style.setProperty(
        "--op-reserved",
        `${Math.round(bottom + 12)}px`
      );
    });
  }

  collectPaintMaterials() {
    const originalColor = new THREE.Color(
      this.game.player.vehicleColor
    ).getHex();

    this.paintMaterials = new Set();

    this.game.vehicle.root.traverse(object => {
      const materials = Array.isArray(object.material)
        ? object.material
        : object.material
          ? [object.material]
          : [];

      for (const material of materials) {
        if (material.color?.getHex() === originalColor) {
          this.paintMaterials.add(material);
        }
      }
    });
  }

  connect() {
    if (!this.running) return;

    if (
      this.socket &&
      (
        this.socket.readyState === WebSocket.CONNECTING ||
        this.socket.readyState === WebSocket.OPEN
      )
    ) {
      return;
    }

    const url = new URL("/multiplayer", window.location.href);
    url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

    if (this.playerName) {
      url.searchParams.set("name", this.playerName);
    }

    this.status.textContent = "Connecting to multiplayer…";

    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener("message", event => {
      if (this.socket !== socket || !this.running) return;

      let message;

      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      this.handleMessage(message);
    });

    socket.addEventListener("error", () => {
      if (this.running) {
        this.status.textContent =
          "Connection unavailable. Is the multiplayer server running?";
      }
    });

    socket.addEventListener("close", event => {
      if (this.socket !== socket) return;

      this.selfId = null;
      this.clearRemotes();

      // Multiplayer connection lost -- fall back to local/offline
      // simulation rather than leaving enemies/combat frozen on whatever
      // the last server snapshot said (requirement #12: game stays
      // playable, this time without a server).
      this.game.targetSystem?.disableNetworkedMode();
      this.game.playerHealth?.disableNetworkedMode();

      if (!this.running) return;

      if (event.code === 4001) {
        this.running = false;
        this.status.textContent = "Session full — try connecting later";
        this.button.textContent = "Connect multiplayer";
        return;
      }

      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);

    const delay = Math.min(
      10000,
      1000 * 2 ** this.reconnectAttempts
    );

    this.reconnectAttempts++;

    this.status.textContent =
      `Disconnected. Retrying in ${Math.round(delay / 1000)}s…`;

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  handleMessage(message) {
    if (message.type === "welcome") {
      if (message.protocol !== 1) {
        this.running = false;
        this.socket.close(1000, "Protocol mismatch");
        this.status.textContent = "Client/server version mismatch";
        this.button.textContent = "Connect multiplayer";
        return;
      }

      this.clearRemotes();
      this.selfId = message.self.id;
      this.sequence = 0;
      this.reconnectAttempts = 0;

      this.applyAssignment(message.self);

      // From here on, enemy identity/position/HP/death and this client's
      // own combat HP/dead are 100% server-authoritative (requirements
      // #5/#6/#10/#11) -- TargetSystem/PlayerHealth stop running their own
      // local simulations and just render whatever the server reports.
      this.game.targetSystem?.enableNetworkedMode();
      this.game.playerHealth?.enableNetworkedMode();

      // New player joining receives the CURRENT enemy world in this same
      // message, not an empty/fresh one (requirement #8).
      this.game.targetSystem?.applyServerState(
        message.enemies ?? [],
        this.game.camera,
        this.game.audio
      );

      for (const player of message.players) {
        this.addPlayer(player);
      }

      this.status.textContent =
        `ONLINE · ${message.self.name}`;

      this.updateCount();
      // this.updateLeaderboard(message.leaderboard ?? []);
      this.chatPanel?.addSystemMessage(`You joined as ${message.self.name}.`);
      return;
    }

    if (message.type === "join") {
      this.addPlayer(message.player);
      this.chatPanel?.addSystemMessage(`${message.player.name} joined the game.`);
      return;
    }

    if (message.type === "leave") {
      const remote = this.remotes.get(message.id);

      if (remote) {
        this.chatPanel?.addSystemMessage(`${remote.name} left the game.`);
        remote.dispose();
        this.remotes.delete(message.id);
      }

      this.updateCount();
      return;
    }

    if (message.type === "snapshot") {
      const now = performance.now();

      for (const player of message.players) {
        // This client's own HP/dead is authoritative from here (see the
          // "welcome" handler above) -- apply it the same way every other
          // player's state already gets applied, instead of trusting the
          // locally-simulated PlayerHealth.
        if (player.id === this.selfId) {
          
          this.game.playerHealth?.applyServerState(
            player.state.health,
            player.state.maxHealth,
            player.state.dead
          );
          continue;
        }

        this.remotes.get(player.id)?.pushState(player.state, now);
      }

      return;
    }

    if (message.type === "enemies") {
      // The single authoritative enemy world (requirements #5/#6) -- see
      // TargetSystem.applyServerState for how this reconciles into local
      // Target visuals without creating duplicates (requirement #9).
      this.game.targetSystem?.applyServerState(
        message.enemies ?? [],
        this.game.camera,
        this.game.audio
      );

      return;
    }

    if (message.type === "enemyKilled") {
      this.game.handleEnemyKilled?.(message);
      return;
    }

    // if (message.type === "leaderboard") {
    //   this.updateLeaderboard(message.entries ?? []);
    //   return;
    // }

    if (message.type === "chat") {
      const isLocal = message.playerId === this.selfId;

      this.chatPanel?.addChatMessage(message, isLocal);

      if (isLocal) {
        this.localBubble.show(message.message);
      } else {
        this.remotes.get(message.playerId)?.showMessage(message.message);
      }

      return;
    }

    if (message.type === "error") {
      this.status.textContent = message.message;
    }
  }

  applyAssignment(player) {
    const game = this.game;

    game.player.playerId = player.id;
    game.player.vehicleId = `vehicle-${player.id}`;
    game.player.vehicleColor = player.color;

    for (const material of this.paintMaterials) {
      material.color.set(player.color);
    }

    // A new network connection creates a fresh spawn.
    // Reconnection does not yet restore an earlier session position.
    game.vehiclePhysics.reset();

    game.vehiclePhysics.body.position.set(...player.spawn.position);
    game.vehiclePhysics.body.quaternion.set(...player.spawn.rotation);
    game.vehiclePhysics.body.aabbNeedsUpdate = true;
    game.vehiclePhysics.body.wakeUp();

    game.controller.reset();
    game.manualController.reset();
    game.vehicleFeedback?.reset();

    game.engineStartRequested = false;
    game.accumulator = 0;

    game.input.keys.clear();
    game.input.resetRequested = false;
    game.input.disarm();

    game.cameraRig.reset();
    game.vehicle.sync();
  }

  addPlayer(player) {
    if (
      !player ||
      player.id === this.selfId ||
      this.remotes.has(player.id)
    ) {
      return;
    }

    this.remotes.set(
      player.id,
      new RemoteVehicle(this.game.scene, player, this.game.physics)
    );

    this.updateCount();
  }

  sendState() {
    if (
      !this.running ||
      !this.selfId ||
      this.socket?.readyState !== WebSocket.OPEN ||
      this.socket.bufferedAmount > 64 * 1024
    ) {
      return;
    }

    const game = this.game;
    const snapshot = game.vehiclePhysics.snapshot();

    const paused =
      game.menu?.isOpen === true ||
      document.hidden;

    // Reading input here is safe: commands are still applied only by Game.
    // Avoid input sampling while the game is paused.
    const input = paused
      ? {
          steering: 0,
          throttle: 0,
          brake: 0,
          clutch: 0
        }
      : game.input.sample();

    const manual = game.drivingMode === "manual";
    const drivetrain = game.manualController.drivetrain;

    this.socket.send(JSON.stringify({
      type: "state",
      sequence: this.sequence++,
      state: {
        position: snapshot.position,
        rotation: snapshot.rotation,
        velocity: paused ? [0, 0, 0] : snapshot.velocity,

        steering: input.steering,
        throttle: input.throttle,
        brake: input.brake,
        clutch: input.clutch,

        gear: manual
          ? drivetrain.engagedGear
          : game.controller.direction,

        rpm: manual ? drivetrain.rpm : 0,
        engineRunning: manual ? drivetrain.engineRunning : true,
        mode: game.drivingMode,
        paused,

        // Turret state/events only -- remote clients reproduce the full
        // mechanical animation locally from this (see RemoteTurret.js)
        // rather than receiving per-part transforms every frame.
        turret: game.turret?.getNetworkState() ?? {
          state: "undeployed", yaw: 0, pitch: 0, fireSeq: 0
        },

        // HP bar / wreck visuals (see RemoteVehicle.js). Once connected,
        // health/maxHealth/dead are authoritative server-side (requirement
        // #10/#11) and the server overwrites these three fields with its
        // own combat record on every state message -- sent here mainly so
        // the very first few frames before that sync round-trips aren't
        // reporting stale/garbage values.
        health: game.playerHealth?.health ?? 0,
        maxHealth: game.playerHealth?.maxHealth ?? 0,
        dead: game.playerHealth?.dead === true,

        // Drives remote vehicle/turret evolution stage (see
        // RemoteVehicle.pushState -> getEvolutionStage()). Only the raw
        // level travels the wire -- every observer derives the visual stage
        // locally from this single number (see EvolutionConfig.js).
        level: game.levelSystem?.level ?? 1,

        // Drives the brighter/faster exhaust look on other players' cars
        // (see ExhaustSystem) -- purely presentational, not re-simulated.
        turbo: game.turbo?.active === true
      }
    }));
  }

  sendTurretHit(enemyId, damage) {
    if (
      !this.running ||
      !this.selfId ||
      this.socket?.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    this.socket.send(JSON.stringify({
      type: "turretHit",
      enemyId,
      damage
    }));
  }

  reportDelivery() {
    if (
      !this.running ||
      !this.selfId ||
      this.socket?.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    this.socket.send(JSON.stringify({ type: "delivery" }));
  }

  // updateLeaderboard(entries) {
  //   this.leaderboardList.innerHTML = "";

  //   for (const entry of entries) {
  //     const item = document.createElement("li");
  //     item.textContent = `${entry.name} — ${entry.deliveries} deliveries`;
  //     this.leaderboardList.append(item);
  //   }

  //   const hasEntries = entries.length > 0;
  //   this.leaderboardList.hidden = !hasEntries;
  //   this.leaderboardEmpty.hidden = hasEntries;

  //   this.syncPanelHeight();
  // }

  sendChat(text) {
    if (
      !this.running ||
      !this.selfId ||
      this.socket?.readyState !== WebSocket.OPEN
    ) {
      return false;
    }

    const trimmed = typeof text === "string" ? text.trim() : "";

    if (!trimmed) return false;

    this.socket.send(JSON.stringify({
      type: "chat",
      message: trimmed.slice(0, 200)
    }));

    return true;
  }

  animate(now) {
    const dt = Math.min(
      Math.max((now - this.lastRenderTime) / 1000, 0),
      0.1
    );

    this.lastRenderTime = now;

    for (const remote of this.remotes.values()) {
      remote.update(now, dt, this.game.camera);
    }

    this.localBubble.update(now);

    this.animationId = requestAnimationFrame(this.animate);
  }

  // Called by Game once per physics tick, right before physics.step(), so
  // every remote's collider sits where it's currently being drawn.
  syncPhysics() {
    for (const remote of this.remotes.values()) {
      remote.syncPhysics();
    }
  }

  updateCount() {
    const total = this.remotes.size + (this.selfId ? 1 : 0);

    this.count.textContent = `Players: ${total} / 8`;
    if (this.badgeCount) this.badgeCount.textContent = `${total}/8`;

    this.syncPanelHeight();
  }

  clearRemotes() {
    for (const remote of this.remotes.values()) {
      remote.dispose();
    }

    this.remotes.clear();
    this.updateCount();
  }

  dispose() {
    this.running = false;

    clearTimeout(this.reconnectTimer);
    clearInterval(this.sendTimer);
    cancelAnimationFrame(this.animationId);

    this.socket?.close(1000, "Game closed");
    this.clearRemotes();
    this.localBubble.dispose();
    this._panelResizeObserver?.disconnect();
    this.panel.remove();
    document.documentElement.style.removeProperty("--op-reserved");
  }
}