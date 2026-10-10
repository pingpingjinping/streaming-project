/**
 * Catalog pages are only a fallback for subtitle-only entries and ambiguous
 * video matches. Verified, unambiguous playback IDs should open their regular
 * anime detail page immediately instead of stopping on a catalog intermediary.
 *
 * Anikoto multi_reviewed mappings deliberately remain on the catalog page:
 * a single video listing can span several distinct TV seasons.
 */
export type CatalogStreamLink = { anikoto_id: string; link_status: string };

const valid = (id: string) => /^[A-Za-z0-9_-]+$/.test(id);

export function directCatalogPlaybackHref(
  members: string[],
  streams: CatalogStreamLink[],
): string | null {
  // Only source IDs already present in the exact administrator-reviewed group
  // are eligible. Never infer a video work from the catalog's Korean title.
  for (const prefix of ["ani_", "re_"]) {
    const sourceIds = [...new Set(members.filter(id =>
      id.startsWith(prefix) && valid(id.slice(prefix.length))))];
    if (sourceIds.length > 1) return null; // multiple seasons/works: choose manually
    if (sourceIds.length === 1) return "/anime/" + encodeURIComponent(sourceIds[0]);
  }

  // The Anikoto catalog lookup is independently reviewed and can resolve a
  // catalog work even if its video ID wasn't included in the local link table.
  // Do not automatically enter any ambiguous or multi-season lookup.
  if (streams.some(row => row.link_status === "multi_reviewed")) return null;
  const streamIds = [...new Set(streams
    .filter(row => ["reviewed", "automatic"].includes(row.link_status))
    .map(row => row.anikoto_id)
    .filter(valid))];
  return streamIds.length === 1 ? "/anime/ak_" + encodeURIComponent(streamIds[0]) : null;
}

export function directManualSearchHref(itemId: string, candidateUrl: string): string | null {
  if (!/^db_(AniList|Onnada)_[A-Za-z0-9_-]+$/.test(itemId)) return null;
  if (!/^\/anime\/(?:ani_[1-9]\d*|re_[A-Za-z0-9_-]+|ak_[A-Za-z0-9_-]+)$/.test(candidateUrl)) return null;
  return candidateUrl;
}
