const STORAGE_KEY = "driveworld.playerName.v1";
const MAX_NAME_LENGTH = 16;

// Strip control characters, bidi/zero-width tricks, and angle brackets so a
// name can never carry markup or invisible manipulation — mirrors the
// server's own sanitizeName(), which is the actual trust boundary.
export function sanitizePlayerName(raw) {
  if (typeof raw !== "string") return "";

  return raw
    .replace(/[<>]/g, "")
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E]/g, "")
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

export function loadSavedPlayerName() {
  try {
    return sanitizePlayerName(localStorage.getItem(STORAGE_KEY) || "");
  } catch {
    return "";
  }
}

export function savePlayerName(name) {
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    // Storage unavailable (e.g. private browsing). The chosen name still
    // works for this session; it just will not be remembered next time.
  }
}
