#!/usr/bin/env bash
# Builds a signed, notarized and stapled macOS release of Branch (universal:
# Apple Silicon + Intel) and its DMG.
#
#   ./scripts/release-macos.sh 0.2.0
#
# Prerequisites, set up once:
#   - a "Developer ID Application" certificate in the login keychain
#   - a notarytool profile:
#       xcrun notarytool store-credentials branch-notary --apple-id <id> --team-id <team>
#
# Optional environment:
#   BRANCH_SIGNING_IDENTITY  certificate name (default: the first Developer ID Application found)
#   BRANCH_NOTARY_PROFILE    notarytool keychain profile (default: branch-notary)
#
# The version is written to package.json, package-lock.json, tauri.conf.json and
# Cargo.toml; committing it is left to the caller. Nothing is published.

set -euo pipefail

VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage : $0 <version>   (ex. $0 0.2.0)" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mÉchec : %s\033[0m\n' "$*" >&2; exit 1; }

# --- Checks -----------------------------------------------------------------

[[ "$(uname)" == "Darwin" ]] || fail "ce script ne tourne que sur macOS"

# A release must match a commit: no uncommitted changes besides the version bump.
if [[ -n "$(git status --porcelain)" ]]; then
  fail "des modifications ne sont pas commitées (git status)"
fi

IDENTITY="${BRANCH_SIGNING_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
  IDENTITY="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | head -1)"
fi
[[ -n "$IDENTITY" ]] || fail "aucun certificat « Developer ID Application » dans le trousseau"

PROFILE="${BRANCH_NOTARY_PROFILE:-branch-notary}"
xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1 \
  || fail "profil notarytool « $PROFILE » introuvable (voir xcrun notarytool store-credentials)"

echo "Version    : $VERSION"
echo "Certificat : $IDENTITY"
echo "Profil     : $PROFILE"

# --- Version ----------------------------------------------------------------

step "Numéro de version → $VERSION"
npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null
node -e '
  const fs = require("fs");
  const path = "src-tauri/tauri.conf.json";
  const conf = JSON.parse(fs.readFileSync(path, "utf8"));
  conf.version = process.argv[1];
  fs.writeFileSync(path, JSON.stringify(conf, null, 2) + "\n");
' "$VERSION"
# Only the [package] version: the first "version =" line of Cargo.toml.
sed -i '' "1,/^version = /s/^version = \".*\"/version = \"$VERSION\"/" src-tauri/Cargo.toml

# --- Build ------------------------------------------------------------------

step "Cibles Rust Apple Silicon et Intel"
rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null

step "Build universel signé"
# Only the .app: the DMG is made below, once the app inside is notarized and stapled.
APPLE_SIGNING_IDENTITY="$IDENTITY" npm run tauri build -- --target universal-apple-darwin --bundles app

APP="src-tauri/target/universal-apple-darwin/release/bundle/macos/branch.app"
[[ -d "$APP" ]] || fail "application introuvable : $APP"
codesign --verify --deep --strict "$APP" || fail "signature invalide"

OUT="src-tauri/target/release-macos"
rm -rf "$OUT"
mkdir -p "$OUT"

# Submits a file to Apple and waits; prints Apple's log if it is not accepted.
notarize() {
  local file="$1" result id
  result="$(xcrun notarytool submit "$file" --keychain-profile "$PROFILE" --wait --output-format json)"
  id="$(node -pe 'JSON.parse(process.argv[1]).id' "$result")"
  if [[ "$(node -pe 'JSON.parse(process.argv[1]).status' "$result")" != "Accepted" ]]; then
    xcrun notarytool log "$id" --keychain-profile "$PROFILE" >&2 || true
    fail "notarisation refusée pour $file (id $id)"
  fi
  echo "Accepté (id $id)"
}

# --- Notarization of the app -------------------------------------------------

step "Notarisation de l'application"
ditto -c -k --keepParent "$APP" "$OUT/branch.zip"
notarize "$OUT/branch.zip"
rm "$OUT/branch.zip"
xcrun stapler staple "$APP"

# --- DMG ----------------------------------------------------------------------

step "Création du DMG"
DMG="$OUT/branch_${VERSION}_universal.dmg"
STAGING="$OUT/dmg"
mkdir -p "$STAGING"
ditto "$APP" "$STAGING/branch.app"
ln -s /Applications "$STAGING/Applications"
hdiutil create -volname "branch" -srcfolder "$STAGING" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGING"
codesign --sign "$IDENTITY" --timestamp "$DMG"

step "Notarisation du DMG"
notarize "$DMG"
xcrun stapler staple "$DMG"

# --- Verification ---------------------------------------------------------------

step "Vérification Gatekeeper"
spctl -a -t exec -vv "$APP" 2>&1 | grep -q "Notarized Developer ID" || fail "Gatekeeper refuse l'application"
spctl -a -t open --context context:primary-signature -vv "$DMG" 2>&1 | grep -q "Notarized Developer ID" \
  || fail "Gatekeeper refuse le DMG"
lipo -archs "$APP/Contents/MacOS/branch"

printf '\n\033[1;32mVersion %s prête :\033[0m\n  %s\n' "$VERSION" "$ROOT/$DMG"
VERSION_FILES=(package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock)
if [[ -n "$(git status --porcelain -- "${VERSION_FILES[@]}")" ]]; then
  echo "Le numéro de version a changé : pensez à le commiter."
fi
