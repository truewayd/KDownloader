// background/download.js - download orchestration (local chrome.downloads and backend forwarding)
import { CONFIG, API, PAW } from './constants.js';
import UTIL from './util.js';
import { loadBackendConfig } from './config.js';
import { handleAPIRequest, getCookies } from './network.js';

// Unified in-memory task queue singleton to manage all outgoing dispatches to backends
class TaskQueue {
  constructor(concurrency = CONFIG.MAX_CONCURRENT_DOWNLOADS) {
    this.queue = [];
    this.waiters = [];
    this.concurrency = concurrency;
    this.activeWorkers = 0;
    this.started = false;
    this.totalDispatched = 0;
    this._startWorkers();
  }

  _startWorkers() {
    if (this.started) return;
    this.started = true;
    for (let i = 0; i < this.concurrency; i++) this._workerLoop(i);
  }

  _notifyNew() {
    while (this.waiters.length && this.queue.length) {
      const w = this.waiters.shift();
      w();
    }
  }

  async _waitForItem() {
    if (this.queue.length) return;
    await new Promise(resolve => this.waiters.push(resolve));
  }

  // Enqueue an array of file tasks. Returns a Promise resolving to results array for those tasks.
  enqueueTasks(batchTasks, options = {}) {
    return new Promise((resolve) => {
      const id = Date.now() + Math.random();
      const meta = { id, remaining: batchTasks.length, results: [], resolve, total: batchTasks.length };
      for (const t of batchTasks) {
        this.queue.push({ meta, task: t, options });
      }
      this._notifyNew();
    });
  }

  async _workerLoop(workerIndex) {
    // Each worker keeps its own adaptive delay state
    let currentDelay = CONFIG.TASK_INTERVAL_INITIAL || CONFIG.TASK_INTERVAL;
    const factor = CONFIG.TASK_INTERVAL_BACKOFF_FACTOR || 1.5;
    const linearInc = CONFIG.TASK_INTERVAL_LINEAR_INC || 50;
    const maxDelay = CONFIG.TASK_INTERVAL_MAX || 5000;

    while (true) {
      if (!this.queue.length) await this._waitForItem();
      const item = this.queue.shift();
      if (!item) continue;

      const { meta, task, options } = item;
      const { endpoint, cookieString, origin, service, userId, postId, headers, perFileRetry = 0, sendProgress } = options;

      // Wait the adaptive delay before sending to avoid spikes
      if (currentDelay > 0) await new Promise(r => setTimeout(r, currentDelay));

      // Build payload
      const filePayload = {
        downloadSource: {
          link: task.url,
          headers: {
            Cookie: cookieString,
            Referer: `${origin}/${service}/user/${userId}/post/${postId}`,
            'User-Agent': headers['User-Agent'] || 'Mozilla/5.0',
            Origin: `chrome-extension://${chrome.runtime.id}`,
            Accept: headers['Accept'] || 'text/css',
            'Accept-Language': headers['Accept-Language'] || 'zh-CN,zh;q=0.9'
          }
        },
        name: task.fileName,
        queueId: 0,
      };

      // Attempt with retries (simple per-file retry with incremental backoff)
      let attempts = 0;
      let success = false;
      let lastError = null;
      while (attempts <= perFileRetry && !success) {
        try {
          attempts++;
          await fetch(endpoint, { method: 'POST', body: JSON.stringify(filePayload), mode: 'no-cors', credentials: 'include' });
          success = true;
        } catch (e) {
          lastError = e;
          if (attempts > perFileRetry) break;
          // simple incremental wait on retry
          await new Promise(r => setTimeout(r, 1000 * attempts));
        }
      }

      // Update adaptive delay: reset on success, backoff on failure
      if (success) {
        currentDelay = CONFIG.TASK_INTERVAL_INITIAL || CONFIG.TASK_INTERVAL;
      } else {
        currentDelay = Math.min(maxDelay, Math.ceil(currentDelay * factor + linearInc));
      }

      // Record result
      const record = success ? { task, success: true, attempts } : { task, success: false, attempts, error: lastError && lastError.message ? lastError.message : String(lastError) };
      meta.results.push(record);
      meta.remaining--;

      // Global dispatched counter
      this.totalDispatched++;
      try { if (typeof sendProgress === 'function') sendProgress(this.totalDispatched, meta && meta.total ? meta.total : 0); } catch (e) { }

      // Resolve when all items for this batch are done
      if (meta.remaining <= 0) {
        try { meta.resolve(meta.results); } catch (e) { }
      }
    }
  }
}

// Single global queue instance (will use default concurrency, can be adjusted later)
const GLOBAL_TASK_QUEUE = new TaskQueue();

export async function runSequentialDownloads(tasks, onProgress) {
  const results = [];
  let successCount = 0;
  const total = tasks.length;
  let processed = 0;
  for (const task of tasks) {
    try {
      await new Promise(r => setTimeout(r, CONFIG.TASK_INTERVAL));
      const id = await new Promise((resolve, reject) => {
        try {
          chrome.downloads.download({ url: task.url, filename: task.fileName, saveAs: false, conflictAction: 'uniquify' }, (downloadId) => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            if (!downloadId) return reject(new Error('No download id'));
            resolve(downloadId);
          });
        } catch (err) { reject(err); }
      });
      successCount++;
      results.push({ task, success: true, downloadId: id });
    } catch (e) {
      results.push({ task, success: false, error: e && e.message ? e.message : String(e) });
    }
    processed++;
    try { if (typeof onProgress === 'function') onProgress({ processed, total, successCount }); } catch (e) { }
  }
  return { successCount, results };
}

// Parse downloadable URLs from a pawchive post HTML page.
// Returns { tasks: [{url, fileName, type}], externalLinks: [] }
function parsePawchiveHtml(html, title) {
  const tasks = [];
  // Deduplicate by file path (before '?') so video <source src> and matching
  // <a class="post__attachment-link"> pointing to the same file aren't doubled.
  const seenPath = new Set();

  const pushIfNew = (rawUrl, fileName, type) => {
    if (!rawUrl) return;
    const url = rawUrl.replace(/&amp;/g, '&');
    let filePath;
    try { filePath = new URL(url).pathname; } catch (_) { filePath = url.split('?')[0]; }
    if (seenPath.has(filePath)) return;
    seenPath.add(filePath);
    tasks.push({ url, fileName, type });
  };

  // Prefer download="" attr, then ?f= query param, then fallback string.
  const extractFileName = (rawUrl, downloadAttr, fallback) => {
    if (downloadAttr) return UTIL.sanitizeFileName(decodeURIComponent(downloadAttr));
    try {
      const fParam = new URL(rawUrl.replace(/&amp;/g, '&')).searchParams.get('f');
      if (fParam) return UTIL.sanitizeFileName(decodeURIComponent(fParam));
    } catch (_) {}
    return UTIL.sanitizeFileName(fallback);
  };

  let m;

  // 1. Video source URLs: <source src="https://file.pawchive.st/...">
  const videoSrcRe = /<source\s[^>]*\bsrc="(https:\/\/file\.pawchive\.st\/[^"]+)"/gi;
  while ((m = videoSrcRe.exec(html)) !== null) {
    const rawUrl = m[1];
    pushIfNew(rawUrl, extractFileName(rawUrl, null, `${title}_video.mp4`), 'video');
  }

  // 2. Attachment links and fileThumb links: scan all <a> tags once, classify by class.
  // This is attribute-order-independent so href/class can appear in any order.
  const aTagRe = /<a\s([^>]*)>/gi;
  while ((m = aTagRe.exec(html)) !== null) {
    const attrs = m[1];
    const hrefM = attrs.match(/\bhref="([^"]+)"/);
    if (!hrefM) continue;
    const rawUrl = hrefM[1];
    const dlM = attrs.match(/\bdownload="([^"]+)"/);
    const dlAttr = dlM ? dlM[1] : null;

    if (/\bpost__attachment-link\b/.test(attrs)) {
      pushIfNew(rawUrl, extractFileName(rawUrl, dlAttr, `${title}_attachment`), 'attachment');
    } else if (/\bfileThumb\b/.test(attrs)) {
      // href is the original full-resolution file; img src inside is the thumbnail.
      const url = rawUrl.replace(/&amp;/g, '&');
      let ext = '';
      try { ext = UTIL.getFileExtension(new URL(url).pathname) || ''; } catch (_) {}
      pushIfNew(rawUrl, extractFileName(rawUrl, dlAttr, `${title}_file${ext}`), 'file');
    }
  }

  // 3. External links from post__content
  const contentMatch = html.match(/<div class="post__content">([\s\S]*?)<\/div>/i);
  const contentHtml = contentMatch ? contentMatch[1] : '';
  const externalLinks = UTIL.extractExternalLinks(contentHtml.replace(/<[^>]+>/g, ' '));

  return { tasks, externalLinks };
}

// Download a single pawchive post by fetching its HTML page and parsing assets.
export async function startPawchiveDownload(service, userId, postId, senderTabId) {
  const postUrl = `${PAW.ORIGIN}/${service}/user/${userId}/post/${postId}`;
  const cookies = await getCookies(PAW.HOST);
  // MV3 service workers with host_permissions bypass CORS for same-origin fetches.
  // Do NOT pass Cookie manually — let credentials:'include' attach cookies automatically,
  // and do NOT set mode:'cors' which would require server CORS headers.
  const headers = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Cache-Control': 'no-cache',
  };

  let html;
  try {
    const resp = await fetch(postUrl, { method: 'GET', headers, credentials: 'include' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    html = await resp.text();
  } catch (e) {
    throw new Error(`Failed to fetch pawchive post page: ${e.message}`);
  }

  // Extract title from <h1 class="post__title">
  const titleMatch = html.match(/<h1[^>]*class="post__title"[^>]*>[\s\S]*?<span>([^<]+)<\/span>/i);
  const rawTitle = titleMatch ? titleMatch[1].trim() : `${service}_${userId}_${postId}`;
  const title = UTIL.sanitizeFileName(rawTitle);

  const { tasks, externalLinks } = parsePawchiveHtml(html, title);

  if (tasks.length === 0) {
    return { success: true, successCount: 0, results: [], externalLinks, message: 'No downloadable files found', noFiles: true };
  }

  if (externalLinks.length > 0) {
    console.log(`[Pawchive] External links found in post ${postId}:`, externalLinks);
  }

  const backendCfg = await loadBackendConfig();

  if (backendCfg.enabled) {
    const endpoint = `${backendCfg.protocol}://${backendCfg.host}:${backendCfg.port}/start-headless-download`;
    const perFileRetry = Math.min(10, Math.max(0, Number(backendCfg.retryCount) || 0));
    const concurrency = Math.max(1, Math.min(6, Math.floor(backendCfg.concurrency || CONFIG.MAX_CONCURRENT_DOWNLOADS)));
    const perPostFileLimit = Number.isFinite(backendCfg.perPostFileLimit) ? backendCfg.perPostFileLimit : 200;

    const sendProgress = (sent, total) => {
      const payload = { action: 'downloadProgress', service, userId, postId, progress: Math.round(100 * (sent / Math.max(1, total))), sentCount: sent, totalCount: total };
      try { if (typeof senderTabId === 'number') chrome.tabs.sendMessage(senderTabId, payload, () => { void chrome.runtime.lastError; }); else chrome.runtime.sendMessage(payload, () => { void chrome.runtime.lastError; }); } catch (e) { }
    };

    GLOBAL_TASK_QUEUE.concurrency = concurrency;
    GLOBAL_TASK_QUEUE._startWorkers();

    const batches = [];
    for (let i = 0; i < tasks.length; i += perPostFileLimit) batches.push(tasks.slice(i, i + perPostFileLimit));

    const allFileResults = [];
    for (let b = 0; b < batches.length; b++) {
      const results = await GLOBAL_TASK_QUEUE.enqueueTasks(batches[b], {
        endpoint, cookieString: cookies, origin: PAW.ORIGIN, service, userId, postId,
        headers, perFileRetry, sendProgress, totalCount: tasks.length,
      });
      allFileResults.push(...results);
      if (b < batches.length - 1) await new Promise(r => setTimeout(r, 250));
    }

    const anySuccess = allFileResults.some(fr => fr.success);
    if (anySuccess) return { success: true, backend: true, results: allFileResults, externalLinks };
  }

  // Local chrome.downloads fallback
  const progressCallback = ({ processed, total, successCount }) => {
    const payload = { action: 'downloadProgress', service, userId, postId, progress: Math.round(100 * (processed / Math.max(1, total))), sentCount: successCount, totalCount: total };
    try { if (typeof senderTabId === 'number') chrome.tabs.sendMessage(senderTabId, payload, () => { void chrome.runtime.lastError; }); else chrome.runtime.sendMessage(payload, () => { void chrome.runtime.lastError; }); } catch (e) { }
  };

  const { successCount, results } = await runSequentialDownloads(tasks, progressCallback);
  return { success: true, successCount, results, externalLinks };
}

export async function startFullDownload(service, userId, postId, path, senderUrl, senderTabId) {
  // 1. Determine origin using centralized API config
  let origin = API.DEFAULT_ORIGIN;
  try {
    if (senderUrl) {
      const su = new URL(senderUrl);
      const host = su.hostname.toLowerCase();
      if (host.includes(API.HOSTS[0])) origin = `https://${API.HOSTS[0]}`;
      else if (host.includes(API.HOSTS[1])) origin = `https://${API.HOSTS[1]}`;
    } else if (path && path.includes('coomer')) {
      origin = `https://${API.HOSTS[0]}`;
    }
  } catch (e) { }

  // 2. API
  const apiUrl = `${origin}${API.API_PREFIX}/${service}/user/${userId}/post/${postId}`;
  const domain = new URL(origin).hostname;
  const cookies = await getCookies(domain);
  const headers = {
    'Accept': 'text/css',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Cache-Control': 'no-cache',
    'DNT': '1',
    'Pragma': 'no-cache',
    'Referer': `${origin}/${service}/user/${userId}/post/${postId}`,
    'User-Agent': 'Mozilla/5.0',
    'Cookie': cookies
  };

  const postData = await handleAPIRequest(apiUrl, headers);
  if (!postData || !postData.post) throw new Error('Invalid API response');

  const title = UTIL.sanitizeFileName(postData.post.title || 'Untitled');
  const tasks = UTIL.buildDownloadTasks(postData, title, origin);
  const externalLinks = UTIL.extractExternalLinks(postData.post && postData.post.content ? postData.post.content : '');

  if (tasks.length === 0) {
    return { success: true, successCount: 0, results: [], externalLinks, message: 'No downloadable files found', noFiles: true };
  }

  const cookieString = cookies;
  const backendCfg = await loadBackendConfig();

  // 3. Backend forwarding (with centralized queue/batching and adaptive throttle)
  if (backendCfg.enabled) {
    const endpoint = `${backendCfg.protocol}://${backendCfg.host}:${backendCfg.port}/start-headless-download`;
    const perFileRetry = Math.min(10, Math.max(0, Number(backendCfg.retryCount) || 0));
    const concurrency = Math.max(1, Math.min(6, Math.floor(backendCfg.concurrency || CONFIG.MAX_CONCURRENT_DOWNLOADS)));
    const perPostFileLimit = Number.isFinite(backendCfg.perPostFileLimit) ? backendCfg.perPostFileLimit : 200;

    // Respect per-post file limit by slicing into batches, but submit each batch to the centralized queue
    const batches = [];
    for (let i = 0; i < tasks.length; i += perPostFileLimit) batches.push(tasks.slice(i, i + perPostFileLimit));

    const allFileResults = [];
    let globalDispatched = 0;

    const sendProgress = (sent, total) => {
      const payload = { action: 'downloadProgress', service, userId, postId, progress: Math.round(100 * (sent / Math.max(1, total))), sentCount: sent, totalCount: total };
      try { if (typeof senderTabId === 'number') chrome.tabs.sendMessage(senderTabId, payload, () => { void chrome.runtime.lastError; }); else chrome.runtime.sendMessage(payload, () => { void chrome.runtime.lastError; }); } catch (e) { }
    };

    // Increase global queue concurrency if backendCfg requests more
    GLOBAL_TASK_QUEUE.concurrency = concurrency;
    GLOBAL_TASK_QUEUE._startWorkers();

    for (let b = 0; b < batches.length; b++) {
      const batchTasks = batches[b];
      // Enqueue batch and wait for completion
      const results = await GLOBAL_TASK_QUEUE.enqueueTasks(batchTasks, { endpoint, cookieString, origin, service, userId, postId, headers, perFileRetry, sendProgress, totalCount: tasks.length });
      allFileResults.push(...results);
      globalDispatched += results.length;
      // small pause between batches to avoid bursts
      if (b < batches.length - 1) await new Promise(r => setTimeout(r, 250));
    }

    const anySuccess = allFileResults.some(fr => fr.success);
    if (anySuccess) {
      return { success: true, backend: true, results: allFileResults, externalLinks };
    }
  }

  // 4. Local chrome.downloads fallback
  const progressCallback = ({ processed, total, successCount }) => {
    const payload = { action: 'downloadProgress', service, userId, postId, progress: Math.round(100 * (processed / Math.max(1, total))), sentCount: successCount, totalCount: total };
    try { if (typeof senderTabId === 'number') chrome.tabs.sendMessage(senderTabId, payload, () => { void chrome.runtime.lastError; }); else chrome.runtime.sendMessage(payload, () => { void chrome.runtime.lastError; }); } catch (e) { }
  };

  const { successCount, results } = await runSequentialDownloads(tasks, progressCallback);
  return { success: true, successCount, results, externalLinks };
}
