import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = relative => readFile(path.join(repository, relative), "utf8");
const symbols = source => new Map([...source.matchAll(/<symbol id="icon-([a-z-]+)" viewBox="0 0 24 24">([^]*?)<\/symbol>/g)].map(match => [match[1], match[2]]));

test("extension and desktop icon consumers resolve the same licensed SVG shapes", async () => {
  const extension = await read("shared/icons.svg");
  const desktop = await read("truedown/web/icons.svg");
  const extensionSymbols = symbols(extension), desktopSymbols = symbols(desktop);
  assert.deepEqual([...extensionSymbols.keys()].sort(), ["clock", "cloud", "database", "download", "filter", "notification-announcement", "notification-error", "notification-info", "notification-success", "notification-warning", "refresh", "save", "search", "server", "upload"]);
  for (const [id, body] of extensionSymbols) assert.equal(desktopSymbols.get(id), body, `Icon ${id} must be identical across products`);
  for (const source of [extension, desktop]) {
    assert.match(source, /Copyright \(c\) 2026 Lucide Icons and Contributors/);
    assert.match(source, /Copyright \(c\) 2013-present Cole Bemis/);
    assert.doesNotMatch(source, /<(?:script|image|foreignObject|use)\b|\bon[a-z]+=/i);
  }
  for (const directory of ["popup", "truedown/web"]) {
    for (const name of await readdir(path.join(repository, directory))) {
      if (!/\.(html|js)$/.test(name)) continue;
      const source = await read(`${directory}/${name}`);
      const available = directory === "popup" ? extensionSymbols : desktopSymbols;
      for (const match of source.matchAll(/icons\.svg#icon-([a-z][a-z-]*)/g)) assert.ok(available.has(match[1]), `${directory}/${name} refers to missing ${match[1]}`);
      if (directory === "truedown/web") {
        for (const match of source.matchAll(/iconMarkup\("([a-z-]+)"\)/g)) assert.ok(available.has(match[1]), `${name} refers to missing ${match[1]}`);
      }
    }
  }
});

test("icon generation dependencies and notices identify the exact pinned source", async () => {
  const manifest = JSON.parse(await read("truedown/tools/icon-sources.json"));
  const pkg = JSON.parse(await read("truedown/desktop/package.json"));
  const lock = JSON.parse(await read("truedown/desktop/package-lock.json"));
  for (const [name, version] of [[manifest.package, manifest.version], [manifest.renderer, manifest.rendererVersion]]) {
    assert.match(version, /^\d+\.\d+\.\d+$/);
    assert.equal(pkg.devDependencies[name], version);
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
    assert.match(lock.packages[`node_modules/${name}`].integrity, /^sha512-/);
  }
  const notices = await read("truedown/THIRD_PARTY_NOTICES.md");
  assert.ok(notices.includes(`${manifest.package}@${manifest.version}`));
  assert.match(notices, /Copyright \(c\) 2013-present Cole Bemis/);
});

test("native notification icon reuses the canonical 256px brand raster", async () => {
  const notification = await readFile(path.join(repository, "truedown/desktop/icons/notification.png"));
  assert.equal(notification.readUInt32BE(16), 256);
  assert.equal(notification.readUInt32BE(20), 256);
  const ico = await readFile(path.join(repository, "truedown/windows/truedown.ico"));
  const entry = Array.from({ length: ico.readUInt16LE(4) }, (_, index) => 6 + index * 16)
    .find(offset => ico[offset] === 0 && ico[offset + 1] === 0);
  assert.ok(entry);
  const start = ico.readUInt32LE(entry + 12);
  assert.deepEqual(notification, ico.subarray(start, start + ico.readUInt32LE(entry + 8)));
});

test("notification variants share a palette and distinct business marks across both products", async () => {
  const kinds = ["error", "warning", "info", "announcement", "success"];
  const extension = symbols(await read("shared/icons.svg"));
  for (const directory of ["icons/notifications", "truedown/desktop/icons/notifications"]) {
    const images = [];
    for (const kind of kinds) {
      const svg = await read(`${directory}/${kind}.svg`);
      const png = await readFile(path.join(repository, directory, `${kind}.png`));
      assert.match(svg, /viewBox="0 0 256 256"/);
      assert.ok(svg.includes(extension.get(`notification-${kind}`)), `${kind} must reuse the shared UI mark`);
      for (const color of ["#487a7a", "#b6cece", "#9ebdbd"]) assert.ok(svg.includes(color));
      assert.match(svg, /<linearGradient/);
      assert.match(svg, /<feDropShadow/);
      assert.doesNotMatch(svg, /stroke-width|appLogoOverride|<image|<circle/);
      assert.equal(png.readUInt32BE(16), directory.startsWith("icons/") ? 128 : 256);
      images.push(png.toString("base64"));
    }
    assert.equal(new Set(images).size, kinds.length, "each business purpose needs distinct rendered artwork");
  }
});

test("native menu actions share web icon shapes and distinguish adjacent operations", async () => {
  const desktop = symbols(await read("truedown/web/icons.svg"));
  const popup = await read("truedown/web/context-menu-window.js");
  const windows = await read("truedown/desktop/src/context_menus/windows_style.rs");
  const native = new Map();
  for (const match of windows.matchAll(/((?:"[\w-]+"\s*\|\s*)*"[\w-]+")\s*=> bytes!\("([\w-]+)"\)/g)) {
    for (const action of match[1].matchAll(/"([\w-]+)"/g)) native.set(action[1], match[2]);
  }
  const actions = new Map([...popup.matchAll(/(?:"([\w-]+)"|(\w+)):\s*\["[^"]+",\s*"([\w-]+)"/g)]
    .map(match => [match[1] || match[2], match[3]]));
  assert.ok(actions.size >= 20, "all popup actions must be checked");
  for (const [action, icon] of actions) {
    assert.ok(desktop.has(icon), `${action} must resolve a generated SVG`);
    assert.equal(native.get(action), icon, `${action} must agree across desktop platforms`);
    for (const size of [16, 32]) {
      const png = await readFile(path.join(repository, `truedown/desktop/icons/menu/${icon}-${size}.png`));
      assert.equal(png.readUInt32BE(16), size, `${action} must have a native raster at ${size}px`);
    }
  }
  for (const menu of [["new-task", "group-add", "group-manage"], ["group-edit", "group-add", "group-manage"], ["tray-new", "tray-open", "settings", "tray-exit"]]) {
    const shapes = menu.map(action => desktop.get(native.get(action)));
    assert.ok(shapes.every(Boolean));
    assert.equal(new Set(shapes).size, menu.length, `${menu.join(", ")} must use distinct shapes`);
  }
});
