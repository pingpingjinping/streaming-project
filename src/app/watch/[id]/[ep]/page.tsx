import Navbar from "@/components/Navbar";
import Player from "@/components/Player";
import ReanimeWatchFallback from "@/components/ReanimeWatchFallback";
import AnissiaStreamFallback from "@/components/AnissiaStreamFallback";
import ManualSourcePanel from "@/components/ManualSourcePanel";
import AnissiaVideoSourceSelect from "@/components/AnissiaVideoSourceSelect";
import { getProviderByAnimeId } from "@/lib/providers";
import type { EpisodeStreamInfo } from "@/lib/providers/types";
import { fetchCreatorSubtitle, resolveKoreanTitle } from "@/lib/subtitles";
import { resolveAnissiaStream } from "@/lib/resolvers/videoResolver";
import { getManualStreamSourceById, getSubtitleEpisodeStart } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { resolveFlixCloudDirect } from "@/lib/flixCloudDirect";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

function manualSourceToStream(source: {
  label: string;
  url: string;
  source_type: "iframe" | "m3u8";
}): EpisodeStreamInfo {
  let ref = source.url;
  try {
    ref = new URL(source.url).origin + "/";
  } catch {}

  if (source.source_type === "m3u8") {
    return {
      success: true,
      m3u8_url: source.url,
      vtt_url: "",
      player_url: ref,
      stream_type: "m3u8",
      server_sources: [{ label: `직접: ${source.label}`, player_url: source.url }],
      link_next: "",
      link_pre: "",
    };
  }

  return {
    success: true,
    m3u8_url: "",
    vtt_url: "",
    player_url: source.url,
    embed_url: source.url,
    stream_type: "iframe",
    server_sources: [{ label: `직접: ${source.label}`, player_url: source.url }],
    link_next: "",
    link_pre: "",
  };
}

export default async function WatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; ep: string }>;
  searchParams: Promise<{
    dub?: string;
    creator?: string;
    sub_url?: string;
    manual_source?: string;
    video_source?: string;
    flix_direct?: string;
  }>;
}) {
  const user = await requireAuth();

  const { id, ep } = await params;
  const { dub, creator, sub_url, manual_source, video_source, flix_direct } = await searchParams;
  const epNum = parseInt(ep, 10) || 1;
  const isDub = dub === "1";
  const isReanime = id.startsWith("re_");
  const isAnissia = id.startsWith("ani_");
  const isAnikoto = id.startsWith("ak_");
  const currentProviderSource = isReanime
    ? "rean"
    : isAnikoto
    ? "anikoto"
    : id.startsWith("ol_")
    ? "ohli24"
    : "linkkf";
  const requestedVideoSource = ["rean", "anikoto", "linkkf", "ohli24"].includes(video_source || "")
    ? video_source as "rean" | "anikoto" | "linkkf" | "ohli24"
    : undefined;

  const manualSourceId = parseInt(manual_source || "0", 10);
  const manualCandidate =
    Number.isInteger(manualSourceId) && manualSourceId > 0
      ? await getManualStreamSourceById(user.username, manualSourceId)
      : null;
  const activeManual =
    manualCandidate &&
    manualCandidate.anime_id === id &&
    manualCandidate.episode_number === epNum
      ? manualCandidate
      : null;

  const provider = getProviderByAnimeId(id);
  const anime = await provider.getAnimeDetail(id);

  // Provider 자체가 죽어 작품 상세를 못 읽어도 직접 링크는 사용할 수 있게 한다.
  if (!anime) {
    if (activeManual) {
      const streamInfo = manualSourceToStream(activeManual);
      const isIframe = streamInfo.stream_type === "iframe";
      const rawM3u8 = streamInfo.m3u8_url || "";
      const playerRef = streamInfo.player_url || "";
      const proxiedM3u8 = rawM3u8
        ? `/api/anime/stream/m3u8?url=${encodeURIComponent(rawM3u8)}&ref=${encodeURIComponent(playerRef)}`
        : "";

      return (
        <div className="min-h-screen bg-[#0b0f19] pb-16">
          <Navbar />
          <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
            <ManualSourcePanel
              animeId={id}
              episodeNumber={epNum}
              activeSourceId={activeManual.id}
            />
            <Player
              animeId={id}
              animeTitle={id}
              episodeNumber={epNum}
              initialEpTitle={`${epNum}화`}
              m3u8Url={proxiedM3u8}
              defaultVttUrl=""
              isDub={isDub}
              subEpisodes={[]}
              dubEpisodes={[]}
              streamType={isIframe ? "iframe" : "m3u8"}
              embedUrl={streamInfo.embed_url || ""}
              serverSources={streamInfo.server_sources}
            />
          </main>
        </div>
      );
    }

    if (isReanime) {
      return (
        <div className="min-h-screen bg-[#0b0f19] pb-16">
          <Navbar />
          <main className="mx-auto max-w-7xl px-4 pt-6 sm:px-6 lg:px-8">
            <ManualSourcePanel animeId={id} episodeNumber={epNum} />
          </main>
          <ReanimeWatchFallback id={id} ep={epNum} isDub={isDub} />
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-[#0b0f19] pb-16">
        <Navbar />
        <main className="mx-auto max-w-4xl px-4 py-12">
          <ManualSourcePanel animeId={id} episodeNumber={epNum} />
          <div className="rounded-3xl border border-amber-500/20 bg-slate-900/60 p-8 text-center">
            <h2 className="text-xl font-bold text-amber-300">기본 스트리밍 사이트에 연결할 수 없습니다.</h2>
            <p className="mt-2 text-sm text-slate-400">
              위의 직접 스트림 링크에 다른 사이트의 embed/player 주소 또는 m3u8 주소를 추가해 재생할 수 있습니다.
            </p>
          </div>
        </main>
      </div>
    );
  }

  const epList = isDub ? anime.dub_episodes : anime.sub_episodes;
  const matched = epList.find((e) => e.number === epNum) || epList[0];
  const watchUrl = matched?.watch_url || "";

  if (!watchUrl && !activeManual) {
    return (
      <div className="min-h-screen bg-[#0b0f19] pb-16">
        <Navbar />
        <main className="mx-auto max-w-4xl px-4 py-12">
          <ManualSourcePanel animeId={id} episodeNumber={epNum} />
          <div className="rounded-3xl border border-red-500/20 bg-slate-900/60 p-8 text-center">
            <h2 className="text-xl font-bold text-red-400">회차 스트림 주소를 찾지 못했습니다.</h2>
            <p className="mt-2 text-sm text-slate-400">
              직접 스트림 링크를 추가하거나 작품 회차 목록으로 돌아가 주세요.
            </p>
          </div>
        </main>
      </div>
    );
  }

  const initialCreator = creator || matched?.creator_name || "";
  const sourceEpisodeStart = await getSubtitleEpisodeStart(user.username, anime.id);
  const sourceEpisode = sourceEpisodeStart && sourceEpisodeStart > 0 ? sourceEpisodeStart + epNum - 1 : epNum;
  const initialSubUrl = sub_url || matched?.caption_url || "";

  const [providerStreamInfo, preloadedSub] = await Promise.all([
    activeManual
      ? Promise.resolve(null)
      : isAnissia || (requestedVideoSource && requestedVideoSource !== currentProviderSource)
        ? resolveAnissiaStream(
            isAnissia ? Number(id.replace(/^ani_/, "")) : null,
            epNum,
            anime.title,
            anime.original_title,
            requestedVideoSource,
            id
          )
        : provider.getEpisodeStream(watchUrl),
    (!isDub && initialSubUrl && initialSubUrl.startsWith("http"))
      ? resolveKoreanTitle(anime.title)
          .then((resolved) =>
            fetchCreatorSubtitle(
              initialCreator || "제작자",
              initialSubUrl,
              resolved || anime.title,
              sourceEpisode,
              4000,
              epNum
            )
          )
          .catch(() => null)
      : Promise.resolve(null),
  ]);

  const streamInfo = activeManual
    ? manualSourceToStream(activeManual)
    : providerStreamInfo;

  if (!streamInfo || (!streamInfo.m3u8_url && !streamInfo.embed_url)) {
    if (isReanime) {
      return (
        <div className="min-h-screen bg-[#0b0f19] pb-16">
          <Navbar />
          <main className="mx-auto max-w-7xl px-4 pt-6 sm:px-6 lg:px-8">
            {!activeManual && <AnissiaVideoSourceSelect animeId={id} episodeNumber={epNum} selectedSource={requestedVideoSource || currentProviderSource} creator={initialCreator} subUrl={initialSubUrl} isDub={isDub} />}
            <ManualSourcePanel animeId={id} episodeNumber={epNum} />
          </main>
          <ReanimeWatchFallback id={id} ep={epNum} isDub={isDub} />
        </div>
      );
    }
    if (isAnissia) {
      return (
        <div className="min-h-screen bg-[#0b0f19] pb-16">
          <Navbar />
          <main className="mx-auto max-w-7xl px-4 pt-6 sm:px-6 lg:px-8">
            {!activeManual && <AnissiaVideoSourceSelect animeId={id} episodeNumber={epNum} selectedSource={requestedVideoSource || "rean"} creator={initialCreator} subUrl={initialSubUrl} isDub={isDub} />}
            <ManualSourcePanel animeId={id} episodeNumber={epNum} />
          </main>
          <AnissiaStreamFallback
            animeId={id}
            animeTitle={anime.title}
            animePoster={anime.poster}
            episodeNumber={epNum}
            episodeTitle={matched?.title || `${epNum}화`}
            initialCreator={initialCreator}
            initialSubUrl={initialSubUrl}
            preloadedSub={preloadedSub}
            maxAvailableEp={streamInfo?.max_available_ep}
            unsupportedReason={streamInfo?.unsupported_reason}
            totalEpisodes={anime.total_episodes}
            selectedVideoSource={requestedVideoSource || "rean"}
          />
        </div>
      );
    }
    return (
      <div className="min-h-screen bg-[#0b0f19]">
        <Navbar />
        <main className="mx-auto max-w-4xl px-4 py-12">
          {!activeManual && <AnissiaVideoSourceSelect animeId={id} episodeNumber={epNum} selectedSource={requestedVideoSource || currentProviderSource} creator={initialCreator} subUrl={initialSubUrl} isDub={isDub} />}
          <ManualSourcePanel animeId={id} episodeNumber={epNum} />
          <div className="rounded-3xl border border-red-500/20 bg-slate-900/60 p-8 text-center">
            <h2 className="text-xl font-bold text-red-400">스트림 주소를 불러오지 못했습니다.</h2>
            <p className="mt-2 text-sm text-slate-400">
              기본 소스 대신 위에서 다른 사이트의 직접 링크를 추가할 수 있습니다.
            </p>
            <Link
              href={`/anime/${id}`}
              className="mt-6 inline-flex items-center gap-2 rounded-xl bg-purple-600 px-5 py-2.5 text-sm font-semibold text-white"
            >
              <ArrowLeft className="h-4 w-4" /> 작품 회차 목록으로 돌아가기
            </Link>
          </div>
        </main>
      </div>
    );
  }

  const originalEmbedUrl = streamInfo.embed_url || streamInfo.player_url || "";
  const canTestFlixDirect = /(^|\.)flixcloud\.cc$/i.test(
    (() => {
      try {
        return new URL(originalEmbedUrl).hostname;
      } catch {
        return "";
      }
    })()
  );
  const flixDirectRequested = flix_direct === "1" && canTestFlixDirect;
  const flixDirect = flixDirectRequested
    ? await resolveFlixCloudDirect(originalEmbedUrl)
    : null;

  const effectiveStreamInfo = flixDirect
    ? {
        ...streamInfo,
        m3u8_url: flixDirect.url,
        embed_url: "",
        player_url: originalEmbedUrl,
        stream_type: "m3u8" as const,
        vtt_url: "",
      }
    : streamInfo;

  const isIframe =
    effectiveStreamInfo.stream_type === "iframe" ||
    (!effectiveStreamInfo.m3u8_url && Boolean(effectiveStreamInfo.embed_url));
  const embedUrl = effectiveStreamInfo.embed_url || effectiveStreamInfo.player_url || "";
  const playerRef = effectiveStreamInfo.player_url || "";
  const rawM3u8 = effectiveStreamInfo.m3u8_url || "";
  const rawVtt = effectiveStreamInfo.vtt_url || "";

  const proxiedM3u8 = flixDirect
    ? `/api/anime/stream/flixcloud/m3u8?url=${encodeURIComponent(flixDirect.url)}&key=${encodeURIComponent(flixDirect.playlistKey)}`
    : (!isIframe && rawM3u8)
      ? `/api/anime/stream/m3u8?url=${encodeURIComponent(rawM3u8)}&ref=${encodeURIComponent(playerRef)}`
      : "";

  const buildFlixTestHref = (enabled: boolean) => {
    const query = new URLSearchParams();
    if (dub) query.set("dub", dub);
    if (creator) query.set("creator", creator);
    if (sub_url) query.set("sub_url", sub_url);
    if (manual_source) query.set("manual_source", manual_source);
    if (video_source) query.set("video_source", video_source);
    if (enabled) query.set("flix_direct", "1");
    const suffix = query.toString();
    return `/watch/${id}/${epNum}${suffix ? `?${suffix}` : ""}`;
  };
  const proxiedVtt = rawVtt ? `/api/anime/stream/vtt?url=${encodeURIComponent(rawVtt)}` : "";

  let linkPreEpNum: number | null = null;
  let linkNextEpNum: number | null = null;
  let epTitle = `${epNum}화`;

  for (let idx = 0; idx < epList.length; idx++) {
    const e = epList[idx];
    if (e.number === epNum) {
      epTitle = e.title;
      if (idx > 0) {
        linkPreEpNum = epList[idx - 1].number;
      }
      if (idx + 1 < epList.length) {
        linkNextEpNum = epList[idx + 1].number;
      }
      break;
    }
  }

  return (
    <div className="min-h-screen bg-[#0b0f19] pb-16">
      <Navbar />

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        {!activeManual && (
          <AnissiaVideoSourceSelect
            animeId={id}
            episodeNumber={epNum}
            selectedSource={
              isAnissia
                ? providerStreamInfo?.server_sources?.[0]?.id || requestedVideoSource || "rean"
                : requestedVideoSource || currentProviderSource
            }
            creator={initialCreator}
            subUrl={initialSubUrl}
            isDub={isDub}
          />
        )}
        <ManualSourcePanel
          animeId={id}
          episodeNumber={epNum}
          activeSourceId={activeManual?.id || null}
        />

        {canTestFlixDirect && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-sky-500/20 bg-sky-500/5 px-3 py-2.5 text-xs">
            <span className={flixDirect ? "text-emerald-300" : flixDirectRequested ? "text-amber-300" : "text-slate-300"}>
              {flixDirect
                ? "FlixCloud 직접재생 테스트 중 · 외부 영어 CC 트랙 제외"
                : flixDirectRequested
                  ? "직접재생 변환 실패 · 기존 iframe으로 자동 폴백"
                  : "FlixCloud 영어 CC OFF 직접재생 테스트"}
            </span>
            <Link
              href={buildFlixTestHref(!flixDirectRequested)}
              className="rounded-lg border border-sky-400/30 bg-slate-900/80 px-3 py-1.5 font-semibold text-sky-200 transition hover:border-sky-300 hover:text-white"
            >
              {flixDirectRequested ? "테스트 끄기" : "테스트 켜기"}
            </Link>
          </div>
        )}

        <Player
          animeId={id}
          animeTitle={anime.title}
          animePoster={anime.poster}
          episodeNumber={epNum}
          initialEpTitle={epTitle}
          m3u8Url={proxiedM3u8}
          defaultVttUrl={proxiedVtt}
          linkPreEp={linkPreEpNum}
          linkNextEp={linkNextEpNum}
          isDub={isDub}
          subEpisodes={anime.sub_episodes}
          dubEpisodes={anime.dub_episodes}
          streamType={isIframe ? "iframe" : "m3u8"}
          embedUrl={embedUrl}
          serverSources={effectiveStreamInfo.server_sources}
          initialSubtitle={preloadedSub}
          initialCreator={initialCreator}
          initialSubUrl={initialSubUrl}
        />
      </main>
    </div>
  );
}
