import type { AnimeListResponse } from "./providers/types";
import { convertCloudflareSearchResponse } from "./cloudflareSearchResponse";

const WORKER_SEARCH_URL = "https://anime-search-api.pingpingjinping.workers.dev/search";

/**
 * First pass of a current-site Anissia search.
 * The read-only Cloudflare D1 index is faster and avoids the Pi's catalog DB.
 * Null means no *visible* hits or a Worker error: preserve the pre-existing
 * Anissia API -> local reviewed subtitle DB fallback in the caller.
 */
export async function searchCloudflareAnimeFirst(
  keyword: string,
  page: number,
  captionsOnly: boolean,
): Promise<AnimeListResponse | null> {
  if (!keyword || keyword.length > 100 || !Number.isSafeInteger(page) || page < 1 || page > 100) {
    return null;
  }
  const endpoint = new URL(WORKER_SEARCH_URL);
  endpoint.searchParams.set("q", keyword);
  endpoint.searchParams.set("page", String(page));
  try {
    const response = await fetch(endpoint, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) throw new Error("Cloudflare search HTTP " + response.status);
    const result = convertCloudflareSearchResponse(await response.json(), page, captionsOnly);
    return result.items.length ? result : null;
  } catch (error) {
    console.warn("[Cloudflare first search: Anissia fallback]", error);
    return null;
  }
}
