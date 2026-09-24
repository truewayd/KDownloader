// Loaded only by acceptance drivers. Never return editor or clipboard text.
function installNativeEditingAcceptance() {
  if (window.__nativeEditing) throw new Error('Editing fixture already installed');
  const original = window.invokeNative;
  const previousFocus = document.activeElement;
  const source = document.createElement('textarea');
  const target = document.createElement('textarea');
  const marker = `TrueDown native editing ${crypto.randomUUID()} \u4e2d\u6587`;
  source.value = `prefix ${marker} suffix`;
  source.setAttribute('aria-label', 'Acceptance copy source');
  target.setAttribute('aria-label', 'Acceptance paste target');
  source.style.cssText = 'position:fixed;left:40px;top:100px;width:240px;height:50px;z-index:100';
  target.style.cssText = 'position:fixed;left:40px;top:170px;width:240px;height:50px;z-index:100';
  document.body.append(source, target);
  let pending = false, completed = false, failed = false;
  let menuRequests = 0, menuError = "", menuResult;
  window.invokeNative = async (command, args) => {
    if (command === 'show_context_menu') {
      menuRequests++;
      try { return menuResult = await original(command, args); }
      catch (error) { menuError = String(error); throw error; }
    }
    if (command !== 'edit_action') return original(command, args);
    pending = true;
    try {
      // The real command must return unit, never a clipboard payload.
      const result = await original(command, args);
      completed = result === null || result === undefined;
      failed = !completed;
      return result;
    } catch (error) {
      failed = true;
      throw error;
    } finally { pending = false; }
  };
  window.__nativeEditing = {
    debug() { return { menuRequests, menuError, menuResult, visible: source.checkVisibility(), inert: Boolean(source.closest('[inert]')), pageMenus: document.querySelectorAll('[role="menu"]').length }; },
    async start(action) {
      if (pending) throw new Error('Overlapping editor actions');
      completed = false; failed = false;
      const input = action === 'copy' ? source : target;
      input.focus();
      if (action === 'copy') source.setSelectionRange(7, 7 + marker.length);
      if (action === 'cut') target.select();
      if (action === 'select-all') {
        target.setSelectionRange(1, 1);
        await window.invokeNative('edit_action', { action });
      } else {
        input.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, button: 2, clientX: 20, clientY: 20,
        }));
        // The native driver chooses the action in the separate popup WebView.
      }
      return true;
    },
    ready(action) {
      if (failed) throw new Error('Native editing command failed or returned data');
      if (pending || !completed) return false;
      if (action === 'copy') return document.activeElement === source;
      if (action === 'select-all') return target.selectionStart === 0 && target.selectionEnd === marker.length;
      return target.value === (action === 'undo' || action === 'cut' ? '' : marker);
    },
    cleanup() {
      window.invokeNative = original;
      source.remove(); target.remove(); previousFocus?.focus();
      delete window.__nativeEditing;
      return true;
    },
  };
  return true;
}
