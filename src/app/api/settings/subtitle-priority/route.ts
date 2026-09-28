import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getSubtitleSourcePriority, setSubtitleSourcePriority } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ success: false, message: "로그인이 필요합니다." }, { status: 401 });
  return NextResponse.json({ success: true, priority: await getSubtitleSourcePriority() });
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ success: false, message: "로그인이 필요합니다." }, { status: 401 });
  if (!user.isAdmin) return NextResponse.json({ success: false, message: "관리자만 자막 우선순위를 변경할 수 있습니다." }, { status: 403 });
  try {
    const { priority } = await request.json();
    if (priority !== "aniall" && priority !== "anissia") {
      return NextResponse.json({ success: false, message: "지원하지 않는 자막 우선순위입니다." }, { status: 400 });
    }
    const success = await setSubtitleSourcePriority(priority);
    return NextResponse.json(success ? { success: true, priority } : { success: false, message: "설정을 저장하지 못했습니다." }, { status: success ? 200 : 500 });
  } catch {
    return NextResponse.json({ success: false, message: "설정을 저장하지 못했습니다." }, { status: 500 });
  }
}
