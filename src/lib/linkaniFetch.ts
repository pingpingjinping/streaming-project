import { fetchChromiumDocument } from "./chromiumDocumentFetch";

const cache = new Map<string, { html: string; expires: number }>();
const browserUntil = new Map<string, number>();
const pending = new Map<string, Promise<string>>();

/** Linkani can reset Node's TLS connection while Chromium succeeds with ECH
 * and HTTP/3. Only page text goes through the script-disabled browser fallback.
 */
export async function fetchLinkaniHtml(
  url: string,
  options: { headers?: Record<string, string>; cacheTtlMs?: number } = {},
): Promise<string> {
  const ttl = options.cacheTtlMs ?? 60_000;
  const cached = cache.get(url);
  if (ttl > 0 && cached && cached.expires > Date.now()) return cached.html;
  const active = pending.get(url);
  if (active) return active;
  const request = (async () => {
    const origin = new URL(url).origin;
    let html = "";
    if ((browserUntil.get(origin) || 0) <= Date.now()) {
      let response: Response | undefined;
      try {
        response = await fetch(url, {
          headers: options.headers || {
            "User-Agent": "Mozilla/5.0", Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
          },
          signal: AbortSignal.timeout(8000), cache: "no-store",
        });
        if (response.ok) html = await response.text();
      } catch { /* Retry transport failures using Chromium's network stack. */ }
      if (response && !response.ok) {
        await response.body?.cancel();
        throw new Error(`Linkani HTTP ${response.status}`);
      }
    }
    if (!html) {
      const document = await fetchChromiumDocument(url);
      html = document.html;
      browserUntil.set(origin, Date.now() + 300_000);
    }
    if (ttl > 0) {
      cache.delete(url);
      cache.set(url, { html, expires: Date.now() + ttl });
      while (cache.size > 128) cache.delete(cache.keys().next().value!);
    }
    // A request following stream-token expiry must not reuse an old page.
    else cache.delete(url);
    if (browserUntil.size > 128) browserUntil.delete(browserUntil.keys().next().value!);
    return html;
  })();
  pending.set(url, request);
  try { return await request; }
  finally { pending.delete(url); }
}

export async function checkLinkaniHealth(url: string): Promise<{ ok: boolean; latencyMs: number; statusText: string }> {
  const start = Date.now();
  try {
    const html = await fetchLinkaniHtml(url, { cacheTtlMs: 5000 });
    if (!/<(?:!doctype|html)\b/i.test(html)) throw new Error("Linkani did not return an HTML document");
    const browser = (browserUntil.get(new URL(url).origin) || 0) > Date.now();
    return { ok: true, latencyMs: Date.now() - start, statusText: browser ? "200 OK (Chromium document)" : "200 OK" };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - start, statusText: error instanceof Error ? error.message : "Linkani connection failed" };
  }
}
