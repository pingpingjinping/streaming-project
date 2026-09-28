import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { saveVerifiedSubtitleCache } from "@/lib/subtitleStorage";
import { assertSafeProxyUrl, UnsafeProxyUrlError } from "@/lib/proxyGuard";

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  try {
    const body = await request.json();
    const animeId = String(body.animeId || "").trim();
    const episodeNumber = Number(body.episodeNumber);
    const sourceProvider = body.sourceProvider === "aniall" ? "aniall" : body.sourceProvider === "anissia" ? "anissia" : null;
    const sourceUrl = String(body.sourceUrl || "").trim();
    const matchedTitle = String(body.matchedTitle || "").trim().slice(0, 512);
    const filename = String(body.filename || "자막").trim().slice(0, 255) || "자막";
    const content = String(body.content || "");
    const format = body.format === "ASS" ? "ASS" : body.format === "VTT" ? "VTT" : null;
    const mediaSeconds = Number(body.mediaSeconds);

    if (!animeId || animeId.length > 100 || !Number.isSafeInteger(episodeNumber) || episodeNumber < 1 ||
      !sourceProvider || !format || !sourceUrl || !content || Buffer.byteLength(content, "utf8") > 2_000_000 || mediaSeconds < 60) {
      return NextResponse.json({ success: false, message: "Invalid subtitle cache data" }, { status: 400 });
    }
    await assertSafeProxyUrl(sourceUrl);
    await saveVerifiedSubtitleCache({ animeId, episodeNumber, filename, content, format, sourceProvider, sourceUrl, matchedTitle });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof UnsafeProxyUrlError) {
      return NextResponse.json({ success: false, message: "Invalid subtitle source" }, { status: 400 });
    }
    console.error("[Subtitle cache POST error]:", error);
    return NextResponse.json({ success: false, message: "자막 캐시 저장에 실패했습니다." }, { status: 500 });
  }
}
