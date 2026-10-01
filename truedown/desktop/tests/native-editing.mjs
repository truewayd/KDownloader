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
export async function acceptNativeEditing(evaluate, until, chooseMenu, { concurrentMenuSelection = false } = {}) {
  await evaluate(`${fixture}; return installNativeEditingAcceptance()`);
  let failure;
  try {
    for (const action of ['copy', 'paste', 'undo', 'redo', 'cut', 'paste', 'select-all']) {
      const started = evaluate(`return window.__nativeEditing.start('${action}')`);
      if (concurrentMenuSelection && action !== 'select-all') {
        // Win32's modal menu loop may hold the CDP reply until selection.
        // Join both bounded operations; never replay an editor action.
        const results = await Promise.allSettled([started, chooseMenu(action)]);
        const failed = results.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
        assert.equal(results[0].value, true);
      } else {
        assert.equal(await started, true);
        if (action !== 'select-all') await chooseMenu(action);
      }
      await until(() => evaluate(`return window.__nativeEditing.ready('${action}')`), 10000);
    }
    assert.equal(await evaluate(`return window.__TAURI__.core.invoke('edit_action',{action:'read-clipboard'}).then(()=>false,()=>true)`), true);
    assert.equal(await evaluate(`return window.__TAURI__.core.invoke('plugin:clipboard-manager|read_text').then(()=>false,()=>true)`), true);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try { await evaluate('return window.__nativeEditing.cleanup()'); }
    catch (error) { if (!failure) throw error; }
  }
}

export async function chooseWebDriverEditingMenu(command, evaluate, until, caller, action) {
  const popup = await until(async () => (await command('GET', '/window/handles')).find(handle => handle !== caller));
  try {
    await command('POST', '/window', { handle: popup });
    // Rendering buttons precedes native readiness. An early click is rejected
    // by the caller-bound IPC gate and must never be retried as an editor action.
    await until(() => evaluate('return window.__popupActive === true && [...document.querySelectorAll("[data-action]")].some(node => node.dataset.action === arguments[0])', [action]));
    try {
      await evaluate('document.querySelectorAll("[data-action]").forEach(node => { if (node.dataset.action === arguments[0]) node.click(); }); return true', [action]);
    } catch (error) {
      // WebKit may destroy the selected popup before execute/async replies.
      // Never replay the click. Require its disappearance below; the caller
      // separately verifies actual editor delivery, not just menu dismissal.
      if (!/\bno such window\b|^Could not parse script result$/.test(error?.message || '')) throw error;
    }
    await until(async () => !(await command('GET', '/window/handles')).includes(popup));
  } finally {
    await command('POST', '/window', { handle: caller });
  }
}
