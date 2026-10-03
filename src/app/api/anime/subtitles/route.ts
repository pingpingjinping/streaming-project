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
import { getAniAllMatches, getManualSubtitleLink, getSubtitleSourcePriority, getSubtitleEpisodeStart, getSubtitleRejections } from "@/lib/db";
import { getAniAllArchiveSubtitle, getAnissiaArchiveSubtitles, getUploadedSubtitles, getVerifiedSubtitleCache } from "@/lib/subtitleStorage";
import { getReviewedSubtitles } from "@/lib/reviewedSubtitleStorage";
import { getReanimeMatch } from "@/lib/reanimeMatches";

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
  const sourceEpisode = sourceEpisodeStart && sourceEpisodeStart > 0 ? sourceEpisodeStart + ep - 1 : ep;
  const website = searchParams.get("website")?.trim() || searchParams.get("sub_url")?.trim() || "";
  const creatorName = searchParams.get("creatorName")?.trim() || searchParams.get("creator")?.trim() || "";
  const rejections = animeIdParam ? await getSubtitleRejections(animeIdParam) : [];
  const isRejected = (provider: string, sourceKey: string) =>
    rejections.some((entry) => entry.provider === provider && entry.sourceKey === sourceKey);

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
    const uploaded = animeIdParam
      ? (await getUploadedSubtitles(user.username, animeIdParam, ep))
        .filter((subtitle) => !isRejected("local", subtitle.name))
      : [];
    if (uploaded.length) {
      return NextResponse.json({ success: true, anime_title: title, episode: ep, count: uploaded.length,
        subtitles: uploaded, creators: [] }, { headers: { "Cache-Control": "no-store" } });
    }
    const resolvedTitle = await resolveKoreanTitle(title);
    const searchTarget = reanimeMatch?.koreanTitle || resolvedTitle || title;
    const comparisonTitle = reanimeMatch?.koreanTitle ||
      (referenceTitle ? await resolveKoreanTitle(referenceTitle) || referenceTitle : searchTarget);

    const sourcePriority = await getSubtitleSourcePriority();

    const findReviewedLocal = async (source: "aniall" | "naver", includeUnknown = true) => {
      const reviewed = await getReviewedSubtitles({ animeId: animeIdParam, episode: ep, sourceEpisode,
        season: parseSeason(comparisonTitle) || parseSeason(searchTarget), source, isRejected: (provider, key) => isRejected(provider, key)
          || (provider === "aniall" && rejections.some(r => r.provider === "aniall" && !r.sourceKey.startsWith("reviewed:"))) });
      if (!reviewed.subtitles.length || (!includeUnknown && reviewed.subtitles.every(s => !s.episodeConfirmed))) return null;
      return NextResponse.json({ success: true, anime_title: title, episode: ep,
        count: reviewed.subtitles.length, subtitles: reviewed.subtitles, creators: [], local_archive: true,
        needs_manual_subtitle_choice: reviewed.needsManualChoice }, { headers: { "Cache-Control": "no-store" } });
    };
    const findAniAllLocal = async () => {
      const reviewed = await findReviewedLocal("aniall", false);
      if (reviewed) return reviewed;
      const matches = (await getAniAllMatches(comparisonTitle, animeIdParam))
        .filter((match) => !isRejected("aniall", match.postUrl))
        .sort((a, b) => b.confidence - a.confidence);
      const localCreators: Array<{ name: string; episode: string; update_date: string; website: string;
        is_current_ep: boolean; matchedTitle: string; matchScore: number; verifiedMatch: boolean;
        sourceProvider: "aniall"; localArchive: true }> = [];
      let bestLocal: { subtitle: NonNullable<Awaited<ReturnType<typeof getAniAllArchiveSubtitle>>>;
        match: (typeof matches)[number] } | null = null;
      for (const match of matches) {
        const localSub = await getAniAllArchiveSubtitle(match.blogTitle, ep, parseSeason(match.canonicalTitle), sourceEpisodeStart);
        if (!localSub) continue;
        if (!bestLocal) bestLocal = { subtitle: localSub, match };
        localCreators.push({ name: `AniAll · ${match.blogTitle}`, episode: "Pi에 저장된 자막",
          update_date: "", website: match.postUrl, is_current_ep: true, matchedTitle: match.canonicalTitle,
          matchScore: match.confidence, verifiedMatch: match.confidence >= 90,
          sourceProvider: "aniall", localArchive: true });
        if (localCreators.length >= 8) break;
      }

      if (!bestLocal) {
        const directFolder = await getAniAllArchiveSubtitle(comparisonTitle, ep, parseSeason(comparisonTitle), sourceEpisodeStart);
        if (directFolder && !isRejected("local", directFolder.name)) {
          return NextResponse.json({
            success: true, anime_title: title, resolved_title: resolvedTitle, episode: ep, count: 1,
            subtitles: [{ ...directFolder, sourceProvider: "aniall", sourceMatchedTitle: comparisonTitle, localArchive: true }],
            creators: [], local_archive: true,
          }, { headers: { "Cache-Control": "no-store" } });
        }
      }

      if (!bestLocal) return findReviewedLocal("aniall");
      return NextResponse.json({
        success: true, anime_title: title, resolved_title: resolvedTitle, episode: ep, count: 1,
        subtitles: [{ ...bestLocal.subtitle, sourceProvider: "aniall", sourceCreatorWebsite: bestLocal.match.postUrl,
          sourceMatchedTitle: bestLocal.match.canonicalTitle, localArchive: true }],
        creators: localCreators,
        local_archive: true,
      }, { headers: { "Cache-Control": "no-store" } });
    };

    const findAnissiaLocal = async () => {
      const localSubtitles = await getAnissiaArchiveSubtitles(
        [searchTarget, comparisonTitle, title, referenceTitle || ""],
        sourceEpisode,
        directAnimeNo,
        parseSeason(comparisonTitle) || parseSeason(searchTarget),
        { localEpisode: ep },
      );
      const availableLocalSubtitles = localSubtitles.filter((subtitle) =>
        !isRejected("anissia", `[로컬 Anissia · ${subtitle.creator}] ${subtitle.localArchiveTrackLabel} · ${subtitle.archiveFilename} · ${subtitle.orig_filename}`)
      );
      const local = availableLocalSubtitles.find((subtitle) =>
        requestedAnissiaTrackKey && subtitle.localArchiveTrackKey === requestedAnissiaTrackKey
      ) || availableLocalSubtitles[0];
      if (!local) return null;
      const displayName = `[로컬 Anissia · ${local.creator}] ${local.localArchiveTrackLabel} · ${local.archiveFilename} · ${local.orig_filename}`;
      return NextResponse.json({
        success: true,
        anime_title: title,
        resolved_title: resolvedTitle,
        episode: ep,
        count: 1,
        subtitles: [{
          ...local,
          name: displayName,
          episode: ep,
          sourceProvider: "anissia",
          sourceCreatorWebsite: local.website || undefined,
          sourceMatchedTitle: local.matchedTitle,
          verifiedMatch: true,
          localArchive: true,
        }],
        creators: [{
          name: `Anissia · ${local.creator}`,
          episode: String(sourceEpisode),
          update_date: local.updatedAt,
          website: local.website || "",
          is_current_ep: true,
          matchedTitle: local.matchedTitle,
          matchScore: 100,
          verifiedMatch: true,
          sourceProvider: "anissia",
          localArchive: true,
        }],
        local_archive: true,
      }, { headers: { "Cache-Control": "no-store" } });
    };

    const localResolvers = requestedAnissiaTrackKey
      ? [findAnissiaLocal, findAniAllLocal]
      : sourcePriority === "aniall"
        ? [findAniAllLocal, findAnissiaLocal]
        : [findAnissiaLocal, findAniAllLocal];
    for (const resolveLocal of localResolvers) {
      const localResponse = await resolveLocal();
      if (localResponse) return localResponse;
    }

    const reviewedNaver = await findReviewedLocal("naver");
    if (reviewedNaver) return reviewedNaver;

    const cached = animeIdParam && !sourceEpisodeStart ? await getVerifiedSubtitleCache(animeIdParam, ep) : null;
    if (cached && !isRejected(cached.sourceProvider,
      cached.sourceCreatorWebsite || cached.name)) {
      return NextResponse.json({ success: true, anime_title: title, episode: ep, count: 1,
        subtitles: [cached], creators: [], verified_cache: true }, { headers: { "Cache-Control": "no-store" } });
    }

    // 직접 저장한 웹 링크와 AniAll/Anissia 링크는 모든 Pi 로컬 보관함을 확인한 뒤 사용한다.
    const savedUrl = animeIdParam ? await getManualSubtitleLink(user.username, animeIdParam, ep) : null;
    if (savedUrl && !isRejected("anissia", savedUrl)) {
      const manual = await fetchCreatorSubtitle("직접 자막", savedUrl, title, sourceEpisode, 12000, ep);
      if (manual?.content) {
        return NextResponse.json({ success: true, anime_title: title, episode: ep, count: 1, subtitles: [manual], creators: [] }, { headers: { "Cache-Control": "no-store" } });
      }
    }

    if (website && website.startsWith("http") && sourcePriority !== "aniall"
      && !isRejected("anissia", website)) {
      const directSub = await fetchCreatorSubtitle(creatorName || "제작자", website, searchTarget, sourceEpisode, 5000, ep);
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
      ? sourceEpisodeStart + ep - 1
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
        sub = await getAniAllArchiveSubtitle(blogTitle, ep, targetSeason, sourceEpisodeStart);
      }
      if (!sub) sub = await fetchCreatorSubtitle(creatorName, website, targetTitle, sourceEpisode, 5000, ep);
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

    return NextResponse.json({
      success: true,
      subtitle: { ...sub, sourceProvider: sourceProvider === "aniall" ? "aniall" : "anissia" },
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
