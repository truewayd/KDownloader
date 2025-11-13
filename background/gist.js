// background/gist.js - GitHub Gist upload/download helpers
import { loadGistConfig, saveGistConfig } from './config.js';
import { exportDB, importDB } from './db.js';

const GITHUB_API = 'https://api.github.com';

async function fetchWithAuth(url, token, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  headers['Authorization'] = `token ${token}`;
  headers['Accept'] = 'application/vnd.github.v3+json';
  const res = await fetch(url, Object.assign({}, opts, { headers }));
  return res;
}

export async function gistUpload() {
  const cfg = await loadGistConfig();
  const token = cfg.token;
  if (!token) throw new Error('No GitHub token configured');

  const text = await exportDB();
  const filename = 'kemono_history.json';

  // If gistId present, try to update; otherwise create new gist
  if (cfg.gistId) {
    const url = `${GITHUB_API}/gists/${encodeURIComponent(cfg.gistId)}`;
    try {
      const body = { files: {} };
      body.files[filename] = { content: text };
      const res = await fetchWithAuth(url, token, { method: 'PATCH', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
      if (res.ok) {
        const data = await res.json();
        // ensure gistId saved
        await saveGistConfig({ gistId: data.id });
        return { gistId: data.id };
      } else {
        // if not found, fall through to create new gist
        if (res.status === 404) {
          // create below
        } else {
          const txt = await res.text();
          throw new Error(`Gist update failed: ${res.status} ${res.statusText} - ${txt}`);
        }
      }
    } catch (e) {
      // if update failed due to 404 or other, try create
      if (e && typeof e.message === 'string' && e.message.includes('404')) {
        // fallthrough to create
      } else {
        // for other errors, still try create as fallback
        console.warn('[gistUpload] update failed, trying to create new gist', e);
      }
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
    const txt = await createRes.text();
    throw new Error(`Gist create failed: ${createRes.status} ${createRes.statusText} - ${txt}`);
  }
  const created = await createRes.json();
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
  const data = await res.json();
  if (!data || !data.files) throw new Error('Gist contains no files');

  // Prefer kemono_history.json if present, otherwise first file
  const files = data.files;
  let fileContent = null;
  if (files['kemono_history.json']) {
    fileContent = files['kemono_history.json'].content;
  } else {
    const firstKey = Object.keys(files)[0];
    if (firstKey) fileContent = files[firstKey].content;
  }
  if (!fileContent) throw new Error('Could not locate a file with gist content');

  // Import content into DB
  await importDB(fileContent);
  return { gistId };
}
