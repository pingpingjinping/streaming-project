import { applyCatalogVideoLinkStatus } from "./catalogVideoLinkStatus";
import type { ManualSubtitleSearchHit } from "./manualSubtitleSearch";
import type { AnimeListResponse } from "./providers/types";

/** Deduplicate before slicing, including duplicates on different upstream pages.
 * Stop once there is one distinct result beyond the requested page. No later
 * result is discarded by changing the upstream offset to a deduplicated count. */
export async function searchCatalogVideoPage(options: {
  page: number;
  readPage: (page: number) => Promise<AnimeListResponse | null>;
  manual?: ManualSubtitleSearchHit[];
}): Promise<AnimeListResponse | null> {
  const page = Math.max(1, Math.floor(options.page) || 1);
  const end = page * 20;
  const collected = new Map<string, AnimeListResponse["items"][number]>();
  for (let upstreamPage = 1; ; upstreamPage++) {
    const response = await options.readPage(upstreamPage);
    // Never publish an incomplete page as a successful empty/end-of-search.
    if (!response || response.error) return response;
    for (const item of response.items) if (!collected.has(item.id)) collected.set(item.id, item);
    // Keep Pi-only entries at stable positions even if their remote alias first
    // appears on a later upstream page. Moving them at that point would shift a
    // previously returned page and skip a distinct result at its boundary.
    const overlaidById = new Map((options.manual || []).map(hit => [hit.item.id, {
      ...hit.item, poster: hit.item.poster || collected.get(hit.item.id)?.poster || "",
    }]));
    for (const item of collected.values()) if (!overlaidById.has(item.id)) overlaidById.set(item.id, item);
    const overlaid = [...overlaidById.values()];
    const unique = await applyCatalogVideoLinkStatus(overlaid, { deduplicate: true });
    const complete = !response.has_next;
    if (complete || unique.length > end) {
      return {
        items: unique.slice((page - 1) * 20, end), page,
        has_next: unique.length > end,
        total_pages: Math.max(1, Math.ceil(unique.length / 20)),
        total_pages_exact: complete,
      };
    }
  }
}
