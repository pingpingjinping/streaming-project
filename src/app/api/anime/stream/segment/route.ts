import { NextRequest, NextResponse } from "next/server";
import { UnsafeProxyUrlError } from "@/lib/proxyGuard";
import { fetchProxyStream, SEGMENT_LIMIT_BYTES, SEGMENT_TIMEOUT_MS, ProxyTimeoutError, ProxySizeError } from "@/lib/streamProxy";
import { getSessionUser } from "@/lib/auth";
import { extractAacFromTs } from "@/lib/tsDemuxer";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  // 보안: 미인증 사용자가 서버를 오픈 프록시로 악용하는 것을 방지
  const user = await getSessionUser();
  if (!user) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const targetUrl = searchParams.get("url")?.trim();
  let refUrl = searchParams.get("ref")?.trim();
  if (!refUrl) {
    if (targetUrl && (targetUrl.includes("whycdn") || targetUrl.includes("fri") || targetUrl.includes("michealcdn"))) {
      refUrl = "https://michealcdn.com/";
    } else {
      refUrl = "https://playv2.sub3.top/";
    }
  }
  const isAudioOnly = searchParams.get("audio") === "1" || searchParams.get("audio") === "true";

  if (!targetUrl) {
    return new NextResponse("Missing url parameter", { status: 400 });
  }

  try {
    const fetchHeaders: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Referer: refUrl,
    };
    if (targetUrl.includes("whycdn") || targetUrl.includes("fri") || targetUrl.includes("michealcdn")) {
      fetchHeaders["Origin"] = "https://michealcdn.com";
    }

    if (!isAudioOnly && request.headers.get("range")) {
      fetchHeaders.Range = request.headers.get("range")!;
    }
    const { response: res } = await fetchProxyStream(targetUrl, {
      headers: fetchHeaders, signal: request.signal,
      maxBytes: SEGMENT_LIMIT_BYTES, timeoutMs: SEGMENT_TIMEOUT_MS,
    });
    const mediaType = res.headers.get("content-type") || "";
    const headers = new Headers({
      "Content-Type": /^(?:video\/|audio\/|application\/octet-stream(?:;|$))/i.test(mediaType) ? mediaType : "video/mp2t",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Cache-Control": "public, max-age=86400, s-maxage=86400, immutable",
    });
    for (const name of ["content-range", "accept-ranges", "content-length"]) {
      const value = res.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (!res.ok) {
      await res.body?.cancel();
      const errorHeaders = new Headers();
      if (res.status === 416 && res.headers.has("content-range")) {
        errorHeaders.set("Content-Range", res.headers.get("content-range")!);
      }
      return new NextResponse("Upstream segment error", { status: res.status, headers: errorHeaders });
    }

    // Ordinary segments and encryption keys are relayed with backpressure.
    // Only audio extraction needs a complete (bounded) segment in memory.
    if (!isAudioOnly) return new NextResponse(res.body, { status: res.status, headers });
    const arrayBuffer = await res.arrayBuffer();

    if (isAudioOnly) {
      const uint8 = new Uint8Array(arrayBuffer);
      const aac = extractAacFromTs(uint8);
      // aac가 추출되었고 비디오가 제거되어 크기가 줄어든 경우 순수 오디오로 반환
      if (aac.length > 0 && aac.length < uint8.length) {
        const aacBuffer = aac.buffer.slice(aac.byteOffset, aac.byteOffset + aac.byteLength) as ArrayBuffer;
        return new NextResponse(aacBuffer, {
          status: 200,
          headers: {
            "Content-Type": "audio/aac",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Cache-Control": "public, max-age=86400, s-maxage=86400, immutable",
          },
        });
      }
    }

    return new NextResponse(arrayBuffer, { status: res.status, headers });
  } catch (error) {
    if (error instanceof UnsafeProxyUrlError) return new NextResponse("Blocked URL", { status: 400 });
    if (error instanceof ProxyTimeoutError) return new NextResponse("Upstream timeout", { status: 504 });
    if (error instanceof ProxySizeError) return new NextResponse("Upstream segment too large", { status: 502 });
    console.error("[Segment Proxy error]:", error);
    // 보안: 내부/외부 에러 상세를 응답 본문에 노출하지 않음
    return new NextResponse("Proxy error", {
      status: 502,
    });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}
