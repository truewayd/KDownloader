import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const menuLabels = { 'group-edit': '调整此分组', undo: '撤销', redo: '重做', cut: '剪切', copy: '复制', paste: '粘贴', 'select-all': '全选' };

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
