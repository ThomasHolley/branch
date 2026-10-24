import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import "@xterm/xterm/css/xterm.css";
import { Session } from "./session.js";
import { classifyForeground, formatElapsed, gitOperationLabel, tabTitle } from "./context.js";
import {
  DEFAULT_SETTINGS,
  TERMINAL_THEMES,
  clampFontSize,
  loadSettings,
  resolveTheme,
  saveSettings,
} from "./settings.js";

const terminalsEl = document.getElementById("terminals");
const tabListEl = document.getElementById("tab-list");
const fileTreeEl = document.getElementById("file-tree");
const currentPathEl = document.getElementById("current-path");
const gitBarEl = document.getElementById("git-bar");
const gitBranchEl = document.getElementById("git-branch");
const gitAheadBehindEl = document.getElementById("git-ahead-behind");
const filterInputEl = document.getElementById("filter-input");
const gitOperationEl = document.getElementById("git-operation");
const gitOperationLabelEl = document.getElementById("git-operation-label");
const sidebarEl = document.querySelector(".sidebar");
const browseHintEl = document.getElementById("browse-hint");
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
const commandHistoryEl = document.getElementById("command-history");
const commandHistoryListEl = document.getElementById("command-history-list");

let homeDir = null;

// ---------------------------------------------------------------------------
// Settings: font size, theme, editor, shell of new tabs.

let settings = loadSettings();
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

function appearance() {
  return {
    fontSize: settings.fontSize,
    theme: TERMINAL_THEMES[resolveTheme(settings.theme, systemDark.matches)],
  };
}

function applyAppearance() {
  document.documentElement.dataset.theme = resolveTheme(settings.theme, systemDark.matches);
  const look = appearance();
  for (const session of sessions) session.setAppearance(look);
}

systemDark.addEventListener("change", () => {
  if (settings.theme === "system") applyAppearance();
});

function updateSettings(changes) {
  settings = { ...settings, ...changes };
  settings.fontSize = clampFontSize(settings.fontSize);
  saveSettings(settings);
  applyAppearance();
  renderSettings();
}

const settingsEl = document.getElementById("settings");
const fontSizeEl = document.getElementById("setting-font-size");
const themeEl = document.getElementById("setting-theme");
const editorEl = document.getElementById("setting-editor");
const shellEl = document.getElementById("setting-shell");

function renderSettings() {
  fontSizeEl.textContent = `${settings.fontSize} px`;
  themeEl.value = settings.theme;
  if ([...editorEl.options].some((o) => o.value === settings.editor)) editorEl.value = settings.editor;
  if ([...shellEl.options].some((o) => o.value === settings.shell)) shellEl.value = settings.shell;
}

// Editors and shells depend on the machine: asked to the backend once.
async function loadSettingsChoices() {
  const editors = await invoke("list_editors");
  editorEl.innerHTML = "";
  for (const { id, label } of editors) editorEl.add(new Option(label, id));
  // The saved editor may have been uninstalled: the backend then uses the default app.
  if (!editors.some((e) => e.id === settings.editor)) editorEl.value = "system";

  const shells = await invoke("shell_choices");
  shellEl.innerHTML = "";
  shellEl.add(new Option(`Par défaut (${shells.default.split(/[\\/]/).pop()})`, ""));
  for (const shell of shells.available) shellEl.add(new Option(shell, shell));
  renderSettings();
}

function openSettings() {
  renderSettings();
  settingsEl.hidden = false;
}

function closeSettings() {
  settingsEl.hidden = true;
  active?.term.focus();
}

document.getElementById("open-settings").addEventListener("click", openSettings);
document.getElementById("close-settings").addEventListener("click", closeSettings);
settingsEl.addEventListener("click", (event) => {
  if (event.target === settingsEl) closeSettings();
});
settingsEl.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeSettings();
});
document.getElementById("font-smaller").addEventListener("click", () => updateSettings({ fontSize: settings.fontSize - 1 }));
document.getElementById("font-larger").addEventListener("click", () => updateSettings({ fontSize: settings.fontSize + 1 }));
themeEl.addEventListener("change", () => updateSettings({ theme: themeEl.value }));
editorEl.addEventListener("change", () => updateSettings({ editor: editorEl.value }));
shellEl.addEventListener("change", () => updateSettings({ shell: shellEl.value }));

function openInEditor(path) {
  return invoke("open_in_editor", { path, editor: settings.editor });
}

// ---------------------------------------------------------------------------
// Tabs: one Session per tab, the sidebar always shows the active one.

const sessions = [];
let active = null;
let tabsKey = null;

const sessionHooks = {
  onPrompt: (session, finished) => onPrompt(session, finished),
  // Pick up claude/ssh/a dev server quickly instead of waiting for the next tick.
  onEnter: (session) => setTimeout(() => pollSession(session), 300),
  onRemoteCwd: (session) => {
    if (session === active && sidebarMode === "ssh") updateSshPanel(session);
  },
  onExit: (session) => {
    renderTabs();
    if (session === active) showSession(session);
  },
};

listen("pty-data", (event) => {
  sessionById(event.payload.id)?.receive(event.payload.data);
});

listen("pty-exit", (event) => {
  sessionById(event.payload.id)?.handleExit(event.payload.code);
});

function sessionById(id) {
  return sessions.find((session) => session.id === id);
}

// New tabs open in the active tab's folder, like most terminals.
async function newTab(cwd = active?.cwd || homeDir) {
  const session = new Session(terminalsEl, sessionHooks, appearance(), settings.shell);
  session.cwd = cwd;
  sessions.push(session);
  activate(session);
  await session.start(cwd);
}

function closeTab(session) {
  const index = sessions.indexOf(session);
  if (index === -1) return;
  sessions.splice(index, 1);
  session.dispose();
  if (sessions.length === 0) {
    active = null;
    newTab(homeDir);
    return;
  }
  if (session === active) {
    active = null;
    activate(sessions[Math.min(index, sessions.length - 1)]);
  } else {
    renderTabs();
  }
}

function activate(session) {
  if (active && active !== session) active.hide();
  active = session;
  session.show();
  renderTabs();
  showSession(session);
}

function cycleTab(step) {
  if (sessions.length < 2) return;
  const index = sessions.indexOf(active);
  activate(sessions[(index + step + sessions.length) % sessions.length]);
}

function renderTabs() {
  const titles = sessions.map((s) => tabTitle(s.context, s.cwd, s.exited));
  // Rebuilt only when something changed, so a click isn't lost to a re-render.
  const key = titles.join("\0") + "\0" + sessions.indexOf(active);
  if (key === tabsKey) return;
  tabsKey = key;
  tabListEl.innerHTML = "";
  sessions.forEach((session, index) => {
    const tab = document.createElement("div");
    tab.className = session === active ? "tab active" : "tab";
    tab.title = session.cwd || "";

    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = titles[index];

    const close = document.createElement("button");
    close.className = "tab-close";
    close.textContent = "×";
    close.title = "Fermer l'onglet (Ctrl+Maj+W)";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      closeTab(session);
    });

    tab.append(label, close);
    tab.addEventListener("click", () => activate(session));
    // Middle click closes, as in browsers.
    tab.addEventListener("auxclick", (event) => {
      if (event.button === 1) closeTab(session);
    });
    tabListEl.appendChild(tab);
  });
}

document.getElementById("new-tab").addEventListener("click", () => newTab());

// Ctrl+Shift+T / Ctrl+Shift+W everywhere (Ctrl+T/W belong to the shell), Cmd+T on macOS,
// Ctrl+Tab to cycle. Caught before xterm sees them.
const isMac = navigator.userAgent.includes("Mac");
window.addEventListener(
  "keydown",
  (event) => {
    const key = event.key.toLowerCase();
    let action = null;
    if (event.ctrlKey && event.shiftKey && key === "t") action = () => newTab();
    else if (isMac && event.metaKey && !event.shiftKey && key === "t") action = () => newTab();
    else if (event.ctrlKey && event.shiftKey && key === "w") action = () => closeTab(active);
    else if (event.ctrlKey && key === "tab") action = () => cycleTab(event.shiftKey ? -1 : 1);
    // Cmd (macOS) or Ctrl with + / - / 0: text size, as in browsers.
    else if ((isMac ? event.metaKey : event.ctrlKey) && !event.altKey) {
      if (key === "=" || key === "+") action = () => updateSettings({ fontSize: settings.fontSize + 1 });
      else if (key === "-") action = () => updateSettings({ fontSize: settings.fontSize - 1 });
      else if (key === "0") action = () => updateSettings({ fontSize: DEFAULT_SETTINGS.fontSize });
      else if (key === "," && isMac) action = openSettings;
    }
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    action();
  },
  true,
);

window.addEventListener("resize", () => {
  active?.syncSize();
});

// Everything in the sidebar that depends on the tab: called when switching tabs.
function showSession(session) {
  contextKey = null;
  serverUrlsKey = null;
  applyContext(session);
  renderHistory();
  renderClaudeHistory();
  const folder = session.cwd || homeDir;
  if (folder && folder !== currentPathEl.textContent) renderRoot(folder);
}

// ---------------------------------------------------------------------------
// File tree

let currentGitEntries = {};
let gitOperation = null;
// Folder the tree shows; currentPathEl may point below it after a click on a folder.
let treeRoot = "";
let activeNodeEl = null;
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
    if ((status.git_dir || null) !== gitDir) {
      gitDir = status.git_dir || null;
      scheduleWatchUpdate();
    }
    if (gitOperation) {
      const conflicts = Object.values(currentGitEntries).filter((code) => code === "UU").length;
      gitOperationLabelEl.textContent = gitOperationLabel(gitOperation, conflicts);
    }
    gitOperationEl.hidden = !gitOperation || sidebarMode !== "shell";
    applyGitBadges();
  } catch {
    currentGitEntries = {};
    gitOperation = null;
    gitBarEl.hidden = true;
    gitBarEl.dataset.hasRepo = "false";
    gitOperationEl.hidden = true;
  }
}

// The tree may type into the terminal (cd, git…) only when the shell waits at its prompt.
function canDriveShell() {
  return Boolean(active?.idle);
}

// Typed at the prompt for the user, like the folder navigation.
async function runAtPrompt(line) {
  if (!canDriveShell()) return;
  await invoke("run_at_prompt", { id: active.id, line });
  active.term.focus();
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

let contextTarget = null;
const contextMenuEl = document.getElementById("context-menu");

function openContextMenu(x, y, entry) {
  contextTarget = entry;
  contextMenuEl.querySelector('[data-action="mention-claude"]').hidden = sidebarMode !== "claude";
  contextMenuEl.querySelector('[data-action="new-tab"]').hidden = !entry.is_dir;
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
    } else if (action === "new-tab") {
      await newTab(target.path);
    } else if (action === "open-editor") {
      await openInEditor(target.path);
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
  node.className = entry.is_dir ? "tree-node is-dir" : "tree-node is-file";
  node.dataset.path = entry.path;
  node.style.paddingLeft = `${depth * 14}px`;

  const chevron = document.createElement("span");
  chevron.className = "chevron";
  chevron.textContent = entry.is_dir ? "▸" : "";

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = entry.name;

  node.appendChild(chevron);
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

    if (expanded) {
      const cached = Boolean(childrenEl);
      if (!childrenEl) {
        childrenEl = await buildChildren(entry.path, depth + 1);
      }
      node.after(childrenEl);
      // Kept from a previous unfold: files may have changed while it was folded.
      if (cached) await refreshDir(entry.path);
      applyGitBadges();
    } else if (childrenEl) {
      childrenEl.remove();
    }
    scheduleWatchUpdate();
  }

  // For refreshDir: the unfolded children that follow this node in its wrapper.
  node.unfoldedChildren = () => (expanded ? childrenEl : null);

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
    openInEditor(entry.path);
  });
}

// Types "@path " in Claude Code's prompt, relative to the folder it runs in.
function mentionInClaude(path) {
  if (!active) return;
  const base = active.cwd ? active.cwd + separatorOf(active.cwd) : null;
  const relative = base && path.startsWith(base) ? path.slice(base.length) : path;
  active.write(`@${relative} `);
  active.term.focus();
}

async function buildChildren(path, depth) {
  const wrapper = document.createElement("div");
  wrapper.className = "tree-children-wrapper";
  wrapper.dataset.dir = path;
  wrapper.dataset.depth = depth;
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
  // Another renderRoot started meanwhile (tab switch, prompt): it wins.
  if (treeRoot !== path) return;
  fileTreeEl.innerHTML = "";
  treeContentEl = children;
  fileTreeEl.appendChild(children);
  searchResultsEl = null;
  if (filterInputEl.value.trim()) runSearch();
  await refreshGitBar(path);
  scheduleWatchUpdate();
}

// ---------------------------------------------------------------------------
// Live tree: the backend watches the folders shown (root and unfolded ones) plus
// the git dir, and reports the ones whose content changed.

let gitDir = null;
let watchTimer = null;
let gitRefreshTimer = null;

function shownFolders() {
  return [...fileTreeEl.querySelectorAll(".tree-children-wrapper[data-dir]")]
    .filter((wrapper) => wrapper.isConnected)
    .map((wrapper) => wrapper.dataset.dir);
}

function scheduleWatchUpdate() {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => {
    const dirs = shownFolders();
    if (gitDir) dirs.push(gitDir);
    invoke("watch_dirs", { dirs }).catch(() => {});
  }, 100);
}

function scheduleGitRefresh() {
  clearTimeout(gitRefreshTimer);
  gitRefreshTimer = setTimeout(() => refreshGitBar(treeRoot), 300);
}

listen("fs-changed", async (event) => {
  dirSizeCache.clear();
  for (const dir of event.payload) {
    if (dir !== gitDir) await refreshDir(dir);
  }
  scheduleGitRefresh();
  if (filterInputEl.value.trim()) runSearch();
});

// Brings one shown folder up to date, keeping the nodes still there (and what is
// unfolded below them) as they are.
async function refreshDir(path) {
  const wrapper = [...fileTreeEl.querySelectorAll(".tree-children-wrapper[data-dir]")].find(
    (w) => w.dataset.dir === path,
  );
  if (!wrapper) return;
  let entries;
  try {
    entries = await invoke("list_dir", { path });
  } catch {
    return;
  }
  const depth = Number(wrapper.dataset.depth);
  const existing = new Map();
  for (const child of wrapper.children) {
    if (child.classList.contains("tree-node") && child.dataset.path) existing.set(child.dataset.path, child);
  }

  const wanted = new Set(entries.map((entry) => entry.path));
  for (const [nodePath, node] of existing) {
    if (wanted.has(nodePath)) continue;
    node.unfoldedChildren?.()?.remove();
    if (node === activeNodeEl) activeNodeEl = null;
    node.remove();
    existing.delete(nodePath);
  }

  // Entries come sorted: walk them, inserting the new ones after the previous node
  // (after what is unfolded below it).
  let previous = null;
  for (const entry of entries) {
    let node = existing.get(entry.path);
    if (!node) {
      node = await buildNode(entry, depth);
      if (!previous) wrapper.prepend(node);
      else (previous.unfoldedChildren?.() || previous).after(node);
    }
    previous = node;
  }
  applyGitBadges();
  scheduleWatchUpdate();
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
  node.className = entry.is_dir ? "tree-node is-dir" : "tree-node is-file";
  node.dataset.path = entry.path;

  // Without icons, a trailing slash tells folders apart.
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = entry.is_dir ? `${entry.name}/` : entry.name;

  // Where it is, relative to the tree root.
  const folder = document.createElement("span");
  folder.className = "search-dir";
  const parent = parentOf(entry.path) || "";
  folder.textContent = parent.length > treeRoot.length ? parent.slice(treeRoot.length + 1) : "";

  node.append(label, folder);

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
    // With shell integration the cd is silent: no command line echoed in the terminal.
    await invoke("cd_to", { id: active.id, path, silent: active.integration });
  } catch {
    // shell not ready yet
  }
}

document.getElementById("go-home").addEventListener("click", async () => {
  await navigateTo(homeDir);
  await renderRoot(homeDir);
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

// ---------------------------------------------------------------------------
// Contextual panels

let sidebarMode = "shell";
let contextKey = null;
let serverUrlsKey = null;

function setSidebarMode(mode) {
  sidebarMode = mode;
  if (mode !== "context") contextKey = null;
  gitOperationEl.hidden = mode !== "shell" || !gitOperation;
  commandHistoryEl.hidden = mode !== "shell" || !active || active.history.length === 0;
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

// Shows the panel matching the session's last known context, without any IPC.
function applyContext(session) {
  const context = session.context;
  if (context.mode === "ssh") {
    setSidebarMode("ssh");
    updateSshPanel(session);
  } else if (context.mode === "server") {
    setSidebarMode("server");
    updateServerPanel(context.urls);
  } else if (context.mode === "context") {
    showContextPanel(session);
  } else {
    setSidebarMode(context.mode);
  }
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
function showContextPanel(session) {
  const context = session.context;
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
        active.write(action.keys);
        active.term.focus();
      });
      contextActionsEl.appendChild(button);
    }
  }
  contextElapsedEl.hidden = !context.elapsed;
  if (context.elapsed) {
    if (!session.commandStartedAt) session.commandStartedAt = Date.now();
    contextElapsedEl.textContent = `Depuis ${formatElapsed(Date.now() - session.commandStartedAt)}`;
  }
}

function updateSshPanel(session) {
  const command = session.context.command || "";
  const match = command.match(/\S+@\S+/);
  sshHostEl.textContent = match ? match[0] : command;
  sshCwdEl.textContent = session.remoteCwd || "";
  sshCwdEl.hidden = !session.remoteCwd;
}

document.getElementById("server-stop").addEventListener("click", () => {
  active?.write(String.fromCharCode(3));
});

document.getElementById("ssh-close").addEventListener("click", () => {
  active?.write(String.fromCharCode(4));
});

document.querySelectorAll("#claude-panel [data-slash]").forEach((button) => {
  button.addEventListener("click", () => {
    if (!active) return;
    const slash = button.dataset.slash;
    active.write(`${slash}\r`);
    active.claudeHistory.unshift(slash);
    renderClaudeHistory();
  });
});

document.getElementById("claude-escape").addEventListener("click", () => {
  active?.write(String.fromCharCode(27));
});

function renderClaudeHistory() {
  claudeHistoryEl.innerHTML = "";
  for (const slash of active?.claudeHistory || []) {
    const entry = document.createElement("div");
    entry.className = "claude-history-entry";
    entry.textContent = slash;
    claudeHistoryEl.appendChild(entry);
  }
}

function renderHistory() {
  const history = active?.history || [];
  commandHistoryEl.hidden = history.length === 0 || sidebarMode !== "shell";
  commandHistoryListEl.innerHTML = "";
  for (const { text, code } of history) {
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
      if (!active?.atPrompt) return;
      active.write(text);
      active.term.focus();
    });
    commandHistoryListEl.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Live state

async function onPrompt(session, finished) {
  renderTabs();
  if (session !== active) return;
  applyContext(session);
  renderHistory();
  // Also brings the tree back to the terminal's folder after browsing elsewhere.
  if (session.cwd && session.cwd !== currentPathEl.textContent) {
    await renderRoot(session.cwd);
    return;
  }
  // The command may have changed files or the branch (git commit, checkout…).
  if (finished) await refreshGitBar(treeRoot);
}

function pollAll() {
  for (const session of sessions) pollSession(session);
}

async function pollSession(session) {
  if (session.polling || session.exited || session.id === null) return;
  if (session.integration && session.atPrompt) return;
  session.polling = true;
  try {
    let foreground;
    try {
      foreground = await invoke("foreground_state", { id: session.id });
    } catch {
      return;
    }
    // The prompt may have come back while ps was running.
    if (session.integration && session.atPrompt) return;

    const context = classifyForeground(foreground, {
      lastServerUrl: session.lastServerUrl,
      pendingCommand: session.pendingCommand,
    });
    if (session.mode === "server" && context.mode !== "server") session.forgetServerUrl();
    if (context.mode !== "context" && context.mode !== "shell") session.commandStartedAt = null;
    session.context = context;
    renderTabs();
    if (session === active) await updateActiveSidebar(session);
  } finally {
    session.polling = false;
  }
}

async function updateActiveSidebar(session) {
  applyContext(session);
  if (session.mode === "claude") {
    try {
      const cwd = session.integration ? session.cwd : await invoke("shell_cwd", { id: session.id });
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
  } else if (session.mode === "shell" && !session.integration) {
    // Without shell integration (fish…), follow the shell's cwd by polling.
    try {
      const cwd = await invoke("shell_cwd", { id: session.id });
      if (cwd && cwd !== session.cwd) {
        session.cwd = cwd;
        renderTabs();
        if (cwd !== currentPathEl.textContent) await renderRoot(cwd);
      }
    } catch {
      // ignore
    }
  }
}

async function init() {
  applyAppearance();
  loadSettingsChoices();
  await invoke("close_all_shells");
  homeDir = await invoke("home_dir");
  await newTab(homeDir);
  setInterval(pollAll, 1000);
}

init();
