import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

export const menuLabels = { 'group-edit': '调整此分组', undo: '撤销', redo: '重做', cut: '剪切', copy: '复制', paste: '粘贴', 'select-all': '全选' };

// Read the production geometry; acceptance still clicks the real popup and
// verifies the resulting editor action rather than invoking it directly.
const nativeStyle = await readFile(new URL('../../native-menu/src/style.rs', import.meta.url), 'utf8');
const metric = name => {
  const match = nativeStyle.match(new RegExp(`pub const ${name}: f32 = ([0-9.]+);`));
  if (!match || !Number.isFinite(Number(match[1]))) throw new Error(`Missing native menu metric: ${name}`);
  return Number(match[1]);
};
export function nativeMenuSelection(actions, action) {
  const index = actions.indexOf(action);
  if (index < 0 || !menuLabels[action]) throw new Error(`Native menu did not offer: ${action}`);
  const separators = actions.slice(0, index + 1).filter((entry, row) => row > 0 && ['remove', 'clear-done', 'tray-exit'].includes(entry)).length;
  return { label: menuLabels[action], itemCount: actions.length,
    itemOffset: metric('SHADOW_PAD') + metric('ITEM_INSET') + (index + 0.5) * metric('ROW_HEIGHT') + separators * 9 };
}

// Start before showing the fixture so helper startup cannot dismiss its menu.
export async function nativeMenuDriver() {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./windows-popup-capture.ps1', import.meta.url)), '-Server'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout });
  let pending;
  const receive = () => new Promise((resolve, reject) => {
    if (pending) return reject(new Error('Native menu driver requires serial requests'));
    const timer = setTimeout(() => { pending = null; child.kill(); reject(new Error('Native menu driver timed out')); }, 15000);
    pending = { resolve: value => { clearTimeout(timer); pending = null; resolve(value); }, reject: error => { clearTimeout(timer); pending = null; reject(error); } };
  });
  lines.on('line', line => pending?.resolve(line));
  child.on('error', error => pending?.reject(error));
  child.on('exit', () => pending?.reject(new Error('Native menu driver exited')));
  const close = () => { child.stdin.end(); lines.close(); child.kill(); };
  try {
    if (await receive() !== 'ready') throw new Error('Native menu driver not ready');
  } catch (error) { close(); throw error; }
  return {
    async request(processId, nativeMenu = {}) {
      const response = receive();
      child.stdin.write(JSON.stringify({ processId, nativeMenu }) + '\n');
      const result = JSON.parse(await response);
      if (result.error) throw new Error(result.error);
      return result;
    },
    close,
  };
}
