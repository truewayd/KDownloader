import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { notificationKinds, notificationPalette, notificationSymbol } from "./notification-icons.mjs";

const output = process.argv[2];
if (!output) throw new Error("Pass a governed run directory for the icon preview");
const root = new URL("../", import.meta.url);
const require = createRequire(new URL("truedown/desktop/package.json", root));
const { renderer, rendererVersion } = JSON.parse(await readFile(new URL("truedown/tools/icon-sources.json", root), "utf8"));
if (require(`${renderer}/package.json`).version !== rendererVersion) throw new Error("Use the pinned renderer");
const { Resvg } = require(renderer);
const labels = { error: "错误", warning: "警告", info: "信息", announcement: "播报 / 气泡", success: "成功" };
let body = '<rect width="1180" height="688" fill="#e9efef"/><text x="32" y="43" font-size="25" font-weight="600" fill="#294646">抽象色块指示器</text><text x="32" y="73" font-size="15" fill="#487a7a">沿用原始 Logo 的圆润色块、青灰渐变与柔和阴影</text>';
for (const [column, file] of ["icons/icon128.png", "truedown/desktop/icons/notification.png"].entries()) {
  const png = await readFile(new URL(file, root));
  body += `<image x="${1000 + column * 70}" y="17" width="60" height="60" href="data:image/png;base64,${png.toString("base64")}"/>`;
}
for (const [row, product, directory] of [[0, "浅色背景", "truedown/desktop/icons/notifications/"], [1, "深色背景", "truedown/desktop/icons/notifications/"]]) {
  const top = 96 + row * 190;
  const foreground = row ? "#edf5f5" : "#294646";
  body += `<rect x="24" y="${top}" width="1132" height="176" rx="16" fill="${row ? "#202a2a" : "#fbfdfd"}"/><text x="46" y="${top + 95}" font-size="19" font-weight="600" fill="${foreground}">${product}</text>`;
  for (const [column, kind] of notificationKinds.entries()) {
    const png = await readFile(new URL(`${directory}${kind}.png`, root));
    const x = 228 + column * 178;
    body += `<image x="${x}" y="${top + 10}" width="120" height="120" href="data:image/png;base64,${png.toString("base64")}"/><text x="${x + 60}" y="${top + 155}" text-anchor="middle" font-size="16" fill="${foreground}">${labels[kind]}</text>`;
  }
}
for (const [row, size] of [18, 24, 32].entries()) {
  const top = 496 + row * 48;
  body += `<text x="46" y="${top + 24}" font-size="17" fill="#294646">实际尺寸 ${size}px</text>`;
  for (const [column, kind] of notificationKinds.entries()) {
    const x = 288 + column * 178;
    body += `<svg x="${x - size / 2}" y="${top + 16 - size / 2}" width="${size}" height="${size}" viewBox="0 0 24 24">${notificationSymbol(kind)}</svg>`;
    if (row === 2) body += `<text x="${x}" y="${top + 64}" text-anchor="middle" font-size="14" fill="${notificationPalette.primary}">${kind}</text>`;
  }
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1180 688" font-family="Microsoft YaHei, sans-serif">${body}</svg>`;
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "notification-family.svg"), svg);
await writeFile(path.join(output, "notification-family.png"), new Resvg(svg).render().asPng());
console.log(path.resolve(output, "notification-family.png"));
