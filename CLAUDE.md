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
cargo test --manifest-path src-tauri/Cargo.toml    # tests unitaires Rust (parseurs, décodage)
npm test                                           # tests unitaires JS (node --test, src/*.test.js)
```

Pas de linter ni de CI. Les tests unitaires couvrent les fonctions pures de `lib.rs` et de `src/context.js`. Pour le reste, on lance l'appli avec `npm run tauri dev`.

Pour `cargo check --target x86_64-pc-windows-msvc` depuis macOS, le build script exige `llvm-rc` (`brew install llvm`). Un faux `llvm-rc` qui écrit un fichier vide suffit pour un simple check.

## Architecture

Le projet tient dans très peu de fichiers :

- [src-tauri/src/lib.rs](src-tauri/src/lib.rs) contient tout le backend : l'état `Sessions` (un PTY par onglet, indexé par id ; toutes les commandes liées au terminal prennent cet `id`, et les événements `pty-data`/`pty-exit` portent `{ id, … }`) et toutes les commandes `#[tauri::command]`, enregistrées dans `generate_handler!` en bas de `run()`.
- [src/main.js](src/main.js) contient le frontend en JS vanilla, sans framework : les onglets, l'arbre de fichiers, le statut git, le menu contextuel et les panneaux de la sidebar. La sidebar affiche toujours la session de l'onglet actif (`active`).
- [src/session.js](src/session.js) définit la classe `Session` : un onglet, avec son xterm, son shell côté backend (identifié par un `id`) et l'état rapporté par la shell integration (`atPrompt`, `cwd`, historique, contexte).
- [src/context.js](src/context.js) contient `classifyForeground()` : à partir de `foreground_state` (nom, ligne de commande, ports en écoute), il choisit le panneau de la sidebar (claude, ssh, serveur, éditeur, pager, REPL, commande en cours, shell). C'est un module pur, sans DOM : on y ajoute les nouveaux contextes et leurs tests.
- [index.html](index.html) définit la structure de la sidebar : les panneaux `file-tree`, `claude-panel`, `server-panel` et `ssh-panel`, plus le menu contextuel.
- [src/styles.css](src/styles.css) : thème sombre.
- [src-tauri/capabilities/default.json](src-tauri/capabilities/default.json) : permissions des plugins (opener, clipboard). Toute nouvelle API de plugin appelée depuis le front doit y être ajoutée.

Flux principaux :

- **PTY** : `start_shell(cwd)` démarre un shell (nouvel onglet = dossier de l'onglet actif) et renvoie son id. `close_all_shells` est appelé au chargement de la page, pour ne pas laisser traîner les shells d'avant un rechargement. Un thread lit la sortie et l'émet dans l'événement `pty-data`. Le front renvoie les frappes via `write_to_pty` et appelle `resize_pty` quand la fenêtre change de taille.
- **Shell integration** : le shell signale son état avec une séquence OSC privée, interceptée par xterm (`term.parser.registerOscHandler(6973, …)`). À chaque prompt, il envoie `ESC ] 6973 ; prompt ; <code> ; <cwd> BEL`. Au lancement d'une commande, il envoie `ESC ] 6973 ; cmd ; <texte> BEL`. Les scripts sont dans [src-tauri/shell/](src-tauri/shell/) : zsh via `ZDOTDIR` (le `.zshenv`/`.zshrc` de l'utilisateur reste chargé), bash via `--rcfile`. PowerShell utilise `PS_INIT` dans `lib.rs`. Ces séquences alimentent l'état `atPrompt`, le dossier courant et l'historique des commandes. L'OSC 7 standard, envoyé par certains shells distants, s'affiche dans le panneau SSH.
- **Polling** : `pollLiveState()` tourne toutes les secondes, mais ne fait rien quand le shell est au prompt. Pendant une commande, il appelle `foreground_state` puis `classifyForeground()`. Un serveur de dev est reconnu à ses **ports TCP en écoute** (job au premier plan via `pgrep -g` + `lsof`, ou descendants du shell + `netstat` sous Windows), pas au nom du processus. Pour les shells sans intégration (fish…), il appelle aussi `shell_cwd` (`lsof`, ou fichier temporaire sous Windows).
- **Navigation permanente** : l'arbre reste toujours visible. Le panneau du contexte (Claude, serveur, SSH, éditeur…) s'affiche au-dessus, sous forme de carte. Le comportement de l'arbre dépend de `canDriveShell()` :
  - **mode shell, au prompt** : un clic sur un dossier appelle `cd_to` (le terminal suit), et le prompt suivant resynchronise l'arbre sur le dossier courant ;
  - **sinon (« navigation libre », classe `.sidebar.browsing`)** : on déplie et on parcourt l'arbre sans jamais écrire dans le PTY. En mode Claude, un clic sur un fichier tape `@chemin` dans le prompt de Claude.
  - Partout : double-clic sur un fichier pour l'ouvrir dans l'éditeur, badges git propagés aux dossiers parents.
- **Recherche** : le champ de filtre appelle `find_files` (recherche récursive bornée, qui ignore `node_modules`, `target`, `dist`…). Les résultats remplacent l'arbre sous forme de liste, Échap restaure l'arbre.
- **Suppression** : `delete_path` envoie à la corbeille (crate `trash`).
- **Git** : `git_status` lance `git status --porcelain=v2 --branch`. Les clés de `entries` sont des chemins absolus, qui doivent correspondre exactement à `data-path` des nœuds de l'arbre.
- **Serveur de dev** : les URL viennent des ports en écoute. Si le serveur a affiché une URL dans la sortie (`URL_REGEX`, après retrait des codes ANSI), elle passe en premier.
- **Git** : `git_status` renvoie aussi `operation` (rebase, merge, cherry-pick, revert en pause). Un bandeau propose alors de continuer ou d'annuler, via `run_at_prompt`.

## Multi-plateforme : points d'attention

Le code spécifique à chaque OS passe par des paires `#[cfg(windows)]` / `#[cfg(not(windows))]`. Quand on modifie une fonction, il faut modifier les deux variantes.

| Besoin | macOS / Unix | Windows |
|---|---|---|
| Shell | `$SHELL` (défaut `/bin/zsh`) | `powershell.exe` avec le script `PS_INIT` |
| Dossier courant du shell | `lsof -d cwd` | le prompt PowerShell écrit dans le fichier `branch-cwd-<pid>.txt` du dossier temp (`BRANCH_CWD_FILE`) |
| Processus au premier plan | `ps -o tpgid=` puis `comm=` / `args=`, ports : `pgrep -g` + `lsof` | `sysinfo` : on suit le plus récent enfant du shell. `node.exe` exécutant `claude-code` est renommé `claude`. Ports : `netstat -ano` |
| `cd_to` | `cd '…' && clear\n` | `Set-Location -LiteralPath '…'; Clear-Host\r` |
| Ouvrir dans l'éditeur | `code` puis `open` | `code.cmd` puis l'appli par défaut (plugin opener) |
| Fichiers cachés | commencent par `.` | `.` ou attribut `FILE_ATTRIBUTE_HIDDEN` |

À retenir :

- Toute commande externe lancée depuis Rust passe par le helper `command()`. Sinon, une fenêtre console s'ouvre brièvement sous Windows.
- `PS_INIT` ne doit contenir aucun guillemet double, car il est passé comme un seul argument de ligne de commande Windows.
- Les chemins renvoyés par git utilisent `/`. `repo_path()` les convertit en `\` sous Windows pour qu'ils correspondent aux clés de l'arbre.
- Pour simuler Entrée dans le PTY depuis le front, on envoie `\r` (cela fonctionne sur les deux OS).
- Le nom de processus `"claude"` déclenche le panneau Claude Code. Les autres contextes sont définis dans [src/context.js](src/context.js).
- Quand on ajoute une police, la pile doit garder des polices Windows (`Consolas`, `Cascadia Mono`) à côté de `Menlo` et `Monaco`.

## Versionnage

- `main` est la branche stable. On n'y commite pas directement.
- Une branche par chantier (`fix/…`, `feat/…`, `chore/…`), fusionnée dans `main` via une PR GitHub.
- Avant la PR : `cargo check` (macOS et `--target x86_64-pc-windows-msvc`), `cargo test` et `npm run build`.
