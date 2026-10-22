import { test } from "node:test";
import assert from "node:assert/strict";
import { clampFontSize, resolveTheme, loadSettings, DEFAULT_SETTINGS } from "./settings.js";

test("taille de police bornée", () => {
  assert.equal(clampFontSize(13), 13);
  assert.equal(clampFontSize(2), 9);
  assert.equal(clampFontSize(100), 28);
  assert.equal(clampFontSize("14.6"), 15);
  assert.equal(clampFontSize("abc"), 13);
});

test("thème système suivi", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("inconnu", false), "dark");
});

test("réglages par défaut sans stockage disponible", () => {
  // localStorage n'existe pas sous Node : les valeurs par défaut s'appliquent.
  assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);
});
