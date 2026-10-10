import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { uploadAdminSubtitles } from "@/lib/adminSubtitleLinker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user?.isAdmin) return NextResponse.json({ success: false, message: "관리자 권한이 필요합니다." }, { status: 403 });
  const site = request.headers.get("sec-fetch-site");
  if (site && !["same-origin", "none"].includes(site)) return NextResponse.json({ success: false, message: "허용되지 않은 요청입니다." }, { status: 403 });
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin)
    return NextResponse.json({ success: false, message: "외부에서의 업로드는 허용하지 않습니다." }, { status: 403 });
  if (Number(request.headers.get("content-length")) > 52 * 1024 * 1024)
    return NextResponse.json({ success: false, message: "한 번에 48MB까지 올릴 수 있습니다." }, { status: 413 });
  try {
    const form = await request.formData();
    const files = form.getAll("files");
    const names = JSON.parse(String(form.get("names") || "[]"));
    const label = String(form.get("label") || "받은 자막");
    if (!Array.isArray(names) || files.length !== names.length ||
      !files.length || files.length > 120 || label.length > 120 ||
      files.some(file => !(file instanceof File))) {
      return NextResponse.json({ success: false, message: "업로드 파일 목록을 확인해 주세요." }, { status: 400 });
    }
    const content: Array<{name:string;bytes:Buffer}> = [];
    let total = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i] as File;
      if (file.size < 1 || file.size > 16 * 1024 * 1024 || typeof names[i] !== "string")
        return NextResponse.json({ success: false, message: "개별 파일은 16MB 이하로 올려 주세요." }, { status: 413 });
      total += file.size;
      if (total > 48 * 1024 * 1024)
        return NextResponse.json({ success: false, message: "총 업로드 크기는 48MB 이하입니다." }, { status: 413 });
      content.push({ name: names[i], bytes: Buffer.from(await file.arrayBuffer()) });
    }
    const item = await uploadAdminSubtitles(content, label);
    return NextResponse.json({ success: true, item }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.warn("[admin subtitle upload]", error);
    return NextResponse.json({
      success: false, message: error instanceof Error ? error.message : "업로드에 실패했습니다."
    }, { status: 400 });
  }
}
