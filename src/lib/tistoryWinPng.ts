import { originalPngCandidates, decodeLocalWinPng } from "@/lib/localWinPng";
import { createHash } from "node:crypto";

const MAX_FILE_BYTES = 8388608;
const MAX_TOTAL_BYTES = 20971520;
const MAX_SOURCE_PNG_BYTES = 32 * 1024 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;

export interface TistoryWinPngFile {
  path: string;
  data: Buffer;
  generated: boolean;
  temporary?: boolean;
}

// Memory only. Temporary JMK previews must never enter the verified disk cache.
const resultCache = new Map<string, { timestamp: number; files: TistoryWinPngFile[] }>();
const inFlight = new Map<string, Promise<TistoryWinPngFile[]>>();
function cloneFiles(files: TistoryWinPngFile[]): TistoryWinPngFile[] {
  return files.map(file => ({...file, data: Buffer.from(file.data)}));
}

function allowedTistoryUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase();
    if (host !== "tistory.com" && !host.endsWith(".tistory.com")) return null;
    return url;
  } catch {
    return null;
  }
}

function safePath(value: unknown): string | null {
  const normalized = String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
  if (!normalized || normalized.includes("\0") || normalized.length > 1000) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  if (parts.some((part) => /[\x00-\x1f*?"<>|]/.test(part))) return null;
  return parts.join("/");
}

async function downloadOriginalKakaoPng(
  rawUrl: string,
  referer: string,
  timeoutMs: number,
): Promise<Buffer | null> {
  let url: URL;
  try {
    url = new URL(rawUrl, referer);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if ((url.protocol !== "https:" && url.protocol !== "http:")
      || (host !== "blog.kakaocdn.net" && !host.endsWith(".kakaocdn.net"))
      || !url.pathname.toLowerCase().endsWith(".png")) {
    return null;
  }

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
        "Accept": "image/png,image/*;q=0.9,*/*;q=0.5",
        "Referer": referer,
      },
      signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, 15000))),
      redirect: "follow",
    });
    if (!response.ok) return null;
    const declared = Number(response.headers.get("content-length") || "0");
    if (declared > MAX_SOURCE_PNG_BYTES) return null;
    if (!response.body) return null;
    const chunks: Uint8Array[] = []; let bytes = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.length;
      if (bytes > MAX_SOURCE_PNG_BYTES) { await response.body.cancel().catch(() => {}); return null; }
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    if (!data.length || data.length > MAX_SOURCE_PNG_BYTES) return null;
    if (!data.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return null;
    return data;
  } catch {
    return null;
  }
}

export async function extractTistoryWinPngFiles(
  pageUrl: string,
  options: {timeoutMs?: number; html?: string} = {},
): Promise<TistoryWinPngFile[]> {
  const parsed = allowedTistoryUrl(pageUrl);
  if (!parsed) return [];
  const cacheKey = parsed.toString(), cached = resultCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cloneFiles(cached.files);
  const running = inFlight.get(cacheKey);
  if (running) return cloneFiles(await running);

  const work = (async () => {
    const files: TistoryWinPngFile[] = [];
    let complete = true;
    try {
      let html = options.html;
      if (html === undefined) {
        const response = await fetch(cacheKey, {signal: AbortSignal.timeout(10000)});
        if (!response.ok) throw new Error("local_winpng_page_failed");
        html = await response.text();
      }
      const deadline = Date.now() + Math.max(1, Math.min(options.timeoutMs ?? 20000, 30000));
      for (const candidate of originalPngCandidates(html, cacheKey)) {
        if (Date.now() >= deadline) { complete = false; break; }
        const png = await downloadOriginalKakaoPng(candidate, cacheKey, deadline - Date.now());
        if (!png) { complete = false; continue; }
        try {
          const decoded = await decodeLocalWinPng(png, deadline - Date.now());
          files.push(...decoded.files);
          console.log("[Tistory WinPNG] local rows collected", {pageUrl: cacheKey,
            rows: decoded.files.length, paths: decoded.files.slice(0, 8).map(f => f.path)});
          if (decoded.pending.length) {
            complete = false;
            console.warn("[Tistory WinPNG] local rows rejected", {pageUrl: cacheKey, pending: decoded.pending.slice(0, 8)});
          }
        } catch (error) {
          complete = false;
          console.warn("[Tistory WinPNG local decode failed]", {pageUrl: cacheKey,
            error: error instanceof Error ? error.message : String(error)});
        }
      }
    } catch (error) {
      complete = false;
      console.warn("[Tistory WinPNG local extraction failed]", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const seen = new Set<string>(); let total = 0;
    const playable = files.filter(file => {
      if (!safePath(file.path) || !/\.(?:ass|ssa|smi|srt|vtt|zip)$/i.test(file.path)
        || !file.data.length || file.data.length > MAX_FILE_BYTES) return false;
      const key = file.path.toLowerCase() + ":" + createHash("sha256").update(file.data).digest("hex");
      if (seen.has(key)) return false;
      if (total + file.data.length > MAX_TOTAL_BYTES) { complete = false; return false; }
      seen.add(key); total += file.data.length; return true;
    });
    console.log("[Tistory WinPNG] playable files collected", {pageUrl: cacheKey,
      count: playable.length, paths: playable.slice(0, 8).map(f => f.path)});
    if (playable.length && complete) {
      resultCache.set(cacheKey, {timestamp: Date.now(), files: cloneFiles(playable)});
      if (resultCache.size > 50) {
        const first = resultCache.keys().next().value;
        if (first) resultCache.delete(first);
      }
    } else resultCache.delete(cacheKey);
    return playable;
  })();
  inFlight.set(cacheKey, work);
  try { return cloneFiles(await work); }
  finally { inFlight.delete(cacheKey); }
}
