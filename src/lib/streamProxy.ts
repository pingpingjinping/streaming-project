import { assertSafeProxyUrl } from "./proxyGuard";

export const SEGMENT_LIMIT_BYTES = 64 * 1024 * 1024;
export const TEXT_LIMIT_BYTES = 2 * 1024 * 1024;
export const SEGMENT_TIMEOUT_MS = 60_000;
export const TEXT_TIMEOUT_MS = 30_000;

export class ProxyTimeoutError extends Error {}
export class ProxySizeError extends Error {}

/** One deadline covers URL checks, redirects, response headers and the body. */
export async function fetchProxyStream(rawUrl: string, options: {
  headers?: HeadersInit;
  signal?: AbortSignal;
  maxBytes: number;
  timeoutMs: number;
}): Promise<{ response: Response; finalUrl: string }> {
  const upstream = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let downstream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let finished = false;
  const cleanup = () => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onClientAbort);
  };
  const stop = (reason: unknown) => {
    if (finished) return;
    finished = true;
    cleanup();
    upstream.abort(reason);
    void reader?.cancel(reason).catch(() => {});
    downstream?.error(reason);
  };
  const onClientAbort = () => stop(options.signal?.reason || new Error("Client disconnected"));
  const timer = setTimeout(() => stop(new ProxyTimeoutError("Upstream timed out")), options.timeoutMs);
  options.signal?.addEventListener("abort", onClientAbort, { once: true });

  try {
    if (options.signal?.aborted) onClientAbort();
    let url = rawUrl;
    let response: Response;
    for (let redirects = 0; ; redirects++) {
      upstream.signal.throwIfAborted();
      const safeUrl = await assertSafeProxyUrl(url);
      upstream.signal.throwIfAborted();
      url = safeUrl.href;
      response = await fetch(url, {
        headers: options.headers,
        redirect: "manual",
        signal: upstream.signal,
        cache: "no-store",
      });
      if (upstream.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        upstream.signal.throwIfAborted();
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects >= 5) throw new Error("Invalid or excessive upstream redirects");
      // The next iteration validates the new destination before fetching it.
      url = new URL(location, url).href;
    }

    const length = response.headers.get("content-length");
    if (length && /^\d+$/.test(length) && Number(length) > options.maxBytes) {
      void response.body?.cancel().catch(() => {});
      throw new ProxySizeError("Upstream body too large");
    }
    if (!response.body) {
      finished = true;
      cleanup();
      return { response, finalUrl: url };
    }
    reader = response.body.getReader();
    const source = reader;
    let bytes = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { downstream = controller; },
      async pull(controller) {
        try {
          upstream.signal.throwIfAborted();
          const chunk = await source.read();
          if (finished) return;
          if (chunk.done) {
            finished = true;
            cleanup();
            source.releaseLock();
            controller.close();
            return;
          }
          bytes += chunk.value.byteLength;
          if (bytes > options.maxBytes) throw new ProxySizeError("Upstream body too large");
          controller.enqueue(chunk.value);
        } catch (error) { stop(error); }
      },
      cancel(reason) {
        // Consumer cancellation already closes its stream; only stop upstream.
        downstream = undefined;
        stop(reason || new Error("Response cancelled"));
      },
    }, { highWaterMark: 0 });
    // Fetch decodes compressed bodies. Do not forward their encoded length.
    const headers = new Headers(response.headers);
    if (headers.has("content-encoding")) {
      headers.delete("content-encoding");
      headers.delete("content-length");
    }
    return { response: new Response(body, { status: response.status, statusText: response.statusText, headers }), finalUrl: url };
  } catch (error) {
    const reason = upstream.signal.aborted ? upstream.signal.reason : error;
    stop(reason);
    throw reason;
  }
}
