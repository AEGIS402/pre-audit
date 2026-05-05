import { createHash } from "node:crypto";

export function createAnalyzerCacheKey({ sourceCode, upstreamUrl, namespace }) {
  const payload = JSON.stringify({
    namespace,
    upstreamUrl,
    request: { source_code: sourceCode },
  });

  return createHash("sha256").update(payload).digest("hex");
}

export function createResponseCache(options = {}) {
  return new ResponseCache(options);
}

export class ResponseCache {
  constructor({
    enabled = true,
    ttlMs = 0,
    maxEntries = 4096,
    now = () => Date.now(),
  } = {}) {
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : 0;
    this.maxEntries = Number.isFinite(maxEntries) && maxEntries > 0 ? maxEntries : 0;
    this.enabled = Boolean(enabled) && this.maxEntries > 0;
    this.now = now;
    this.entries = new Map();
    this.hits = 0;
    this.misses = 0;
    this.sets = 0;
    this.evictions = 0;
  }

  get(key) {
    if (!this.enabled) {
      this.misses += 1;
      return null;
    }

    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return null;
    }

    const now = this.now();
    if (this.isExpired(entry, now)) {
      this.entries.delete(key);
      this.evictions += 1;
      this.misses += 1;
      return null;
    }

    entry.accessedAt = now;
    this.hits += 1;
    return { ...entry.value };
  }

  set(key, value) {
    if (!this.enabled) {
      return;
    }

    const now = this.now();
    this.entries.set(key, {
      value: { ...value },
      accessedAt: now,
      expiresAt: this.ttlMs === 0 ? null : now + this.ttlMs,
    });
    this.sets += 1;
    this.pruneExpired();
    this.trimToMaxEntries();
  }

  stats() {
    return {
      enabled: this.enabled,
      ttl_ms: this.ttlMs,
      max_entries: this.maxEntries,
      size: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      sets: this.sets,
      evictions: this.evictions,
    };
  }

  pruneExpired() {
    if (this.ttlMs === 0) {
      return;
    }

    const now = this.now();
    for (const [key, entry] of this.entries.entries()) {
      if (this.isExpired(entry, now)) {
        this.entries.delete(key);
        this.evictions += 1;
      }
    }
  }

  trimToMaxEntries() {
    while (this.entries.size > this.maxEntries) {
      let oldestKey = null;
      let oldestAccessedAt = Infinity;

      for (const [key, entry] of this.entries.entries()) {
        if (entry.accessedAt < oldestAccessedAt) {
          oldestKey = key;
          oldestAccessedAt = entry.accessedAt;
        }
      }

      if (oldestKey === null) {
        return;
      }

      this.entries.delete(oldestKey);
      this.evictions += 1;
    }
  }

  isExpired(entry, now) {
    return this.ttlMs > 0 && entry.expiresAt <= now;
  }
}
