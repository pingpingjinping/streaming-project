import { getDb, initDb } from "./db";

export type AnikotoManualWorkMatch = {
  anissiaNo: number; anikotoId: string;
  mappingKind: "whole" | "range";
  anikotoEpisodeStart: number | null; anikotoEpisodeEnd: number | null;
  targetEpisodeStart: number | null; targetEpisodeEnd: number | null;
};

export function validAnikotoId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value);
}

export async function getAnikotoWorkOverride(anissiaNo: number): Promise<AnikotoManualWorkMatch | null> {
  const sql = getDb();
  if (!sql) return null;
  try {
    const rows = await sql`SELECT anissia_no,anikoto_id,mapping_kind,
      anikoto_episode_start,anikoto_episode_end,target_episode_start,target_episode_end
      FROM anime_anikoto_work_overrides WHERE anissia_no=${anissiaNo} LIMIT 1`;
    if (!rows.length) return null;
    const r = rows[0];
    return {
      anissiaNo: Number(r.anissia_no), anikotoId: String(r.anikoto_id),
      mappingKind: r.mapping_kind === "range" ? "range" : "whole",
      anikotoEpisodeStart: r.anikoto_episode_start == null ? null : Number(r.anikoto_episode_start),
      anikotoEpisodeEnd: r.anikoto_episode_end == null ? null : Number(r.anikoto_episode_end),
      targetEpisodeStart: r.target_episode_start == null ? null : Number(r.target_episode_start),
      targetEpisodeEnd: r.target_episode_end == null ? null : Number(r.target_episode_end),
    };
  } catch (error: any) {
    if (error?.code === "42P01") return null;
    throw error;
  }
}

export async function saveAnikotoWorkOverride(anissiaNo: number, anikotoId: string) {
  if (!Number.isSafeInteger(anissiaNo) || anissiaNo < 1 || !validAnikotoId(anikotoId))
    throw new Error("invalid_anime_id");
  await initDb();
  const sql = getDb();
  if (!sql) throw new Error("database_unavailable");
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(84102752)`;
    // Anikoto can cover different seasons. Only copy a previously *reviewed*
    // explicit range; never infer episode offsets from a title or file name.
    const ranges = await tx`SELECT mapping_kind,anikoto_episode_start,anikoto_episode_end,
      target_episode_start,target_episode_end FROM anime_anikoto_work_targets
      WHERE anikoto_id=${anikotoId} AND target_source='Anissia'
        AND target_id=${String(anissiaNo)}
        AND link_status IN ('reviewed','multi_reviewed')
      ORDER BY target_order`;
    const other = await tx`SELECT target_id FROM anime_anikoto_work_targets
      WHERE anikoto_id=${anikotoId}
        AND NOT (target_source='Anissia' AND target_id=${String(anissiaNo)})
        AND link_status IN ('reviewed','multi_reviewed')
      LIMIT 1`;
    const existing = await tx`SELECT anissia_no FROM anime_anikoto_work_overrides
      WHERE anikoto_id=${anikotoId} AND anissia_no<>${anissiaNo} LIMIT 1`;
    if (existing.length || (other.length && !ranges.length)) throw new Error("ambiguous_multi_season");
    const range = ranges.length === 1 ? ranges[0] : null;
    if (ranges.length > 1) throw new Error("ambiguous_multi_season");
    const explicit = !!range && range.mapping_kind !== "whole";
    const sourceStart = explicit ? Number(range.anikoto_episode_start) : null;
    const sourceEnd = explicit ? Number(range.anikoto_episode_end) : null;
    const targetStart = explicit ? Number(range.target_episode_start) : null;
    const targetEnd = explicit ? Number(range.target_episode_end) : null;
    if (explicit && (!Number.isInteger(sourceStart) || !Number.isInteger(sourceEnd)
      || !Number.isInteger(targetStart) || !Number.isInteger(targetEnd)
      || sourceStart! < 1 || targetStart! < 1 || sourceEnd! < sourceStart!
      || targetEnd! < targetStart! || sourceEnd! - sourceStart! !== targetEnd! - targetStart!))
      throw new Error("ambiguous_multi_season");
    await tx`INSERT INTO anime_anikoto_work_overrides (
      anissia_no,anikoto_id,mapping_kind,anikoto_episode_start,anikoto_episode_end,
      target_episode_start,target_episode_end)
      VALUES (${anissiaNo},${anikotoId},${explicit ? "range" : "whole"},
        ${sourceStart},${sourceEnd},${targetStart},${targetEnd})
      ON CONFLICT (anissia_no) DO UPDATE SET
      anikoto_id=excluded.anikoto_id,mapping_kind=excluded.mapping_kind,
      anikoto_episode_start=excluded.anikoto_episode_start,
      anikoto_episode_end=excluded.anikoto_episode_end,
      target_episode_start=excluded.target_episode_start,
      target_episode_end=excluded.target_episode_end`;
  });
}

export async function resetAnikotoWorkOverride(anissiaNo: number) {
  await initDb();
  const sql = getDb();
  if (!sql) throw new Error("database_unavailable");
  await sql`DELETE FROM anime_anikoto_work_overrides WHERE anissia_no=${anissiaNo}`;
}
