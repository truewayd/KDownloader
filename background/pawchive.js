// background/pawchive.js - Pawchive JSON API and file-task parsing
import { PAW } from './constants.js';
import { fetchPawchiveDmsHtml, fetchPawchiveJson } from './network.js';
import UTIL from './util.js';

const MAX_IDENTITY_LENGTH = 512;
const MAX_POST_FILES = 5000;
const MAX_POST_FILE_CANDIDATES = 10000;
const MAX_FILE_PATH_LENGTH = 8192;
const MAX_CREATOR_POSTS = 10000;
const MAX_CREATOR_RETAINED_BYTES = 64 * 1024 * 1024;
const MAX_DMS_MESSAGES = 5000;
const MAX_TEXT_EXPORT_BYTES = 8 * 1024 * 1024;
const MAX_HTML_TAG_LENGTH = 64 * 1024;
const MAX_DM_HREF_LENGTH = 8192;
const TEXT_ACCUMULATOR_PARTS = 4096;
const TEXT_ACCUMULATOR_CHARS = 64 * 1024;
const HTML_BLOCK_TAGS = new Set(['p', 'div', 'li', 'section', 'blockquote']);
const DM_CAPTURE_KINDS = ['content', 'added'];
const DM_CAPTURE_CLASSES = [
  ['content', 'dm-card__content'],
  ['added', 'dm-card__added'],
];

function requiredPart(value, label) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > MAX_IDENTITY_LENGTH || /[\x00-\x1f\x7f]/.test(normalized)
      || UTIL.hasUnpairedSurrogate(normalized, MAX_IDENTITY_LENGTH)) {
    throw new Error(`Invalid Pawchive ${label}`);
  }
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
    return Number.isFinite(numeric)
      && numeric > 0
      && numeric <= 0x10ffff
      && (numeric < 0xd800 || numeric > 0xdfff)
      ? String.fromCodePoint(numeric)
      : '\ufffd';
  });
}

function isHtmlNameCode(code) {
  return (code >= 48 && code <= 57)
    || (code >= 65 && code <= 90)
    || (code >= 97 && code <= 122)
    || code === 45
    || code === 58;
}

function scanHtmlTags(input, visitor) {
  const source = String(input || '');
  let cursor = 0;
  let rawTextTag = '';
  while (cursor < source.length) {
    const start = source.indexOf('<', cursor);
    if (start < 0) return;

    if (!rawTextTag && source.startsWith('<!--', start)) {
      const commentEnd = source.indexOf('-->', start + 4);
      const end = commentEnd < 0 ? source.length : commentEnd + 3;
      if (visitor({ start, end, name: '', closing: false, selfClosing: false }, source) === false) return;
      cursor = end;
      continue;
    }

    let nameStart = start + 1;
    let closing = false;
    if (source[nameStart] === '/') {
      closing = true;
      nameStart++;
    }
    let nameEnd = nameStart;
    while (nameEnd < source.length && isHtmlNameCode(source.charCodeAt(nameEnd))) nameEnd++;
    if (nameEnd === nameStart || nameEnd - nameStart > 32) {
      if (!rawTextTag && (source[nameStart] === '!' || source[nameStart] === '?')) {
        const declarationEnd = source.indexOf('>', nameStart + 1);
        const end = declarationEnd < 0
          ? Math.min(source.length, start + MAX_HTML_TAG_LENGTH + 1)
          : Math.min(declarationEnd + 1, start + MAX_HTML_TAG_LENGTH + 1);
        if (visitor({ start, end, name: '', closing: false, selfClosing: false }, source) === false) return;
        cursor = end;
      } else {
        cursor = Math.max(nameEnd, start + 1);
      }
      continue;
    }

    const name = source.slice(nameStart, nameEnd).toLowerCase();
    if (rawTextTag && (!closing || name !== rawTextTag)) {
      cursor = start + 1;
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
      if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
      else if (char === '<') {
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

    let slash = end - 1;
    while (slash > nameEnd && /\s/.test(source[slash])) slash--;
    const token = { start, end: end + 1, name, closing, selfClosing: source[slash] === '/' };
    if (visitor(token, source) === false) return;
    cursor = end + 1;
    if (rawTextTag && closing) rawTextTag = '';
    else if (!closing && !token.selfClosing && (name === 'script' || name === 'style')) rawTextTag = name;
  }
}

function htmlAttribute(source, token, targetName, maxLength = MAX_HTML_TAG_LENGTH) {
  let cursor = token.start + 1 + (token.closing ? 1 : 0);
  while (cursor < token.end && isHtmlNameCode(source.charCodeAt(cursor))) cursor++;
  while (cursor < token.end) {
    while (cursor < token.end && /\s/.test(source[cursor])) cursor++;
    if (cursor >= token.end || source[cursor] === '>') return '';
    if (source[cursor] === '/') {
      cursor++;
      continue;
    }
    const nameStart = cursor;
    while (cursor < token.end && !/[\s"'=<>`/]/.test(source[cursor])) cursor++;
    if (cursor === nameStart) {
      cursor++;
      continue;
    }
    const name = source.slice(nameStart, cursor).toLowerCase();
    while (cursor < token.end && /\s/.test(source[cursor])) cursor++;
    let valueStart = cursor;
    let valueEnd = cursor;
    if (source[cursor] === '=') {
      cursor++;
      while (cursor < token.end && /\s/.test(source[cursor])) cursor++;
      const quote = source[cursor] === '"' || source[cursor] === "'" ? source[cursor++] : '';
      valueStart = cursor;
      if (quote) {
        while (cursor < token.end && source[cursor] !== quote) cursor++;
        valueEnd = cursor;
        if (source[cursor] === quote) cursor++;
      } else {
        while (cursor < token.end && !/[\s"'=<>`]/.test(source[cursor])) cursor++;
        valueEnd = cursor;
      }
    }
    if (name === targetName) {
      return valueEnd - valueStart <= maxLength ? source.slice(valueStart, valueEnd) : '';
    }
  }
  return '';
}

function hasClassToken(source, token, target) {
  const classes = htmlAttribute(source, token, 'class');
  let cursor = 0;
  while (cursor < classes.length) {
    while (cursor < classes.length && /\s/.test(classes[cursor])) cursor++;
    const start = cursor;
    while (cursor < classes.length && !/\s/.test(classes[cursor])) cursor++;
    if (classes.slice(start, cursor) === target) return true;
  }
  return false;
}

function createTextAccumulator() {
  return { blocks: [], parts: [], partChars: 0 };
}

function appendText(accumulator, value) {
  if (!value) return;
  accumulator.parts.push(value);
  accumulator.partChars += value.length;
  if (accumulator.parts.length >= TEXT_ACCUMULATOR_PARTS
      || accumulator.partChars >= TEXT_ACCUMULATOR_CHARS) {
    accumulator.blocks.push(accumulator.parts.join(''));
    accumulator.parts.length = 0;
    accumulator.partChars = 0;
  }
}

function finishText(accumulator) {
  if (accumulator.parts.length) accumulator.blocks.push(accumulator.parts.join(''));
  return accumulator.blocks.join('');
}

function normalizePlainText(value) {
  return decodeHtmlEntities(value)
    .replace(/\r/g, '')
    .replace(/[\t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function plainTextFromHtml(fragment) {
  const source = String(fragment || '');
  const output = createTextAccumulator();
  const anchors = [];
  let ignoredAnchorDepth = 0;
  let textCursor = 0;
  let suppressedTag = '';
  const currentOutput = () => anchors.length ? anchors[anchors.length - 1].text : output;

  scanHtmlTags(source, (token, fullSource) => {
    if (!suppressedTag && token.start > textCursor) {
      appendText(currentOutput(), fullSource.slice(textCursor, token.start));
    }
    textCursor = token.end;

    if (suppressedTag) {
      if (token.closing && token.name === suppressedTag) suppressedTag = '';
      return true;
    }
    if (!token.closing && !token.selfClosing && (token.name === 'script' || token.name === 'style')) {
      suppressedTag = token.name;
      return true;
    }
    if (token.name === 'a') {
      if (!token.closing && !token.selfClosing) {
        if (anchors.length < 32) {
          anchors.push({
            href: htmlAttribute(fullSource, token, 'href', MAX_DM_HREF_LENGTH),
            text: createTextAccumulator(),
          });
        } else {
          ignoredAnchorDepth++;
        }
      } else if (token.closing) {
        if (ignoredAnchorDepth > 0) {
          ignoredAnchorDepth--;
        } else if (anchors.length) {
          const anchor = anchors.pop();
          const label = normalizePlainText(finishText(anchor.text));
          const href = decodeHtmlEntities(anchor.href).trim();
          appendText(currentOutput(), !href || label === href
            ? (label || href)
            : (label ? `${label} (${href})` : href));
        }
      }
      return true;
    }
    if (!token.closing && token.name === 'br') appendText(currentOutput(), '\n');
    else if (!token.closing && token.name === 'li') appendText(currentOutput(), '- ');
    else if (token.closing && HTML_BLOCK_TAGS.has(token.name)) {
      appendText(currentOutput(), '\n');
    }
    return true;
  });

  if (!suppressedTag && textCursor < source.length) appendText(currentOutput(), source.slice(textCursor));
  while (anchors.length) {
    const anchor = anchors.pop();
    appendText(currentOutput(), finishText(anchor.text));
  }
  return normalizePlainText(finishText(output));
}

function utf8ByteLength(value) {
  const text = String(value || '');
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

function finishDmCard(card, messages, textBytes) {
  const content = plainTextFromHtml(card.content || '');
  const added = plainTextFromHtml(card.added || '');
  const published = added.replace(/^Published\s*:\s*/i, '').trim();
  if (!content && !published) return textBytes;
  const nextBytes = textBytes + utf8ByteLength(published) + utf8ByteLength(content) + 2;
  if (nextBytes > MAX_TEXT_EXPORT_BYTES) {
    throw new Error('Pawchive DMs exceed the 8 MiB text safety limit');
  }
  messages.push({ published, text: content });
  return nextBytes;
}

export function parsePawchiveDmsHtml(html) {
  const messages = [];
  const source = String(html || '');
  let textBytes = 0;
  let card = null;

  scanHtmlTags(source, (token, fullSource) => {
    if (!card) {
      if (!token.closing && !token.selfClosing && token.name === 'article'
          && hasClassToken(fullSource, token, 'dm-card')) {
        card = {
          articleDepth: 1,
          content: '',
          added: '',
          contentFound: false,
          addedFound: false,
          contentCapture: null,
          addedCapture: null,
        };
      }
      return true;
    }

    if (token.name === 'div') {
      for (const kind of DM_CAPTURE_KINDS) {
        const captureName = `${kind}Capture`;
        const capture = card[captureName];
        if (!capture) continue;
        if (!token.closing && !token.selfClosing) capture.depth++;
        else if (token.closing && --capture.depth === 0) {
          card[kind] = fullSource.slice(capture.start, token.start);
          card[captureName] = null;
        }
      }
      if (!token.closing) {
        for (const [kind, className] of DM_CAPTURE_CLASSES) {
          if (!card[`${kind}Found`] && hasClassToken(fullSource, token, className)) {
            card[`${kind}Found`] = true;
            if (!token.selfClosing) card[`${kind}Capture`] = { start: token.end, depth: 1 };
          }
        }
      }
    }

    if (token.name === 'article') {
      if (!token.closing && !token.selfClosing) card.articleDepth++;
      else if (token.closing && --card.articleDepth === 0) {
        textBytes = finishDmCard(card, messages, textBytes);
        card = null;
        return messages.length < MAX_DMS_MESSAGES;
      }
    }
    return true;
  });
  return messages;
}

export function formatPawchiveDmsText(messages, context = {}) {
  const items = Array.isArray(messages) ? messages.slice(0, MAX_DMS_MESSAGES) : [];
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
  const text = `${lines.join('\n').trimEnd()}\n`;
  if (text.length > MAX_TEXT_EXPORT_BYTES
      || utf8ByteLength(text) > MAX_TEXT_EXPORT_BYTES) {
    throw new Error('Pawchive DMs exceed the 8 MiB text safety limit');
  }
  return text;
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
  return value.filter((post) => post && post.id).slice(0, PAW.PAGE_SIZE);
}

function projectedPawchiveFile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const path = typeof value.path === 'string' ? value.path.trim() : '';
  if (!path || path.length > MAX_FILE_PATH_LENGTH || /[\x00-\x1f\x7f]/.test(path)
      || UTIL.hasUnpairedSurrogate(path, MAX_FILE_PATH_LENGTH)) return null;
  const result = { path };
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (name && name.length <= 1024 && !/[\x00-\x1f\x7f]/.test(name)
      && !UTIL.hasUnpairedSurrogate(name, 1024)) result.name = name;
  return result;
}

export function projectPawchiveCreatorPost(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = String(value.id ?? '').trim();
  if (!id || id.length > MAX_IDENTITY_LENGTH || /[\x00-\x1f\x7f]/.test(id)
      || UTIL.hasUnpairedSurrogate(id, MAX_IDENTITY_LENGTH)) return null;
  const post = { id, has_full: value.has_full === true };
  const file = projectedPawchiveFile(value.file);
  if (file) post.file = file;
  const attachments = [];
  const candidates = Array.isArray(value.attachments) ? value.attachments : [];
  for (let index = 0; index < candidates.length && index < MAX_POST_FILE_CANDIDATES; index++) {
    const attachment = projectedPawchiveFile(candidates[index]);
    if (attachment) attachments.push(attachment);
  }
  if (attachments.length > 0) post.attachments = attachments;
  if (typeof value.content === 'string' && value.content) post.content = value.content;
  if (typeof value.embed?.url === 'string' && value.embed.url) {
    post.embed = { url: value.embed.url };
  }
  return post;
}

function retainedPawchivePostBytes(post) {
  const stringBytes = (value) => Math.max(utf8ByteLength(value), String(value || '').length * 2);
  let bytes = 384 + stringBytes(post.id);
  if (post.file) bytes += 128 + stringBytes(post.file.path) + stringBytes(post.file.name);
  if (Array.isArray(post.attachments)) {
    bytes += 64;
    for (const attachment of post.attachments) {
      bytes += 128 + stringBytes(attachment.path) + stringBytes(attachment.name);
    }
  }
  if (typeof post.content === 'string') bytes += 32 + stringBytes(post.content);
  if (post.embed) bytes += 64 + stringBytes(post.embed.url);
  return bytes;
}

export async function fetchAllPawchiveCreatorPosts(service, userId, options = {}) {
  const maxPages = Math.max(1, Math.min(1000, Number(options.maxPages) || 200));
  const requestedRetainedBytes = Number(options.maxRetainedBytes);
  const maxRetainedBytes = Number.isFinite(requestedRetainedBytes) && requestedRetainedBytes > 0
    ? Math.min(MAX_CREATOR_RETAINED_BYTES, Math.floor(requestedRetainedBytes))
    : MAX_CREATOR_RETAINED_BYTES;
  const posts = new Map();
  let retainedBytes = 0;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    const offset = pageIndex * PAW.PAGE_SIZE;
    const page = await fetchPawchiveCreatorPage(service, userId, offset);
    let added = 0;
    for (const value of page) {
      if (posts.size >= MAX_CREATOR_POSTS) break;
      const post = projectPawchiveCreatorPost(value);
      if (!post || posts.has(post.id)) continue;
      const postBytes = retainedPawchivePostBytes(post);
      if (retainedBytes + postBytes > maxRetainedBytes) {
        throw new Error('Pawchive creator posts exceed the 64 MiB retained-data safety limit');
      }
      posts.set(post.id, post);
      retainedBytes += postBytes;
      added++;
    }
    if (typeof options.onPage === 'function') {
      await options.onPage({ offset, page, total: posts.size });
    }
    if (posts.size >= MAX_CREATOR_POSTS || page.length < PAW.PAGE_SIZE || added === 0) break;
  }

  return Array.from(posts.values());
}

export function isCompletePawchivePost(post) {
  return !!post && post.has_full === true;
}

function pawchiveFileUrl(path) {
  const normalized = String(path || '').trim();
  if (!normalized || normalized.length > MAX_FILE_PATH_LENGTH || /[\x00-\x1f\x7f]/.test(normalized)) return '';
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `${PAW.FILE_ORIGIN}/data${withSlash}`;
}

export function buildPawchiveDownloadTasks(post) {
  if (!isCompletePawchivePost(post)) return [];
  const tasks = [];
  const seenPaths = new Set();
  const attachments = Array.isArray(post && post.attachments) ? post.attachments : [];
  const candidates = [post && post.file];
  for (let index = 0; index < attachments.length && index < MAX_POST_FILE_CANDIDATES; index++) {
    candidates.push(attachments[index]);
  }

  for (const candidate of candidates) {
    if (tasks.length >= MAX_POST_FILES) break;
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
