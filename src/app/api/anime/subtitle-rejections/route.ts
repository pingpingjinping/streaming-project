import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSubtitleRejections, updateSubtitleRejection } from "@/lib/db";

function validAnimeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 100;
}

function validSource(provider: unknown, sourceKey: unknown): provider is "aniall" | "anissia" | "local" {
  return (provider === "aniall" || provider === "anissia" || provider === "local") &&
    typeof sourceKey === "string" && sourceKey.trim().length > 0 && sourceKey.length <= 4096;
}

export async function GET(request: NextRequest) {
  if (!await getSessionUser()) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  const animeId = request.nextUrl.searchParams.get("animeId");
  if (!validAnimeId(animeId)) return NextResponse.json({ message: "잘못된 작품 ID" }, { status: 400 });
  return NextResponse.json({ success: true, rejections: await getSubtitleRejections(animeId) },
    { headers: { "Cache-Control": "no-store" } });
}

async function change(request: NextRequest, reject: boolean) {
  if (!await getSessionUser()) return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null);
  if (!validAnimeId(body?.animeId) || !validSource(body?.provider, body?.sourceKey)) {
    return NextResponse.json({ message: "작품이나 자막 정보가 올바르지 않습니다." }, { status: 400 });
  }
  if (!await updateSubtitleRejection(body.animeId, body.provider, body.sourceKey, reject)) {
    return NextResponse.json({ message: "선택을 저장하지 못했습니다." }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}

export async function POST(request: NextRequest) { return change(request, true); }
export async function DELETE(request: NextRequest) { return change(request, false); }
