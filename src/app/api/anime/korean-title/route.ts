import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { resolveKoreanTitle } from "@/lib/subtitles";
import { getAdminWorkTitles } from "@/lib/adminWorkTitles";
import { getDb } from "@/lib/db";

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const original = request.nextUrl.searchParams.get("title")?.trim() || "";
  if (!original || original.length > 255) {
    return NextResponse.json({ message: "올바른 제목이 아닙니다." }, { status: 400 });
  }
  // The selected work ID is more precise than an English/romanized text
  // lookup: respect Korean labels explicitly reviewed in the local DB first.
  const animeId = request.nextUrl.searchParams.get("animeId")?.trim() || "";
  let preferred = "";
  if (/^(?:ani_\d+|re_[A-Za-z0-9_-]+|ak_[A-Za-z0-9_-]+|db_(?:AniList|Onnada)_[A-Za-z0-9_-]+)$/.test(animeId)) {
    preferred = (await getAdminWorkTitles([animeId])).get(animeId) || "";
    if (!preferred) {
      const match = /^ani_(\d+)$/.exec(animeId)
        ? {source: "Anissia", id: animeId.slice(4)}
        : /^re_([A-Za-z0-9_-]+)$/.exec(animeId)
          ? {source: "ReAnime", id: animeId.slice(3)}
          : /^db_(AniList|Onnada)_([A-Za-z0-9_-]+)$/.exec(animeId)
            ? {source: animeId.split("_")[1], id: animeId.split("_").slice(2).join("_")} : null;
      const sql = getDb();
      if (match && sql) {
        try {
          const rows = await sql`SELECT payload->>'title_ko' AS title FROM anime_catalog_entries
            WHERE source=${match.source} AND source_record_id=${match.id}
            AND NULLIF(payload->>'title_ko', '') IS NOT NULL LIMIT 1`;
          preferred = String(rows[0]?.title || "");
        } catch (error) {
          console.warn("[Korean title catalog lookup deferred]", error);
        }
      }
    }
  }
  const title = /[가-힣]/.test(preferred) ? preferred : await resolveKoreanTitle(original);
  return NextResponse.json({ title }, { headers: { "Cache-Control": "private, max-age=3600" } });
}
