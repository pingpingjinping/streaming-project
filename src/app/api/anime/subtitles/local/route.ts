import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import {
  getAniAllMatches,
  searchAniAllMatchesByTitleFragment,
  getSubtitleEpisodeStart,
  getSubtitleRejections,
  getSubtitleSourcePriority,
  getSubtitleBundleAssignment,
  getSubtitleBundleAssignments,
} from "@/lib/db";
import { getAniAllArchiveSubtitles, getAnissiaArchiveSubtitles, searchLocalSubtitleFolders } from "@/lib/subtitleStorage";
import { findReviewedTitles, getReviewedSubtitles } from "@/lib/reviewedSubtitleStorage";
import {parseBundleScope} from "@/lib/subtitleLocalIdentity";
import { parseSeason, resolveKoreanTitle } from "@/lib/subtitles";

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const params = request.nextUrl.searchParams;
  const title = params.get("title")?.trim() || "";
  const animeId = params.get("animeId")?.trim() || "";
  const episode = Number(params.get("ep") || 1);
  if (!title || title.length > 200 || !Number.isSafeInteger(episode) || episode < 1 || episode > 10000) {
    return NextResponse.json({ success: false, message: "작품명과 회차를 확인해 주세요." }, { status: 400 });
  }

  try {
    if (params.get("mode") === "folders") {
      const [legacy, reviewed] = await Promise.all([searchLocalSubtitleFolders(title), findReviewedTitles(title)]);
      const folders = [...new Map([...legacy, ...reviewed].map(f => [`${f.provider}:${f.folderName}`, f])).values()].slice(0, 200);
      return NextResponse.json({ success: true, folders },
        { headers: { "Cache-Control": "no-store" } });
    }
    const [sourceEpisodeStart, rejected, sourcePriority, bundleAssignment, bundleAssignments] = await Promise.all([
      animeId ? getSubtitleEpisodeStart(user.username, animeId) : Promise.resolve(null),
      getSubtitleRejections(animeId),
      getSubtitleSourcePriority(),
      animeId ? getSubtitleBundleAssignment(user.username, animeId) : Promise.resolve(null),
      animeId ? getSubtitleBundleAssignments(user.username) : Promise.resolve([]),
    ]);
    const isRejected = (provider: string, sourceKey: string) =>
      rejected.some((entry) => entry.provider === provider && entry.sourceKey === sourceKey);
    const allowReassignmentSearch = params.get("mode") === "search";
    const claimedByOtherAnime = (provider: string, bundleKey?: string) =>
      Boolean(!allowReassignmentSearch && bundleKey && bundleAssignments.some((entry) =>
        entry.exclusive && entry.provider === provider && entry.bundleKey === bundleKey && entry.animeId !== animeId));
    const assignedScope=bundleAssignment ? parseBundleScope(bundleAssignment.bundleKey) : null;
    const resolvedTitle = await resolveKoreanTitle(title) || title;
    const exactMatches = (await getAniAllMatches(resolvedTitle, animeId)).sort((a, b) => b.confidence - a.confidence);
    const partialMatches = await searchAniAllMatchesByTitleFragment(resolvedTitle);
    const seenMatches = new Set<string>();
    const matches = [...exactMatches, ...partialMatches].filter((match) => {
      const key = `${match.postId}\n${match.canonicalTitle}`;
      if (seenMatches.has(key)) return false;
      seenMatches.add(key);
      return true;
    });
    const candidates = new Map<string, { blogTitle: string; canonicalTitle: string; postUrl: string; confidence: number }>();
    if (bundleAssignment?.provider === "aniall" && assignedScope?.type === "local" && !allowReassignmentSearch) {
      const postId = assignedScope.work.match(/^([1-9]\d*)__/)?.[1] || "";
      const postUrl = postId ? `https://aniall.tistory.com/${postId}` : "";
      candidates.set(`assigned:${bundleAssignment.bundleKey}`, {
        blogTitle: assignedScope.work.replace(/^[1-9]\d*__/, ""),
        canonicalTitle: resolvedTitle,
        postUrl,
        confidence: 1000,
      });
    }
    for (const match of matches) {
      const key = match.postUrl || match.blogTitle;
      if (!candidates.has(key)) candidates.set(key, {
        blogTitle: match.blogTitle, canonicalTitle: match.canonicalTitle,
        postUrl: match.postUrl, confidence: match.confidence,
      });
    }
    // Also permit a folder whose name directly matches the entered title.
    const selectedFolder = title.match(/^([1-9]\d*)__([\s\S]+)$/);
    if (!candidates.has(title)) candidates.set(title, { blogTitle: selectedFolder?.[2] || title,
      canonicalTitle: resolvedTitle, postUrl: selectedFolder ? `https://aniall.tistory.com/${selectedFolder[1]}` : "", confidence: 0 });

    const aniallSubtitles = [];
    for (const candidate of [...candidates.values()].slice(0, 20)) {
      const found=await getAniAllArchiveSubtitles(candidate.blogTitle,episode,parseSeason(candidate.canonicalTitle),sourceEpisodeStart,candidate.postUrl,
        {manualSearch:true,bundleKey:!allowReassignmentSearch && assignedScope?.type==='local' && bundleAssignment?.provider==='aniall' ? bundleAssignment.bundleKey : undefined});
      for(const subtitle of found) {
      if (claimedByOtherAnime("aniall", subtitle.sourceBundleKey)) continue;
      const displayName = `[로컬 AniAll · ${candidate.blogTitle}] ${subtitle.orig_filename}`;
      if (isRejected(candidate.postUrl ? "aniall" : "local", candidate.postUrl || displayName)) continue;
      aniallSubtitles.push({
        ...subtitle,
        name: displayName,
        episode, sourceProvider: "aniall", sourceCreatorWebsite: candidate.postUrl,
        sourceMatchedTitle: candidate.canonicalTitle, matchScore: candidate.confidence,
        verifiedMatch: candidate.confidence >= 90, localArchive: true,
        bundleAssigned: bundleAssignment?.provider === "aniall" && bundleAssignment.bundleKey === subtitle.sourceBundleKey,
      });
      }
    }

    const anissiaNoMatch = animeId.match(/^(?:ani_)?(\d+)$/);
    const anissiaNo = anissiaNoMatch ? Number(anissiaNoMatch[1]) : null;
    const sourceEpisode = sourceEpisodeStart && sourceEpisodeStart > 0 ? sourceEpisodeStart + episode - 1 : episode;
    const assignedAnissiaLabel = !allowReassignmentSearch && assignedScope?.type==='local' && bundleAssignment?.provider==='anissia' ? assignedScope.work.replace(/^[1-9]\d*__/,'') : "";
    const anissiaArchives = await getAnissiaArchiveSubtitles(
      [title, resolvedTitle, assignedAnissiaLabel].filter(Boolean),
      sourceEpisode,
      null,
      parseSeason(resolvedTitle) || parseSeason(title),
      { folderNameQuery: assignedAnissiaLabel || title, maxResults: 50, localEpisode: episode,manualSearch:true,
        bundleKey:assignedAnissiaLabel ? bundleAssignment?.bundleKey : undefined },
    );
    const anissiaSubtitles = anissiaArchives
      .filter((subtitle) => !claimedByOtherAnime("anissia", subtitle.sourceBundleKey))
      .filter((subtitle) => !isRejected("anissia", `[로컬 Anissia · ${subtitle.creator}] ${subtitle.localArchiveTrackLabel} · ${subtitle.archiveFilename} · ${subtitle.orig_filename}`))
      .map((subtitle) => ({
        ...subtitle,
        name: `[로컬 Anissia · ${subtitle.creator}] ${subtitle.localArchiveTrackLabel} · ${subtitle.archiveFilename} · ${subtitle.orig_filename}`,
        episode,
        sourceProvider: "anissia",
        sourceCreatorWebsite: subtitle.website || undefined,
        sourceMatchedTitle: subtitle.matchedTitle,
        matchScore: 100,
        verifiedMatch: true,
        localArchive: true,
        bundleAssigned: bundleAssignment?.provider === "anissia" && bundleAssignment.bundleKey === subtitle.sourceBundleKey,
      }));
    const reviewed = await getReviewedSubtitles({ animeId, episode, sourceEpisode,
      season: parseSeason(resolvedTitle) || parseSeason(title),
      bundleKey: params.get("mode") === "search" ? undefined
        : bundleAssignment && (bundleAssignment.provider === "aniall" || bundleAssignment.provider === "naver")
          ? bundleAssignment.bundleKey : undefined,
      source: params.get("mode") === "search" ? undefined
        : bundleAssignment && (bundleAssignment.provider === "aniall" || bundleAssignment.provider === "naver")
          ? bundleAssignment.provider : undefined,
      isRejected: (provider, key) => isRejected(provider, key)
        || (provider === "aniall" && rejected.some(r => r.provider === "aniall" && !r.sourceKey.startsWith("reviewed:"))),
      keyword: params.get("mode") === "search" ? title : "", manualSearch: true });
    const reviewedVisible = reviewed.subtitles
      .filter(s => !claimedByOtherAnime(s.sourceProvider, s.sourceBundleKey))
      .map(s => ({ ...s,
        bundleAssigned: bundleAssignment?.provider === s.sourceProvider && bundleAssignment.bundleKey === s.sourceBundleKey }));
    const reviewedAniAll = reviewedVisible.filter(s => s.sourceProvider === "aniall");
    const reviewedNaver = reviewedVisible.filter(s => s.sourceProvider === "naver");
    const subtitles = sourcePriority === "aniall"
      ? [...reviewedAniAll, ...aniallSubtitles, ...anissiaSubtitles, ...reviewedNaver]
      : [...anissiaSubtitles, ...reviewedAniAll, ...aniallSubtitles, ...reviewedNaver];

    return NextResponse.json({ success: true, anime_title: title, episode, count: subtitles.length, subtitles,
      bundleAssignment },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[Local subtitle search error]:", error);
    return NextResponse.json({ success: false, message: "Pi 로컬 자막 검색에 실패했습니다." }, { status: 500 });
  }
}
