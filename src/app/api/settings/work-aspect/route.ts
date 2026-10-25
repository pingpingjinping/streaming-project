import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  getWorkAspectChoice, saveWorkAspectChoice, validWorkAspectChoice, validWorkAspectId,
} from "@/lib/db";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "private, no-store" };

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ success: false, message: "로그인이 필요합니다." }, { status: 401, headers: noStore });
  const animeId = request.nextUrl.searchParams.get("animeId");
  if (!validWorkAspectId(animeId)) {
    return NextResponse.json({ success: false, message: "작품 ID가 올바르지 않습니다." }, { status: 400, headers: noStore });
  }
  const choice = await getWorkAspectChoice(user.username, animeId);
  return NextResponse.json({ success: true, choice }, { headers: noStore });
}

export async function PUT(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ success: false, message: "로그인이 필요합니다." }, { status: 401, headers: noStore });
  const body = await request.json().catch(() => null);
  if (!validWorkAspectId(body?.animeId) || !validWorkAspectChoice(body?.choice)
    || (body?.onlyIfAbsent !== undefined && typeof body.onlyIfAbsent !== "boolean")) {
    return NextResponse.json({ success: false, message: "비율 설정이 올바르지 않습니다." }, { status: 400, headers: noStore });
  }
  const result = await saveWorkAspectChoice(
    user.username, body.animeId, body.choice, body.onlyIfAbsent === true,
  );
  if (!result.success) {
    return NextResponse.json({ success: false, message: "비율 설정을 저장하지 못했습니다." }, { status: 500, headers: noStore });
  }
  return NextResponse.json({ success: true, choice: result.choice }, { headers: noStore });
}
