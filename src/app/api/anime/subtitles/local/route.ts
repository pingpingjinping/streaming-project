import { toSourceEpisode } from "@/lib/episodeMapping";
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
import { getAniAllArchiveSubtitles, getAnissiaArchiveSubtitles, listLocalSubtitleFolderFiles, getLocalSubtitleFolderFile } from "@/lib/subtitleStorage";
import { findReviewedFiles, getReviewedSubtitles } from "@/lib/reviewedSubtitleStorage";
import { searchLocalSubtitleEntries, searchLocalZipSubtitles, refreshLocalSubtitleSearchIndex } from "@/lib/localSubtitleSearch";
import {bundleScopeKey,parseBundleScope,bundleScopesOverlap,bundleSelectionMatches} from "@/lib/subtitleLocalIdentity";
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
    if (params.get("mode") === "folder-entries") {
      const key = params.get("folderKey") || "";
      const offsetValue = params.get("offset") || "0";
      const filter = params.get("filter") || "";
      if (!/^(0|[1-9]\d{0,5})$/.test(offsetValue) || filter.length > 200)
        return NextResponse.json({success:false,message:"폴더 목록 요청을 확인해 주세요."},{status:400});
      const page = await listLocalSubtitleFolderFiles(key,Number(offsetValue),filter);
      return NextResponse.json(page ? {success:true,...page} : {success:false,message:"선택한 폴더에 접근할 수 없습니다."},
        {status:page?200:404,headers:{"Cache-Control":"no-store"}});
    }
    if (params.get("mode") === "folder-file") {
      const key = params.get("folderKey") || "";
      const relative = params.get("path") || "";
      const member = params.get("member") || "";
      const subtitle = await getLocalSubtitleFolderFile(key,relative,member);
      return NextResponse.json(subtitle ? {success:true,subtitle} : {success:false,message:"선택한 자막 파일을 읽을 수 없습니다."},
        {status:subtitle?200:404,headers:{"Cache-Control":"no-store"}});
    }
    if (params.get("mode") === "folders") {
      // Explicit refresh also handles files moved manually by File Browser,
      // which does not write the automatic downloader change journal.
      if (params.get("refresh") === "1") {
        if (!user.isAdmin) return NextResponse.json({ success: false, message: "관리자만 인덱스를 갱신할 수 있습니다." }, { status: 403 });
        await refreshLocalSubtitleSearchIndex();
      }
      const folders = await searchLocalSubtitleEntries(title);
      return NextResponse.json({ success: true, folders },
        { headers: { "Cache-Control": "no-store" } });
    }
    const [sourceEpisodeStart, rejected, sourcePriority, bundleAssignment, bundleAssignments] = await Promise.all([
      animeId ? getSubtitleEpisodeStart(user.username, animeId) : Promise.resolve(null),
      getSubtitleRejections(animeId),
      getSubtitleSourcePriority(),
      animeId ? getSubtitleBundleAssignment(user.username, animeId) : Promise.resolve(null),
      animeId ? getSubtitleBundleAssignments(user.username, animeId) : Promise.resolve([]),
    ]);
    const isRejected = (provider: string, sourceKey: string) =>
      rejected.some((entry) => entry.provider === provider && entry.sourceKey === sourceKey);
    const allowReassignmentSearch = params.get("mode") === "search";
    const claimedByOtherAnime = (provider: string, bundleKey?: string) =>
      Boolean(!allowReassignmentSearch && bundleKey && bundleAssignments.some((entry) =>
        entry.exclusive && entry.provider === provider && bundleScopesOverlap(entry.bundleKey,bundleKey!) && entry.animeId !== animeId));
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
    // Browsing the selected work shows its other current-episode releases so users can replace the default.
    const recommendationKey=assignedScope && bundleAssignment ? bundleScopeKey(assignedScope.type==='reviewed'
      ? {...assignedScope,track:undefined} : {type:'folder',provider:assignedScope.provider,work:assignedScope.work,
        kind:assignedScope.kind,season:assignedScope.season}) : undefined;
    const candidates = new Map<string, { blogTitle: string; canonicalTitle: string; postUrl: string; confidence: number }>();
    if (bundleAssignment?.provider === "aniall" && (assignedScope?.type === "local" || assignedScope?.type === "folder") && !allowReassignmentSearch) {
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
    const selectedAniAll = !allowReassignmentSearch && bundleAssignment?.provider==='aniall'
      && (assignedScope?.type==='local' || assignedScope?.type==='folder');
    const aniallCandidates = selectedAniAll ? [...candidates.values()].slice(0,1) : [...candidates.values()].slice(0,20);
    for (const candidate of aniallCandidates) {
      const found=await getAniAllArchiveSubtitles(candidate.blogTitle,episode,parseSeason(candidate.canonicalTitle),sourceEpisodeStart,candidate.postUrl,
        {manualSearch:allowReassignmentSearch,bundleKey:!allowReassignmentSearch && (assignedScope?.type==='local' || assignedScope?.type==='folder') && bundleAssignment?.provider==='aniall' ? recommendationKey : undefined});
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
        bundleAssigned: bundleAssignment?.provider === "aniall" && bundleSelectionMatches(bundleAssignment.bundleKey,subtitle.sourceBundleKey),
      });
      }
    }

    const anissiaNoMatch = animeId.match(/^(?:ani_)?(\d+)$/);
    const anissiaNo = anissiaNoMatch ? Number(anissiaNoMatch[1]) : null;
    const sourceEpisode = sourceEpisodeStart && sourceEpisodeStart > 0
      ? toSourceEpisode(episode, sourceEpisodeStart)
      : episode;
    const assignedAnissiaLabel = !allowReassignmentSearch && (assignedScope?.type==='local' || assignedScope?.type==='folder') && bundleAssignment?.provider==='anissia' ? assignedScope.work.replace(/^[1-9]\d*__/,'') : "";
    const anissiaArchives = await getAnissiaArchiveSubtitles(
      [title, resolvedTitle, assignedAnissiaLabel].filter(Boolean),
      sourceEpisode,
      null,
      parseSeason(resolvedTitle) || parseSeason(title),
      { folderNameQuery: assignedAnissiaLabel || title, maxResults: 50, localEpisode: episode,manualSearch:allowReassignmentSearch,
        bundleKey:assignedAnissiaLabel ? recommendationKey : undefined },
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
        bundleAssigned: bundleAssignment?.provider === "anissia" && bundleSelectionMatches(bundleAssignment.bundleKey,subtitle.sourceBundleKey),
      }));
    const reviewed = await getReviewedSubtitles({ animeId, episode, sourceEpisode,
      season: parseSeason(resolvedTitle) || parseSeason(title),
      bundleKey: params.get("mode") === "search" ? undefined
        : bundleAssignment && assignedScope?.type === 'reviewed'
          ? recommendationKey : undefined,
      source: params.get("mode") === "search" ? undefined
        : bundleAssignment && assignedScope?.type === 'reviewed'
          ? bundleAssignment.provider : undefined,
      isRejected: (provider, key) => isRejected(provider, key)
        || (provider === "aniall" && rejected.some(r => r.provider === "aniall" && !r.sourceKey.startsWith("reviewed:"))),
      keyword: params.get("mode") === "search" ? title : "", manualSearch: allowReassignmentSearch });
    const reviewedVisible = reviewed.subtitles
      .filter(s => !claimedByOtherAnime(s.sourceProvider, s.sourceBundleKey))
      .map(s => ({ ...s,
        bundleAssigned: bundleAssignment?.provider === s.sourceProvider && bundleSelectionMatches(bundleAssignment.bundleKey,s.sourceBundleKey) }));
    const reviewedAniAll = reviewedVisible.filter(s => s.sourceProvider === "aniall");
    const reviewedNaver = reviewedVisible.filter(s => s.sourceProvider === "naver");
    const reviewedAnissia = reviewedVisible.filter(s => s.sourceProvider === "anissia");
    const archivePath = allowReassignmentSearch ? params.get("archivePath") || undefined : undefined;
    const rawZipSubtitles = allowReassignmentSearch
      ? await searchLocalZipSubtitles(title, episode, sourceEpisode, parseSeason(resolvedTitle) || parseSeason(title), archivePath) : [];
    // Preserve registered identities and episode bindings when the same member is already available.
    const registered = [...reviewedVisible, ...aniallSubtitles, ...anissiaSubtitles];
    // Never resurrect a rejected or unreadable registered member through the raw reader.
    const registeredFiles = allowReassignmentSearch ? await findReviewedFiles(animeId, title) : [];
    const rawVisible = rawZipSubtitles.filter(raw => !isRejected(raw.sourceProvider, raw.name)
      && !(raw.sourceProvider === "aniall" && rejected.some(r => r.provider === "aniall" && !r.sourceKey.startsWith("reviewed:")))
      && !(raw.sourceProvider === "anissia" && rejected.some(r => r.provider === "anissia"
        && r.sourceKey.endsWith(` · ${raw.archiveFilename} · ${raw.orig_filename}`)))
      && !registeredFiles.some(f => f.source === raw.sourceProvider && f.sha256 === raw.archiveMemberSha256)
      && !registered.some(s => s.sourceProvider === raw.sourceProvider
      && s.content === raw.content && s.format === raw.format));
    const ordered = sourcePriority === "aniall"
      ? [...reviewedAniAll, ...aniallSubtitles, ...reviewedAnissia, ...anissiaSubtitles, ...reviewedNaver]
      : [...reviewedAnissia, ...anissiaSubtitles, ...reviewedAniAll, ...aniallSubtitles, ...reviewedNaver];

    // The recommendations tab applies a file to the current episode. Broad
    // browsing (including unknown/other episodes) belongs only to manual search.
    const searched = archivePath ? ordered.filter(s => rawZipSubtitles.some(raw => raw.sourceProvider === s.sourceProvider
      && raw.content === s.content && raw.format === s.format)) : ordered;
    const eligible = allowReassignmentSearch ? [...searched, ...rawVisible] : ordered.filter(s=>
      (s.episodeConfirmed || ('reviewedFileId' in s && s.reviewedFileId.startsWith('subsubsub_20261009:')))
      && (!bundleAssignment || s.sourceProvider===bundleAssignment.provider));
    const subtitles = [...new Map(eligible.map(s=>[`${s.sourceProvider}:${'reviewedFileId' in s ? s.reviewedFileId : 'manualArchiveFileId' in s ? s.manualArchiveFileId : s.localFileId}`,s])).values()];
    return NextResponse.json({ success: true, anime_title: title, episode, count: subtitles.length, subtitles,
      bundleAssignment },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[Local subtitle search error]:", error);
    return NextResponse.json({ success: false, message: "Pi 로컬 자막 검색에 실패했습니다." }, { status: 500 });
  }
}


