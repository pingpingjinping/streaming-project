import { getDb, initDb } from './db';

export type WorkMatchOverride = { reanimeId: string; anissiaNo: number; updatedBy: string };
export function validReanimeId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 && /^[a-z\d][a-z\d-]*$/i.test(value);
}
export function validAnissiaNo(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
}
export async function getWorkMatchOverrides(): Promise<WorkMatchOverride[]> {
  const sql = getDb();
  if (!sql) return [];
  try {
    const rows = await sql`SELECT reanime_id, anissia_no, updated_by FROM anime_work_match_overrides`;
    return rows.filter(r => validReanimeId(r.reanime_id) && validAnissiaNo(Number(r.anissia_no)))
      .map(r => ({ reanimeId: String(r.reanime_id), anissiaNo: Number(r.anissia_no), updatedBy: String(r.updated_by) }));
  } catch (error: any) {
    if (error?.code === '42P01') return []; // Existing installations before first initialization.
    throw error;
  }
}
export function matchingOverride(rows: WorkMatchOverride[], animeId: string) {
  return rows.find(r => animeId === `re_${r.reanimeId}` || animeId === `ani_${r.anissiaNo}`) || null;
}
export function importedLinkIsOverridden(rows: WorkMatchOverride[], reanimeId: string, anissiaNo: number | null) {
  return rows.some(r => r.reanimeId === reanimeId || r.anissiaNo === anissiaNo);
}
export async function saveWorkMatchOverride(animeId: string, reanimeId: string, anissiaNo: number, updatedBy: string) {
  const sql = getDb();
  if (!sql) throw new Error('DB 연결이 필요합니다.');
  await initDb();
  await sql.begin(async tx => {
    // Serialize edits so a concurrent save cannot replace another manual pair.
    await tx`SELECT pg_advisory_xact_lock(84102751)`;
    if (animeId.startsWith('re_')) {
      await tx`DELETE FROM anime_work_match_overrides WHERE reanime_id=${animeId.slice(3)}`;
    } else {
      await tx`DELETE FROM anime_work_match_overrides WHERE anissia_no=${Number(animeId.slice(4))}`;
    }
    await tx`INSERT INTO anime_work_match_overrides(reanime_id,anissia_no,updated_by)
      VALUES (${reanimeId},${anissiaNo},${updatedBy})`;
    // Heuristic playback caches are disposable; manual data lives separately.
    await tx`DELETE FROM anissia_stream_cache WHERE anissia_id=${anissiaNo} OR reanime_id IN (${reanimeId},${'re_'+reanimeId})`;
  });
}
export async function resetWorkMatchOverride(animeId: string) {
  const sql = getDb();
  if (!sql) throw new Error('DB 연결이 필요합니다.');
  await initDb();
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(84102751)`;
    const removed = animeId.startsWith('re_')
      ? await tx`DELETE FROM anime_work_match_overrides WHERE reanime_id=${animeId.slice(3)} RETURNING anissia_no`
      : await tx`DELETE FROM anime_work_match_overrides WHERE anissia_no=${Number(animeId.slice(4))} RETURNING anissia_no`;
    for (const row of removed) await tx`DELETE FROM anissia_stream_cache WHERE anissia_id=${row.anissia_no}`;
  });
}
