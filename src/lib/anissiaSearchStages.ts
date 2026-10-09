import type { AnimeListResponse } from './providers/types';

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
