// background/download.js - download orchestration (local chrome.downloads and backend forwarding)
import { CONFIG, API, PAW } from './constants.js';
import UTIL from './util.js';
import { loadBackendConfig, loadExternalLinkFilterConfig } from './config.js';
import { handleAPIRequest, getCookies, readLimitedResponseText } from './network.js';
import {
  buildPawchiveDownloadTasks,
  fetchPawchivePost,
  isCompletePawchivePost,
} from './pawchive.js';

const BACKEND_REQUEST_TIMEOUT_MS = 60 * 1000;
const HTML_REQUEST_TIMEOUT_MS = 45 * 1000;
const MAX_COOMERFANS_MEDIA_TASKS = 5000;
const MAX_MEDIA_URL_LENGTH = 8192;
const MAX_HTML_TAG_LENGTH = 64 * 1024;
const MAX_PENDING_BACKEND_TASKS = 10_000;
const COOMERFANS_MEDIA_TAGS = new Set(['source', 'video', 'a', 'img']);
const COOMERFANS_MEDIA_ATTRIBUTES = new Set([
  'src', 'href', 'data-src', 'data-original', 'data-lazy-src',
]);
const COOMERFANS_MEDIA_EXTENSIONS = new Set([
  '.mp4', '.webm', '.m4v', '.mov', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.zip', '.rar', '.7z',
]);
const TRUSTED_MEDIA_HOSTS = new Set([...API.HOSTS, API.COOMERFANS_HOST, PAW.HOST, PAW.FILE_HOST]);

function trustedMediaUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase();
    for (const trustedHost of TRUSTED_MEDIA_HOSTS) {
      if (host === trustedHost || host.endsWith(`.${trustedHost}`)) return true;
    }
  } catch (error) {
    // Ignore malformed URLs from upstream data.
  }
  return false;
}

function isSameSiteFamily(taskUrl, origin) {
  try {
    const task = new URL(taskUrl);
    const originHost = new URL(origin).hostname.toLowerCase();
    const taskHost = task.hostname.toLowerCase();
    if (task.protocol !== 'https:') return false;
    if (originHost === PAW.HOST) {
      return taskHost === PAW.HOST || taskHost === PAW.FILE_HOST;
    }
    return taskHost === originHost || taskHost.endsWith(`.${originHost}`);
  } catch (error) {
    return false;
  }
}

function cookieForTask(taskUrl, origin, cookieString) {
  return cookieString && isSameSiteFamily(taskUrl, origin) ? cookieString : '';
}

function refererForTask(taskUrl, origin, referer) {
  return referer && isSameSiteFamily(taskUrl, origin) ? referer : '';
}

async function fetchWithTimeout(url, options, timeoutMs) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

// Unified in-memory task queue singleton to manage all outgoing dispatches to backends
class TaskQueue {
  constructor(concurrency = CONFIG.MAX_CONCURRENT_DOWNLOADS) {
    this.queue = [];
    this.queueHead = 0;
    this.waiters = [];
    this.pendingTasks = 0;
    this.concurrency = concurrency;
    this.activeWorkers = 0;
    this.setConcurrency(concurrency);
  }

  setConcurrency(concurrency) {
    const requested = Number(concurrency);
    this.concurrency = Number.isFinite(requested)
      ? Math.min(6, Math.max(1, Math.floor(requested)))
      : CONFIG.MAX_CONCURRENT_DOWNLOADS;
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
    const index = this.queueHead++;
    const item = this.queue[index];
    // Break references to completed batch metadata immediately. Waiting for a
    // later array compaction retained every consumed task behind a large queue.
    this.queue[index] = undefined;
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
    if (Array.isArray(batchTasks) && batchTasks.length > 0
        && this.pendingTasks + batchTasks.length > MAX_PENDING_BACKEND_TASKS) {
      return Promise.reject(new Error(
        `Backend task queue exceeds the ${MAX_PENDING_BACKEND_TASKS} pending-task limit`
      ));
    }
    return new Promise((resolve) => {
      if (!Array.isArray(batchTasks) || batchTasks.length === 0) {
        resolve([]);
        return;
      }
      this.pendingTasks += batchTasks.length;
      const meta = {
        remaining: batchTasks.length,
        processed: Number(options.progressOffset || 0),
        results: new Array(batchTasks.length),
        resolve,
        total: Number(options.totalCount || batchTasks.length),
      };
      for (let index = 0; index < batchTasks.length; index++) {
        this.queue.push({ meta, task: batchTasks[index], options, resultIndex: index });
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

      const { meta, task, options, resultIndex } = item;
      let sendProgress;
      let record;
      try {
        const {
          endpoint, cookieString, origin, service, userId, postId, headers, referer,
          perFileRetry = 0, sendProgress: progressCallback,
        } = options || {};
        sendProgress = progressCallback;
        const requestReferer = referer || `${origin}/${encodeURIComponent(service)}/user/${encodeURIComponent(userId)}/post/${encodeURIComponent(postId)}`;

        // Wait the adaptive delay before sending to avoid spikes.
        if (currentDelay > 0) await new Promise(r => setTimeout(r, currentDelay));

        // Build payload. Site cookies never cross to a different media domain.
        const downloadHeaders = {
          'User-Agent': headers?.['User-Agent'] || 'Mozilla/5.0',
          Accept: headers?.['Accept'] || 'text/css',
          'Accept-Language': headers?.['Accept-Language'] || 'zh-CN,zh;q=0.9'
        };
        const taskReferer = refererForTask(task.url, origin, requestReferer);
        if (taskReferer) downloadHeaders.Referer = taskReferer;
        const taskCookie = cookieForTask(task.url, origin, cookieString);
        if (taskCookie) downloadHeaders.Cookie = taskCookie;
        const filePayload = {
          downloadSource: {
            link: task.url,
            headers: downloadHeaders
          },
          name: task.fileName,
          queueId: 0,
        };

        // Attempt with retries (simple per-file retry with incremental backoff).
        let attempts = 0;
        let success = false;
        let lastError = null;
        while (attempts <= perFileRetry && !success) {
          try {
            attempts++;
            const requestHeaders = { 'Content-Type': 'application/json' };
            if (options.apiKey) requestHeaders['X-Api-Key'] = options.apiKey;
            const resp = await fetchWithTimeout(endpoint, {
              method: 'POST',
              headers: requestHeaders,
              body: JSON.stringify(filePayload),
              credentials: 'omit',
              redirect: 'error',
            }, BACKEND_REQUEST_TIMEOUT_MS);
            const text = await readLimitedResponseText(resp, 64 * 1024, 'Backend').catch(() => '');
            if (!resp.ok) {
              throw new Error(`Backend HTTP ${resp.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
            }
            success = true;
          } catch (e) {
            lastError = e;
            if (attempts > perFileRetry) break;
            await new Promise(r => setTimeout(r, 1000 * attempts));
          }
        }

        // Update adaptive delay: reset on success, back off on failure.
        if (success) {
          currentDelay = CONFIG.TASK_INTERVAL_INITIAL || CONFIG.TASK_INTERVAL;
        } else {
          currentDelay = Math.min(maxDelay, Math.ceil(currentDelay * factor + linearInc));
        }

        record = success ? { task, success: true, attempts } : { task, success: false, attempts, error: lastError && lastError.message ? lastError.message : String(lastError) };
      } catch (error) {
        currentDelay = Math.min(maxDelay, Math.ceil(currentDelay * factor + linearInc));
        record = {
          task,
          success: false,
          attempts: 0,
          error: error && error.message ? error.message : String(error),
        };
      }
      meta.results[resultIndex] = record;
      meta.remaining--;
      meta.processed++;
      this.pendingTasks = Math.max(0, this.pendingTasks - 1);
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

function sendDownloadProgress(senderTabId, service, userId, postId, processed, total, sentCount = processed, requestId) {
  const payload = {
    action: 'downloadProgress',
    ...(requestId ? { requestId } : {}),
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
  const perPostFileLimit = Math.max(
    1,
    Math.min(1000, Number.isFinite(backendCfg.perPostFileLimit) ? backendCfg.perPostFileLimit : context.defaultFileLimit)
  );
  const allFileResults = [];
  const sendProgress = (sent, total) => {
    sendDownloadProgress(
      context.senderTabId,
      context.service,
      context.userId,
      context.postId,
      sent,
      total,
      sent,
      context.requestId
    );
  };

  GLOBAL_TASK_QUEUE.setConcurrency(concurrency);
  for (let offset = 0; offset < tasks.length; offset += perPostFileLimit) {
    const batch = tasks.slice(offset, offset + perPostFileLimit);
    try {
      const results = await GLOBAL_TASK_QUEUE.enqueueTasks(batch, {
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
        apiKey: backendCfg.apiKey || '',
        totalCount: tasks.length,
        progressOffset: allFileResults.length,
      });
      allFileResults.push(...results);
    } catch (error) {
      const failure = error && error.message ? error.message : String(error);
      for (let index = offset; index < tasks.length; index++) {
        allFileResults.push({
          task: tasks[index],
          success: false,
          attempts: 0,
          error: failure,
        });
      }
      sendProgress(tasks.length, tasks.length);
      break;
    }
    if (offset + perPostFileLimit < tasks.length) {
      await new Promise(r => setTimeout(r, 250));
    }
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

function validateDownloadTasks(tasks) {
  const trustedTasks = tasks.filter((task) => task && trustedMediaUrl(task.url));
  if (tasks.length > 0 && trustedTasks.length === 0) {
    throw new Error('The post contains no trusted HTTPS media URLs');
  }
  if (trustedTasks.length < tasks.length) {
    console.warn(`[Background] ignored ${tasks.length - trustedTasks.length} untrusted media URLs`);
  }
  return trustedTasks;
}

function absoluteCoomerFansUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    if (rawUrl.length > MAX_MEDIA_URL_LENGTH) return '';
    return new URL(rawUrl.replace(/&amp;/g, '&'), API.COOMERFANS_ORIGIN).toString();
  } catch (_) {
    return '';
  }
}

function isHtmlNameCode(code) {
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || code === 45
    || code === 58;
}

function forEachBoundedStartTag(input, acceptedNames, visitor) {
  const source = String(input || '');
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf('<', cursor);
    if (start < 0) return;

    const nameStart = start + 1;
    let nameEnd = nameStart;
    while (nameEnd < source.length && isHtmlNameCode(source.charCodeAt(nameEnd))) nameEnd++;
    if (nameEnd === nameStart || nameEnd - nameStart > 16) {
      cursor = Math.max(nameEnd, nameStart);
      continue;
    }
    const name = source.slice(nameStart, nameEnd).toLowerCase();
    if (!acceptedNames.has(name)) {
      cursor = nameEnd;
      continue;
    }

    let quote = '';
    let end = nameEnd;
    let restart = -1;
    const limit = Math.min(source.length, start + MAX_HTML_TAG_LENGTH + 1);
    for (; end < limit; end++) {
      const char = source[end];
      if (quote) {
        if (char === quote) quote = '';
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        break;
      } else if (char === '<') {
        restart = end;
        break;
      }
    }

    if (restart >= 0) {
      cursor = restart;
      continue;
    }
    if (end >= limit || source[end] !== '>') {
      cursor = limit;
      continue;
    }
    if (visitor(source.slice(start, end + 1), name) === false) return;
    cursor = end + 1;
  }
}

function extractTagAttrs(tagText) {
  const attrs = Object.create(null);
  let cursor = 1;
  while (cursor < tagText.length && !/\s/.test(tagText[cursor]) && tagText[cursor] !== '>') cursor++;
  while (cursor < tagText.length) {
    while (cursor < tagText.length && /\s/.test(tagText[cursor])) cursor++;
    if (cursor >= tagText.length || tagText[cursor] === '>') break;
    if (tagText[cursor] === '/') {
      cursor++;
      continue;
    }

    const nameStart = cursor;
    while (cursor < tagText.length
      && !/[\s"'=<>`/]/.test(tagText[cursor])) cursor++;
    if (cursor === nameStart) {
      cursor++;
      continue;
    }
    const name = tagText.slice(nameStart, cursor).toLowerCase();
    while (cursor < tagText.length && /\s/.test(tagText[cursor])) cursor++;

    let value = '';
    if (tagText[cursor] === '=') {
      cursor++;
      while (cursor < tagText.length && /\s/.test(tagText[cursor])) cursor++;
      const quote = tagText[cursor] === '"' || tagText[cursor] === "'" ? tagText[cursor++] : '';
      const valueStart = cursor;
      if (quote) {
        while (cursor < tagText.length && tagText[cursor] !== quote) cursor++;
        value = tagText.slice(valueStart, cursor);
        if (tagText[cursor] === quote) cursor++;
      } else {
        while (cursor < tagText.length && !/[\s"'=<>`]/.test(tagText[cursor])) cursor++;
        value = tagText.slice(valueStart, cursor);
      }
    }
    if (COOMERFANS_MEDIA_ATTRIBUTES.has(name)) attrs[name] = value;
  }
  return attrs;
}

function isCoomerFansMediaUrl(mediaUrl) {
  try {
    const u = new URL(mediaUrl);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    const ext = UTIL.getFileExtension(path);
    if (!COOMERFANS_MEDIA_EXTENSIONS.has(ext)) return false;
    if (path.includes('/istorage/')) return false;
    return (host === API.COOMERFANS_HOST || host.endsWith(`.${API.COOMERFANS_HOST}`)) && path.includes('/storage/');
  } catch (_) {
    return false;
  }
}

function extractCoomerFansMediaUrls(html) {
  const urls = [];
  const seen = new Set();
  forEachBoundedStartTag(html, COOMERFANS_MEDIA_TAGS, (tagText) => {
    const attrs = extractTagAttrs(tagText);
    const raw = attrs.src || attrs.href || attrs['data-src'] || attrs['data-original'] || attrs['data-lazy-src'];
    const full = absoluteCoomerFansUrl(raw);
    if (!full || !isCoomerFansMediaUrl(full) || seen.has(full)) return true;
    seen.add(full);
    urls.push(full);
    return urls.length < MAX_COOMERFANS_MEDIA_TASKS;
  });
  return urls.sort();
}

async function fetchCoomerFansHtml(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new Error('Invalid CoomerFans URL');
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
      || (host !== API.COOMERFANS_HOST && !host.endsWith(`.${API.COOMERFANS_HOST}`))) {
    throw new Error('Unexpected CoomerFans URL');
  }
  const headers = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Cache-Control': 'no-cache',
    'User-Agent': 'Mozilla/5.0',
  };
  const resp = await fetchWithTimeout(parsed.toString(), {
    method: 'GET',
    headers,
    credentials: 'include',
    cache: 'no-store',
    redirect: 'error',
  }, HTML_REQUEST_TIMEOUT_MS);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return readLimitedResponseText(resp, 16 * 1024 * 1024, 'CoomerFans');
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

export async function startCoomerFansDownload(service, userId, postId, creatorName, senderTabId, requestId) {
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
  const externalLinks = UTIL.filterExternalLinks(
    UTIL.extractExternalLinks(html),
    await loadExternalLinkFilterConfig()
  );

  if (tasks.length === 0) {
    return { success: true, successCount: 0, results: [], externalLinks, message: 'No downloadable files found', noFiles: true };
  }

  tasks = validateDownloadTasks(tasks);

  const backendCfg = await loadBackendConfig();

  if (backendCfg.enabled) {
    const cookieString = await getCookies(API.COOMERFANS_HOST);
    if (backendCfg.backendType === 'gopeed') {
      const { successCount, results } = await dispatchAllToGopeed(tasks, backendCfg, cookieString, API.COOMERFANS_ORIGIN, postUrl, service, userId, postId, senderTabId, requestId);
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
        requestId,
        defaultFileLimit: 100,
      });

      if (allFileResults.some(fr => fr.success)) return { success: true, backend: true, results: allFileResults, externalLinks };
    }
    return backendFailureResult(tasks, externalLinks);
  }

  const progressCallback = ({ processed, total, successCount }) => {
    sendDownloadProgress(senderTabId, service, userId, postId, processed, total, successCount, requestId);
  };

  const { successCount, results } = await runSequentialDownloads(tasks, progressCallback);
  return { success: true, successCount, results, externalLinks };
}

// Download a single Pawchive post from its JSON API representation. Creator
// page batches can pass an already-fetched post to avoid duplicate requests.
export async function startPawchiveDownload(service, userId, postId, senderTabId, prefetchedPost = null, requestId) {
  const postUrl = `${PAW.ORIGIN}/${encodeURIComponent(service)}/user/${encodeURIComponent(userId)}/post/${encodeURIComponent(postId)}`;
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
  const externalLinks = UTIL.filterExternalLinks(
    UTIL.extractPostExternalLinks(post),
    await loadExternalLinkFilterConfig()
  );

  if (tasks.length === 0) {
    return { success: true, successCount: 0, results: [], externalLinks, message: 'No downloadable files found', noFiles: true };
  }

  tasks = validateDownloadTasks(tasks);

  const backendCfg = await loadBackendConfig();

  if (backendCfg.enabled) {
    const cookies = await getCookies(PAW.HOST);
    if (backendCfg.backendType === 'gopeed') {
      const referer = postUrl;
      const { successCount, results } = await dispatchAllToGopeed(tasks, backendCfg, cookies, PAW.ORIGIN, referer, service, userId, postId, senderTabId, requestId);
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
        requestId,
      });

      const anySuccess = allFileResults.some(fr => fr.success);
      if (anySuccess) return { success: true, backend: true, results: allFileResults, externalLinks };
    }
    return backendFailureResult(tasks, externalLinks);
  }

  // Local chrome.downloads fallback
  const progressCallback = ({ processed, total, successCount }) => {
    sendDownloadProgress(senderTabId, service, userId, postId, processed, total, successCount, requestId);
  };

  const { successCount, results } = await runSequentialDownloads(tasks, progressCallback);
  return { success: true, successCount, results, externalLinks };
}

// Dispatch a single file URL to Gopeed via the REST API from the background
// service worker. Do not use no-cors here: it strips Content-Type and
// X-Api-Token, which makes token-protected Gopeed instances silently fail.
async function dispatchToGopeed(baseUrl, token, fileUrl, cookieString, referer, fileName) {
  const requestHeaders = {};
  if (referer) requestHeaders.Referer = referer;
  if (cookieString) requestHeaders.Cookie = cookieString;
  const payload = {
    rid: '',
    req: {
      url: fileUrl,
      method: 'GET',
      extra: { header: requestHeaders },
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
    const resp = await fetchWithTimeout(`${baseUrl}/api/v1/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      credentials: 'omit',
      redirect: 'error',
    }, BACKEND_REQUEST_TIMEOUT_MS);
    const text = await readLimitedResponseText(resp, 64 * 1024, 'Gopeed').catch(() => '');
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
async function dispatchAllToGopeed(tasks, backendCfg, cookieString, origin, referer, service, userId, postId, senderTabId, requestId) {
  const baseUrl = `${backendCfg.gopeedProtocol}://${backendCfg.gopeedHost}:${backendCfg.gopeedPort}`;
  const token = backendCfg.gopeedToken || '';
  let successCount = 0;
  const results = [];
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const result = await dispatchToGopeed(
      baseUrl,
      token,
      task.url,
      cookieForTask(task.url, origin, cookieString),
      refererForTask(task.url, origin, referer),
      task.fileName
    );
    results.push({ task, ...result });
    if (result.success) successCount++;
    sendDownloadProgress(senderTabId, service, userId, postId, i + 1, tasks.length, i + 1, requestId);
  }
  return { successCount, results };
}

export async function startFullDownload(service, userId, postId, path, senderUrl, senderTabId, requestId) {
  // 1. Determine origin using centralized API config
  let origin = API.DEFAULT_ORIGIN;
  try {
    if (senderUrl) {
      const su = new URL(senderUrl);
      const host = su.hostname.toLowerCase();
      if (host === API.HOSTS[0]) origin = `https://${API.HOSTS[0]}`;
      else if (host === API.HOSTS[1]) origin = `https://${API.HOSTS[1]}`;
    } else if (path && path.includes('coomer')) {
      origin = `https://${API.HOSTS[0]}`;
    }
  } catch (e) { }

  // 2. API
  const encodedService = encodeURIComponent(service);
  const encodedUserId = encodeURIComponent(userId);
  const encodedPostId = encodeURIComponent(postId);
  const postUrl = `${origin}/${encodedService}/user/${encodedUserId}/post/${encodedPostId}`;
  const apiUrl = `${origin}${API.API_PREFIX}/${encodedService}/user/${encodedUserId}/post/${encodedPostId}`;
  const headers = {
    'Accept': 'text/css',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Cache-Control': 'no-cache',
    'DNT': '1',
    'Pragma': 'no-cache',
    'Referer': postUrl,
    'User-Agent': 'Mozilla/5.0'
  };

  const postData = await handleAPIRequest(apiUrl, headers);
  if (!postData || !postData.post) throw new Error('Invalid API response');

  const title = UTIL.sanitizeFileName(postData.post.title || 'Untitled');
  let tasks = UTIL.buildDownloadTasks(postData, title, origin);
  const externalLinks = UTIL.filterExternalLinks(
    UTIL.extractPostExternalLinks(postData),
    await loadExternalLinkFilterConfig()
  );

  if (tasks.length === 0) {
    return { success: true, successCount: 0, results: [], externalLinks, message: 'No downloadable files found', noFiles: true };
  }

  tasks = validateDownloadTasks(tasks);

  const backendCfg = await loadBackendConfig();

  // 3. Backend forwarding (with centralized queue/batching and adaptive throttle)
  if (backendCfg.enabled) {
    const cookieString = await getCookies(new URL(origin).hostname);
    if (backendCfg.backendType === 'gopeed') {
      const referer = postUrl;
      const { successCount, results } = await dispatchAllToGopeed(tasks, backendCfg, cookieString, origin, referer, service, userId, postId, senderTabId, requestId);
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
        requestId,
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
    sendDownloadProgress(senderTabId, service, userId, postId, processed, total, successCount, requestId);
  };

  const { successCount, results } = await runSequentialDownloads(tasks, progressCallback);
  return { success: true, successCount, results, externalLinks };
}
