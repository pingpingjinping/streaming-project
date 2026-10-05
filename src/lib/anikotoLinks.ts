import { getDb } from "./db";

export interface AnikotoPlaybackCandidate {
  animeId: string;
  episodeNumber: number;
  mappingKind: string;
  linkStatus: string;
}

type WorkKey = { source: "Anissia" | "ReAnime" | "Onnada"; sourceId: string };

function workKeyFromAnimeId(animeId: string): WorkKey | null {
  if (animeId.startsWith("ani_")) {
    const sourceId = animeId.slice(4);
    return /^\\d+$/.test(sourceId) ? { source: "Anissia", sourceId } : null;
  }
  if (animeId.startsWith("re_")) {
    const sourceId = animeId.slice(3).trim();
    return sourceId ? { source: "ReAnime", sourceId } : null;
  }
  if (animeId.startsWith("ol_")) {
    const sourceId = animeId.slice(3).trim();
    return sourceId ? { source: "Onnada", sourceId } : null;
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

/**
 * Return only DB-reviewed Anikoto candidates for the currently viewed canonical
 * work. A single Anikoto source may map to multiple seasons; range metadata
 * keeps each detail/watch page inside its own reviewed episode span.
 */
export async function getAnikotoPlaybackCandidates(
  animeId: string,
  episodeNumber: number
): Promise<AnikotoPlaybackCandidate[]> {
  const work = workKeyFromAnimeId(animeId);
  const sql = getDb();
  if (!work || !sql) return [];

  try {
    const rows = await sql`
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
    `;

    const result: AnikotoPlaybackCandidate[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const mapped = mapAnikotoEpisode(row, episodeNumber);
      if (mapped === null) continue;
      const id = `ak_${String(row.anikoto_id)}`;
      const key = `${id}:${mapped}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        animeId: id,
        episodeNumber: mapped,
        mappingKind: String(row.mapping_kind || "whole"),
        linkStatus: String(row.link_status || ""),
      });
    }
    return result;
  } catch (error) {
    // Older Pi databases do not have the Anikoto lookup table yet.
    console.warn("[getAnikotoPlaybackCandidates warning]:", error);
    return [];
  }
}
