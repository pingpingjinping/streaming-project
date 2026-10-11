import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import {
  getAnikotoWorkOverride, resetAnikotoWorkOverride,
  saveAnikotoWorkOverride, validAnikotoId
} from "@/lib/anikotoWorkOverrides";

export const dynamic = "force-dynamic";
const fail = (message: string, status: number) =>
  NextResponse.json({ success: false, message }, { status });
const workNo = (id: unknown) => typeof id === "string" && /^ani_[1-9]\d*$/.test(id)
  && Number.isSafeInteger(Number(id.slice(4))) ? Number(id.slice(4)) : null;

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail("로그인이 필요합니다.", 401);
  const no = workNo(request.nextUrl.searchParams.get("animeId"));
  if (!no) return fail("Anissia 작품 ID가 필요합니다.", 400);
  const sql = getDb();
  if (!sql) return fail("DB 연결이 필요합니다.", 503);
  try {
    const manual = await getAnikotoWorkOverride(no);
    const query = (request.nextUrl.searchParams.get("q") || "").normalize("NFKC").trim().slice(0,160);
    const pattern = "%" + query.replace(/[\\%_]/g,"\\$&") + "%";
    const rows = query.length >= 2
      ? await sql`SELECT anikoto_id,payload FROM anime_anikoto_catalog
          WHERE anikoto_id=${query} OR CONCAT_WS(' ',payload->>'title',payload->>'name',
            payload->>'title_english',payload->>'english_title',
            payload->>'title_romaji',payload->>'title_native') ILIKE ${pattern}
          ORDER BY anikoto_id LIMIT 30`
      : manual ? await sql`SELECT anikoto_id,payload FROM anime_anikoto_catalog
          WHERE anikoto_id=${manual.anikotoId} LIMIT 1` : [];
    const item = (r: any) => ({
      id: String(r.anikoto_id),
      title: String(r.payload?.title_ko || r.payload?.title || r.payload?.name ||
        r.payload?.title_english || r.anikoto_id),
      year: r.payload?.year || r.payload?.release_year || null,
      format: r.payload?.format || "",
    });
    return NextResponse.json({
      success: true, manual: !!manual, current: manual
        ? rows.find(r=>String(r.anikoto_id)===manual.anikotoId)
          ? item(rows.find(r=>String(r.anikoto_id)===manual.anikotoId))
          : { id: manual.anikotoId, title: manual.anikotoId }
        : null,
      candidates: rows.map(item), canEdit: user.isAdmin,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return fail("Anikoto 작품 목록을 불러오지 못했습니다.", 500);
  }
}

export async function PUT(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail("로그인이 필요합니다.",401);
  if (!user.isAdmin) return fail("관리자만 수정할 수 있습니다.",403);
  try {
    const body = await request.json();
    const no = workNo(body?.animeId), target = body?.targetId;
    if (!no || !validAnikotoId(target)) return fail("정확한 작품 ID를 입력해 주세요.",400);
    const sql = getDb();
    if (!sql) return fail("DB 연결이 필요합니다.",503);
    const [source, targetRows] = await Promise.all([
      sql`SELECT 1 FROM anime_catalog_entries
        WHERE source='Anissia' AND source_record_id=${String(no)} LIMIT 1`,
      sql`SELECT 1 FROM anime_anikoto_catalog WHERE anikoto_id=${target} LIMIT 1`,
    ]);
    if (!source.length || !targetRows.length) return fail("두 작품이 DB에 있어야 합니다.",404);
    await saveAnikotoWorkOverride(no,target);
    return NextResponse.json({success:true});
  } catch(error: any) {
    return error?.message === "ambiguous_multi_season" || error?.code === "23505"
      ? fail("한 Anikoto 작품이 여러 시즌에 연결됩니다. 기존 검수 회차 범위가 없으면 자동 연결할 수 없습니다.",409)
      : fail("수동 Anikoto 연결을 저장하지 못했습니다.",500);
  }
}

export async function DELETE(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return fail("로그인이 필요합니다.",401);
  if (!user.isAdmin) return fail("관리자만 수정할 수 있습니다.",403);
  const no = workNo(request.nextUrl.searchParams.get("animeId"));
  if (!no) return fail("Anissia 작품 ID가 필요합니다.",400);
  try {
    await resetAnikotoWorkOverride(no);
    return NextResponse.json({success:true});
  } catch { return fail("연결을 해제하지 못했습니다.",500); }
}
