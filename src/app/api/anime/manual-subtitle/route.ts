import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { assertSafeProxyUrl, UnsafeProxyUrlError } from "@/lib/proxyGuard";
import { deleteManualSubtitleLink, getManualSubtitleLink, saveManualSubtitleLink } from "@/lib/db";
import { fetchCreatorSubtitle } from "@/lib/subtitles";

function key(animeId: unknown, episodeNumber: unknown) {
  const id = typeof animeId === "string" ? animeId.trim() : "";
  const ep = Number(episodeNumber);
  return id.length > 0 && id.length <= 100 && Number.isInteger(ep) && ep > 0 && ep <= 10000
    ? { id, ep } : null;
}

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const target = key(request.nextUrl.searchParams.get("animeId"), request.nextUrl.searchParams.get("ep"));
  if (!target) return NextResponse.json({ message: "잘못된 회차입니다." }, { status: 400 });
  const url = await getManualSubtitleLink(user.username, target.id, target.ep);
  return NextResponse.json({ success: true, url }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const body = await request.json().catch(() => null);
  const target = key(body?.animeId, body?.episodeNumber);
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  if (!target || !url || url.length > 2048) return NextResponse.json({ message: "주소 또는 회차가 올바르지 않습니다." }, { status: 400 });
  try {
    await assertSafeProxyUrl(url);
  } catch (error) {
    if (error instanceof UnsafeProxyUrlError) return NextResponse.json({ message: "허용되지 않는 주소입니다." }, { status: 400 });
    throw error;
  }
  const title = typeof body?.title === "string" ? body.title.slice(0, 255) : target.id;
  const subtitle = await fetchCreatorSubtitle("직접 자막", url, title, target.ep, 12000);
  if (!subtitle?.content) return NextResponse.json({ message: "이 주소에서 해당 회차 자막을 추출하지 못했습니다. 글 주소와 회차를 확인해 주세요." }, { status: 422 });
  await saveManualSubtitleLink(user.username, target.id, target.ep, url);
  return NextResponse.json({ success: true, filename: subtitle.orig_filename }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const target = key(request.nextUrl.searchParams.get("animeId"), request.nextUrl.searchParams.get("ep"));
  if (!target) return NextResponse.json({ message: "잘못된 회차입니다." }, { status: 400 });
  await deleteManualSubtitleLink(user.username, target.id, target.ep);
  return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
}
