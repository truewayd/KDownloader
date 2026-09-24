import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fixture = await readFile(new URL('./native-editing.js', import.meta.url), 'utf8');
export async function nativeEditingDocumentReady(evaluate) {
  try {
    return await evaluate("return Boolean(window.__TAURI__ && document.querySelector('#task-count') && document.hasFocus())");
  } catch (error) {
    // Initial WebView navigation may replace the document after CDP attaches.
    // Only this read-only probe retries, under the caller's original deadline.
    if (/\bExecution context was destroyed\b|\bCannot find context with specified id\b/.test(error?.message || '')) return false;
    throw error;
  }
}
export async function acceptNativeEditing(evaluate, until, chooseMenu) {
  await evaluate(`${fixture}; return installNativeEditingAcceptance()`);
  try {
    for (const action of ['copy', 'paste', 'undo', 'redo', 'cut', 'paste', 'select-all']) {
      assert.equal(await evaluate(`return window.__nativeEditing.start('${action}')`), true);
      if (action !== 'select-all') await chooseMenu(action);
      await until(() => evaluate(`return window.__nativeEditing.ready('${action}')`), 10000);
    }
    assert.equal(await evaluate(`return window.__TAURI__.core.invoke('edit_action',{action:'read-clipboard'}).then(()=>false,()=>true)`), true);
    assert.equal(await evaluate(`return window.__TAURI__.core.invoke('plugin:clipboard-manager|read_text').then(()=>false,()=>true)`), true);
  } finally {
    await evaluate('return window.__nativeEditing.cleanup()');
  }
}
