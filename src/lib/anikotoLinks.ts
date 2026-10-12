import { getDb } from "./db";
import { reviewedAnikotoRanges } from "./episodeMapping";
import { getAnikotoWorkOverride } from "./anikotoWorkOverrides";

export interface AnikotoPlaybackCandidate {
  animeId: string;
  episodeNumber: number;
  mappingKind: string;
  linkStatus: string;
  sourceStart?: number;
  targetStart?: number;
  targetEnd?: number;
}

type WorkKey = { source: "Anissia" | "ReAnime"; sourceId: string };

function workKeyFromAnimeId(animeId: string): WorkKey | null {
  if (animeId.startsWith("ani_")) {
    const sourceId = animeId.slice(4);
    return /^\d+$/.test(sourceId) ? { source: "Anissia", sourceId } : null;
  }
  if (animeId.startsWith("re_")) {
    const sourceId = animeId.slice(3).trim();
    return sourceId ? { source: "ReAnime", sourceId } : null;
  }
  return null;
}

function integerOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * Translate a canonical work episode number to the episode number used by one
 * Anikoto source. Unknown-order mappings are deliberately not guessed.
 */
export function mapAnikotoEpisode(
  row: {
    mapping_kind?: unknown;
    anikoto_episode_start?: unknown;
    anikoto_episode_end?: unknown;
    target_episode_start?: unknown;
    target_episode_end?: unknown;
  },
  episodeNumber: number
): number | null {
  if (!Number.isInteger(episodeNumber) || episodeNumber < 0) return null;

  const kind = String(row.mapping_kind || "whole");
  if (kind === "whole") return episodeNumber;
  if (kind === "unknown_order") return null;

  const sourceStart = integerOrNull(row.anikoto_episode_start);
  const sourceEnd = integerOrNull(row.anikoto_episode_end);
  const targetStart = integerOrNull(row.target_episode_start);
  const targetEnd = integerOrNull(row.target_episode_end);

  if (sourceStart === null || targetStart === null) return null;
  const resolvedSourceEnd = sourceEnd ?? sourceStart;
  const resolvedTargetEnd = targetEnd ?? targetStart;
  if (episodeNumber < targetStart || episodeNumber > resolvedTargetEnd) return null;

  // Only apply an offset when the reviewed ranges describe a one-to-one span.
  // Shared/irregular ranges remain manual instead of risking the wrong episode.
  if (resolvedSourceEnd - sourceStart !== resolvedTargetEnd - targetStart) return null;

  return sourceStart + (episodeNumber - targetStart);
}

/** Use an already-proven canonical ID without repeating remote title searches. */
export async function getAnikotoPlaybackCandidatesByAniList(
  anilistId: number, episodeNumber: number, includeCatalog = false,
): Promise<AnikotoPlaybackCandidate[]> {
  if (!Number.isInteger(anilistId) || anilistId <= 0) return [];
  const sql = getDb();
  if (!sql) return [];
  try {
    const rows = await sql`SELECT anikoto_id, target_order, link_status, mapping_kind,
      anikoto_episode_start, anikoto_episode_end, target_episode_start, target_episode_end
      FROM anime_anikoto_work_targets
      WHERE target_source='AniList' AND target_id=${String(anilistId)}
        AND link_status IN ('reviewed','multi_reviewed','automatic')
      ORDER BY CASE link_status WHEN 'multi_reviewed' THEN 0 WHEN 'reviewed' THEN 1 ELSE 2 END,
        anikoto_id, target_order`;
    return rows.flatMap(row => {
      if (row.mapping_kind && row.mapping_kind !== 'whole' &&
          mapAnikotoEpisode(row, integerOrNull(row.target_episode_start) ?? -1) === null) return [];
      const mapped = mapAnikotoEpisode(row, episodeNumber);
      if (mapped === null && (!includeCatalog || row.mapping_kind === 'unknown_order')) return [];
      return [{ animeId: `ak_${row.anikoto_id}`, episodeNumber: mapped ?? -1,
        mappingKind: String(row.mapping_kind || 'whole'), linkStatus: String(row.link_status || ''),
        sourceStart: integerOrNull(row.anikoto_episode_start) ?? undefined,
        targetStart: integerOrNull(row.target_episode_start) ?? undefined,
        targetEnd: integerOrNull(row.target_episode_end) ?? undefined }];
    });
  } catch {
    return [];
  }
}

/**
 * Return only DB-reviewed Anikoto candidates for the currently viewed canonical
 * work. A single Anikoto source may map to multiple seasons; range metadata
 * keeps each detail/watch page inside its own reviewed episode span.
 */
export async function getAnikotoPlaybackCandidates(
  animeId: string,
  episodeNumber: number,
  includeCatalog = false,
): Promise<AnikotoPlaybackCandidate[]> {
  const work = workKeyFromAnimeId(animeId);
  const sql = getDb();
  if (!work) return [];
  // Local administrator choice wins over all imported/automatic Anikoto IDs.
  // Do not flatten multi-season reviewed ranges to whole-season links.
  if (work.source === "Anissia") {
    const manual = await getAnikotoWorkOverride(Number(work.sourceId));
    if (manual) {
      const row = {
        mapping_kind: manual.mappingKind,
        anikoto_episode_start: manual.anikotoEpisodeStart,
        anikoto_episode_end: manual.anikotoEpisodeEnd,
        target_episode_start: manual.targetEpisodeStart,
        target_episode_end: manual.targetEpisodeEnd,
      };
      const mapped = mapAnikotoEpisode(row, episodeNumber);
      if (mapped === null) return [];
      return [{
        animeId: "ak_" + manual.anikotoId,
        episodeNumber: mapped, mappingKind: manual.mappingKind,
        linkStatus: "manual", sourceStart: manual.anikotoEpisodeStart ?? undefined,
        targetStart: manual.targetEpisodeStart ?? undefined,
        targetEnd: manual.targetEpisodeEnd ?? undefined,
      }];
    }
  }

  try {
    const rows: any[] = sql ? await sql`
      SELECT anikoto_id, target_order, link_status, mapping_kind,
             anikoto_episode_start, anikoto_episode_end,
             target_episode_start, target_episode_end
      FROM anime_anikoto_work_lookup
      WHERE source = ${work.source}
        AND source_record_id = ${work.sourceId}
      ORDER BY
        CASE link_status
          WHEN 'multi_reviewed' THEN 0
          WHEN 'reviewed' THEN 1
          WHEN 'automatic' THEN 2
          ELSE 3
        END,
        anikoto_id,
        target_order
    ` : [];

    // Bundled reviewed ranges repair this known split without changing any
    // user-reviewed explicit range. A whole-work link cannot express it.
    for (const range of reviewedAnikotoRanges(animeId)) {
      const index = rows.findIndex(row => row.anikoto_id === range.anikoto_id);
      if (index < 0) rows.push({ ...range, link_status: "reviewed" });
      else if (!rows[index].mapping_kind || rows[index].mapping_kind === "whole") rows[index] = { ...rows[index], ...range };
    }

    const result: AnikotoPlaybackCandidate[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.mapping_kind && row.mapping_kind !== "whole" &&
          mapAnikotoEpisode(row, integerOrNull(row.target_episode_start) ?? -1) === null) continue;
      const mapped = mapAnikotoEpisode(row, episodeNumber);
      if (mapped === null && (!includeCatalog || row.mapping_kind === "unknown_order")) continue;
      const id = `ak_${String(row.anikoto_id)}`;
      const key = includeCatalog ? `${id}:${row.anikoto_episode_start}:${row.target_episode_start}:${row.target_episode_end}` : `${id}:${mapped}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        animeId: id,
        episodeNumber: mapped ?? -1,
        mappingKind: String(row.mapping_kind || "whole"),
        linkStatus: String(row.link_status || ""),
        sourceStart: integerOrNull(row.anikoto_episode_start) ?? undefined,
        targetStart: integerOrNull(row.target_episode_start) ?? undefined,
        targetEnd: integerOrNull(row.target_episode_end) ?? undefined,
      });
    }
    return result;
  } catch (error) {
    // Older Pi databases do not have the Anikoto lookup table yet.
    console.warn("[getAnikotoPlaybackCandidates warning]:", error);
    return [];
  }
}

