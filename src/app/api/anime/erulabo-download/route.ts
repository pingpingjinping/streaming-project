import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isTrustedAdminWriteRequest } from "@/lib/adminSubtitleRequestAuth";
import { getSubtitleEpisodeStart, getSubtitleRejections } from "@/lib/db";
import { getReanimeMatch } from "@/lib/reanimeMatches";
import { resolveKoreanTitle, parseSeason, mapProviderEpisodeNumber } from "@/lib/subtitles";
import { toSourceEpisode } from "@/lib/episodeMapping";
import { canonicalErulaboUrl, getErulaboDownloadStatus, requestErulaboDownload } from "@/lib/erulaboDownloads";

export const dynamic = "force-dynamic";
async function handle(request: NextRequest, start: boolean) {
  const user = await getSessionUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  if (start && !isTrustedAdminWriteRequest(request.headers, request.nextUrl.origin))
    return new NextResponse("Forbidden", { status: 403 });
  try {
    const body = start ? await request.json() : Object.fromEntries(request.nextUrl.searchParams);
    const animeId = typeof body.animeId === "string" ? body.animeId.trim() : "";
    const rawTitle = String(body.matchedTitle || body.title || "").trim();
    const episode = Number(body.episodeNumber);
    if (!animeId || animeId.length > 100 || !rawTitle || rawTitle.length > 512
        || !Number.isSafeInteger(episode) || episode < 1 || episode > 10000)
      return NextResponse.json({ success: false, message: "작품과 회차를 확인해 주세요." }, { status: 400 });
    let website: string;
    try { website = canonicalErulaboUrl(String(body.website || "")); }
    catch { return NextResponse.json({ success: false, message: "에루샤 게시글 주소를 확인해 주세요." }, { status: 400 }); }
    const rejected = await getSubtitleRejections(animeId);
    if (rejected.some(item => item.provider === "anissia" && item.sourceKey === website))
      return NextResponse.json({ success: false, message: "이 작품에서 숨긴 자막입니다." }, { status: 409 });
    const title = await resolveKoreanTitle(rawTitle);
    const season = parseSeason(title) || parseSeason(rawTitle);
    const startEpisode = await getSubtitleEpisodeStart(user.username, animeId);
    const sourceEpisode = startEpisode ? toSourceEpisode(episode, startEpisode)
      : mapProviderEpisodeNumber(String(body.creatorEpisode || ""), episode, season);
    const linked = animeId.startsWith("re_") ? await getReanimeMatch(animeId) : null;
    const animeNo = linked?.anissiaNo || Number(animeId.match(/^(?:ani_)?(\d+)$/)?.[1]) || null;
    const context = { animeId, title, episode, sourceEpisode, season, animeNo, website };
    const status = start ? await requestErulaboDownload(context) : await getErulaboDownloadStatus(context);
    return NextResponse.json({ success: true, ...status }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.warn("[Erulabo download request]", error);
    return NextResponse.json({ success: false, message: start
      ? "자막 받아오기를 시작하지 못했어요. 잠시 후 다시 시도해 주세요."
      : "다운로드 상태를 확인하지 못했어요." }, { status: 503 });
  }
}
export const GET = (request: NextRequest) => handle(request, false);
export const POST = (request: NextRequest) => handle(request, true);
