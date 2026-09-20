const MAX_HISTORY = 50;
const MAX_MESSAGE_LENGTH = 200;

const STORAGE_KEY = "driveworld.chat.v1";
const SIZES = ["compact", "normal", "expanded"];

// Same convention used by CameraManager/InputManager: never react to a
// game shortcut while the player is typing into a text field.
function isEditingTarget(element) {
  return (
    element instanceof HTMLElement &&
    (
      element.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)
    )
  );
}

function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));

    if (saved && typeof saved === "object") {
      return {
        visible: saved.visible !== false,
        size: SIZES.includes(saved.size) ? saved.size : "compact"
      };
    }
  } catch {
    // Storage unavailable (e.g. private browsing). Fall through to
    // the default, visible/compact, same as a first-time player.
  }

  return { visible: true, size: "compact" };
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Preference just won't persist across sessions; chat still works.
  }
}

export class ChatPanel {
  constructor(multiplayerClient) {
    this.client = multiplayerClient;
    this.messageCount = 0;
    this.sending = false;

    const prefs = loadPrefs();
    this.size = prefs.size;
    this.visible = prefs.visible;

    this.buildUI();
    this.bindEvents();

    this.applySize();
    this.applyVisibility({ animate: false });
  }

  buildUI() {
    // Small pill that reappears once the player hides the main panel —
    // the only way back in besides pressing Enter.
    this.showButton = document.createElement("button");
    this.showButton.type = "button";
    this.showButton.id = "chat-show";
    this.showButton.textContent = "💬 Chat";
    this.showButton.setAttribute("aria-label", "Show chat");

    this.panel = document.createElement("section");
    this.panel.id = "chat-panel";
    this.panel.setAttribute("aria-label", "Multiplayer chat");

    const header = document.createElement("header");
    header.id = "chat-header";

    const title = document.createElement("strong");
    title.id = "chat-title";
    title.textContent = "Chat";

    const actions = document.createElement("div");
    actions.id = "chat-header-actions";

    this.resizeButton = document.createElement("button");
    this.resizeButton.type = "button";
    this.resizeButton.id = "chat-resize";
    this.resizeButton.title = "Resize chat";
    this.resizeButton.setAttribute("aria-label", "Resize chat");
    this.resizeButton.textContent = "⤢";

    this.hideButton = document.createElement("button");
    this.hideButton.type = "button";
    this.hideButton.id = "chat-hide";
    this.hideButton.title = "Hide chat";
    this.hideButton.setAttribute("aria-label", "Hide chat");
    this.hideButton.textContent = "–";

    actions.append(this.resizeButton, this.hideButton);
    header.append(title, actions);

    this.log = document.createElement("div");
    this.log.id = "chat-log";
    this.log.setAttribute("role", "log");
    this.log.setAttribute("aria-live", "polite");

    const form = document.createElement("div");
    form.id = "chat-form";

    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.id = "chat-input";
    this.input.dataset.chatInput = "true";
    this.input.maxLength = MAX_MESSAGE_LENGTH;
    this.input.autocomplete = "off";
    this.input.enterKeyHint = "send";
    this.input.placeholder = "Press Enter to chat…";

    this.sendButton = document.createElement("button");
    this.sendButton.type = "button";
    this.sendButton.id = "chat-send";
    this.sendButton.textContent = "Send";

    form.append(this.input, this.sendButton);
    this.panel.append(header, this.log, form);

    document.body.append(this.panel, this.showButton);
  }

  bindEvents() {
    this.showButton.addEventListener("click", () => {
      this.setVisible(true);
      this.focusInput();
    });

    this.hideButton.addEventListener("click", () => {
      // A message being composed is intentionally discarded: hiding the
      // panel is the player choosing to stop chatting for now.
      this.input.value = "";
      this.input.blur();
      this.setVisible(false);
    });

    this.resizeButton.addEventListener("click", () => this.cycleSize());
    this.sendButton.addEventListener("click", () => this.trySend());

    this.input.addEventListener("keydown", event => {
      if (event.code === "Enter" && !event.shiftKey) {
        event.preventDefault();
        // Stop the bubble-phase global handler below from re-processing
        // the same Enter press (it only reacts when the input is NOT
        // the focused element, but keep this explicit and cheap).
        event.stopPropagation();
        this.trySend();
        return;
      }

      if (event.code === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        // Cancel without sending: discard the draft and hand control
        // back to driving immediately.
        this.input.value = "";
        this.input.blur();
      }
    });

    // Bubble-phase, so SettingsMenu's capture-phase Escape handler (which
    // defers to us while the chat input is focused) always runs first,
    // and so InputManager/CameraManager's own bubble-phase listeners see
    // the same event without any of them needing to know about chat.
    this.enterKeyHandler = event => {
      if (event.code !== "Enter" || event.repeat) return;
      if (document.activeElement === this.input) return;

      // Never hijack Enter away from some other text field (e.g. a
      // settings input, though none currently accept it) or while a
      // modal is on top of gameplay.
      if (isEditingTarget(document.activeElement)) return;

      const settingsMenu = document.getElementById("settings-menu");
      if (settingsMenu && !settingsMenu.hidden) return;

      event.preventDefault();
      this.setVisible(true);
      this.focusInput();
    };

    window.addEventListener("keydown", this.enterKeyHandler);
  }

  setVisible(visible) {
    this.visible = visible;
    this.applyVisibility({ animate: true });
    savePrefs({ visible: this.visible, size: this.size });
  }

  applyVisibility({ animate }) {
    if (this.visible) {
      this.showButton.hidden = true;
      this.panel.hidden = false;

      if (animate) {
        // Force a reflow so the removal of `chat-entering` below is
        // picked up as a fresh transition rather than a no-op.
        this.panel.classList.add("chat-entering");
        // eslint-disable-next-line no-unused-expressions
        this.panel.offsetHeight;
        this.panel.classList.remove("chat-entering");
      }

      this.scrollToBottom();
    } else {
      this.panel.hidden = true;
      this.showButton.hidden = false;
    }
  }

  cycleSize() {
    const next = SIZES[(SIZES.indexOf(this.size) + 1) % SIZES.length];
    this.size = next;
    this.applySize();
    savePrefs({ visible: this.visible, size: this.size });
  }

  applySize() {
    for (const size of SIZES) {
      this.panel.classList.toggle(`chat-size-${size}`, size === this.size);
    }

    this.resizeButton.title =
      `Resize chat (currently ${this.size})`;

    this.scrollToBottom();
  }

  focusInput() {
    this.input.focus();
  }

  trySend() {
    // Guard against double-submission from a fast double click or an
    // Enter-plus-click landing in the same tick.
    if (this.sending) return;

    const text = this.input.value.trim();
    if (!text) return;

    this.sending = true;

    const sent = this.client?.sendChat(text) ?? false;

    if (sent) {
      this.input.value = "";
    }

    this.sending = false;
  }

  appendEntry(node) {
    this.log.append(node);
    this.messageCount++;

    while (this.messageCount > MAX_HISTORY) {
      this.log.firstElementChild?.remove();
      this.messageCount--;
    }

    this.scrollToBottom();
  }

  scrollToBottom() {
    this.log.scrollTop = this.log.scrollHeight;
  }

  addSystemMessage(text) {
    const entry = document.createElement("p");
    entry.className = "chat-entry chat-entry-system";
    // textContent only — never innerHTML with anything derived from the
    // network, even for system-generated text.
    entry.textContent = text;
    this.appendEntry(entry);
  }

  addChatMessage(message, isLocal) {
    const entry = document.createElement("p");
    entry.className = isLocal
      ? "chat-entry chat-entry-local"
      : "chat-entry";

    const name = document.createElement("span");
    name.className = "chat-entry-name";
    name.textContent = `${message.playerName}: `;

    const body = document.createElement("span");
    body.textContent = message.message;

    entry.append(name, body);
    this.appendEntry(entry);
  }

  dispose() {
    window.removeEventListener("keydown", this.enterKeyHandler);
    this.panel.remove();
    this.showButton.remove();
  }
}
