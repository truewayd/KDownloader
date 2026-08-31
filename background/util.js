// background/util.js - utility functions
import { CONFIG } from './constants.js';

const MAX_EXTERNAL_LINKS = 5000;
const MAX_URL_LENGTH = 8192;
const MAX_TEXT_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const MAX_POST_DOWNLOAD_TASKS = 5000;
const MAX_LINK_CANDIDATES = 20000;
const MAX_POST_FILE_CANDIDATES = 10000;

function utf8ByteLength(value) {
  const text = String(value);
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff
        && index + 1 < text.length
        && text.charCodeAt(index + 1) >= 0xdc00
        && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index++;
    } else {
      // TextEncoder replaces every unpaired surrogate with U+FFFD (three bytes).
      bytes += 3;
    }
  }
  return bytes;
}

export function hasUnpairedSurrogate(value, maxCodeUnits = 8192) {
  if (typeof value !== 'string') return false;
  const boundedLength = Number.isSafeInteger(maxCodeUnits) && maxCodeUnits >= 0
    ? maxCodeUnits
    : 8192;
  if (value.length > boundedLength) return true;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function matchesAsciiIgnoreCase(source, start, expected) {
  if (start + expected.length > source.length) return false;
  for (let index = 0; index < expected.length; index++) {
    let actual = source.charCodeAt(start + index);
    let wanted = expected.charCodeAt(index);
    if (actual >= 65 && actual <= 90) actual += 32;
    if (wanted >= 65 && wanted <= 90) wanted += 32;
    if (actual !== wanted) return false;
  }
  return true;
}

function httpSchemeLengthAt(source, start) {
  if (!matchesAsciiIgnoreCase(source, start, 'http')) return 0;
  let cursor = start + 4;
  if ((source.charCodeAt(cursor) | 32) === 115) cursor++;
  return source[cursor] === ':' && source[cursor + 1] === '/' && source[cursor + 2] === '/'
    ? cursor + 3 - start
    : 0;
}

function encodedExternalLinkEntityAt(source, start) {
  if (source[start] !== '&') return 0;
  // Match the legacy replacement order: &amp; was decoded before the quote,
  // apostrophe, and hash entities, so these double-encoded forms decoded too.
  if (matchesAsciiIgnoreCase(source, start + 1, 'amp;quot;')) return (10 << 3) | 2;
  if (matchesAsciiIgnoreCase(source, start + 1, 'amp;#39;')) return (9 << 3) | 3;
  if (matchesAsciiIgnoreCase(source, start + 1, 'amp;#x27;')) return (10 << 3) | 3;
  if (matchesAsciiIgnoreCase(source, start + 1, 'amp;#35;')) return (9 << 3) | 4;
  if (matchesAsciiIgnoreCase(source, start + 1, 'amp;#x23;')) return (10 << 3) | 4;
  if (matchesAsciiIgnoreCase(source, start + 1, 'amp;')) return (5 << 3) | 1;
  if (matchesAsciiIgnoreCase(source, start + 1, 'quot;')) return (6 << 3) | 2;
  if (matchesAsciiIgnoreCase(source, start + 1, '#39;')) return (5 << 3) | 3;
  if (matchesAsciiIgnoreCase(source, start + 1, '#x27;')) return (6 << 3) | 3;
  if (matchesAsciiIgnoreCase(source, start + 1, '#35;')) return (5 << 3) | 4;
  if (matchesAsciiIgnoreCase(source, start + 1, '#x23;')) return (6 << 3) | 4;
  return 0;
}

function decodedExternalLinkEntity(type) {
  if (type === 1) return '&';
  if (type === 3) return "'";
  if (type === 4) return '#';
  return '"';
}

function isExternalLinkDelimiter(char) {
  const code = char.charCodeAt(0);
  const whitespace = (code >= 9 && code <= 13)
    || code === 32
    || code === 160
    || code === 5760
    || (code >= 8192 && code <= 8202)
    || code === 8232
    || code === 8233
    || code === 8239
    || code === 8287
    || code === 12288
    || code === 65279;
  return whitespace || char === '<' || char === '>' || char === '"' || char === '`';
}

function isTrailingUrlPunctuation(char) {
  return char === ')' || char === ']' || char === '}' || char === "'" || char === '"'
    || char === '.' || char === ',' || char === ';' || char === '!' || char === '?';
}

function decodeExternalLinkCandidate(source, start, end) {
  const parts = [];
  let segmentStart = start;
  let cursor = start;
  while (cursor < end) {
    const encoded = encodedExternalLinkEntityAt(source, cursor);
    if (!encoded) {
      cursor++;
      continue;
    }
    parts.push(source.slice(segmentStart, cursor), decodedExternalLinkEntity(encoded & 7));
    cursor += encoded >> 3;
    segmentStart = cursor;
  }
  parts.push(source.slice(segmentStart, end));
  return parts.join('');
}

export const UTIL = {
  hasUnpairedSurrogate,

  sanitizeFileName: (name) => {
    if (!name || typeof name !== 'string') return 'Untitled';
    const v = name
      .replace(/[\/\\:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/_{2,}/g, '_')
      .trim();
    return v.substring(0, CONFIG.MAX_FILENAME_LENGTH) || 'Untitled';
  },

  getFileExtension: (path) => {
    if (!path || typeof path !== 'string') return '';
    try {
      const qIdx = path.indexOf('?');
      const hashIdx = path.indexOf('#');
      const end = qIdx === -1 ? (hashIdx === -1 ? path.length : hashIdx) : (hashIdx === -1 ? qIdx : Math.min(qIdx, hashIdx));
      const base = path.substring(0, end);
      const dot = base.lastIndexOf('.');
      if (dot === -1 || dot === base.length - 1) return '';
      const ext = base.substring(dot).toLowerCase();
      if (/^\.[a-z0-9]{1,16}$/.test(ext)) return ext;
    } catch (e) { }
    return '';
  },

  filterDownloadTasks: (tasks, config) => {
    if (!Array.isArray(tasks)) return [];
    if (!config || config.enabled !== true) return [...tasks];
    const excluded = new Set(
      (Array.isArray(config.excludedExtensions) ? config.excludedExtensions : [])
        .map((value) => String(value || '').trim().toLowerCase())
        .map((value) => value && (value.startsWith('.') ? value : `.${value}`))
        .filter((value) => /^\.[a-z0-9]{1,16}$/.test(value))
    );
    if (excluded.size === 0) return [...tasks];
    return tasks.filter((task) => {
      const extension = UTIL.getFileExtension(task && task.fileName)
        || UTIL.getFileExtension(task && task.url);
      return !excluded.has(extension);
    });
  },

  normalizeCreatorFetchMode: (mode, legacyFullMode = false) => {
    const normalized = String(mode || '').trim().toLowerCase();
    if (normalized === 'full' || normalized === 'links' || normalized === 'dms') return normalized;
    return legacyFullMode === true ? 'full' : 'default';
  },

  extractExternalLinks: (content) => {
    if (!content || typeof content !== 'string') return [];
    const seen = new Set();
    const result = [];
    let cursor = 0;
    let examined = 0;
    while (cursor < content.length && result.length < MAX_EXTERNAL_LINKS
        && examined < MAX_LINK_CANDIDATES) {
      let schemeLength = 0;
      while (cursor < content.length && !(schemeLength = httpSchemeLengthAt(content, cursor))) cursor++;
      if (!schemeLength) break;

      const start = cursor;
      let scan = cursor + schemeLength;
      let decodedLength = schemeLength;
      let significantLength = schemeLength;
      let significantRawEnd = scan;
      while (scan < content.length) {
        const char = content[scan];
        if (isExternalLinkDelimiter(char)) break;
        const encoded = encodedExternalLinkEntityAt(content, scan);
        if (encoded) {
          const type = encoded & 7;
          const length = encoded >> 3;
          if (type === 2) {
            scan += length - 1;
            break;
          }
          decodedLength++;
          scan += length;
          if (!isTrailingUrlPunctuation(decodedExternalLinkEntity(type))) {
            significantLength = decodedLength;
            significantRawEnd = scan;
          }
          continue;
        }
        decodedLength++;
        scan++;
        if (!isTrailingUrlPunctuation(char)) {
          significantLength = decodedLength;
          significantRawEnd = scan;
        }
      }

      examined++;
      cursor = scan < content.length ? scan + 1 : scan;
      if (significantLength > MAX_URL_LENGTH) continue;
      const urlStr = decodeExternalLinkCandidate(content, start, significantRawEnd);
      try {
        const u = new URL(urlStr);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
        const normalizedUrl = u.toString();
        if (seen.has(normalizedUrl)) continue;
        seen.add(normalizedUrl);
        result.push(normalizedUrl);
      } catch (e) { }
    }

    return result;
  },

  extractPostExternalLinks: (postData) => {
    const post = postData?.post || postData;
    if (!post || typeof post !== 'object') return [];

    const candidates = [];
    if (typeof post.content === 'string') candidates.push(post.content);
    if (typeof post.embed?.url === 'string') candidates.push(post.embed.url);

    const seen = new Set();
    const result = [];
    for (const candidate of candidates) {
      for (const url of UTIL.extractExternalLinks(candidate)) {
        if (seen.has(url)) continue;
        seen.add(url);
        result.push(url);
      }
    }
    return result;
  },

  filterExternalLinks: (links, config) => {
    const blacklist = config?.mode === 'blacklist' && Array.isArray(config.blacklist)
      ? config.blacklist.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
      : [];
    const seen = new Set();
    const result = [];
    const candidates = Array.isArray(links) ? links : [];
    for (let index = 0; index < candidates.length && index < MAX_LINK_CANDIDATES; index++) {
      if (result.length >= MAX_EXTERNAL_LINKS) break;
      const value = candidates[index];
      try {
        const raw = String(value || '');
        if (raw.length > MAX_URL_LENGTH) continue;
        const url = new URL(raw).toString();
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
        const host = parsed.hostname.toLowerCase();
        if (blacklist.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        result.push(url);
      } catch (e) { }
    }
    return result;
  },

  buildExternalLinksText: (entries) => {
    const links = new Set();
    // Reserve the final newline that is appended to every non-empty file.
    let bytes = 1;
    const addLink = (value) => {
      if (links.has(value)) return;
      const addedBytes = utf8ByteLength(value) + (links.size > 0 ? 1 : 0);
      if (bytes + addedBytes > MAX_TEXT_DOWNLOAD_BYTES) {
        throw new Error('External links TXT exceeds the 8 MiB safety limit');
      }
      links.add(value);
      bytes += addedBytes;
    };
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (links.size >= MAX_EXTERNAL_LINKS) break;
      const rawUrl = typeof entry === 'string' ? entry : entry && (entry.url || entry.link);
      const rawSourceUrl = typeof entry === 'object' && entry ? entry.sourceUrl : '';
      let url;
      try {
        const value = String(rawUrl || '');
        if (value.length > MAX_URL_LENGTH) continue;
        url = new URL(value).toString();
      } catch (e) {
        continue;
      }
      if (!/^https?:$/i.test(new URL(url).protocol)) continue;
      addLink(url);

      try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        const isMega = host === 'mega.nz' || host === 'www.mega.nz' || host === 'mega.co.nz' || host === 'www.mega.co.nz';
        if (isMega && !parsed.hash.slice(1).trim() && rawSourceUrl) {
          const sourceValue = String(rawSourceUrl);
          if (sourceValue.length > MAX_URL_LENGTH) continue;
          const sourceUrl = new URL(sourceValue).toString();
          if (links.size < MAX_EXTERNAL_LINKS && /^https?:$/i.test(new URL(sourceUrl).protocol)) {
            addLink(sourceUrl);
          }
        }
      } catch (e) { }
    }

    const sorted = Array.from(links).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    return sorted.length > 0 ? `${sorted.join('\n')}\n` : '';
  },

  buildExternalLinksTextTask: (entries, fileName = 'external-links.txt') => {
    const text = UTIL.buildExternalLinksText(entries);
    if (!text) return null;
    return UTIL.buildTextDownloadTask(text, fileName, 'external_links_txt');
  },

  buildTextDownloadTask: (text, fileName = 'export.txt', type = 'text') => {
    if (typeof text !== 'string' || !text) return null;
    if (text.length > MAX_TEXT_DOWNLOAD_BYTES
        || utf8ByteLength(text) > MAX_TEXT_DOWNLOAD_BYTES) {
      throw new Error('Text download exceeds the 8 MiB safety limit');
    }
    const safeName = UTIL.sanitizeFileName(fileName || 'external-links.txt');
    const normalizedName = safeName.toLowerCase().endsWith('.txt') ? safeName : `${safeName}.txt`;
    return {
      url: `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`,
      fileName: normalizedName,
      type,
    };
  },

  buildDownloadTasks: (postData, title, baseUrl) => {
    const tasks = [];
    const seen = new Set();
    const pushIfNew = (url, fileName, type) => {
      if (!url || String(url).length > MAX_URL_LENGTH || seen.has(url)
          || tasks.length >= MAX_POST_DOWNLOAD_TASKS) return;
      seen.add(url);
      tasks.push({ url, fileName, type });
    };

    const p = postData?.post || {};

    if (p.file?.path) {
      const file = p.file;
      const url = `${baseUrl}${file.path}`;
      const ext = UTIL.getFileExtension(file.path) || '';
      const fileName = UTIL.sanitizeFileName(file.name || `${title}${ext}`);
      pushIfNew(url, fileName, 'main_file');
    }

    if (Array.isArray(p.attachments)) {
      for (let i = 0; i < p.attachments.length && i < MAX_POST_FILE_CANDIDATES
          && tasks.length < MAX_POST_DOWNLOAD_TASKS; i++) {
        const att = p.attachments[i];
        if (!att?.path) continue;
        const url = `${baseUrl}${att.path}`;
        const ext = UTIL.getFileExtension(att.path) || '';
        const fileName = UTIL.sanitizeFileName(att.name || `${title}_att${i + 1}${ext}`);
        pushIfNew(url, fileName, 'attachment');
      }
    }

    if (tasks.length === 0 && Array.isArray(postData.previews)) {
      for (let i = 0; i < postData.previews.length && i < MAX_POST_FILE_CANDIDATES
          && tasks.length < MAX_POST_DOWNLOAD_TASKS; i++) {
        const preview = postData.previews[i];
        if (!preview?.path) continue;
        const server = preview.server || baseUrl;
        const url = `${server}${preview.path}`;
        const ext = UTIL.getFileExtension(preview.path) || '';
        const fileName = UTIL.sanitizeFileName(preview.name || `${title}_preview${i + 1}${ext}`);
        pushIfNew(url, fileName, 'preview');
      }
    }

    if (Array.isArray(postData.videos)) {
      for (let i = 0; i < postData.videos.length && i < MAX_POST_FILE_CANDIDATES
          && tasks.length < MAX_POST_DOWNLOAD_TASKS; i++) {
        const video = postData.videos[i];
        if (!video || typeof video !== 'object') continue;
        const url = video.url || (video.path ? `${baseUrl}${video.path}` : null);
        if (!url) continue;
        const ext = UTIL.getFileExtension(url) || '.mp4';
        const fileName = UTIL.sanitizeFileName(video.name || `${title}_video${i + 1}${ext}`);
        pushIfNew(url, fileName, 'video');
      }
    }

    return tasks;
  }
};

export default UTIL;
