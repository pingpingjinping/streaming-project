import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { refreshLocalSubtitleSearchIndex } from "@/lib/localSubtitleSearch";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";
const storageRoot = () => process.env.SUBTITLE_STORAGE_DIR || path.join(process.cwd(), "data", "subtitles");
const indexFile = () => path.join(storageRoot(), ".local-subtitle-name-index-v1.json");

async function adminError() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({
    success: false, message: "로그인 세션을 확인할 수 없습니다. 새로고침 후 다시 로그인해 주세요."
  }, { status: 401 });
  if (!user.isAdmin) return NextResponse.json({
    success: false, message: "현재 로그인 계정에 관리자 권한이 없습니다."
  }, { status: 403 });
  return null;
}

// Reading status does not generate an index or traverse the subtitle folders.
export async function GET() {
  const accessError = await adminError();
  if (accessError) return accessError;
  try {
    const [raw, info] = await Promise.all([readFile(indexFile(), "utf8"), stat(indexFile())]);
    const data = JSON.parse(raw);
    if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error("Invalid index snapshot");
    return NextResponse.json({
      success: true,
      index: { count: data.entries.length, refreshedAt: new Date(data.scannedAt).toISOString(), bytes: info.size },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return NextResponse.json({ success: true, index: null }, { headers: { "Cache-Control": "no-store" } });
    }
    console.error("[Admin subtitle name index: status]", error);
    return NextResponse.json({ success: false, message: "인덱스 상태 확인에 실패했습니다." }, { status: 500 });
  }
}

// Full rebuild is an explicit administrator action, never triggered by search.
export async function POST(request: Request) {
  const accessError = await adminError();
  if (accessError) return accessError;
  const site = request.headers.get("sec-fetch-site");
  if (site && !["same-origin", "none"].includes(site)) {
    return NextResponse.json({ success: false, message: "허용되지 않은 요청입니다." }, { status: 403 });
  }
  try {
    const start = Date.now();
    const count = await refreshLocalSubtitleSearchIndex();
    return NextResponse.json({
      success: true,
      index: { count, refreshedAt: new Date().toISOString(), elapsedMs: Date.now() - start },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[Admin subtitle name index: refresh]", error);
    return NextResponse.json({ success: false, message: "로컬 자막 인덱스 갱신에 실패했습니다." }, { status: 500 });
  }
}
