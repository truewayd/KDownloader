import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const loadMessages = async (locale) => JSON.parse(await readFile(path.join(root, "_locales", locale, "messages.json"), "utf8"));

async function sourceFiles(dir = root) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if ([".git", "_locales"].includes(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(fullPath));
    else if (/\.(?:html|js|json)$/.test(entry.name)) files.push(fullPath);
  }
  return files;
}

test("locale catalogs have identical non-empty keys", async () => {
  const [en, zh] = await Promise.all([loadMessages("en"), loadMessages("zh_CN")]);
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const [key, value] of Object.entries(zh)) assert.ok(value.message?.trim(), `${key} is empty`);
});

test("all declared localization references exist", async () => {
  const messages = await loadMessages("en");
  const references = new Set();
  for (const file of await sourceFiles()) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/data-i18n(?:-placeholder|-title|-aria-label)?=["']([^"']+)["']/g)) references.add(match[1]);
    for (const match of source.matchAll(/KDI18n\.get\(["']([^"']+)["']/g)) references.add(match[1]);
    for (const match of source.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) references.add(match[1]);
  }
  for (const key of references) assert.ok(messages[key], `Missing locale key: ${key}`);
});
