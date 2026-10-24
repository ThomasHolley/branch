import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyForeground, serverUrls, gitOperationLabel, formatElapsed } from "./context.js";

const fg = (name, command = name, ports = []) => ({ name, command, ports });

test("claude et ssh passent avant tout", () => {
  assert.equal(classifyForeground(fg("claude", "claude", [3000])).mode, "claude");
  assert.equal(classifyForeground(fg("ssh", "ssh user@host")).mode, "ssh");
});

test("un port en écoute suffit à reconnaître un serveur", () => {
  const result = classifyForeground(fg("python3", "python3 manage.py runserver", [8000]));
  assert.equal(result.mode, "server");
  assert.deepEqual(result.urls, ["http://localhost:8000"]);
});

test("l'URL affichée par le serveur passe en premier", () => {
  assert.deepEqual(serverUrls([5173, 24678], "http://localhost:5173/app/"), [
    "http://localhost:5173/app/",
    "http://localhost:24678",
  ]);
  assert.deepEqual(serverUrls([3000], "http://localhost:5173/"), ["http://localhost:3000"]);
});

test("node sans port ni URL n'est pas un serveur", () => {
  assert.equal(classifyForeground(fg("node", "node script.js")).key, "running:node script.js");
  assert.equal(classifyForeground(fg("npm", "npm run dev"), { lastServerUrl: "http://localhost:5173/" }).mode, "server");
});

test("shell au premier plan", () => {
  assert.equal(classifyForeground(fg("-zsh")).mode, "shell");
  assert.equal(classifyForeground(fg("")).mode, "shell");
});

test("éditeur avec le fichier ouvert", () => {
  const result = classifyForeground(fg("nvim", "nvim -p +12 src/main.js"));
  assert.equal(result.title, "Éditeur · nvim");
  assert.equal(result.detail, "main.js");
  assert.equal(result.actions[0].keys, "\x1b:w\r");
  assert.equal(classifyForeground(fg("vim", "C:\\tools\\vim.exe C:\\proj\\a.txt")).detail, "a.txt");
});

test("pager et manuel", () => {
  assert.equal(classifyForeground(fg("man", "man git-rebase")).title, "Manuel");
  assert.equal(classifyForeground(fg("less", "less -R log.txt")).detail, "log.txt");
});

test("REPL seulement sans script", () => {
  assert.equal(classifyForeground(fg("Python", "/usr/bin/python3")).title, "REPL Python");
  assert.equal(classifyForeground(fg("python3.12", "python3.12 -i")).title, "REPL Python");
  assert.equal(classifyForeground(fg("node", "node")).actions[1].keys, ".exit\r");
  assert.equal(classifyForeground(fg("python3", "python3 build.py")).title, "Commande en cours");
});

test("commande en cours : texte tapé par l'utilisateur de préférence", () => {
  const result = classifyForeground(fg("cargo", "/Users/x/.cargo/bin/cargo build"), { pendingCommand: "cargo build " });
  assert.equal(result.detail, "cargo build");
  assert.equal(result.elapsed, true);
});

test("libellés git et durée", () => {
  assert.equal(gitOperationLabel("rebase", 0), "Rebase en cours");
  assert.equal(gitOperationLabel("merge", 2), "Merge en cours · 2 conflits");
  assert.equal(formatElapsed(5_000), "5 s");
  assert.equal(formatElapsed(125_000), "2 min 05 s");
  assert.equal(formatElapsed(3_900_000), "1 h 05 min");
});
