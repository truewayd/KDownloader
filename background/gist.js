// background/gist.js - GitHub Gist upload/download helpers
import { loadGistConfig, saveGistConfig } from './config.js';
import { exportDB, getHistoryStats, importDB } from './db.js';
import { readLimitedResponseText } from './network.js';

const GITHUB_API = 'https://api.github.com';
const MAX_GIST_FILE_BYTES = 64 * 1024 * 1024;
const MAX_GIST_API_BYTES = 16 * 1024 * 1024;
const GITHUB_TIMEOUT_MS = 60 * 1000;

function validatedRawGistUrl(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:' || url.hostname !== 'gist.githubusercontent.com'
      || url.username || url.password || url.port) {
    throw new Error('Gist returned an unexpected raw file URL');
  }
  return url.toString();
}

async function fetchWithAuth(url, token, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  headers['Authorization'] = `Bearer ${token}`;
  headers['Accept'] = 'application/vnd.github.v3+json';
  return fetch(url, Object.assign({}, opts, {
    headers,
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  }));
}

async function readGistApiJson(response) {
  const text = await readLimitedResponseText(response, MAX_GIST_API_BYTES, 'Gist API');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error('Gist API returned invalid JSON');
  }
}

export async function gistUpload() {
  const cfg = await loadGistConfig();
  const token = cfg.token;
  if (!token) throw new Error('No GitHub token configured');

  const stats = await getHistoryStats();
  if (Number(stats.bytes || 0) > MAX_GIST_FILE_BYTES) {
    throw new Error('History is too large for safe Gist upload');
  }
  const text = await exportDB(MAX_GIST_FILE_BYTES);
  const filename = 'kemono_history.json';

  // If gistId present, try to update; otherwise create new gist
  if (cfg.gistId) {
    const url = `${GITHUB_API}/gists/${encodeURIComponent(cfg.gistId)}`;
    const body = { files: { [filename]: { content: text } } };
    const res = await fetchWithAuth(url, token, {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
    if (res.ok) {
      const data = await readGistApiJson(res);
      await saveGistConfig({ gistId: data.id });
      return { gistId: data.id };
    }
    if (res.status !== 404) {
      const detail = (await readLimitedResponseText(res, 64 * 1024, 'Gist API error').catch(() => '')).slice(0, 500);
      throw new Error(`Gist update failed: ${res.status} ${res.statusText}${detail ? ` - ${detail}` : ''}`);
    }
  }

  // Create new gist
  const createUrl = `${GITHUB_API}/gists`;
  const createBody = {
    public: false,
    files: {}
  };
  createBody.files[filename] = { content: text };

  const createRes = await fetchWithAuth(createUrl, token, { method: 'POST', body: JSON.stringify(createBody), headers: { 'Content-Type': 'application/json' } });
  if (!createRes.ok) {
    const txt = (await readLimitedResponseText(createRes, 64 * 1024, 'Gist API error').catch(() => '')).slice(0, 500);
    throw new Error(`Gist create failed: ${createRes.status} ${createRes.statusText} - ${txt}`);
  }
  const created = await readGistApiJson(createRes);
  if (created && created.id) {
    await saveGistConfig({ gistId: created.id });
    return { gistId: created.id };
  }
  throw new Error('Gist create returned unexpected response');
}

export async function gistDownload() {
  const cfg = await loadGistConfig();
  const token = cfg.token;
  const gistId = cfg.gistId;
  if (!token) throw new Error('No GitHub token configured');
  if (!gistId) throw new Error('No Gist ID configured');

  const url = `${GITHUB_API}/gists/${encodeURIComponent(gistId)}`;
  const res = await fetchWithAuth(url, token, { method: 'GET' });
  if (!res.ok) throw new Error(`Gist fetch failed: ${res.status} ${res.statusText}`);
  const data = await readGistApiJson(res);
  if (!data || !data.files) throw new Error('Gist contains no files');

  // Prefer kemono_history.json if present, otherwise first file
  const files = data.files;
  let fileObj = null;
  if (files['kemono_history.json']) {
    fileObj = files['kemono_history.json'];
  } else {
    const firstKey = Object.keys(files)[0];
    if (firstKey) fileObj = files[firstKey];
  }
  if (!fileObj) throw new Error('Could not locate a file with gist content');

  // Fetch from raw_url to avoid truncation for large files
  let fileContent;
  if (fileObj.truncated || fileObj.size > 1000000) {
    const rawRes = await fetchWithAuth(validatedRawGistUrl(fileObj.raw_url), token, { method: 'GET' });
    if (!rawRes.ok) throw new Error(`Failed to fetch raw content: ${rawRes.status}`);
    fileContent = await readLimitedResponseText(rawRes, MAX_GIST_FILE_BYTES, 'Gist history file');
  } else {
    fileContent = fileObj.content;
  }

  // Import content into DB
  await importDB(fileContent);
  return { gistId };
}
