import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { isTrustedAdminWriteRequest } from "@/lib/adminSubtitleRequestAuth";
import {
  browseLocalEntries, deleteAdminSubtitleLink, findCatalogWorks,
  getAdminSubtitleLinks, saveAdminSubtitleLink, safeSubtitlePath,
} from "@/lib/adminSubtitleLinker";

export const dynamic = "force-dynamic";
const respond = (message: string, status: number) =>
  NextResponse.json({ success: false, message }, { status, headers: { "Cache-Control": "no-store" } });

async function adminSession() {
  const user = await getSessionUser();
  if (!user) return { user: null, failure: respond("로그인 세션을 확인할 수 없습니다. 새로고침 후 다시 로그인해 주세요.", 401) };
  if (!user.isAdmin) return { user: null, failure: respond("현재 로그인 계정에 관리자 권한이 없습니다.", 403) };
  return { user, failure: null };
}

function writeOriginFailure(request: NextRequest) {
  return isTrustedAdminWriteRequest(request.headers, request.nextUrl.origin)
    ? null : respond("요청 출처를 확인할 수 없습니다. 현재 사이트 주소에서 다시 시도해 주세요.", 403);
}

export async function GET(request: NextRequest) {
  const auth = await adminSession();
  if (!auth.user) return auth.failure!;
  const params = request.nextUrl.searchParams;
  const mode = params.get("mode") || "links";
  const q = (params.get("q") || "").slice(0, 150);
  try {
    if (mode === "files") {
      const startedAt = Date.now();
      const result = await browseLocalEntries(q);
      return NextResponse.json({ success: true, items: result.items, total: result.total,
        elapsedMs: Date.now() - startedAt,
      }, { headers: { "Cache-Control": "no-store" } });
    }
    const result = mode === "works" ? await findCatalogWorks(q)
      : mode === "links" ? await getAdminSubtitleLinks() : null;
    if (!result) return respond("조회 모드를 확인해 주세요.", 400);
    return NextResponse.json({ success: true, items: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.warn("[admin subtitle links GET]", error);
    return respond("연결 정보를 읽지 못했습니다.", 500);
  }
}

export async function PUT(request: NextRequest) {
  const auth = await adminSession();
  if (!auth.user) return auth.failure!;
  const originFailure = writeOriginFailure(request);
  if (originFailure) return originFailure;
  const user = auth.user;
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
  const auth = await adminSession();
  if (!auth.user) return auth.failure!;
  const originFailure = writeOriginFailure(request);
  if (originFailure) return originFailure;
  const relativePath = request.nextUrl.searchParams.get("path") || "";
  if (!safeSubtitlePath(relativePath, /\.zip$/i.test(relativePath) ? "zip" : "folder"))
    return respond("해제할 파일 경로를 확인해 주세요.", 400);
  try {
    await deleteAdminSubtitleLink(relativePath);
    return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
  } catch { return respond("연결을 해제하지 못했습니다.", 500); }
}
