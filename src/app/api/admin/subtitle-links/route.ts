import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  browseLocalEntries, deleteAdminSubtitleLink, findCatalogWorks,
  getAdminSubtitleLinks, saveAdminSubtitleLink, safeSubtitlePath,
} from "@/lib/adminSubtitleLinker";

export const dynamic = "force-dynamic";
const respond = (message: string, status: number) =>
  NextResponse.json({ success: false, message }, { status, headers: { "Cache-Control": "no-store" } });

async function authorized(request: NextRequest) {
  const user = await getSessionUser();
  if (!user?.isAdmin) return null;
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin) return null;
  const site = request.headers.get("sec-fetch-site");
  if (site && !["same-origin", "none"].includes(site)) return null;
  return user;
}

export async function GET(request: NextRequest) {
  if (!(await authorized(request))) return respond("관리자 권한이 필요합니다.", 403);
  const params = request.nextUrl.searchParams;
  const mode = params.get("mode") || "links";
  const q = (params.get("q") || "").slice(0, 150);
  try {
    const result = mode === "files" ? await browseLocalEntries(q)
      : mode === "works" ? await findCatalogWorks(q)
      : mode === "links" ? await getAdminSubtitleLinks() : null;
    if (!result) return respond("조회 모드를 확인해 주세요.", 400);
    return NextResponse.json({ success: true, items: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.warn("[admin subtitle links GET]", error);
    return respond("연결 정보를 읽지 못했습니다.", 500);
  }
}

export async function PUT(request: NextRequest) {
  const user = await authorized(request);
  if (!user) return respond("관리자 권한이 필요합니다.", 403);
  const data = await request.json().catch(() => null);
  if (!data || !safeSubtitlePath(data.relativePath, data.type) ||
    typeof data.animeId !== "string" || data.animeId.length > 150 ||
    !Number.isInteger(data.season) || data.season < 1 || data.season > 99 ||
    typeof data.kind !== "string") return respond("연결 정보를 확인해 주세요.", 400);
  try {
    const item = await saveAdminSubtitleLink({
      relativePath: data.relativePath, type: data.type,
      animeId: data.animeId, season: data.season, kind: data.kind, admin: user.username,
    });
    return NextResponse.json({ success: true, item }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return respond(error instanceof Error ? error.message : "연결을 저장하지 못했습니다.", 400);
  }
}

export async function DELETE(request: NextRequest) {
  if (!(await authorized(request))) return respond("관리자 권한이 필요합니다.", 403);
  const relativePath = request.nextUrl.searchParams.get("path") || "";
  if (!safeSubtitlePath(relativePath, /\.zip$/i.test(relativePath) ? "zip" : "folder"))
    return respond("해제할 파일 경로를 확인해 주세요.", 400);
  try {
    await deleteAdminSubtitleLink(relativePath);
    return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch { return respond("연결을 해제하지 못했습니다.", 500); }
}
