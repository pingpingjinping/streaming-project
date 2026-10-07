import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runChromiumQueued } from "@/lib/chromiumFetch";

const CHROMIUM_BIN = process.env.CHROMIUM_BIN || "/usr/bin/chromium";
const MAX_CANDIDATES = 6;
const MAX_FILE_BYTES = 8388608;
const MAX_TOTAL_BYTES = 20971520;
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
  const nodes = document.querySelectorAll(
    "#content img, .tt_article_useless_p_margin img, .contents_style img"
  );
  nodes.forEach((img, index) => {
    const sources = [
      img.getAttribute("data-url") || "",
      img.getAttribute("data-phocus") || "",
      img.currentSrc || "",
      img.src || "",
    ].filter(Boolean);
    const src = sources.find((value) => value.split("?")[0].toLowerCase().endsWith(".png")) || "";
    if (!src || seen.has(src)) return;
    seen.add(src);
    const key = "anime-wp-" + index;
    img.setAttribute("data-anime-wp-key", key);
    out.push({ key, src });
  });
  return out.slice(0, 6);
})()`;

function candidateClickExpression(key: string) {
  return "(() => {"
    + "window.__animeWinPng={failed:false};"
    + "const list=document.getElementById('viewFileList');if(list)list.innerHTML='';"
    + "const key=" + JSON.stringify(key) + ";"
    + "const image=[...document.querySelectorAll('img[data-anime-wp-key]')].find((img)=>img.getAttribute('data-anime-wp-key')===key);"
    + "if(!image)return false;image.click();return true;"
    + "})()";
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
      if (!assUrl && !smiUrl) await add(originalName, anchor.getAttribute("data-href"), false);
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
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...process.env,
      HOME: "/tmp",
      XDG_CONFIG_HOME: "/tmp",
      XDG_CACHE_HOME: "/tmp",
    },
  });

  let client: CdpClient | null = null;
  try {
    const port = await waitForDevToolsPort(profileDir, child, Math.min(8000, timeoutMs));
    const socketUrl = await targetWebSocket(port, pageUrl, Math.min(6000, timeoutMs));
    client = await CdpClient.connect(socketUrl, Math.min(5000, timeoutMs));
    await client.send("Runtime.enable");
    await client.send("Page.enable");

    const ready = await waitFor<boolean>(
      client,
      VIEWER_READY,
      Boolean,
      Math.min(15000, timeoutMs),
    );
    if (!ready) return [];

    await client.evaluate(SETUP);
    const candidates = await client.evaluate<Array<{ key: string; src: string }>>(CANDIDATES);
    if (!Array.isArray(candidates) || !candidates.length) return [];

    const collected: TistoryWinPngFile[] = [];
    const seen = new Set<string>();
    let totalBytes = 0;
    const deadline = Date.now() + timeoutMs;

    for (const candidate of candidates) {
      if (Date.now() >= deadline) break;
      const clicked = await client.evaluate<boolean>(candidateClickExpression(candidate.key));
      if (!clicked) continue;

      const state = await waitFor<string>(
        client,
        VIEWER_STATE,
        (value) => value === "done" || value === "failed",
        Math.min(9000, Math.max(1000, deadline - Date.now())),
        220,
      );
      if (state !== "done") continue;

      const rows = await client.evaluate<Array<{ path: string; base64: string; generated: boolean }>>(
        COLLECT,
        Math.min(12000, Math.max(1000, deadline - Date.now())),
      );
      if (!Array.isArray(rows)) continue;

      for (const row of rows) {
        const relative = safePath(row?.path);
        if (!relative || typeof row?.base64 !== "string") continue;
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

    const timeoutMs = Math.max(8000, Math.min(options.timeoutMs ?? 28000, 45000));
    let files: TistoryWinPngFile[] = [];
    try {
      files = await decodeWithTistoryViewer(cacheKey, timeoutMs);
    } catch (error) {
      console.warn("[Tistory WinPNG web decode failed]", {
        pageUrl: cacheKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    resultCache.set(cacheKey, { timestamp: Date.now(), files: cloneFiles(files) });
    if (resultCache.size > 50) {
      const oldest = resultCache.keys().next().value;
      if (oldest) resultCache.delete(oldest);
    }
    return cloneFiles(files);
  });
}
