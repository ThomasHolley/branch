# CLAUDE.md

Ce fichier guide Claude Code (claude.ai/code) pour travailler sur ce dépôt.

## Projet

**Branch** : application desktop Tauri 2 qui associe un vrai terminal (xterm.js côté front, `portable-pty` côté Rust) à une arborescence de fichiers graphique. La sidebar change selon le processus au premier plan dans le terminal : shell, `claude`, `ssh` ou serveur de dev (`node`, `npm`, `vite`…). Cibles : macOS et Windows.

L'interface, les messages et les commits sont en français.

## Commandes

```
npm install
npm run tauri dev      # lance Vite (port 1420, strictPort) + l'appli Tauri
npm run tauri build    # installeurs dans src-tauri/target/release/bundle/
npm run build          # front seul (Vite → dist/)
cargo check --manifest-path src-tauri/Cargo.toml   # vérif rapide du Rust
cargo test --manifest-path src-tauri/Cargo.toml    # tests unitaires (parseurs, décodage)
```

Pas de linter ni de CI. Les tests unitaires couvrent les fonctions pures de `lib.rs`. Pour le reste, on lance l'appli avec `npm run tauri dev`.

Pour `cargo check --target x86_64-pc-windows-msvc` depuis macOS, le build script exige `llvm-rc` (`brew install llvm`). Un faux `llvm-rc` qui écrit un fichier vide suffit pour un simple check.

## Architecture

Le projet tient dans très peu de fichiers :

- [src-tauri/src/lib.rs](src-tauri/src/lib.rs) contient tout le backend : l'état `PtyState` (master, writer, PID du shell) et toutes les commandes `#[tauri::command]`, enregistrées dans `generate_handler!` en bas de `run()`.
- [src/main.js](src/main.js) contient tout le frontend en JS vanilla, sans framework : le terminal xterm, l'arbre de fichiers, le statut git, le menu contextuel et les panneaux de la sidebar.
- [index.html](index.html) définit la structure de la sidebar : les panneaux `file-tree`, `claude-panel`, `server-panel` et `ssh-panel`, plus le menu contextuel.
- [src/styles.css](src/styles.css) : thème sombre.
- [src-tauri/capabilities/default.json](src-tauri/capabilities/default.json) : permissions des plugins (opener, clipboard). Toute nouvelle API de plugin appelée depuis le front doit y être ajoutée.

Flux principaux :

- **PTY** : `start_shell` démarre le shell dans le dossier personnel. Un thread lit la sortie et l'émet dans l'événement `pty-data`. Le front renvoie les frappes via `write_to_pty` et appelle `resize_pty` quand la fenêtre change de taille.
- **Shell integration** : le shell signale son état avec une séquence OSC privée, interceptée par xterm (`term.parser.registerOscHandler(6973, …)`). À chaque prompt, il envoie `ESC ] 6973 ; prompt ; <code> ; <cwd> BEL`. Au lancement d'une commande, il envoie `ESC ] 6973 ; cmd ; <texte> BEL`. Les scripts sont dans [src-tauri/shell/](src-tauri/shell/) : zsh via `ZDOTDIR` (le `.zshenv`/`.zshrc` de l'utilisateur reste chargé), bash via `--rcfile`. PowerShell utilise `PS_INIT` dans `lib.rs`. Ces séquences alimentent l'état `atPrompt`, le dossier courant et l'historique des commandes. L'OSC 7 standard, envoyé par certains shells distants, s'affiche dans le panneau SSH.
- **Polling** : `pollLiveState()` tourne toutes les secondes, mais ne fait rien quand le shell est au prompt. Pendant une commande, il appelle `foreground_process` et choisit le mode de la sidebar avec `setSidebarMode`. Pour les shells sans intégration (fish…), il appelle aussi `shell_cwd` (`lsof`, ou fichier temporaire sous Windows).
- **Navigation** : un clic sur un dossier de l'arbre appelle `cd_to`, qui écrit une commande `cd` dans le PTY, uniquement quand le shell est au prompt.
- **Git** : `git_status` lance `git status --porcelain=v2 --branch`. Les clés de `entries` sont des chemins absolus, qui doivent correspondre exactement à `data-path` des nœuds de l'arbre.
- **Serveur de dev** : son URL est détectée par une regex (`URL_REGEX`) appliquée à la sortie du PTY.

## Multi-plateforme : points d'attention

Le code spécifique à chaque OS passe par des paires `#[cfg(windows)]` / `#[cfg(not(windows))]`. Quand on modifie une fonction, il faut modifier les deux variantes.

| Besoin | macOS / Unix | Windows |
|---|---|---|
| Shell | `$SHELL` (défaut `/bin/zsh`) | `powershell.exe` avec le script `PS_INIT` |
| Dossier courant du shell | `lsof -d cwd` | le prompt PowerShell écrit dans le fichier `branch-cwd-<pid>.txt` du dossier temp (`BRANCH_CWD_FILE`) |
| Processus au premier plan | `ps -o tpgid=` puis `comm=` / `args=` | `sysinfo` : on suit le plus récent enfant du shell. `node.exe` exécutant `claude-code` est renommé `claude` |
| `cd_to` | `cd '…' && clear\n` | `Set-Location -LiteralPath '…'; Clear-Host\r` |
| Ouvrir dans l'éditeur | `code` puis `open` | `code.cmd` puis l'appli par défaut (plugin opener) |
| Fichiers cachés | commencent par `.` | `.` ou attribut `FILE_ATTRIBUTE_HIDDEN` |

À retenir :

- Toute commande externe lancée depuis Rust passe par le helper `command()`. Sinon, une fenêtre console s'ouvre brièvement sous Windows.
- `PS_INIT` ne doit contenir aucun guillemet double, car il est passé comme un seul argument de ligne de commande Windows.
- Les chemins renvoyés par git utilisent `/`. `repo_path()` les convertit en `\` sous Windows pour qu'ils correspondent aux clés de l'arbre.
- Pour simuler Entrée dans le PTY depuis le front, on envoie `\r` (cela fonctionne sur les deux OS).
- Le nom de processus `"claude"` déclenche le panneau Claude Code. La liste des serveurs de dev est dans `SERVER_PROCESS_NAMES` ([src/main.js](src/main.js)).
- Quand on ajoute une police, la pile doit garder des polices Windows (`Consolas`, `Cascadia Mono`) à côté de `Menlo` et `Monaco`.

## Versionnage

- `main` est la branche stable. On n'y commite pas directement.
- Une branche par chantier (`fix/…`, `feat/…`, `chore/…`), fusionnée dans `main` via une PR GitHub.
- Avant la PR : `cargo check` (macOS et `--target x86_64-pc-windows-msvc`), `cargo test` et `npm run build`.
