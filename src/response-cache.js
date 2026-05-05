import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function createAnalyzerCacheKey({ requestBody, upstreamUrl, namespace }) {
  const payload = JSON.stringify({
    namespace,
    upstreamUrl,
    request: requestBody,
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
    dbPath = ".cache/analyzer-response-cache.sqlite",
    now = () => Date.now(),
  } = {}) {
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : 0;
    this.maxEntries = Number.isFinite(maxEntries) && maxEntries > 0 ? maxEntries : 0;
    this.enabled = Boolean(enabled) && this.maxEntries > 0;
    this.dbPath = dbPath;
    this.now = now;
    this.db = null;
    this.statements = null;
    this.hits = 0;
    this.misses = 0;
    this.sets = 0;
    this.evictions = 0;

    if (this.enabled) {
      this.open();
    }
  }

  get(key) {
    if (!this.enabled) {
      this.misses += 1;
      return null;
    }

    const entry = this.statements.get.get(key);
    if (!entry) {
      this.misses += 1;
      return null;
    }

    const now = this.now();
    if (this.isExpired(entry, now)) {
      this.statements.delete.run(key);
      this.evictions += 1;
      this.misses += 1;
      return null;
    }

    this.statements.touch.run(now, key);
    this.hits += 1;
    return {
      status: entry.status,
      contentType: entry.content_type,
      body: entry.body,
    };
  }

  set(key, value) {
    if (!this.enabled) {
      return;
    }

    const now = this.now();
    this.statements.upsert.run({
      key,
      status: value.status,
      content_type: value.contentType,
      body: value.body,
      created_at: now,
      accessed_at: now,
      expires_at: this.ttlMs === 0 ? null : now + this.ttlMs,
    });
    this.sets += 1;
    this.pruneExpired();
    this.trimToMaxEntries();
  }

  stats() {
    return {
      enabled: this.enabled,
      storage: "sqlite",
      db_path: this.dbPath,
      journal_mode: this.enabled ? "wal" : null,
      ttl_ms: this.ttlMs,
      max_entries: this.maxEntries,
      size: this.enabled ? Number(this.statements.count.get().count) : 0,
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
    const result = this.statements.deleteExpired.run(now);
    if (Number.isInteger(result.changes) && result.changes > 0) {
      this.evictions += result.changes;
    }
  }

  trimToMaxEntries() {
    const size = Number(this.statements.count.get().count);
    const overLimit = size - this.maxEntries;

    if (overLimit <= 0) {
      return;
    }

    const oldest = this.statements.oldest.all(overLimit);
    for (const row of oldest) {
      this.statements.delete.run(row.key);
      this.evictions += 1;
    }
  }

  isExpired(entry, now) {
    return this.ttlMs > 0 && entry.expires_at <= now;
  }

  open() {
    mkdirSync(dirname(this.dbPath), { recursive: true });

    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS analyzer_response_cache (
        key TEXT PRIMARY KEY,
        status INTEGER NOT NULL,
        content_type TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        accessed_at INTEGER NOT NULL,
        expires_at INTEGER
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_analyzer_response_cache_accessed_at ON analyzer_response_cache(accessed_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_analyzer_response_cache_expires_at ON analyzer_response_cache(expires_at)");

    this.statements = {
      get: this.db.prepare(`
        SELECT status, content_type, body, expires_at
        FROM analyzer_response_cache
        WHERE key = ?
      `),
      touch: this.db.prepare("UPDATE analyzer_response_cache SET accessed_at = ? WHERE key = ?"),
      upsert: this.db.prepare(`
        INSERT INTO analyzer_response_cache (
          key,
          status,
          content_type,
          body,
          created_at,
          accessed_at,
          expires_at
        ) VALUES (
          $key,
          $status,
          $content_type,
          $body,
          $created_at,
          $accessed_at,
          $expires_at
        )
        ON CONFLICT(key) DO UPDATE SET
          status = excluded.status,
          content_type = excluded.content_type,
          body = excluded.body,
          accessed_at = excluded.accessed_at,
          expires_at = excluded.expires_at
      `),
      delete: this.db.prepare("DELETE FROM analyzer_response_cache WHERE key = ?"),
      deleteExpired: this.db.prepare("DELETE FROM analyzer_response_cache WHERE expires_at IS NOT NULL AND expires_at <= ?"),
      oldest: this.db.prepare(`
        SELECT key
        FROM analyzer_response_cache
        ORDER BY accessed_at ASC, created_at ASC, key ASC
        LIMIT ?
      `),
      count: this.db.prepare("SELECT COUNT(*) AS count FROM analyzer_response_cache"),
    };
  }
}
