import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { assertSafeProxyUrl, UnsafeProxyUrlError } from "@/lib/proxyGuard";
import { unwrapFlixCloudSegment } from "@/lib/flixCloudDirect";

export const dynamic = "force-dynamic";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { searchParams } = new URL(request.url);
  const targetUrl = searchParams.get("url")?.trim();
  if (!targetUrl) return new NextResponse("Missing url", { status: 400 });

  try {
    await assertSafeProxyUrl(targetUrl);
  } catch (error) {
    if (error instanceof UnsafeProxyUrlError) {
      return new NextResponse("Blocked URL", { status: 400 });
    }
    throw error;
  }

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        "User-Agent": UA,
        Accept: "*/*",
        Referer: "https://flixcloud.cc/",
        Origin: "https://flixcloud.cc",
      },
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });

    if (!upstream.ok) {
      return new NextResponse(`FlixCloud media HTTP ${upstream.status}`, {
        status: upstream.status,
      });
    }

    const raw = new Uint8Array(await upstream.arrayBuffer());
    const { body, unwrapped } = unwrapFlixCloudSegment(raw);
    const upstreamType = upstream.headers.get("content-type") || "application/octet-stream";
    const pathname = new URL(targetUrl).pathname.toLowerCase();
    const looksLikeTs =
      unwrapped ||
      pathname.endsWith(".ts") ||
      (body.length > 0 && body[0] === 0x47);

    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": looksLikeTs ? "video/mp2t" : upstreamType,
        "Cache-Control": "private, max-age=3600",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    console.error("[FlixCloud direct media proxy]:", error);
    return new NextResponse("FlixCloud media proxy failed", { status: 502 });
  }
}
