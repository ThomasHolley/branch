# Branch

Terminal avec navigation graphique (Tauri 2 + xterm.js), pour macOS et Windows.

Sous Windows, le terminal lance PowerShell (`powershell.exe`).

## Compiler sous Windows

Prérequis :

- [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) avec « Développement Desktop en C++ »
- [Rust](https://rustup.rs) (cible MSVC, celle par défaut)
- [Node.js](https://nodejs.org)
- [Git](https://git-scm.com) (pour l'affichage du statut git dans l'appli)

WebView2 est déjà présent sur Windows 10 et 11.

```
npm install
npm run tauri build
```

Les installateurs sont générés dans :

- `src-tauri\target\release\bundle\nsis\branch_0.1.0_x64-setup.exe`
- `src-tauri\target\release\bundle\msi\branch_0.1.0_x64_en-US.msi`

Pour tester sans installer : `npm run tauri dev`.

## Compiler sous macOS

```
npm install
npm run tauri build
```

## Publier une version macOS (signée et notarisée)

```
./scripts/release-macos.sh 0.2.0
```

Le script met à jour le numéro de version (`package.json`, `tauri.conf.json`, `Cargo.toml`). Il compile ensuite une application universelle (Apple Silicon + Intel), la signe avec le certificat Developer ID, la fait notariser par Apple et agrafe le ticket. Il fait de même pour le DMG, puis vérifie le résultat avec Gatekeeper. Le DMG final est écrit dans `src-tauri/target/release-macos/`. Le script ne publie rien et ne commite rien.

Prérequis (une seule fois) :

- un certificat « Developer ID Application » dans le trousseau ;
- un profil notarytool : `xcrun notarytool store-credentials branch-notary --apple-id <identifiant> --team-id <équipe>`.

Variables facultatives : `BRANCH_SIGNING_IDENTITY` (nom du certificat, détecté automatiquement sinon) et `BRANCH_NOTARY_PROFILE` (`branch-notary` par défaut).
