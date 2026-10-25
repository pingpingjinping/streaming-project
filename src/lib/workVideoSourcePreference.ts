import { getWorkVideoSourceChoice, type WorkVideoSource } from "./db";
import { getLocalReanimeDetail } from "./localReanimeDetail";
import { getAnikotoPlaybackCandidates } from "./anikotoLinks";
import { getEffectiveReanimeIdsForAnissia } from "./reanimeMatches";

/** Use only locally stored, explicitly confirmed unplayable ReAnime metadata.
 * Never assume that missing / slow upstream means an unavailable video.
 * Ambiguous Anikoto connections remain in the existing manual-selection flow.
 */
export async function getDbBackedWorkVideoSource(animeId: string): Promise<"anikoto" | null> {
  if (!/^re_[A-Za-z0-9_-]+$/.test(animeId) && !/^ani_[1-9]\d*$/.test(animeId)) return null;
  try {
    let reanimeId = animeId;
    if (animeId.startsWith("ani_")) {
      const no = Number(animeId.slice(4));
      const linked = (await getEffectiveReanimeIdsForAnissia([no])).get(no);
      if (!linked || !/^[A-Za-z0-9_-]+$/.test(linked)) return null;
      reanimeId = "re_" + linked;
    }
    const local = await getLocalReanimeDetail(reanimeId, true);
    if (!local || local.video_available !== false) return null;
    const candidates = (await getAnikotoPlaybackCandidates(animeId, 1, true))
      .filter(row => ["manual", "reviewed", "multi_reviewed", "automatic"].includes(row.linkStatus)
        && /^ak_[A-Za-z0-9_-]+$/.test(row.animeId));
    return new Set(candidates.map(row => row.animeId)).size === 1 ? "anikoto" : null;
  } catch (error) {
    console.warn("[workVideoSourcePreference] Unable to confirm DB video status", error);
    return null;
  }
}

/** Explicit per-account selection always wins. Otherwise preserve the default
 * ReAnime path except for an exact DB-confirmed metadata-only work.
 */
export async function resolveWorkVideoSource(
  userId: string, animeId: string,
): Promise<WorkVideoSource | undefined> {
  const selected = await getWorkVideoSourceChoice(userId, animeId);
  if (selected) return selected;
  return (await getDbBackedWorkVideoSource(animeId)) || undefined;
}
