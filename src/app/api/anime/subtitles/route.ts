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
import { getAniAllMatches, getManualSubtitleLink, getSubtitleSourcePriority } from "@/lib/db";
import { getAniAllArchiveSubtitle, getUploadedSubtitle, getVerifiedSubtitleCache } from "@/lib/subtitleStorage";
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
  const ep = parseInt(searchParams.get("ep") || "1", 10) || 1;
  const animeIdParam = searchParams.get("animeId") || searchParams.get("animeNo") || "";
  let directAnimeNo: number | null = null;
  if (/^(ani_)?\d+$/.test(animeIdParam)) {
    const parsed = Number(animeIdParam.replace(/^ani_/, ""));
    if (Number.isSafeInteger(parsed) && parsed > 0) directAnimeNo = parsed;
  }
  const reanimeMatch = animeIdParam.startsWith("re_")
    ? await getReanimeMatch(animeIdParam) : null;
  if (reanimeMatch?.anissiaNo) directAnimeNo = reanimeMatch.anissiaNo;

  const website = searchParams.get("website")?.trim() || searchParams.get("sub_url")?.trim() || "";
  const creatorName = searchParams.get("creatorName")?.trim() || searchParams.get("creator")?.trim() || "";

  if (!title) {
    return NextResponse.json(
      { success: false, message: "Missing anime title parameter" },
      { status: 400 }
    );
  }

  try {
    const uploaded = animeIdParam ? await getUploadedSubtitle(user.username, animeIdParam, ep) : null;
    if (uploaded) {
      return NextResponse.json({ success: true, anime_title: title, episode: ep, count: 1,
        subtitles: [uploaded], creators: [] }, { headers: { "Cache-Control": "no-store" } });
    }
    const savedUrl = animeIdParam ? await getManualSubtitleLink(user.username, animeIdParam, ep) : null;
    if (savedUrl) {
      const manual = await fetchCreatorSubtitle("직접 자막", savedUrl, title, ep, 12000);
      if (manual?.content) {
        return NextResponse.json({ success: true, anime_title: title, episode: ep, count: 1, subtitles: [manual], creators: [] }, { headers: { "Cache-Control": "no-store" } });
      }
    }
    const cached = animeIdParam ? await getVerifiedSubtitleCache(animeIdParam, ep) : null;
    if (cached) {
      return NextResponse.json({ success: true, anime_title: title, episode: ep, count: 1,
        subtitles: [cached], creators: [], verified_cache: true }, { headers: { "Cache-Control": "no-store" } });
    }
    const resolvedTitle = await resolveKoreanTitle(title);
    const searchTarget = reanimeMatch?.koreanTitle || resolvedTitle || title;
    const comparisonTitle = reanimeMatch?.koreanTitle ||
      (referenceTitle ? await resolveKoreanTitle(referenceTitle) || referenceTitle : searchTarget);

    const sourcePriority = await getSubtitleSourcePriority();

    // 애니시아 우선일 때만 전달된 링크를 바로 가져온다.
    // AniAll 우선이면 Pi 보관함을 먼저 확인하고, 없을 때 AniAll 검색을 우선한다.
    if (website && website.startsWith("http") && sourcePriority !== "aniall") {
      const directSub = await fetchCreatorSubtitle(creatorName || "제작자", website, searchTarget, ep, 5000);
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
            "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=43200",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }
    }

    const localMatches = sourcePriority === "aniall"
      ? (await getAniAllMatches(comparisonTitle, animeIdParam)).sort((a, b) => b.confidence - a.confidence)
      : [];
    const localCreators: Array<{ name: string; episode: string; update_date: string; website: string;
      is_current_ep: boolean; matchedTitle: string; matchScore: number; verifiedMatch: boolean;
      sourceProvider: "aniall"; localArchive: true }> = [];
    let bestLocal: { subtitle: NonNullable<Awaited<ReturnType<typeof getAniAllArchiveSubtitle>>>;
      match: (typeof localMatches)[number] } | null = null;
    for (const match of localMatches) {
      const localSub = await getAniAllArchiveSubtitle(match.blogTitle, ep, parseSeason(match.canonicalTitle));
      if (!localSub) continue;
      if (!bestLocal) bestLocal = { subtitle: localSub, match };
      localCreators.push({ name: `AniAll · ${match.blogTitle}`, episode: "Pi에 저장된 자막",
        update_date: "", website: match.postUrl, is_current_ep: true, matchedTitle: match.canonicalTitle,
        matchScore: match.confidence, verifiedMatch: match.confidence >= 90,
        sourceProvider: "aniall", localArchive: true });
      if (localCreators.length >= 8) break;
    }
    if (bestLocal) {
      return NextResponse.json({
        success: true, anime_title: title, resolved_title: resolvedTitle, episode: ep, count: 1,
        subtitles: [{ ...bestLocal.subtitle, sourceProvider: "aniall", sourceCreatorWebsite: bestLocal.match.postUrl,
          sourceMatchedTitle: bestLocal.match.canonicalTitle, localArchive: true }],
        creators: localCreators,
        local_archive: true,
      }, { headers: { "Cache-Control": "no-store" } });
    }

    // 13초 타임아웃 방어 가드 적용 (directAnimeNo 지원)
    const result = await searchAllSubtitlesParallel(searchTarget, ep, 45000, directAnimeNo, comparisonTitle, animeIdParam);

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
          "Cache-Control":
            validSubtitles.length > 0
              ? "public, s-maxage=86400, stale-while-revalidate=43200"
              : "no-store",
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
    const { creatorName, website, title, matchedTitle, episodeNumber, creatorEpisode, sourceProvider } = body;
    const ep = parseInt(String(episodeNumber || "1"), 10) || 1;

    if (!creatorName || !title) {
      return NextResponse.json(
        { success: false, message: "필수 정보가 누락되었습니다." },
        { status: 400 }
      );
    }

    // 보안: website는 서버에서 fetch하므로 SSRF 가드 통과 필수
    if (website) {
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
    const sourceEpisode = mapProviderEpisodeNumber(String(creatorEpisode || ""), ep, targetSeason);

    const isErusha = creatorName.includes("에루샤") || (website && website.toLowerCase().includes("erulabo"));
    if (isErusha) {
      return NextResponse.json({
        success: false,
        message: "에루샤 님의 배포처(erulabo.com)는 Cloudflare 보안 캡차가 적용되어 있어 자동 추출이 지원되지 않습니다. 블로그에서 직접 다운로드해 주세요.",
      });
    }

    let sub = null;
    if (creatorName.includes("카이란") || (website && website.toLowerCase().includes("kairan"))) {
      sub = await findKairanSubtitle(targetTitle, ep, 5000);
    } else if (website) {
      if (sourceProvider === "aniall") {
        const blogTitle = String(creatorName).replace(/^AniAll\s*[·|]\s*/i, "").trim();
        sub = await getAniAllArchiveSubtitle(blogTitle, ep, targetSeason);
      }
      if (!sub) sub = await fetchCreatorSubtitle(creatorName, website, targetTitle, sourceEpisode, 5000);
    }

    if (!sub || !sub.content) {
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
