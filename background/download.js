// background/download.js - download orchestration (local chrome.downloads and backend forwarding)
import { CONFIG, API } from './constants.js';
import UTIL from './util.js';
import { loadBackendConfig } from './config.js';
import { handleAPIRequest, getCookies } from './network.js';

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
    return { success: true, successCount: 0, results: [], externalLinks, message: 'No downloadable files found' };
  }

  const cookieString = cookies;
  const backendCfg = await loadBackendConfig();

  // 3. Backend forwarding (with batching/concurrency/throttle)
  if (backendCfg.enabled) {
    const endpoint = `${backendCfg.protocol}://${backendCfg.host}:${backendCfg.port}/start-headless-download`;
    const perFileRetry = Math.min(10, Math.max(0, Number(backendCfg.retryCount) || 0));
    const baseIntervalMs = 500;
    const concurrency = Math.max(1, Math.min(6, Math.floor(backendCfg.concurrency || 3)));
    const perPostFileLimit = Number.isFinite(backendCfg.perPostFileLimit) ? backendCfg.perPostFileLimit : 200;

    const batches = [];
    for (let i = 0; i < tasks.length; i += perPostFileLimit) batches.push(tasks.slice(i, i + perPostFileLimit));

    const allFileResults = [];
    let globalDispatched = 0;

    const sendProgress = (sent, total) => {
      const payload = { action: 'downloadProgress', service, userId, postId, progress: Math.round(100 * (sent / Math.max(1, total))), sentCount: sent, totalCount: total };
      try { if (typeof senderTabId === 'number') chrome.tabs.sendMessage(senderTabId, payload, () => { void chrome.runtime.lastError; }); else chrome.runtime.sendMessage(payload, () => { void chrome.runtime.lastError; }); } catch (e) { }
    };


    for (let b = 0; b < batches.length; b++) {
      const batchTasks = batches[b];
      let idx = 0;
      const total = batchTasks.length;
      const fileResults = [];

      const worker = async () => {
        while (true) {
          const i = idx++;
          if (i >= total) break;
          const t = batchTasks[i];

          let success = false;
          let attempts = 0;
          while (attempts <= perFileRetry && !success) {
            try {
              attempts++;
              const filePayload = {
                downloadSource: {
                  link: t.url,
                  headers: {
                    Cookie: cookieString,
                    Referer: `${origin}/${service}/user/${userId}/post/${postId}`,
                    'User-Agent': headers['User-Agent'] || 'Mozilla/5.0',
                    Origin: `chrome-extension://${chrome.runtime.id}`,
                    Accept: headers['Accept'] || 'text/css',
                    'Accept-Language': headers['Accept-Language'] || 'zh-CN,zh;q=0.9'
                  }
                },
                name: t.fileName,
                queueId: 0,
              };

              await fetch(endpoint, { method: 'POST', body: JSON.stringify(filePayload), mode: 'no-cors', credentials: 'include' });
              fileResults.push({ task: t, success: true, attempts });
              success = true;
            } catch (e) {
              if (attempts > perFileRetry) {
                fileResults.push({ task: t, success: false, attempts, error: e && e.message ? e.message : String(e) });
              } else {
                await new Promise(r => setTimeout(r, 1000 * attempts));
              }
            }

            if (baseIntervalMs > 0) await new Promise(r => setTimeout(r, baseIntervalMs));
            globalDispatched++;
            sendProgress(globalDispatched, tasks.length);
          }
        }
      };

      const workers = [];
      for (let w = 0; w < concurrency; w++) workers.push(worker());
      await Promise.all(workers);

      allFileResults.push(...fileResults);
      if (b < batches.length - 1) await new Promise(r => setTimeout(r, 1000));
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
