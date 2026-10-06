import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getSessionUser } from "@/lib/auth";

const reportPath = () =>
  path.join(
    process.env.SUBTITLE_STORAGE_DIR || path.join(process.cwd(), "data", "subtitles"),
    ".weekly-subtitle-dashboard.json",
  );

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user || user.isAdmin !== true) {
      return NextResponse.json(
        { success: false, message: "권한이 없습니다." },
        { status: 403 },
      );
    }

    try {
      const raw = await readFile(reportPath(), "utf8");
      if (Buffer.byteLength(raw, "utf8") > 2_000_000) {
        throw new Error("Weekly subtitle dashboard report is too large");
      }
      const report = JSON.parse(raw);
      return NextResponse.json(
        { success: true, report },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return NextResponse.json(
          { success: true, report: null },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      throw error;
    }
  } catch (error) {
    console.error("[admin subtitle downloads error]:", error);
    return NextResponse.json(
      { success: false, message: "자막 다운로드 기록을 불러오지 못했습니다." },
      { status: 500 },
    );
  }
}
