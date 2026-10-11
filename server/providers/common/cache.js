/**
 * Bounded insertion-ordered cache: the oldest entry leaves when the cap is
 * crossed, a read refreshes the entry's recency, and an expired entry reads
 * as absent. The provider caches this replaces were plain Maps keyed by
 * client-chosen values (callsigns, hex ids, 5dp points), so one caller could
 * grow them without bound; a cap makes the worst case a known size.
 *
 * `set` accepts the entry's own timestamp so a cache rebuilt from disk keeps
 * aging from the original acquisition, not from the reload.
 *
 * @param {object} options
 * @param {number} options.max - Entry ceiling; the oldest entry is evicted past it.
 * @param {number} [options.ttlMs=Infinity] - Age past which `get`/`has` report a miss.
 * @param {() => number} [options.now=Date.now] - Clock, injectable for tests.
 */
export function createLruCache({ max, ttlMs = Infinity, now = Date.now } = {}) {
  if (!Number.isFinite(max) || max < 1) {
    throw new TypeError('createLruCache: max must be a positive number');
  }
  /** @type {Map<any, {value: any, at: number}>} */
  const entries = new Map();
  const expired = (entry) => ttlMs !== Infinity && now() - entry.at >= ttlMs;
  return {
    /** Current entry count, expired entries included until they are read. */
    get size() {
      return entries.size;
    },
    /** Value for `key`, or undefined when absent or expired (expired entries are dropped). */
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (expired(entry)) {
        entries.delete(key);
        return undefined;
      }
      // Re-insert so Map order tracks recency, not first insertion.
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    /** Whether `key` holds a live entry; does not refresh recency. */
    has(key) {
      const entry = entries.get(key);
      if (!entry) return false;
      if (expired(entry)) {
        entries.delete(key);
        return false;
      }
      return true;
    },
    /**
     * Store `value` under `key`, evicting the oldest entries past `max`.
     * @param {any} key
     * @param {any} value
     * @param {number} [at] - Acquisition time; defaults to now.
     */
    set(key, value, at = now()) {
      entries.delete(key);
      entries.set(key, { value, at });
      while (entries.size > max) {
        entries.delete(entries.keys().next().value);
      }
      return this;
    },
    delete(key) {
      return entries.delete(key);
    },
    clear() {
      entries.clear();
    },
    /** Map-like `[key, value]` pairs, oldest first, without TTL filtering (for persistence). */
    *entries() {
      for (const [key, entry] of entries) yield [key, entry.value];
    },
    /** Keys oldest first, without TTL filtering. */
    keys() {
      return entries.keys();
    },
  };
}
