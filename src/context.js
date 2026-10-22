// Decides which sidebar panel matches what runs in the terminal's foreground.
// Pure (no DOM, no Tauri) so that it can be tested with `node --test`.

const SHELLS = new Set(["", "zsh", "-zsh", "bash", "-bash", "sh", "fish", "-fish", "login", "powershell", "pwsh"]);

// A server may print its URL before it starts listening: these names alone are enough
// once a URL has been seen in the output.
const SERVER_PROCESS_NAMES = new Set(["node", "npm", "npx", "yarn", "pnpm", "bun", "deno", "vite", "next-server"]);

const CTRL_C = "\x03";
const VIM_KEYS = { save: "\x1b:w\r", quit: "\x1b:q\r" };
const EDITORS = {
  vim: VIM_KEYS,
  nvim: VIM_KEYS,
  vi: VIM_KEYS,
  hx: VIM_KEYS,
  helix: VIM_KEYS,
  nano: { save: "\x0f\r", quit: "\x18" },
  micro: { save: "\x13", quit: "\x11" },
  emacs: { save: "\x18\x13", quit: "\x18\x03" },
};

const PAGERS = new Set(["less", "more", "most", "man"]);

const REPLS = [
  { test: (name) => /^python[\d.]*$/.test(name), label: "Python", exit: "exit()\r" },
  { test: (name) => name === "node", label: "Node.js", exit: ".exit\r" },
  { test: (name) => name === "irb", label: "Ruby", exit: "exit\r" },
];

// Arguments that are not options: the files or scripts the program was given.
function positionalArgs(command) {
  return command
    .trim()
    .split(/\s+/)
    .slice(1)
    .filter((arg) => arg && !arg.startsWith("-") && !arg.startsWith("+"));
}

function basename(path) {
  return path.split(/[\\/]/).pop();
}

export function serverUrls(ports, lastServerUrl) {
  const urls = ports.map((port) => `http://localhost:${port}`);
  // The URL the server printed is the one to open (it may carry a path such as /app/).
  const printedPort = lastServerUrl?.match(/:(\d+)/)?.[1];
  if (printedPort && ports.includes(Number(printedPort))) {
    return [lastServerUrl, ...urls.filter((url) => !url.endsWith(`:${printedPort}`))];
  }
  return urls;
}

// `foreground` is the backend's foreground_state: { name, command, ports }.
// `pendingCommand` is the command line as the user typed it (shell integration).
export function classifyForeground(foreground, { lastServerUrl = null, pendingCommand = null } = {}) {
  const name = foreground.name.toLowerCase();
  const command = foreground.command || "";
  const ports = foreground.ports || [];

  if (name === "claude") return { mode: "claude" };
  if (name === "ssh") return { mode: "ssh", command };
  if (ports.length) return { mode: "server", urls: serverUrls(ports, lastServerUrl) };
  if (SERVER_PROCESS_NAMES.has(name) && lastServerUrl) return { mode: "server", urls: [lastServerUrl] };
  if (SHELLS.has(name)) return { mode: "shell" };

  if (EDITORS[name]) {
    const files = positionalArgs(command);
    const file = files[files.length - 1];
    return {
      mode: "context",
      key: `editor:${name}:${file || ""}`,
      title: `Éditeur · ${name}`,
      detail: file ? basename(file) : "Nouveau fichier",
      detailTitle: file || "",
      actions: [
        { label: "Enregistrer", keys: EDITORS[name].save },
        { label: "Quitter", keys: EDITORS[name].quit },
      ],
    };
  }

  if (PAGERS.has(name)) {
    const topic = positionalArgs(command).join(" ");
    return {
      mode: "context",
      key: `pager:${name}:${topic}`,
      title: name === "man" ? "Manuel" : `Lecture · ${name}`,
      detail: topic ? basename(topic) : "",
      detailTitle: topic,
      actions: [
        { label: "Page suivante", keys: " " },
        { label: "Page précédente", keys: "b" },
        { label: "Rechercher…", keys: "/", focus: true },
        { label: "Quitter", keys: "q" },
      ],
    };
  }

  const repl = REPLS.find((r) => r.test(name));
  if (repl && positionalArgs(command).length === 0) {
    return {
      mode: "context",
      key: `repl:${name}`,
      title: `REPL ${repl.label}`,
      detail: "",
      detailTitle: "",
      actions: [
        { label: "Interrompre (Ctrl+C)", keys: CTRL_C },
        { label: "Quitter", keys: repl.exit },
      ],
    };
  }

  const text = pendingCommand?.trim() || command;
  return {
    mode: "context",
    key: `running:${text}`,
    title: "Commande en cours",
    detail: text,
    detailTitle: text,
    elapsed: true,
    actions: [{ label: "Interrompre (Ctrl+C)", keys: CTRL_C }],
  };
}

const GIT_OPERATION_LABELS = {
  rebase: "Rebase",
  merge: "Merge",
  "cherry-pick": "Cherry-pick",
  revert: "Revert",
};

export function gitOperationLabel(operation, conflicts) {
  const label = `${GIT_OPERATION_LABELS[operation] || operation} en cours`;
  if (!conflicts) return label;
  return `${label} · ${conflicts} conflit${conflicts > 1 ? "s" : ""}`;
}

export function formatElapsed(ms) {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, "0")} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}
