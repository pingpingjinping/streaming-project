import { getDb, initDb } from "@/lib/db";
import type { WorkGroup } from "@/lib/adminSubtitleWorkGroups";

/** Manual display names belong to exact reviewed IDs, never a title-similarity key.
 * Keep them outside imported tables so a monthly catalog refresh preserves them. */
export function normalizeAdminKoreanTitle(value: unknown): string {
  if (value === undefined || value === "") return "";
  if (typeof value !== "string" || value.length > 300 || /[\x00-\x1f\x7f]/.test(value))
    throw new Error("한글 이름은 300자 이내의 한 줄로 입력해 주세요.");
  const title = value.normalize("NFKC").trim();
  if (title.length > 300 || !/[가-힣]/.test(title))
    throw new Error("등록할 한글 이름을 입력해 주세요.");
  return title;
}

let schemaReady: Promise<void> | null = null;
export async function ensureAdminWorkTitlesTable() {
  const sql = getDb();
  if (!sql) throw new Error("PostgreSQL 연결이 필요합니다.");
  if (!schemaReady) schemaReady = (async () => {
    await initDb();
    await sql`CREATE TABLE IF NOT EXISTS anime_admin_work_titles (
      anime_id VARCHAR(150) PRIMARY KEY,
      canonical_id VARCHAR(150) NOT NULL,
      korean_title TEXT NOT NULL,
      updated_by VARCHAR(100) NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`;
  })().catch(error => { schemaReady = null; throw error; });
  await schemaReady;
  return sql;
}

export async function getAdminWorkTitles(ids?: string[]): Promise<Map<string, string>> {
  const sql = getDb();
  if (!sql || (ids && !ids.length)) return new Map();
  try {
    const rows = ids ? await sql`SELECT anime_id,korean_title FROM anime_admin_work_titles
      WHERE anime_id=ANY(${ids}::text[])`
      : await sql`SELECT anime_id,korean_title FROM anime_admin_work_titles`;
    return new Map(rows.map(row => [String(row.anime_id), String(row.korean_title)]));
  } catch (error: any) {
    // Older installations have no overrides until their first admin write.
    if (error?.code !== "42P01") console.warn("[Manual Korean work titles]", error);
    return new Map();
  }
}

export function titleMemberIds(group: WorkGroup): string[] {
  return [...new Set(group.members
    .filter(member => !group.multiAnikotoIds.includes(member.animeId))
    .map(member => member.animeId))];
}

/** Called inside the same transaction as the subtitle link update. */
export async function persistAdminWorkTitle(sql: any, group: WorkGroup, title: string, admin: string) {
  const normalized = normalizeAdminKoreanTitle(title);
  if (!normalized) throw new Error("등록할 한글 이름을 입력해 주세요.");
  const ids = titleMemberIds(group);
  for (const id of ids) await sql`INSERT INTO anime_admin_work_titles
    (anime_id,canonical_id,korean_title,updated_by) VALUES (${id},${group.animeId},${normalized},${admin})
    ON CONFLICT(anime_id) DO UPDATE SET korean_title=EXCLUDED.korean_title,
      canonical_id=EXCLUDED.canonical_id,
      updated_by=EXCLUDED.updated_by,updated_at=CURRENT_TIMESTAMP`;
  // Search uses these durable local link names as well as upstream titles.
  await sql`UPDATE anime_admin_subtitle_links l SET work_title=${normalized},
      updated_by=${admin},updated_at=CURRENT_TIMESTAMP
    WHERE l.anime_id=ANY(${ids}::text[])`;
  return normalized;
}

export async function applyAdminWorkTitle<T extends { id: string; title: string;
  original_title?: string; identity_titles?: string[] }>(work: T): Promise<T> {
  const title = (await getAdminWorkTitles([work.id])).get(work.id);
  if (!title || title === work.title) return work;
  return { ...work, title, original_title: work.original_title || work.title,
    identity_titles: [...new Set([...(work.identity_titles || []), work.title])] };
}

export async function applyAdminWorkTitles<T extends { id: string; title: string;
  original_title?: string; identity_titles?: string[] }>(items: T[]): Promise<T[]> {
  const titles=await getAdminWorkTitles(items.map(item=>item.id));
  return items.map(item=>{
    const title=titles.get(item.id);
    return title && title!==item.title ? {...item,title,
      original_title:item.original_title || item.title,
      identity_titles:[...new Set([...(item.identity_titles || []),item.title])]} : item;
  });
}
