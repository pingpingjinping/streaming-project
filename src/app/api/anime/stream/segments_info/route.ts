import { NextRequest, NextResponse } from "next/server";
import { UnsafeProxyUrlError } from "@/lib/proxyGuard";
import { fetchProxyStream, TEXT_LIMIT_BYTES, TEXT_TIMEOUT_MS, ProxyTimeoutError } from "@/lib/streamProxy";
import { getSessionUser } from "@/lib/auth";

import { getSubtitleEpisodeStart } from "@/lib/db";
import { resolveAnissiaStream } from "@/lib/resolvers/videoResolver";

export const dynamic = "force-dynamic";

const OP_SEARCH_SEC = 240; // 앞 4분
const ED_SEARCH_SEC = 150; // 뒤 2.5분

interface SegmentItem {
  duration: number;
  url: string;
  offset: number;
}

async function fetchM3u8(url: string, refUrl = "https://playv2.sub3.top/", signal?: AbortSignal): Promise<{ content: string; finalUrl: string }> {
  const actualRef = (url.includes("michealcdn") || url.includes("whycdn")) ? "https://michealcdn.com/" : refUrl;
  const { response: res, finalUrl } = await fetchProxyStream(url, {
    signal, maxBytes: TEXT_LIMIT_BYTES, timeoutMs: TEXT_TIMEOUT_MS,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Referer: actualRef,
    },
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Failed to fetch m3u8: ${res.status}`);
  }
  const content = await res.text();
  return { content, finalUrl };
}

async function parseM3u8Recursive(url: string, refUrl = "https://playv2.sub3.top/", signal?: AbortSignal, visited = new Set<string>()): Promise<SegmentItem[]> {
  if (visited.has(url) || visited.size >= 5) throw new Error("Invalid nested playlist");
  visited.add(url);
  const { content, finalUrl } = await fetchM3u8(url, refUrl, signal);

  // 마스터 플레이리스트 처리
  if (content.includes("#EXT-X-STREAM-INF")) {
    const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (!line.startsWith("#")) {
        const nextUrl = new URL(line, finalUrl).toString();
        return parseM3u8Recursive(nextUrl, refUrl, signal, visited);
      }
    }
  }

  const lines = content.split(/\r?\n/);
  const segments: SegmentItem[] = [];
  let curDur = 0;
  let curOffset = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#EXTINF:")) {
      const match = trimmed.match(/[\d.]+/);
      curDur = match ? parseFloat(match[0]) : 0;
    } else if (trimmed && !trimmed.startsWith("#")) {
      const absUrl = new URL(trimmed, finalUrl).toString();
      segments.push({
        duration: curDur,
        url: absUrl,
        offset: curOffset,
      });
      curOffset += curDur;
    }
  }

  return segments;
}

export async function GET(request: NextRequest) {
  // 보안: 미인증 사용자가 서버를 오픈 프록시로 악용하는 것을 방지
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  let m3u8Url = searchParams.get("url")?.trim();
  const animeId = searchParams.get("anime_id")?.trim();
  const ep = parseInt(searchParams.get("ep") || "1", 10) || 1;
  const isDub = searchParams.get("dub") === "1";

  try {
    // anime_id와 ep가 제공된 경우 회차 스트림 m3u8을 자동으로 찾기
    if (!m3u8Url && animeId) {
      const { getProviderByAnimeId } = await import("@/lib/providers");
      const provider = getProviderByAnimeId(animeId);
      const subtitleEpisodeStart = await getSubtitleEpisodeStart(user.username, animeId);
      const detail = await provider.getAnimeDetail(animeId, { subtitleEpisodeStart });
      if (detail) {
        const epList = isDub && detail.dub_episodes && detail.dub_episodes.length > 0
          ? detail.dub_episodes
          : detail.sub_episodes;
        const targetEp = epList.find((e) => e.number === ep);
        if (targetEp && targetEp.watch_url) {
          const streamInfo = provider.name === "anissia"
            ? await resolveAnissiaStream(Number(animeId.slice(4)), ep, detail.title, detail.original_title, undefined, animeId, subtitleEpisodeStart, detail.total_episodes)
            : await provider.getEpisodeStream(targetEp.watch_url);
          if (streamInfo && streamInfo.m3u8_url) {
            m3u8Url = streamInfo.m3u8_url;
          }
        }
      }
    }

    if (!m3u8Url) {
      return NextResponse.json(
        { success: false, message: "Missing url or anime_id+ep parameter" },
        { status: 400 }
      );
    }

    // Proxy url인 경우 원본 URL 추출
    if (m3u8Url.includes("/api/anime/stream/m3u8?url=")) {
      const u = new URL(m3u8Url, "http://localhost");
      m3u8Url = decodeURIComponent(u.searchParams.get("url") || m3u8Url);
    }

    if (m3u8Url.includes("michealcdn.com") && m3u8Url.includes("master.m3u8")) {
      m3u8Url = m3u8Url.replace(/master\.m3u8(\?.*)?$/, "master.txt");
    }

    const segments = await parseM3u8Recursive(m3u8Url, undefined, request.signal);
    if (segments.length === 0) {
      return NextResponse.json(
        { success: false, message: "No segments found in m3u8" },
        { status: 404 }
      );
    }

    const totalDuration = segments.reduce((sum, s) => sum + s.duration, 0);

    // 1. 오프닝 세그먼트 (앞 4분: 0 ~ 240초)
    const opEndLimit = Math.min(totalDuration, OP_SEARCH_SEC);
    const opSegments = segments
      .filter((s) => s.offset < opEndLimit && s.offset + s.duration > 0)
      .map((s) => ({
        duration: s.duration,
        offset: s.offset,
        url: s.url, // 브라우저 직접 다운로드 (Vercel 대역폭 0B)
        proxyUrl: `/api/anime/stream/segment?url=${encodeURIComponent(s.url)}&audio=1`, // CORS 차단 시 폴백
      }));

    // 2. 엔딩 세그먼트 (뒤 2.5분: max(0, totalDuration - 150) ~ totalDuration)
    const edStartLimit = Math.max(0, totalDuration - ED_SEARCH_SEC);
    const edSegments = segments
      .filter((s) => s.offset + s.duration > edStartLimit)
      .map((s) => ({
        duration: s.duration,
        offset: s.offset,
        url: s.url, // 브라우저 직접 다운로드 (Vercel 대역폭 0B)
        proxyUrl: `/api/anime/stream/segment?url=${encodeURIComponent(s.url)}&audio=1`, // CORS 차단 시 폴백
      }));

    return NextResponse.json(
      {
        success: true,
        totalDuration: Math.round(totalDuration * 10) / 10,
        op: {
          startSec: 0,
          durationSec: opEndLimit,
          segments: opSegments,
        },
        ed: {
          startSec: Math.round(edStartLimit * 10) / 10,
          durationSec: Math.round((totalDuration - edStartLimit) * 10) / 10,
          segments: edSegments,
        },
      },
      {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=3600",
        },
      }
    );
  } catch (error) {
    if (error instanceof UnsafeProxyUrlError) return NextResponse.json({ success: false, message: "Blocked URL" }, { status: 400 });
    if (error instanceof ProxyTimeoutError) return NextResponse.json({ success: false, message: "Upstream timeout" }, { status: 504 });
    console.error("[segments_info error]:", error);
    // 보안: 내부 에러 상세를 클라이언트에 노출하지 않음
    return NextResponse.json(
      { success: false, message: "시청 정보를 불러오지 못했습니다." },
      { status: 500 }
    );
  }
}
