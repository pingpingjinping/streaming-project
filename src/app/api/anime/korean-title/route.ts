import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { resolveKoreanTitle } from "@/lib/subtitles";

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const original = request.nextUrl.searchParams.get("title")?.trim() || "";
  if (!original || original.length > 255) {
    return NextResponse.json({ message: "올바른 제목이 아닙니다." }, { status: 400 });
  }
  const title = await resolveKoreanTitle(original);
  return NextResponse.json({ title }, { headers: { "Cache-Control": "private, max-age=3600" } });
}
