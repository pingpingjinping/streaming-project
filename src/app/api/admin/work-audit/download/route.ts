import { getSessionUser } from "@/lib/auth";
import { resolveAuditSnapshotFile, resolveAuditSubtitleFile } from "@/lib/workAuditAccess";
import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ success: false, message: "로그인이 필요합니다." }, { status: 401 });
  if (!user.isAdmin) return NextResponse.json({ success: false, message: "관리자 전용 자료입니다." }, { status: 403 });

  const kind = request.nextUrl.searchParams.get("type");
  try {
    const file = kind === "snapshot"
      ? await resolveAuditSnapshotFile(request.nextUrl.searchParams.get("file") || "")
      : kind === "subtitle"
        ? await resolveAuditSubtitleFile(request.nextUrl.searchParams.get("path") || "")
        : null;
    if (!file) return NextResponse.json({
      success: false, message: "허용된 파일이 아니거나 128MB 다운로드 제한을 초과했습니다.",
    }, { status: 404 });

    // Attachment-only + nosniff; even an HTML-looking subtitle is never run as a page.
    // Read streams avoid buffering ZIPs/SQLite snapshots in Node.js memory on WalnutPi.
    const stream = Readable.toWeb(createReadStream(file.path)) as ReadableStream;
    return new Response(stream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(file.name),
        "Content-Length": String(file.size),
        "Cache-Control": "private, no-store, no-transform",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
      },
    });
  } catch (e: unknown) {
    if (["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException)?.code || ""))
      return NextResponse.json({ success: false, message: "파일이 존재하지 않습니다." }, { status: 404 });
    console.error("[Work audit file download]", e);
    return NextResponse.json({ success: false, message: "파일을 확인하지 못했습니다." }, { status: 500 });
  }
}
