import { EpisodeStreamInfo, ServerSource } from "../providers/types";
import { reanimeProvider } from "../providers/reanime";
import { linkkfProvider } from "../providers/linkkf";
import { ohli24Provider } from "../providers/ohli24";
import { anikotoProvider } from "../providers/anikoto";
import { getAnissiaStreamCache, setAnissiaStreamCache } from "../db";
import { fetchAniListMeta } from "../providers/anissia";

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
  const m1 = text.match(/(\d+)\s*기/);
  if (m1) return parseInt(m1[1], 10);
  const m2 = text.match(/season\s*(\d+)/i);
  if (m2) return parseInt(m2[1], 10);
  const m3 = text.match(/(\d+)(?:st|nd|rd|th)\s*season/i);
  if (m3) return parseInt(m3[1], 10);

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

/**
 * 검색 대상 작품들 중 시즌이 가장 잘 일치하는 아이템을 우선 선정
 */
function selectBestReanimeItem(items: any[], targetSeason: number | null): any {
  if (items.length === 0) return null;
  if (targetSeason && targetSeason > 1) {
    // targetSeason (예: 3)이 포함된 아이템 우선 탐색
    const seasonMatch = items.find((item) => {
      const s = parseSeason(item.title);
      return s === targetSeason;
    });
    if (seasonMatch) return seasonMatch;
  }

  // 시즌 1이거나 타겟 시즌이 없는 경우 1기 또는 본편 우선
  const firstSeason = items.find((item) => {
    const s = parseSeason(item.title);
    return !s || s === 1;
  });
  return firstSeason || items[0];
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
  requestedSource?: "rean" | "anikoto" | "linkkf" | "ohli24"
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
  const relatedJapaneseTitles = jpTitle || anissiaId === null ? [] : await findRelatedJapaneseTitles(anissiaId, korTitle);
  if (!jpTitle && relatedJapaneseTitles.length > 0) jpTitle = relatedJapaneseTitles[0];

  const targetSeason = parseSeason(korTitle) || parseSeason(jpTitle);

  // 최신 업로드 회차 번호 추적 (부족한 회차 안내용)
  let latestAvailableEp: number | null = null;

  // ==========================================================
  // Step 2: 1순위 ReAnime 1080p 고화질 탐색
  // ==========================================================
  try {
    if (!requestedSource || requestedSource === "rean") {
    let reanimeId = cachedReanimeId;

    // 캐시된 ID가 있다면 해당 회차가 실제로 존재하는지 검증
    if (reanimeId) {
      const detail = await reanimeProvider.getAnimeDetail(reanimeId);
      if (detail?.sub_episodes && detail.sub_episodes.length > 0) {
        const maxEp = Math.max(...detail.sub_episodes.map((e) => e.number));
        if (maxEp > 0) latestAvailableEp = maxEp;
      }
      const hasEpisode = detail?.sub_episodes?.some((e) => e.number === episodeNumber);
      if (!hasEpisode) {
        // 캐시된 ID에 해당 회차가 없으면 캐시 무효화 후 새로 탐색
        reanimeId = null;
      }
    }

    if (!reanimeId) {
      const cleanJp = jpTitle ? jpTitle.replace(SUBTITLE_DELIMITERS, "").trim() : "";
      const baseJp = cleanJp
        ? cleanJp
            .replace(
              /[第期シーズンSeason]+|\d+기|\d+th|[ⅠⅡⅢⅣⅤⅥ]|(?:part\s*)?(?:VI|IV|V|III|II|I)/gi,
              ""
            )
            .trim()
        : "";

      // AniList 메타데이터 조회하여 영어/로마자 타이틀 보강
      const meta = await fetchAniListMeta(cleanJp || jpTitle || korTitle);
      const romajiClean = meta?.romajiTitle ? meta.romajiTitle.replace(SUBTITLE_DELIMITERS, "").trim() : "";

      // 일본어 원제 및 AniList 로마자 위주로 검색 쿼리 구성 (영어/일어 DB인 ReAnime 특성 반영)
      const searchQueries = [
        cleanJp,
        baseJp,
        romajiClean,
        jpTitle,
        ...relatedJapaneseTitles,
      ].filter((q): q is string => Boolean(q && q.length >= 2));

      for (const q of searchQueries) {
        const searchRes = await reanimeProvider.searchAnime(q);
        if (searchRes.items && searchRes.items.length > 0) {
          const best = selectBestReanimeItem(searchRes.items, targetSeason);
          if (best) {
            // 해당 후보가 요청한 회차를 가지고 있는지 검증
            const candidateDetail = await reanimeProvider.getAnimeDetail(best.id);
            if (candidateDetail?.sub_episodes && candidateDetail.sub_episodes.length > 0) {
              const maxEp = Math.max(...candidateDetail.sub_episodes.map((e) => e.number));
              if (maxEp > 0) {
                latestAvailableEp = Math.max(latestAvailableEp || 0, maxEp);
              }
            }
            if (candidateDetail?.sub_episodes?.some((e) => e.number === episodeNumber)) {
              reanimeId = best.id;
              break;
            }
          }
        }
      }
    }

    if (reanimeId) {
      const detail = await reanimeProvider.getAnimeDetail(reanimeId);
      if (detail && detail.sub_episodes.length > 0) {
        // 해당 회차 번호에 맞는 watch_url 탐색
        const epItem = detail.sub_episodes.find((e) => e.number === episodeNumber);

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
      const meta = await fetchAniListMeta(jpTitle || korTitle).catch(() => null);
      const searchQueries = [
        jpTitle,
        meta?.romajiTitle || "",
        korTitle,
      ].filter((q, index, arr): q is string => Boolean(q && q.length >= 2) && arr.indexOf(q) === index);

      for (const query of searchQueries) {
        const searchRes = await anikotoProvider.searchAnime(query, 1);
        if (!searchRes.items.length) continue;

        const candidates = targetSeason
          ? [
              ...searchRes.items.filter((item) => parseSeason(item.title) === targetSeason),
              ...searchRes.items.filter((item) => parseSeason(item.title) !== targetSeason),
            ]
          : searchRes.items;

        for (const candidate of candidates.slice(0, 5)) {
          const detail = await anikotoProvider.getAnimeDetail(candidate.id);
          if (!detail?.sub_episodes?.length) continue;

          const epItem = detail.sub_episodes.find((episode) => episode.number === episodeNumber);
          if (!epItem?.watch_url) continue;

          const stream = await anikotoProvider.getEpisodeStream(epItem.watch_url);
          if (stream && (stream.embed_url || stream.player_url || stream.m3u8_url)) {
            return {
              ...stream,
              server_sources: stream.server_sources?.length
                ? stream.server_sources
                : [{ label: "Anikoto", player_url: epItem.watch_url, id: "anikoto" }],
            };
          }
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
        const epItem = detail.sub_episodes.find((e) => e.number === episodeNumber);

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
          const epItem = detail.sub_episodes.find((e) => e.number === episodeNumber);

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
