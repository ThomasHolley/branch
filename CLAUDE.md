# CLAUDE.md

Ce fichier guide Claude Code (claude.ai/code) pour travailler sur ce dépôt.

## Projet

**Branch** : application desktop Tauri 2 qui associe un vrai terminal (xterm.js côté front, `portable-pty` côté Rust) à une arborescence de fichiers graphique. La sidebar change selon le processus au premier plan dans le terminal : shell, `claude`, `ssh` ou serveur de dev (`node`, `npm`, `vite`…).

L'interface, les messages et les commits sont en français.

## Commandes

```
npm install
npm run tauri dev      # lance Vite (port 1420, strictPort) + l'appli Tauri
npm run tauri build    # installeurs dans src-tauri/target/release/bundle/
npm run build          # front seul (Vite → dist/)
cargo check --manifest-path src-tauri/Cargo.toml   # vérif rapide du Rust
```

Il n'y a ni tests, ni linter, ni CI. On vérifie en lançant l'appli avec `npm run tauri dev`.

## Architecture

Le projet tient dans très peu de fichiers :

- [src-tauri/src/lib.rs](src-tauri/src/lib.rs) contient tout le backend : l'état `PtyState` (master, writer, PID du shell) et toutes les commandes `#[tauri::command]`, enregistrées dans `generate_handler!` en bas de `run()`.
- [src/main.js](src/main.js) contient tout le frontend en JS vanilla, sans framework : le terminal xterm, l'arbre de fichiers, le statut git, le menu contextuel et les panneaux de la sidebar.
- [index.html](index.html) définit la structure de la sidebar : les panneaux `file-tree`, `claude-panel`, `server-panel` et `ssh-panel`, plus le menu contextuel.
- [src/styles.css](src/styles.css) : thème sombre.
- [src-tauri/capabilities/default.json](src-tauri/capabilities/default.json) : permissions des plugins (opener, clipboard). Toute nouvelle API de plugin appelée depuis le front doit y être ajoutée.

Flux principaux :

- **PTY** : `start_shell` démarre `$SHELL` (`/bin/zsh` par défaut) dans `$HOME`. Un thread lit la sortie et l'émet dans l'événement `pty-data`. Le front renvoie les frappes via `write_to_pty` et appelle `resize_pty` quand la fenêtre change de taille.
- **Polling** : `pollLiveState()` tourne toutes les secondes. Il appelle `foreground_process` (`ps -o tpgid=` puis `comm=`) et choisit le mode de la sidebar avec `setSidebarMode`. En mode shell, il appelle `shell_cwd` (`lsof -d cwd`) pour que l'arbre suive les `cd` tapés dans le terminal.
- **Navigation** : un clic sur un dossier de l'arbre appelle `cd_to`, qui écrit `cd '…' && clear` dans le PTY.
- **Git** : `git_status` lance `git status --porcelain=v2 --branch`. Les clés de `entries` sont des chemins absolus, qui doivent correspondre exactement à `data-path` des nœuds de l'arbre.
- **Serveur de dev** : son URL est détectée par une regex (`URL_REGEX`) appliquée à la sortie du PTY.
- **Éditeur** : `open_in_editor` essaie `code`, puis `open` en repli.

À retenir :

- Le nom de processus `"claude"` déclenche le panneau Claude Code. La liste des serveurs de dev est dans `SERVER_PROCESS_NAMES` ([src/main.js](src/main.js)).
- Le code de `main` ne vise que macOS/Unix (`ps`, `lsof`, `open`, `$HOME`).

## Branches

- `main` : version macOS.
- `windows-support` : ajoute la prise en charge de Windows (PowerShell, `sysinfo`, polices, README). Elle n'est pas encore fusionnée dans `main`. Au moment de la fusion, il faudra compléter ce fichier avec les points d'attention multi-plateforme.
