// Original, filled geometric indicators derived from the logos' visual language.
// Each shape is assembled from teal and pale blocks with soft volume and joins.
export const notificationKinds = Object.freeze(["error", "warning", "info", "announcement", "success"]);
export const notificationPalette = Object.freeze({ primary: "#487a7a", edge: "#b6cece" });

function capsule(x1, y1, x2, y2, width, fill) {
  const length = Math.hypot(x2 - x1, y2 - y1);
  const nx = -(y2 - y1) / length * width / 2, ny = (x2 - x1) / length * width / 2;
  const point = (x, y) => `${Number(x.toFixed(3))} ${Number(y.toFixed(3))}`;
  const radius = width / 2;
  return `<path d="M${point(x1 - nx, y1 - ny)} ${point(x2 - nx, y2 - ny)}A${radius} ${radius} 0 0 1 ${point(x2 + nx, y2 + ny)}L${point(x1 + nx, y1 + ny)}A${radius} ${radius} 0 0 1 ${point(x1 - nx, y1 - ny)}Z" fill="${fill}"/>`;
}

const marks = {
  error: capsule(6.7, 6.7, 17.3, 17.3, 5.8, "PRIMARY") + capsule(17.3, 6.7, 6.7, 17.3, 5.8, "LIGHT"),
  warning: capsule(3, 20, 21, 20, 3.8, "PRIMARY") + capsule(12, 4, 21, 20, 3.8, "PRIMARY") + capsule(3, 20, 12, 4, 3.8, "LIGHT"),
  info: '<rect x="8.8" y="2.5" width="6.4" height="6.4" rx="2.6" fill="LIGHT"/><rect x="8.8" y="11" width="6.4" height="10.9" rx="2.8" fill="PRIMARY"/>',
  announcement: '<path d="M7.4 13.8h6.4l-5.8 7c-.7.8-1.6.4-1.4-.7Z" fill="LIGHT"/><rect x="2.5" y="3" width="19" height="14.8" rx="5.2" fill="PRIMARY"/>',
  success: capsule(10.1, 18, 19.1, 6, 5.6, "PRIMARY") + capsule(4.9, 12.2, 10.1, 18, 5.6, "LIGHT"),
};

export function notificationSymbol(kind) {
  if (!notificationKinds.includes(kind)) throw new Error(`Unknown notification kind: ${kind}`);
  const id = `notification-${kind}`;
  const { primary, edge } = notificationPalette;
  const definitions = `<defs><linearGradient id="${id}-primary" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#527f7f"/><stop offset=".48" stop-color="${primary}"/><stop offset="1" stop-color="#3c6868"/></linearGradient><linearGradient id="${id}-light" x1="0" y1="0" x2=".6" y2="1"><stop offset="0" stop-color="#c0d5d5"/><stop offset=".5" stop-color="${edge}"/><stop offset="1" stop-color="#9ebdbd"/></linearGradient><filter id="${id}-shadow" x="-30%" y="-25%" width="160%" height="165%" color-interpolation-filters="sRGB"><feDropShadow dx="0" dy=".65" stdDeviation=".5" flood-color="#183d3f" flood-opacity=".2"/></filter></defs>`;
  const blocks = marks[kind].replaceAll('fill="PRIMARY"', `fill="url(#${id}-primary)"`).replaceAll('fill="LIGHT"', `fill="url(#${id}-light)"`);
  return `${definitions}<g transform="translate(.65 .35) scale(.94)" filter="url(#${id}-shadow)" stroke="none">${blocks}</g>`;
}

export function notificationSvg(kind, product) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-label="${product} ${kind}"><g transform="scale(10.6666666667)">${notificationSymbol(kind)}</g></svg>\n`;
}
