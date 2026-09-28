import matches from "@/data/reanime-matches.json";
import { getDb } from "@/lib/db";

export interface ReanimeMatch {
  koreanTitle: string;
  anissiaNo: number | null;
  searchTitle?: string;
}

const bundled = matches as unknown as Record<string, [string, number | null, string]>;

export function getBundledReanimeMatch(animeId: string): ReanimeMatch | null {
  const slug = animeId.replace(/^re_/, "");
  const row = bundled[slug];
  return row ? { koreanTitle: row[0], anissiaNo: row[1], searchTitle: row[2] } : null;
}

export function findReanimeSearchTitles(koreanTitle: string): string[] {
  const normalized = koreanTitle.normalize("NFKC").trim().toLowerCase();
  if (!/[가-힣]/.test(normalized)) return [];
  return Object.values(bundled)
    .filter((row) => row[2] && row[0].normalize("NFKC").toLowerCase() === normalized)
    .slice(0, 4).map((row) => row[2]);
}

/** Resolve partial Korean queries (for example, "슬라임") to ReAnime titles
 * through the reviewed catalog imported into Postgres.
 */
export async function findReanimeSearchTitlesFromDb(koreanQuery: string): Promise<string[]> {
  const query = koreanQuery.normalize("NFKC").trim();
  if (!/[가-힣]/.test(query)) return [];
  const sql = getDb();
  if (!sql) return [];

  const compact = query.toLocaleLowerCase("ko-KR").replace(/[^\p{L}\p{N}]/gu, "");
  if (compact.length < 2) return [];

  try {
    const like = `%${query}%`;
    const compactLike = `%${compact}%`;
    const rows = await sql`
      SELECT m.reanime_id, m.korean_title,
        COALESCE(NULLIF(r.payload->>'title_english', ''),
                 NULLIF(r.payload->>'title_romaji', ''),
                 NULLIF(r.payload->>'title_native', '')) AS search_title
      FROM anime_reanime_matches m
      LEFT JOIN anime_catalog_entries r
        ON r.source = 'ReAnime' AND r.source_record_id = m.reanime_id
      WHERE m.korean_title ILIKE ${like}
         OR regexp_replace(lower(m.korean_title), '[^[:alnum:]가-힣]', '', 'g') LIKE ${compactLike}
      ORDER BY CASE
        WHEN regexp_replace(lower(m.korean_title), '[^[:alnum:]가-힣]', '', 'g') = ${compact} THEN 0
        ELSE 1 END,
        length(m.korean_title), m.korean_title
      LIMIT 12
    `;

    return [...new Set(rows.map((row) => String(row.search_title || "").trim()).filter(Boolean))];
  } catch (error) {
    console.warn("[findReanimeSearchTitlesFromDb warning]:", error);
    return [];
  }
}

export async function getReanimeMatch(animeId: string): Promise<ReanimeMatch | null> {
  if (!animeId.startsWith("re_")) return null;
  const slug = animeId.slice(3);
  const sql = getDb();
  if (sql) {
    try {
      const rows = await sql`SELECT korean_title,anissia_no
        FROM anime_reanime_matches WHERE reanime_id=${slug} LIMIT 1`;
      if (rows.length) return { koreanTitle: String(rows[0].korean_title),
        anissiaNo: rows[0].anissia_no === null ? null : Number(rows[0].anissia_no) };
    } catch { /* The import may not have run yet. */ }
  }
  return getBundledReanimeMatch(animeId);
}
