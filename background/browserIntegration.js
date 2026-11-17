import { BACKEND_CONFIG_KEY } from './constants.js';
import { loadBackendConfig } from './config.js';
import { readLimitedResponseText } from './network.js';
import { createNotification } from './notifications.js';

export const LINK_MENU = 'kd-send-link';
export const SELECTION_MENU = 'kd-send-selection';
let menuQueue = Promise.resolve();
const message = key => chrome.i18n.getMessage(key);

export function browserDownloadLinks(info) {
  if (String(info.selectionText || '').length > 1024 * 1024) throw new RangeError('Selection too large');
  const values = info.menuItemId === SELECTION_MENU
    ? String(info.selectionText || '').match(/https?:\/\/[^\s<>"']+/gi) || []
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
    if (!config.enabled || !config.contextMenuEnabled || config.backendType !== 'abdm') return;
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

export async function sendBrowserDownloads(info) {
  const config = await loadBackendConfig();
  if (!config.enabled || !config.contextMenuEnabled || config.backendType !== 'abdm') return false;
  const links = browserDownloadLinks(info);
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
  chrome.contextMenus.onClicked.addListener(info => {
    if (![LINK_MENU, SELECTION_MENU].includes(info.menuItemId)) return;
    sendBrowserDownloads(info).then(accepted => {
      if (accepted) return createNotification('browser-download', { kind: 'success', title: message('browserDownloadAccepted'), message: message('browserDownloadAcceptedHelp') });
    }).catch(() => createNotification('browser-download', { kind: 'error', title: message('browserDownloadFailed'), message: message('browserDownloadFailedHelp') })).catch(() => {});
  });
  refresh();
}
