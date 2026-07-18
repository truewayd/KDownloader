// background/pawchive.js - Pawchive JSON API and file-task parsing
import { PAW } from './constants.js';
import { fetchPawchiveJson } from './network.js';
import UTIL from './util.js';

function requiredPart(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`Missing Pawchive ${label}`);
  return encodeURIComponent(normalized);
}

export function pawchiveCreatorApiUrl(service, userId, offset = 0) {
  const suffix = Number(offset) > 0 ? `?o=${Math.floor(Number(offset) / PAW.PAGE_SIZE) * PAW.PAGE_SIZE}` : '';
  return `${PAW.ORIGIN}${PAW.API_PREFIX}/${requiredPart(service, 'service')}/user/${requiredPart(userId, 'user id')}${suffix}`;
}

export function pawchivePostApiUrl(service, userId, postId) {
  return `${PAW.ORIGIN}${PAW.API_PREFIX}/${requiredPart(service, 'service')}/user/${requiredPart(userId, 'user id')}/post/${requiredPart(postId, 'post id')}`;
}

function normalizePostResponse(value) {
  if (value && value.post && typeof value.post === 'object') {
    return {
      ...value.post,
      attachments: Array.isArray(value.attachments) ? value.attachments : value.post.attachments,
    };
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export async function fetchPawchivePost(service, userId, postId) {
  const post = normalizePostResponse(await fetchPawchiveJson(pawchivePostApiUrl(service, userId, postId)));
  if (!post || String(post.id || '') !== String(postId)) {
    throw new Error('Invalid Pawchive post response');
  }
  return post;
}

export async function fetchPawchiveCreatorPage(service, userId, offset = 0) {
  const value = await fetchPawchiveJson(pawchiveCreatorApiUrl(service, userId, offset));
  if (!Array.isArray(value)) throw new Error('Invalid Pawchive creator page response');
  return value.filter((post) => post && post.id);
}

export async function fetchAllPawchiveCreatorPosts(service, userId, options = {}) {
  const maxPages = Math.max(1, Math.min(1000, Number(options.maxPages) || 200));
  const posts = new Map();

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    const offset = pageIndex * PAW.PAGE_SIZE;
    const page = await fetchPawchiveCreatorPage(service, userId, offset);
    let added = 0;
    for (const post of page) {
      const id = String(post.id);
      if (posts.has(id)) continue;
      posts.set(id, post);
      added++;
    }
    if (typeof options.onPage === 'function') {
      await options.onPage({ offset, page, total: posts.size });
    }
    if (page.length < PAW.PAGE_SIZE || added === 0) break;
  }

  return Array.from(posts.values());
}

export function isCompletePawchivePost(post) {
  return !!post && post.has_full === true;
}

function pawchiveFileUrl(path) {
  const normalized = String(path || '').trim();
  if (!normalized) return '';
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `${PAW.FILE_ORIGIN}/data${withSlash}`;
}

export function buildPawchiveDownloadTasks(post) {
  if (!isCompletePawchivePost(post)) return [];
  const tasks = [];
  const seenPaths = new Set();
  const candidates = [post && post.file, ...(Array.isArray(post && post.attachments) ? post.attachments : [])];

  for (const candidate of candidates) {
    if (!candidate || !candidate.path || seenPaths.has(candidate.path)) continue;
    const url = pawchiveFileUrl(candidate.path);
    if (!url) continue;
    seenPaths.add(candidate.path);
    const fallbackName = String(candidate.path).split('/').filter(Boolean).pop() || 'Untitled';
    tasks.push({
      url,
      fileName: UTIL.sanitizeFileName(candidate.name || fallbackName),
      type: candidate === post.file ? 'file' : 'attachment',
    });
  }

  return tasks;
}
