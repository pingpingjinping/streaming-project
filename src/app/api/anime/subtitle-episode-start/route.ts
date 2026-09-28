import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSubtitleEpisodeStart, setSubtitleEpisodeStart } from "@/lib/db";

function values(request: NextRequest, body?: any) {
  const params = request.nextUrl.searchParams;
  const animeId = String(body?.animeId ?? params.get("animeId") ?? "").trim();
  const website = String(body?.website ?? params.get("website") ?? "").trim();
  const matchedTitle = String(body?.matchedTitle ?? params.get("matchedTitle") ?? "").trim();
  if (!animeId || animeId.length > 100 || !website || website.length > 2000 ||
      !/^https?:\/\//i.test(website) || matchedTitle.length > 255) return null;
  return { animeId, website, matchedTitle };
}

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const key = values(request);
  if (!key) return NextResponse.json({ message: "작품 또는 제작자 정보가 올바르지 않습니다." }, { status: 400 });
  const startEpisode = await getSubtitleEpisodeStart(user.username, key.animeId, key.website, key.matchedTitle);
  return NextResponse.json({ success: true, startEpisode }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const body = await request.json().catch(() => null);
  const key = values(request, body);
  if (!key) return NextResponse.json({ message: "작품 또는 제작자 정보가 올바르지 않습니다." }, { status: 400 });
  const raw = body?.startEpisode;
  const startEpisode = raw === null || raw === "" ? null : Number(raw);
  if (startEpisode !== null && (!Number.isInteger(startEpisode) || startEpisode < 1 || startEpisode > 10000)) {
    return NextResponse.json({ message: "시작 회차는 1~10000 사이의 정수로 입력해 주세요." }, { status: 400 });
  }
  const saved = await setSubtitleEpisodeStart(user.username, key.animeId, key.website, key.matchedTitle, startEpisode);
  if (!saved) return NextResponse.json({ message: "시작 회차 설정을 저장하지 못했습니다." }, { status: 500 });
  return NextResponse.json({ success: true, startEpisode }, { headers: { "Cache-Control": "no-store" } });
}
