import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runChromiumQueued } from "@/lib/chromiumFetch";

const CHROMIUM_BIN = process.env.CHROMIUM_BIN || "/usr/bin/chromium";
const MAX_CANDIDATES = 6;
const MAX_FILE_BYTES = 8388608;
const MAX_TOTAL_BYTES = 20971520;
const MAX_SOURCE_PNG_BYTES = 32 * 1024 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;

export interface TistoryWinPngFile {
  path: string;
  data: Buffer;
  generated: boolean;
}

const resultCache = new Map<string, { timestamp: number; files: TistoryWinPngFile[] }>();

function cloneFiles(files: TistoryWinPngFile[]): TistoryWinPngFile[] {
  return files.map((file) => ({ ...file, data: Buffer.from(file.data) }));
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDevToolsPort(profileDir: string, process: ChildProcess, timeoutMs: number) {
  const file = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error("Chromium exited before DevTools became ready");
    try {
      const text = await readFile(file, "utf8");
      const port = Number(text.split(/\r?\n/)[0]);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {}
    await sleep(80);
  }
  throw new Error("Timed out waiting for Chromium DevTools port");
}

type CdpResponse = {
  id?: number;
  result?: any;
  error?: { message?: string };
};

class CdpClient {
  private socket: WebSocket;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      if (!raw) return;
      let message: CdpResponse;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      if (!message.id) return;
      const item = this.pending.get(message.id);
      if (!item) return;
      this.pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(new Error(message.error.message || "CDP command failed"));
      else item.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const item of this.pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error("Chromium DevTools connection closed"));
      }
      this.pending.clear();
    });
  }

  static async connect(url: string, timeoutMs = 5000) {
    if (typeof WebSocket === "undefined") {
      throw new Error("WebSocket is unavailable in this Node runtime");
    }
    return await new Promise<CdpClient>((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        try { socket.close(); } catch {}
        reject(new Error("Timed out connecting to Chromium DevTools"));
      }, timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new CdpClient(socket));
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Failed to connect to Chromium DevTools"));
      }, { once: true });
    });
  }

  async send(method: string, params: Record<string, unknown> = {}, timeoutMs = 10000) {
    const id = this.nextId++;
    return await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("CDP command timed out: " + method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T>(expression: string, timeoutMs = 10000): Promise<T> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, timeoutMs);
    if (result?.exceptionDetails) {
      const description = result.exceptionDetails?.exception?.description
        || result.exceptionDetails?.text
        || "Chromium evaluation failed";
      throw new Error(description);
    }
    return result?.result?.value as T;
  }

  close() {
    try { this.socket.close(); } catch {}
  }
}

async function targetWebSocket(port: number, pageUrl: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/json/list", {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        const targets = await response.json() as Array<any>;
        const pages = targets.filter((item) => item?.type === "page" && item?.webSocketDebuggerUrl);
        const exact = pages.find((item) => item.url === pageUrl);
        const useful = exact || pages.find((item) => item.url && item.url !== "about:blank") || pages[0];
        if (useful?.webSocketDebuggerUrl) return String(useful.webSocketDebuggerUrl);
      }
    } catch {}
    await sleep(100);
  }
  throw new Error("Chromium page target was not available");
}

async function waitFor<T>(
  client: CdpClient,
  expression: string,
  predicate: (value: T) => boolean,
  timeoutMs: number,
  intervalMs = 180,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await client.evaluate<T>(expression, Math.min(4000, timeoutMs));
      if (predicate(value)) return value;
    } catch {}
    await sleep(intervalMs);
  }
  return null;
}

const VIEWER_READY = `(() => (
  typeof window.downloadZip === "function"
  && !!document.getElementById("viewFileList")
))()`;

const SETUP = `(() => {
  window.__animeWinPng = { failed: false };
  window.alert = () => { window.__animeWinPng.failed = true; };
  window.prompt = () => null;
  window.confirm = () => false;
  return true;
})()`;

const CANDIDATES = `(() => {
  const seen = new Set();
  const out = [];
  const roots = [
    document.querySelector("#content"),
    document.querySelector(".tt_article_useless_p_margin"),
    document.querySelector(".contents_style"),
  ].filter(Boolean);
  const nodes = roots.length
    ? roots.flatMap((root) => [root, ...root.querySelectorAll("*")])
    : [...document.querySelectorAll("body *")];

  for (const node of nodes) {
    const values = [
      node.getAttribute?.("data-url") || "",
      node.getAttribute?.("data-phocus") || "",
      node.getAttribute?.("src") || "",
      node.currentSrc || "",
    ].filter(Boolean);

    for (const raw of values) {
      let url;
      try { url = new URL(raw, location.href); } catch { continue; }
      const host = url.hostname.toLowerCase();
      if (host !== "blog.kakaocdn.net" && !host.endsWith(".kakaocdn.net")) continue;
      if (!url.pathname.toLowerCase().endsWith(".png")) continue;
      const src = url.toString();
      if (seen.has(src)) continue;
      seen.add(src);
      out.push({ src });
      break;
    }
    if (out.length >= 6) break;
  }
  return out;
})()`;

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
      signal: AbortSignal.timeout(Math.max(4000, Math.min(timeoutMs, 15000))),
      redirect: "follow",
    });
    if (!response.ok) return null;
    const declared = Number(response.headers.get("content-length") || "0");
    if (declared > MAX_SOURCE_PNG_BYTES) return null;
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length || data.length > MAX_SOURCE_PNG_BYTES) return null;
    if (!data.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return null;
    return data;
  } catch {
    return null;
  }
}

function candidateOpenExpression(base64: string) {
  return `(() => {
    window.__animeWinPng = { failed: false };
    const list = document.getElementById("viewFileList");
    if (list) list.innerHTML = "";
    try {
      const binary = atob(${JSON.stringify(base64)});
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: "image/png" });
      const inputUrl = document.getElementById("inputUrl");
      if (!inputUrl || typeof window.parse !== "function" || typeof URL.reset !== "function") return false;
      inputUrl.value = URL.reset(blob);
      window.parse();
      return true;
    } catch {
      return false;
    }
  })()`;
}

const VIEWER_STATE = `(() => {
  if (window.__animeWinPng && window.__animeWinPng.failed) return "failed";
  const root = document.getElementById("winPNG");
  if (root && root.classList.contains("progress")) return "wait";
  const entries = document.querySelectorAll("#viewFileList a[data-href]");
  if (!entries.length) return "wait";
  if (document.querySelector("#viewFileList a.processing")) return "wait";
  return "done";
})()`;

const COLLECT = `(async () => {
  const MAX_FILE = 8388608;
  const toBase64 = (bytes) => {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  };
  const read = async (url) => {
    if (!url) return null;
    try {
      const response = await fetch(url);
      if (!response.ok && !url.startsWith("blob:") && !url.startsWith("data:")) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_FILE) return null;
      return toBase64(bytes);
    } catch {
      return null;
    }
  };
  const output = [];
  for (const anchor of document.querySelectorAll("#viewFileList a[data-href]")) {
    const dir = anchor.querySelector(":scope > span:not(.file)")?.textContent || "";
    const originalName = anchor.download || anchor.querySelector(":scope > span.file")?.textContent || "";
    const dot = originalName.lastIndexOf(".");
    const stem = dot >= 0 ? originalName.slice(0, dot + 1) : originalName + ".";
    const ext = dot >= 0 ? originalName.slice(dot + 1).toLowerCase() : "";
    const nested = [...anchor.querySelectorAll("a")];

    const add = async (filePath, url, generated) => {
      const base64 = await read(url);
      if (base64) output.push({ path: dir + filePath, base64, generated });
    };

    if (ext === "jmk") {
      const assLink = nested.find((item) => (item.download || "").toLowerCase().endsWith(".ass"));
      const smiLink = nested.find((item) => (item.download || "").toLowerCase().endsWith(".smi"));
      const assUrl = anchor.getAttribute("data-ass");
      const smiUrl = anchor.getAttribute("data-smi");
      if (assUrl) await add(assLink?.download || stem + "ass", assUrl, true);
      if (smiUrl) await add(smiLink?.download || stem + "smi", smiUrl, true);
      // Raw JMK is intentionally never returned or cached. Once conversion
      // finishes, only playable ASS/SMI output may leave the temporary browser.
      continue;
    }

    if (["ass", "ssa", "smi", "srt", "vtt", "zip"].includes(ext)) {
      await add(originalName, anchor.getAttribute("data-href"), false);
    }
  }
  return output;
})()`;

async function decodeWithTistoryViewer(pageUrl: string, timeoutMs: number): Promise<TistoryWinPngFile[]> {
  const profileDir = await mkdtemp(path.join(tmpdir(), "anime-winpng-"));
  const args = [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-extensions",
    "--metrics-recording-only",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-allow-origins=*",
    "--remote-debugging-port=0",
    "--user-data-dir=" + profileDir,
    pageUrl,
  ];
  const child = spawn(CHROMIUM_BIN, args, {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      HOME: "/tmp",
      XDG_CONFIG_HOME: "/tmp",
      XDG_CACHE_HOME: "/tmp",
    },
  });

  let chromiumStderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    if (chromiumStderr.length < 12000) chromiumStderr += chunk;
  });

  let client: CdpClient | null = null;
  try {
    let port: number;
    try {
      // Chromium can take noticeably longer to become ready on a small Pi,
      // especially on the first cold launch after an image rebuild.
      port = await waitForDevToolsPort(profileDir, child, Math.min(20000, timeoutMs));
    } catch (error) {
      const detail = chromiumStderr.trim().slice(-6000);
      console.warn("[Tistory WinPNG] Chromium startup failed", {
        pageUrl,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        stderr: detail || "(no Chromium stderr)",
      });
      throw error;
    }
    const socketUrl = await targetWebSocket(port, pageUrl, Math.min(6000, timeoutMs));
    client = await CdpClient.connect(socketUrl, Math.min(5000, timeoutMs));
    await client.send("Runtime.enable");
    await client.send("Page.enable");

    const ready = await waitFor<boolean>(
      client,
      VIEWER_READY,
      Boolean,
      Math.min(20000, timeoutMs),
    );
    if (!ready) {
      console.warn("[Tistory WinPNG] viewer readiness timeout", { pageUrl, timeoutMs });
      return [];
    }

    await client.evaluate(SETUP);
    const candidates = await waitFor<Array<{ src: string }>>(
      client,
      CANDIDATES,
      (value) => Array.isArray(value) && value.length > 0,
      Math.min(8000, Math.max(1500, timeoutMs)),
      250,
    );
    if (!Array.isArray(candidates) || !candidates.length) {
      console.warn("[Tistory WinPNG] no original Kakao PNG candidates", { pageUrl });
      return [];
    }
    console.log("[Tistory WinPNG] candidates ready", { pageUrl, count: candidates.length });

    const collected: TistoryWinPngFile[] = [];
    const seen = new Set<string>();
    let totalBytes = 0;
    const deadline = Date.now() + timeoutMs;

    for (const candidate of candidates) {
      if (Date.now() >= deadline) break;
      // Fetch the original Kakao PNG in Node, not inside the Tistory page.
      // This avoids the browser CORS failure that made manual "online search"
      // creator confirmation fail even though the weekly downloader succeeded.
      const png = await downloadOriginalKakaoPng(
        candidate.src,
        pageUrl,
        Math.min(15000, Math.max(4000, deadline - Date.now())),
      );
      if (!png) {
        console.warn("[Tistory WinPNG] original Kakao PNG download failed", {
          pageUrl,
          candidate: candidate.src,
        });
        continue;
      }
      console.log("[Tistory WinPNG] original Kakao PNG downloaded", {
        pageUrl,
        bytes: png.length,
      });
      const opened = await client.evaluate<boolean>(
        candidateOpenExpression(png.toString("base64")),
        Math.min(12000, Math.max(1000, deadline - Date.now())),
      );
      if (!opened) {
        console.warn("[Tistory WinPNG] viewer rejected downloaded PNG", { pageUrl });
        continue;
      }

      const state = await waitFor<string>(
        client,
        VIEWER_STATE,
        (value) => value === "done" || value === "failed",
        Math.min(60000, Math.max(1000, deadline - Date.now())),
        250,
      );
      if (state !== "done") {
        console.warn("[Tistory WinPNG] conversion did not finish", {
          pageUrl,
          state: state || "timeout",
          remainingMs: Math.max(0, deadline - Date.now()),
        });
        continue;
      }

      const rows = await client.evaluate<Array<{ path: string; base64: string; generated: boolean }>>(
        COLLECT,
        Math.min(12000, Math.max(1000, deadline - Date.now())),
      );
      if (!Array.isArray(rows)) {
        console.warn("[Tistory WinPNG] viewer returned invalid rows", { pageUrl });
        continue;
      }
      console.log("[Tistory WinPNG] conversion rows collected", {
        pageUrl,
        rows: rows.length,
        paths: rows.slice(0, 8).map((row) => ({
          path: String(row?.path || "").slice(0, 300),
          generated: Boolean(row?.generated),
        })),
      });

      for (const row of rows) {
        const relative = safePath(row?.path);
        if (!relative || typeof row?.base64 !== "string") {
          console.warn("[Tistory WinPNG] converted row rejected", {
            pageUrl,
            path: String(row?.path || "").slice(0, 300),
            reason: !relative ? "unsafe_path" : "missing_base64",
          });
          continue;
        }
        let data: Buffer;
        try {
          data = Buffer.from(row.base64, "base64");
        } catch {
          continue;
        }
        if (!data.length || data.length > MAX_FILE_BYTES) continue;
        const key = relative.toLocaleLowerCase("ko-KR") + ":" + data.length + ":"
          + data.subarray(0, 32).toString("hex");
        if (seen.has(key)) continue;
        if (totalBytes + data.length > MAX_TOTAL_BYTES) break;
        seen.add(key);
        totalBytes += data.length;
        collected.push({ path: relative, data, generated: Boolean(row.generated) });
      }
    }
    console.log("[Tistory WinPNG] playable files collected", {
      pageUrl,
      count: collected.length,
      paths: collected.slice(0, 8).map((file) => file.path),
    });
    return collected;
  } finally {
    client?.close();
    try { child.kill("SIGKILL"); } catch {}
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function extractTistoryWinPngFiles(
  pageUrl: string,
  options: { timeoutMs?: number } = {},
): Promise<TistoryWinPngFile[]> {
  const parsed = allowedTistoryUrl(pageUrl);
  if (!parsed) return [];

  const cacheKey = parsed.toString();
  const cached = resultCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cloneFiles(cached.files);
  }

  return await runChromiumQueued(async () => {
    const second = resultCache.get(cacheKey);
    if (second && Date.now() - second.timestamp < CACHE_TTL_MS) {
      return cloneFiles(second.files);
    }

    // The proven downloader path allows up to 60 seconds for a single Jamaker
    // conversion. Raspberry Pi can exceed the old 9-second per-image web wait,
    // so give the browser path enough room to match that behavior.
    const timeoutMs = Math.max(45000, Math.min(options.timeoutMs ?? 75000, 90000));
    let files: TistoryWinPngFile[] = [];
    try {
      files = await decodeWithTistoryViewer(cacheKey, timeoutMs);
    } catch (error) {
      console.warn("[Tistory WinPNG web decode failed]", {
        pageUrl: cacheKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // PNG and JMK are transient decode inputs only. Never persist or cache them;
    // keep only playable subtitle output after extraction/conversion.
    files = files.filter((file) => /\.(?:ass|ssa|smi|srt|vtt|zip)$/i.test(file.path));
    // Never cache an empty/failed decode. A transient Tistory/Chromium load
    // issue must be allowed to retry immediately; only successful conversions
    // get the 10-minute warm cache.
    if (files.length) {
      resultCache.set(cacheKey, { timestamp: Date.now(), files: cloneFiles(files) });
      if (resultCache.size > 50) {
        const oldest = resultCache.keys().next().value;
        if (oldest) resultCache.delete(oldest);
      }
    } else {
      resultCache.delete(cacheKey);
    }
    return cloneFiles(files);
  });
}
