import WorkMatchSetting from "@/components/WorkMatchSetting";
import Navbar from "@/components/Navbar";
import FavoriteButton from "@/components/FavoriteButton";
import EpisodeListSection from "@/components/EpisodeListSection";
import SubtitleEpisodeStartSetting from "@/components/SubtitleEpisodeStartSetting";
import SubtitleBundleAssignmentSetting from "@/components/SubtitleBundleAssignmentSetting";
import ReanimeDetailFallback from "@/components/ReanimeDetailFallback";
import { getProviderByAnimeId } from "@/lib/providers";
import { requireAuth, getCurrentUserId } from "@/lib/auth";
import { getAnimeHistoryMap, getSubtitleEpisodeStart } from "@/lib/db";
import Link from "next/link";
import LocalizedAnimeTitle from "@/components/LocalizedAnimeTitle";
import { notFound } from "next/navigation";
import { Play, Film, Calendar, CheckCircle2 } from "lucide-react";
import {anikotoSeasonHref,filterSeasonEpisodes,getAnikotoSeasons,getPreferredAnikotoSeason,validSeasonOrder} from "@/lib/preferredAnikotoSeason";
import PreferredSeasonButton from "@/components/PreferredSeasonButton";

export default async function AnimeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ dub?: string; season?: string }>;
}) {
  const user = await requireAuth();
  const currentUserId = await getCurrentUserId();

  const { id } = await params;
  const { dub, season: seasonQuery } = await searchParams;
  const isDub = dub === "1";

  const provider = getProviderByAnimeId(id);
  const subtitleEpisodeStart = await getSubtitleEpisodeStart(user.username, id);
  const anime = await provider.getAnimeDetail(id, { subtitleEpisodeStart });
  if (!anime) {
    if (id.startsWith("re_")) {
      return (
        <div className="min-h-screen bg-[#0b0f19]">
          <Navbar />
          <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
            <ReanimeDetailFallback id={id} initialIsDub={isDub} />
            <WorkMatchSetting animeId={id} />
          </main>
        </div>
      );
    }
    notFound();
  }

  const isAnikoto = id.startsWith("ak_");
  const anikotoId = isAnikoto ? id.slice(3) : "";
  const [seasonOptions, savedOrder] = isAnikoto
    ? await Promise.all([getAnikotoSeasons(anikotoId),getPreferredAnikotoSeason(user.username,anikotoId)])
    : [[],null] as const;
  const requestedOrder=seasonQuery && /^\\d{1,3}$/.test(seasonQuery)?Number(seasonQuery):null;
  const effectiveOrder=(validSeasonOrder(requestedOrder)?requestedOrder:null) ?? savedOrder ??
    (seasonOptions.length===1?seasonOptions[0].order:null);
  const currentSeason=seasonOptions.find(row=>row.order===effectiveOrder)||null;
  const subResult=filterSeasonEpisodes(anime.sub_episodes,currentSeason);
  const dubResult=filterSeasonEpisodes(anime.dub_episodes,currentSeason);
  const initialHistoryMap = await getAnimeHistoryMap(currentUserId, anime.id);
  const episodes = isDub ? dubResult.episodes : subResult.episodes;

  return (
    <div className="min-h-screen bg-[#0b0f19]">
      <Navbar />

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Banner Card */}
        <div className="overflow-hidden rounded-3xl border border-purple-500/20 bg-slate-900/60 p-6 backdrop-blur-md sm:p-8">
          <div className="flex flex-col gap-8 md:flex-row">
            {/* Poster */}
            <div className="mx-auto w-48 flex-shrink-0 sm:w-60 md:mx-0">
              <div className="relative aspect-[3/4] overflow-hidden rounded-2xl border border-purple-500/30 shadow-2xl shadow-purple-900/30 bg-slate-950">
                {anime.poster && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={anime.poster}
                    alt={anime.title}
                    className="h-full w-full object-cover"
                  />
                )}
              </div>
            </div>

            {/* Info */}
            <div className="flex flex-1 flex-col justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  {anime.is_finished ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 px-3 py-1 text-xs font-semibold text-emerald-300 border border-emerald-500/30">
                      <CheckCircle2 className="h-3 w-3" /> 완결
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-purple-500/20 px-3 py-1 text-xs font-semibold text-purple-300 border border-purple-500/30">
                      방영중
                    </span>
                  )}
                  {anime.year && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-300">
                      <Calendar className="h-3 w-3" /> {anime.year}
                    </span>
                  )}
                </div>

                <h1 className="mt-3 text-2xl font-black tracking-tight text-white sm:text-3xl lg:text-4xl">
                  <LocalizedAnimeTitle title={anime.title} />
                </h1>

                {anime.genres.length > 0 && (
                  <div className="mt-4 flex flex-wrap gap-1.5">
                    {anime.genres.map((g) => (
                      <span
                        key={g}
                        className="rounded-lg bg-slate-800/80 px-2.5 py-1 text-xs font-medium text-slate-300"
                      >
                        {g}
                      </span>
                    ))}
                  </div>
                )}

                {anime.description && (
                  <p className="mt-5 text-sm leading-relaxed text-slate-300 whitespace-pre-line line-clamp-4">
                    {anime.description}
                  </p>
                )}
              </div>

              {/* Action */}
              <div className="mt-6 flex flex-wrap items-center gap-3">
                {episodes.length > 0 && (
                  <Link
                    href={`/watch/${anime.id}/${episodes[0].number}${isDub ? "?dub=1" : ""}`}
                    className="inline-flex items-center gap-2 rounded-2xl bg-gradient-to-r from-purple-600 to-indigo-600 px-6 py-3 font-bold text-white shadow-xl shadow-purple-600/30 transition hover:scale-105 active:scale-95 text-sm"
                  >
                    <Play className="h-4 w-4 fill-white" />
                    1화 바로 시청
                  </Link>
                )}
                <FavoriteButton
                  animeId={anime.id}
                  animeTitle={anime.title}
                  animePoster={anime.poster}
                />
              </div>
            </div>
          </div>
        </div>

        {seasonOptions.length>1 && <section className="mt-5 rounded-2xl border border-purple-500/25 bg-slate-900/60 p-4">
          <h2 className="font-bold text-white">다른 시즌으로 이동</h2>
          <p className="mt-1 text-xs text-slate-400">확정 연결된 시즌만 표시합니다. 우선 시즌은 계정에 저장되고, 다음에 이 영상을 열 때 적용됩니다.</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {seasonOptions.map(item=>{
              const href=anikotoSeasonHref(anikotoId,item.order);
              if(!href)return null;
              const active=currentSeason?.order===item.order;
              return <div key={item.order} className={`rounded-xl border p-3 ${active?"border-purple-500/50 bg-purple-500/10":"border-white/10 bg-slate-950/50"}`}>
                <p className="font-semibold text-sm text-white">{item.title}</p>
                <p className="mt-1 text-xs text-slate-400">
                  {item.year?item.year+" · ":""}연결 시즌 {item.order}
                  {item.episodeStart && item.episodeEnd? ` · ${item.episodeStart}–${item.episodeEnd}화` : " · 회차 범위 미확정"}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Link href={href} className="rounded-lg bg-slate-700 px-3 py-2 text-xs text-white hover:bg-slate-600">
                    {active?"현재 시즌 보기":"다른 시즌으로 이동"}
                  </Link>
                  <PreferredSeasonButton anikotoId={anikotoId} order={item.order}
                    href={href} currentPreferred={savedOrder===item.order} />
                </div>
              </div>;
            })}
          </div>
          {currentSeason && !subResult.filtered &&
            <p className="mt-3 text-xs text-amber-200">이 시즌의 회차 범위가 확인되지 않았거나 영상 회차와 일치하지 않아 전체 회차를 표시합니다.</p>}
        </section>}

        <WorkMatchSetting animeId={anime.id} />
        <SubtitleEpisodeStartSetting animeId={anime.id} />
        <SubtitleBundleAssignmentSetting animeId={anime.id} animeTitle={anime.title} />

        {/* Episodes Section (50-chunk ranges, sorting, jump search, watched badges) */}
        <EpisodeListSection
          animeId={anime.id}
          subEpisodes={subResult.episodes}
          dubEpisodes={dubResult.episodes}
          initialIsDub={isDub}
          initialHistoryMap={initialHistoryMap}
        />
      </main>
    </div>
  );
}
