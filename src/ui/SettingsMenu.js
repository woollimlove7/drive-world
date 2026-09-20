export class SettingsMenu {
  constructor() {
    this.isOpen = false;

    this.element = document.querySelector("#settings-menu");
    this.openButton = document.querySelector("#open-menu");
    this.closeButton = document.querySelector("#close-menu");
    this.previousFocus = null;

    // Move existing DOM nodes. Their registered listeners are preserved.
    this.moveButtonGroup("menu-controls", [
      "enable-v99",
      "use-keyboard",
      "use-mobile",
      "use-controller"
    ]);

    this.moveElement("control-status", "menu-controls");

    this.moveButtonGroup("menu-driving", [
  "select-arcade",
  "select-manual"
]);

    this.moveElement("driving-status", "menu-driving");

    // Display tab: camera controls + HUD. Audio tab: volume controls.
    // Previously these all lived in one "Camera & Audio" page; split so
    // each tab only has settings a player would actually look for there.
    this.moveButtonGroup("menu-display", ["camera-toggle", "fullscreen-toggle"]);
    this.moveButtonGroup("menu-audio", ["enable-audio"]);

    for (const [id, destinationId] of [
      ["camera-vibration", "menu-display"],
      ["master-volume", "menu-audio"]
    ]) {
      const input = document.getElementById(id);
      const label = input?.closest("label");

      if (label) {
        document.getElementById(destinationId).append(label);
      }
    }

    this.moveElement("presentation-status", "menu-display");

    for (const [selector, destinationId] of [
      [".camera-options", "menu-display-advanced"],
      [".audio-options", "menu-audio-advanced"]
    ]) {
      const options = document.querySelector(selector);
      if (options) {
        options.open = true;
        document.getElementById(destinationId).append(options);
      }
    }

    // Remove groups left empty by moving their buttons.
    document.querySelectorAll("#debug .debug-actions").forEach(group => {
      if (!group.children.length) group.remove();
    });

    document.querySelector("#debug").open = false;

    this.openButton.hidden = false;
    this.openButton.addEventListener("click", () => this.open());
    this.closeButton.addEventListener("click", () => this.close());

    this.tabs = Array.from(document.querySelectorAll("[data-settings-tab]"));

    this.tabs.forEach(button => {
      button.addEventListener("click", () => {
        this.selectPage(button.dataset.settingsTab);
        button.focus();
      });

      // Standard ARIA tabs keyboard pattern: arrow keys move focus AND
      // activate (no separate "select" step), Home/End jump to the ends.
      button.addEventListener("keydown", event => {
        const index = this.tabs.indexOf(button);
        let target = null;

        if (event.key === "ArrowRight") {
          target = this.tabs[(index + 1) % this.tabs.length];
        } else if (event.key === "ArrowLeft") {
          target = this.tabs[(index - 1 + this.tabs.length) % this.tabs.length];
        } else if (event.key === "Home") {
          target = this.tabs[0];
        } else if (event.key === "End") {
          target = this.tabs[this.tabs.length - 1];
        } else {
          return;
        }

        event.preventDefault();
        this.selectPage(target.dataset.settingsTab);
        target.focus();
      });
    });

    this.selectPage("controls");

    // Capture prevents camera shortcuts or driving keys from reaching
    // gameplay while the modal menu is open.
    window.addEventListener("keydown", event => {
      if (event.code === "Escape" && !event.repeat) {
        // The chat input handles its own Escape (unfocus/close chat)
        // instead of this toggling the settings menu underneath it.
        if (document.activeElement?.dataset?.chatInput !== undefined) {
          return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();

        if (this.isOpen) this.close();
        else this.open();

        return;
      }

      if (!this.isOpen) return;

      if (event.code === "Tab") {
        this.trapFocus(event);
      }

      // Do not prevent default: sliders, buttons and Tab still work.
      event.stopImmediatePropagation();
    }, true);
  }

  moveElement(id, destinationId) {
    const element = document.getElementById(id);
    const destination = document.getElementById(destinationId);

    if (element && destination) destination.append(element);
  }

  moveButtonGroup(destinationId, ids) {
    const group = document.createElement("div");
    group.className = "debug-actions";

    for (const id of ids) {
      const button = document.getElementById(id);
      if (button) group.append(button);
    }

    document.getElementById(destinationId).append(group);
  }

  selectPage(name) {
    document.querySelectorAll("[data-settings-page]").forEach(page => {
      page.hidden = page.dataset.settingsPage !== name;
    });

    this.tabs.forEach(button => {
      const selected = button.dataset.settingsTab === name;
      button.setAttribute("aria-selected", String(selected));
      // Roving tabindex: only the active tab sits in the Tab order, so
      // Tab moves straight from the tab strip into the visible panel
      // instead of stopping on hidden tabs.
      button.tabIndex = selected ? 0 : -1;
    });
  }

  open() {
    this.previousFocus = document.activeElement;
    this.isOpen = true;
    this.element.hidden = false;
    this.closeButton.focus();
  }

  close() {
    this.isOpen = false;
    this.element.hidden = true;
    this.previousFocus?.focus();
  }

  trapFocus(event) {
    const focusable = Array.from(this.element.querySelectorAll(
      "button:not(:disabled), input:not(:disabled), summary, [tabindex='0']"
    )).filter(element => element.getClientRects().length > 0);

    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}