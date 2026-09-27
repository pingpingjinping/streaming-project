import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { saveUploadedSubtitle } from "@/lib/db";
import { extractSubtitleFromBuffer } from "@/lib/subtitles";
import {
  captureTurnstileBrowser,
  clickTurnstileBrowser,
  consumeTurnstileDownload,
  scrollTurnstileBrowser,
  startTurnstileBrowser,
  stopTurnstileBrowser,
} from "@/lib/turnstileBrowser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function validTarget(animeId: unknown, episode: unknown) {
  const id = typeof animeId === "string" ? animeId.trim() : "";
  const ep = Number(episode);
  return id.length > 0 && id.length <= 100 && Number.isInteger(ep) && ep > 0 && ep <= 10000
    ? { id, ep } : null;
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const body = await request.json().catch(() => null);
  if (body?.action === "click") {
    const x = Number(body.x);
    const y = Number(body.y);
    const ok = await clickTurnstileBrowser(user.username, String(body.sessionId || ""), x, y);
    return NextResponse.json({ success: ok }, { status: ok ? 200 : 404, headers: { "Cache-Control": "no-store" } });
  }
  if (body?.action === "scroll") {
    const ok = await scrollTurnstileBrowser(user.username, String(body.sessionId || ""), Number(body.deltaY));
    return NextResponse.json({ success: ok }, { status: ok ? 200 : 404, headers: { "Cache-Control": "no-store" } });
  }

  const target = validTarget(body?.animeId, body?.episodeNumber);
  const url = typeof body?.url === "string" ? body.url : "";
  if (!target || !url) return NextResponse.json({ message: "회차 또는 블로그 주소가 올바르지 않습니다." }, { status: 400 });
  try {
    const result = await startTurnstileBrowser(user.username, target.id, target.ep, url);
    return NextResponse.json({ success: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ message: error instanceof Error ? error.message : "브라우저를 시작하지 못했습니다." }, { status: 400 });
  }
}

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const id = request.nextUrl.searchParams.get("sessionId") || "";
  try {
    const downloaded = await consumeTurnstileDownload(user.username, id);
    if (downloaded.state === "ready") {
      const subtitle = extractSubtitleFromBuffer(downloaded.buffer, downloaded.episode, downloaded.filename);
      if (!subtitle || Buffer.byteLength(subtitle.content) > 2 * 1024 * 1024) {
        return NextResponse.json({ state: "invalid", message: "다운로드 파일에서 해당 회차 자막을 찾지 못했습니다." }, { headers: { "Cache-Control": "no-store" } });
      }
      await saveUploadedSubtitle(user.username, downloaded.animeId, downloaded.episode,
        subtitle.orig_filename.slice(0, 255), subtitle.content, subtitle.format);
      await stopTurnstileBrowser(id, user.username);
      return NextResponse.json({ state: "saved", filename: subtitle.orig_filename }, { headers: { "Cache-Control": "no-store" } });
    }
    if (downloaded.state === "invalid") {
      return NextResponse.json({ state: "invalid", message: "파일 크기가 12MB를 넘거나 비어 있습니다." }, { headers: { "Cache-Control": "no-store" } });
    }
    const screen = await captureTurnstileBrowser(user.username, id);
    if (!screen) return NextResponse.json({ state: "expired" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    return NextResponse.json({ state: downloaded.state, image: screen.image, remainingMs: screen.remainingMs }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[captcha-subtitle browser error]", error);
    return NextResponse.json({ state: "error", message: "브라우저 상태를 확인하지 못했습니다." }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const id = request.nextUrl.searchParams.get("sessionId") || "";
  await stopTurnstileBrowser(id, user.username);
  return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
}
