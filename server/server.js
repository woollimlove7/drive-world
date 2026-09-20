import http from "node:http";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocket, WebSocketServer } from "ws";

import { EnemyWorld } from "./EnemyWorld.js";
import { ENEMY_CONFIG, PLAYER_CONFIG, TURRET_CONFIG } from "../src/turret/TurretConfig.js";
import { getEvolutionStage } from "../src/gameplay/EvolutionConfig.js";

const PORT = Number(process.env.PORT || 3001);

// Public hosting needs to listen on all network interfaces.
const HOST = process.env.HOST || "0.0.0.0";

const MAX_PLAYERS = 8;
const SNAPSHOT_RATE = 15;
const MAX_NAME_LENGTH = 16;
const MAX_CHAT_LENGTH = 200;
const CHAT_WINDOW_MS = 4000;
const CHAT_LIMIT_PER_WINDOW = 6;

// ---------------------------------------------------------------------------
// AUTHORITATIVE ENEMY WORLD (requirements #5/#6/#7/#8/#9/#10)
// ---------------------------------------------------------------------------
// One EnemyWorld instance, owned by the server, is the only place enemy
// spawning/position/HP/death/targeting are decided. Every connected client
// only ever renders what this broadcasts (see EnemyWorld.js's header
// comment and TargetSystem.applyServerState on the client).
// ---------------------------------------------------------------------------
const ENEMY_TICK_RATE = 12; // Hz -- simulation + broadcast rate for enemies
const ENEMY_TICK_MS = 1000 / ENEMY_TICK_RATE;
const enemyWorld = new EnemyWorld();

// A player's turret damage can be boosted by leveling (see PLAYER_CONFIG's
// turretDamageBonusPerInterval in TurretConfig.js), so a single fixed
// damage value can't be trusted as the exact cap -- but any single hit
// wildly larger than the base damage is not a legitimate leveled-up shot,
// it's a forged/cheated message. This bound is deliberately generous.
const MAX_TURRET_HIT_DAMAGE = TURRET_CONFIG.damage * 10;
const MAX_ENEMY_ID_LENGTH = 32;

// Session-only delivery stats (Phase 2). There is no database in this
// project, so the leaderboard tracks players connected during the
// current server process rather than persisting across restarts.
const DELIVERY_REWARD = 25;
const MIN_DELIVERY_INTERVAL_MS = 3000;
const LEADERBOARD_SIZE = 10;

const SERVER_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIRECTORY = path.resolve(SERVER_DIRECTORY, "../dist");

const COLORS = [
  "#ef5350",
  "#4285f4",
  "#58b76b",
  "#f5ce47",
  "#aa70d6",
  "#f29b43",
  "#ee83bd",
  "#50cad5"
];

const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean)
);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".bin": "application/octet-stream",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8"
};

const players = new Map();

// Strip control characters and bidi/zero-width tricks; the client-sent
// name is never trusted beyond this sanitization.
function sanitizeName(raw) {
  if (typeof raw !== "string") return null;

  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E<>]/g, "")
    .trim()
    .slice(0, MAX_NAME_LENGTH);

  return cleaned.length > 0 ? cleaned : null;
}

function fallbackName(id) {
  return `Racer${id.slice(0, 4)}`;
}

function sanitizeChatMessage(raw) {
  if (typeof raw !== "string") return null;

  const cleaned = raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, MAX_CHAT_LENGTH);

  return cleaned.length > 0 ? cleaned : null;
}

function textResponse(response, status, message) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8"
  });

  response.end(message);
}

async function serveHTTP(request, response) {
  if (!["GET", "HEAD"].includes(request.method)) {
    response.setHeader("Allow", "GET, HEAD");
    textResponse(response, 405, "Method not allowed");
    return;
  }

  let pathname;

  try {
    pathname = decodeURIComponent(
      new URL(request.url, "http://localhost").pathname
    );
  } catch {
    textResponse(response, 400, "Invalid URL");
    return;
  }

  if (pathname === "/health") {
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    });

    response.end(
      request.method === "HEAD"
        ? undefined
        : JSON.stringify({
            ok: true,
            players: players.size,
            capacity: MAX_PLAYERS
          })
    );

    return;
  }

  if (pathname === "/multiplayer") {
    textResponse(response, 426, "WebSocket connection required");
    return;
  }

  if (pathname.includes("\0")) {
    textResponse(response, 400, "Invalid path");
    return;
  }

  const relativePath = pathname === "/"
    ? "index.html"
    : pathname.replace(/^\/+/, "");

  const filename = path.resolve(DIST_DIRECTORY, relativePath);
  const relative = path.relative(DIST_DIRECTORY, filename);

  // Only serve files inside the production build directory.
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    textResponse(response, 403, "Forbidden");
    return;
  }

  let fileInfo;

  try {
    fileInfo = await stat(filename);
  } catch {
    textResponse(
      response,
      404,
      pathname === "/"
        ? "Game build missing. Run npm run build first."
        : "Not found"
    );
    return;
  }

  if (!fileInfo.isFile()) {
    textResponse(response, 404, "Not found");
    return;
  }

  const extension = path.extname(filename).toLowerCase();

  response.writeHead(200, {
    "Content-Type":
      MIME_TYPES[extension] || "application/octet-stream",
    "Content-Length": fileInfo.size,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control":
      relative.startsWith(`assets${path.sep}`)
        ? "public, max-age=31536000, immutable"
        : "no-cache"
  });

  if (request.method === "HEAD") {
    response.end();
    return;
  }

  const stream = createReadStream(filename);

  stream.on("error", error => {
    console.error("Static file read failed:", error.message);
    response.destroy();
  });

  stream.pipe(response);
}

const server = http.createServer((request, response) => {
  serveHTTP(request, response).catch(error => {
    console.error("HTTP request failed:", error);

    if (!response.headersSent) {
      textResponse(response, 500, "Server error");
    } else {
      response.destroy();
    }
  });
});

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 4096,
  perMessageDeflate: false
});

server.on("upgrade", (request, socket, head) => {
  let pathname;

  try {
    pathname = new URL(
      request.url,
      "http://localhost"
    ).pathname;
  } catch {
    socket.destroy();
    return;
  }

  const origin = request.headers.origin;

  if (
    pathname !== "/multiplayer" ||
    (allowedOrigins.size > 0 && !allowedOrigins.has(origin))
  ) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, ws => {
    wss.emit("connection", ws, request);
  });
});

function send(ws, message) {
  if (ws.readyState !== WebSocket.OPEN) return;

  if (ws.bufferedAmount > 256 * 1024) {
    ws.close(1013, "Connection too slow");
    return;
  }

  ws.send(JSON.stringify(message));
}

function broadcast(message, exceptId = null) {
  for (const player of players.values()) {
    if (player.id !== exceptId) {
      send(player.ws, message);
    }
  }
}

function initialSpawn(slot) {
  return {
    position: [
      -15 + (slot % 4) * 10,
      1.2,
      -72 + Math.floor(slot / 4) * 10
    ],
    rotation: [0, 0, 0, 1]
  };
}

const TURRET_STATES = new Set([
  "undeployed", "deploying", "deployed", "undeploying"
]);

function initialTurretState() {
  return { state: "undeployed", yaw: 0, pitch: 0, fireSeq: 0 };
}

function initialState(spawn) {
  return {
    position: [...spawn.position],
    rotation: [...spawn.rotation],
    velocity: [0, 0, 0],
    steering: 0,
    throttle: 0,
    brake: 0,
    clutch: 0,
    gear: 0,
    rpm: 0,
    engineRunning: false,
    mode: "arcade",
    paused: false,
    turret: initialTurretState(),

    // These fields are cosmetic mirrors of player.combat (below) --
    // kept on `state` too because that's what already flows out through
    // the existing "snapshot"/"welcome"/"join" broadcasts and what
    // RemoteVehicle.js already reads client-side. See syncCombatIntoState().
    health: PLAYER_CONFIG.maxHealth,
    maxHealth: PLAYER_CONFIG.maxHealth,
    dead: false,
    turbo: false,

    // Raw level -- RemoteVehicle.pushState() derives its own evolution
    // stage from this via getEvolutionStage() (see EvolutionConfig.js), so
    // this is the only evolution-related value that actually needs to
    // travel the wire. vehicleEvolutionStage below is an additional,
    // server-recomputed convenience mirror -- see its comment.
    level: 1,

    // Recomputed server-side from player.combat.level on every sync, never
    // taken from the client -- see syncCombatIntoState(). Not currently
    // consumed by any client code (RemoteVehicle already derives its own
    // stage from `level` above), but kept authoritative and available here
    // per the "never trust a client-supplied evolution stage" requirement,
    // in case any future UI/leaderboard wants the stage without
    // re-deriving it.
    vehicleEvolutionStage: 0
  };
}

// ---------------------------------------------------------------------------
// AUTHORITATIVE PLAYER COMBAT STATE (requirement #11)
// ---------------------------------------------------------------------------
// Unlike driving/turret state (still client-reported + bounded, see
// validateState below), HP/dead is fully server-owned once enemies became
// networked: enemy damage has to be decided in exactly one place for every
// player to agree on it, the same way enemy HP does.
//
// `level` joined this record as part of the evolution feature: it used to
// be entirely absent server-side, which meant maxHealth here never grew
// past the level-1 default and PlayerHealth.applyServerState() on the
// client would silently overwrite a leveled-up player's real maxHealth
// back down to 100 on the very next snapshot. See deriveMaxHealth() below.
// ---------------------------------------------------------------------------
function initialCombat() {
  return {
    health: PLAYER_CONFIG.maxHealth,
    maxHealth: PLAYER_CONFIG.maxHealth,
    dead: false,
    respawnAt: 0,
    level: 1
  };
}

// Same level -> maxHealth formula PlayerHealth.addMaxHealth() produces
// client-side (Game.js's onLevelUp calls it once per level with
// PLAYER_CONFIG.hpPerLevel) -- kept as one function so the two never drift.
function deriveMaxHealth(level) {
  return PLAYER_CONFIG.maxHealth + (level - 1) * PLAYER_CONFIG.hpPerLevel;
}

// Mirrors the authoritative combat fields onto player.state so they ride
// along with the existing snapshot/welcome/join broadcasts unchanged.
function syncCombatIntoState(player) {
  player.state.health = player.combat.health;
  player.state.maxHealth = player.combat.maxHealth;
  player.state.dead = player.combat.dead;
  player.state.level = player.combat.level;
  player.state.vehicleEvolutionStage = getEvolutionStage(player.combat.level);
}

// Soft anti-cheat, not real anti-cheat: there is no server-side XP
// simulation (kills/XP are tracked for the leaderboard, not replayed into
// a level here), so this cannot catch a modified client that simply claims
// a too-high level from the start. What it DOES guarantee is that level
// (and therefore maxHealth/evolution stage) can only ever increase within
// a session, matching the game's own "evolution never regresses" rule
// (see EvolutionConfig.js) and preventing a client from lowering its
// reported level later to some advantage. Called once per validated
// "state" message, before syncCombatIntoState() mirrors the result back
// onto player.state.
const MAX_LEVEL = 999; // sanity ceiling well above anything reachable in a session

function applyReportedLevel(player, reportedLevel) {
  const level = Number.isInteger(reportedLevel)
    ? Math.max(1, Math.min(MAX_LEVEL, reportedLevel))
    : player.combat.level;

  if (level <= player.combat.level) return;

  player.combat.level = level;
  player.combat.maxHealth = deriveMaxHealth(level);

  // Fully restore HP to the new ceiling, mirroring PlayerHealth.addMaxHealth()'s
  // "leveling up fully restores health" behavior client-side -- without this,
  // a level-up would raise the ceiling but leave current HP unchanged (or only
  // partially topped off), unlike the local/offline experience. A dead player
  // stays dead/at 0 HP here; their next respawn already sets health to the
  // (now higher) maxHealth on its own.
  if (!player.combat.dead) {
    player.combat.health = player.combat.maxHealth;
  }
}

function applyDamageToPlayer(playerId, amount, enemyId) {
  const player = players.get(playerId);

  // Requirement #2: a dead player must not receive damage, full stop --
  // enforced here at the single point damage is ever applied, not just by
  // EnemyWorld choosing not to target them.
  if (!player || player.combat.dead || !Number.isFinite(amount) || amount <= 0) {
    return;
  }

  player.combat.health = Math.max(0, player.combat.health - amount);

  if (player.combat.health <= 0) {
    player.combat.dead = true;
    player.combat.respawnAt = Date.now() + PLAYER_CONFIG.respawnDelay * 1000;
  }

  syncCombatIntoState(player);
}

function onEnemyKilled(killerPlayerId, enemy) {
  const killer = players.get(killerPlayerId);
  if (!killer) return;

  const xpReward = enemy.kind === "boss"
    ? ENEMY_CONFIG.boss.xpReward
    : ENEMY_CONFIG.normal.xpReward;

  send(killer.ws, {
    type: "enemyKilled",
    enemyId: enemy.id,
    kind: enemy.kind,
    xpReward
  });
}

// Only the turret's state/aim/fire-event fields are ever synchronized (see
// client MultiplayerClient.sendState / RemoteTurret.js) -- never the
// individual mechanical parts, so this validator stays this small.
function validateTurret(raw) {
  if (!raw || typeof raw !== "object") return initialTurretState();

  return {
    state: TURRET_STATES.has(raw.state) ? raw.state : "undeployed",
    yaw: bounded(raw.yaw, -Math.PI, Math.PI),
    pitch: bounded(raw.pitch, -Math.PI, Math.PI),
    fireSeq: Number.isInteger(raw.fireSeq)
      ? Math.max(0, Math.min(65535, raw.fireSeq))
      : 0
  };
}

function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    color: player.color,
    spawn: player.spawn,
    state: player.state
  };
}

function buildLeaderboard() {
  return Array.from(players.values())
    .filter(player => player.deliveries > 0)
    .sort((a, b) => b.deliveries - a.deliveries)
    .slice(0, LEADERBOARD_SIZE)
    .map(player => ({
      name: player.name,
      deliveries: player.deliveries,
      score: player.score
    }));
}

function broadcastLeaderboard() {
  broadcast({ type: "leaderboard", entries: buildLeaderboard() });
}

function validVector(value, length, limit) {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every(component =>
      Number.isFinite(component) &&
      Math.abs(component) <= limit
    )
  );
}

function bounded(value, min, max, fallback = 0) {
  return Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function validateState(raw) {
  if (!raw || typeof raw !== "object") return null;

  if (!validVector(raw.position, 3, 500)) return null;
  if (!validVector(raw.velocity, 3, 200)) return null;
  if (!validVector(raw.rotation, 4, 1.01)) return null;

  const length = Math.hypot(...raw.rotation);

  if (length < 0.5 || length > 1.5) return null;

  return {
    position: [...raw.position],
    rotation: raw.rotation.map(value => value / length),
    velocity: [...raw.velocity],

    steering: bounded(raw.steering, -1, 1),
    throttle: bounded(raw.throttle, 0, 1),
    brake: bounded(raw.brake, 0, 1),
    clutch: bounded(raw.clutch, 0, 1),

    gear:
      Number.isInteger(raw.gear) &&
      raw.gear >= -1 &&
      raw.gear <= 6
        ? raw.gear
        : 0,

    rpm: bounded(raw.rpm, 0, 12000),
    engineRunning: raw.engineRunning === true,
    mode: raw.mode === "manual" ? "manual" : "arcade",
    paused: raw.paused === true,
    turret: validateTurret(raw.turret),

    // Parsed here just to keep this object's shape stable and bounded --
    // these two fields are ALWAYS immediately overwritten with the
    // server's own authoritative combat record right after this function
    // returns (see the "state" message handler's syncCombatIntoState()
    // call), since enemy damage is no longer client-reported (requirement
    // #10/#11). Never trust these two parsed values for anything.
    maxHealth: bounded(raw.maxHealth, 1, 100000, 100),
    health: bounded(raw.health, 0, bounded(raw.maxHealth, 1, 100000, 100)),

    // Destroyed/wreck flag -- same "client-reported presentation value"
    // treatment as health above (see MultiplayerClient.sendState).
    dead: raw.dead === true,

    turbo: raw.turbo === true,

    // Parsed and bounded here just like health/maxHealth above, and same
    // caveat: this parsed value is never trusted directly. The "state"
    // message handler passes it through applyReportedLevel() first, which
    // enforces monotonicity and re-derives maxHealth server-side, before
    // syncCombatIntoState() overwrites this field with the authoritative
    // result.
    level: Number.isInteger(raw.level)
      ? Math.max(1, Math.min(MAX_LEVEL, raw.level))
      : 1
  };
}

wss.on("connection", (ws, request) => {
  ws.on("error", error => {
    console.warn("WebSocket error:", error.message);
  });

  if (players.size >= MAX_PLAYERS) {
    send(ws, {
      type: "error",
      message: "This session is full. Maximum eight players."
    });

    ws.close(4001, "Session full");
    return;
  }

  const usedSlots = new Set(
    Array.from(players.values(), player => player.slot)
  );

  let slot = 0;
  while (usedSlots.has(slot)) slot++;

  const spawn = initialSpawn(slot);
  const id = randomUUID();

  let requestedName = null;

  try {
    const { searchParams } = new URL(request.url, "http://localhost");
    requestedName = sanitizeName(searchParams.get("name"));
  } catch {
    requestedName = null;
  }

  const player = {
    id,
    ws,
    slot,
    name: requestedName || fallbackName(id),
    color: COLORS[slot],
    spawn,
    state: initialState(spawn),
    combat: initialCombat(),
    lastSequence: -1,
    rateWindow: Date.now(),
    messageCount: 0,
    chatWindow: Date.now(),
    chatCount: 0,
    deliveries: 0,
    score: 0,
    lastDeliveryAt: 0
  };

  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  players.set(player.id, player);

  send(ws, {
    type: "welcome",
    protocol: 1,
    self: publicPlayer(player),
    players: Array.from(players.values(), publicPlayer),
    leaderboard: buildLeaderboard(),

    // New player joining must see the CURRENT enemy world, never spawn
    // their own separate set (requirement #8's "initial enemy state when a
    // player joins").
    enemies: enemyWorld.serialize(players)
  });

  broadcast({
    type: "join",
    player: publicPlayer(player)
  }, player.id);

  console.log(
    `Joined ${player.id} (${players.size}/${MAX_PLAYERS})`
  );

  ws.on("message", (data, isBinary) => {
    const now = Date.now();

    if (now - player.rateWindow >= 1000) {
      player.rateWindow = now;
      player.messageCount = 0;
    }

    player.messageCount++;

    if (player.messageCount > 50) {
      ws.close(1008, "Message rate exceeded");
      return;
    }

    if (isBinary) {
      ws.close(1003, "Text messages required");
      return;
    }

    let message;

    try {
      message = JSON.parse(data.toString());
    } catch {
      ws.close(1007, "Invalid JSON");
      return;
    }

    if (message?.type === "state") {
      if (
        !Number.isSafeInteger(message.sequence) ||
        message.sequence <= player.lastSequence
      ) {
        return;
      }

      const state = validateState(message.state);

      if (!state) return;

      player.lastSequence = message.sequence;
      player.state = state;

      // Level feeds maxHealth/evolution-stage derivation (see
      // applyReportedLevel()) before the combat record gets mirrored back
      // onto player.state just below -- must run first so that mirror
      // reflects this message's level, not last message's.
      applyReportedLevel(player, state.level);

      // health/maxHealth/dead/level on the incoming state are whatever the
      // client last reported for itself -- now that enemy damage is
      // authoritative (requirement #10/#11), those fields must always be
      // overwritten with the server's own combat record rather than
      // trusted from the client, immediately after every state update.
      syncCombatIntoState(player);
      return;
    }

    if (message?.type === "turretHit") {
      // A player's turret reports "I hit enemy X for Y damage" -- the
      // server is the one that actually applies it (requirement #10),
      // validates it's plausible, and figures out whether that shot was
      // the killing blow (for XP -- see onEnemyKilled).
      if (player.combat.dead) return;

      const enemyId = message.enemyId;

      if (
        typeof enemyId !== "string" ||
        enemyId.length === 0 ||
        enemyId.length > MAX_ENEMY_ID_LENGTH
      ) {
        return;
      }

      const damage = Number(message.damage);

      if (!Number.isFinite(damage) || damage <= 0 || damage > MAX_TURRET_HIT_DAMAGE) {
        return;
      }

      enemyWorld.applyDamage(enemyId, damage, player.id);
      return;
    }

    if (message?.type === "delivery") {
      const now = Date.now();

      // The client determines completion locally (proximity to a beacon);
      // this only guards the shared leaderboard against spam, it does not
      // re-validate the delivery itself.
      if (now - player.lastDeliveryAt < MIN_DELIVERY_INTERVAL_MS) return;

      player.lastDeliveryAt = now;
      player.deliveries++;
      player.score += DELIVERY_REWARD;

      broadcastLeaderboard();
      return;
    }

    if (message?.type === "chat") {
      const chatNow = Date.now();

      if (chatNow - player.chatWindow >= CHAT_WINDOW_MS) {
        player.chatWindow = chatNow;
        player.chatCount = 0;
      }

      player.chatCount++;

      // Silently drop messages over the burst limit instead of
      // disconnecting; the generic message-rate check above already
      // guards against outright flooding.
      if (player.chatCount > CHAT_LIMIT_PER_WINDOW) return;

      const text = sanitizeChatMessage(message.message);

      if (!text) return;

      // The server, never the client, is the source of truth for who
      // sent a message and under what name.
      broadcast({
        type: "chat",
        playerId: player.id,
        playerName: player.name,
        message: text,
        timestamp: Date.now()
      });

      return;
    }
  });

  ws.on("close", () => {
    if (!players.delete(player.id)) return;

    broadcast({
      type: "leave",
      id: player.id
    });

    broadcastLeaderboard();

    console.log(
      `Left ${player.id} (${players.size}/${MAX_PLAYERS})`
    );
  });
});

enemyWorld.onPlayerDamage = applyDamageToPlayer;
enemyWorld.onEnemyKilled = onEnemyKilled;

const snapshotTimer = setInterval(() => {
  if (!players.size) return;

  broadcast({
    type: "snapshot",
    players: Array.from(players.values(), player => ({
      id: player.id,
      state: player.state
    }))
  });
}, 1000 / SNAPSHOT_RATE);

// ---------------------------------------------------------------------------
// ENEMY SIMULATION TICK (requirements #5/#6/#8)
// ---------------------------------------------------------------------------
// Runs the ONE authoritative enemy simulation and broadcasts its resulting
// state to every connected player at a fixed rate, independent of the
// per-player driving-state snapshot above. Also handles authoritative
// player-combat respawn timing here, since it's driven by the same clock.
// ---------------------------------------------------------------------------
let lastEnemyTick = Date.now();

const enemyTimer = setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.25, (now - lastEnemyTick) / 1000);
  lastEnemyTick = now;

  // Authoritative respawn: revive any player whose respawn delay elapsed.
  // Controls/targetability are restored automatically for them from this
  // point on -- EnemyWorld.findNearestPlayer() only ever considers players
  // with combat.dead === false, and the client re-enables movement input
  // the moment it sees its own `dead` flag go false (see
  // PlayerHealth.applyServerState on the client).
  for (const player of players.values()) {
    if (player.combat.dead && now >= player.combat.respawnAt) {
      player.combat.dead = false;
      player.combat.health = player.combat.maxHealth;
      syncCombatIntoState(player);
    }
  }

  if (players.size > 0) {
    enemyWorld.update(dt, players);

    broadcast({
      type: "enemies",
      enemies: enemyWorld.serialize(players)
    });
  }
}, ENEMY_TICK_MS);

const heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }

    ws.isAlive = false;
    ws.ping();
  }
}, 10000);

function shutdown() {
  clearInterval(snapshotTimer);
  clearInterval(enemyTimer);
  clearInterval(heartbeatTimer);

  for (const ws of wss.clients) {
    ws.close(1001, "Server shutting down");
  }

  server.close();
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(PORT, HOST, () => {
  console.log(`Driveworld listening on ${HOST}:${PORT}`);
  console.log(`Serving production game from ${DIST_DIRECTORY}`);
  console.log(`Multiplayer capacity: ${MAX_PLAYERS}`);
});