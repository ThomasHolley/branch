import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { classifyForeground, formatElapsed, gitOperationLabel } from "./context.js";

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
    commandStartedAt = Date.now();
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
const gitOperationEl = document.getElementById("git-operation");
const gitOperationLabelEl = document.getElementById("git-operation-label");
let gitOperation = null;
// Folder the tree shows; currentPathEl may point below it after a click on a folder.
let treeRoot = "";
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
    gitOperation = status.operation || null;
    if (gitOperation) {
      const conflicts = Object.values(currentGitEntries).filter((code) => code === "UU").length;
      gitOperationLabelEl.textContent = gitOperationLabel(gitOperation, conflicts);
    }
    gitOperationEl.hidden = !gitOperation;
    applyGitBadges();
  } catch {
    currentGitEntries = {};
    gitOperation = null;
    gitBarEl.hidden = true;
    gitBarEl.dataset.hasRepo = "false";
    gitOperationEl.hidden = true;
  }
}

// Typed at the prompt for the user, like the folder navigation.
async function runAtPrompt(line) {
  if (integration && !atPrompt) return;
  await invoke("run_at_prompt", { line });
  term.focus();
}

document.getElementById("git-continue").addEventListener("click", () => {
  if (gitOperation) runAtPrompt(`git ${gitOperation} --continue`);
});

document.getElementById("git-abort").addEventListener("click", () => {
  if (!gitOperation) return;
  if (window.confirm(`Annuler le ${gitOperation} en cours ? Les modifications de l'opération seront perdues.`)) {
    runAtPrompt(`git ${gitOperation} --abort`);
  }
});

// Windows paths use backslashes, everything else forward slashes.
function separatorOf(path) {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

function parentOf(path) {
  const index = path.lastIndexOf(separatorOf(path));
  return index > 0 ? path.slice(0, index) : null;
}

// Folders of the tree that contain a change somewhere below them.
function changedFolders() {
  const folders = new Set();
  for (const path of Object.keys(currentGitEntries)) {
    let parent = parentOf(path);
    while (parent && parent.length > treeRoot.length && !folders.has(parent)) {
      folders.add(parent);
      parent = parentOf(parent);
    }
  }
  return folders;
}

function applyGitBadges() {
  const folders = changedFolders();
  fileTreeEl.querySelectorAll(".tree-node").forEach((node) => {
    const path = node.dataset.path;
    const existing = node.querySelector(".badge");
    if (existing) existing.remove();
    const code = currentGitEntries[path];
    const badge = badgeForStatus(code) || (folders.has(path) ? { label: "•", cls: "badge-dir" } : null);
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
  contextMenuEl.querySelector('[data-action="mention-claude"]').hidden = sidebarMode !== "claude";
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

    if (action === "mention-claude") {
      mentionInClaude(target.path);
    } else if (action === "open-editor") {
      await invoke("open_in_editor", { path: target.path });
    } else if (action === "copy-path") {
      await writeText(target.path);
    } else if (action === "delete") {
      const confirmed = window.confirm(`Mettre "${target.name}" à la corbeille ?`);
      if (confirmed) {
        try {
          await invoke("delete_path", { path: target.path });
          const parentPath = await invoke("parent_dir", { path: target.path });
          if (treeRoot === parentPath) {
            await renderRoot(parentPath);
          } else {
            document.querySelector(`.tree-node[data-path="${CSS.escape(target.path)}"]`)?.remove();
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
      // Browsing while a program runs: only unfold, the terminal is left alone.
      if (!canDriveShell()) {
        await setExpanded(!expanded);
        return;
      }
      await navigateTo(entry.path);
      if (!expanded) {
        await setExpanded(true);
      }
    });
  } else {
    addFileHandlers(node, entry, setActive);
  }

  return node;
}

function addFileHandlers(node, entry, setActive) {
  node.addEventListener("click", () => {
    setActive();
    if (sidebarMode === "claude") mentionInClaude(entry.path);
  });
  node.addEventListener("dblclick", () => {
    invoke("open_in_editor", { path: entry.path });
  });
}

// Types "@path " in Claude Code's prompt, relative to the folder it runs in.
function mentionInClaude(path) {
  const base = liveCwd ? liveCwd + separatorOf(liveCwd) : null;
  const relative = base && path.startsWith(base) ? path.slice(base.length) : path;
  invoke("write_to_pty", { data: `@${relative} ` });
  term.focus();
}

// The tree may type into the terminal (cd) only when the shell waits at its prompt.
function canDriveShell() {
  return sidebarMode === "shell" && (!integration || atPrompt);
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
  activeNodeEl = null;
  treeRoot = path;
  currentPathEl.textContent = path;
  currentPathEl.title = path;
  const children = await buildChildren(path, 0);
  fileTreeEl.innerHTML = "";
  treeContentEl = children;
  fileTreeEl.appendChild(children);
  searchResultsEl = null;
  if (filterInputEl.value.trim()) runSearch();
  await refreshGitBar(path);
}

// The filter searches every subfolder of the tree root (find_files) and shows a flat
// list in place of the tree; clearing it brings the tree back as it was.
let treeContentEl = null;
let searchResultsEl = null;
let searchTimer = null;
let searchSeq = 0;

filterInputEl.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 150);
});

filterInputEl.addEventListener("keydown", (event) => {
  if (event.key === "Escape") clearSearch();
});

function clearSearch() {
  filterInputEl.value = "";
  runSearch();
}

async function runSearch() {
  const query = filterInputEl.value.trim();
  const seq = ++searchSeq;
  if (!query) {
    searchResultsEl?.remove();
    searchResultsEl = null;
    if (treeContentEl) treeContentEl.hidden = false;
    return;
  }

  let results = [];
  try {
    results = await invoke("find_files", { root: treeRoot, query });
  } catch {
    // unreadable root: show no results
  }
  if (seq !== searchSeq) return;

  const container = document.createElement("div");
  if (results.length === 0) {
    const empty = document.createElement("div");
    empty.className = "search-empty";
    empty.textContent = "Aucun résultat";
    container.appendChild(empty);
  }
  for (const entry of results) container.appendChild(buildSearchResult(entry));

  searchResultsEl?.remove();
  searchResultsEl = container;
  if (treeContentEl) treeContentEl.hidden = true;
  fileTreeEl.appendChild(container);
  applyGitBadges();
}

function buildSearchResult(entry) {
  const node = document.createElement("div");
  node.className = "tree-node";
  node.dataset.path = entry.path;

  const icon = document.createElement("span");
  icon.className = "icon";
  icon.textContent = iconFor(entry);

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = entry.name;

  // Where it is, relative to the tree root.
  const folder = document.createElement("span");
  folder.className = "search-dir";
  const parent = parentOf(entry.path) || "";
  folder.textContent = parent.length > treeRoot.length ? parent.slice(treeRoot.length + 1) : "";

  node.append(icon, label, folder);

  const setActive = () => {
    if (activeNodeEl) activeNodeEl.classList.remove("active");
    node.classList.add("active");
    activeNodeEl = node;
  };

  if (entry.is_dir) {
    node.addEventListener("click", async () => {
      filterInputEl.value = "";
      await navigateTo(entry.path);
      await renderRoot(entry.path);
    });
  } else {
    addFileHandlers(node, entry, setActive);
  }

  node.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openContextMenu(event.clientX, event.clientY, entry);
  });
  return node;
}

async function navigateTo(path) {
  currentPathEl.textContent = path;
  currentPathEl.title = path;
  // Never type a cd into a running command.
  if (!canDriveShell()) return;
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
const serverUrlsEl = document.getElementById("server-urls");
const sshHostEl = document.getElementById("ssh-host");
const sshCwdEl = document.getElementById("ssh-cwd");

const contextPanelEl = document.getElementById("context-panel");
const contextTitleEl = document.getElementById("context-title");
const contextDetailEl = document.getElementById("context-detail");
const contextElapsedEl = document.getElementById("context-elapsed");
const contextActionsEl = document.getElementById("context-actions");
const sidebarEl = document.querySelector(".sidebar");
const browseHintEl = document.getElementById("browse-hint");
let sidebarMode = "shell";
let contextKey = null;
let serverUrlsKey = null;
let commandStartedAt = null;

function setSidebarMode(mode) {
  if (mode === sidebarMode) return;
  // A URL printed by a server that has since stopped must not show up for the next one.
  if (sidebarMode === "server") {
    lastServerUrl = null;
    outputTail = "";
  }
  sidebarMode = mode;
  contextKey = mode === "context" ? contextKey : null;
  gitOperationEl.hidden = mode !== "shell" || !gitOperation;
  commandHistoryEl.hidden = mode !== "shell" || commandHistory.length === 0;
  // The tree stays usable whatever runs in the terminal, but no longer drives it.
  sidebarEl.classList.toggle("browsing", mode !== "shell");
  browseHintEl.hidden = mode === "shell";
  browseHintEl.textContent =
    mode === "claude"
      ? "Navigation libre · clic sur un fichier : le mentionner dans Claude"
      : "Navigation libre · le terminal n'est pas modifié";
  claudePanelEl.hidden = mode !== "claude";
  serverPanelEl.hidden = mode !== "server";
  sshPanelEl.hidden = mode !== "ssh";
  contextPanelEl.hidden = mode !== "context";
}

function updateServerPanel(urls) {
  // Rebuilt only when the list changes, so a click isn't lost to a re-render.
  const key = urls.join(" ");
  if (key === serverUrlsKey) return;
  serverUrlsKey = key;
  serverUrlsEl.innerHTML = "";
  if (urls.length === 0) {
    const empty = document.createElement("span");
    empty.className = "server-url";
    empty.textContent = "URL non détectée";
    serverUrlsEl.appendChild(empty);
    return;
  }
  urls.forEach((url, index) => {
    const row = document.createElement("div");
    row.className = index === 0 ? "server-url-row" : "server-url-row secondary";
    const label = document.createElement("span");
    label.className = "server-url";
    label.textContent = url;
    label.title = url;
    const open = document.createElement("button");
    open.textContent = "Ouvrir";
    open.addEventListener("click", () => openUrl(url));
    row.append(label, open);
    serverUrlsEl.appendChild(row);
  });
}

// Editor, pager, REPL or any other running command: one panel built from the
// description classifyForeground returns.
function showContextPanel(context) {
  setSidebarMode("context");
  if (context.key !== contextKey) {
    contextKey = context.key;
    contextTitleEl.textContent = context.title;
    contextDetailEl.textContent = context.detail;
    contextDetailEl.title = context.detailTitle;
    contextDetailEl.hidden = !context.detail;
    contextActionsEl.innerHTML = "";
    for (const action of context.actions) {
      const button = document.createElement("button");
      button.textContent = action.label;
      button.addEventListener("click", () => {
        invoke("write_to_pty", { data: action.keys });
        term.focus();
      });
      contextActionsEl.appendChild(button);
    }
  }
  contextElapsedEl.hidden = !context.elapsed;
  if (context.elapsed) {
    if (!commandStartedAt) commandStartedAt = Date.now();
    contextElapsedEl.textContent = `Depuis ${formatElapsed(Date.now() - commandStartedAt)}`;
  }
}

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
  commandStartedAt = Date.now();
  lastServerUrl = null;
  outputTail = "";
  // Pick up claude/ssh/a dev server quickly instead of waiting for the next tick.
  setTimeout(pollLiveState, 300);
}

async function onPrompt(code, cwd) {
  integration = true;
  atPrompt = true;
  remoteCwd = null;
  commandStartedAt = null;
  setSidebarMode("shell");
  const finished = pendingCommand;
  pendingCommand = null;
  if (finished) addToHistory(finished, code);

  if (!cwd) return;
  liveCwd = cwd;
  // Also brings the tree back to the terminal's folder after browsing elsewhere.
  if (cwd !== currentPathEl.textContent) {
    await renderRoot(cwd);
    return;
  }
  // The command may have changed files or the branch (git commit, checkout…).
  if (finished) await refreshGitBar(treeRoot);
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

  let foreground;
  try {
    foreground = await invoke("foreground_state");
  } catch {
    return;
  }
  // The prompt may have come back while ps was running.
  if (integration && atPrompt) return;

  const context = classifyForeground(foreground, { lastServerUrl, pendingCommand });
  if (context.mode !== "context" && context.mode !== "shell") commandStartedAt = null;

  if (context.mode === "claude") {
    setSidebarMode("claude");
    try {
      const cwd = integration ? liveCwd : await invoke("shell_cwd");
      const status = await invoke("git_status", { path: cwd });
      claudeBranchEl.textContent = `⎇ ${status.branch || "(détaché)"}`;
      // Files Claude edits show up in the tree as it works.
      if (cwd === treeRoot) {
        currentGitEntries = status.entries || {};
        applyGitBadges();
      }
    } catch {
      claudeBranchEl.textContent = "";
    }
  } else if (context.mode === "ssh") {
    setSidebarMode("ssh");
    updateSshPanel(context.command);
  } else if (context.mode === "server") {
    setSidebarMode("server");
    updateServerPanel(context.urls);
  } else if (context.mode === "context") {
    showContextPanel(context);
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
