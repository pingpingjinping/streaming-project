import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { assertSafeProxyUrl, UnsafeProxyUrlError } from "@/lib/proxyGuard";
import { deleteManualSubtitleLink, getManualSubtitleLink, saveManualSubtitleLink } from "@/lib/db";

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
  await saveManualSubtitleLink(user.username, target.id, target.ep, url);
  return NextResponse.json(
    { success: true, message: "링크를 저장했습니다. 재생할 때 해당 회차 자막 추출을 시도합니다." },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function DELETE(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const target = key(request.nextUrl.searchParams.get("animeId"), request.nextUrl.searchParams.get("ep"));
  if (!target) return NextResponse.json({ message: "잘못된 회차입니다." }, { status: 400 });
  await deleteManualSubtitleLink(user.username, target.id, target.ep);
  return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
}
