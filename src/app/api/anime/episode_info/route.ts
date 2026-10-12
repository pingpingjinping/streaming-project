import { NextRequest, NextResponse } from "next/server";
import { getProviderByAnimeId } from "@/lib/providers";
import { getSessionUser } from "@/lib/auth";

import { getSubtitleEpisodeStart } from "@/lib/db";
import { resolveAnissiaStream } from "@/lib/resolvers/videoResolver";
import { attachEpisodeCaptions } from "@/lib/episodeMapping";
import type { AnimeDetail } from '@/lib/providers/types';

export async function GET(request: NextRequest) {
  // 보안: 미인증 사용자가 2회 외부 스크래핑을 유도하는 것을 방지
  const user = await getSessionUser();
  if (!user) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const animeId = searchParams.get("id")?.trim();
  const epNum = parseInt(searchParams.get("ep") || "1", 10) || 1;
  const isDub = searchParams.get("is_dub") === "1" || searchParams.get("is_dub") === "true";
  const serverKey = searchParams.get('video_server') || undefined;
  if (serverKey && serverKey.length > 200) return NextResponse.json({ success: false, message: 'Invalid server' }, { status: 400 });
  const videoSource = searchParams.get("video_source");
  let requestedSource = ["rean", "anikoto", "linkkf", "ohli24"].includes(videoSource || "")
    ? videoSource as "rean" | "anikoto" | "linkkf" | "ohli24" : undefined;

  if (!animeId) {
    return NextResponse.json({ success: false, message: "Missing anime id" }, { status: 400 });
  }

  const provider = getProviderByAnimeId(animeId);
  const subtitleEpisodeStart = await getSubtitleEpisodeStart(user.username, animeId);
  const anikotoDetails = new Map<string, AnimeDetail>();
  let anime = await provider.getAnimeDetail(animeId, { subtitleEpisodeStart, videoSource: isDub ? undefined : requestedSource });
  if (anime && ['reanime','anissia'].includes(provider.name) && !isDub &&
      (anime.video_available === false || requestedSource === 'anikoto')) {
    const { reviewedProviderPlayback } = await import('@/lib/reviewedProviderPlayback');
    anime = await reviewedProviderPlayback(anime, requestedSource, anikotoDetails);
    requestedSource ||= anime.playback_source || (provider.name === 'reanime' && anime.video_available === false ? 'anikoto' : undefined);
  }
  if (!anime) {
    return NextResponse.json({ success: false, message: "Anime not found" }, { status: 404 });
  }

  let epList = isDub ? anime.dub_episodes : anime.sub_episodes;

  // 보안: 클라이언트에서 ?url= 로 임의 URL을 지정해 서버를 프록시/SSRF 수단으로 쓰는 것을 막기 위해
  // 스트림 URL은 항상 서버가 스크래핑한 회차 목록에서만 해석합니다.
  const matched = epList.find((e) => e.number === epNum);
  const watchUrl = matched?.watch_url || "";

  const providerSource = provider.name === 'reanime' ? 'rean' : provider.name;
  let alternateSource = !!requestedSource && requestedSource !== providerSource;
  const canResolveExtra = (provider.name === "anissia" || alternateSource) && !isDub && (!subtitleEpisodeStart || subtitleEpisodeStart === 1 || requestedSource) && epNum > 0 && epNum <= 10000;
  if (!watchUrl && !canResolveExtra) {
    return NextResponse.json({ success: false, message: "Watch URL not found" }, { status: 404 });
  }

  let streamInfo = provider.name === "anissia" || alternateSource
    ? await resolveAnissiaStream(provider.name === 'anissia' ? Number(animeId.slice(4)) : null, epNum, anime.title, anime.original_title, requestedSource, animeId, subtitleEpisodeStart,
        subtitleEpisodeStart && subtitleEpisodeStart > 1 ? anime.total_episodes : undefined, true, anikotoDetails, serverKey)
    : await provider.getEpisodeStream(watchUrl, serverKey ? { serverKey, allowServerFallback: true } : undefined);
  if (provider.name === 'reanime' && !isDub && !videoSource &&
      (!streamInfo || (!streamInfo.embed_url && !streamInfo.m3u8_url))) {
    const fallback = await resolveAnissiaStream(null, epNum, anime.title, anime.original_title,
      'anikoto', animeId, subtitleEpisodeStart, undefined, true, anikotoDetails, serverKey);
    if (fallback && (fallback.embed_url || fallback.m3u8_url)) {
      streamInfo = fallback; requestedSource = 'anikoto'; alternateSource = true;
    }
  }
  if ((provider.name === "anissia" || alternateSource) && !isDub && streamInfo?.video_episodes?.length) {
    epList = attachEpisodeCaptions(streamInfo.video_episodes, anime.sub_episodes);
  }
  if (!epList.some(e => e.number === epNum) || streamInfo?.success === false) {
    return NextResponse.json({ success: false, message: "Video episode not found" }, { status: 404 });
  }
  if (!streamInfo || (!streamInfo.m3u8_url && !streamInfo.embed_url && !streamInfo.player_url)) {
    return NextResponse.json({ success: false, message: 'Video stream unavailable' }, { status: 502 });
  }
  if (serverKey && streamInfo.video_source !== 'anikoto') {
    const { selectVideoServer } = await import('@/lib/videoServerSelection');
    streamInfo = selectVideoServer(streamInfo, serverKey)!;
  }
  const playerRef = streamInfo?.player_url || "";
  const rawM3u8 = streamInfo?.m3u8_url || "";
  const rawVtt = streamInfo?.vtt_url || "";

  const proxiedM3u8 = rawM3u8
    ? `/api/anime/stream/m3u8?url=${encodeURIComponent(rawM3u8)}&ref=${encodeURIComponent(playerRef)}`
    : "";
  const proxiedVtt = rawVtt ? `/api/anime/stream/vtt?url=${encodeURIComponent(rawVtt)}` : "";

  let linkPre = "";
  let linkNext = "";
  let linkPreEpNum: number | null = null;
  let linkNextEpNum: number | null = null;
  let epTitle = `${epNum}화`;

  for (let idx = 0; idx < epList.length; idx++) {
    const e = epList[idx];
    if (e.number === epNum) {
      epTitle = e.title;
      if (idx > 0) {
        linkPre = epList[idx - 1].watch_url;
        linkPreEpNum = epList[idx - 1].number;
      }
      if (idx + 1 < epList.length) {
        linkNext = epList[idx + 1].watch_url;
        linkNextEpNum = epList[idx + 1].number;
      }
      break;
    }
  }

  const noCache = searchParams.get("nocache") === "1";
  return NextResponse.json(
    {
      success: true,
      anime_id: animeId,
      anime_title: anime.title,
      episode_number: epNum,
      episode_title: epTitle,
      watch_url: watchUrl,
      proxied_m3u8: proxiedM3u8,
      proxied_vtt: proxiedVtt,
      m3u8_url: proxiedM3u8,
      vtt_url: proxiedVtt,
      link_pre: linkPre,
      link_next: linkNext,
      link_pre_ep_num: linkPreEpNum,
      link_next_ep_num: linkNextEpNum,
      is_dub: isDub,
      server_sources: streamInfo?.server_sources || [],
      video_server: streamInfo?.video_server,
      source_anime_id: streamInfo?.source_anime_id,
      source_episode_number: streamInfo?.source_episode_number ?? epNum,
      embed_url: streamInfo?.embed_url,
      video_source: streamInfo?.video_source || requestedSource,
    },
    {
      headers: {
        "Cache-Control": (noCache || !!serverKey || provider.name === "anissia" || streamInfo.video_source === 'anikoto' || requestedSource === 'anikoto' || provider.name === 'anikoto')
          ? "no-store"
          : "public, s-maxage=1800, stale-while-revalidate=3600",
      },
    }
  );
}

