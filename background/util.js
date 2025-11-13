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
      if (/^\.[a-z0-9]{1,5}$/.test(ext)) return ext;
    } catch (e) { }
    return '';
  },

  extractExternalLinks: (content) => {
    if (!content || typeof content !== 'string') return [];
    const broad = /https?:\/\/[\w\-\.%@:\/\?=\&\+\$\#\(\)\[\]~,;\'!\*]+/gi;
    const rawMatches = content.match(broad) || [];

    const allowedHosts = [
      'drive.google.com', 'docs.google.com', 'mega.nz', 'mega.co.nz', 'dropbox.com', 'db.tt',
      'onedrive.live.com', '1drv.ms', 'mediafire.com', 'wetransfer.com', 'we.tl', 'sendspace.com',
      '4shared.com', 'zippyshare.com', 'uploadfiles.io', 'box.com', 'pcloud.com', 'disk.yandex.'
    ];

    const seen = new Set();
    const result = [];

    for (let raw of rawMatches) {
      if (!raw || typeof raw !== 'string') continue;
      let urlStr = raw.replace(/[)\]'"\.,;!?:]+$/g, '');
      urlStr = urlStr.replace(/&amp;/g, '&');

      let ok = false;
      try {
        const u = new URL(urlStr);
        const host = u.hostname.toLowerCase();
        ok = allowedHosts.some(h => host.indexOf(h) !== -1);
        if (!ok) {
          const path = (u.pathname || '').toLowerCase();
          ok = /(file|upload|share|download|drive|storage)/.test(path);
        }
        if (ok) {
          const key = (u.origin + u.pathname).toLowerCase();
          if (!seen.has(key)) { seen.add(key); result.push(u.toString()); }
        }
      } catch (e) {
        const lower = urlStr.toLowerCase();
        ok = allowedHosts.some(h => lower.indexOf(h) !== -1) || /(file|upload|share|download|drive|storage)/.test(lower);
        if (ok) {
          const key = lower.split(/[?#]/)[0];
          if (!seen.has(key)) { seen.add(key); result.push(urlStr); }
        }
      }
    }

    return result;
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
