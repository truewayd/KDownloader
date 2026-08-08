// background/pawchive.js - Pawchive JSON API and file-task parsing
import { PAW } from './constants.js';
import { fetchPawchiveDmsHtml, fetchPawchiveJson } from './network.js';
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

export function pawchiveDmsUrl(service, userId) {
  return `${PAW.ORIGIN}/${requiredPart(service, 'service')}/user/${requiredPart(userId, 'user id')}/dms`;
}

function decodeHtmlEntities(value) {
  const named = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
  };
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
    if (code[0] !== '#') return named[code.toLowerCase()] ?? entity;
    const numeric = code[1].toLowerCase() === 'x'
      ? Number.parseInt(code.slice(2), 16)
      : Number.parseInt(code.slice(1), 10);
    return Number.isFinite(numeric) && numeric > 0 && numeric <= 0x10ffff
      ? String.fromCodePoint(numeric)
      : entity;
  });
}

function plainTextFromHtml(fragment) {
  const withLinks = String(fragment || '').replace(
    /<a\b([^>]*)>([\s\S]*?)<\/a>/gi,
    (match, attributes, body) => {
      const hrefMatch = attributes.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const label = plainTextFromHtml(body);
      const href = decodeHtmlEntities(hrefMatch && (hrefMatch[1] || hrefMatch[2] || hrefMatch[3]) || '').trim();
      if (!href || label === href) return label || href;
      return label ? `${label} (${href})` : href;
    }
  );
  return decodeHtmlEntities(withLinks
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(?:p|div|li|section|blockquote)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ''))
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .filter((line, index, lines) => line || (index > 0 && lines[index - 1]))
    .join('\n')
    .trim();
}

function classBody(fragment, tagName, className) {
  const pattern = new RegExp(
    `<${tagName}\\b[^>]*class\\s*=\\s*(?:"[^"]*\\b${className}\\b[^"]*"|'[^']*\\b${className}\\b[^']*')[^>]*>([\\s\\S]*?)<\\/${tagName}>`,
    'i'
  );
  const match = pattern.exec(fragment);
  return match ? match[1] : '';
}

export function parsePawchiveDmsHtml(html) {
  const messages = [];
  const cardPattern = /<article\b[^>]*class\s*=\s*(?:"[^"]*\bdm-card\b[^"]*"|'[^']*\bdm-card\b[^']*')[^>]*>([\s\S]*?)<\/article>/gi;
  let match;
  while ((match = cardPattern.exec(String(html || ''))) !== null) {
    const content = plainTextFromHtml(classBody(match[1], 'div', 'dm-card__content'));
    const added = plainTextFromHtml(classBody(match[1], 'div', 'dm-card__added'));
    const published = added.replace(/^Published\s*:\s*/i, '').trim();
    if (content || published) messages.push({ published, text: content });
  }
  return messages;
}

export function formatPawchiveDmsText(messages, context = {}) {
  const items = Array.isArray(messages) ? messages : [];
  const lines = [
    'Pawchive DMs',
    `Service: ${String(context.service || '')}`,
    `User: ${String(context.userId || '')}`,
    `Source: ${String(context.sourceUrl || '')}`,
    `Messages: ${items.length}`,
    '',
  ];
  items.forEach((message, index) => {
    lines.push(`[${message.published || 'Unknown date'}]`);
    if (message.text) lines.push(message.text);
    if (index < items.length - 1) lines.push('', '---', '');
  });
  return `${lines.join('\n').trimEnd()}\n`;
}

export async function fetchPawchiveDms(service, userId) {
  const url = pawchiveDmsUrl(service, userId);
  const html = await fetchPawchiveDmsHtml(url);
  return { url, messages: parsePawchiveDmsHtml(html) };
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
