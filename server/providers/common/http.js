import {
  readResponseTextCapped,
  readResponseJsonCapped,
  readResponseBytesCapped,
} from '../../../src/sources/httpBody.js';
export {
  readResponseTextCapped,
  readResponseJsonCapped,
  readResponseBytesCapped,
  coalesceProxyRequest,
} from '../../../src/sources/httpBody.js';

/** Body readers by `as`; each enforces the cap while streaming. */
const BOUNDED_READERS = {
  text: readResponseTextCapped,
  json: readResponseJsonCapped,
  bytes: readResponseBytesCapped,
};

/**
 * fetch() with a deadline that covers both the response headers and the body
 * read, a hard byte cap on the body, and redirects refused by default so a
 * host-pinned request (often carrying a key) cannot be steered elsewhere.
 *
 * The deadline is enforced here rather than trusted to the fetch
 * implementation, so a transport that ignores its signal still settles.
 * Timeouts reject with `{ code: 'UPSTREAM_TIMEOUT', name: 'TimeoutError' }`;
 * an oversized body rejects with `{ code: 'RESPONSE_TOO_LARGE' }` from the
 * shared capped readers; an abort of the caller's own `signal` propagates as
 * is. A non-OK response is returned, not thrown — its body is read under the
 * same cap unless `readErrorBody` is false, in which case it is cancelled and
 * `body` is null.
 *
 * @param {typeof fetch|null|undefined} fetchImpl - Transport; defaults to the global fetch.
 * @param {string|URL} url
 * @param {object} [options]
 * @param {number} [options.timeoutMs=20000] - Deadline for headers plus body.
 * @param {number} [options.maxBytes=1048576] - Body ceiling in bytes.
 * @param {RequestRedirect} [options.redirect='error']
 * @param {Record<string,string>} [options.headers]
 * @param {string} [options.method]
 * @param {BodyInit} [options.body] - Request body.
 * @param {AbortSignal} [options.signal] - Composed with the deadline.
 * @param {'text'|'json'|'bytes'} [options.as='text'] - How the body is read.
 * @param {boolean} [options.readErrorBody=true] - Read a non-OK body under the cap, or cancel it.
 * @returns {Promise<{response: Response, body: string|object|Uint8Array|null}>}
 */
export async function fetchBounded(
  fetchImpl,
  url,
  {
    timeoutMs = 20_000,
    maxBytes = 1024 * 1024,
    redirect = 'error',
    headers,
    method,
    body: requestBody,
    signal: callerSignal,
    as = 'text',
    readErrorBody = true,
  } = {},
) {
  const read = BOUNDED_READERS[as];
  if (!read) throw new TypeError(`fetchBounded: unknown body kind "${as}"`);
  const transport = fetchImpl || globalThis.fetch;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, deadline])
    : deadline;
  const init = { redirect, signal };
  if (headers) init.headers = headers;
  if (method) init.method = method;
  if (requestBody !== undefined) init.body = requestBody;

  const timedOut = () =>
    Object.assign(new Error('Upstream request timed out'), {
      code: 'UPSTREAM_TIMEOUT',
      name: 'TimeoutError',
    });
  const abortReason = () => (deadline.aborted ? timedOut() : signal.reason);

  let response;
  try {
    response = await new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(abortReason());
        return;
      }
      const onAbort = () => reject(abortReason());
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve()
        .then(() => transport(url, init))
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', onAbort));
    });
  } catch (error) {
    throw deadline.aborted ? timedOut() : error;
  }

  if (!response.ok && !readErrorBody) {
    void response.body?.cancel?.()?.catch?.(() => {});
    return { response, body: null };
  }
  try {
    return { response, body: await read(response, maxBytes, signal) };
  } catch (error) {
    throw deadline.aborted ? timedOut() : error;
  }
}

/**
 * Read a fetch Response body as text while enforcing a hard byte cap during
 * the read — so a malicious or buggy upstream that streams an unbounded body
 * (no/oversized Content-Length, chunked) can't OOM the proxy. Returns
 * { tooLarge, text }. Cancels the stream as soon as the cap is crossed.
 * @param {Response} upstream - fetch() response.
 * @param {number} maxBytes - hard ceiling on decoded bytes.
 * @returns {Promise<{tooLarge: boolean, text: string}>}
 */
export async function readCappedResponseText(upstream, maxBytes) {
  const declared = Number(upstream.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await upstream.body?.cancel();
    } catch {
      /* no-op */
    }
    return { tooLarge: true, text: '' };
  }
  if (
    !upstream.body ||
    typeof upstream.body[Symbol.asyncIterator] !== 'function'
  ) {
    const text = await upstream.text();
    return text.length > maxBytes
      ? { tooLarge: true, text: '' }
      : { tooLarge: false, text };
  }
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  for await (const chunk of upstream.body) {
    total += chunk.length;
    if (total > maxBytes) {
      try {
        await upstream.body.cancel();
      } catch {
        /* no-op */
      }
      return { tooLarge: true, text: '' };
    }
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  return { tooLarge: false, text };
}
