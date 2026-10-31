import * as cheerio from "cheerio";

function naverPost(value: string): { blogId: string; logNo: string; mobile: boolean } | null {
  try {
    const url = new URL(value);
    if (!["blog.naver.com", "m.blog.naver.com"].includes(url.hostname)
        || url.username || url.password || url.port) return null;
    const path = url.pathname.match(/^\/([\w-]+)\/(\d+)\/?$/);
    const blogId = path?.[1] || url.searchParams.get("blogId") || "";
    const logNo = path?.[2] || url.searchParams.get("logNo") || "";
    return /^[\w-]+$/.test(blogId) && /^\d+$/.test(logNo)
      ? { blogId, logNo, mobile: url.hostname === "m.blog.naver.com" } : null;
  } catch { return null; }
}

export async function fetchSubtitleBlogPage(
  value: string, headers: Record<string, string>, timeoutMs: number,
): Promise<{ html: string; url: string } | null> {
  const post = naverPost(value);
  const urls = post ? [post.mobile ? "m.blog.naver.com" : "blog.naver.com",
    post.mobile ? "blog.naver.com" : "m.blog.naver.com"].map(host =>
    `https://${host}/PostView.naver?blogId=${post.blogId}&logNo=${post.logNo}`) : [value];
  const signal = AbortSignal.timeout(post ? Math.max(timeoutMs, 8000) : timeoutMs);
  for (const url of urls) {
    try {
      const response = await fetch(url, { headers, signal });
      if (!response.ok) { await response.body?.cancel(); continue; }
      const html = await response.text();
      if (post) {
        const $ = cheerio.load(html);
        if (!$("#postViewArea, .se-main-container").length) continue;
      }
      return { html, url: response.url || url };
    } catch { if (signal.aborted) break; }
  }
  return null;
}

/** Naver also uses table.post-body for its navigation and notices. */
export function subtitleBlogContent($: cheerio.CheerioAPI, pageUrl: string) {
  const post = naverPost(pageUrl);
  if (post) {
    const current = $("#post-view" + post.logNo).first();
    if (current.length) return current;
  }
  for (const selector of [".tt_article_useless_p_margin", ".se-main-container", "#postViewArea",
    ".post-body:not(table)", ".entry-content"]) {
    const content = $(selector).first();
    if (content.length) return content;
  }
  return $("body");
}

export function subtitleAttachmentIdentity(value: string): string {
  const url = new URL(value);
  // Naver changes the signed /open/<token> prefix on each render. Preserve the
  // stable attachment path so script fallback cannot revive a rejected label.
  return url.hostname === "download.blog.naver.com"
    ? "naver:" + url.pathname.split("/").slice(-2).join("/") : value;
}

export function naverScriptAttachments(html: string, pageUrl: string): Array<{ url: string; filename: string }> {
  const post = naverPost(pageUrl);
  if (!post) return [];
  const rows = [...html.matchAll(/aPostFiles\[(\d+)\]\s*=\s*JSON\.parse\('((?:\\.|[^'\\])*)'\s*\.replace/gs)];
  const bases = new Map([...html.matchAll(/aPostBaseInfo\[(\d+)\]\s*=\s*["'](\d+)\|/g)]
    .map(match => [match[1], match[2]]));
  const attachments: Array<{ url: string; filename: string }> = [];
  for (const row of rows) {
    if (bases.size ? bases.get(row[1]) !== post.logNo : rows.length !== 1) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(row[2]); } catch {
      try { parsed = JSON.parse(row[2].replace(/\\'/g, "'").replace(/\\\\/g, "\\")); } catch { continue; }
    }
    if (!Array.isArray(parsed)) continue;
    for (const item of parsed.slice(0, 200)) {
      if (!item || typeof item !== "object" || typeof item.encodedAttachFileUrl !== "string"
          || typeof item.encodedAttachFileName !== "string") continue;
      let url: URL;
      try { url = new URL(item.encodedAttachFileUrl.replace(/&amp;/g, "&")); } catch { continue; }
      if (url.protocol !== "https:" || url.username || url.password || url.port
          || url.hostname !== "download.blog.naver.com") continue;
      let filename = item.encodedAttachFileName;
      try { filename = decodeURIComponent(filename); } catch {}
      if (/\.(?:zip|ass|ssa|srt|smi|vtt)$/i.test(filename)) attachments.push({ url: url.toString(), filename });
    }
  }
  return attachments;
}
