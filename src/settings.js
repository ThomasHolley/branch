// User preferences, kept in the webview's localStorage (per user, per machine).
// Reading and writing are wrapped: storage may be unavailable, the defaults then apply.

const STORAGE_KEY = "branch.settings";

export const DEFAULT_SETTINGS = {
  fontSize: 13,
  // "dark", "light" or "system"
  theme: "dark",
  // id from list_editors (lib.rs), "system" for the default application
  editor: "vscode",
  // shell for new tabs; empty means the user's default shell
  shell: "",
};

export const FONT_SIZE_MIN = 9;
export const FONT_SIZE_MAX = 28;

export function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // not persisted: still applied for this session
  }
}

export function clampFontSize(size) {
  const value = Math.round(Number(size));
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS.fontSize;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, value));
}

export function resolveTheme(theme, systemPrefersDark) {
  if (theme === "system") return systemPrefersDark ? "dark" : "light";
  return theme === "light" ? "light" : "dark";
}

// xterm.js palettes. The light one is VS Code's: xterm's default ANSI colors (pale
// yellow, white) are unreadable on a white background.
export const TERMINAL_THEMES = {
  dark: {
    background: "#1e1e1e",
    foreground: "#dddddd",
    cursor: "#dddddd",
    selectionBackground: "#264f78",
  },
  light: {
    background: "#ffffff",
    foreground: "#1f1f1f",
    cursor: "#1f1f1f",
    selectionBackground: "#add6ff",
    black: "#000000",
    red: "#cd3131",
    green: "#00bc00",
    yellow: "#949800",
    blue: "#0451a5",
    magenta: "#bc05bc",
    cyan: "#0598bc",
    white: "#555555",
    brightBlack: "#666666",
    brightRed: "#cd3131",
    brightGreen: "#14ce14",
    brightYellow: "#b5ba00",
    brightBlue: "#0451a5",
    brightMagenta: "#bc05bc",
    brightCyan: "#0598bc",
    brightWhite: "#a5a5a5",
  },
};
