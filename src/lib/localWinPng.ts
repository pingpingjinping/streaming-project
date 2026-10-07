import { spawn } from "node:child_process";
import path from "node:path";
import * as cheerio from "cheerio";
import type { TistoryWinPngFile } from "@/lib/tistoryWinPng";

export function originalPngCandidates(html: string, pageUrl: string): string[] {
  const $ = cheerio.load(html);
  const roots = $("#content, .tt_article_useless_p_margin, .contents_style");
  const nodes = roots.length ? roots.add(roots.find("*")) : $("body *");
  const found = new Set<string>();
  const containers = new Set<unknown>();
  nodes.each((_, node) => {
    if (found.size >= 6) return false;
    if ($(node).parents().toArray().some(parent => containers.has(parent))) return;
    for (const attr of ["data-url", "data-phocus", "src"]) {
      const raw = $(node).attr(attr);
      if (!raw) continue;
      try {
        const url = new URL(raw, pageUrl), host = url.hostname.toLowerCase();
        if (!["https:", "http:"].includes(url.protocol)
          || !(host === "blog.kakaocdn.net" || host.endsWith(".kakaocdn.net"))
          || !url.pathname.toLowerCase().endsWith(".png")) continue;
        found.add(url.toString());
        containers.add(node);
        break;
      } catch {}
    }
  });
  return [...found];
}

export async function decodeLocalWinPng(png: Buffer, timeoutMs = 30000): Promise<{
  files: TistoryWinPngFile[]; pending: Array<{ path: string; reason: string }>;
}> {
  // Keep pixel decoding and untrusted subtitle processing off the web event loop.
  // JMK previews contain only main dialogue/syncs. No embedded scripts execute.
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=128",
      path.join(process.cwd(), "scripts/winpng/cli.cjs")], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = []; let length = 0, stderr = "", finished = false;
    const finish = (error?: Error, value?: Parameters<typeof resolve>[0]) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      child.kill("SIGKILL");
      if (error) reject(error); else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error("local_winpng_timeout")),
      Math.max(1, Math.min(timeoutMs, 30000)));
    child.on("error", error => finish(error));
    child.stdin.on("error", error => finish(error));
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > 29 * 1024 * 1024) finish(new Error("local_winpng_output_limit"));
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 1000) stderr += chunk.toString(); });
    child.on("close", code => {
      if (code !== 0) return finish(new Error(stderr || "local_winpng_worker_failed"));
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!Array.isArray(result.files) || !Array.isArray(result.pending)) throw new Error("invalid_worker_output");
        finish(undefined, {
          files: result.files.map((f: {path: string; base64: string; generated: boolean; temporary?: boolean}) => ({
            path: f.path, data: Buffer.from(f.base64, "base64"), generated: !!f.generated, temporary: !!f.temporary,
          })), pending: result.pending,
        });
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    child.stdin.end(JSON.stringify({ png: png.toString("base64") }));
  });
}
