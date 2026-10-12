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
  fontFamily: "Menlo, Monaco, 'Courier New', monospace",
  theme: {
    background: "#1e1e1e",
    foreground: "#ddd",
  },
});
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById("terminal"));
fitAddon.fit();

term.onData((data) => {
  invoke("write_to_pty", { data });
});

const URL_REGEX = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?[^\s"'\\]*/;
let lastServerUrl = null;

listen("pty-data", (event) => {
  term.write(event.payload);
  const match = event.payload.match(URL_REGEX);
  if (match) {
    lastServerUrl = match[0];
    updateServerPanel();
  }
});

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

const SERVER_PROCESS_NAMES = new Set(["node", "npm", "yarn", "pnpm", "vite", "next-server"]);
let sidebarMode = "shell";

function setSidebarMode(mode) {
  if (mode === sidebarMode) return;
  sidebarMode = mode;
  gitBarEl.hidden = mode !== "shell" || gitBarEl.dataset.hasRepo !== "true";
  fileTreeEl.hidden = mode !== "shell";
  document.querySelector(".filter-row").hidden = mode !== "shell";
  claudePanelEl.hidden = mode !== "claude";
  serverPanelEl.hidden = mode !== "server";
  sshPanelEl.hidden = mode !== "ssh";
}

function updateServerPanel() {
  if (lastServerUrl) {
    serverUrlEl.textContent = lastServerUrl;
  }
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

async function pollLiveState() {
  let name = "";
  try {
    name = await invoke("foreground_process");
  } catch {
    return;
  }

  if (name === "claude") {
    setSidebarMode("claude");
    try {
      const cwd = await invoke("shell_cwd");
      const status = await invoke("git_status", { path: cwd });
      claudeBranchEl.textContent = `⎇ ${status.branch || "(détaché)"}`;
    } catch {
      claudeBranchEl.textContent = "";
    }
  } else if (name === "ssh") {
    setSidebarMode("ssh");
    try {
      const cmd = await invoke("foreground_command");
      const match = cmd.match(/\S+@\S+/);
      sshHostEl.textContent = match ? match[0] : cmd;
    } catch {
      sshHostEl.textContent = "";
    }
  } else if (SERVER_PROCESS_NAMES.has(name)) {
    setSidebarMode("server");
    updateServerPanel();
  } else {
    setSidebarMode("shell");
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
    invoke("write_to_pty", { data: `${slash}\n` });
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
