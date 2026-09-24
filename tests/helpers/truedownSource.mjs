import { readFile } from "node:fs/promises";

const root = new URL("../../truedown/web/", import.meta.url);
const html = await readFile(new URL("index.html", root), "utf8");
// Native role initialization intentionally loads before the first paint.
// Include both blocking and deferred classic scripts in source-contract checks.
const scripts = [...html.matchAll(/<script src="\/([^"/]+\.js)"(?: defer)?><\/script>/g)]
  .map((match) => match[1]).filter((name) => name !== "components.js");
export const dashboardSource = (await Promise.all(scripts.map((name) => readFile(new URL(name, root), "utf8"))))
  .join("\n").replace(/\r\n?/g, "\n");
