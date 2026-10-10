import type { AnimeListItem, AnimeListResponse } from './providers/types';

/** The fast upstream search is always the first stage of a current-site search.
 * Only an empty *visible* page requires the slower local subtitle database.
 */
export function prepareAnissiaApiSearch(result: AnimeListResponse, captionsOnly: boolean) {
  const items = captionsOnly
    ? result.items.filter(item => Number(item.caption_count || 0) > 0)
    : result.items;
  return {
    result: { ...result, items },
    needsDbFallback: items.length === 0,
  };
}

/**
 * Exclude the Anissia cards already on screen from an optional DB search.
 * Compare stable work IDs or exact detail links, never titles: seasons and
 * remakes can legitimately share the same title.
 */
export function filterSupplementalDbItems(
  dbItems: AnimeListItem[],
  upstreamItems: Pick<AnimeListItem, 'id' | 'detail_url'>[],
): AnimeListItem[] {
  const visibleIds = new Set(upstreamItems.map(item => item.id).filter(Boolean));
  const visibleUrls = new Set(upstreamItems.map(item => item.detail_url).filter(Boolean));
  const seen = new Set<string>();
  return dbItems.filter(item => {
    if ((item.id && visibleIds.has(item.id)) || (item.detail_url && visibleUrls.has(item.detail_url))) return false;
    const key = item.id || item.detail_url;
    if (key && seen.has(key)) return false;
    if (key) seen.add(key);
    return true;
  });
}
