// background/handlers/downloadHandlers.js - download and creator fetch RPCs
import { API, PAW } from "../constants.js";
import UTIL from "../util.js";
import { handleAPIRequest, readLimitedResponseText } from "../network.js";
import {
  dispatchExternalLinksTextTask,
  dispatchTextDownloadTask,
  startCoomerFansDownload,
  startFullDownload,
  startPawchiveDownload,
  runSequentialDownloads,
} from "../download.js";
import {
  fetchAllPawchiveCreatorPosts,
  fetchPawchiveDms,
  fetchPawchiveCreatorPage,
  formatPawchiveDmsText,
  isCompletePawchivePost,
} from "../pawchive.js";
import {
  checkDownloadedMany,
  downloadedItemKey,
  markDownloaded,
  markMultipleDownloaded,
} from "../db.js";
import {
  registerBatch,
  updateProcessed,
  updateAcked,
  completeBatch,
} from "../progress.js";
import {
  beginAcceptedRequest,
  completeAcceptedRequest,
  delay,
  buildDownloadHistoryRecord,
  getSenderTabId,
  getSenderUrl,
  requireExtensionPage,
  requireTrustedWebSender,
  safeBroadcast,
} from "../messageHelpers.js";
import {
  clearNativeFallbackNotification,
  enqueueNativeFallback,
  measureNativeFallbackRequest,
  NATIVE_FALLBACK_LIMITS,
  takeNativeFallback,
} from "../nativeFallback.js";
import { loadExternalLinkFilterConfig } from "../config.js";

const DOWNLOAD_CONTENT_HOSTS = [...API.HOSTS, API.COOMERFANS_HOST, PAW.HOST];
const MAX_BATCH_EXTERNAL_LINKS = 5000;
const MAX_CREATOR_POSTS = 10000;
const MAX_CREATOR_PAGE_POSTS = 5000;
const MAX_CREATOR_RETAINED_BYTES = 64 * 1024 * 1024;
const MAX_EXTERNAL_LINK_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_BROADCAST_EXTERNAL_LINKS = 1000;
const MAX_BROADCAST_EXTERNAL_LINK_BYTES = 512 * 1024;
const MAX_HTML_TAG_LENGTH = 64 * 1024;
const MAX_HTML_URL_LENGTH = 8192;

function utf8ByteLength(value) {
  const text = String(value || "");
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code <= 0x7f) bytes++;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff
        && index + 1 < text.length
        && text.charCodeAt(index + 1) >= 0xdc00
        && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

function serializedStringByteLength(value) {
  const text = String(value || "");
  let bytes = 2;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) bytes += 2;
    else if (code <= 0x1f) bytes += 6;
    else if (code <= 0x7f) bytes++;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff
        && index + 1 < text.length
        && text.charCodeAt(index + 1) >= 0xdc00
        && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index++;
    } else if (code >= 0xd800 && code <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
}

function createBatchId() {
  return `batch:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function isPawRequest(item, senderUrl) {
  let isPawSender = false;
  if (typeof senderUrl === "string") {
    try {
      isPawSender = PAW.HOSTS.includes(new URL(senderUrl).hostname.toLowerCase());
    } catch (e) {
      isPawSender = false;
    }
  }
  return (
    item.site === "pawchive" ||
    isPawSender
  );
}

async function runSingleDownload(item, sender, tabId) {
  const senderUrl = getSenderUrl(sender);
  if (isPawRequest(item, senderUrl)) {
    return startPawchiveDownload(item.service, item.userId, item.postId, tabId, item.postData, item.requestId);
  }
  if (item.source === "coomerfans") {
    return startCoomerFansDownload(
      item.service,
      item.userId,
      item.postId,
      item.creatorName,
      tabId,
      item.requestId
    );
  }
  return startFullDownload(
    item.service,
    item.userId,
    item.postId,
    item.path,
    senderUrl,
    tabId,
    item.requestId
  );
}

function normalizedHttpUrl(value) {
  try {
    const raw = String(value || "");
    if (!raw || raw.length > MAX_HTML_URL_LENGTH) return "";
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return "";
    return parsed.toString();
  } catch (error) {
    return "";
  }
}

function boundedResultText(value, maxLength = 2048) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+/g, " ").slice(0, maxLength);
}

function projectBroadcastExternalLinks(values) {
  const links = [];
  const seen = new Set();
  const candidates = Array.isArray(values) ? values : [];
  let bytes = 2;
  let truncated = candidates.length > MAX_BROADCAST_EXTERNAL_LINKS;
  const limit = Math.min(candidates.length, MAX_BATCH_EXTERNAL_LINKS);
  for (let index = 0; index < limit; index++) {
    const url = normalizedHttpUrl(candidates[index]);
    if (!url || seen.has(url)) continue;
    const addedBytes = utf8ByteLength(url) + 4;
    if (links.length >= MAX_BROADCAST_EXTERNAL_LINKS
        || bytes + addedBytes > MAX_BROADCAST_EXTERNAL_LINK_BYTES) {
      truncated = true;
      continue;
    }
    seen.add(url);
    links.push(url);
    bytes += addedBytes;
  }
  if (candidates.length > limit) truncated = true;
  return { links, truncated };
}

export function projectDownloadResultForBroadcast(result) {
  const value = result && typeof result === "object" ? result : {};
  const results = Array.isArray(value.results) ? value.results : [];
  const countedSuccesses = results.reduce(
    (count, entry) => count + (entry && entry.success === true ? 1 : 0),
    0
  );
  const suppliedSuccessCount = Number(value.successCount);
  const successCount = Number.isFinite(suppliedSuccessCount) && suppliedSuccessCount >= 0
    ? Math.floor(suppliedSuccessCount)
    : countedSuccesses;
  const suppliedTotalCount = Number(value.totalCount);
  const totalCount = results.length > 0
    ? results.length
    : (Number.isFinite(suppliedTotalCount) && suppliedTotalCount >= 0
        ? Math.floor(suppliedTotalCount)
        : successCount);
  const dto = {
    success: value.success === true,
    successCount: Math.min(successCount, totalCount),
    totalCount,
    failedCount: Math.max(0, totalCount - successCount),
  };
  for (const flag of [
    "alreadyDownloaded", "backend", "gopeed", "noFiles", "cancelled",
    "incomplete", "skipped", "skippedByFilter",
  ]) {
    if (value[flag] === true) dto[flag] = true;
  }
  const error = boundedResultText(value.error);
  if (error) dto.error = error;
  const projectedLinks = projectBroadcastExternalLinks(value.externalLinks);
  if (projectedLinks.links.length > 0) dto.externalLinks = projectedLinks.links;
  if (projectedLinks.truncated) dto.externalLinksTruncated = true;
  return dto;
}

function broadcastComplete(item, result, tabId, requestId = item?.requestId) {
  safeBroadcast(
    {
      action: "downloadComplete",
      requestId,
      service: item.service,
      userId: item.userId,
      postId: item.postId,
      result: projectDownloadResultForBroadcast(result),
    },
    tabId
  );
}

function broadcastBatchProgress(scope, processed, total, tabId) {
  safeBroadcast(
    {
      action: "downloadProgress",
      requestId: scope.requestId,
      batch: true,
      service: scope.service,
      userId: scope.userId,
      sentCount: processed,
      totalCount: total,
      progress: Math.round((100 * processed) / Math.max(1, total)),
    },
    tabId
  );
}

function broadcastBatchError(scope, err, tabId) {
  safeBroadcast(
    {
      action: "downloadProgress",
      requestId: scope.requestId,
      batch: true,
      service: scope.service,
      userId: scope.userId,
      sentCount: 0,
      totalCount: 0,
      progress: 0,
      error: boundedResultText(err && err.message ? err.message : String(err)),
    },
    tabId
  );
}

function itemPostUrl(item, senderUrl) {
  if (item && item.postUrl) return item.postUrl;
  const service = encodeURIComponent(String(item && item.service || ""));
  const userId = encodeURIComponent(String(item && item.userId || ""));
  const postId = encodeURIComponent(String(item && item.postId || ""));
  if (item && item.source === "coomerfans") {
    return `${item.origin || API.COOMERFANS_ORIGIN}/p/${postId}/${userId}/${service}`;
  }

  let origin = item && item.origin;
  if (!origin && senderUrl) {
    try {
      origin = new URL(senderUrl).origin;
    } catch (error) {
      origin = "";
    }
  }
  if (!origin && item && item.postData) origin = PAW.ORIGIN;
  return `${origin || API.DEFAULT_ORIGIN}/${service}/user/${userId}/post/${postId}`;
}

function createExternalLinkAccumulator() {
  return {
    entries: [],
    outputLinks: new Set(),
    textBytes: 1,
  };
}

function appendExternalTextLink(accumulator, url) {
  if (accumulator.outputLinks.has(url)) return true;
  if (accumulator.outputLinks.size >= MAX_BATCH_EXTERNAL_LINKS) return false;
  const addedBytes = utf8ByteLength(url) + (accumulator.outputLinks.size > 0 ? 1 : 0);
  if (accumulator.textBytes + addedBytes > MAX_EXTERNAL_LINK_TEXT_BYTES) return false;
  accumulator.outputLinks.add(url);
  accumulator.textBytes += addedBytes;
  return true;
}

function isHashlessMegaUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return ["mega.nz", "www.mega.nz", "mega.co.nz", "www.mega.co.nz"].includes(host)
      && !parsed.hash.slice(1).trim();
  } catch (error) {
    return false;
  }
}

function collectExternalLinkEntries(accumulator, item, result, senderUrl) {
  if (!result || !Array.isArray(result.externalLinks)) return;
  const sourceUrl = normalizedHttpUrl(itemPostUrl(item, senderUrl));
  for (const value of result.externalLinks) {
    if (accumulator.entries.length >= MAX_BATCH_EXTERNAL_LINKS) break;
    const url = normalizedHttpUrl(value);
    if (!url || accumulator.outputLinks.has(url)) continue;
    if (!appendExternalTextLink(accumulator, url)) continue;
    const entry = { url };
    if (sourceUrl && isHashlessMegaUrl(url)
        && !accumulator.outputLinks.has(sourceUrl)
        && appendExternalTextLink(accumulator, sourceUrl)) {
      entry.sourceUrl = sourceUrl;
    }
    accumulator.entries.push(entry);
  }
}

async function extractItemExternalLinks(item, filterConfig) {
  let links;
  if (item.source === "coomerfans") {
    const html = await fetchCoomerFansCreatorHtml(item.postUrl || item.path);
    links = UTIL.extractExternalLinks(html);
  } else if (item.postData && typeof item.postData === "object") {
    links = UTIL.extractPostExternalLinks(item.postData);
  } else if (item.site === "pawchive") {
    links = [];
  } else {
    const origin = item.origin || API.DEFAULT_ORIGIN;
    const postUrl = `${origin}/${encodeURIComponent(item.service)}/user/${encodeURIComponent(item.userId)}/post/${encodeURIComponent(item.postId)}`;
    const apiUrl = `${origin}${API.API_PREFIX}/${encodeURIComponent(item.service)}/user/${encodeURIComponent(item.userId)}/post/${encodeURIComponent(item.postId)}`;
    const postData = await handleAPIRequest(apiUrl, {
      Accept: "text/css",
      "Content-Type": "text/css",
      Referer: postUrl,
    });
    links = UTIL.extractPostExternalLinks(postData);
  }
  return UTIL.filterExternalLinks(links, filterConfig);
}

async function runLinksOnlyBatch(items, sender, scope = {}) {
  const tabId = getSenderTabId(sender);
  const total = items.length;
  const batchId = createBatchId();
  const externalLinkEntries = createExternalLinkAccumulator();
  const filterConfig = await loadExternalLinkFilterConfig();
  let processed = 0;

  registerBatch(batchId, total);
  try {
    broadcastBatchProgress(scope, 0, total, tabId);
    for (const item of items) {
      try {
        const links = await extractItemExternalLinks(item, filterConfig);
        collectExternalLinkEntries(externalLinkEntries, item, { externalLinks: links }, getSenderUrl(sender));
        updateAcked(batchId, 1);
      } catch (error) {
        console.warn("[Background] creator links-only extraction failed", item.postId, error);
      }
      processed++;
      updateProcessed(batchId, 1);
      broadcastBatchProgress(scope, processed, total, tabId);
      await delay(200);
    }

    const linkResult = await dispatchExternalLinksTextTask(externalLinkEntries.entries, {
      fileName: scope.linksFileName,
    });
    if (!linkResult.success && !linkResult.skipped) {
      console.warn("[Background] external links TXT Chrome download failed", linkResult.error || linkResult.results);
    }
  } finally {
    completeBatch(batchId);
  }
}

function appendNativeFallbackRequest(target, budget, request) {
  const measured = measureNativeFallbackRequest(request);
  if (measured.taskCount === 0) throw new Error("No native fallback tasks");
  if (budget.requests + 1 > NATIVE_FALLBACK_LIMITS.maxRequests
      || budget.tasks + measured.taskCount > NATIVE_FALLBACK_LIMITS.maxTasksTotal
      || budget.externalLinks + measured.externalLinkCount > NATIVE_FALLBACK_LIMITS.maxExternalLinksTotal
      || budget.bytes + measured.bytes > NATIVE_FALLBACK_LIMITS.maxStorageBytes) {
    throw new Error("Native fallback batch exceeds the 5,000 task or 8 MiB safety limit");
  }
  target.push(request);
  budget.requests++;
  budget.tasks += measured.taskCount;
  budget.externalLinks += measured.externalLinkCount;
  budget.bytes += measured.bytes;
}

async function runDownloadBatch(items, sender, scope = {}) {
  const tabId = getSenderTabId(sender);
  const senderUrl = getSenderUrl(sender);
  const total = items.length;
  const historyRecords = [];
  const fallbackRequests = [];
  const fallbackBudget = { requests: 0, tasks: 0, externalLinks: 0, bytes: 0 };
  const externalLinkEntries = createExternalLinkAccumulator();
  const batchId = createBatchId();
  let processed = 0;
  const progressScope = {
    service: scope.service || (items[0] && items[0].service),
    userId: scope.userId || (items[0] && items[0].userId),
    requestId: scope.requestId,
  };

  registerBatch(batchId, total);
  try {
    broadcastBatchProgress(progressScope, 0, total, tabId);
    if (total === 0) return;

    for (const item of items) {
      try {
        const result = await runSingleDownload(item, sender, tabId);
        if (scope.aggregateExternalLinks === true) {
          collectExternalLinkEntries(externalLinkEntries, item, result, senderUrl);
        }
        if (result && result.backendFailed && Array.isArray(result.fallbackTasks)) {
          try {
            appendNativeFallbackRequest(fallbackRequests, fallbackBudget, {
              item: {
                source: item.source,
                service: item.service,
                userId: item.userId,
                postId: item.postId,
                requestId: scope.requestId,
              },
              tasks: result.fallbackTasks,
              externalLinks: result.externalLinks,
              tabId,
            });
          } catch (error) {
            broadcastComplete(item, {
              success: false,
              error: error && error.message ? error.message : String(error),
            }, tabId, scope.requestId);
          }
        } else {
          broadcastComplete(item, result, tabId, scope.requestId);
          const historyRecord = buildDownloadHistoryRecord(item, result);
          if (historyRecord) {
            historyRecords.push(historyRecord);
            if (historyRecord.status !== "partial") updateAcked(batchId, 1);
          }
        }
      } catch (err) {
        broadcastComplete(
          item,
          {
            success: false,
            error: err && err.message ? err.message : String(err),
          },
          tabId,
          scope.requestId
        );
      }

      processed++;
      updateProcessed(batchId, 1);
      broadcastBatchProgress(progressScope, processed, total, tabId);
      await delay(200);
    }

    if (historyRecords.length > 0) {
      try {
        await markMultipleDownloaded(historyRecords);
      } catch (err) {
        console.warn("[Background] markMultipleDownloaded failed", err);
      }
    }
    if (fallbackRequests.length > 0) {
      try {
        await enqueueNativeFallback(fallbackRequests);
      } catch (err) {
        for (const request of fallbackRequests) {
          broadcastComplete(request.item, {
            success: false,
            error: err && err.message ? err.message : String(err),
          }, request.tabId);
        }
      }
    }
    if (scope.aggregateExternalLinks === true && externalLinkEntries.entries.length > 0) {
      try {
        const linkResult = await dispatchExternalLinksTextTask(externalLinkEntries.entries, {
          fileName: scope.linksFileName,
          origin: scope.origin,
          referer: scope.referer,
          service: progressScope.service,
          userId: progressScope.userId,
          postId: scope.linksPostId,
        });
        if (!linkResult.success && !linkResult.skipped) {
          console.warn("[Background] external links TXT Chrome download failed", linkResult.error || linkResult.results);
        }
      } catch (err) {
        console.warn("[Background] external links TXT task failed", err);
      }
    }
  } finally {
    completeBatch(batchId);
  }
}

function fallbackProgress(request, progress) {
  safeBroadcast({
    action: "downloadProgress",
    requestId: request.item.requestId,
    service: request.item.service,
    userId: request.item.userId,
    postId: request.item.postId,
    progress: Math.round((100 * progress.processed) / Math.max(1, progress.total)),
    sentCount: progress.processed,
    totalCount: progress.total,
  }, request.tabId);
}

function fallbackCancelledMessage() {
  try {
    return chrome.i18n.getMessage("nativeFallbackCancelled") || "Chrome fallback download cancelled";
  } catch (error) {
    return "Chrome fallback download cancelled";
  }
}

async function completeNativeFallbackRequest(request, shouldContinue) {
  if (!shouldContinue) {
    broadcastComplete(request.item, {
      success: false,
      cancelled: true,
      error: fallbackCancelledMessage(),
    }, request.tabId);
    return;
  }

  try {
    const { successCount, results } = await runSequentialDownloads(
      request.tasks,
      (progress) => fallbackProgress(request, progress)
    );
    const result = {
      success: successCount > 0,
      successCount,
      results,
      externalLinks: request.externalLinks,
      error: successCount > 0 ? undefined : "Chrome downloads failed",
    };
    const historyRecord = buildDownloadHistoryRecord(request.item, result);
    if (historyRecord) {
      try {
        await markDownloaded(historyRecord);
      } catch (error) {
        console.warn("[Background] native fallback history write failed", error);
      }
    }
    broadcastComplete(request.item, result, request.tabId);
  } catch (error) {
    broadcastComplete(request.item, {
      success: false,
      error: error && error.message ? error.message : String(error),
    }, request.tabId);
  }
}

export async function handleNativeFallbackDecision(notificationId, shouldContinue) {
  const pending = await takeNativeFallback(notificationId);
  if (!pending) return false;
  await clearNativeFallbackNotification(notificationId);
  for (const request of (pending.requests || []).slice(0, 5000)) {
    await completeNativeFallbackRequest(request, shouldContinue === true);
  }
  return true;
}

export function projectCreatorPost(post, includePostData = false) {
  if (!post || typeof post !== "object" || Array.isArray(post)) return null;
  const id = String(post.id ?? "").trim();
  if (!id || id.length > 512 || /[\x00-\x1f\x7f]/.test(id)
      || UTIL.hasUnpairedSurrogate(id, 512)) return null;
  const projected = { id };
  const path = typeof post.file?.path === "string" ? post.file.path.trim() : "";
  if (path && path.length <= MAX_HTML_URL_LENGTH && !/[\x00-\x1f\x7f]/.test(path)
      && !UTIL.hasUnpairedSurrogate(path, MAX_HTML_URL_LENGTH)) {
    projected.file = { path };
  }
  if (includePostData) {
    if (typeof post.content === "string" && post.content) projected.content = post.content;
    if (typeof post.embed?.url === "string" && post.embed.url) {
      projected.embed = { url: post.embed.url };
    }
  }
  return projected;
}

function creatorPostRetainedBytes(post) {
  let bytes = 256 + serializedStringByteLength(post.id);
  if (post.file) bytes += 64 + serializedStringByteLength(post.file.path);
  if (typeof post.content === "string") bytes += 32 + serializedStringByteLength(post.content);
  if (post.embed) bytes += 64 + serializedStringByteLength(post.embed.url);
  return bytes;
}

function postToDownloadItem(origin, service, userId, post, includePostData = false) {
  const item = {
    service,
    userId,
    postId: String(post.id),
    path: `${origin}${post.file && post.file.path ? post.file.path : ""}`,
    origin,
    postUrl: `${origin}/${encodeURIComponent(service)}/user/${encodeURIComponent(userId)}/post/${encodeURIComponent(String(post.id))}`,
  };
  if (includePostData) item.postData = post;
  return item;
}

function pawPostToDownloadItem(service, userId, post) {
  return {
    source: "default",
    site: "pawchive",
    service,
    userId,
    postId: String(post.id),
    postData: post,
    origin: PAW.ORIGIN,
    postUrl: `${PAW.ORIGIN}/${encodeURIComponent(service)}/user/${encodeURIComponent(userId)}/post/${encodeURIComponent(String(post.id))}`,
  };
}

function isCoomerFansOrigin(origin) {
  try {
    const url = new URL(origin || API.COOMERFANS_ORIGIN);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && !url.port
      && (host === API.COOMERFANS_HOST || host.endsWith(`.${API.COOMERFANS_HOST}`));
  } catch (e) {
    return false;
  }
}

function coomerFansCreatorUrl(origin, service, userId, creatorName) {
  const name = creatorName ? `/${encodeURIComponent(creatorName)}` : "";
  return `${origin}/u/${encodeURIComponent(service)}/${encodeURIComponent(userId)}${name}`;
}

function getCoomerFansPostIdentity(rawUrl, expectedService, expectedUserId) {
  try {
    const u = new URL(rawUrl, API.COOMERFANS_ORIGIN);
    if (!isCoomerFansOrigin(u.toString())) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    const service = String(expectedService || "").toLowerCase();
    if (
      parts.length >= 4 &&
      parts[0] === "p" &&
      parts[2] === String(expectedUserId) &&
      parts[3].toLowerCase() === service
    ) {
      return { postId: parts[1], postUrl: u.toString() };
    }
    if (
      parts.length >= 5 &&
      parts[0].toLowerCase() === service &&
      parts[1] === "user" &&
      parts[2] === String(expectedUserId) &&
      parts[3] === "post"
    ) {
      return { postId: parts[4], postUrl: u.toString() };
    }
  } catch (e) {
    /* ignore malformed links */
  }
  return null;
}

async function fetchCoomerFansCreatorHtml(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new Error("Invalid CoomerFans URL");
  }
  if (!isCoomerFansOrigin(parsed.toString())) throw new Error("Unexpected CoomerFans URL");
  const headers = {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Cache-Control": "no-cache",
    "User-Agent": "Mozilla/5.0",
  };
  const resp = await fetch(parsed.toString(), {
    method: "GET",
    headers,
    credentials: "include",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(45 * 1000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return readLimitedResponseText(resp, 16 * 1024 * 1024, "CoomerFans");
}

function isHtmlNameCode(code) {
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || code === 45
    || code === 58;
}

function anchorHref(tagText) {
  let cursor = 1;
  while (cursor < tagText.length && !/\s/.test(tagText[cursor]) && tagText[cursor] !== ">") cursor++;
  while (cursor < tagText.length) {
    while (cursor < tagText.length && /\s/.test(tagText[cursor])) cursor++;
    if (cursor >= tagText.length || tagText[cursor] === ">") return "";
    if (tagText[cursor] === "/") {
      cursor++;
      continue;
    }

    const nameStart = cursor;
    while (cursor < tagText.length && !/[\s"'=<>`/]/.test(tagText[cursor])) cursor++;
    if (cursor === nameStart) {
      cursor++;
      continue;
    }
    const name = tagText.slice(nameStart, cursor).toLowerCase();
    while (cursor < tagText.length && /\s/.test(tagText[cursor])) cursor++;

    let value = "";
    if (tagText[cursor] === "=") {
      cursor++;
      while (cursor < tagText.length && /\s/.test(tagText[cursor])) cursor++;
      const quote = tagText[cursor] === '"' || tagText[cursor] === "'" ? tagText[cursor++] : "";
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
    if (name === "href") return value.length <= MAX_HTML_URL_LENGTH ? value : "";
  }
  return "";
}

function forEachAnchorHref(input, visitor) {
  const source = String(input || "");
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf("<", cursor);
    if (start < 0) return;
    const nameStart = start + 1;
    let nameEnd = nameStart;
    while (nameEnd < source.length && isHtmlNameCode(source.charCodeAt(nameEnd))) nameEnd++;
    if (nameEnd - nameStart !== 1 || (source.charCodeAt(nameStart) | 32) !== 97) {
      cursor = Math.max(nameEnd, nameStart);
      continue;
    }

    let quote = "";
    let end = nameEnd;
    let restart = -1;
    const limit = Math.min(source.length, start + MAX_HTML_TAG_LENGTH + 1);
    for (; end < limit; end++) {
      const char = source[end];
      if (quote) {
        if (char === quote) quote = "";
        continue;
      }
      if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
      else if (char === "<") {
        restart = end;
        break;
      }
    }
    if (restart >= 0) {
      cursor = restart;
      continue;
    }
    if (end >= limit || source[end] !== ">") {
      cursor = limit;
      continue;
    }

    const href = anchorHref(source.slice(start, end + 1));
    if (href && visitor(href) === false) return;
    cursor = end + 1;
  }
}

async function fetchCoomerFansCreatorItems(origin, service, userId, creatorName) {
  const baseProfile = coomerFansCreatorUrl(origin, service, userId, creatorName);
  const perPage = 50;
  const maxPages = 200;
  const maxRequests = 400;
  const maxConsecutiveFailures = 8;
  const maxPosts = MAX_CREATOR_POSTS;
  const postMap = new Map();
  let requestCount = 0;
  let consecutiveFailures = 0;

  for (let pageIdx = 1; pageIdx <= maxPages; pageIdx++) {
    const candidates = pageIdx === 1 ? [baseProfile] : [];
    candidates.push(`${baseProfile}?page=${pageIdx}`);
    candidates.push(`${baseProfile}?o=${(pageIdx - 1) * perPage}`);

    let fetchedAny = false;
    let foundThisPage = 0;
    for (const listUrl of candidates) {
      if (requestCount >= maxRequests) break;
      try {
        requestCount++;
        const html = await fetchCoomerFansCreatorHtml(listUrl);
        fetchedAny = true;
        consecutiveFailures = 0;
        forEachAnchorHref(html, (rawHref) => {
          const href = rawHref.replace(/&amp;/g, "&");
          const identity = getCoomerFansPostIdentity(href, service, userId);
          if (!identity || postMap.has(identity.postId)) return true;
          postMap.set(identity.postId, {
            source: "coomerfans",
            service,
            userId,
            postId: identity.postId,
            path: identity.postUrl,
            postUrl: identity.postUrl,
            origin,
            creatorName,
          });
          foundThisPage++;
          return postMap.size < maxPosts;
        });
        if (foundThisPage > 0) break;
      } catch (err) {
        consecutiveFailures++;
        console.warn("[Background] fetch CoomerFans listing failed", listUrl, err);
        if (consecutiveFailures >= maxConsecutiveFailures) break;
        await delay(Math.min(2000, 200 * consecutiveFailures));
      }
    }
    if (requestCount >= maxRequests || consecutiveFailures >= maxConsecutiveFailures
        || postMap.size >= maxPosts) break;
    if (!fetchedAny) break;

    if (foundThisPage === 0) break;
    await delay(200);
  }

  return Array.from(postMap.values());
}

async function filterUndownloaded(items) {
  const downloaded = await checkDownloadedMany(items);
  return items.filter((item) => {
    const key = downloadedItemKey(item.service, item.userId, item.postId, item.source);
    return !downloaded[key];
  });
}

async function runFilteredDownloadBatch(allItems, sender, scope = {}) {
  const items = scope.fullMode === true ? allItems : await filterUndownloaded(allItems);
  await runDownloadBatch(items, sender, scope);
}

async function runCreatorFetchBatch(allItems, sender, scope = {}) {
  if (scope.mode === "links") {
    await runLinksOnlyBatch(allItems, sender, scope);
    return;
  }
  await runFilteredDownloadBatch(allItems, sender, scope);
}

async function runPawchiveDmsFetch(service, userId, sender, scope) {
  const tabId = getSenderTabId(sender);
  const batchId = createBatchId();
  registerBatch(batchId, 1);
  try {
    broadcastBatchProgress(scope, 0, 1, tabId);
    const { url, messages } = await fetchPawchiveDms(service, userId);
    const text = formatPawchiveDmsText(messages, {
      service,
      userId,
      sourceUrl: url,
    });
    const result = await dispatchTextDownloadTask(text, {
      fileName: `${service}_${userId}_dms.txt`,
      type: "pawchive_dms_txt",
    });
    if (!result.success) throw new Error(result.error || "Pawchive DMs TXT download failed");
    updateAcked(batchId, 1);
    updateProcessed(batchId, 1);
    broadcastBatchProgress(scope, 1, 1, tabId);
  } finally {
    completeBatch(batchId);
  }
}

function linksFileName(kind, service, userId, qualifier = "") {
  const suffix = qualifier === "" || qualifier === null || qualifier === undefined ? "" : `_${qualifier}`;
  return `${service}_${userId}_${kind}${suffix}_links.txt`;
}

function runAcceptedTask(label, task, scope, tabId, requestToken) {
  task().catch((err) => {
    console.error(`[Background] ${label} failed`, err);
    broadcastBatchError(scope, err, tabId);
  }).finally(() => {
    completeAcceptedRequest(requestToken);
  });
}

async function fetchCreatorPosts(origin, service, userId, options = {}) {
  const encodedService = encodeURIComponent(service);
  const encodedUserId = encodeURIComponent(userId);
  const headers = {
    Accept: "text/css",
    "Content-Type": "text/css",
    Referer: `${origin}/${encodedService}/user/${encodedUserId}`,
  };
  const profileUrl = `${origin}${API.API_PREFIX}/${encodedService}/user/${encodedUserId}/profile`;
  const profile = await handleAPIRequest(profileUrl, headers);
  const postCount = Math.min(
    10000,
    profile && Number.isFinite(profile.post_count)
      ? Math.max(0, Math.floor(profile.post_count))
      : 0
  );
  const perPage = 50;
  const postMap = new Map();
  let consecutiveFailures = 0;
  let retainedBytes = 0;
  const requestedRetainedBytes = Number(options.maxRetainedBytes);
  const maxRetainedBytes = Number.isFinite(requestedRetainedBytes) && requestedRetainedBytes > 0
    ? Math.min(MAX_CREATOR_RETAINED_BYTES, Math.floor(requestedRetainedBytes))
    : MAX_CREATOR_RETAINED_BYTES;
  const includePostData = options.includePostData === true;

  for (let offset = 0; offset < postCount && postMap.size < MAX_CREATOR_POSTS; offset += perPage) {
    let pageData;
    try {
      const url = `${origin}${API.API_PREFIX}/${encodedService}/user/${encodedUserId}/posts?o=${offset}`;
      pageData = await handleAPIRequest(url, headers);
      if (!Array.isArray(pageData)) throw new Error("Invalid creator posts response");
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      console.warn("[Background] fetch creator posts page failed", err);
      if (consecutiveFailures >= 5) break;
      continue;
    }
    for (const post of pageData) {
      if (postMap.size >= MAX_CREATOR_POSTS) break;
      const projected = projectCreatorPost(post, includePostData);
      if (!projected || postMap.has(projected.id)) continue;
      const postBytes = creatorPostRetainedBytes(projected);
      if (retainedBytes + postBytes > maxRetainedBytes) {
        throw new Error("Creator posts exceed the 64 MiB retained-data safety limit");
      }
      postMap.set(projected.id, projected);
      retainedBytes += postBytes;
    }
    await delay(200);
  }

  return Array.from(postMap.values());
}

async function fetchCreatorPage(origin, service, userId, offset) {
  if (isPawOrigin(origin)) {
    return (await fetchPawchiveCreatorPage(service, userId, offset || 0))
      .slice(0, MAX_CREATOR_PAGE_POSTS);
  }
  const headers = {
    Accept: "text/css",
    "Content-Type": "text/css",
    Referer: `${origin}/${encodeURIComponent(service)}/user/${encodeURIComponent(userId)}`,
  };
  const suffix = offset ? `?o=${offset}` : "";
  const url = `${origin}${API.API_PREFIX}/${encodeURIComponent(service)}/user/${encodeURIComponent(userId)}/posts${suffix}`;
  try {
    const pageData = await handleAPIRequest(url, headers);
    return Array.isArray(pageData) ? pageData.slice(0, MAX_CREATOR_PAGE_POSTS) : [];
  } catch (err) {
    console.warn("[Background] creator.pageFetch request failed", err);
    return [];
  }
}

function isPawOrigin(origin) {
  try {
    return new URL(origin).origin === PAW.ORIGIN;
  } catch (error) {
    return false;
  }
}

function normalizeSupportedOrigin(value) {
  const url = new URL(String(value || API.DEFAULT_ORIGIN));
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("Unsupported creator origin");
  }
  const host = url.hostname.toLowerCase();
  if (host === PAW.HOST) return PAW.ORIGIN;
  if (API.HOSTS.includes(host)) return `https://${host}`;
  if (host === API.COOMERFANS_HOST || host.endsWith(`.${API.COOMERFANS_HOST}`)) {
    return API.COOMERFANS_ORIGIN;
  }
  throw new Error("Unsupported creator origin");
}

function requiredIdentity(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 512 || /[\x00-\x1f\x7f]/.test(normalized)
      || UTIL.hasUnpairedSurrogate(normalized, 512)) {
    throw new Error(`Invalid ${label}`);
  }
  return normalized;
}

function optionalShortString(value, maxLength = 512) {
  if (value === undefined || value === null || value === "") return undefined;
  const normalized = String(value).trim();
  if (!normalized || normalized.length > maxLength || /[\x00-\x1f\x7f]/.test(normalized)
      || UTIL.hasUnpairedSurrogate(normalized, maxLength)) {
    throw new Error("Invalid download metadata");
  }
  return normalized;
}

function normalizeDownloadItem(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid download item");
  }
  const declaredSource = optionalShortString(value.source, 32);
  if (declaredSource && !["default", "pawchive", "coomerfans"].includes(declaredSource)) {
    throw new Error("Unsupported download source");
  }
  // Pawchive shares the default history namespace. Accept the briefly emitted
  // legacy label at the RPC boundary without persisting it as a third source.
  const source = declaredSource === "pawchive" ? "default" : declaredSource;
  const item = {
    service: requiredIdentity(value.service, "service"),
    userId: requiredIdentity(value.userId, "creator id"),
    postId: requiredIdentity(value.postId, "post id"),
    path: optionalShortString(value.path, 8192),
    source,
    creatorName: optionalShortString(value.creatorName, 512),
    requestId: normalizeRequestId(value.requestId),
  };
  if (source === "coomerfans") {
    const identity = getCoomerFansPostIdentity(item.path, item.service, item.userId);
    if (!identity) throw new Error("Invalid CoomerFans post URL");
    if (identity.postId !== item.postId) {
      throw new Error("CoomerFans post URL identity does not match the download item");
    }
  }
  return item;
}

function requireDownloadItemSenderMatch(item, sender) {
  let host;
  try {
    host = new URL(getSenderUrl(sender)).hostname.toLowerCase();
  } catch (error) {
    throw new Error("Download source does not match the sending site");
  }
  const isCoomerFansSender = host === API.COOMERFANS_HOST
    || host.endsWith(`.${API.COOMERFANS_HOST}`);
  const matches = isCoomerFansSender
    ? item.source === "coomerfans"
    : item.source === undefined || item.source === "default";
  if (!matches) throw new Error("Download source does not match the sending site");
}

function normalizePageOffset(value) {
  if (value === undefined || value === null || value === "") return 0;
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000) {
    throw new Error("Invalid creator page offset");
  }
  return offset;
}

function normalizeRequestId(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Invalid request id");
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || /[\x00-\x1f\x7f]/.test(normalized)) {
    throw new Error("Invalid request id");
  }
  return normalized;
}

function resolveOrigin(message, sender) {
  const senderUrl = getSenderUrl(sender);
  if (senderUrl) {
    try {
      return normalizeSupportedOrigin(new URL(senderUrl).origin);
    } catch (e) {
      /* fall through */
    }
  }
  return normalizeSupportedOrigin(message.origin || API.DEFAULT_ORIGIN);
}

export function createDownloadHandlers() {
  return {
    startDownload: ({ message, sender, sendResponse }) => {
      let item;
      let requestRegistration;
      try {
        requireTrustedWebSender(
          sender,
          DOWNLOAD_CONTENT_HOSTS,
          "Post downloads",
          { allowSubdomains: true }
        );
        item = normalizeDownloadItem(message);
        requireDownloadItemSenderMatch(item, sender);
        requestRegistration = beginAcceptedRequest("startDownload", item.requestId, sender);
        sendResponse({ success: true, accepted: true });
      } catch (error) {
        sendResponse({ success: false, error: error.message || String(error) });
        return false;
      }
      if (requestRegistration.duplicate) return false;

      (async () => {
        const tabId = getSenderTabId(sender);
        try {
          const result = await runSingleDownload(item, sender, tabId);
          if (result && result.backendFailed && Array.isArray(result.fallbackTasks)) {
            try {
              await enqueueNativeFallback({
                item,
                tasks: result.fallbackTasks,
                externalLinks: result.externalLinks,
                tabId,
              });
            } catch (error) {
              broadcastComplete(item, {
                success: false,
                error: error && error.message ? error.message : String(error),
              }, tabId);
            }
            return;
          }
          const historyRecord = buildDownloadHistoryRecord(item, result);
          if (historyRecord) {
            try {
              await markDownloaded(historyRecord);
            } catch (err) {
              console.warn("[Background] markDownloaded failed", err);
            }
          }
          broadcastComplete(item, result, tabId);
        } catch (err) {
          broadcastComplete(
            item,
            {
              success: false,
              error: err && err.message ? err.message : String(err),
            },
            tabId
          );
        } finally {
          completeAcceptedRequest(requestRegistration.token);
        }
      })();
      return false;
    },

    startDownloadBatch: ({ message, sender, sendResponse }) => {
      let items;
      let scope;
      let requestRegistration;
      try {
        requireTrustedWebSender(
          sender,
          DOWNLOAD_CONTENT_HOSTS,
          "Download batches",
          { allowSubdomains: true }
        );
        if (!Array.isArray(message.items) || message.items.length === 0 || message.items.length > 5000) {
          throw new Error("Invalid or oversized download batch");
        }
        items = message.items.map(normalizeDownloadItem);
        for (const item of items) requireDownloadItemSenderMatch(item, sender);
        const first = items[0];
        const service = message.service
          ? requiredIdentity(message.service, "service")
          : first.service;
        const userId = message.userId
          ? requiredIdentity(message.userId, "creator id")
          : first.userId;
        if (items.some((item) => item.service !== service || item.userId !== userId)) {
          throw new Error("Mixed-creator download batches are not supported");
        }
        scope = {
          service,
          userId,
          aggregateExternalLinks: message.aggregateExternalLinks === true,
          linksFileName: optionalShortString(message.linksFileName, 512),
          linksPostId: optionalShortString(message.linksPostId, 512),
          requestId: normalizeRequestId(message.requestId),
        };
        requestRegistration = beginAcceptedRequest(
          "startDownloadBatch",
          scope.requestId,
          sender
        );
        sendResponse({ success: true, accepted: true });
      } catch (error) {
        sendResponse({ success: false, error: error.message || String(error) });
        return false;
      }
      if (requestRegistration.duplicate) return false;
      const tabId = getSenderTabId(sender);
      runAcceptedTask(
        "startDownloadBatch",
        () => runDownloadBatch(items, sender, scope),
        scope,
        tabId,
        requestRegistration.token
      );
      return false;
    },

    "creator.fetch": ({ message, sender, sendResponse }) => {
      let origin;
      let service;
      let userId;
      let creatorName;
      let requestId;
      let requestRegistration;
      const mode = UTIL.normalizeCreatorFetchMode(message.mode, message.fullMode);
      try {
        requireExtensionPage(sender, "Creator Fetch");
        origin = normalizeSupportedOrigin(message.origin || API.DEFAULT_ORIGIN);
        service = requiredIdentity(message.service, "service");
        userId = requiredIdentity(message.userId, "creator id");
        creatorName = optionalShortString(message.creatorName, 512);
        requestId = normalizeRequestId(message.requestId);
        if (mode === "dms" && !isPawOrigin(origin)) {
          throw new Error("DM fetch is available only for Pawchive creator URLs");
        }
        if (message.source === "coomerfans" && !isCoomerFansOrigin(origin)) {
          throw new Error("Invalid CoomerFans creator origin");
        }
        requestRegistration = beginAcceptedRequest("creator.fetch", requestId, sender);
        sendResponse({ success: true, accepted: true });
      } catch (error) {
        sendResponse({ success: false, error: error.message || String(error) });
        return false;
      }
      if (requestRegistration.duplicate) return false;
      const tabId = getSenderTabId(sender);
      runAcceptedTask("creator.fetch", async () => {
        const scope = {
          service,
          userId,
          origin,
          referer: `${origin}/${encodeURIComponent(service)}/user/${encodeURIComponent(userId)}`,
          mode,
          fullMode: mode === "full",
          aggregateExternalLinks: true,
          linksFileName: linksFileName("creator", service, userId),
          linksPostId: "creator-links",
          requestId,
        };

        if (mode === "dms") {
          await runPawchiveDmsFetch(service, userId, sender, scope);
          return;
        }

        if (message.source === "coomerfans" || isCoomerFansOrigin(origin)) {
          const allItems = await fetchCoomerFansCreatorItems(origin, service, userId, creatorName);
          await runCreatorFetchBatch(allItems, sender, scope);
          return;
        }

        if (isPawOrigin(origin)) {
          const posts = await fetchAllPawchiveCreatorPosts(service, userId);
          const allItems = posts
            .filter(isCompletePawchivePost)
            .map((post) => pawPostToDownloadItem(service, userId, post));
          await runCreatorFetchBatch(allItems, sender, scope);
          return;
        }

        const posts = await fetchCreatorPosts(origin, service, userId, {
          includePostData: mode === "links",
        });
        const allItems = posts.map((post) =>
          postToDownloadItem(origin, service, userId, post, mode === "links")
        );
        await runCreatorFetchBatch(allItems, sender, scope);
      }, { service, userId, requestId }, tabId, requestRegistration.token);
      return false;
    },

    "creator.pageFetch": ({ message, sender, sendResponse }) => {
      let service;
      let userId;
      let origin;
      let offset;
      let requestId;
      let requestRegistration;
      try {
        requireTrustedWebSender(
          sender,
          DOWNLOAD_CONTENT_HOSTS,
          "Creator page downloads",
          { allowSubdomains: true }
        );
        service = requiredIdentity(message.service, "service");
        userId = requiredIdentity(message.userId, "creator id");
        origin = resolveOrigin(message, sender);
        offset = normalizePageOffset(message.offset);
        requestId = normalizeRequestId(message.requestId);
        requestRegistration = beginAcceptedRequest("creator.pageFetch", requestId, sender);
        sendResponse({ success: true, accepted: true });
      } catch (error) {
        sendResponse({ success: false, error: error.message || String(error) });
        return false;
      }
      if (requestRegistration.duplicate) return false;
      const tabId = getSenderTabId(sender);
      runAcceptedTask("creator.pageFetch", async () => {
        const posts = await fetchCreatorPage(origin, service, userId, offset);
        const allItems = isPawOrigin(origin)
          ? posts.filter(isCompletePawchivePost).map((post) => pawPostToDownloadItem(service, userId, post))
          : posts.filter((post) => post && post.id).map((post) => postToDownloadItem(origin, service, userId, post));
        await runFilteredDownloadBatch(allItems, sender, {
          service,
          userId,
          origin,
          referer: `${origin}/${encodeURIComponent(service)}/user/${encodeURIComponent(userId)}`,
          aggregateExternalLinks: true,
          linksFileName: linksFileName("page", service, userId, offset),
          linksPostId: `page-links-${offset}`,
          requestId,
        });
      }, { service, userId, requestId }, tabId, requestRegistration.token);
      return false;
    },
  };
}
