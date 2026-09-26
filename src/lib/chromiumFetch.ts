import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CHROMIUM_BIN = process.env.CHROMIUM_BIN || "/usr/bin/chromium";
const htmlCache = new Map<string, { html: string; timestamp: number }>();

let chromiumQueue: Promise<void> = Promise.resolve();

async function runQueued<T>(task: () => Promise<T>): Promise<T> {
  const previous = chromiumQueue;
  let release!: () => void;
  chromiumQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

export async function fetchHtmlWithChromium(
  url: string,
  options: { timeoutMs?: number; cacheTtlMs?: number } = {}
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 12_000;
  const cacheTtlMs = options.cacheTtlMs ?? 60_000;
  const cached = htmlCache.get(url);
  if (cached && Date.now() - cached.timestamp < cacheTtlMs) {
    return cached.html;
  }

  return await runQueued(async () => {
    const secondCached = htmlCache.get(url);
    if (secondCached && Date.now() - secondCached.timestamp < cacheTtlMs) {
      return secondCached.html;
    }

    const profileDir = await mkdtemp(path.join(tmpdir(), "anime-chromium-"));
    try {
      const args = [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-sync",
        "--metrics-recording-only",
        "--no-first-run",
        "--no-default-browser-check",
        `--user-data-dir=${profileDir}`,
        "--dump-dom",
        url,
      ];

      let stdout = "";
      try {
        const result = await execFileAsync(CHROMIUM_BIN, args, {
          timeout: timeoutMs,
          maxBuffer: 12 * 1024 * 1024,
          env: {
            ...process.env,
            HOME: "/tmp",
            XDG_CONFIG_HOME: "/tmp",
            XDG_CACHE_HOME: "/tmp",
          },
        });
        stdout = result.stdout || "";
      } catch (error: any) {
        // Chromium은 일부 경고를 stderr에 남기면서도 DOM을 stdout으로 반환할 수 있다.
        stdout = typeof error?.stdout === "string" ? error.stdout : "";
        if (!stdout.trim()) {
          throw error;
        }
      }

      const html = stdout.trim();
      if (!html || (!html.includes("<html") && !html.includes("<!DOCTYPE") && !html.includes("<!doctype"))) {
        throw new Error("Chromium returned an empty or invalid HTML document");
      }

      htmlCache.set(url, { html, timestamp: Date.now() });
      if (htmlCache.size > 200) {
        const oldest = htmlCache.keys().next().value;
        if (oldest) htmlCache.delete(oldest);
      }
      return html;
    } finally {
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

export async function checkUrlWithChromium(
  url: string,
  timeoutMs = 10_000
): Promise<{ ok: boolean; latencyMs: number; statusText: string }> {
  const start = Date.now();
  try {
    const html = await fetchHtmlWithChromium(url, { timeoutMs, cacheTtlMs: 5_000 });
    return {
      ok: html.length > 100,
      latencyMs: Date.now() - start,
      statusText: "200 OK (Chromium)",
    };
  } catch (error: any) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      statusText: error?.message || "Chromium fetch failed",
    };
  }
}
