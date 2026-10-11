import WorkMatchBadge from "@/components/WorkMatchBadge";
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
import { attachEpisodeCaptions, toSourceEpisode, toLocalEpisode } from "@/lib/episodeMapping";
import { notFound } from "next/navigation";
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
    source_ep?: string;
  }>;
}) {
  const user = await requireAuth();

  const { id, ep } = await params;
  const { dub, creator, sub_url, manual_source, video_source, source_ep } = await searchParams;
  const sourceEpisodeStart = await getSubtitleEpisodeStart(user.username, id);
  const requestedEp = parseInt(ep, 10) || 1;
  const epNum = source_ep === "1" && id.startsWith("ani_")
    ? toLocalEpisode(requestedEp, sourceEpisodeStart) : requestedEp;
  if (epNum === null) notFound();
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
  let anime = await provider.getAnimeDetail(id, { subtitleEpisodeStart: sourceEpisodeStart });

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
            <WorkMatchBadge animeId={id} />
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
            <WorkMatchBadge animeId={id} />
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
          <WorkMatchBadge animeId={id} />
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

  let epList = isDub ? anime.dub_episodes : anime.sub_episodes;
  let matched = epList.find((e) => e.number === epNum);
  const watchUrl = matched?.watch_url || "";

  // A verified video can contain additional episodes absent from the caption
  // catalog. Resolve those numbers before rejecting them; season bounds remain.
  const canResolveExtra = isAnissia && !isDub && (!sourceEpisodeStart || sourceEpisodeStart === 1 || requestedVideoSource) && epNum > 0 && epNum <= 10000;
  if (!watchUrl && !activeManual && !canResolveExtra) {
    return (
      <div className="min-h-screen bg-[#0b0f19] pb-16">
        <Navbar />
        <main className="mx-auto max-w-4xl px-4 py-12">
          <WorkMatchBadge animeId={id} />
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
  const sourceEpisode = toSourceEpisode(epNum, sourceEpisodeStart);
  const initialSubUrl = sub_url || matched?.caption_url || "";
  const subtitleTitle = anime.title;

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
            id,
            sourceEpisodeStart,
            sourceEpisodeStart && sourceEpisodeStart > 1 ? anime.total_episodes : undefined
          )
        : provider.getEpisodeStream(watchUrl),
    (!isDub && initialSubUrl && initialSubUrl.startsWith("http"))
      ? resolveKoreanTitle(anime.title)
          .then((resolved) =>
            fetchCreatorSubtitle(
              initialCreator || "제작자",
              initialSubUrl,
              resolved || subtitleTitle,
              sourceEpisode,
              4000,
              epNum,
              id
            )
          )
          .catch(() => null)
      : Promise.resolve(null),
  ]);

  const streamInfo = activeManual
    ? manualSourceToStream(activeManual)
    : providerStreamInfo;

  if (isAnissia && !activeManual && !isDub && streamInfo?.video_episodes?.length) {
    epList = attachEpisodeCaptions(streamInfo.video_episodes, anime.sub_episodes);
    anime = { ...anime, sub_episodes: epList, total_episodes: epList.length };
    matched = epList.find(e => e.number === epNum);
  }
  const activeVideoSource = streamInfo?.video_source || streamInfo?.server_sources?.[0]?.id || requestedVideoSource || (isAnissia ? "rean" : currentProviderSource);

  if (!streamInfo || (!streamInfo.m3u8_url && !streamInfo.embed_url)) {
    if (isReanime) {
      return (
        <div className="min-h-screen bg-[#0b0f19] pb-16">
          <Navbar />
          <main className="mx-auto max-w-7xl px-4 pt-6 sm:px-6 lg:px-8">
            {!activeManual && <AnissiaVideoSourceSelect animeId={id} episodeNumber={epNum} selectedSource={requestedVideoSource || currentProviderSource} creator={initialCreator} subUrl={initialSubUrl} isDub={isDub} />}
            <WorkMatchBadge animeId={id} />
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
            <WorkMatchBadge animeId={id} />
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
          <WorkMatchBadge animeId={id} />
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

  const isIframe = streamInfo.stream_type === "iframe" || (!streamInfo.m3u8_url && Boolean(streamInfo.embed_url));
  const embedUrl = streamInfo.embed_url || streamInfo.player_url || "";
  const playerRef = streamInfo.player_url || "";
  const rawM3u8 = streamInfo.m3u8_url || "";
  const rawVtt = streamInfo.vtt_url || "";

  const proxiedM3u8 = (!isIframe && rawM3u8)
    ? `/api/anime/stream/m3u8?url=${encodeURIComponent(rawM3u8)}&ref=${encodeURIComponent(playerRef)}`
    : "";
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
            selectedSource={activeVideoSource}
            creator={initialCreator}
            subUrl={initialSubUrl}
            isDub={isDub}
          />
        )}
        <WorkMatchBadge animeId={id} />
        <ManualSourcePanel
          animeId={id}
          episodeNumber={epNum}
          activeSourceId={activeManual?.id || null}
        />

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
          serverSources={streamInfo.server_sources}
          videoSource={activeManual ? undefined : activeVideoSource}
          initialSubtitle={preloadedSub}
          initialCreator={initialCreator}
          initialSubUrl={initialSubUrl}
        />
      </main>
    </div>
  );
}

