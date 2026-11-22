import { BACKEND_CONFIG_KEY } from './constants.js';
import { loadBackendConfig } from './config.js';
import { readLimitedResponseText } from './network.js';
import { createNotification } from './notifications.js';

export const LINK_MENU = 'kd-send-link';
export const SELECTION_MENU = 'kd-send-selection';
let menuQueue = Promise.resolve();
const message = key => chrome.i18n.getMessage(key);

// Chrome serializes this function into the clicked frame's isolated world.
export function selectedAnchorLinks(pageURL, expectedText) {
  const selection = window.getSelection();
  const normalize = text => text.trim().replace(/\s+/g, ' ');
  if (location.href !== pageURL || !selection || selection.isCollapsed ||
      normalize(selection.toString()) !== normalize(expectedText)) return [];
  const links = new Set();
  let visited = 0, size = 0;
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i);
    const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_ALL);
    const start = range.startContainer;
    walker.currentNode = start.childNodes[range.startOffset] || start;
    // A boundary after an element's last child starts at its next sibling.
    if (start.nodeType === Node.ELEMENT_NODE && range.startOffset === start.childNodes.length) {
      while (!walker.nextSibling() && walker.parentNode()) { /* ascend to the next sibling */ }
      if (walker.currentNode === range.commonAncestorContainer) continue;
    }
    do {
      const node = walker.currentNode;
      if (!range.intersectsNode(node)) break;
      if ((node === start && node.nodeType === Node.TEXT_NODE && range.startOffset === node.length) ||
          (node === range.endContainer && range.endOffset === 0)) continue;
      if (++visited > 20000) return null;
      const anchor = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest('a[href]');
      if (anchor && anchor.getClientRects().length && !anchor.closest('[hidden],[inert]')) {
        const href = anchor.href;
        if (typeof href === 'string' && href.length <= 8192 && /^https?:\/\//i.test(href) && !links.has(href)) {
          links.add(href);
          size += href.length;
          if (links.size > 256 || size > 1024 * 1024) return null;
        }
      }
    } while (walker.nextNode());
  }
  return [...links];
}

export function browserDownloadLinks(info, anchors = []) {
  if (String(info.selectionText || '').length > 1024 * 1024) throw new RangeError('Selection too large');
  const values = info.menuItemId === SELECTION_MENU
    ? [...anchors, ...(String(info.selectionText || '').match(/https?:\/\/[^\s<>"']+/gi) || [])]
    : [info.linkUrl || info.srcUrl];
  const links = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\x7f]/.test(value)) continue;
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
      links.add(url.href);
      if (links.size > 256) throw new RangeError('Too many links');
    } catch (error) { if (error instanceof RangeError) throw error; }
  }
  return [...links];
}

export function refreshBrowserMenus() {
  const run = menuQueue.then(async () => {
    const config = await loadBackendConfig();
    await chrome.contextMenus.removeAll();
    if (!menuEnabled(config)) return;
    for (const [id, title, contexts] of [
      [LINK_MENU, 'browserDownloadLink', ['link', 'image', 'audio', 'video']],
      [SELECTION_MENU, 'browserDownloadSelection', ['selection']],
    ]) {
      await new Promise((resolve, reject) => {
        chrome.contextMenus.create({ id, title: message(title), contexts }, () => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error('Cannot create browser download menu')); else resolve();
        });
      });
    }
  });
  menuQueue = run.catch(() => {});
  return run;
}

const menuEnabled = config => config.enabled && config.contextMenuEnabled && config.backendType === 'abdm';

export async function sendBrowserDownloads(info, tab) {
  let config = await loadBackendConfig();
  if (!menuEnabled(config)) return false;
  let links = browserDownloadLinks(info);
  const frameId = info.frameId ?? 0;
  const pageURL = frameId ? info.frameUrl : info.pageUrl;
  if (info.menuItemId === SELECTION_MENU && Number.isInteger(tab?.id) && /^https?:\/\//i.test(pageURL || '')) {
    let results;
    try {
      results = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [frameId] },
        func: selectedAnchorLinks, args: [pageURL, info.selectionText || ''] });
    } catch { /* Restricted frames still support URLs in the browser's selected text. */ }
    if (results?.[0]?.result === null) throw new RangeError('Selection too large');
    if (Array.isArray(results?.[0]?.result)) links = browserDownloadLinks(info, results[0].result);
    config = await loadBackendConfig();
    if (!menuEnabled(config)) return false;
  }
  if (!links.length) throw new Error('No supported links');
  const headers = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers['X-Api-Key'] = config.apiKey;
  const body = JSON.stringify({ items: links.map(link => ({ type: 'http', link })),
    options: { silentAdd: true, silentStart: true } });
  if (new TextEncoder().encode(body).length > 1024 * 1024) throw new RangeError('Download batch too large');
  const response = await fetch(`${config.protocol}://${config.host}:${config.port}/add`, {
    method: 'POST', headers, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000),
    body,
  });
  const result = await readLimitedResponseText(response, 4096, 'Browser download');
  if (!response.ok || result.trim() !== 'OK') throw new Error('Backend did not accept downloads');
  return true;
}

export function registerBrowserIntegration() {
  const refresh = () => { refreshBrowserMenus().catch(() => console.warn('[Background] browser menu update failed')); };
  chrome.runtime.onInstalled.addListener(refresh);
  chrome.runtime.onStartup.addListener(refresh);
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'sync' && changes[BACKEND_CONFIG_KEY]) refresh(); });
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (![LINK_MENU, SELECTION_MENU].includes(info.menuItemId)) return;
    sendBrowserDownloads(info, tab).then(accepted => {
      if (accepted) return createNotification('browser-download', { kind: 'success', title: message('browserDownloadAccepted'), message: message('browserDownloadAcceptedHelp') });
    }).catch(() => createNotification('browser-download', { kind: 'error', title: message('browserDownloadFailed'), message: message('browserDownloadFailedHelp') })).catch(() => {});
  });
  refresh();
}
