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
