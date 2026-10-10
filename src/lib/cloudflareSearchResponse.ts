import type { AnimeListItem, AnimeListResponse } from "./providers/types";

interface CloudflareWork {
  id?: unknown;
  title?: unknown;
  poster?: unknown;
  detail_url?: unknown;
  source_name?: unknown;
  caption_count?: unknown;
  remarks?: unknown;
}

/** Only expose canonical local anime/catalog links returned by our D1 index. */
function safeWorkLink(id: string, detailUrl: string): boolean {
  if (id.startsWith("ani_") || id.startsWith("re_")) {
    return detailUrl === "/anime/" + encodeURIComponent(id).replace(/%2F/gi, "/") ||
      detailUrl === "/anime/" + id;
  }
  const match = /^db_(AniList|Onnada)_([^/]+)$/.exec(id);
  if (!match) return false;
  return detailUrl === "/catalog/" + match[1] + "/" + encodeURIComponent(match[2]) ||
    detailUrl === "/catalog/" + match[1] + "/" + match[2];
}

/** Convert the public Cloudflare Worker format to the site's existing card format. */
export function convertCloudflareSearchResponse(
  payload: unknown,
  page: number,
  captionsOnly: boolean,
): AnimeListResponse {
  if (!payload || typeof payload !== "object") throw new Error("Invalid Cloudflare search response");
  // The Worker may expose its records under "results" rather than "items".
  const data = payload as {
    items?: unknown; results?: unknown; total?: unknown;
    total_pages?: unknown; has_next?: unknown;
  };
  const records = Array.isArray(data.items) ? data.items : data.results;
  if (!Array.isArray(records) || records.length > 20) {
    throw new Error("Invalid Cloudflare search items");
  }

  const items: AnimeListItem[] = [];
  for (const value of records as CloudflareWork[]) {
    if (!value || typeof value !== "object") continue;
    const id = typeof value.id === "string" ? value.id : "";
    const title = typeof value.title === "string" ? value.title : "";
    const detailUrl = typeof value.detail_url === "string" ? value.detail_url : "";
    if (!id || !title || !safeWorkLink(id, detailUrl)) continue;
    const captions = typeof value.caption_count === "number" &&
      Number.isFinite(value.caption_count) ? Math.max(0, value.caption_count) : 0;
    if (captionsOnly && captions === 0) continue;
    items.push({
      id,
      title,
      detail_url: detailUrl,
      poster: typeof value.poster === "string" && /^https:\/\//.test(value.poster) ? value.poster : "",
      source_name: typeof value.source_name === "string" ? value.source_name : "",
      caption_count: captions,
      remarks: typeof value.remarks === "string" ? value.remarks : "",
    });
  }
  const total = Number(data.total);
  const totalPages = Number(data.total_pages);
  const pages = Number.isSafeInteger(totalPages) && totalPages >= 1 ? totalPages
    : Number.isSafeInteger(total) && total >= 0 ? Math.max(1, Math.ceil(total / 20)) : 1;
  return {
    items,
    page,
    total_pages: Math.min(pages, 100),
    has_next: typeof data.has_next === "boolean" ? data.has_next && page < 100
      : page < pages,
  };
}
