import {
  AnimeDetail,
  AnimeListFilterParams,
  AnimeListItem,
  AnimeListResponse,
  AnimeProvider,
  EpisodeItem,
  EpisodeStreamInfo,
} from "./types";
import { ANISSIA_PREFIX, stripAnissiaId, toAnissiaId } from "./ids";
import {getConfirmedReanimeIdsForAnissia} from "../reanimeMatches";
import {getReanimeArtwork} from "./reanime";
import { localEpisodeCount, toSourceEpisode } from "../episodeMapping";
import { resolveAnissiaStream } from "../resolvers/videoResolver";

/** Parse Anissia episode labels without concatenating punctuation-separated digits.
 * Labels such as `24.9` are special/decimal episode notation, not episode 249.
 */
function parseAnissiaEpisodeNumbers(value: unknown): number[] {
  const text = String(value ?? "").trim();
  if (!text) return [];

  const numbers = new Set<number>();
  const ranges = /(?:^|[^\d])(\d{1,3})\s*(?:~|〜|–|—|-|\.\.|to)\s*(\d{1,3})(?=$|[^\d])/gi;
  let remainder = text;
  for (const match of text.matchAll(ranges)) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (start > 0 && end >= start && end - start <= 100) {
      for (let episode = start; episode <= end; episode++) numbers.add(episode);
    } else {
      if (start > 0) numbers.add(start);
      if (end > 0) numbers.add(end);
    }
  }
  remainder = remainder.replace(ranges, " ");

  // Keep only the integer portion of decimals (24.9 -> episode 24).
  for (const match of remainder.matchAll(/(?:^|[^\d])(\d{1,3})(?:\.\d+)?(?=$|[^\d])/g)) {
    const episode = Number(match[1]);
    if (episode > 0) numbers.add(episode);
  }
  return [...numbers];
}

export const ANISSIA_BASE_URL = "https://api.anissia.net";
export const ANILIST_GRAPHQL_URL = "https://graphql.anilist.co";

// 40대 한국어 장르 (12대 주요 대표 장르 + 28대 세부 서브컬처 장르)
export const ANISSIA_PRIMARY_GENRES: string[] = [
  "판타지", "이세계", "액션", "일상", "학원", "코미디",
  "로맨스", "연애", "SF", "모험", "드라마", "미스터리",
];

export const ANISSIA_ALL_GENRES: string[] = [
  "BL", "GL", "SF", "TS", "개그", "게임", "고어", "금융",
  "기타", "내정", "드라마", "로맨스", "마법소녀", "메르헨", "메카닉", "모험",
  "무협", "미소녀", "미스터리", "밀리터리", "변신", "순정", "스릴러", "스포츠",
  "시대물", "아이돌", "액션", "연애", "우주", "음악", "이세계", "일상",
  "추리", "치유", "코미디", "판타지", "패러디", "학원", "현대", "호러",
];

const DEFAULT_POSTER = "https://images.unsplash.com/photo-1578632767115-351597cf2477?w=600&auto=format&fit=crop&q=80";

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json",
};

interface AniListMeta {
  anilistId: number;
  romajiTitle: string;
  nativeTitle: string;
  poster: string;
  banner: string;
  rating: number | null;
  description: string;
  genres: string[];
  totalEpisodes: number | null;
}

// In-memory cache for AniList metadata to achieve 0ms response time
const aniListMetaCache = new Map<string, { meta: AniListMeta | null; timestamp: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory cache for Anissia schedules
let scheduleCache: { [day: number]: { data: any[]; timestamp: number } } = {};
const SCHEDULE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// In-memory master schedule mapping (animeNo -> { subject, originalSubject })
let masterScheduleCache: Map<number, { subject: string; originalSubject: string }> | null = null;
let masterScheduleTimestamp = 0;

async function getMasterScheduleMap(): Promise<Map<number, { subject: string; originalSubject: string }>> {
  const now = Date.now();
  if (masterScheduleCache && now - masterScheduleTimestamp < 30 * 60 * 1000) {
    return masterScheduleCache;
  }
  const map = new Map<number, { subject: string; originalSubject: string }>();
  try {
    const days = [0, 1, 2, 3, 4, 5, 6, 7];
    const results = await Promise.allSettled(
      days.map((d) =>
        fetch(`${ANISSIA_BASE_URL}/anime/schedule/${d}`, {
          headers: HEADERS,
          signal: AbortSignal.timeout(3000),
        }).then((r) => (r.ok ? r.json() : null))
      )
    );
    for (const r of results) {
      if (r.status === "fulfilled" && Array.isArray(r.value?.data)) {
        for (const item of r.value.data) {
          if (item?.animeNo) {
            map.set(Number(item.animeNo), {
              subject: String(item.subject || ""),
              originalSubject: String(item.originalSubject || ""),
            });
          }
        }
      }
    }
    if (map.size > 0) {
      masterScheduleCache = map;
      masterScheduleTimestamp = now;
    }
  } catch {}
  return masterScheduleCache || map;
}

/**
 * AniList GraphQL 쿼리로 초고화질 포스터, 배너, 평점, 줄거리 가져오기
 */
export async function fetchAniListMeta(searchTitle: string): Promise<AniListMeta | null> {
  if (!searchTitle || searchTitle.trim().length === 0) return null;
  const cleanTitle = searchTitle.normalize('NFKC').replace(/\s+/g,' ').trim();
  const cacheKey = cleanTitle.toLowerCase();

  const cached = aniListMetaCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < (cached.meta ? CACHE_TTL_MS : 5*60*1000)) {
    return cached.meta;
  }

  const query = `
    query ($search: String) {
      Media (search: $search, type: ANIME) {
        id
        title {
          romaji
          english
          native
        }
        coverImage {
          extraLarge
          large
          medium
        }
        bannerImage
        averageScore
        description
        genres
        episodes
      }
    }
  `;

  try {
    const res = await fetch(ANILIST_GRAPHQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables: { search: cleanTitle } }),
      signal: AbortSignal.timeout(4000),
    });

    if (!res.ok) {
      aniListMetaCache.set(cacheKey, { meta: null, timestamp: Date.now() });
      return null;
    }

    const data = await res.json();
    const media = data?.data?.Media;
    if (!media) {
      aniListMetaCache.set(cacheKey, { meta: null, timestamp: Date.now() });
      return null;
    }

    const meta: AniListMeta = {
      anilistId: Number(media.id),
      romajiTitle: media.title?.romaji || "",
      nativeTitle: media.title?.native || "",
      poster: media.coverImage?.extraLarge || media.coverImage?.large || DEFAULT_POSTER,
      banner: media.bannerImage || "",
      rating: media.averageScore ? Math.round((media.averageScore / 10) * 10) / 10 : null,
      description: media.description ? media.description.replace(/<[^>]*>/g, "") : "",
      genres: media.genres || [],
      totalEpisodes: media.episodes || null,
    };

    aniListMetaCache.set(cacheKey, { meta, timestamp: Date.now() });
    return meta;
  } catch (err) {
    return null;
  }
}

const metaKey=(animeNo:unknown,title:string)=>`${animeNo || ''}:${title}`;
async function fetchAnissiaMeta(animeNo:number,searchTitle:string,links?:Map<number,string>):Promise<AniListMeta|null> {
  const reanimeId=(links || await getConfirmedReanimeIdsForAnissia([animeNo])).get(animeNo);
  if(reanimeId) {
    const artwork=await getReanimeArtwork(reanimeId);
    if(artwork)return artwork;
  }
  return fetchAniListMeta(searchTitle);
}

/** ReAnime first, AniList only when no confirmed ReAnime poster is available. */
async function enrichWithArtwork(items:Array<{titleToSearch:string;animeNo:unknown;[k:string]:any}>):Promise<Map<string,AniListMeta>> {
  const metaMap=new Map<string,AniListMeta>();
  const targets=[...new Map(items.map(item=>[metaKey(item.animeNo,item.titleToSearch),item])).values()];
  const links=await getConfirmedReanimeIdsForAnissia(targets.map(item=>Number(item.animeNo)));
  for(let i=0;i<targets.length;i+=5)await Promise.allSettled(targets.slice(i,i+5).map(async item=>{
    const meta=await fetchAnissiaMeta(Number(item.animeNo),item.titleToSearch,links);
    if(meta)metaMap.set(metaKey(item.animeNo,item.titleToSearch),meta);
  }));
  return metaMap;
}

class AnissiaProvider implements AnimeProvider {
  readonly name = "anissia" as const;
  readonly displayName = "애니시아 허브 (추천)";

  async getBaseUrl(): Promise<string> {
    return ANISSIA_BASE_URL;
  }

  /**
   * 홈 화면 탭 및 필터 목록 조회
   */
  async getAnimeListFiltered(params: AnimeListFilterParams): Promise<AnimeListResponse> {
    const category = params.category || "recent_caption";
    const day = params.day !== undefined ? Number(params.day) : undefined;
    const genre = params.genre;

    const page = typeof params.page === "number" && params.page > 0 ? params.page : 1;

    // Anissia 전체 작품 카탈로그 (최근 자막 피드와 별도)
    if (params.catalog) {
      return genre ? await this.searchByGenre(genre, page) : await this.getAnimeCatalog(page);
    }

    // 1. ⚡ 최근 등록 자막 피드 (기본 첫 화면)
    if (category === "recent_caption") {
      return await this.getRecentCaptions(page);
    }

    // 2. 📅 요일별 편성표 (day: 0~7)
    if (category === "airing" || day !== undefined) {
      const targetDay = day !== undefined ? day : new Date().getDay();
      return await this.getScheduleByDay(targetDay);
    }

    // 3. 🔥 글로벌 인기 랭킹 (AniList Trending TOP 30)
    if (category === "trending") {
      return await this.getGlobalTrending();
    }

    // 4. 👑 국내 화제작 (삭제/대체: recent_caption으로 처리)
    if (category === "top") {
      return await this.getRecentCaptions(page);
    }

    // 5. ⭐ 역대 최고 명작 (AniList Top Rated)
    if (category === "finished") {
      return await this.getTopRated();
    }

    // 6. 🎭 장르별 탐색
    if (genre) {
      return await this.searchByGenre(genre, params.page || 1);
    }

    return await this.getRecentCaptions();
  }

  async getAnimeList(params: {
    category?: "recent_caption" | "airing" | "top" | "movie" | "finished" | "trending" | "upcoming";
    page?: number;
    genre?: string;
    period?: "day" | "week" | "month" | "all";
    sort?: string;
    day?: number | string;
  }): Promise<AnimeListResponse> {
    return await this.getAnimeListFiltered({
      category: params.category,
      page: params.page,
      genre: params.genre,
      period: params.period,
      sort: params.sort,
      day: params.day,
    });
  }

  /**
   * 1. ⚡ 최근 등록 자막 피드 (/anime/caption/recent/{page})
   */
  private async getRecentCaptions(page: number = 1): Promise<AnimeListResponse> {
    try {
      const anissiaPage = Math.max(0, page - 1);
      let res = await fetch(`${ANISSIA_BASE_URL}/anime/caption/recent/${anissiaPage}`, {
        headers: HEADERS,
        signal: AbortSignal.timeout(4000),
      });

      // 페이징 엔드포인트 실패 시 1페이지 기본 엔드포인트 fallback
      if (!res.ok && anissiaPage === 0) {
        res = await fetch(`${ANISSIA_BASE_URL}/anime/caption/recent`, {
          headers: HEADERS,
          signal: AbortSignal.timeout(4000),
        });
      }

      if (!res.ok) throw new Error(`Anissia API Error: ${res.status}`);
      const json = await res.json();

      let list: any[] = [];
      let totalPages = 1;
      let hasNext = false;

      if (json.data && Array.isArray(json.data.content)) {
        list = json.data.content;
        totalPages = Math.max(1, Number(json.data.totalPages) || 1);
        const isLast = Boolean(json.data.last);
        hasNext = !isLast && page < totalPages;
      } else if (Array.isArray(json.data)) {
        list = json.data;
        totalPages = 1;
        hasNext = false;
      }

      // 동일 작품/에피소드/제작자의 중복 등록 방지
      const seen = new Set<string>();
      const uniqueItems: any[] = [];
      for (const item of list) {
        const dedupeKey = `${item.animeNo}_${item.episode || ""}_${item.name || ""}`;
        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          uniqueItems.push(item);
        }
      }

      // 원제를 보완하고 확정된 ReAnime ID로 포스터를 먼저 조회
      const scheduleMap = await getMasterScheduleMap();
      const enrichTargets = uniqueItems.map((u) => {
        const sched = scheduleMap.get(Number(u.animeNo));
        const searchTitle = sched?.originalSubject || u.subject || "";
        return {
          titleToSearch: searchTitle,
          rawSubject: u.subject,
          animeNo: u.animeNo,
        };
      });
      const metaMap = await enrichWithArtwork(enrichTargets);

      const items: AnimeListItem[] = uniqueItems.map((item) => {
        const sched = scheduleMap.get(Number(item.animeNo));
        const searchTitle = sched?.originalSubject || item.subject || "";
        const meta = metaMap.get(metaKey(item.animeNo,searchTitle));
        const epStr = item.episode ? `${item.episode}화` : "";
        const creatorStr = item.name ? `[${item.name}]` : "";
        const remarks = [epStr, creatorStr].filter(Boolean).join(" ");
        const timeFormatted = item.updDt ? item.updDt.replace("T", " ").slice(5, 16) : "";
        const targetDetailUrl = item.episode && item.website
          ? `/watch/${toAnissiaId(item.animeNo)}/${item.episode}?source_ep=1&creator=${encodeURIComponent(item.name || "")}&sub_url=${encodeURIComponent(item.website)}`
          : `/anime/${toAnissiaId(item.animeNo)}`;

        return {
          id: toAnissiaId(item.animeNo),
          title: item.subject,
          poster: meta?.poster || DEFAULT_POSTER,
          detail_url: targetDetailUrl,
          remarks: remarks || "최신 자막 등록",
          rating: meta?.rating ?? null,
          time: timeFormatted,
          latest_ep: item.episode,
          creator_name: item.name,
          caption_url: item.website || null,
        };
      });

      return {
        items,
        page,
        has_next: hasNext,
        total_pages: totalPages,
      };
    } catch (err) {
      console.error("[AnissiaProvider] getRecentCaptions error:", err);
      return { items: [], page, has_next: false, total_pages: 0 };
    }
  }


  /**
   * 2. 📅 요일별 편성표 (/anime/schedule/{day})
   */
  private async getScheduleByDay(day: number): Promise<AnimeListResponse> {
    try {
      const now = Date.now();
      if (scheduleCache[day] && now - scheduleCache[day].timestamp < SCHEDULE_TTL_MS) {
        return {
          items: scheduleCache[day].data,
          page: 1,
          has_next: false,
          total_pages: 1,
        };
      }

      const res = await fetch(`${ANISSIA_BASE_URL}/anime/schedule/${day}`, {
        headers: HEADERS,
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) throw new Error(`Anissia API Error: ${res.status}`);
      const json = await res.json();
      const rawList = Array.isArray(json.data) ? json.data : [];

      // 확정 ReAnime 포스터 우선, 없을 때 원제로 AniList 조회
      const enrichTargets = rawList.map((item: any) => ({
        titleToSearch: item.originalSubject || item.subject,animeNo:item.animeNo,
      }));
      const metaMap = await enrichWithArtwork(enrichTargets);

      const items: AnimeListItem[] = rawList.map((item: any) => {
        const searchKey = item.originalSubject || item.subject;
        const meta = metaMap.get(metaKey(item.animeNo,searchKey));
        const timeStr = item.time || "";
        const capCount = Number(item.captionCount || 0);
        const remarks = `${timeStr} | 자막 ${capCount}명`;

        return {
          id: toAnissiaId(item.animeNo),
          title: item.subject,
          poster: meta?.poster || DEFAULT_POSTER,
          detail_url: `/anime/${toAnissiaId(item.animeNo)}`,
          remarks,
          rating: meta?.rating ?? null,
          time: timeStr,
          caption_count: capCount,
          genres: item.genres ? item.genres.split(",").map((g: string) => g.trim()) : [],
          status: item.status,
        };
      });

      scheduleCache[day] = { data: items, timestamp: now };

      return {
        items,
        page: 1,
        has_next: false,
        total_pages: 1,
      };
    } catch (err) {
      console.error("[AnissiaProvider] getScheduleByDay error:", err);
      return { items: [], page: 1, has_next: false, total_pages: 0 };
    }
  }

  /**
   * 3. 🔥 글로벌 인기 랭킹 (AniList Trending TOP 30)
   */
  private async getGlobalTrending(): Promise<AnimeListResponse> {
    try {
      const query = `
        query {
          Page(page: 1, perPage: 30) {
            media(type: ANIME, sort: [TRENDING_DESC, POPULARITY_DESC]) {
              id
              title { romaji english native }
              coverImage { extraLarge large }
              averageScore
              episodes
              genres
            }
          }
        }
      `;
      const res = await fetch(ANILIST_GRAPHQL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      const list = data?.data?.Page?.media || [];

      if (list.length === 0) {
        return await this.getDomesticPopular();
      }

      // AniList 항목들을 애니시아 검색 API로 animeNo 매칭 시도
      const items: AnimeListItem[] = await Promise.all(
        list.map(async (media: any, index: number) => {
          const nativeTitle = media.title?.native || media.title?.romaji || "";
          let animeNo: number | null = null;

          try {
            const anissiaRes = await fetch(
              `${ANISSIA_BASE_URL}/anime/list/0?q=${encodeURIComponent(nativeTitle.slice(0, 15))}`,
              { headers: HEADERS, signal: AbortSignal.timeout(2000) }
            );
            if (anissiaRes.ok) {
              const aJson = await anissiaRes.json();
              const found = aJson?.data?.content?.[0] || aJson?.data?.[0];
              if (found) animeNo = Number(found.animeNo);
            }
          } catch {}

          const id = animeNo ? toAnissiaId(animeNo) : `ani_al_${media.id}`;
          const title = media.title?.romaji || media.title?.english || media.title?.native;
          const rating = media.averageScore ? Math.round((media.averageScore / 10) * 10) / 10 : null;

          return {
            id,
            title,
            poster: media.coverImage?.extraLarge || media.coverImage?.large || DEFAULT_POSTER,
            detail_url: `/anime/${id}`,
            remarks: rating ? `⭐ ${rating}` : "인기 급상승",
            rank: index + 1,
            rating,
            genres: media.genres || [],
          };
        })
      );

      return {
        items,
        page: 1,
        has_next: false,
        total_pages: 1,
      };
    } catch (err) {
      console.error("[AnissiaProvider] getGlobalTrending error, fallback to domestic popular:", err);
      return await this.getDomesticPopular();
    }
  }

  /**
   * 4. 👑 국내 화제작 (애니시아 요일별 스케줄 중 captionCount 내림차순 TOP 30)
   */
  private async getDomesticPopular(): Promise<AnimeListResponse> {
    try {
      const days = [0, 1, 2, 3, 4, 5, 6, 7];
      const results = await Promise.allSettled(
        days.map((d) => this.getScheduleByDay(d))
      );

      const allItems: AnimeListItem[] = [];
      const seen = new Set<string>();

      for (const r of results) {
        if (r.status === "fulfilled" && Array.isArray(r.value.items)) {
          for (const item of r.value.items) {
            if (!seen.has(item.id)) {
              seen.add(item.id);
              allItems.push(item);
            }
          }
        }
      }

      // 자막 제작자 수(caption_count) 내림차순 정렬
      allItems.sort((a, b) => (b.caption_count || 0) - (a.caption_count || 0));

      const rankedItems = allItems.slice(0, 30).map((item, idx) => ({
        ...item,
        rank: idx + 1,
        remarks: `자막 제작자 ${item.caption_count || 0}명`,
      }));

      return {
        items: rankedItems,
        page: 1,
        has_next: false,
        total_pages: 1,
      };
    } catch (err) {
      console.error("[AnissiaProvider] getDomesticPopular error:", err);
      return { items: [], page: 1, has_next: false, total_pages: 0 };
    }
  }

  /**
   * 5. ⭐ 역대 최고 명작 (AniList Top Rated TOP 30)
   */
  private async getTopRated(): Promise<AnimeListResponse> {
    try {
      const query = `
        query {
          Page(page: 1, perPage: 30) {
            media(type: ANIME, sort: [SCORE_DESC]) {
              id
              title { romaji english native }
              coverImage { extraLarge large }
              averageScore
              genres
            }
          }
        }
      `;
      const res = await fetch(ANILIST_GRAPHQL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      const list = data?.data?.Page?.media || [];

      const items: AnimeListItem[] = list.map((media: any, index: number) => {
        const rating = media.averageScore ? Math.round((media.averageScore / 10) * 10) / 10 : null;
        const title = media.title?.romaji || media.title?.english || media.title?.native;
        return {
          id: `ani_al_${media.id}`,
          title,
          poster: media.coverImage?.extraLarge || media.coverImage?.large || DEFAULT_POSTER,
          detail_url: `/anime/ani_al_${media.id}`,
          remarks: `⭐ ${rating || 9.0}`,
          rank: index + 1,
          rating,
          genres: media.genres || [],
        };
      });

      return {
        items,
        page: 1,
        has_next: false,
        total_pages: 1,
      };
    } catch (err) {
      console.error("[AnissiaProvider] getTopRated error:", err);
      return { items: [], page: 1, has_next: false, total_pages: 0 };
    }
  }

  /**
   * 6. 🎭 장르별 검색 (/anime/list/0?q={genre})
   */
  private async searchByGenre(genre: string, page = 1): Promise<AnimeListResponse> {
    return await this.searchAnime(genre, page);
  }

  /** 전체 작품 카탈로그 (/anime/list/{page}) */
  private async getAnimeCatalog(page = 1): Promise<AnimeListResponse> {
    try {
      const anissiaPage = Math.max(0, page - 1);
      const res = await fetch(`${ANISSIA_BASE_URL}/anime/list/${anissiaPage}`, {
        headers: HEADERS,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`Anissia Catalog Error: ${res.status}`);
      const json = await res.json();
      const data = json?.data;
      const list = Array.isArray(data?.content) ? data.content : Array.isArray(data) ? data : [];
      const targets = list.map((item: any) => ({
        titleToSearch: item.originalSubject || item.subject || "",animeNo:item.animeNo,
      }));
      const metaMap = await enrichWithArtwork(targets);
      const items: AnimeListItem[] = list.map((item: any) => {
        const searchKey = item.originalSubject || item.subject || "";
        const meta = metaMap.get(metaKey(item.animeNo,searchKey));
        const captionCount = Number(item.captionCount || 0);
        return {
          id: toAnissiaId(item.animeNo),
          title: item.subject || searchKey,
          poster: meta?.poster || DEFAULT_POSTER,
          detail_url: `/anime/${toAnissiaId(item.animeNo)}`,
          remarks: `${captionCount ? `자막 ${captionCount}명 · ` : "자막 정보 없음 · "}${item.status === "ON" ? "방영중" : "완결"}`,
          rating: meta?.rating ?? null,
          caption_count: captionCount,
          genres: item.genres ? item.genres.split(",").map((g: string) => g.trim()) : [],
          status: item.status,
        };
      });
      const totalPages = Math.max(1, Number(data?.totalPages) || 1);
      return {
        items,
        page,
        has_next: data?.last === undefined ? page < totalPages : !Boolean(data.last),
        total_pages: totalPages,
      };
    } catch (err) {
      console.error("[AnissiaProvider] getAnimeCatalog error:", err);
      return { items: [], page, has_next: false, total_pages: 0 };
    }
  }

  /**
   * 검색 (/anime/list/{page}?q={keyword})
   */
  async searchAnime(keyword: string, page = 1): Promise<AnimeListResponse> {
    try {
      // App pagination is 1-based; Anissia API pagination is 0-based.
      const anissiaPage = Math.max(0, page - 1);
      const res = await fetch(
        `${ANISSIA_BASE_URL}/anime/list/${anissiaPage}?q=${encodeURIComponent(keyword)}`,
        { headers: HEADERS, signal: AbortSignal.timeout(4000) }
      );
      if (!res.ok) throw new Error(`Anissia Search Error: ${res.status}`);
      const json = await res.json();
      const content = json?.data?.content || json?.data || [];
      const list = Array.isArray(content) ? content : [];

      const enrichTargets = list.map((item: any) => ({
        titleToSearch: item.originalSubject || item.subject,animeNo:item.animeNo,
      }));
      const metaMap = await enrichWithArtwork(enrichTargets);

      const items: AnimeListItem[] = list.map((item: any) => {
        const searchKey = item.originalSubject || item.subject;
        const meta = metaMap.get(metaKey(item.animeNo,searchKey));
        const genres = item.genres ? item.genres.split(",").map((g: string) => g.trim()) : [];

        return {
          id: toAnissiaId(item.animeNo),
          title: item.subject,
          poster: meta?.poster || DEFAULT_POSTER,
          detail_url: `/anime/${toAnissiaId(item.animeNo)}`,
          remarks: item.status === "ON" ? "방영중" : "완결",
          rating: meta?.rating ?? null,
          genres,
        };
      });

      return {
        items,
        page,
        has_next: json?.data?.last === undefined ? items.length >= 30 : !Boolean(json.data.last),
        total_pages: Math.max(1, Number(json?.data?.totalPages) || 1),
      };
    } catch (err) {
      console.error("[AnissiaProvider] searchAnime error:", err);
      return { items: [], page: 1, has_next: false, total_pages: 0 };
    }
  }

  /**
   * 작품 상세 정보 (/anime/animeNo/{animeNo})
   */
  async getAnimeDetail(animeId: string, options: { subtitleEpisodeStart?: number | null } = {}): Promise<AnimeDetail | null> {
    const rawId = stripAnissiaId(animeId);
    const animeNo = parseInt(rawId, 10);

    if (isNaN(animeNo)) {
      return null;
    }

    try {
      const [detailRes, capRes] = await Promise.allSettled([
        fetch(`${ANISSIA_BASE_URL}/anime/animeNo/${animeNo}`, {
          headers: HEADERS,
          signal: AbortSignal.timeout(4000),
        }).then((r) => (r.ok ? r.json() : null)),
        fetch(`${ANISSIA_BASE_URL}/anime/caption/animeNo/${animeNo}`, {
          headers: HEADERS,
          signal: AbortSignal.timeout(4000),
        }).then((r) => (r.ok ? r.json() : null)),
      ]);

      const animeData = detailRes.status === "fulfilled" ? detailRes.value?.data : null;
      if (!animeData) return null;

      const captions = capRes.status === "fulfilled" && Array.isArray(capRes.value?.data) ? capRes.value.data : [];

      // 확정 ReAnime 메타데이터 우선, 없을 때 AniList 조회
      const meta = await fetchAnissiaMeta(animeNo,animeData.originalSubject || animeData.subject);

      // 에피소드 목록 추출 (자막 등록된 에피소드 번호 파싱 또는 1부터 최대 번호까지)
      const epNumbers = new Set<number>();
      for (const c of captions) {
        for (const episode of parseAnissiaEpisodeNumbers(c.episode)) epNumbers.add(episode);
      }

      // 자막 정보 맵 (회차 -> { creator, website })
      const captionMap = new Map<number, { creator: string; website: string }>();
      for (const c of captions) {
        // Only attach a post to one episode when its label names one exact integer.
        // Decimal/special labels such as 24.9 must not point at a fictitious episode 249.
        const exactEpisode = String(c.episode ?? "").trim().match(/^0*(\d+)(?:화)?$/);
        const ep = exactEpisode ? Number(exactEpisode[1]) : 0;
        if (ep > 0 && c.website) {
          if (!captionMap.has(ep)) {
            captionMap.set(ep, {
              creator: c.name || "",
              website: c.website,
            });
          }
        }
      }

      // 최대 화수 계산
      const maxEp = localEpisodeCount(epNumbers, options.subtitleEpisodeStart, meta?.totalEpisodes || 12);
      const subEpisodes: EpisodeItem[] = [];
      for (let i = 1; i <= Math.max(maxEp, 1); i++) {
        const cap = captionMap.get(toSourceEpisode(i, options.subtitleEpisodeStart));
        const watchUrl = cap
          ? `/watch/${animeId}/${i}?creator=${encodeURIComponent(cap.creator)}&sub_url=${encodeURIComponent(cap.website)}`
          : `/watch/${animeId}/${i}`;

        subEpisodes.push({
          number: i,
          title: cap?.creator ? `${i}화 [${cap.creator}]` : `${i}화`,
          watch_url: watchUrl,
          caption_url: cap?.website,
          creator_name: cap?.creator,
        });
      }

      const genres = animeData.genres
        ? animeData.genres.split(",").map((g: string) => g.trim())
        : meta?.genres || [];

      return {
        id: animeId,
        title: animeData.subject,
        poster: meta?.poster || DEFAULT_POSTER,
        banner: meta?.banner || undefined,
        description: meta?.description || animeData.note || `${animeData.subject} 애니메이션 상세 정보입니다.`,
        genres,
        sub_episodes: subEpisodes,
        dub_episodes: [],
        total_episodes: subEpisodes.length,
        status_text: animeData.status === "ON" ? "방영중" : "완결",
        year: animeData.startDate ? animeData.startDate.slice(0, 4) : "",
        is_finished: animeData.status !== "ON",
        rating: meta?.rating,
        caption_count: Number(animeData.captionCount || captions.length),
        original_title: animeData.originalSubject,
      };
    } catch (err) {
      console.error("[AnissiaProvider] getAnimeDetail error:", err);
      return null;
    }
  }

  /**
   * 에피소드 스트림 정보 (Phase 4: 스마트 비디오 리졸버 연동)
   */
  async getEpisodeStream(watchUrl: string): Promise<EpisodeStreamInfo | null> {
    const m = watchUrl.match(/ani_(\d+)\/(\d+)/) || watchUrl.match(/(\d+)\/(\d+)/);
    let animeNo = 0;
    let epNum = 1;
    if (m) {
      animeNo = parseInt(m[1], 10);
      epNum = parseInt(m[2], 10);
    }

    if (!animeNo) {
      return null;
    }

    return await resolveAnissiaStream(animeNo, epNum);
  }
}

export const anissiaProvider = new AnissiaProvider();
