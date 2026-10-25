import { getDb } from "./db";

type ReanimeCatalogEvidence = { reanime_id: string; payload: unknown };

const object = (raw: unknown): Record<string, unknown> => {
  if (typeof raw === "string") {
    try { return object(JSON.parse(raw)); } catch { return {}; }
  }
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown> : {};
};

/** Do not confuse a metadata-only ReAnime page with a playable stream.
 * This uses only exact work IDs and confirmed local catalog associations.
 * Missing or unknown availability is NOT proof that ReAnime has no video.
 * Fail closed on incomplete/older DBs rather than redirecting to another season.
 */
export async function catalogHasConfirmedNoReanimeVideo(source: string, id: string): Promise<boolean> {
  if (!["AniList", "Onnada", "ReAnime", "Anissia"].includes(source) || !/^[A-Za-z0-9_-]{1,160}$/.test(id))
    return false;
  const sql = getDb();
  if (!sql) return false;
  try {
    const rows = await sql`
      WITH exact_reanime_refs AS (
        SELECT NULLIF(f.reanime_id, '') AS reanime_id
        FROM anime_subtitle_files f
        WHERE f.target_source=${source} AND f.target_id=${id}
          AND f.work_confirmed
        UNION
        SELECT NULLIF(w.reanime_id, '') AS reanime_id
        FROM anime_subtitle_work_reanime_links w
        WHERE w.target_source=${source} AND w.target_id=${id}
          AND w.automatic_eligible
        UNION
        SELECT NULLIF(k.payload->>'reanimeId', '') AS reanime_id
        FROM anime_korean_catalog k
        WHERE k.source=${source} AND k.source_record_id=${id}
          AND k.payload->>'status' IN ('검토된 사항', '자동확정')
        UNION
        SELECT r.source_record_id AS reanime_id
        FROM anime_catalog_entries r
        WHERE ${source}='AniList' AND r.source='ReAnime'
          -- On Pi the metadata is stored either as a JSON object or as a
          -- JSON-encoded string. ->>'anilist_id' on a string always returns
          -- NULL, silently breaking exact AniList -> ReAnime discovery.
          AND (
            CASE jsonb_typeof(r.payload->'source_metadata_json')
              WHEN 'object' THEN r.payload->'source_metadata_json'->>'anilist_id'
              WHEN 'string' THEN (r.payload->>'source_metadata_json')::jsonb->>'anilist_id'
              ELSE NULL
            END
          )=${id}
        UNION
        SELECT ${id}::text AS reanime_id WHERE ${source}='ReAnime'
      )
      SELECT refs.reanime_id, r.payload
      FROM exact_reanime_refs refs
      LEFT JOIN anime_catalog_entries r
        ON r.source='ReAnime' AND r.source_record_id=refs.reanime_id
      WHERE refs.reanime_id IS NOT NULL
      ORDER BY refs.reanime_id
    ` as ReanimeCatalogEvidence[];
    // An empty list, a missing catalog entry, or a source without the explicit
    // can_watch=false flag must not unlock a multi-season Anikoto redirect.
    return rows.length > 0 && rows.every(row => {
      const metadata = object(object(row.payload).source_metadata_json);
      return metadata.can_watch === false;
    });
  } catch (error) {
    console.warn("[Catalog video availability] Cannot verify ReAnime video state", error);
    return false;
  }
}
