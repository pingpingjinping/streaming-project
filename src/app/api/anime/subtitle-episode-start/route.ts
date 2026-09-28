import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSubtitleEpisodeStart, setSubtitleEpisodeStart } from "@/lib/db";

function animeId(request: NextRequest, body?: any) {
  const id = String(body?.animeId ?? request.nextUrl.searchParams.get("animeId") ?? "").trim();
  return id && id.length <= 100 ? id : null;
}

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const id = animeId(request);
  if (!id) return NextResponse.json({ message: "작품 페이지 정보가 올바르지 않습니다." }, { status: 400 });
  const startEpisode = await getSubtitleEpisodeStart(user.username, id);
  return NextResponse.json({ success: true, startEpisode }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const body = await request.json().catch(() => null);
  const id = animeId(request, body);
  if (!id) return NextResponse.json({ message: "작품 페이지 정보가 올바르지 않습니다." }, { status: 400 });
  const raw = body?.startEpisode;
  const startEpisode = raw === null || raw === "" ? null : Number(raw);
  if (startEpisode !== null && (!Number.isInteger(startEpisode) || startEpisode < 1 || startEpisode > 10000)) {
    return NextResponse.json({ message: "시작 회차는 1~10000 사이의 정수로 입력해 주세요." }, { status: 400 });
  }
  const saved = await setSubtitleEpisodeStart(user.username, id, startEpisode);
  if (!saved) return NextResponse.json({ message: "시작 회차 설정을 저장하지 못했습니다." }, { status: 500 });
  return NextResponse.json({ success: true, startEpisode }, { headers: { "Cache-Control": "no-store" } });
}
