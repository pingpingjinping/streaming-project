import { NextRequest, NextResponse } from "next/server";
import {
  deleteManualStreamSource,
  getManualStreamSources,
  upsertManualStreamSource,
  type ManualStreamSourceType,
} from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { assertSafeProxyUrl, UnsafeProxyUrlError } from "@/lib/proxyGuard";

export const dynamic = "force-dynamic";

function detectSourceType(url: string, requested?: string): ManualStreamSourceType {
  if (requested === "m3u8" || requested === "iframe") {
    return requested;
  }
  const lower = url.toLowerCase();
  return lower.includes(".m3u8") || lower.includes("master.txt") ? "m3u8" : "iframe";
}

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const animeId = searchParams.get("animeId")?.trim() || "";
  const episodeNumber = parseInt(searchParams.get("ep") || "0", 10);

  if (!animeId || !Number.isInteger(episodeNumber) || episodeNumber <= 0) {
    return NextResponse.json(
      { success: false, message: "작품 ID와 회차가 필요합니다." },
      { status: 400 }
    );
  }

  const sources = await getManualStreamSources(user.username, animeId, episodeNumber);
  return NextResponse.json(
    { success: true, sources },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const body = await request.json();
    const animeId = String(body?.animeId || "").trim();
    const episodeNumber = parseInt(String(body?.episodeNumber || "0"), 10);
    const rawUrl = String(body?.url || "").trim();
    const labelInput = String(body?.label || "").trim().slice(0, 100);

    if (!animeId || !Number.isInteger(episodeNumber) || episodeNumber <= 0 || !rawUrl) {
      return NextResponse.json(
        { success: false, message: "작품 ID, 회차, URL을 모두 입력해주세요." },
        { status: 400 }
      );
    }

    let parsed: URL;
    try {
      parsed = await assertSafeProxyUrl(rawUrl);
    } catch (error) {
      if (error instanceof UnsafeProxyUrlError) {
        return NextResponse.json(
          { success: false, message: `허용되지 않는 주소입니다: ${error.message}` },
          { status: 400 }
        );
      }
      throw error;
    }

    const url = parsed.toString();
    const sourceType = detectSourceType(url, body?.sourceType);
    const label = labelInput || parsed.hostname;

    const source = await upsertManualStreamSource({
      userId: user.username,
      animeId,
      episodeNumber,
      label,
      url,
      sourceType,
    });

    if (!source) {
      return NextResponse.json(
        { success: false, message: "직접 링크 저장에 실패했습니다." },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, source });
  } catch (error) {
    console.error("[POST /api/anime/manual-source error]:", error);
    return NextResponse.json(
      { success: false, message: "직접 링크 저장 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const id = parseInt(searchParams.get("id") || "0", 10);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json(
      { success: false, message: "삭제할 링크 ID가 필요합니다." },
      { status: 400 }
    );
  }

  const deleted = await deleteManualStreamSource(user.username, id);
  return NextResponse.json(
    { success: deleted },
    { status: deleted ? 200 : 404 }
  );
}
