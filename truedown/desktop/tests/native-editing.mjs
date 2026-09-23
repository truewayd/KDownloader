import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fixture = await readFile(new URL('./native-editing.js', import.meta.url), 'utf8');
export async function acceptNativeEditing(evaluate, until) {
  await evaluate(`${fixture}; return installNativeEditingAcceptance()`);
  try {
    for (const action of ['copy', 'paste', 'undo', 'redo', 'cut', 'paste', 'select-all']) {
      assert.equal(await evaluate(`return window.__nativeEditing.start('${action}')`), true);
      await until(() => evaluate(`return window.__nativeEditing.ready('${action}')`), 10000);
    }
    assert.equal(await evaluate(`return window.__TAURI__.core.invoke('edit_action',{action:'read-clipboard'}).then(()=>false,()=>true)`), true);
    assert.equal(await evaluate(`return window.__TAURI__.core.invoke('plugin:clipboard-manager|read_text').then(()=>false,()=>true)`), true);
  } finally {
    await evaluate('return window.__nativeEditing.cleanup()');
  }
}
