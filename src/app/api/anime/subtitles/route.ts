import { toSourceEpisode } from "@/lib/episodeMapping";
import { NextRequest, NextResponse } from "next/server";
import {
  searchAllSubtitlesParallel,
  findKairanSubtitle,
  fetchCreatorSubtitle,
  mapProviderEpisodeNumber,
  parseSeason,
  resolveKoreanTitle,
} from "@/lib/subtitles";
import { assertSafeProxyUrl, UnsafeProxyUrlError } from "@/lib/proxyGuard";
import { getSessionUser } from "@/lib/auth";
import {
  getAniAllMatches,
  getManualSubtitleLink,
  getSubtitleSourcePriority,
  getSubtitleEpisodeStart,
  getSubtitleRejections,
  getSubtitleBundleAssignment,
  getSubtitleBundleAssignments,
  saveSubtitleBundleAssignment,
  getSubtitleCreatorPreference,
  saveSubtitleCreatorPreference,
  getSubtitleEpisodeOverrides,
  type SubtitleCreatorPreference,
} from "@/lib/db";
import { getAniAllArchiveSubtitle, getAnissiaArchiveSubtitles, getUploadedSubtitles, getVerifiedSubtitleCache, getAniAllArchiveSubtitles } from "@/lib/subtitleStorage";
import { getReviewedSubtitles } from "@/lib/reviewedSubtitleStorage";
import { getReanimeMatch } from "@/lib/reanimeMatches";
import { bundleScopeKey, bundleMatchesAssignment, parseBundleScope, bundleScopesOverlap, refineLocalBundleAssignment } from "@/lib/subtitleLocalIdentity";
import {resolveSubtitleOverride, distinctLocalSubtitles} from "@/lib/subtitleOverrides";
import { pruneVerifiedSubtitleCache } from "@/lib/subtitleCache";

async function pruneLocalCache(animeId: string, episode: number, subtitles: Array<{content: string; format: string}>) {
  if (!animeId || !subtitles.length) return;
  try { await pruneVerifiedSubtitleCache(animeId, episode, subtitles
    .filter(s => s.format === "ASS" || s.format === "VTT")
    .map(s => ({content: s.content, format: s.format as "ASS" | "VTT"}))); }
  catch (error) { console.warn("[Subtitle cache cleanup deferred]", error); }
}

async function fetchPreferredBlogSubtitle(
  preference: SubtitleCreatorPreference,
  fallbackTitle: string,
  episode: number,
  sourceEpisodeStart: number | null,
  animeId: string,
) {
  if (!preference.website.startsWith("http")) return null;
  await assertSafeProxyUrl(preference.website);

  const requestedTitle = preference.matchedTitle || fallbackTitle;
  const resolvedTitle = await resolveKoreanTitle(requestedTitle);
  const targetTitle = resolvedTitle || requestedTitle;
  const targetSeason = parseSeason(targetTitle) || parseSeason(requestedTitle);
  const sourceEpisode = sourceEpisodeStart && sourceEpisodeStart > 0
    ? toSourceEpisode(episode, sourceEpisodeStart)
    : mapProviderEpisodeNumber(preference.creatorEpisode, episode, targetSeason);

  let subtitle = null;
  if (preference.creatorName.includes("카이란") || preference.website.toLowerCase().includes("kairan")) {
    subtitle = await findKairanSubtitle(targetTitle, sourceEpisode, 5000, episode);
  } else {
    subtitle = await fetchCreatorSubtitle(
      preference.creatorName,
      preference.website,
      targetTitle,
      sourceEpisode,
      5000,
      episode,
      animeId,
    );
  }

  if (!subtitle?.content) return null;
  const lower = subtitle.content.slice(0, 300).toLowerCase();
  if (lower.includes("<!doctype html") || lower.includes("<html") || lower.includes("<head>")) return null;

  return {
    ...subtitle,
    sourceCreatorWebsite: preference.website,
    sourceMatchedTitle: preference.matchedTitle || requestedTitle,
    sourceProvider: preference.sourceProvider,
    localArchive: false,
  };
}

function creatorBlogKey(website: string): string {
  try {
    const url = new URL(website);
    const host = url.hostname.toLowerCase();
    if (host.endsWith(".tistory.com") || host.endsWith(".blogspot.com")) return host;
    if (host === "blog.naver.com" || host === "m.blog.naver.com") {
      const id = url.searchParams.get("blogId") || url.pathname.split("/")[1];
      return id && !id.endsWith(".naver") ? `naver:${id}` : "";
    }
    return url.toString();
  } catch { return ""; }
}

async function fetchPreferredLocalSubtitles(
  preference: SubtitleCreatorPreference,
  titles: string[], episode: number,
  sourceEpisodeStart: number | null, animeNo: number | null,
) {
  const requestedTitle = preference.matchedTitle || titles[0];
  const matchedTitle = await resolveKoreanTitle(requestedTitle) || requestedTitle;
  const season = parseSeason(matchedTitle) || parseSeason(requestedTitle);
  const sourceEpisode = sourceEpisodeStart && sourceEpisodeStart > 0
    ? toSourceEpisode(episode, sourceEpisodeStart)
    : mapProviderEpisodeNumber(preference.creatorEpisode, episode, season);
  if (preference.sourceProvider === "aniall") {
    const blogTitle = preference.creatorName.replace(/^AniAll\s*[·|]\s*/i, "").trim();
    const subtitles = await getAniAllArchiveSubtitles(blogTitle, episode, season,
      sourceEpisodeStart, preference.website);
    return subtitles.filter(s => s.episodeConfirmed).map(s => ({...s,
      sourceProvider: "aniall", sourceCreatorWebsite: preference.website,
      sourceMatchedTitle: matchedTitle, localArchive: true}));
  }
  const creator = preference.creatorName.replace(/^Anissia\s*[·|]\s*/i, "").trim();
  const key = creatorBlogKey(preference.website);
  const subtitles = await getAnissiaArchiveSubtitles([matchedTitle, requestedTitle, ...titles], sourceEpisode, animeNo, season,
    {localEpisode: episode});
  return subtitles.filter(s => s.episodeConfirmed && key && creatorBlogKey(s.website) === key
    && s.creator.trim().toLocaleLowerCase("ko-KR") === creator.toLocaleLowerCase("ko-KR"))
    .map(s => ({...s, sourceProvider: "anissia", sourceCreatorWebsite: s.website,
      sourceMatchedTitle: s.matchedTitle, localArchive: true}));
}

export async function GET(request: NextRequest) {
  // 보안: 미인증 사용자가 서버를 오픈 크롤링/퍼치 서비스로 악용하는 것을 방지
  const user = await getSessionUser();
  if (!user) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const title = searchParams.get("title")?.trim();
  const referenceTitle = searchParams.get("referenceTitle")?.trim();
  const onlineSearch = searchParams.get("mode") === "online";
  const ep = parseInt(searchParams.get("ep") || "1", 10) || 1;
  const animeIdParam = searchParams.get("animeId") || searchParams.get("animeNo") || "";
  const requestedAnissiaTrackKey = (searchParams.get("anissiaTrack") || "").slice(0, 1000);
  let directAnimeNo: number | null = null;
  if (/^(ani_)?\d+$/.test(animeIdParam)) {
    const parsed = Number(animeIdParam.replace(/^ani_/, ""));
    if (Number.isSafeInteger(parsed) && parsed > 0) directAnimeNo = parsed;
  }
  const reanimeMatch = animeIdParam.startsWith("re_")
    ? await getReanimeMatch(animeIdParam) : null;
  if (reanimeMatch?.anissiaNo) directAnimeNo = reanimeMatch.anissiaNo;

  const sourceEpisodeStart = animeIdParam
    ? await getSubtitleEpisodeStart(user.username, animeIdParam)
    : null;
  const sourceEpisode = sourceEpisodeStart && sourceEpisodeStart > 0
    ? toSourceEpisode(ep, sourceEpisodeStart)
    : ep;
  const website = searchParams.get("website")?.trim() || searchParams.get("sub_url")?.trim() || "";
  const creatorName = searchParams.get("creatorName")?.trim() || searchParams.get("creator")?.trim() || "";
  const [rejections, bundleAssignment, bundleAssignments, creatorPreference, episodeOverrides] = animeIdParam
    ? await Promise.all([
        getSubtitleRejections(animeIdParam),
        getSubtitleBundleAssignment(user.username, animeIdParam),
        getSubtitleBundleAssignments(user.username),
        getSubtitleCreatorPreference(user.username, animeIdParam),
        getSubtitleEpisodeOverrides(user.username,animeIdParam),
      ])
    : [[], null, [], null, []];
  const isRejected = (provider: string, sourceKey: string) =>
    rejections.some((entry) => entry.provider === provider && entry.sourceKey === sourceKey);
  const claimedByOtherAnime = (provider: string, bundleKey?: string) =>
    Boolean(bundleKey && bundleAssignments.some((entry) =>
      entry.exclusive && entry.provider === provider && bundleScopesOverlap(entry.bundleKey,bundleKey!)
        && entry.animeId !== animeIdParam));

  if (!title) {
    return NextResponse.json(
      { success: false, message: "Missing anime title parameter" },
      { status: 400 }
    );
  }

  try {
    if (onlineSearch) {
      // Manual online search must honor the typed keyword and show all
      // discovered creators, even when a local or verified subtitle exists.
      const query = await resolveKoreanTitle(title);
      const result = await searchAllSubtitlesParallel(query || title, ep, 45000, null,
        query || title, animeIdParam, null, false, true);
      return NextResponse.json({
        success: true, anime_title: title, episode: ep,
        count: result.subtitles.length, subtitles: result.subtitles,
        creators: result.creators,
      }, { headers: { "Cache-Control": "no-store" } });
    }
    const exception=episodeOverrides.find(item=>item.episodeNumber===ep);
    if(exception) {
      const subtitle=await resolveSubtitleOverride(exception.provider,exception.fileId);
      if(!subtitle) return NextResponse.json({success:true,episode:ep,count:0,subtitles:[],creators:[],
        needs_manual_subtitle_choice:true,assignment_missing:true,subtitle_notice:'예외로 지정한 자막이 없거나 변경되었습니다. 예외를 해제하거나 다시 선택해 주세요.'},
        {headers:{'Cache-Control':'no-store'}});
      await pruneLocalCache(animeIdParam,ep,[subtitle]);
      return NextResponse.json({success:true,episode:ep,count:1,subtitles:[{...subtitle,episodeException:true}],creators:[],
        local_archive:true,episode_exception:exception,needs_manual_subtitle_choice:false},{headers:{'Cache-Control':'no-store'}});
    }
    const uploaded = animeIdParam
      ? (await getUploadedSubtitles(user.username, animeIdParam, ep))
        .filter((subtitle) => !isRejected("local", subtitle.name))
      : [];
    if (uploaded.length) {
      await pruneLocalCache(animeIdParam, ep, uploaded);
      return NextResponse.json({ success: true, anime_title: title, episode: ep, count: uploaded.length,
        subtitles: uploaded, creators: [] }, { headers: { "Cache-Control": "no-store" } });
    }
    const resolvedTitle = await resolveKoreanTitle(title);
    const searchTarget = reanimeMatch?.koreanTitle || resolvedTitle || title;
    const comparisonTitle = reanimeMatch?.koreanTitle ||
      (referenceTitle ? await resolveKoreanTitle(referenceTitle) || referenceTitle : searchTarget);

    const sourcePriority = await getSubtitleSourcePriority();

    if (creatorPreference && !bundleAssignment &&
        !isRejected(creatorPreference.sourceProvider, creatorPreference.website)) {
      // Remember the creator without forcing a fresh web extraction. Keep all
      // candidates in the requested work/episode and creator scope.
      try {
        const local = distinctLocalSubtitles((await fetchPreferredLocalSubtitles(
          creatorPreference, [searchTarget, comparisonTitle, title, referenceTitle || ""],
          ep, sourceEpisodeStart, directAnimeNo,
        )).filter(s => !claimedByOtherAnime(creatorPreference.sourceProvider, s.sourceBundleKey)
          && !isRejected("local", s.name)
          && !isRejected(creatorPreference.sourceProvider, s.name)
          && !(s.sourceProvider === "anissia" && "creator" in s && isRejected("anissia",
            `[로컬 Anissia · ${s.creator}] ${s.localArchiveTrackLabel} · ${s.archiveFilename} · ${s.orig_filename}`))
          && !isRejected(creatorPreference.sourceProvider, s.sourceCreatorWebsite)));
        if (local.length) {
          await pruneLocalCache(animeIdParam, ep, local);
          return NextResponse.json({success: true, anime_title: title, episode: ep,
            count: local.length, subtitles: local, creators: [], local_archive: true,
            preferred_creator: true, needs_manual_subtitle_choice: local.length > 1},
            {headers: {"Cache-Control": "no-store"}});
        }
      } catch (error) {
        console.warn("[Preferred local subtitle unavailable]", error);
      }
      if (!sourceEpisodeStart) {
        try {
          const cached = await getVerifiedSubtitleCache(animeIdParam, ep, {
            sourceProvider: creatorPreference.sourceProvider,
            sourceUrl: creatorPreference.website,
            matchedTitle: creatorPreference.matchedTitle || searchTarget,
          });
          if (cached && !isRejected("local", cached.name)) {
            return NextResponse.json({success: true, anime_title: title, episode: ep,
              count: 1, subtitles: [cached], creators: [], verified_cache: true,
              preferred_creator: true, needs_manual_subtitle_choice: false},
              {headers: {"Cache-Control": "no-store"}});
          }
        } catch (error) {
          console.warn("[Preferred subtitle cache unavailable]", error);
        }
      }
      let preferredSubtitle = null;
      try {
        preferredSubtitle = await fetchPreferredBlogSubtitle(
          creatorPreference,
          searchTarget,
          ep,
          sourceEpisodeStart,
          animeIdParam,
        );
      } catch (error) {
        console.warn("[Preferred subtitle creator unavailable]", {
          animeId: animeIdParam,
          episode: ep,
          creator: creatorPreference.creatorName,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      const preferredCreator = {
        name: creatorPreference.creatorName,
        episode: creatorPreference.creatorEpisode || String(sourceEpisode),
        update_date: "",
        website: creatorPreference.website,
        is_current_ep: Boolean(preferredSubtitle),
        matchedTitle: creatorPreference.matchedTitle || searchTarget,
        verifiedMatch: true,
        sourceProvider: creatorPreference.sourceProvider,
        localArchive: false,
      };
      if (preferredSubtitle) {
        return NextResponse.json({
          success: true,
          anime_title: title,
          resolved_title: resolvedTitle,
          episode: ep,
          count: 1,
          subtitles: [preferredSubtitle],
          creators: [preferredCreator],
          preferred_creator: true,
          needs_manual_subtitle_choice: false,
        }, { headers: { "Cache-Control": "no-store" } });
      }

      // Do not silently jump to a different DB/blog after an explicit creator
      // choice. Only reopen the picker when that creator genuinely has no
      // usable subtitle for this episode.
      return NextResponse.json({
        success: true,
        anime_title: title,
        resolved_title: resolvedTitle,
        episode: ep,
        count: 0,
        subtitles: [],
        creators: [preferredCreator],
        preferred_creator: true,
        preferred_creator_missing: true,
        needs_manual_subtitle_choice: true,
        subtitle_notice: `선택한 제작자 '${creatorPreference.creatorName}'의 ${ep}화 자막을 찾지 못했어요. 다른 자막을 선택해 주세요.`,
      }, { headers: { "Cache-Control": "no-store" } });
    }

    const localResponse = async (subtitles: Array<any>, creators: Array<any> = []) => {
      let distinct=distinctLocalSubtitles(subtitles);
      if(!distinct.length) return null;
      let effectiveAssignment=bundleAssignment;
      const confirmed=distinct.filter(s=>s.episodeConfirmed && s.sourceBundleKey && s.sourceProvider);
      if(confirmed.length) {
        // Stable ordering chooses one valid release, then the saved track scopes subsequent episodes.
        const chosen=[...confirmed].sort((a,b)=>a.sourceBundleKey<b.sourceBundleKey?-1:a.sourceBundleKey>b.sourceBundleKey?1:
          String(a.reviewedFileId || a.localFileId || a.orig_filename).localeCompare(String(b.reviewedFileId || b.localFileId || b.orig_filename),'en'))[0];
        const scope=bundleAssignment ? parseBundleScope(bundleAssignment.bundleKey) : null;
        const fileScope=parseBundleScope(chosen.sourceBundleKey);
        let selectedKey=chosen.sourceBundleKey;
        if(scope?.type==='folder' && fileScope?.type==='local')selectedKey=bundleScopeKey({...scope,track:fileScope.track});
        else if(bundleAssignment && scope?.type!=='reviewed')selectedKey=refineLocalBundleAssignment(bundleAssignment.bundleKey,chosen.sourceBundleKey) || bundleAssignment.bundleKey;
        // Equal bytes with several provenances cannot refine a legacy creator/source preference.
        const canRemember=confirmed.length>1 || new Set(subtitles.map(s=>s.sourceBundleKey)).size===1;
        if(animeIdParam && canRemember && selectedKey!==bundleAssignment?.bundleKey) {
          try {
            const saved=await saveSubtitleBundleAssignment(user.username,animeIdParam,chosen.sourceProvider,selectedKey,
              (bundleAssignment?.label || chosen.sourceBundleLabel || chosen.matchedTitle || title).slice(0,1000),bundleAssignment?.bundleKey || '',true);
            if(saved) effectiveAssignment={animeId:animeIdParam,provider:chosen.sourceProvider,bundleKey:selectedKey,
              label:bundleAssignment?.label || chosen.sourceBundleLabel || title,exclusive:true};
            else {
              const current=await getSubtitleBundleAssignment(user.username,animeIdParam);
              const others=await getSubtitleBundleAssignments(user.username);
              const preference=await getSubtitleCreatorPreference(user.username,animeIdParam);
              const claimed=others.some(entry=>entry.animeId!==animeIdParam && entry.provider===chosen.sourceProvider
                && entry.exclusive && bundleScopesOverlap(entry.bundleKey,selectedKey));
              if(current && current.provider===chosen.sourceProvider && bundleMatchesAssignment(current.bundleKey,chosen.sourceBundleKey))effectiveAssignment=current;
              else if(claimed || preference || current?.bundleKey!==bundleAssignment?.bundleKey || current?.provider!==bundleAssignment?.provider)
                return NextResponse.json({success:true,anime_title:title,episode:ep,count:0,subtitles:[],creators:[],
                  bundle_assignment:current,needs_manual_subtitle_choice:true,subtitle_notice:'자막 선택이 변경됐어요. 다시 불러와 주세요.'},
                  {headers:{'Cache-Control':'no-store'}});
            }
          }catch(error){console.warn('[Local subtitle choice save deferred]',error);}
        }
        distinct=[{...chosen,bundleAssigned:Boolean(effectiveAssignment && bundleMatchesAssignment(effectiveAssignment.bundleKey,chosen.sourceBundleKey))}];
      }
      await pruneLocalCache(animeIdParam,ep,distinct.filter(s=>s.episodeConfirmed));
      return NextResponse.json({success:true,anime_title:title,resolved_title:resolvedTitle,episode:ep,count:distinct.length,
        subtitles:distinct,creators,local_archive:true,bundle_assignment:effectiveAssignment,
        needs_manual_subtitle_choice:distinct.length>1 || distinct.some(s=>!s.episodeConfirmed)}, {headers:{'Cache-Control':'no-store'}});
    };
    const findReviewedLocal = async (source: "aniall" | "naver" | "anissia", includeUnknown = true) => {
      if (bundleAssignment && bundleAssignment.provider !== source) return null;
      const reviewed = await getReviewedSubtitles({ animeId: animeIdParam, episode: ep, sourceEpisode,
        season: parseSeason(comparisonTitle) || parseSeason(searchTarget), source, automaticSelection:true,
        bundleKey: bundleAssignment?.provider === source ? bundleAssignment.bundleKey : undefined,
        isRejected: (provider, key) => isRejected(provider, key)
          || (provider === "aniall" && rejections.some(r => r.provider === "aniall" && !r.sourceKey.startsWith("reviewed:"))) });
      const subtitles = distinctLocalSubtitles(reviewed.subtitles
        .filter(s => !claimedByOtherAnime(source, s.sourceBundleKey))
        .filter(s => !bundleAssignment || bundleAssignment.provider !== source
          || bundleMatchesAssignment(bundleAssignment.bundleKey,s.sourceBundleKey))
        .map(s => ({ ...s, bundleAssigned: Boolean(bundleAssignment
          && bundleAssignment.provider === source && bundleMatchesAssignment(bundleAssignment.bundleKey,s.sourceBundleKey)) })));
      if (!subtitles.length || (!includeUnknown && !bundleAssignment && subtitles.every(s => !s.episodeConfirmed))) return null;
      return localResponse(subtitles);
    };
    const findAniAllLocal = async () => {
      if(bundleAssignment && bundleAssignment.provider!=='aniall') return null;
      const reviewed=await findReviewedLocal('aniall',false);if(reviewed) return reviewed;
      const scope=bundleAssignment ? parseBundleScope(bundleAssignment.bundleKey) : null;
      if(bundleAssignment) {
        if(!scope || (scope.type!=='local' && scope.type!=='folder') || scope.provider!=='aniall') return null;
        const postId=scope.work.match(/^([1-9]\d*)__/)?.[1] || '';
        const postUrl=postId?`https://aniall.tistory.com/${postId}`:'';
        const subtitles=await getAniAllArchiveSubtitles(scope.work.replace(/^[1-9]\d*__/,''),ep,scope.season,sourceEpisodeStart,postUrl,
          {bundleKey:bundleAssignment.bundleKey});
        return localResponse(subtitles.map(s=>({...s,sourceProvider:'aniall',sourceCreatorWebsite:postUrl || undefined,
          sourceMatchedTitle:bundleAssignment.label,localArchive:true,bundleAssigned:true})));
      }
      const matches=(await getAniAllMatches(comparisonTitle,animeIdParam))
        .filter(m=>!isRejected('aniall',m.postUrl)).sort((a,b)=>b.confidence-a.confidence);
      const available:Array<any>=[];let bestScore=-Infinity;
      for(const match of matches.slice(0,20)) {
        if(match.confidence<bestScore) break;
        const subtitles=(await getAniAllArchiveSubtitles(match.blogTitle,ep,parseSeason(match.canonicalTitle),sourceEpisodeStart,match.postUrl))
          .filter(s=>!claimedByOtherAnime('aniall',s.sourceBundleKey));
        if(subtitles.length) bestScore=match.confidence;
        available.push(...subtitles.map(s=>({...s,sourceProvider:'aniall',sourceCreatorWebsite:match.postUrl,
          sourceMatchedTitle:match.canonicalTitle,localArchive:true,bundleAssigned:false})));
      }
      if(available.length) return localResponse(available);
      const direct=(await getAniAllArchiveSubtitles(comparisonTitle,ep,parseSeason(comparisonTitle),sourceEpisodeStart))
        .filter(s=>!claimedByOtherAnime('aniall',s.sourceBundleKey) && !isRejected('local',s.name));
      return localResponse(direct.map(s=>({...s,sourceProvider:'aniall',sourceMatchedTitle:comparisonTitle,localArchive:true})));
    };
    const findAnissiaLocal = async () => {
      if(bundleAssignment && bundleAssignment.provider!=='anissia') return null;
      const reviewed=await findReviewedLocal('anissia',false);if(reviewed) return reviewed;
      const localSubtitles=await getAnissiaArchiveSubtitles([searchTarget,comparisonTitle,title,referenceTitle || ''],sourceEpisode,directAnimeNo,
        parseSeason(comparisonTitle) || parseSeason(searchTarget),{localEpisode:ep,bundleKey:bundleAssignment?.bundleKey});
      let available=localSubtitles.filter(s=>!claimedByOtherAnime('anissia',s.sourceBundleKey))
        .filter(s=>!isRejected('anissia',`[로컬 Anissia · ${s.creator}] ${s.localArchiveTrackLabel} · ${s.archiveFilename} · ${s.orig_filename}`));
      if(requestedAnissiaTrackKey && !bundleAssignment) {
        const preferred=available.filter(s=>s.localArchiveTrackKey===requestedAnissiaTrackKey);
        if(preferred.length) available=preferred;
      }
      return localResponse(available.map(s=>({...s,
        name:`[로컬 Anissia · ${s.creator}] ${s.localArchiveTrackLabel} · ${s.archiveFilename} · ${s.orig_filename}`,
        episode:ep,sourceProvider:'anissia',sourceCreatorWebsite:s.website || undefined,sourceMatchedTitle:s.matchedTitle,
        verifiedMatch:true,localArchive:true,bundleAssigned:Boolean(bundleAssignment)})),available.map(s=>({
          name:`Anissia · ${s.creator}`,episode:String(sourceEpisode),update_date:s.updatedAt,website:s.website || '',
          is_current_ep:true,matchedTitle:s.matchedTitle,matchScore:100,verifiedMatch:true,sourceProvider:'anissia',localArchive:true})));
    };

    const localResolvers = bundleAssignment?.provider === "aniall"
      ? [findAniAllLocal]
      : bundleAssignment?.provider === "anissia"
        ? [findAnissiaLocal]
        : bundleAssignment?.provider === "naver"
          ? [() => findReviewedLocal("naver", false)]
          : requestedAnissiaTrackKey
            ? [findAnissiaLocal, findAniAllLocal]
            : sourcePriority === "aniall"
              ? [findAniAllLocal, findAnissiaLocal]
              : [findAnissiaLocal, findAniAllLocal];
    for (const resolveLocal of localResolvers) {
      const localResponse = await resolveLocal();
      if (localResponse) return localResponse;
    }

    if(bundleAssignment) return NextResponse.json({success:true,episode:ep,count:0,subtitles:[],creators:[],
      bundle_assignment:bundleAssignment,assignment_missing:true,needs_manual_subtitle_choice:true,
      subtitle_notice:parseBundleScope(bundleAssignment.bundleKey)
        ? '지정한 자막 묶음에 이 회차의 자막이 없습니다. 로컬 검색 또는 예외 만들기로 선택해 주세요.'
        : '기존 묶음 지정은 작품 범위를 다시 선택해야 합니다. 로컬 검색에서 작품 전체 지정을 다시 해 주세요.'},
      {headers:{'Cache-Control':'no-store'}});
    if (!bundleAssignment) {
      const reviewedNaver = await findReviewedLocal("naver", false);
      if (reviewedNaver) return reviewedNaver;
      // Unknown historical episodes must not hide a known weekly file from either local source.
      const reviewedManual = sourcePriority === 'aniall'
        ? await findReviewedLocal('aniall') || await findReviewedLocal('anissia') || await findReviewedLocal('naver')
        : await findReviewedLocal('anissia') || await findReviewedLocal('aniall') || await findReviewedLocal('naver');
      if (reviewedManual) return reviewedManual;
    }

    const cached = animeIdParam && !sourceEpisodeStart && !bundleAssignment
      ? await getVerifiedSubtitleCache(animeIdParam, ep) : null;
    if (cached && !isRejected(cached.sourceProvider,
      cached.sourceCreatorWebsite || cached.name)) {
      return NextResponse.json({ success: true, anime_title: title, episode: ep, count: 1,
        subtitles: [cached], creators: [], verified_cache: true }, { headers: { "Cache-Control": "no-store" } });
    }

    // 직접 저장한 웹 링크와 AniAll/Anissia 링크는 모든 Pi 로컬 보관함을 확인한 뒤 사용한다.
    const savedUrl = animeIdParam ? await getManualSubtitleLink(user.username, animeIdParam, ep) : null;
    if (savedUrl && !isRejected("anissia", savedUrl)) {
      const manual = await fetchCreatorSubtitle("직접 자막", savedUrl, title, sourceEpisode, 12000, ep, animeIdParam);
      if (manual?.content) {
        return NextResponse.json({ success: true, anime_title: title, episode: ep, count: 1, subtitles: [manual], creators: [] }, { headers: { "Cache-Control": "no-store" } });
      }
    }

    if (website && website.startsWith("http") && sourcePriority !== "aniall"
      && !isRejected("anissia", website)) {
      const directSub = await fetchCreatorSubtitle(creatorName || "제작자", website, searchTarget, sourceEpisode, 5000, ep, animeIdParam);
      if (directSub && directSub.content) {
        return NextResponse.json({
          success: true,
          anime_title: title,
          resolved_title: resolvedTitle,
          episode: ep,
          count: 1,
          subtitles: [directSub],
          creators: creatorName ? [{
            name: creatorName,
            episode: String(ep),
            update_date: "",
            website,
            is_current_ep: true,
          }] : [],
        }, {
          status: 200,
          headers: {
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
    }

    // 13초 타임아웃 방어 가드 적용 (directAnimeNo 지원)
    const result = await searchAllSubtitlesParallel(searchTarget, ep, 45000, directAnimeNo, comparisonTitle, animeIdParam, sourceEpisodeStart);

    // HTML 등 비정상 자막 필터링
    const validSubtitles = (result.subtitles || []).filter((s) => {
      if (!s.content) return false;
      const lower = s.content.slice(0, 300).toLowerCase();
      if (lower.includes("<!doctype html") || lower.includes("<html") || lower.includes("<head>")) {
        return false;
      }
      return true;
    });

    return NextResponse.json(
      {
        success: true,
        anime_title: title,
        resolved_title: resolvedTitle,
        episode: ep,
        count: validSubtitles.length,
        subtitles: validSubtitles,
        creators: result.creators,
        needs_manual_subtitle_choice: result.needsManualSubtitleChoice,
      },
      {
        status: 200,
        headers: {
          // 자막이 실제로 있을 때만 Vercel Edge CDN에 24시간 캐싱
          // (검색 타임아웃 등으로 빈 결과가 24시간 캐시되면 재방문 시 자막 검색이 영구 실패함)
          // Results include work-specific user feedback; never serve an old
          // public cache entry after a source has been rejected.
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  } catch (error) {
    console.error("[Subtitles API error]:", error);
    // 보안: 내부 에러 상세를 클라이언트에 노출하지 않음
    return NextResponse.json(
      { success: false, message: "자막 검색에 실패했습니다." },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  // 보안: 미인증 사용자가 서버를 오픈 크롤링/퍼치 서비스로 악용하는 것을 방지
  const user = await getSessionUser();
  if (!user) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const body = await request.json();
    const { creatorName, website, title, matchedTitle, episodeNumber, creatorEpisode, sourceProvider, localArchive } = body;
    const animeId = typeof body.animeId === "string" ? body.animeId.trim() : "";
    const ep = parseInt(String(episodeNumber || "1"), 10) || 1;
    const sourceEpisodeStart = animeId
      ? await getSubtitleEpisodeStart(user.username, animeId)
      : null;

    if (!creatorName || !title) {
      return NextResponse.json(
        { success: false, message: "필수 정보가 누락되었습니다." },
        { status: 400 }
      );
    }

    if (animeId && website && !localArchive) {
      const rejected = await getSubtitleRejections(animeId);
      if (rejected.some((entry) => entry.provider === (sourceProvider === "aniall" ? "aniall" : "anissia")
        && entry.sourceKey === website)) {
        return NextResponse.json({ success: false, message: "이 작품에서 숨긴 자막입니다. 숨긴 자막 목록에서 되돌릴 수 있어요." },
          { status: 409 });
      }
    }

    // 보안: website는 서버에서 fetch하므로 SSRF 가드 통과 필수
    if (website && !(localArchive && sourceProvider === "anissia")) {
      try {
        await assertSafeProxyUrl(String(website));
      } catch (e) {
        if (e instanceof UnsafeProxyUrlError) {
          return NextResponse.json(
            { success: false, message: `허용되지 않는 주소입니다: ${e.message}` },
            { status: 400 }
          );
        }
        throw e;
      }
    }

    const requestedTitle = typeof matchedTitle === "string" && matchedTitle.trim() ? matchedTitle.trim() : title;
    const resolvedTitle = await resolveKoreanTitle(requestedTitle);
    const targetTitle = resolvedTitle || requestedTitle;
    const targetSeason = parseSeason(targetTitle) || parseSeason(requestedTitle);
    const sourceEpisode = sourceEpisodeStart && sourceEpisodeStart > 0
      ? toSourceEpisode(ep, sourceEpisodeStart)
      : mapProviderEpisodeNumber(String(creatorEpisode || ""), ep, targetSeason);

    const isErusha = (creatorName.includes("에루샤") || (website && website.toLowerCase().includes("erulabo")))
      && !(localArchive && sourceProvider === "anissia");
    if (isErusha) {
      return NextResponse.json({
        success: false,
        message: "에루샤 님의 배포처(erulabo.com)는 Cloudflare 보안 캡차가 적용되어 있어 자동 추출이 지원되지 않습니다. 블로그에서 직접 다운로드해 주세요.",
      });
    }

    let sub = null;
    if (localArchive && sourceProvider === "anissia") {
      const animeNoMatch = animeId.match(/^(?:ani_)?(\d+)$/);
      const animeNo = animeNoMatch ? Number(animeNoMatch[1]) : null;
      const archives = await getAnissiaArchiveSubtitles(
        [targetTitle, requestedTitle, String(title)],
        sourceEpisode,
        animeNo,
        targetSeason,
        { localEpisode: ep },
      );
      const requestedCreator = String(creatorName).replace(/^Anissia\s*[·|]\s*/i, "").trim();
      const local = archives.find((item) =>
        (website && item.website === website) ||
        (item.creator.toLocaleLowerCase("ko-KR") === requestedCreator.toLocaleLowerCase("ko-KR")
          && (!matchedTitle || item.matchedTitle === matchedTitle))
      );
      if (local) {
        sub = {
          name: local.name,
          orig_filename: local.orig_filename,
          content: local.content,
          format: local.format,
          is_ass: local.is_ass,
          url: local.website || undefined,
        };
      }
    } else if (creatorName.includes("카이란") || (website && website.toLowerCase().includes("kairan"))) {
      sub = await findKairanSubtitle(targetTitle, sourceEpisode, 5000, ep);
    } else if (website) {
      if (sourceProvider === "aniall") {
        const blogTitle = String(creatorName).replace(/^AniAll\s*[·|]\s*/i, "").trim();
        sub = await getAniAllArchiveSubtitle(blogTitle, ep, targetSeason, sourceEpisodeStart, String(website));
      }
      if (!sub) sub = await fetchCreatorSubtitle(creatorName, website, targetTitle, sourceEpisode, 5000, ep, animeId);
    }

    if (!sub || !sub.content) {
      if (sourceProvider === "aniall") {
        console.warn("[AniAll subtitle extraction failed]", {
          blogTitle: String(creatorName).replace(/^AniAll\s*[·|]\s*/i, "").trim(),
          episode: ep,
          sourceEpisode,
          season: targetSeason,
          website,
        });
      }
      return NextResponse.json({
        success: false,
        message: "해당 제작자 블로그에서 자막을 자동으로 추출하지 못했습니다.",
      });
    }

    // HTML 응답 필터링
    const lower = sub.content.slice(0, 300).toLowerCase();
    if (lower.includes("<!doctype html") || lower.includes("<html") || lower.includes("<head>")) {
      return NextResponse.json({
        success: false,
        message: "유효하지 않은 자막 파일 형식입니다.",
      });
    }

    const normalizedProvider = sourceProvider === "aniall" ? "aniall" : "anissia";
    let creatorPreferenceSaved = false;
    if (animeId && website && !localArchive) {
      creatorPreferenceSaved = await saveSubtitleCreatorPreference(user.username, animeId, {
        sourceProvider: normalizedProvider,
        creatorName: String(creatorName),
        website: String(website),
        matchedTitle: String(matchedTitle || requestedTitle || title),
        creatorEpisode: String(creatorEpisode || ""),
      });
      if (!creatorPreferenceSaved) {
        console.warn("[Subtitle creator preference save failed]", { animeId, creatorName, website });
      }
    }

    return NextResponse.json({
      success: true,
      subtitle: {
        ...sub,
        sourceProvider: normalizedProvider,
        sourceCreatorWebsite: website || undefined,
        sourceMatchedTitle: matchedTitle || requestedTitle,
      },
      creator_preference_saved: creatorPreferenceSaved,
    });
  } catch (error) {
    console.error("[Subtitles POST error]:", error);
    // 보안: 내부 에러 상세를 클라이언트에 노출하지 않음
    return NextResponse.json(
      { success: false, message: "자막 추출 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}

