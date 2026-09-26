import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  getStreamingProviderSettings,
  setStreamingProviderEnabled,
  STREAMING_PROVIDERS,
  type StreamingProviderKey,
} from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ success: false, message: "로그인이 필요합니다." }, { status: 401 });
  return NextResponse.json({ success: true, providers: await getStreamingProviderSettings() });
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ success: false, message: "로그인이 필요합니다." }, { status: 401 });
  if (!user.isAdmin) return NextResponse.json({ success: false, message: "관리자만 사이트를 관리할 수 있습니다." }, { status: 403 });

  try {
    const body = await request.json();
    const key = String(body?.provider || "") as StreamingProviderKey;
    const enabled = body?.enabled;
    if (!(STREAMING_PROVIDERS as readonly string[]).includes(key) || typeof enabled !== "boolean") {
      return NextResponse.json({ success: false, message: "지원하지 않는 사이트 설정입니다." }, { status: 400 });
    }

    if (!enabled) {
      const active = (await getStreamingProviderSettings()).filter((source) => source.enabled);
      if (active.length <= 1 && active[0]?.key === key) {
        return NextResponse.json({ success: false, message: "사이트를 하나 이상 사용하도록 남겨야 합니다." }, { status: 400 });
      }
    }

    const success = await setStreamingProviderEnabled(key, enabled);
    return NextResponse.json(
      success
        ? { success: true, providers: await getStreamingProviderSettings() }
        : { success: false, message: "사이트 설정을 저장하지 못했습니다." },
      { status: success ? 200 : 500 }
    );
  } catch {
    return NextResponse.json({ success: false, message: "사이트 설정을 저장하지 못했습니다." }, { status: 500 });
  }
}
