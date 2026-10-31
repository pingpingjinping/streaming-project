import * as cheerio from "cheerio";

export interface SubtitleDownload {
  buffer: Buffer;
  filename: string;
  sourceFilename?: string;
}

export function googleDriveFileId(value: string): string | null {
  try {
    const url = new URL(value.replace(/&amp;/g, "&"));
    if (!["drive.google.com", "docs.google.com", "drive.usercontent.google.com"].includes(url.hostname)
        || url.username || url.password || url.port) return null;
    const id = url.pathname.match(/^\/file\/d\/([\w-]{25,})(?:\/|$)/)?.[1]
      || (/^\/(?:open|uc|download)$/.test(url.pathname) ? url.searchParams.get("id") : null);
    return id && /^[\w-]{25,}$/.test(id) ? id : null;
  } catch { return null; }
}

export function boxSharedFile(value: string): string | null {
  try {
    const url = new URL(value);
    if (!["app.box.com", "www.box.com", "box.com"].includes(url.hostname)
        || url.username || url.password || url.port) return null;
    return url.pathname.match(/^\/s\/([a-zA-Z0-9_-]+)(?:\/file\/\d+)?\/?$/)?.[1] || null;
  } catch { return null; }
}

function responseFilename(response: Response): string {
  const disposition = response.headers.get("content-disposition") || "";
  const encoded = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  if (encoded) { try { return decodeURIComponent(encoded.trim()); } catch {} }
  const plain = disposition.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
  let filename = plain?.[1] || plain?.[2]?.trim() || "";
  // Some cloud servers send UTF-8 bytes in the legacy filename header.
  if (filename && /^[\u0000-\u00ff]*$/.test(filename)) {
    const decoded = Buffer.from(filename, "latin1").toString("utf8");
    if (!decoded.includes("\ufffd")) filename = decoded;
  }
  return filename;
}

async function responseBytes(response: Response): Promise<Buffer> {
  const limit = 32 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("Subtitle download exceeds 32 MiB");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error("Subtitle download exceeds 32 MiB"); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

function isHtml(buffer: Buffer, response: Response): boolean {
  const sample = buffer.subarray(0, 300).toString("utf8");
  // A few attachment hosts serve valid SAMI with a text/html content type.
  if (/^\s*\ufeff?\s*<sami\b/i.test(sample)
      || buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))
      || buffer.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) return false;
  return /text\/html|application\/xhtml\+xml/i.test(response.headers.get("content-type") || "")
    || /<!doctype\s+html|<html\b/i.test(sample);
}

function driveConfirmation(html: string, pageUrl: string, fileId: string): string | null {
  const $ = cheerio.load(html);
  for (const node of $("form").toArray()) {
    const form = $(node);
    if ((form.attr("method") || "get").toLowerCase() !== "get") continue;
    let url: URL;
    try { url = new URL(form.attr("action") || "", pageUrl); } catch { continue; }
    if (url.protocol !== "https:" || url.username || url.password || url.port
        || !["drive.google.com", "docs.google.com", "drive.usercontent.google.com"].includes(url.hostname)
        || !/^\/(?:download|uc)$/.test(url.pathname)) continue;
    form.find('input[type="hidden"][name]').each((_, input) => {
      url.searchParams.set($(input).attr("name")!, $(input).attr("value") || "");
    });
    if (url.searchParams.get("id") === fileId && url.searchParams.get("export") === "download"
        && url.searchParams.get("confirm")) return url.toString();
  }
  // Older Drive warning pages use a link rather than a form.
  for (const node of $("a#uc-download-link[href]").toArray()) {
    let url: URL;
    try { url = new URL($(node).attr("href")!, pageUrl); } catch { continue; }
    if (url.protocol === "https:" && !url.username && !url.password && !url.port
        && ["drive.google.com", "docs.google.com", "drive.usercontent.google.com"].includes(url.hostname)
        && /^\/(?:download|uc)$/.test(url.pathname) && url.searchParams.get("id") === fileId
        && url.searchParams.get("export") === "download" && url.searchParams.get("confirm")) return url.toString();
  }
  return null;
}

/** Parse public page JSON without executing the page's scripts. */
function boxPageJson(html: string, field: string): Record<string, any> | null {
  const match = new RegExp(`Box\\.${field}\\s*=\\s*`).exec(html);
  if (!match) return null;
  const start = match.index + match[0].length;
  if (html[start] !== "{") return null;
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < html.length; index++) {
    const c = html[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try { return JSON.parse(html.slice(start, index + 1)); } catch { return null; }
    }
  }
  return null;
}

/** Public cloud adapters share one deadline, including response bodies. */
export async function downloadSubtitleFile(
  url: string, headers: Record<string, string>, timeoutMs: number,
): Promise<SubtitleDownload | null> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const driveId = googleDriveFileId(url);
    const share = boxSharedFile(url);
    if (driveId) {
      // Drive can repeat the warning indefinitely when the confirmation is
      // submitted with the originating blog as Referer. Public file downloads
      // do not need that blog header; other attachment hosts still keep it.
      headers = { ...headers, Accept: "*/*" };
      for (const key of Object.keys(headers)) if (key.toLowerCase() === "referer") delete headers[key];
    }
    let current = driveId ? `https://drive.usercontent.google.com/download?id=${driveId}&export=download` : url;
    let sourceFilename: string | undefined;
    if (share) {
      const page = await fetch(url, { headers, signal });
      if (!page.ok) { await page.body?.cancel(); return null; }
      const html = (await responseBytes(page)).toString("utf8");
      const metadata = boxPageJson(html, "prefetchedData")?.preview_metadata;
      const shared = boxPageJson(html, "postStreamData")?.["/app-api/enduserapp/shared-item"];
      if (metadata?.type !== "file" || metadata.permissions?.can_download !== true
          || !/^\d+$/.test(String(metadata.id)) || shared?.itemType !== "file"
          || String(shared.itemID) !== String(metadata.id) || shared.sharedName !== share
          || !/\.(?:zip|ass|ssa|srt|smi|vtt)$/i.test(metadata.name || "")) return null;
      const selectedId = new URL(url).pathname.match(/\/file\/(\d+)/)?.[1];
      if (selectedId && selectedId !== String(metadata.id)) return null;
      sourceFilename = metadata.name;
      const download = new URL("https://app.box.com/index.php");
      download.search = new URLSearchParams({ rm: "box_download_shared_file", shared_name: share,
        file_id: "f_" + metadata.id }).toString();
      current = download.toString();
      headers = { ...headers, Referer: url };
    }
    const visited = new Set<string>();
    let driveFallback = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (visited.has(current)) return null;
      visited.add(current);
      const response = await fetch(current, { headers, signal });
      if (!response.ok) {
        await response.body?.cancel();
        if (!driveId || driveFallback) return null;
        driveFallback = true;
        current = `https://docs.google.com/uc?export=download&id=${driveId}&confirm=t`;
        continue;
      }
      const buffer = await responseBytes(response);
      if (!isHtml(buffer, response)) return { buffer, filename: responseFilename(response) || sourceFilename || "", sourceFilename };
      if (!driveId) return null;
      const next = driveConfirmation(buffer.toString("utf8"), response.url || current, driveId);
      if (!next) return null;
      current = next;
    }
  } catch { /* Unavailable links leave other subtitle candidates eligible. */ }
  return null;
}
