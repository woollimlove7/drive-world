import * as THREE from "three";
import * as CANNON from "cannon-es";
import { ChatBubble } from "./ChatBubble.js";
import { RemoteTurret } from "../turret/RemoteTurret.js";
import { ExhaustSystem } from "../vehicle/ExhaustSystem.js";
import { HealthBar } from "../gameplay/HealthBar.js";
import { VehicleDestruction } from "../vehicle/VehicleDestruction.js";
import { VehicleEvolutionRig } from "../vehicle/VehicleEvolution.js";
import { getEvolutionStage } from "../gameplay/EvolutionConfig.js";
import { DEFAULT_VEHICLE_TYPE } from "../vehicle/VehicleConfig.js";
import {
  buildVehicleBody,
  buildWheelGeometries,
  createWheel
} from "../vehicle/VehicleVisual.js";
import {
  COLLISION_GROUPS,
  REMOTE_VEHICLE_CANNON_MATERIAL
} from "../vehicle/CollisionGroups.js";

// Matches the local player's own chassis collider (VehiclePhysics.js) so a
// bump against a remote car and a bump against the local car's own shape
// feel the same size. Remote vehicles have no real physics simulation of
// their own (their position/rotation come entirely from network
// snapshots) -- this box only exists so the LOCAL player's dynamic body
// has something solid to push against. See MultiplayerClient.syncPhysics.
const COLLIDER_HALF_EXTENTS = new CANNON.Vec3(0.9, 0.3, 2);
const COLLIDER_OFFSET = new CANNON.Vec3(0, 0.15, 0);

const INTERPOLATION_DELAY = 120;

// A little clearance above the top edge of the nameplate sprite
// (label.position.y=2, label.scale.y=0.525) so the bubble tail never
// overlaps the player's name.
const BUBBLE_ANCHOR_Y = 2.35;

// ---------------------------------------------------------------------------
// RemoteVehicle
// ---------------------------------------------------------------------------
// Network/state representation of another player. All body/interior/wheel
// geometry and materials come from the shared VehicleVisual.js -- the exact
// same construction the local player's Vehicle.js uses -- so remote cars
// are visually identical to the local car. Only the *wiring* differs: each
// wheel here is wrapped in a small pivot group (steering angle + spin
// simulated from interpolated network state) instead of being positioned
// from real per-wheel physics transforms.

export class RemoteVehicle {
  constructor(scene, player, physics = null) {
    this.scene = scene;
    this.id = player.id;
    this.name = typeof player.name === "string" && player.name.length > 0
      ? player.name
      : `Driver ${player.id.slice(0, 6)}`;

    this.root = new THREE.Group();
    scene.add(this.root);

    this.samples = [];
    this.lastState = player.state;

    // Kinematic: driven directly by syncPhysics() from network state, never
    // moved by forces/gravity/solver impulses itself, but still solid to
    // the local player's dynamic chassis body. `physics` is optional so
    // this class still works if it's ever used without a physics world.
    this.physics = physics;
    this.body = null;

    if (physics) {
      this.body = new CANNON.Body({
        mass: 0,
        type: CANNON.Body.KINEMATIC,
        material: REMOTE_VEHICLE_CANNON_MATERIAL,
        collisionFilterGroup: COLLISION_GROUPS.REMOTE,
        // Only the local vehicle needs to feel this body. It deliberately
        // does not collide with the world (terrain/buildings/trees) or
        // with other remotes -- those interactions have no visible owner
        // to react to them, since this box isn't simulated.
        collisionFilterMask: COLLISION_GROUPS.VEHICLE
      });

      this.body.addShape(new CANNON.Box(COLLIDER_HALF_EXTENTS), COLLIDER_OFFSET);

      if (player.state?.position) {
        this.body.position.set(...player.state.position);
      }

      if (player.state?.rotation) {
        this.body.quaternion.set(...player.state.rotation);
      }

      physics.addBody(this.body);
    }

    // Full body/interior construction -- identical to the local player's
    // Vehicle.js, via the shared VehicleVisual.js builder. `driverEye` is a
    // camera anchor only the local player needs (ignored here); the
    // steering wheel and dashboard are kept for visual parity but are not
    // animated per-frame for remote players (see update() below) to avoid
    // redrawing a dashboard canvas texture for every remote car on screen.
    const {
      mat,
      exhaustPoints,
      steeringWheel
    } = buildVehicleBody(
      this.root,
      player.color,
      player.vehicleType || DEFAULT_VEHICLE_TYPE
    );

    this.paint = mat.paint;
    this.exhaustPoints = exhaustPoints;
    this.steeringWheel = steeringWheel;
    this.brakeMaterial = mat.tailLamp;

    // ---- Wheels -------------------------------------------------------------
    // Same detailed 5-spoke wheel (tire, alloy rim, brake disc, caliper,
    // lug nuts) as the local vehicle. Each wheel is wrapped in its own
    // pivot group parented under this.root -- unlike the local vehicle,
    // which positions wheels directly from real per-wheel physics
    // transforms, a remote vehicle has no physics simulation of its own, so
    // steering angle and spin are simulated from interpolated network
    // state in update() below. Pivot offsets match the local vehicle's
    // actual physics wheel connection points (see VehiclePhysics.js) so the
    // wheels sit under the fenders correctly now that the body is shared.
    const wheelGeo = buildWheelGeometries();

    this.wheels = [];

    for (const [x, z, front] of [
      [-0.95, 1.35, true],
      [0.95, 1.35, true],
      [-0.95, -1.35, false],
      [0.95, -1.35, false]
    ]) {
      const pivot = new THREE.Group();
      pivot.position.set(x, -0.32, z);

      // Matches Vehicle.js's convention (left wheels: +1, right wheels: -1)
      // so the rim face/spokes/lug nuts/brake disc all sit on the correct
      // (outboard-facing) side of the wheel.
      const inboardSign = x < 0 ? 1 : -1;
      const tire = createWheel(wheelGeo, mat, inboardSign);
      pivot.add(tire);

      this.root.add(pivot);
      this.wheels.push({ pivot, tire, front });
    }

    // ---- Nameplate ------------------------------------------------------------
    const NAMEPLATE_WIDTH = 300;
    const NAMEPLATE_HEIGHT = 80;
    // Leave real padding on both sides of the canvas -- the previous
    // threshold here (460) was wider than the canvas itself (300), so the
    // shrink-to-fit loop below never actually triggered until the text was
    // already being clipped by the canvas edge (see e.g. "Kurt Allen Kinch").
    const NAMEPLATE_MAX_TEXT_WIDTH = NAMEPLATE_WIDTH - 48;
    const NAMEPLATE_MIN_FONT_SIZE = 16;

    const canvas = document.createElement("canvas");
    canvas.width = NAMEPLATE_WIDTH;
    canvas.height = NAMEPLATE_HEIGHT;

    const context = canvas.getContext("2d");
    context.fillStyle = "#09131ed9";
    context.fillRect(0, 0, NAMEPLATE_WIDTH, NAMEPLATE_HEIGHT);
    context.fillStyle = "#ffffff";
    context.textAlign = "center";

    // Shrink the font for longer names so it never overflows the label.
    let fontSize = 50;
    context.font = `bold ${fontSize}px sans-serif`;

    while (
      context.measureText(this.name).width > NAMEPLATE_MAX_TEXT_WIDTH &&
      fontSize > NAMEPLATE_MIN_FONT_SIZE
    ) {
      fontSize -= 2;
      context.font = `bold ${fontSize}px sans-serif`;
    }

    // Safety net for the rare name that still doesn't fit even at the
    // smallest font size -- truncate with an ellipsis instead of letting
    // the canvas edge clip it.
    let displayName = this.name;
    if (context.measureText(displayName).width > NAMEPLATE_MAX_TEXT_WIDTH) {
      while (
        displayName.length > 1 &&
        context.measureText(`${displayName}…`).width > NAMEPLATE_MAX_TEXT_WIDTH
      ) {
        displayName = displayName.slice(0, -1);
      }
      displayName += "…";
    }

    context.fillText(displayName, NAMEPLATE_WIDTH / 2, 50);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;

    this.label = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: texture,
        depthWrite: false
      })
    );

    this.label.position.set(0.1, 2.4, 0);
    this.label.scale.set(1.25, 0.3, 1);
    this.root.add(this.label);

    this.chatBubble = new ChatBubble(this.root, BUBBLE_ANCHOR_Y);
    this.turret = new RemoteTurret(this.root, this.scene, player.color);

    // Armor evolution -- built lazily as this remote player's level
    // (reported in state.level) crosses each milestone; see pushState().
    // Wheel tech accents (stage 3+, see VehicleEvolution.js's
    // addWheelAccent) are attached to each wheel's actual visual mesh
    // group (`tire`), not its steering/spin pivot -- matching how the
    // local Vehicle.js passes its own wheel groups.
    this.evolution = new VehicleEvolutionRig(this.root, this.wheels.map(w => w.tire));
    this.evolutionStage = 0;

    this.exhaust = new ExhaustSystem(scene, this.root, this.exhaustPoints);

    // Other players' HP bar. Reuses the exact same billboarded 3D bar the
    // local player's own HP uses (Game.js's this.playerHealthBar) rather
    // than a second, separately-styled HP UI -- see HealthBar.js. Sits a
    // little above the nameplate sprite. Hidden until the first real health
    // value arrives (HealthBar starts hidden on its own).
    this.healthBar = new HealthBar(scene, {
      width: 1.6, height: 0.16, yOffset: 2.65
    });

    // Destroyed/wreck visuals for other players -- purely presentational
    // (no physics body drives a remote vehicle, so no tilt impulse is
    // passed to activate()). Toggled from pushState() below whenever the
    // networked `dead` flag changes.
    this.destruction = new VehicleDestruction(scene, this.root);
    this.wasDead = false;

    this.positionA = new THREE.Vector3();
    this.positionB = new THREE.Vector3();
    this.rotationA = new THREE.Quaternion();
    this.rotationB = new THREE.Quaternion();

    this.pushState(player.state, performance.now());
  }

  pushState(state, time) {
    if (!state) return;

    const previous = this.samples.at(-1)?.state;

    if (previous) {
      const distance = Math.hypot(
        state.position[0] - previous.position[0],
        state.position[1] - previous.position[1],
        state.position[2] - previous.position[2]
      );

      // Reset/teleport: do not interpolate a car across the entire map.
      if (distance > 12) {
        this.samples.length = 0;
      }
    }

    this.samples.push({ time, state });

    if (this.samples.length > 30) {
      this.samples.shift();
    }

    if (this.samples.length === 1) {
      this.root.position.fromArray(state.position);
      this.root.quaternion.fromArray(state.rotation);
    }

    this.lastState = state;

    // Turret is state/event-driven, not interpolated like position -- this
    // also covers late joiners, since `state` here is the player's full
    // current state (including turret) whether it arrived via "welcome",
    // "join", or a regular "snapshot".
    this.turret.setNetworkState(state.turret);

    // Vehicle/turret evolution stage is derived from the player's reported
    // level using the exact same mapping as the local player and the
    // server (see EvolutionConfig.js) -- never trusted as an independent
    // field, so there is nowhere for a remote player's visuals to disagree
    // with their actual level. The very first sample (covers a late
    // joiner's spawn, or this client's own reconnect) applies the current
    // stage instantly with no transformation replay; every stage change
    // after that plays the full animated sequence, same as the local
    // player, so other clients see it happen live (requirement: remote
    // evolution must animate too).
    const evolutionStage = getEvolutionStage(state.level);
    const animate = this._firstStateApplied === true;
    this.evolution.setStage(evolutionStage, { animate });
    this.turret.setEvolutionStage(evolutionStage, { animate });
    this.evolutionStage = evolutionStage;
    // Keeps remote turbo flames in visual sync with this player's own
    // armor stage (cyan-white at Elite/Ultimate) -- see ExhaustSystem.js.
    // Purely cosmetic; never affects turbo gameplay.
    this.exhaust.setEvolutionStage(evolutionStage);
    this._firstStateApplied = true;

    // HP bar. Health is reported by each client for itself (see
    // MultiplayerClient.sendState) the same way position/steering/turret
    // state already are -- this game has no PvP damage between players, so
    // there is no separate server-authoritative combat value to defer to
    // here. Missing/invalid numbers simply leave the bar in its last known
    // (or initially hidden) state rather than drawing a wrong one.
    if (
      Number.isFinite(state.health) &&
      Number.isFinite(state.maxHealth) &&
      state.maxHealth > 0
    ) {
      this.healthBar.setRatio(state.health / state.maxHealth);
    }

    // Destroyed/wreck visuals -- mirrors the local player's
    // playerHealth.onDeath/onRespawn (see Game.js), driven here by the
    // networked `dead` flag instead of a local PlayerHealth instance.
    const isDead = state.dead === true;
    if (isDead && !this.wasDead) {
      this.destruction.activate();
    } else if (!isDead && this.wasDead) {
      this.destruction.deactivate();
    }
    this.wasDead = isDead;
  }

  // Called by MultiplayerClient when a `chat` message arrives for this
  // player's id. Kept separate from network parsing so RemoteVehicle
  // knows nothing about the wire format.
  showMessage(text) {
    this.chatBubble.show(text);
  }

  // Called once per physics tick by Game (via MultiplayerClient), just
  // before physics.step(). Copies the already-interpolated visual
  // transform (computed in update() below, on the render loop) onto the
  // kinematic collider. A frame of lag between the two loops is
  // imperceptible and far simpler than merging them.
  syncPhysics() {
    if (!this.body) return;

    this.body.position.set(
      this.root.position.x,
      this.root.position.y,
      this.root.position.z
    );

    this.body.quaternion.set(
      this.root.quaternion.x,
      this.root.quaternion.y,
      this.root.quaternion.z,
      this.root.quaternion.w
    );

    this.body.velocity.setZero();
    this.body.angularVelocity.setZero();
    this.body.aabbNeedsUpdate = true;
  }

  // camera is optional (billboards the HP bar and exhaust puffs toward it);
  // callers that don't pass one just skip that per-frame orientation update.
  update(now, dt, camera = null) {
    this.chatBubble.update(now);

    if (!this.samples.length) {
      // No network samples yet (e.g. the very first frame): still animate
      // the turret in place so it isn't stuck on a stale pose.
      this.turret.update(dt);
      this.evolution.update(dt);
      this.destruction.update(dt, camera);
      return;
    }

    const renderTime = now - INTERPOLATION_DELAY;

    while (
      this.samples.length > 2 &&
      this.samples[1].time <= renderTime
    ) {
      this.samples.shift();
    }

    const first = this.samples[0];
    const second = this.samples[1] ?? first;

    const duration = second.time - first.time;

    const alpha = duration > 0
      ? THREE.MathUtils.clamp(
          (renderTime - first.time) / duration,
          0,
          1
        )
      : 0;

    this.positionA.fromArray(first.state.position);
    this.positionB.fromArray(second.state.position);

    this.rotationA.fromArray(first.state.rotation);
    this.rotationB.fromArray(second.state.rotation);

    this.root.position.lerpVectors(
      this.positionA,
      this.positionB,
      alpha
    );

    this.root.quaternion.slerpQuaternions(
      this.rotationA,
      this.rotationB,
      alpha
    );

    const state = second.state;

    const speed = state.paused
      ? 0
      : Math.hypot(...state.velocity);

    for (const wheel of this.wheels) {
      wheel.pivot.rotation.y = wheel.front
        ? -state.steering * 0.48
        : 0;

      // Presentation estimate; not replicated wheel physics.
      wheel.tire.rotation.x +=
        speed / 0.36 * dt * (state.gear === -1 ? -1 : 1);
    }

    this.brakeMaterial.emissiveIntensity =
      state.brake > 0.1 ? 1.5 : 0.25;

    // Cheap visual-parity touch: the local vehicle rotates its interior
    // steering wheel from live steering input (see
    // Vehicle.updatePresentation); mirroring that here from the same
    // networked `state.steering` used for the front wheels above costs one
    // rotation assignment per frame, no canvas redraw.
    this.steeringWheel.rotation.z = state.steering * Math.PI * 1.25;

    // Runs after this.root's position/quaternion are updated above so the
    // turret's own world-matrix math (muzzle position for fire effects)
    // reflects this frame's vehicle transform.
    this.turret.update(dt);

    // Advances any in-progress armor-reveal animation (see
    // VehicleEvolutionRig.beginReveal/update). Without this call the newly
    // added stage group set up by setStage() in pushState() just sits at
    // its initial near-zero scale forever -- it's added to the scene, but
    // never actually animates into view for anyone watching live. Mirrors
    // the same call in the "no samples yet" branch above.
    this.evolution.update(dt);

    // this.root.matrixWorld must reflect the position set above; Three
    // only refreshes it during rendering, so ExhaustSystem.emit() (which
    // reads matrixWorld) works off a one-frame-stale transform. That lag
    // is imperceptible for a trailing exhaust puff.
    this.root.updateMatrixWorld();

    this.exhaust.update(dt, camera, {
      running: state.engineRunning === true,
      boosting: state.turbo === true
    });

    this.destruction.update(dt, camera);

    if (camera) {
      this.healthBar.updateTransform(this.root.position, camera);
    }
  }

  dispose() {
    this.chatBubble.dispose();
    this.turret.dispose();
    this.exhaust.dispose();
    this.destruction.dispose();
    this.healthBar.dispose();
    this.scene.remove(this.root);

    if (this.body) {
      this.physics?.removeBody(this.body);
      this.body = null;
    }

    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();

    this.root.traverse(object => {
      if (object.geometry) geometries.add(object.geometry);

      const objectMaterials = Array.isArray(object.material)
        ? object.material
        : object.material
          ? [object.material]
          : [];

      for (const material of objectMaterials) {
        materials.add(material);
        if (material.map) textures.add(material.map);
      }
    });

    for (const geometry of geometries) geometry.dispose();
    for (const texture of textures) texture.dispose();
    for (const material of materials) material.dispose();

    this.samples.length = 0;
  }
}