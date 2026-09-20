import "./style.css";

import { Game } from "./core/Game.js";
import { setupDiagnosticsExport } from "./ui/DiagnosticsExport.js";
import { MultiplayerClient } from "./multiplayer/MultiplayerClient.js";
import { ChatPanel } from "./ui/ChatPanel.js";
import {
  loadSavedPlayerName,
  savePlayerName,
  sanitizePlayerName
} from "./ui/PlayerNameMenu.js";

setupDiagnosticsExport();

const startButton = document.querySelector("#start");
const loading = document.querySelector("#loading");
const status = document.querySelector("#loading-status");
const nameInput = document.querySelector("#player-name");
const nameError = document.querySelector("#name-error");

nameInput.value = loadSavedPlayerName();

// Enter submits the name from the input, same as clicking Play.
nameInput.addEventListener("keydown", event => {
  if (event.code === "Enter") {
    event.preventDefault();
    startButton.click();
  }
});

nameInput.addEventListener("input", () => {
  nameError.textContent = "";
});

let multiplayer = null;
let chatPanel = null;
let starting = false;

startButton.addEventListener("click", async () => {
  // Guard against double submission (double click, or Enter and a click
  // landing in the same tick) without needing { once: true }, since an
  // invalid name must still allow the player to retry.
  if (starting) return;

  const name = sanitizePlayerName(nameInput.value);

  if (!name) {
    nameError.textContent =
      "Enter a name (up to 16 characters) before playing.";
    nameInput.focus();
    return;
  }

  starting = true;
  startButton.disabled = true;
  nameInput.disabled = true;
  savePlayerName(name);

  status.textContent =
    "Preparing renderer, terrain, and vehicle…";

  await new Promise(resolve => {
    requestAnimationFrame(() => {
      requestAnimationFrame(resolve);
    });
  });

  try {
    const game = new Game(document.querySelector("#game"));

    game.frame(performance.now());

    document.querySelector("#hud").hidden = false;
    document.querySelector("#combat-hud").hidden = false;
    loading.hidden = true;

    game.start();

    // A missing multiplayer server does not prevent local driving.
    try {
      multiplayer = new MultiplayerClient(game, name);
      game.multiplayer = multiplayer;
      chatPanel = new ChatPanel(multiplayer);
      multiplayer.chatPanel = chatPanel;
    } catch (error) {
      console.error("Multiplayer initialization failed:", error);
    }
  } catch (error) {
    console.error(error);

    status.textContent =
      `Could not start: ${error.message}. Check the console for details.`;

    startButton.textContent = "Reload the page to retry";
    starting = false;
    startButton.disabled = false;
    nameInput.disabled = false;
  }
});

window.addEventListener("beforeunload", () => {
  multiplayer?.dispose();
  chatPanel?.dispose();
});
