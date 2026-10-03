import matches from "@/data/reanime-matches.json";
import { getDb } from "@/lib/db";

export interface ReanimeMatch {
  koreanTitle: string;
  anissiaNo: number | null;
  searchTitle?: string;
}

export interface ReanimeSubtitleCandidate {
  animeNo: number;
  subject: string;
  score: number;
  reason: string;
}

/** Monthly candidates are suggestions; only reviewed/unique automatic links are direct IDs. */
export async function getMonthlyAnissiaCandidates(animeId: string): Promise<ReanimeSubtitleCandidate[]> {
  if (!animeId.startsWith("re_")) return [];
  const sql = getDb();
  if (!sql) return [];
  try {
    const rows = await sql`
      SELECT c.anissia_no, c.score, c.reason,
        COALESCE(a.payload->>'title_ko', '') AS subject
      FROM anime_monthly_match_candidates c
      JOIN anime_catalog_entries a ON a.source='Anissia'
        AND a.source_record_id=c.anissia_no::text
      WHERE c.reanime_id=${animeId.slice(3)} AND c.score>=70
      ORDER BY c.score DESC, c.anissia_no
      LIMIT 4
    `;
    return rows.map((row) => ({ animeNo: Number(row.anissia_no),
      subject: String(row.subject), score: Number(row.score), reason: String(row.reason) }));
  } catch {
    // Older Pi databases may not have imported the monthly candidate table yet.
    return [];
  }
}

const bundled = matches as unknown as Record<string, [string, number | null, string]>;

/** Reverse only confirmed IDs; multiple ReAnime works never become an arbitrary poster. */
export async function getConfirmedReanimeIdsForAnissia(animeNos: number[]): Promise<Map<number,string>> {
  const ids=[...new Set(animeNos.filter(n=>Number.isSafeInteger(n) && n>0))];
  const candidates=new Map<number,Set<string>>();
  const add=(n:number,id:string)=>{
    if(!ids.includes(n) || !id)return;
    const values=candidates.get(n) || new Set<string>();values.add(id);candidates.set(n,values);
  };
  if(!ids.length)return new Map();
  const sql=getDb();let loaded=false;
  if(sql)try {
    const rows=await sql`SELECT anissia_no,reanime_id FROM anime_reanime_matches
      WHERE anissia_no=ANY(${ids}::integer[]) AND review_status IN ('검토된 사항','자동확정')`;
    rows.forEach(row=>add(Number(row.anissia_no),String(row.reanime_id)));loaded=true;
  }catch { /* A Pi without the imported table can use the bundled reviewed IDs. */ }
  if(!loaded)for(const [slug,row] of Object.entries(bundled))if(row[1])add(row[1],slug);
  return new Map([...candidates].flatMap(([n,values])=>values.size===1 ? [[n,[...values][0]] as const] : []));
}

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
