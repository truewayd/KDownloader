// background/download.js - download orchestration (local chrome.downloads and backend forwarding)
import { CONFIG, API, PAW } from './constants.js';
import UTIL from './util.js';
import { loadBackendConfig, loadDownloadRulesConfig } from './config.js';
import { handleAPIRequest, getCookies } from './network.js';
import {
  buildPawchiveDownloadTasks,
  fetchPawchivePost,
  isCompletePawchivePost,
} from './pawchive.js';

// Unified in-memory task queue singleton to manage all outgoing dispatches to backends
class TaskQueue {
  constructor(concurrency = CONFIG.MAX_CONCURRENT_DOWNLOADS) {
    this.queue = [];
    this.queueHead = 0;
    this.waiters = [];
    this.concurrency = concurrency;
    this.activeWorkers = 0;
    this.setConcurrency(concurrency);
  }

  setConcurrency(concurrency) {
    this.concurrency = Math.max(1, Math.floor(concurrency || CONFIG.MAX_CONCURRENT_DOWNLOADS));
    while (this.activeWorkers < this.concurrency) {
      this._spawnWorker();
    }
    this._wakeAll();
  }

  _spawnWorker() {
    this.activeWorkers++;
    this._workerLoop().finally(() => {
      this.activeWorkers = Math.max(0, this.activeWorkers - 1);
      if (this._hasItems() && this.activeWorkers < this.concurrency) {
        this._spawnWorker();
      }
    });
  }

  _notifyNew() {
    while (this.waiters.length && this._hasItems()) {
      const w = this.waiters.shift();
      w();
    }
  }

  _wakeAll() {
    while (this.waiters.length) {
      const w = this.waiters.shift();
      w();
    }
  }

  async _waitForItem() {
    if (this._hasItems()) return;
    await new Promise(resolve => this.waiters.push(resolve));
  }

  _hasItems() {
    return this.queueHead < this.queue.length;
  }

  _takeItem() {
    if (!this._hasItems()) return null;
    const item = this.queue[this.queueHead++];
    if (this.queueHead >= this.queue.length) {
      this.queue.length = 0;
      this.queueHead = 0;
    } else if (this.queueHead > 1024 && this.queueHead * 2 > this.queue.length) {
      this.queue = this.queue.slice(this.queueHead);
      this.queueHead = 0;
    }
    return item;
  }

  // Enqueue an array of file tasks. Returns a Promise resolving to results array for those tasks.
  enqueueTasks(batchTasks, options = {}) {
    return new Promise((resolve) => {
      if (!Array.isArray(batchTasks) || batchTasks.length === 0) {
        resolve([]);
        return;
      }
      const id = Date.now() + Math.random();
      const meta = {
        id,
        remaining: batchTasks.length,
        processed: Number(options.progressOffset || 0),
        results: [],
        resolve,
        total: Number(options.totalCount || batchTasks.length),
      };
      for (const t of batchTasks) {
        this.queue.push({ meta, task: t, options });
      }
      this._notifyNew();
    });
  }

  async _workerLoop() {
    // Each worker keeps its own adaptive delay state
    let currentDelay = CONFIG.TASK_INTERVAL_INITIAL || CONFIG.TASK_INTERVAL;
    const factor = CONFIG.TASK_INTERVAL_BACKOFF_FACTOR || 1.5;
    const linearInc = CONFIG.TASK_INTERVAL_LINEAR_INC || 50;
    const maxDelay = CONFIG.TASK_INTERVAL_MAX || 5000;

    while (true) {
      if (this.activeWorkers > this.concurrency) return;
      if (!this._hasItems()) await this._waitForItem();
      if (this.activeWorkers > this.concurrency) return;
      const item = this._takeItem();
      if (!item) continue;

      const { meta, task, options } = item;
      const { endpoint, cookieString, origin, service, userId, postId, headers, referer, perFileRetry = 0, sendProgress } = options;
      const requestReferer = referer || `${origin}/${service}/user/${userId}/post/${postId}`;

      // Wait the adaptive delay before sending to avoid spikes
      if (currentDelay > 0) await new Promise(r => setTimeout(r, currentDelay));

      // Build payload
      const filePayload = {
        downloadSource: {
          link: task.url,
          headers: {
            Cookie: cookieString,
            Referer: requestReferer,
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
          const resp = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(filePayload),
            credentials: 'include',
          });
          const text = await resp.text().catch(() => '');
          if (!resp.ok) {
            throw new Error(`Backend HTTP ${resp.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
          }
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
      meta.processed++;
      try { if (typeof sendProgress === 'function') sendProgress(meta.processed, meta.total); } catch (e) { }

      // Resolve when all items for this batch are done
      if (meta.remaining <= 0) {
        try { meta.resolve(meta.results); } catch (e) { }
      }
    }
  }
}

// Single global queue instance (will use default concurrency, can be adjusted later)
const GLOBAL_TASK_QUEUE = new TaskQueue();

function sendDownloadProgress(senderTabId, service, userId, postId, processed, total, sentCount = processed) {
  const payload = {
    action: 'downloadProgress',
    service,
    userId,
    postId,
    progress: Math.round(100 * (processed / Math.max(1, total))),
    sentCount,
    totalCount: total,
  };
  try {
    if (typeof senderTabId === 'number') {
      chrome.tabs.sendMessage(senderTabId, payload, () => { void chrome.runtime.lastError; });
    } else {
      chrome.runtime.sendMessage(payload, () => { void chrome.runtime.lastError; });
    }
  } catch (e) { }
}

async function dispatchAllToBackend(tasks, backendCfg, context) {
  const endpoint = `${backendCfg.protocol}://${backendCfg.host}:${backendCfg.port}/start-headless-download`;
  const perFileRetry = Math.min(10, Math.max(0, Number(backendCfg.retryCount) || 0));
  const concurrency = Math.max(1, Math.min(6, Math.floor(backendCfg.concurrency || CONFIG.MAX_CONCURRENT_DOWNLOADS)));
  const perPostFileLimit = Number.isFinite(backendCfg.perPostFileLimit) ? backendCfg.perPostFileLimit : context.defaultFileLimit;
  const batches = [];
  for (let i = 0; i < tasks.length; i += perPostFileLimit) batches.push(tasks.slice(i, i + perPostFileLimit));

  const allFileResults = [];
  const sendProgress = (sent, total) => {
    sendDownloadProgress(context.senderTabId, context.service, context.userId, context.postId, sent, total);
  };

  GLOBAL_TASK_QUEUE.setConcurrency(concurrency);
  for (let b = 0; b < batches.length; b++) {
    const results = await GLOBAL_TASK_QUEUE.enqueueTasks(batches[b], {
      endpoint,
      cookieString: context.cookieString,
      origin: context.origin,
      service: context.service,
      userId: context.userId,
      postId: context.postId,
      headers: context.headers,
      referer: context.referer,
      perFileRetry,
      sendProgress,
      totalCount: tasks.length,
      progressOffset: allFileResults.length,
    });
    allFileResults.push(...results);
    if (b < batches.length - 1) await new Promise(r => setTimeout(r, 250));
  }

  return allFileResults;
}

export async function dispatchExternalLinksTextTask(entries, context = {}) {
  const task = UTIL.buildExternalLinksTextTask(entries, context.fileName);
  if (!task) return { success: true, skipped: true, results: [] };

  const { successCount, results } = await runSequentialDownloads([task]);
  return {
    success: successCount > 0,
    successCount,
    results,
    task,
    error: successCount > 0 ? undefined : 'Chrome download failed',
  };
}

export async function dispatchTextDownloadTask(text, context = {}) {
  const task = UTIL.buildTextDownloadTask(text, context.fileName, context.type);
  if (!task) return { success: true, skipped: true, results: [] };

  const { successCount, results } = await runSequentialDownloads([task]);
  return {
    success: successCount > 0,
    successCount,
    results,
    task,
    error: successCount > 0 ? undefined : 'Chrome download failed',
  };
}

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

function backendFailureResult(tasks, externalLinks) {
  return {
    success: false,
    backendFailed: true,
    fallbackTasks: tasks,
    externalLinks,
    error: 'Download backend connection failed',
  };
}

async function applyDownloadRules(tasks, externalLinks) {
  const filteredTasks = UTIL.filterDownloadTasks(tasks, await loadDownloadRulesConfig());
  if (tasks.length > 0 && filteredTasks.length === 0) {
    return {
      tasks: filteredTasks,
      result: {
        success: true,
        successCount: 0,
        results: [],
        externalLinks,
        skippedByFilter: true,
        filteredCount: tasks.length,
        message: 'All files were excluded by download rules',
      },
    };
  }
  return { tasks: filteredTasks, result: null };
}

function absoluteCoomerFansUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    return new URL(rawUrl.replace(/&amp;/g, '&'), API.COOMERFANS_ORIGIN).toString();
  } catch (_) {
    return '';
  }
}

function extractTagAttrs(tagText) {
  const attrs = {};
  const attrRe = /([^\s"'=<>`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = attrRe.exec(tagText)) !== null) {
    const name = String(match[1] || '').toLowerCase();
    if (!name || name === 'a' || name === 'img' || name === 'source' || name === 'video') continue;
    attrs[name] = match[2] || match[3] || match[4] || '';
  }
  return attrs;
}

function isCoomerFansMediaUrl(mediaUrl) {
  try {
    const u = new URL(mediaUrl);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    const ext = UTIL.getFileExtension(path);
    const allowed = new Set(['.mp4', '.webm', '.m4v', '.mov', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.zip', '.rar', '.7z']);
    if (!allowed.has(ext)) return false;
    if (path.includes('/istorage/')) return false;
    return (host === API.COOMERFANS_HOST || host.endsWith(`.${API.COOMERFANS_HOST}`)) && path.includes('/storage/');
  } catch (_) {
    return false;
  }
}

function extractCoomerFansMediaUrls(html) {
  const urls = [];
  const seen = new Set();
  const tagRe = /<(source|video|a|img)\b[^>]*>/gi;
  let match;
  while ((match = tagRe.exec(html || '')) !== null) {
    const attrs = extractTagAttrs(match[0]);
    const raw = attrs.src || attrs.href || attrs['data-src'] || attrs['data-original'] || attrs['data-lazy-src'];
    const full = absoluteCoomerFansUrl(raw);
    if (!full || !isCoomerFansMediaUrl(full) || seen.has(full)) continue;
    seen.add(full);
    urls.push(full);
  }
  return urls.sort();
}

async function fetchCoomerFansHtml(url) {
  const headers = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Cache-Control': 'no-cache',
    'User-Agent': 'Mozilla/5.0',
  };
  const resp = await fetch(url, { method: 'GET', headers, credentials: 'include' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

function coomerFansPostUrl(service, userId, postId) {
  return `${API.COOMERFANS_ORIGIN}/p/${encodeURIComponent(postId)}/${encodeURIComponent(userId)}/${encodeURIComponent(service)}`;
}

function buildCoomerFansFileName(creatorName, userId, postId, mediaUrl, index) {
  const ext = UTIL.getFileExtension(mediaUrl) || '.bin';
  const base = UTIL.sanitizeFileName(creatorName || userId || 'coomerfans');
  const suffix = index === 1 ? '' : `.${index}`;
  return UTIL.sanitizeFileName(`${base}.${postId}${suffix}${ext}`);
}

export async function startCoomerFansDownload(service, userId, postId, creatorName, senderTabId) {
  const postUrl = coomerFansPostUrl(service, userId, postId);
  let html;
  try {
    html = await fetchCoomerFansHtml(postUrl);
  } catch (e) {
    throw new Error(`Failed to fetch CoomerFans post page: ${e.message}`);
  }

  const mediaUrls = extractCoomerFansMediaUrls(html);
  let tasks = mediaUrls.map((url, index) => ({
    url,
    fileName: buildCoomerFansFileName(creatorName, userId, postId, url, index + 1),
    type: 'coomerfans_media',
  }));
  const externalLinks = UTIL.extractExternalLinks(html);

  if (tasks.length === 0) {
    return { success: true, successCount: 0, results: [], externalLinks, message: 'No downloadable files found', noFiles: true };
  }

  const filtered = await applyDownloadRules(tasks, externalLinks);
  if (filtered.result) return filtered.result;
  tasks = filtered.tasks;

  const domain = API.COOMERFANS_HOST;
  const cookieString = await getCookies(domain);
  const backendCfg = await loadBackendConfig();

  if (backendCfg.enabled) {
    if (backendCfg.backendType === 'gopeed') {
      const { successCount, results } = await dispatchAllToGopeed(tasks, backendCfg, cookieString, postUrl, service, userId, postId, senderTabId);
      if (successCount > 0) return { success: true, backend: true, gopeed: true, successCount, results, externalLinks };
    } else {
      const headers = {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'User-Agent': 'Mozilla/5.0',
      };
      const allFileResults = await dispatchAllToBackend(tasks, backendCfg, {
        cookieString,
        origin: API.COOMERFANS_ORIGIN,
        service,
        userId,
        postId,
        headers,
        referer: postUrl,
        senderTabId,
        defaultFileLimit: 100,
      });

      if (allFileResults.some(fr => fr.success)) return { success: true, backend: true, results: allFileResults, externalLinks };
    }
    return backendFailureResult(tasks, externalLinks);
  }

  const progressCallback = ({ processed, total, successCount }) => {
    sendDownloadProgress(senderTabId, service, userId, postId, processed, total, successCount);
  };

  const { successCount, results } = await runSequentialDownloads(tasks, progressCallback);
  return { success: true, successCount, results, externalLinks };
}

// Download a single Pawchive post from its JSON API representation. Creator
// page batches can pass an already-fetched post to avoid duplicate requests.
export async function startPawchiveDownload(service, userId, postId, senderTabId, prefetchedPost = null) {
  const postUrl = `${PAW.ORIGIN}/${service}/user/${userId}/post/${postId}`;
  const cookies = await getCookies(PAW.HOST);
  const headers = {
    'Accept': 'application/json',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Cache-Control': 'no-cache',
  };

  let post;
  try {
    post = prefetchedPost || await fetchPawchivePost(service, userId, postId);
  } catch (e) {
    throw new Error(`Failed to fetch Pawchive post: ${e.message}`);
  }

  if (!isCompletePawchivePost(post)) {
    return {
      success: false,
      skipped: true,
      incomplete: true,
      results: [],
      externalLinks: [],
      error: 'Pawchive post is incomplete (has_full is false)',
    };
  }

  let tasks = buildPawchiveDownloadTasks(post);
  const externalLinks = UTIL.extractExternalLinks(typeof post.content === 'string' ? post.content : '');

  if (tasks.length === 0) {
    return { success: true, successCount: 0, results: [], externalLinks, message: 'No downloadable files found', noFiles: true };
  }

  const filtered = await applyDownloadRules(tasks, externalLinks);
  if (filtered.result) return filtered.result;
  tasks = filtered.tasks;

  const backendCfg = await loadBackendConfig();

  if (backendCfg.enabled) {
    if (backendCfg.backendType === 'gopeed') {
      const referer = postUrl;
      const { successCount, results } = await dispatchAllToGopeed(tasks, backendCfg, cookies, referer, service, userId, postId, senderTabId);
      if (successCount > 0) return { success: true, backend: true, gopeed: true, successCount, results, externalLinks };
    } else {
      const allFileResults = await dispatchAllToBackend(tasks, backendCfg, {
        cookieString: cookies,
        origin: PAW.ORIGIN,
        service,
        userId,
        postId,
        headers,
        referer: postUrl,
        defaultFileLimit: 200,
        senderTabId,
      });

      const anySuccess = allFileResults.some(fr => fr.success);
      if (anySuccess) return { success: true, backend: true, results: allFileResults, externalLinks };
    }
    return backendFailureResult(tasks, externalLinks);
  }

  // Local chrome.downloads fallback
  const progressCallback = ({ processed, total, successCount }) => {
    sendDownloadProgress(senderTabId, service, userId, postId, processed, total, successCount);
  };

  const { successCount, results } = await runSequentialDownloads(tasks, progressCallback);
  return { success: true, successCount, results, externalLinks };
}

// Dispatch a single file URL to Gopeed via the REST API from the background
// service worker. Do not use no-cors here: it strips Content-Type and
// X-Api-Token, which makes token-protected Gopeed instances silently fail.
async function dispatchToGopeed(baseUrl, token, fileUrl, cookieString, referer, fileName) {
  const payload = {
    rid: '',
    req: {
      url: fileUrl,
      method: 'GET',
      extra: { header: { Cookie: cookieString, Referer: referer } },
    },
    opts: {
      name: fileName,
      selectFiles: [1],
      extra: { connections: 32 },
    },
  };
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Api-Token'] = token;

  try {
    const resp = await fetch(`${baseUrl}/api/v1/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const text = await resp.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) {}
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }
    if (data && typeof data.code === 'number' && data.code !== 0) {
      throw new Error(data.msg || data.message || `Gopeed API error ${data.code}`);
    }
    return { success: true, response: data || text || null };
  } catch (e) {
    console.error('[Gopeed] dispatch error:', e.message);
    return { success: false, error: e && e.message ? e.message : String(e) };
  }
}

// Dispatch all tasks to gopeed sequentially, reporting progress.
async function dispatchAllToGopeed(tasks, backendCfg, cookieString, referer, service, userId, postId, senderTabId) {
  const baseUrl = `${backendCfg.gopeedProtocol}://${backendCfg.gopeedHost}:${backendCfg.gopeedPort}`;
  const token = backendCfg.gopeedToken || '';
  let successCount = 0;
  const results = [];
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const result = await dispatchToGopeed(baseUrl, token, task.url, cookieString, referer, task.fileName);
    results.push({ task, ...result });
    if (result.success) successCount++;
    sendDownloadProgress(senderTabId, service, userId, postId, i + 1, tasks.length);
  }
  return { successCount, results };
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
  let tasks = UTIL.buildDownloadTasks(postData, title, origin);
  const externalLinks = UTIL.extractExternalLinks(postData.post && postData.post.content ? postData.post.content : '');

  if (tasks.length === 0) {
    return { success: true, successCount: 0, results: [], externalLinks, message: 'No downloadable files found', noFiles: true };
  }

  const filtered = await applyDownloadRules(tasks, externalLinks);
  if (filtered.result) return filtered.result;
  tasks = filtered.tasks;

  const cookieString = cookies;
  const backendCfg = await loadBackendConfig();

  // 3. Backend forwarding (with centralized queue/batching and adaptive throttle)
  if (backendCfg.enabled) {
    if (backendCfg.backendType === 'gopeed') {
      const referer = `${origin}/${service}/user/${userId}/post/${postId}`;
      const { successCount, results } = await dispatchAllToGopeed(tasks, backendCfg, cookieString, referer, service, userId, postId, senderTabId);
      if (successCount > 0) return { success: true, backend: true, gopeed: true, successCount, results, externalLinks };
    } else {
      const allFileResults = await dispatchAllToBackend(tasks, backendCfg, {
        cookieString,
        origin,
        service,
        userId,
        postId,
        headers,
        defaultFileLimit: 200,
        senderTabId,
      });

      const anySuccess = allFileResults.some(fr => fr.success);
      if (anySuccess) {
        return { success: true, backend: true, results: allFileResults, externalLinks };
      }
    }
    return backendFailureResult(tasks, externalLinks);
  }

  // 4. Local chrome.downloads fallback
  const progressCallback = ({ processed, total, successCount }) => {
    sendDownloadProgress(senderTabId, service, userId, postId, processed, total, successCount);
  };

  const { successCount, results } = await runSequentialDownloads(tasks, progressCallback);
  return { success: true, successCount, results, externalLinks };
}
