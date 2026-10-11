import { getProvisionalWorkMatches, getReservedReanimeIdsForOtherWorks, hasWorkMatchCandidates } from './provisionalWorkMatches';
import { getWorkMatchOverrides, importedLinkIsOverridden } from './workMatchOverrides';
import matches from "@/data/reanime-matches.json";
import { getDb, getAnissiaStreamCache } from "@/lib/db";

export interface ReanimeMatch {
  koreanTitle: string;
  anissiaNo: number | null;
  searchTitle?: string;
  matchStatus?: "confirmed" | "candidate";
  candidateReason?: string;
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
  const overrides=await getWorkMatchOverrides();
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
    rows.forEach(row=>{
      if(!importedLinkIsOverridden(overrides,String(row.reanime_id),Number(row.anissia_no)))
        add(Number(row.anissia_no),String(row.reanime_id));
    });loaded=true;
  }catch { /* A Pi without the imported table can use the bundled reviewed IDs. */ }
  if(!loaded)for(const [slug,row] of Object.entries(bundled))if(row[1] && !importedLinkIsOverridden(overrides,slug,row[1]))add(row[1],slug);
  overrides.forEach(row=>add(row.anissiaNo,row.reanimeId));
  return new Map([...candidates].flatMap(([n,values])=>values.size===1 ? [[n,[...values][0]] as const] : []));
}

/** Effective reverse links retain a distinct provisional state. */
export async function getEffectiveReanimeIdsForAnissia(animeNos:number[]):Promise<Map<number,string>> {
  const result=await getConfirmedReanimeIdsForAnissia(animeNos);
  for(const c of await getProvisionalWorkMatches())if(animeNos.includes(c.anissiaNo) && !result.has(c.anissiaNo))
    result.set(c.anissiaNo,c.reanimeId);
  return result;
}

/** Use the same selected/cached work as playback without a new title search.
 * Explicit and provisional choices supersede a previously successful cache.
 * Candidate conflicts and IDs reserved for another work invalidate old caches.
 */
export async function getPlaybackReanimeIdForAnissia(anissiaNo: number): Promise<string | null> {
  if (!Number.isSafeInteger(anissiaNo) || anissiaNo <= 0) return null;
  const selected = (await getEffectiveReanimeIdsForAnissia([anissiaNo])).get(anissiaNo);
  if (selected) return selected;
  if (await hasWorkMatchCandidates(anissiaNo)) return null;
  try {
    const cached = (await getAnissiaStreamCache(anissiaNo))?.reanime_id;
    if (!cached) return null;
    const slug = cached.replace(/^re_/, '');
    const [reserved, overrides] = await Promise.all([
      getReservedReanimeIdsForOtherWorks(anissiaNo), getWorkMatchOverrides(),
    ]);
    if (reserved.has(slug) || overrides.some(row => row.reanimeId === slug && row.anissiaNo !== anissiaNo)) return null;
    return cached;
  } catch {
    return null;
  }
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
  const overrides = await getWorkMatchOverrides();
  const manual = overrides.find(r => r.reanimeId === slug);
  const sql = getDb();
  if (manual) {
    const titles = sql ? await sql`SELECT payload->>'title_ko' AS title FROM anime_catalog_entries
      WHERE source='Anissia' AND source_record_id=${String(manual.anissiaNo)} LIMIT 1` : [];
    return { koreanTitle: String(titles[0]?.title || ''), anissiaNo: manual.anissiaNo };
  }
  let importedTitle:string|null=null;
  if (sql) {
    try {
      const rows = await sql`SELECT korean_title,anissia_no
        FROM anime_reanime_matches WHERE reanime_id=${slug} LIMIT 1`;
      if(rows.length)importedTitle=String(rows[0].korean_title);
      if (rows.length && rows[0].anissia_no !== null && !importedLinkIsOverridden(overrides,slug,Number(rows[0].anissia_no))) return { koreanTitle: String(rows[0].korean_title),
        anissiaNo: rows[0].anissia_no === null || importedLinkIsOverridden(overrides,slug,Number(rows[0].anissia_no)) ? null : Number(rows[0].anissia_no) };
    } catch { /* The import may not have run yet. */ }
  }
  const candidate=(await getProvisionalWorkMatches()).find(c=>c.reanimeId===slug);
  if(candidate) {
    const titles=sql ? await sql`SELECT payload->>'title_ko' AS title FROM anime_catalog_entries
      WHERE source='Anissia' AND source_record_id=${String(candidate.anissiaNo)} LIMIT 1` : [];
    return {koreanTitle:String(titles[0]?.title || ''),anissiaNo:candidate.anissiaNo,
      matchStatus:'candidate',candidateReason:candidate.reason};
  }
  if(importedTitle!==null)return {koreanTitle:importedTitle,anissiaNo:null};
  const bundledMatch = getBundledReanimeMatch(animeId);
  return bundledMatch && importedLinkIsOverridden(overrides,slug,bundledMatch.anissiaNo)
    ? { ...bundledMatch, anissiaNo: null } : bundledMatch;
}
