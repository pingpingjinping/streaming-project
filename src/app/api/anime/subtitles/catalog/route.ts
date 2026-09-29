import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const query = (request.nextUrl.searchParams.get("q") || "").trim().slice(0, 100);
  if (query.length < 2) return NextResponse.json({ success: true, titles: [] });
  const sql = getDb();
  if (!sql) return NextResponse.json({ success: false, message: "DB unavailable" }, { status: 503 });
  const pattern = `%${query}%`;
  try {
    const rows = await sql`
      WITH matches AS (
        SELECT NULLIF(payload->>'title', '') AS title, source
        FROM anime_korean_catalog WHERE payload->>'title' ILIKE ${pattern}
        UNION ALL
        SELECT COALESCE(NULLIF(payload->>'title_ko', ''), NULLIF(payload->>'title_english', ''),
          NULLIF(payload->>'title_native', ''), NULLIF(payload->>'title_romaji', '')) AS title, source
        FROM anime_catalog_entries
        WHERE payload->>'title_ko' ILIKE ${pattern} OR payload->>'title_english' ILIKE ${pattern}
           OR payload->>'title_native' ILIKE ${pattern} OR payload->>'title_romaji' ILIKE ${pattern}
        UNION ALL
        SELECT korean_title AS title, source
        FROM anime_title_aliases
        WHERE korean_title ILIKE ${pattern} OR original_title ILIKE ${pattern}
        UNION ALL
        SELECT canonical_title AS title, 'AniAll' AS source
        FROM anime_aniall_matches
        WHERE canonical_title ILIKE ${pattern} OR blog_title ILIKE ${pattern}
      )
      SELECT title, array_agg(DISTINCT source ORDER BY source) AS sources
      FROM matches WHERE title IS NOT NULL
      GROUP BY title
      ORDER BY CASE WHEN title ILIKE ${query} THEN 0 ELSE 1 END, length(title), title
      LIMIT 200
    `;
    return NextResponse.json({ success: true, titles: rows.map((row) => ({
      title: String(row.title), sources: row.sources as string[],
    })) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[subtitle catalog search]", error);
    return NextResponse.json({ success: false, message: "DB title search failed" }, { status: 500 });
  }
}
