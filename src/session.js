import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

const URL_REGEX = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?[^\s"'\\]*/g;
// CSI sequences (colors, cursor moves) and OSC sequences: Vite, for one, prints the port in bold.
const ANSI_REGEX = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const MAX_HISTORY = 30;

const TERMINAL_OPTIONS = {
  cursorBlink: true,
  fontSize: 13,
  fontFamily: "Menlo, Monaco, Consolas, 'Cascadia Mono', 'Courier New', monospace",
  theme: {
    background: "#1e1e1e",
    foreground: "#ddd",
  },
};

// One terminal tab: its xterm instance, its shell in the backend (by id) and what is
// known about that shell. `hooks` lets main.js react to the shell integration:
// onPrompt(session, code), onCommandStart(session), onEnter(session),
// onRemoteCwd(session), onExit(session, code).
//
// Shell integration (see shell_command in lib.rs): once the shell has reported a
// prompt, the prompt itself tells the cwd and that nothing is running, so the ps/lsof
// polling only runs while a command is in the foreground.
export class Session {
  constructor(container, hooks) {
    this.hooks = hooks;
    this.id = null;
    this.integration = false;
    this.atPrompt = false;
    this.pendingCommand = null;
    this.commandStartedAt = null;
    this.cwd = null;
    this.remoteCwd = null;
    this.lastServerUrl = null;
    // Tail of the recent output, so a URL split across two chunks is still found.
    this.outputTail = "";
    this.history = [];
    this.claudeHistory = [];
    this.exited = false;
    // Last classification of the foreground (see context.js), shell by default.
    this.context = { mode: "shell" };

    this.el = document.createElement("div");
    this.el.className = "terminal-instance";
    this.el.hidden = true;
    container.appendChild(this.el);

    this.term = new Terminal(TERMINAL_OPTIONS);
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.open(this.el);
    this.term.onData((data) => this.handleInput(data));

    this.term.parser.registerOscHandler(6973, (data) => {
      const [kind, ...rest] = data.split(";");
      if (kind === "prompt") {
        this.handlePrompt(Number(rest[0]) || 0, rest.slice(1).join(";"));
      } else if (kind === "cmd") {
        this.handleCommandStart(rest.join(";"));
      }
      return true;
    });

    // Standard OSC 7 (file://host/path), sent by some remote shells: shown in the SSH panel.
    this.term.parser.registerOscHandler(7, (data) => {
      const match = data.match(/^file:\/\/([^/]*)(\/.*)$/);
      if (match) {
        let path = match[2];
        try {
          path = decodeURIComponent(path);
        } catch {
          // keep it encoded
        }
        this.remoteCwd = `${match[1]}:${path}`;
        this.hooks.onRemoteCwd(this);
      }
      return true;
    });
  }

  async start(cwd) {
    // Fitted first so that the shell starts at the right size.
    if (!this.el.hidden) this.fitAddon.fit();
    this.id = await invoke("start_shell", { cwd: cwd || null, cols: this.term.cols, rows: this.term.rows });
    await this.syncSize();
  }

  get mode() {
    return this.context.mode;
  }

  // The shell waits at its prompt: the sidebar may type into it (cd, git…).
  get idle() {
    return this.mode === "shell" && (!this.integration || this.atPrompt);
  }

  write(data) {
    return invoke("write_to_pty", { id: this.id, data });
  }

  handleInput(data) {
    if (this.exited) {
      if (data === "\r") this.restart();
      return;
    }
    // bash only reports a command once it is done: Enter is enough to know one is running.
    if (this.atPrompt && data.includes("\r")) {
      this.atPrompt = false;
      this.commandStartedAt = Date.now();
      this.hooks.onEnter(this);
    }
    this.write(data);
  }

  receive(data) {
    this.term.write(data);
    this.outputTail = (this.outputTail + data.replace(ANSI_REGEX, "")).slice(-1000);
    const matches = this.outputTail.match(URL_REGEX);
    if (matches) this.lastServerUrl = matches[matches.length - 1];
  }

  handleCommandStart(command) {
    this.atPrompt = false;
    this.pendingCommand = command;
    this.commandStartedAt = Date.now();
    this.forgetServerUrl();
    this.hooks.onEnter(this);
  }

  handlePrompt(code, cwd) {
    this.integration = true;
    this.atPrompt = true;
    this.remoteCwd = null;
    this.commandStartedAt = null;
    this.context = { mode: "shell" };
    const finished = this.pendingCommand;
    this.pendingCommand = null;
    if (finished?.trim()) {
      this.history.unshift({ text: finished.trim(), code });
      this.history.length = Math.min(this.history.length, MAX_HISTORY);
    }
    if (cwd) this.cwd = cwd;
    this.hooks.onPrompt(this, finished);
  }

  // A URL printed by a server that has since stopped must not show up for the next one.
  forgetServerUrl() {
    this.lastServerUrl = null;
    this.outputTail = "";
  }

  handleExit(code) {
    this.exited = true;
    this.atPrompt = false;
    this.pendingCommand = null;
    this.context = { mode: "shell" };
    this.term.write(`\r\n\x1b[2m[Processus terminé (code ${code}) — Entrée pour relancer]\x1b[0m\r\n`);
    this.hooks.onExit(this, code);
  }

  async restart() {
    this.exited = false;
    this.integration = false;
    this.term.reset();
    await this.start(this.cwd);
  }

  async syncSize() {
    // A hidden tab has no size: it is fitted when shown.
    if (this.el.hidden || this.id === null) return;
    this.fitAddon.fit();
    try {
      await invoke("resize_pty", { id: this.id, cols: this.term.cols, rows: this.term.rows });
    } catch {
      // shell gone
    }
  }

  show() {
    this.el.hidden = false;
    this.syncSize();
    this.term.focus();
  }

  hide() {
    this.el.hidden = true;
  }

  dispose() {
    if (this.id !== null) invoke("close_shell", { id: this.id });
    this.term.dispose();
    this.el.remove();
  }
}
