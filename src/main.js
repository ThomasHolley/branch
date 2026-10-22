import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const term = new Terminal({
  cursorBlink: true,
  fontSize: 13,
  fontFamily: "Menlo, Monaco, Consolas, 'Cascadia Mono', 'Courier New', monospace",
  theme: {
    background: "#1e1e1e",
    foreground: "#ddd",
  },
});
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById("terminal"));
fitAddon.fit();

let shellExited = false;

term.onData((data) => {
  if (shellExited) {
    if (data === "\r") restartShell();
    return;
  }
  // bash only reports a command once it is done: Enter is enough to know one is running.
  if (atPrompt && data.includes("\r")) {
    atPrompt = false;
    setTimeout(pollLiveState, 300);
  }
  invoke("write_to_pty", { data });
});

const URL_REGEX = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?[^\s"'\\]*/g;
// CSI sequences (colors, cursor moves) and OSC sequences: Vite, for one, prints the port in bold.
const ANSI_REGEX = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
let lastServerUrl = null;
// Tail of the recent output, so a URL split across two chunks is still found.
let outputTail = "";

listen("pty-data", (event) => {
  term.write(event.payload);
  outputTail = (outputTail + event.payload.replace(ANSI_REGEX, "")).slice(-1000);
  const matches = outputTail.match(URL_REGEX);
  if (matches) {
    lastServerUrl = matches[matches.length - 1];
    updateServerPanel();
  }
});

listen("pty-exit", (event) => {
  shellExited = true;
  atPrompt = false;
  pendingCommand = null;
  term.write(`\r\n\x1b[2m[Processus terminé (code ${event.payload}) — Entrée pour relancer]\x1b[0m\r\n`);
});

async function restartShell() {
  shellExited = false;
  term.reset();
  await invoke("start_shell");
  await syncSize();
}

async function syncSize() {
  fitAddon.fit();
  const { cols, rows } = term;
  try {
    await invoke("resize_pty", { cols, rows });
  } catch {
    // shell not started yet
  }
}

window.addEventListener("resize", () => {
  syncSize();
});

const fileTreeEl = document.getElementById("file-tree");
const currentPathEl = document.getElementById("current-path");
const gitBarEl = document.getElementById("git-bar");
const gitBranchEl = document.getElementById("git-branch");
const gitAheadBehindEl = document.getElementById("git-ahead-behind");
const filterInputEl = document.getElementById("filter-input");
let activeNodeEl = null;
let currentGitEntries = {};
const dirSizeCache = new Map();

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  const units = ["Ko", "Mo", "Go"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function badgeForStatus(code) {
  if (!code) return null;
  if (code === "??") return { label: "U", cls: "badge-untracked" };
  if (code === "UU") return { label: "C", cls: "badge-conflict" };
  if (code.includes("R")) return { label: "R", cls: "badge-added" };
  if (code.includes("M")) return { label: "M", cls: "badge-modified" };
  if (code.includes("A")) return { label: "A", cls: "badge-added" };
  if (code.includes("D")) return { label: "D", cls: "badge-deleted" };
  return { label: "•", cls: "badge-modified" };
}

async function refreshGitBar(path) {
  try {
    const status = await invoke("git_status", { path });
    currentGitEntries = status.entries || {};
    gitBarEl.hidden = false;
    gitBarEl.dataset.hasRepo = "true";
    gitBranchEl.textContent = `⎇ ${status.branch || "(détaché)"}`;
    const parts = [];
    if (status.ahead) parts.push(`↑${status.ahead}`);
    if (status.behind) parts.push(`↓${status.behind}`);
    gitAheadBehindEl.textContent = parts.join(" ");
    applyGitBadges();
  } catch {
    currentGitEntries = {};
    gitBarEl.hidden = true;
    gitBarEl.dataset.hasRepo = "false";
  }
}

function applyGitBadges() {
  fileTreeEl.querySelectorAll(".tree-node").forEach((node) => {
    const path = node.dataset.path;
    const existing = node.querySelector(".badge");
    if (existing) existing.remove();
    const code = currentGitEntries[path];
    const badge = badgeForStatus(code);
    if (badge) {
      const span = document.createElement("span");
      span.className = `badge ${badge.cls}`;
      span.textContent = badge.label;
      node.appendChild(span);
    }
  });
}

function iconFor(entry) {
  return entry.is_dir ? "📁" : "📄";
}

let contextTarget = null;
const contextMenuEl = document.getElementById("context-menu");

function openContextMenu(x, y, entry) {
  contextTarget = entry;
  contextMenuEl.style.left = `${x}px`;
  contextMenuEl.style.top = `${y}px`;
  contextMenuEl.hidden = false;
}

function closeContextMenu() {
  contextMenuEl.hidden = true;
  contextTarget = null;
}

document.addEventListener("click", (event) => {
  if (!contextMenuEl.contains(event.target)) {
    closeContextMenu();
  }
});

contextMenuEl.querySelectorAll(".context-menu-item").forEach((item) => {
  item.addEventListener("click", async () => {
    const action = item.dataset.action;
    const target = contextTarget;
    closeContextMenu();
    if (!target) return;

    if (action === "open-editor") {
      await invoke("open_in_editor", { path: target.path });
    } else if (action === "copy-path") {
      await writeText(target.path);
    } else if (action === "delete") {
      const confirmed = window.confirm(`Supprimer définitivement "${target.name}" ?`);
      if (confirmed) {
        try {
          await invoke("delete_path", { path: target.path });
          const parentPath = await invoke("parent_dir", { path: target.path });
          if (currentPathEl.textContent === parentPath) {
            await renderRoot(parentPath);
          }
        } catch (e) {
          window.alert(`Échec de la suppression : ${e}`);
        }
      }
    }
  });
});

async function buildNode(entry, depth) {
  const node = document.createElement("div");
  node.className = "tree-node";
  node.dataset.path = entry.path;
  node.style.paddingLeft = `${depth * 14}px`;

  const chevron = document.createElement("span");
  chevron.className = "chevron";
  chevron.textContent = entry.is_dir ? "▸" : "";

  const icon = document.createElement("span");
  icon.className = "icon";
  icon.textContent = iconFor(entry);

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = entry.name;

  node.appendChild(chevron);
  node.appendChild(icon);
  node.appendChild(label);

  if (entry.is_dir) {
    node.addEventListener("mouseenter", async () => {
      if (dirSizeCache.has(entry.path)) {
        node.title = dirSizeCache.get(entry.path);
        return;
      }
      try {
        const bytes = await invoke("dir_size", { path: entry.path });
        const formatted = formatBytes(bytes);
        dirSizeCache.set(entry.path, formatted);
        node.title = formatted;
      } catch {
        // ignore
      }
    });
  }

  node.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openContextMenu(event.clientX, event.clientY, entry);
  });

  let childrenEl = null;
  let expanded = false;

  async function setExpanded(next) {
    expanded = next;
    chevron.textContent = expanded ? "▾" : "▸";
    icon.textContent = expanded ? "📂" : "📁";

    if (expanded) {
      if (!childrenEl) {
        childrenEl = await buildChildren(entry.path, depth + 1);
      }
      node.after(childrenEl);
      applyGitBadges();
      applyFilter();
    } else if (childrenEl) {
      childrenEl.remove();
    }
  }

  function setActive() {
    if (activeNodeEl) activeNodeEl.classList.remove("active");
    node.classList.add("active");
    activeNodeEl = node;
  }

  if (entry.is_dir) {
    chevron.addEventListener("click", (event) => {
      event.stopPropagation();
      setExpanded(!expanded);
    });

    node.addEventListener("click", async () => {
      setActive();
      await navigateTo(entry.path);
      if (!expanded) {
        await setExpanded(true);
      }
    });
  } else {
    node.addEventListener("click", setActive);
  }

  return node;
}

async function buildChildren(path, depth) {
  const wrapper = document.createElement("div");
  wrapper.className = "tree-children-wrapper";
  try {
    const entries = await invoke("list_dir", { path });
    for (const entry of entries) {
      const node = await buildNode(entry, depth);
      wrapper.appendChild(node);
    }
  } catch (e) {
    const err = document.createElement("div");
    err.className = "tree-node";
    err.textContent = `(erreur: ${e})`;
    wrapper.appendChild(err);
  }
  return wrapper;
}

async function renderRoot(path) {
  fileTreeEl.innerHTML = "";
  activeNodeEl = null;
  currentPathEl.textContent = path;
  currentPathEl.title = path;
  const children = await buildChildren(path, 0);
  fileTreeEl.appendChild(children);
  applyFilter();
  await refreshGitBar(path);
}

function applyFilter() {
  const query = filterInputEl.value.trim().toLowerCase();
  fileTreeEl.querySelectorAll(".tree-node").forEach((node) => {
    const label = node.querySelector(".label").textContent.toLowerCase();
    node.style.display = !query || label.includes(query) ? "flex" : "none";
  });
}

filterInputEl.addEventListener("input", applyFilter);

async function navigateTo(path) {
  currentPathEl.textContent = path;
  currentPathEl.title = path;
  // Never type a cd into a running command.
  if (integration && !atPrompt) return;
  try {
    await invoke("cd_to", { path });
  } catch {
    // shell not ready yet
  }
}

document.getElementById("go-home").addEventListener("click", async () => {
  const home = await invoke("home_dir");
  await navigateTo(home);
  await renderRoot(home);
});

document.getElementById("go-up").addEventListener("click", async () => {
  const current = currentPathEl.textContent;
  if (!current) return;
  try {
    const parent = await invoke("parent_dir", { path: current });
    await navigateTo(parent);
    await renderRoot(parent);
  } catch {
    // already at root
  }
});

const claudePanelEl = document.getElementById("claude-panel");
const serverPanelEl = document.getElementById("server-panel");
const sshPanelEl = document.getElementById("ssh-panel");
const claudeBranchEl = document.getElementById("claude-branch");
const claudeHistoryEl = document.getElementById("claude-history");
const serverUrlEl = document.getElementById("server-url");
const sshHostEl = document.getElementById("ssh-host");
const sshCwdEl = document.getElementById("ssh-cwd");

const SERVER_PROCESS_NAMES = new Set(["node", "npm", "yarn", "pnpm", "vite", "next-server"]);
let sidebarMode = "shell";

function setSidebarMode(mode) {
  if (mode === sidebarMode) return;
  // A URL printed by a server that has since stopped must not show up for the next one.
  if (sidebarMode === "server") {
    lastServerUrl = null;
    outputTail = "";
  }
  sidebarMode = mode;
  gitBarEl.hidden = mode !== "shell" || gitBarEl.dataset.hasRepo !== "true";
  fileTreeEl.hidden = mode !== "shell";
  document.querySelector(".filter-row").hidden = mode !== "shell";
  commandHistoryEl.hidden = mode !== "shell" || commandHistory.length === 0;
  claudePanelEl.hidden = mode !== "claude";
  serverPanelEl.hidden = mode !== "server";
  sshPanelEl.hidden = mode !== "ssh";
}

function updateServerPanel() {
  serverUrlEl.textContent = lastServerUrl || "URL non détectée";
}

document.getElementById("server-open").addEventListener("click", () => {
  if (lastServerUrl) openUrl(lastServerUrl);
});

document.getElementById("server-stop").addEventListener("click", () => {
  invoke("write_to_pty", { data: String.fromCharCode(3) });
});

document.getElementById("ssh-close").addEventListener("click", () => {
  invoke("write_to_pty", { data: String.fromCharCode(4) });
});

let liveCwd = null;

// Shell integration (see shell_command in lib.rs): once the shell has reported a
// prompt, the prompt itself tells us the cwd and that nothing is running, so the
// ps/lsof polling only runs while a command is in the foreground.
let integration = false;
let atPrompt = false;
let pendingCommand = null;
let remoteCwd = null;
const MAX_HISTORY = 30;
const commandHistory = [];
const commandHistoryEl = document.getElementById("command-history");
const commandHistoryListEl = document.getElementById("command-history-list");

term.parser.registerOscHandler(6973, (data) => {
  const [kind, ...rest] = data.split(";");
  if (kind === "prompt") {
    onPrompt(Number(rest[0]) || 0, rest.slice(1).join(";"));
  } else if (kind === "cmd") {
    onCommandStart(rest.join(";"));
  }
  return true;
});

// Standard OSC 7 (file://host/path), sent by some remote shells: shown in the SSH panel.
term.parser.registerOscHandler(7, (data) => {
  const match = data.match(/^file:\/\/([^/]*)(\/.*)$/);
  if (match) {
    let path = match[2];
    try {
      path = decodeURIComponent(path);
    } catch {
      // keep it encoded
    }
    remoteCwd = `${match[1]}:${path}`;
    if (sidebarMode === "ssh") updateSshPanel();
  }
  return true;
});

function onCommandStart(command) {
  atPrompt = false;
  pendingCommand = command;
  lastServerUrl = null;
  outputTail = "";
  // Pick up claude/ssh/a dev server quickly instead of waiting for the next tick.
  setTimeout(pollLiveState, 300);
}

async function onPrompt(code, cwd) {
  integration = true;
  atPrompt = true;
  remoteCwd = null;
  setSidebarMode("shell");
  const finished = pendingCommand;
  pendingCommand = null;
  if (finished) addToHistory(finished, code);

  if (!cwd) return;
  if (cwd !== liveCwd) {
    liveCwd = cwd;
    if (cwd !== currentPathEl.textContent) {
      await renderRoot(cwd);
      return;
    }
  }
  // The command may have changed files or the branch (git commit, checkout…).
  if (finished) await refreshGitBar(currentPathEl.textContent);
}

function addToHistory(command, code) {
  const text = command.trim();
  if (!text) return;
  commandHistory.unshift({ text, code });
  commandHistory.length = Math.min(commandHistory.length, MAX_HISTORY);
  renderHistory();
}

function renderHistory() {
  commandHistoryEl.hidden = commandHistory.length === 0;
  commandHistoryListEl.innerHTML = "";
  for (const { text, code } of commandHistory) {
    const row = document.createElement("div");
    row.className = "command-history-entry";
    row.title = code === 0 ? "Cliquer pour réinsérer" : `Code de sortie ${code} — cliquer pour réinsérer`;

    const status = document.createElement("span");
    status.className = code === 0 ? "command-ok" : "command-failed";
    status.textContent = code === 0 ? "✓" : `✗ ${code}`;

    const label = document.createElement("span");
    label.className = "command-text";
    label.textContent = text;

    row.append(status, label);
    // Typed at the prompt without Enter, so it can be edited before running.
    row.addEventListener("click", () => {
      if (!atPrompt) return;
      invoke("write_to_pty", { data: text });
      term.focus();
    });
    commandHistoryListEl.appendChild(row);
  }
}

function updateSshPanel(command) {
  if (command !== undefined) {
    const match = command.match(/\S+@\S+/);
    sshHostEl.textContent = match ? match[0] : command;
  }
  sshCwdEl.textContent = remoteCwd || "";
  sshCwdEl.hidden = !remoteCwd;
}

async function pollLiveState() {
  if (integration && atPrompt) return;

  let name = "";
  try {
    name = await invoke("foreground_process");
  } catch {
    return;
  }
  // The prompt may have come back while ps was running.
  if (integration && atPrompt) return;

  if (name === "claude") {
    setSidebarMode("claude");
    try {
      const cwd = integration ? liveCwd : await invoke("shell_cwd");
      const status = await invoke("git_status", { path: cwd });
      claudeBranchEl.textContent = `⎇ ${status.branch || "(détaché)"}`;
    } catch {
      claudeBranchEl.textContent = "";
    }
  } else if (name === "ssh") {
    setSidebarMode("ssh");
    try {
      updateSshPanel(await invoke("foreground_command"));
    } catch {
      updateSshPanel("");
    }
  } else if (SERVER_PROCESS_NAMES.has(name)) {
    setSidebarMode("server");
    updateServerPanel();
  } else {
    setSidebarMode("shell");
    // With integration, the next prompt reports the cwd.
    if (integration) return;
    try {
      const cwd = await invoke("shell_cwd");
      if (cwd && cwd !== liveCwd) {
        liveCwd = cwd;
        if (cwd !== currentPathEl.textContent) {
          await renderRoot(cwd);
        }
      }
    } catch {
      // ignore
    }
  }
}

document.querySelectorAll("#claude-panel [data-slash]").forEach((button) => {
  button.addEventListener("click", () => {
    const slash = button.dataset.slash;
    invoke("write_to_pty", { data: `${slash}\r` });
    const entry = document.createElement("div");
    entry.className = "claude-history-entry";
    entry.textContent = slash;
    claudeHistoryEl.prepend(entry);
  });
});

document.getElementById("claude-escape").addEventListener("click", () => {
  invoke("write_to_pty", { data: String.fromCharCode(27) });
});

async function init() {
  await invoke("start_shell");
  await syncSize();
  const home = await invoke("home_dir");
  liveCwd = home;
  await renderRoot(home);
  term.focus();
  setInterval(pollLiveState, 1000);
}

init();
