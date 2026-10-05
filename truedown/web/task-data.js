// Bounded page bodies, independent foreground reads, and one speculative read.
// Native IPC cannot be canceled by aborting a JS promise: retain each slot until
// the transport settles, and keep only the latest queued viewport.
class TaskPageStore {
  constructor(fetchPage) {
    this.fetchPage = fetchPage;
    this.cache = new Map();
    this.running = new Set();
    this.pending = null;
    this.generation = 0;
    this.revision = -1;
    this.orderVersion = "";
    this.overview = null;
    this.epoch = null;
  }

  invalidate({ keepCache = false } = {}) {
    this.generation++;
    if (!keepCache) this.cache.clear();
    this.pending?.resolve(null);
    this.pending = null;
  }

  peek(url) {
    const entry = this.cache.get(url);
    if (!entry || Date.now() - entry.time > 10_000) return null;
    this.cache.delete(url);
    this.cache.set(url, entry);
    return entry;
  }

  request(url, { prefetch = false } = {}) {
    const existing = [...this.running, this.pending].find(job => job?.url === url && job.generation === this.generation);
    if (existing) return existing.promise;
    if (prefetch && (this.pending || [...this.running].some(job => job.prefetch))) return Promise.resolve(null);
    const job = { url, prefetch, generation: this.generation, epoch: this.epoch };
    job.promise = new Promise((resolve, reject) => Object.assign(job, { resolve, reject }));
    if (prefetch) this.start(job);
    else {
      this.pending?.resolve(null);
      this.pending = job;
      this.pump();
    }
    return job.promise;
  }

  pump() {
    if (!this.pending || [...this.running].filter(job => !job.prefetch).length >= 2) return;
    const job = this.pending;
    this.pending = null;
    this.start(job);
  }

  async start(job) {
    this.running.add(job);
    try {
      const entry = this.peek(job.url);
      const headers = entry?.etag ? { "If-None-Match": entry.etag } : {};
      const url = entry?.page.rowsVersion ? `${job.url}&rowsVersion=${encodeURIComponent(entry.page.rowsVersion)}` : job.url;
      const response = await this.fetchPage(url, { headers });
      if (job.generation !== this.generation) { job.resolve(null); return; }
      let page;
      if (response.status === 304) {
        if (!entry) throw new Error("Missing task page body");
        page = entry.page;
      } else {
        if (!response.ok) throw new Error(await response.text());
        page = await response.json();
        if (job.generation !== this.generation) { job.resolve(null); return; }
        if (page?.rowsUnchanged && entry?.page.rowsVersion === page.rowsVersion) page.tasks = entry.page.tasks;
        if (!page || !Array.isArray(page.tasks) || page.tasks.length > 200 || !page.summary) throw new Error("Invalid task page");
      }
      if (Number.isSafeInteger(page.revision)) {
        if (page.epoch !== this.epoch) {
          if (this.epoch !== null && job.epoch !== this.epoch) { job.resolve(null); return; }
          this.cache.clear();
          this.revision = -1;
          this.epoch = page.epoch;
        }
        if (page.revision < this.revision && page.orderVersion !== this.orderVersion) { job.resolve(null); return; }
        if (page.revision >= this.revision) {
          if (page.orderVersion !== this.orderVersion) this.cache.clear();
          this.revision = page.revision;
          this.orderVersion = page.orderVersion;
          this.overview = { revision: page.revision, groups: page.groups, summary: page.summary };
        }
      }
      const result = { page, etag: response.headers?.get("ETag") || entry?.etag, time: Date.now(), size: JSON.stringify(page).length };
      this.cache.delete(job.url);
      this.cache.set(job.url, result);
      let size = [...this.cache.values()].reduce((sum, item) => sum + item.size, 0);
      while (this.cache.size > 8 || size > 1_048_576) {
        const key = this.cache.keys().next().value;
        size -= this.cache.get(key).size;
        this.cache.delete(key);
      }
      job.resolve(result);
    } catch (error) { job.reject(error); }
    finally { this.running.delete(job); this.pump(); }
  }
}
