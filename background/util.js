// background/util.js - utility functions
import { CONFIG } from './constants.js';

export const UTIL = {
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
    if (normalized === 'full' || normalized === 'links') return normalized;
    return legacyFullMode === true ? 'full' : 'default';
  },

  extractExternalLinks: (content) => {
    if (!content || typeof content !== 'string') return [];
    const normalizedContent = content
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#(?:39|x27);/gi, "'")
      .replace(/&#(?:35|x23);/gi, '#');
    const broad = /https?:\/\/[^\s<>"`]+/gi;
    const rawMatches = normalizedContent.match(broad) || [];

    const seen = new Set();
    const result = [];

    for (let raw of rawMatches) {
      if (!raw || typeof raw !== 'string') continue;
      const urlStr = raw.replace(/[)\]}\'"\.,;!?]+$/g, '');
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

  buildExternalLinksText: (entries) => {
    const links = new Set();
    for (const entry of Array.isArray(entries) ? entries : []) {
      const rawUrl = typeof entry === 'string' ? entry : entry && (entry.url || entry.link);
      const rawSourceUrl = typeof entry === 'object' && entry ? entry.sourceUrl : '';
      let url;
      try {
        url = new URL(String(rawUrl || '')).toString();
      } catch (e) {
        continue;
      }
      if (!/^https?:$/i.test(new URL(url).protocol)) continue;
      links.add(url);

      try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        const isMega = host === 'mega.nz' || host === 'www.mega.nz' || host === 'mega.co.nz' || host === 'www.mega.co.nz';
        if (isMega && !parsed.hash.slice(1).trim() && rawSourceUrl) {
          const sourceUrl = new URL(String(rawSourceUrl)).toString();
          if (/^https?:$/i.test(new URL(sourceUrl).protocol)) links.add(sourceUrl);
        }
      } catch (e) { }
    }

    const sorted = Array.from(links).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    return sorted.length > 0 ? `${sorted.join('\n')}\n` : '';
  },

  buildExternalLinksTextTask: (entries, fileName = 'external-links.txt') => {
    const text = UTIL.buildExternalLinksText(entries);
    if (!text) return null;
    const safeName = UTIL.sanitizeFileName(fileName || 'external-links.txt');
    const normalizedName = safeName.toLowerCase().endsWith('.txt') ? safeName : `${safeName}.txt`;
    return {
      url: `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`,
      fileName: normalizedName,
      type: 'external_links_txt',
    };
  },

  buildDownloadTasks: (postData, title, baseUrl) => {
    const tasks = [];
    const seen = new Set();
    const pushIfNew = (url, fileName, type) => {
      if (!url || seen.has(url)) return;
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
      p.attachments.forEach((att, i) => {
        if (!att.path) return;
        const url = `${baseUrl}${att.path}`;
        const ext = UTIL.getFileExtension(att.path) || '';
        const fileName = UTIL.sanitizeFileName(att.name || `${title}_att${i + 1}${ext}`);
        pushIfNew(url, fileName, 'attachment');
      });
    }

    if (tasks.length === 0 && Array.isArray(postData.previews)) {
      postData.previews.forEach((preview, i) => {
        if (!preview.path) return;
        const server = preview.server || baseUrl;
        const url = `${server}${preview.path}`;
        const ext = UTIL.getFileExtension(preview.path) || '';
        const fileName = UTIL.sanitizeFileName(preview.name || `${title}_preview${i + 1}${ext}`);
        pushIfNew(url, fileName, 'preview');
      });
    }

    if (Array.isArray(postData.videos)) {
      postData.videos.forEach((video, i) => {
        const url = video.url || (video.path ? `${baseUrl}${video.path}` : null);
        if (!url) return;
        const ext = UTIL.getFileExtension(url) || '.mp4';
        const fileName = UTIL.sanitizeFileName(video.name || `${title}_video${i + 1}${ext}`);
        pushIfNew(url, fileName, 'video');
      });
    }

    return tasks;
  }
};

export default UTIL;
