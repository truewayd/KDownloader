import { readFile } from "node:fs/promises";

const root = new URL("../../truedown/web/", import.meta.url);
const html = await readFile(new URL("index.html", root), "utf8");
const scripts = [...html.matchAll(/<script src="\/([^"/]+\.js)" defer><\/script>/g)]
  .map((match) => match[1]).filter((name) => name !== "components.js");
export const dashboardSource = (await Promise.all(scripts.map((name) => readFile(new URL(name, root), "utf8"))))
  .join("\n").replace(/\r\n?/g, "\n");
