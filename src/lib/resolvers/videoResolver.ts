import { getReservedReanimeIdsForOtherWorks, hasWorkMatchCandidates } from '../provisionalWorkMatches';
import { getWorkMatchOverrides } from "../workMatchOverrides";
import { getEffectiveReanimeIdsForAnissia } from "../reanimeMatches";
import { mapVideoEpisode, reviewedVideoStart, toLocalEpisode, videoEpisodeList, videoEpisodeStart } from "../episodeMapping";
import { AnimeDetail, EpisodeItem, EpisodeStreamInfo, ServerSource } from "../providers/types";
import { reanimeProvider } from "../providers/reanime";
import { linkkfProvider } from "../providers/linkkf";
import { ohli24Provider } from "../providers/ohli24";
import { anikotoProvider } from "../providers/anikoto";
import { getAnissiaStreamCache, setAnissiaStreamCache } from "../db";
import { fetchAniListMeta } from "../providers/anissia";
import { getAnikotoPlaybackCandidates } from "../anikotoLinks";
import { getAnimeWorkIdentity, matchesIdentityTitle, normalizeIdentityTitle } from "../animeWorkIdentity";

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json",
};

// 일본어 웨이브 대시 (\u301C 〜), 전각 틸드 (\uFF5E ～), 일반 틸드 (~), 대시류, 콜론
const SUBTITLE_DELIMITERS = /[~～〜―—–\-:：].*$/;

/**
 * 시즌 번호 추출 헬퍼 (예: "3기", "Season 2", "4th Season", "III", "Ⅲ", "Part 2")
 */
export function parseSeason(text: string): number | null {
  if (!text) return null;
  const m1 = text.match(/(?:第\s*)?(\d+)\s*(?:기|期)/);
  if (m1) return parseInt(m1[1], 10);
  const m2 = text.match(/season\s*(\d+)/i);
  if (m2) return parseInt(m2[1], 10);
  const m3 = text.match(/(\d+)(?:st|nd|rd|th)\s*season/i);
  if (m3) return parseInt(m3[1], 10);

  const part = text.match(/part\s*(\d+)/i);
  if (part) return Number(part[1]);

  // 전각 로마 숫자 (Ⅰ, Ⅱ, Ⅲ, Ⅳ, Ⅴ, Ⅵ)
  if (text.includes("Ⅵ")) return 6;
  if (text.includes("Ⅴ")) return 5;
  if (text.includes("Ⅳ")) return 4;
  if (text.includes("Ⅲ")) return 3;
  if (text.includes("Ⅱ")) return 2;
  if (text.includes("Ⅰ")) return 1;

  // 반각 로마 숫자 및 Part 표기 (예: "III", "Part 2", "Part II")
  const mRoman = text.match(/(?:^|[\s_~～〜\-:：])(?:part\s*)?(VI|IV|V|III|II|I)(?:[\s_~～〜\-:：]|$)/i);
  if (mRoman) {
    const rom = mRoman[1].toUpperCase();
    if (rom === "VI") return 6;
    if (rom === "V") return 5;
    if (rom === "IV") return 4;
    if (rom === "III") return 3;
    if (rom === "II") return 2;
    if (rom === "I") return 1;
  }

  return null;
}

interface ProviderIdentity {
  title: string;
  original_title?: string;
  identity_titles?: string[];
  anilist_id?: number;
}

// Only a terminal numbered season label may be removed for a combined source.
// Preserve OVA, movie, named chapters, part numbers and all other subtitles.
function withoutSeason(title: string): string {
  return title.replace(/\s*(?:第\s*\d+\s*期|\d+\s*기|(?:season\s*\d+|\d+(?:st|nd|rd|th)\s*season))\s*$/iu, "").trim();
}

export function matchesVideoPlaybackIdentity(
  candidate: ProviderIdentity,
  aliases: string[],
  expectedAniListId: number | null,
  allowCombinedSource: boolean,
): boolean {
  // Raw provider titles take precedence: a bundled label must not disguise
  // a detail response belonging to a different work.
  const titles = candidate.identity_titles?.length
    ? candidate.identity_titles : [candidate.title, candidate.original_title || ""];
  const exact = titles.some(title => matchesIdentityTitle(title, aliases));
  const combined = allowCombinedSource && titles.some(title => {
    const key = normalizeIdentityTitle(title);
    return key.length >= 4 && aliases.some(alias => {
      const base = withoutSeason(alias);
      return base !== alias && normalizeIdentityTitle(base) === key;
    });
  });
  if (!exact && !combined) return false;
  // Separate seasons can legitimately use one combined provider ID, but the
  // existing episode mapper must still validate the configured boundary.
  if (expectedAniListId && candidate.anilist_id && candidate.anilist_id !== expectedAniListId) {
    return combined;
  }
  return true;
}

/**
 * Older Anissia entries often have no originalSubject. Look up closely related
 * Anissia catalog entries (for example an OVA entry) and recover their shared
 * Japanese franchise title, trimming only known work/format suffixes.
 */
async function findRelatedJapaneseTitles(anissiaId: number, koreanTitle: string): Promise<string[]> {
  if (!koreanTitle) return [];

  try {
    const res = await fetch(
      `https://api.anissia.net/anime/list/0?q=${encodeURIComponent(koreanTitle)}`,
      { headers: HEADERS, signal: AbortSignal.timeout(3000) }
    );
    if (!res.ok) return [];

    const json = await res.json();
    const list = Array.isArray(json?.data?.content) ? json.data.content : [];
    const normalize = (value: string) => value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
    const target = normalize(koreanTitle);
    const titles = new Set<string>();

    for (const item of list) {
      if (Number(item?.animeNo) === anissiaId || !item?.originalSubject || !item?.subject) continue;
      const related = normalize(String(item.subject));
      if (!related.includes(target) && !target.includes(related)) continue;

      const original = String(item.originalSubject).trim();
      const franchiseTitle = original
        .replace(/[\s\u3000]*(?:完|続|續|OVA|OAD|SP|特別編|番外編)(?:[\s\u3000].*)?$/iu, "")
        .trim();
      if (franchiseTitle.length >= 4 && franchiseTitle !== original) titles.add(franchiseTitle);
    }

    return [...titles];
  } catch {
    return [];
  }
}

/**
 * 작품 제목과 회차를 바탕으로 선택한 스트리밍 제공처를 리졸빙
 */
export async function resolveAnissiaStream(
  anissiaId: number | null,
  episodeNumber: number,
  title?: string,
  originalTitle?: string,
  requestedSource?: "rean" | "anikoto" | "linkkf" | "ohli24",
  animeId?: string,
  subtitleEpisodeStart?: number | null,
  seasonEpisodeCount?: number
): Promise<EpisodeStreamInfo | null> {
  const serverSources: ServerSource[] = [];

  // Step 1: Neon DB 스트림 캐시 확인 (0ms 초고속 로드)
  let cachedReanimeId: string | null = null;
  let cachedLinkkfId: string | null = null;

  try {
    if (anissiaId !== null) {
      const cache = await getAnissiaStreamCache(anissiaId);
      if (cache) {
        cachedReanimeId = cache.reanime_id || null;
        cachedLinkkfId = cache.linkkf_id || null;
      }
    }
  } catch (e) {
    console.warn("[videoResolver] DB cache lookup error:", e);
  }

  const workOverrides = await getWorkMatchOverrides();
  const reservedIds = await getReservedReanimeIdsForOtherWorks(anissiaId);
  const reservedForAnotherWork = (id: string) => reservedIds.has(id.replace(/^re_/, "")) || workOverrides.some(row =>
    row.reanimeId === id.replace(/^re_/, "") && row.anissiaNo !== anissiaId);
  if (cachedReanimeId && reservedForAnotherWork(cachedReanimeId)) cachedReanimeId = null;
  const selectedReanimeId = anissiaId === null ? null
    : (await getEffectiveReanimeIdsForAnissia([anissiaId])).get(anissiaId) || null;
  const hasCatalogCandidates=await hasWorkMatchCandidates(anissiaId);
  if (selectedReanimeId) cachedReanimeId = selectedReanimeId;
  else if(hasCatalogCandidates)cachedReanimeId=null;

  // 제목/원제 메타데이터가 없는 경우 애니시아 상세 API로 보강
  let korTitle = title || "";
  let jpTitle = originalTitle || "";

  if (anissiaId !== null && (!korTitle || !jpTitle)) {
    try {
      const res = await fetch(`https://api.anissia.net/anime/animeNo/${anissiaId}`, {
        headers: HEADERS,
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const j = await res.json();
        if (j?.data) {
          korTitle = korTitle || j.data.subject || "";
          jpTitle = jpTitle || j.data.originalSubject || "";
        }
      }
    } catch {}
  }

  // 과거 작품은 Anissia 원제가 비어 있는 경우가 많다. 같은 한국어 제목의
  // OVA/후속 항목에서 공통 일본어 원제를 복구해 ReAnime 매칭에 사용한다.
  const requestedWorkTitles = [korTitle, jpTitle].filter(Boolean);
  const requestedJapaneseTitle = jpTitle;
  const relatedJapaneseTitles = jpTitle || anissiaId === null ? [] : await findRelatedJapaneseTitles(anissiaId, korTitle);
  if (!jpTitle && relatedJapaneseTitles.length > 0) jpTitle = relatedJapaneseTitles[0];

  const targetSeason = parseSeason(korTitle) || parseSeason(jpTitle);
  const episodeHint = (detail: AnimeDetail) => reviewedVideoStart(animeId || `ani_${anissiaId}`, detail.id) ?? subtitleEpisodeStart;
  const videoEpisode = (detail: AnimeDetail | null): number | null => {
    if (!detail) return null;
    const numbers = detail.sub_episodes.map(e => e.number);
    const sourceSeason = parseSeason(detail.title) || parseSeason(detail.original_title || "");
    const start = videoEpisodeStart(numbers, episodeHint(detail), targetSeason, sourceSeason, seasonEpisodeCount);
    return mapVideoEpisode(episodeNumber, numbers, episodeHint(detail), targetSeason, sourceSeason,
      start && start > 1 ? seasonEpisodeCount : undefined);
  };
  const recordLatestReanimeEpisode = (detail: AnimeDetail | null) => {
    if (!detail?.sub_episodes?.length) return;
    const episodes = detail.sub_episodes.map((e) => e.number);
    const start = videoEpisodeStart(episodes, episodeHint(detail), targetSeason,
      parseSeason(detail.title) || parseSeason(detail.original_title || ""), seasonEpisodeCount);
    if (start === null) return;
    const latest = toLocalEpisode(Math.max(...episodes), start);
    if (latest !== null) latestAvailableEp = Math.max(latestAvailableEp || 0,
      seasonEpisodeCount ? Math.min(latest, seasonEpisodeCount) : latest);
  };

  const playbackCatalog = (detail: AnimeDetail, source: NonNullable<EpisodeStreamInfo["video_source"]>, episodes?: EpisodeItem[]) => ({
    video_source: source,
    video_episodes: (episodes || videoEpisodeList(detail.sub_episodes, episodeHint(detail), targetSeason,
      parseSeason(detail.title) || parseSeason(detail.original_title || ""), seasonEpisodeCount))
      .map(e => ({ ...e, watch_url: `/watch/${animeId || `ani_${anissiaId}`}/${e.number}?video_source=${source}` })),
  });


  // 최신 업로드 회차 번호 추적 (부족한 회차 안내용)
  let latestAvailableEp: number | null = null;

  // ==========================================================
  // Step 2: 1순위 ReAnime 1080p 고화질 탐색
  // ==========================================================
  try {
    if (!requestedSource || requestedSource === "rean") {
    let reanimeId = cachedReanimeId;

    // Reviewed/manual DB links stay authoritative, including merged-season
    // projections. Unreviewed cache and search results must prove identity.
    let identity: Promise<{ aliases: string[]; anilistId: number | null }> | null = null;
    const getIdentity = () => identity ||= (async () => {
      const work = await getAnimeWorkIdentity(animeId || (anissiaId ? `ani_${anissiaId}` : ""));
      const aliases = [...new Set([...(work?.titles || []), ...requestedWorkTitles])];
      const meta = await fetchAniListMeta(requestedJapaneseTitle || korTitle).catch(() => null);
      const verifiedMeta = meta && [meta.nativeTitle, meta.romajiTitle]
        .some(value => matchesIdentityTitle(value || "", aliases));
      if (verifiedMeta) aliases.push(...[meta.nativeTitle, meta.romajiTitle].filter(Boolean));
      return { aliases: [...new Set(aliases)], anilistId: verifiedMeta && meta.anilistId > 0 ? meta.anilistId : null };
    })();
    const matchesWork = async (candidate: Parameters<typeof matchesVideoPlaybackIdentity>[0]) => {
      const proof = await getIdentity();
      return matchesVideoPlaybackIdentity(candidate, proof.aliases, proof.anilistId,
        !!targetSeason && targetSeason > 1 && Number(subtitleEpisodeStart) > 1);
    };

    if (reanimeId) {
      const detail = await reanimeProvider.getAnimeDetail(reanimeId);
      if (!detail || (!selectedReanimeId && !await matchesWork(detail))) {
        // Never reuse or refresh a stale cache pointing to another work.
        reanimeId = null;
      } else {
        recordLatestReanimeEpisode(detail);
        if (videoEpisode(detail) === null) reanimeId = null;
      }
    }

    if (!reanimeId && !selectedReanimeId && !hasCatalogCandidates) {
      const { aliases } = await getIdentity();
      // Complete aliases preserve named specials, seasons and punctuation.
      // No prefix truncation and no character-class "Season" stripping.
      const romanAliases = aliases.filter(q => /^[a-z0-9]{4,}$/.test(normalizeIdentityTitle(q)));
      const searchQueries = [...new Set([requestedJapaneseTitle, ...romanAliases, ...aliases])]
        .filter(q => q.length >= 2).slice(0, 6);
      const examined = new Set<string>();
      for (const q of searchQueries) {
        let searchRes;
        try { searchRes = await reanimeProvider.searchAnime(q); }
        catch { continue; }
        const playable = [];
        for (const candidate of searchRes.items || []) {
          if (examined.has(candidate.id) || reservedForAnotherWork(candidate.id)) continue;
          if (!await matchesWork(candidate)) continue;
          examined.add(candidate.id);
          const detail = await reanimeProvider.getAnimeDetail(candidate.id);
          if (!detail || !await matchesWork(detail)) continue;
          recordLatestReanimeEpisode(detail);
          if (videoEpisode(detail) !== null) playable.push(candidate.id);
        }
        // Ambiguous full-title matches require a reviewed link, not ordering.
        if (playable.length > 1) break;
        if (playable.length === 1) {
          reanimeId = playable[0];
          break;
        }
      }
    }

    if (reanimeId) {
      const detail = await reanimeProvider.getAnimeDetail(reanimeId);
      if (detail && detail.sub_episodes.length > 0) {
        // 해당 회차 번호에 맞는 watch_url 탐색
        const epItem = detail.sub_episodes.find((e) => e.number === videoEpisode(detail));

        if (epItem?.watch_url) {
          const stream = await reanimeProvider.getEpisodeStream(epItem.watch_url);
          if (stream && (stream.embed_url || stream.player_url || stream.m3u8_url)) {
            serverSources.push({
              label: "ReAnime 1080p (고화질)",
              player_url: epItem.watch_url,
              id: "rean",
            });

            // 실제로 유효한 스트림을 획득했을 때만 DB에 영구 캐싱
            if (anissiaId !== null) {
              setAnissiaStreamCache({
                anissia_id: anissiaId,
                reanime_id: reanimeId,
              }).catch(() => {});
            }

            return {
              ...stream,
              ...playbackCatalog(detail, "rean"),
              server_sources: serverSources,
            };
          }
        }
      }
    }
    }
  } catch (err) {
    console.warn("[videoResolver] ReAnime stream attempt failed:", err);
  }

  // ==========================================================
  // Step 3: Anikoto 해외 스트림 폴백
  // ==========================================================
  try {
    if (!requestedSource || requestedSource === "anikoto") {
      // Prefer the reviewed DB identity over title search. Multi mappings carry
      // explicit episode ranges, so season 1/2 pages can share one Anikoto
      // source without exposing the other season's episode numbers.
      const linkedCandidates = animeId
        ? await getAnikotoPlaybackCandidates(animeId, episodeNumber, true)
        : [];

      let automaticIdentity: Promise<{ aliases: string[]; anilistId: number | null }> | null = null;
      const getAutomaticIdentity = () => automaticIdentity ||= (async () => {
        const work = await getAnimeWorkIdentity(animeId || (anissiaId ? `ani_${anissiaId}` : ""));
        const aliases = [...new Set([...(work?.titles || []), ...requestedWorkTitles])];
        const hasCatalogRomanTitle = work?.titles.some(value => /^[a-z0-9]{4,}$/.test(normalizeIdentityTitle(value)));
        const meta = hasCatalogRomanTitle ? null
          : await fetchAniListMeta(requestedJapaneseTitle || korTitle).catch(() => null);
        const verifiedMeta = meta && [meta.nativeTitle, meta.romajiTitle]
          .some(value => matchesIdentityTitle(value || "", aliases));
        if (verifiedMeta) aliases.push(...[meta.nativeTitle, meta.romajiTitle].filter(Boolean));
        return { aliases: [...new Set(aliases)], anilistId: verifiedMeta && meta.anilistId > 0 ? meta.anilistId : null };
      })();

      const linkedDetails = new Map<string, AnimeDetail>();
      await Promise.allSettled([...new Set(linkedCandidates.map(c => c.animeId))].map(async id => {
        const detail = await anikotoProvider.getAnimeDetail(id);
        if (detail) linkedDetails.set(id, detail);
      }));
      // Reviewed ranges/manual links are authoritative. Imported automatic
      // links need the same work proof as a fresh search before contributing
      // either a stream or a playlist.
      const usableLinks = [];
      for (const linked of linkedCandidates) {
        if (["reviewed", "multi_reviewed"].includes(linked.linkStatus)) {
          usableLinks.push(linked);
          continue;
        }
        const detail = linkedDetails.get(linked.animeId);
        if (!detail) continue;
        const proof = await getAutomaticIdentity();
        if (matchesVideoPlaybackIdentity(detail, proof.aliases, proof.anilistId,
          linked.mappingKind === "whole" && !!targetSeason && targetSeason > 1 && Number(subtitleEpisodeStart) > 1)) {
          usableLinks.push(linked);
        }
      }
      const linkedEpisodes = new Map<number, EpisodeItem>();
      for (const linked of usableLinks) {
        const detail = linkedDetails.get(linked.animeId);
        if (!detail) continue;
        const episodes = linked.mappingKind === "whole"
          ? videoEpisodeList(detail.sub_episodes, episodeHint(detail), targetSeason,
              parseSeason(detail.title) || parseSeason(detail.original_title || ""), seasonEpisodeCount)
          : detail.sub_episodes.flatMap(e => {
              if (linked.sourceStart === undefined || linked.targetStart === undefined || linked.targetEnd === undefined) return [];
              const number = linked.targetStart + e.number - linked.sourceStart;
              return number >= linked.targetStart && number <= linked.targetEnd
                ? [{ ...e, number, title: e.title?.replace(/^\d+화/, `${number}화`) || `${number}화` }] : [];
            });
        for (const e of episodes) if (!linkedEpisodes.has(e.number)) linkedEpisodes.set(e.number, e);
      }

      for (const linked of usableLinks) {
        if (linked.episodeNumber < 1) continue;
        const detail = linkedDetails.get(linked.animeId);
        if (!detail?.sub_episodes?.length) continue;

        const sourceEpisode = linked.mappingKind === "whole" ? videoEpisode(detail) : linked.episodeNumber;
        const epItem = detail.sub_episodes.find(episode => episode.number === sourceEpisode);
        if (!epItem?.watch_url) continue;

        const stream = await anikotoProvider.getEpisodeStream(epItem.watch_url);
        if (stream && (stream.embed_url || stream.player_url || stream.m3u8_url)) {
          return {
            ...stream,
            ...playbackCatalog(detail, "anikoto", linkedEpisodes.size ? [...linkedEpisodes.values()].sort((a,b) => a.number-b.number) : undefined),
            server_sources: stream.server_sources?.length
              ? stream.server_sources
              : [{ label: "Anikoto · DB 연결", player_url: epItem.watch_url, id: "anikoto" }],
          };
        }
      }

      const { aliases, anilistId } = await getAutomaticIdentity();
      const searchQueries = [...new Set(aliases)].filter(q => q.length >= 2).slice(0, 6);
      const candidates = new Set<string>();
      const searchResults = await Promise.allSettled(searchQueries.map(query => anikotoProvider.searchAnime(query, 1)));
      for (const result of searchResults) {
        if (result.status !== "fulfilled") continue;
        for (const candidate of result.value.items.slice(0, 20)) {
          if (matchesVideoPlaybackIdentity(candidate, aliases, anilistId, false)) {
            candidates.add(candidate.id);
          }
        }
      }

      const playable = [];
      for (const id of candidates) {
        const detail = await anikotoProvider.getAnimeDetail(id);
        // Recheck the detail page: a search label must not disguise a different
        // work. Complete titles preserve sequel, season, OVA and movie suffixes.
        if (!detail || !matchesVideoPlaybackIdentity(detail, aliases, anilistId, false)) continue;
        const sourceEpisode = videoEpisode(detail);
        const epItem = detail.sub_episodes.find(episode => episode.number === sourceEpisode);
        if (epItem?.watch_url) playable.push({ epItem, detail });
      }
      // Duplicate title matches need a reviewed DB link, not result-order luck.
      if (playable.length === 1) {
        const { epItem, detail } = playable[0];
        const stream = await anikotoProvider.getEpisodeStream(epItem.watch_url);
        if (stream && (stream.embed_url || stream.player_url || stream.m3u8_url)) {
          return {
            ...stream,
            ...playbackCatalog(detail, "anikoto"),
            server_sources: stream.server_sources?.length
              ? stream.server_sources
              : [{ label: "Anikoto", player_url: epItem.watch_url, id: "anikoto" }],
          };
        }
      }

    }
  } catch (err) {
    console.warn("[videoResolver] Anikoto stream attempt failed:", err);
  }

  // ==========================================================
  // Step 4: Linkkf 자체자막 스트림 폴백
  // ==========================================================
  try {
    if (!requestedSource || requestedSource === "linkkf") {
    let linkkfId = cachedLinkkfId;

    if (!linkkfId && korTitle) {
      const cleanKor = korTitle.replace(SUBTITLE_DELIMITERS, "").trim();
      const lkRes = await linkkfProvider.searchAnime(cleanKor);
      if (lkRes.items && lkRes.items.length > 0) {
        linkkfId = lkRes.items[0].id;
      }
    }

    if (linkkfId) {
      const detail = await linkkfProvider.getAnimeDetail(linkkfId);
      if (detail && detail.sub_episodes.length > 0) {
        const epItem = detail.sub_episodes.find((e) => e.number === videoEpisode(detail));

        if (epItem?.watch_url) {
          const stream = await linkkfProvider.getEpisodeStream(epItem.watch_url);
          if (stream && (stream.m3u8_url || stream.player_url)) {
            serverSources.push({
              label: "Linkkf (자체자막)",
              player_url: epItem.watch_url,
              id: "linkkf",
            });

            if (anissiaId !== null) {
              setAnissiaStreamCache({
                anissia_id: anissiaId,
                linkkf_id: linkkfId,
              }).catch(() => {});
            }

            return {
              ...stream,
              ...playbackCatalog(detail, "linkkf"),
              server_sources: serverSources,
            };
          }
        }
      }
    }
    }
  } catch (err) {
    console.warn("[videoResolver] Linkkf fallback attempt failed:", err);
  }

  // ==========================================================
  // Step 5: Ohli24 예비 스트림 폴백
  // ==========================================================
  try {
    if (!requestedSource || requestedSource === "ohli24") {
    if (korTitle) {
      const cleanKor = korTitle.replace(SUBTITLE_DELIMITERS, "").trim();
      const ohRes = await ohli24Provider.searchAnime(cleanKor);
      if (ohRes.items && ohRes.items.length > 0) {
        const ohliId = ohRes.items[0].id;
        const detail = await ohli24Provider.getAnimeDetail(ohliId);
        if (detail && detail.sub_episodes.length > 0) {
          const epItem = detail.sub_episodes.find((e) => e.number === videoEpisode(detail));

          if (epItem?.watch_url) {
            const stream = await ohli24Provider.getEpisodeStream(epItem.watch_url);
            if (stream && (stream.m3u8_url || stream.player_url)) {
              serverSources.push({
                label: "Ohli24",
                player_url: epItem.watch_url,
                id: "ohli24",
              });

              if (anissiaId !== null) {
                setAnissiaStreamCache({
                  anissia_id: anissiaId,
                  ohli24_id: ohliId,
                }).catch(() => {});
              }

              return {
                ...stream,
                ...playbackCatalog(detail, "ohli24"),
                server_sources: serverSources,
              };
            }
          }
        }
      }
    }
    }
  } catch (err) {
    console.warn("[videoResolver] Ohli24 fallback attempt failed:", err);
  }

  // 스트림을 찾지 못한 경우 상세 원인 및 최신 등록 회차 정보 반환
  let unsupportedReason = "해당 회차 영상 소스가 아직 업로드되지 않았거나 연결이 원활하지 않습니다.";
  if (latestAvailableEp && latestAvailableEp < episodeNumber) {
    unsupportedReason = `해당 작품은 현재 해외 스트리밍 서버에 ${latestAvailableEp}화까지만 등록되어 있어, ${episodeNumber}화 영상은 등록 대기 중입니다.`;
  } else if (!latestAvailableEp) {
    unsupportedReason = "해당 작품(웹 숏폼/유튜브 전용 등)은 외부 스트리밍 제공처에 영상이 등록되지 않았거나 지원되지 않는 작품입니다.";
  }

  return {
    success: false,
    m3u8_url: "",
    vtt_url: "",
    player_url: "",
    server_sources: [],
    link_next: "",
    link_pre: "",
    max_available_ep: latestAvailableEp || undefined,
    unsupported_reason: unsupportedReason,
  };
}
