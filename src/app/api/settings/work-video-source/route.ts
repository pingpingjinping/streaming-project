import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  saveWorkVideoSourceChoice, validWorkVideoSource,
  validWorkVideoSourceId,
} from "@/lib/db";
import { getDbBackedWorkVideoSource } from "@/lib/workVideoSourcePreference";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };

/** Only an explicit source-button click updates the account. */
export async function PUT(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ success: false, message: "로그인이 필요합니다." }, { status: 401, headers });
  const body = await request.json().catch(() => null);
  if (!validWorkVideoSourceId(body?.animeId) || !validWorkVideoSource(body?.source)) {
    return NextResponse.json({ success: false, message: "올바르지 않은 작품 또는 영상 소스입니다." }, { status: 400, headers });
  }
  // ReAnime is the implicit default: do not store a redundant entry.
  // Exception: when DB would automatically use Anikoto, an explicit ReAnime
  // selection must be remembered so it doesn't get overridden next visit.
  const choice = body.source === "rean"
    ? (await getDbBackedWorkVideoSource(body.animeId)) === "anikoto" ? "rean" : null
    : body.source;
  const ok = await saveWorkVideoSourceChoice(user.username, body.animeId, choice);
  if (!ok) return NextResponse.json({ success: false, message: "소스 선택을 저장하지 못했습니다." }, { status: 500, headers });
  return NextResponse.json({ success: true, choice }, { headers });
}
