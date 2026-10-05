import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const root = new URL("../", import.meta.url);
const require = createRequire(new URL("truedown/desktop/package.json", root));
const { renderer, rendererVersion } = JSON.parse(await readFile(new URL("truedown/tools/icon-sources.json", root), "utf8"));
if (require(`${renderer}/package.json`).version !== rendererVersion) {
  throw new Error("Install the pinned renderer with npm ci in truedown/desktop");
}
const { Resvg } = require(renderer);
const check = process.argv.includes("--check");
if (process.argv.slice(2).some(value => value !== "--check")) {
  throw new Error("Usage: generate-extension-icons.mjs [--check]");
}

const source = await readFile(new URL("icons/kdownloader-logo.svg", root), "utf8");
if (!source.includes('viewBox="0 0 1024 1024"')) throw new Error("Unexpected extension logo viewBox");
// Keep the inline logo's spacing, but give browser icons a centered viewport
// with roughly 32 source pixels above/below the silhouette. Preserve its ratio.
const svg = source.replace('viewBox="0 0 1024 1024"', 'viewBox="80 84 864 864"');
for (const size of [16, 20, 24, 32, 48, 128]) {
  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
    font: { loadSystemFonts: false },
  }).render().asPng();
  const filename = new URL(`icons/icon${size}.png`, root);
  let current;
  try {
    current = await readFile(filename);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!current?.equals(png)) {
    if (check) throw new Error(`Stale extension icon: icon${size}.png. Run npm run icons:sync.`);
    await writeFile(filename, png);
  }
}
console.log(`${check ? "Verified" : "Generated"} 6 extension icons from the canonical SVG`);
