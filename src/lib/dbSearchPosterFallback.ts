/** Determine when a card should ask Pi for artwork verified by exact work ID. */
const ANISSIA_LEGACY_PLACEHOLDER = "https://images.unsplash.com/photo-1578632767115-351597cf2477";
const WORK_ID = /^(?:ani_\d+|re_[A-Za-z0-9_-]+|ak_[A-Za-z0-9_-]+|db_(?:AniList|Onnada)_[A-Za-z0-9_-]+)$/;

export function shouldFetchVerifiedPoster(animeId: string, poster: string): boolean {
  if (!WORK_ID.test(animeId)) return false;
  if (!poster) return true;
  // Anissia recent-caption/feed cards fill unknown artwork with this stock image.
  // It is NOT verified artwork; never let it block the lazy Pi-backed fallback.
  return /^ani_\d+$/.test(animeId) && poster.startsWith(ANISSIA_LEGACY_PLACEHOLDER);
}
