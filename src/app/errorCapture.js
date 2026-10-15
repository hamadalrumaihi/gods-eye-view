const MAX_TEXT_LENGTH = 2000;
// Query-string credentials that provider URLs can carry into error text.
const SECRET_QUERY_PARAM =
  /([?&](?:key|api_key|apikey|token|access_token|session|signature)=)[^&\s'"]+/gi;

function clip(text) {
  const value = String(text);
  return value.length > MAX_TEXT_LENGTH
    ? `${value.slice(0, MAX_TEXT_LENGTH)}…`
    : value;
}

function scrub(text) {
  if (text === undefined || text === null || text === '') return undefined;
  return clip(String(text).replace(SECRET_QUERY_PARAM, '$1[redacted]'));
}

/** Reduce a thrown value to its message and stack; never serialize payloads. */
function describe(value) {
  if (value instanceof Error) {
    return {
      message: scrub(value.message || value.name || 'Error') || 'Error',
      stack: scrub(value.stack),
    };
  }
  if (typeof value === 'string') return { message: scrub(value) || 'Error' };
  if (value && typeof value === 'object' && 'message' in value) {
    return { message: scrub(value.message) || 'Error' };
  }
  return { message: value === undefined ? 'Error' : scrub(value) || 'Error' };
}

/**
 * Capture uncaught errors and unhandled rejections in a bounded ring buffer so
 * live gates and bug reports can read what the console already showed. Entries
 * hold only `{ at, kind, message, stack? }`: no event payloads, request bodies
 * or key values are retained, and credential-shaped query parameters in URLs
 * are redacted.
 * @param {object} [options]
 * @param {EventTarget} [options.target=globalThis] Where 'error' and 'unhandledrejection' fire.
 * @param {number} [options.limit=200] Entries kept; the oldest is evicted first.
 * @returns {{ getEntries: () => Array<object>, clear: () => void, dispose: () => void }}
 */
export function createErrorCapture({ target = globalThis, limit = 200 } = {}) {
  const capacity = Number.isInteger(limit) && limit > 0 ? limit : 200;
  const entries = [];
  const record = (kind, value) => {
    entries.push({ at: Date.now(), kind, ...describe(value) });
    if (entries.length > capacity) entries.splice(0, entries.length - capacity);
  };
  const onError = (event) =>
    record('error', event?.error ?? event?.message ?? event);
  const onRejection = (event) => record('unhandledrejection', event?.reason);
  const canListen = typeof target?.addEventListener === 'function';
  if (canListen) {
    target.addEventListener('error', onError);
    target.addEventListener('unhandledrejection', onRejection);
  }
  let disposed = false;
  return {
    getEntries: () => entries.map((entry) => ({ ...entry })),
    clear() {
      entries.length = 0;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (canListen) {
        target.removeEventListener('error', onError);
        target.removeEventListener('unhandledrejection', onRejection);
      }
    },
  };
}
