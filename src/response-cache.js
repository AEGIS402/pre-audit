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
    ttlMs = 24 * 60 * 60 * 1000,
    maxEntries = 256,
    now = () => Date.now(),
  } = {}) {
    this.enabled = Boolean(enabled) && ttlMs > 0 && maxEntries > 0;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
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

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      this.evictions += 1;
      this.misses += 1;
      return null;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return { ...entry.value };
  }

  set(key, value) {
    if (!this.enabled) {
      return;
    }

    this.entries.set(key, {
      value: { ...value },
      expiresAt: this.now() + this.ttlMs,
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
    const now = this.now();
    for (const [key, entry] of this.entries.entries()) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        this.evictions += 1;
      }
    }
  }

  trimToMaxEntries() {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
      this.evictions += 1;
    }
  }
}
