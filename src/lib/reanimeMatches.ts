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
