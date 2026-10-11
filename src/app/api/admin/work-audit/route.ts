import { getSessionUser } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import path from "node:path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const auditDir = () => process.env.WORK_AUDIT_DIR || path.join(process.cwd(), "data", "work-audit");

const headers = { "Cache-Control": "private, no-store, no-transform", "X-Content-Type-Options": "nosniff" };
function respond(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers });
}
async function adminError() {
  const user = await getSessionUser();
  if (!user) return respond({ success: false, message: "로그인이 필요합니다." }, 401);
  if (!user.isAdmin) return respond({ success: false, message: "관리자 전용 자료입니다." }, 403);
  return null;
}

export async function GET(request: NextRequest) {
  const error = await adminError();
  if (error) return error;
  const mode = request.nextUrl.searchParams.get("mode") || "status";
  if (mode === "status") {
    try {
      const manifest = JSON.parse(await readFile(path.join(auditDir(), "manifest.json"), "utf8"));
      if (manifest.schema_version !== 1 || !manifest.files) throw new Error("Unsupported manifest version");
      return respond({ success: true, ready: true, manifest });
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT")
        return respond({ success: true, ready: false, message: "Pi에서 검수 스냅샷을 아직 생성하지 않았습니다." });
      console.error("[Work audit status]", e);
      return respond({ success: false, message: "검수 스냅샷 상태 확인 실패" }, 500);
    }
  }
  if (mode !== "search") return respond({ success: false, message: "지원하지 않는 요청입니다." }, 400);
  const raw = request.nextUrl.searchParams.get("q") || "";
  if (raw.length > 120) return respond({ success: false, message: "검색어가 너무 깁니다." }, 400);
  const q = raw.normalize("NFKC").toLocaleLowerCase("ko-KR").trim();
  if (q.length < 2) return respond({ success: true, results: [], truncated: false });
  const limit = Math.min(100, Math.max(1, Number.parseInt(request.nextUrl.searchParams.get("limit") || "60", 10) || 60));
  const result: Array<{ path: string; provider: string; size: number; mtime: string }> = [];
  let truncated = false;
  try {
    // The inventory is an immutable, pregenerated JSONL snapshot. Never walk Pi disks for a search request.
    const lines = createInterface({
      input: createReadStream(path.join(auditDir(), "subtitle_files.jsonl.gz")).pipe(createGunzip()),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (!line || !line.normalize("NFKC").toLocaleLowerCase("ko-KR").includes(q)) continue;
      const item = JSON.parse(line);
      if (result.length >= limit) { truncated = true; break; }
      if (typeof item.path !== "string" || typeof item.provider !== "string") continue;
      result.push({ path: item.path, provider: item.provider, size: Number(item.size) || 0,
        mtime: String(item.mtime || "") });
    }
    return respond({ success: true, results: result, truncated });
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return respond({
      success: false, message: "파일 목록이 없습니다. Pi에서 검수 스냅샷을 먼저 생성하세요.",
    }, 404);
    console.error("[Work audit search]", e);
    return respond({ success: false, message: "자막 파일 목록 검색 실패" }, 500);
  }
}
