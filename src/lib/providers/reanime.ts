import {
  AnimeDetail,
  AnimeListFilterParams,
  AnimeListItem,
  AnimeListResponse,
  AnimeProvider,
  EpisodeItem,
  EpisodeStreamInfo,
  ServerSource,
} from "./types";
import { REANIME_PREFIX, stripReanimeId, toReanimeId } from "./ids";
import { reviewedReanimeProjection } from "../episodeMapping";
import {
  findReanimeSearchTitles,
  findReanimeSearchTitlesFromDb,
  getBundledReanimeMatch,
} from "@/lib/reanimeMatches";
import { getReanimeBaseUrl, DEFAULT_REANIME_URL } from "@/lib/db";

export const BASE_URL = DEFAULT_REANIME_URL;

export const REANIME_GENRES: [string, string][] = [
  ["액션", "Action"],
  ["모험", "Adventure"],
  ["코미디", "Comedy"],
  ["드라마", "Drama"],
  ["판타지", "Fantasy"],
  ["이세계", "Isekai"],
  ["학원", "School"],
  ["로맨스", "Romance"],
  ["SF", "Sci-Fi"],
  ["일상", "Slice of Life"],
  ["스릴러", "Thriller"],
  ["미스터리", "Mystery"],
  ["심리", "Psychological"],
  ["초자연", "Supernatural"],
  ["스포츠", "Sports"],
  ["음악", "Music"],
  ["메카닉", "Mecha"],
  ["공포", "Horror"],
  ["마법소녀", "Mahou Shoujo"],
];

const REANIME_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Referer: "https://reanime.to/",
  Accept: "application/json, text/plain, */*",
};

// Keep recent lookups only; expiration must release memory as well as reject hits.
const detailCache = new Map<string, { data: AnimeDetail; anilistId: number; timestamp: number }>();
const streamCache = new Map<string, { data: EpisodeStreamInfo; timestamp: number }>();
let homeCache: { data: any; timestamp: number } | null = null;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const HOME_CACHE_TTL = 3 * 60 * 1000; // 3 minutes
const DETAIL_CACHE_LIMIT = 128;
const STREAM_CACHE_LIMIT = 256;

function readCache<T extends { timestamp: number }>(cache: Map<string, T>, key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp >= CACHE_TTL) {
    cache.delete(key);
    return undefined;
  }
  // Recency changes eviction order, not the ten-minute validity window.
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function pruneCache<T extends { timestamp: number }>(cache: Map<string, T>, limit: number) {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.timestamp >= CACHE_TTL) cache.delete(key);
  }
  while (cache.size > limit) cache.delete(cache.keys().next().value!);
}

function writeCache<T extends { timestamp: number }>(cache: Map<string, T>, key: string, entry: T, limit: number) {
  cache.delete(key);
  cache.set(key, entry);
  pruneCache(cache, limit);
}

export async function getBaseUrl(): Promise<string> {
  return await getReanimeBaseUrl();
}

/**
 * SvelteKit 1/2 devalue hydration helper
 */
function unflatten(data: unknown[]): any {
  if (!Array.isArray(data) || data.length === 0) return null;
  const cache = new Map<number, any>();
  function hydrate(val: any): any {
    if (typeof val !== "number") return val;
    if (cache.has(val)) return cache.get(val);
    const raw = data[val];
    if (raw === null || typeof raw !== "object") return raw;
    if (Array.isArray(raw)) {
      const arr: any[] = [];
      cache.set(val, arr);
      for (const item of raw) arr.push(hydrate(item));
      return arr;
    }
    const obj: Record<string, any> = {};
    cache.set(val, obj);
    for (const [k, v] of Object.entries(raw)) obj[k] = hydrate(v);
    return obj;
  }
  return hydrate(0);
}

/**
 * ReAnime API JSON fetcher with Cloudflare WAF bypass fallback (via Jina Reader)
 */
async function fetchReanimeJson<T = any>(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 6000
): Promise<T | null> {
  // 1순위: 직접 fetch 시도
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (res.ok) {
      return (await res.json()) as T;
    }
  } catch {
    // 403 (Cloudflare WAF) 또는 네트워크 오류 시 2순위 우회로 이동
  }

  // 2순위: Jina Reader 프록시를 통한 Cloudflare WAF 우회
  // 주의: Jina Reader에 브라우저 User-Agent를 넘기면 Cloudflare 챌린지로 차단되므로 헤더를 최소화합니다.
  try {
    const jinaRes = await fetch(`https://r.jina.ai/${url}`, {
      headers: {
        Accept: "application/json",
        "X-No-Cache": "true",
      },
      signal: AbortSignal.timeout(timeoutMs + 4000),
      cache: "no-store",
    });
    if (jinaRes.ok) {
      const jinaData = await jinaRes.json();
      const content = jinaData?.data?.content;
      if (content && typeof content === "string") {
        const cleaned = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
        try {
          return JSON.parse(cleaned) as T;
        } catch {
          const jsonMatch = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
          if (jsonMatch) {
            return JSON.parse(jsonMatch[0]) as T;
          }
        }
      }
    }
  } catch (jinaErr) {
    console.warn(`[ReAnime] Jina bypass fetch failed for ${url}:`, jinaErr);
  }

  return null;
}

export interface ReanimeArtwork {
  poster:string;banner:string;anilistId:number;romajiTitle:string;nativeTitle:string;
  description:string;genres:string[];totalEpisodes:number|null;rating:number|null;
}
const artworkCache=new Map<string,{value:ReanimeArtwork|null;expires:number}>();
const artworkPending=new Map<string,Promise<ReanimeArtwork|null>>();

// Free expired entries even when nobody requests the old work again. This is
// memory-only housekeeping, with no provider requests or persistent writes.
if (typeof setInterval === 'function') {
  const cleanupTimer = setInterval(() => {
    pruneCache(detailCache, DETAIL_CACHE_LIMIT);
    pruneCache(streamCache, STREAM_CACHE_LIMIT);
    pruneMergedSearchCache();
    const now = Date.now();
    for (const [key, entry] of artworkCache) {
      if (entry.expires <= now) artworkCache.delete(key);
    }
  }, 60_000);
  cleanupTimer.unref?.();
}

/** Fetch metadata only, without downloading episode lists or searching by title. */
export async function getReanimeArtwork(reanimeId:string):Promise<ReanimeArtwork|null> {
  const slug=stripReanimeId(reanimeId);if(!slug || !/^[a-z\d][a-z\d-]*$/i.test(slug))return null;
  const baseUrl=await getBaseUrl(),key=baseUrl+'|'+slug;
  const cached=artworkCache.get(key);if(cached && cached.expires>Date.now())return cached.value;
  if(artworkPending.has(key))return artworkPending.get(key)!;
  const pending=(async()=>{
    let value:ReanimeArtwork|null=null;
    try {
      const raw=await fetchReanimeJson<any>(`${baseUrl}/api/v1/anime/${encodeURIComponent(slug)}`,
        {...REANIME_HEADERS,Referer:`${baseUrl}/`},3000);
      if(raw && (!raw.anime_id || raw.anime_id===slug)) {
        const image=(input:unknown)=>{
          if(typeof input!=='string' || !input.trim())return '';
          try {const url=new URL(input,baseUrl);return /^https?:$/.test(url.protocol)?url.href:'';}catch{return '';}
        };
        const poster=[raw.cover_image?.extra_large,raw.cover_image?.large,raw.cover_image?.medium,raw.banner_image].map(image).find(Boolean) || '';
        if(poster)value={poster,banner:image(raw.banner_image),anilistId:Number(raw.anilist_id)||0,
          romajiTitle:raw.title?.romaji || raw.title?.english || '',nativeTitle:raw.title?.native || '',
          description:typeof raw.description==='string'?raw.description.replace(/<[^>]*>/g,''):'',
          genres:Array.isArray(raw.genres)?raw.genres.filter((g:unknown)=>typeof g==='string'):[],
          totalEpisodes:Number(raw.episodes_total)>0?Number(raw.episodes_total):null,
          rating:Number(raw.average_score)>0?Number(raw.average_score)/10:null};
      }
    }catch { /* Missing posters allow the AniList fallback. */ }
    if(artworkCache.size>=4000)artworkCache.delete(artworkCache.keys().next().value!);
    artworkCache.set(key,{value,expires:Date.now()+(value?24*60*60*1000:5*60*1000)});
    return value;
  })();
  artworkPending.set(key,pending);
  try{return await pending;}finally{artworkPending.delete(key);}
}

async function fetchHomeData(): Promise<any> {
  const now = Date.now();
  if (homeCache && now - homeCache.timestamp < HOME_CACHE_TTL) {
    return homeCache.data;
  }

  const baseUrl = await getBaseUrl();
  const headers = { ...REANIME_HEADERS, Referer: `${baseUrl}/` };

  // 1순위: 공식 순수 JSON REST API 시도 (/api/v1/home)
  try {
    const data = await fetchReanimeJson<any>(`${baseUrl}/api/v1/home`, headers);
    if (data && (Array.isArray(data.trending) || Array.isArray(data.latest_aired))) {
      homeCache = { data, timestamp: now };
      return data;
    }
  } catch (e) {
    console.warn("[ReAnime] /api/v1/home error, falling back to SvelteKit:", e);
  }

  // 2순위: SvelteKit __data.json 백업 엔드포인트
  try {
    const res = await fetch(`${baseUrl}/home/__data.json`, {
      headers,
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch home data: ${res.status}`);
    }
    const json = await res.json();
    const homeNode = json.nodes?.find((n: any) => n?.data?.[0] && "homeData" in n.data[0]);
    if (!homeNode || !homeNode.data) {
      throw new Error("Could not find homeData node in ReAnime response");
    }
    const unflattened = unflatten(homeNode.data);
    const homeData = unflattened?.homeData || {};
    homeCache = { data: homeData, timestamp: now };
    return homeData;
  } catch (err) {
    console.error("[ReAnime] fetchHomeData error:", err);
    return homeCache?.data || {};
  }
}

function mapRawItemToAnimeListItem(item: any): AnimeListItem {
  const animeId = item.anime_id || "";
  const verified = getBundledReanimeMatch(toReanimeId(animeId));
  const title =
    verified?.koreanTitle ||
    item.title?.english ||
    item.title?.romaji ||
    item.title?.native ||
    item.title?.user_preferred ||
    item.title ||
    animeId;

  const poster =
    item.cover_image?.large ||
    item.cover_image?.extra_large ||
    item.cover_image?.medium ||
    item.banner_image ||
    "";

  let remarks = "";
  if (item.episode?.episode_number) {
    remarks = `${item.episode.episode_number}화 방영`;
  } else if (item.format) {
    const epCount = item.episodes ? `${item.episodes}화` : "";
    const statusKo = item.status === "Finished" ? "완결" : (item.status === "Releasing" ? "방영중" : "");
    remarks = [item.season_year, item.format, epCount, statusKo].filter(Boolean).join(" • ");
  } else if (item.status) {
    remarks = item.status === "Finished" ? "완결" : item.status;
  }

  return {
    id: toReanimeId(animeId),
    title,
    original_title: item.title?.native || item.title?.romaji || "",
    identity_titles: [item.title?.native, item.title?.romaji, item.title?.english]
      .filter((value): value is string => typeof value === "string" && !!value.trim()),
    anilist_id: Number(item.anilist_id) || 0,
    poster,
    detail_url: `/anime/${toReanimeId(animeId)}`,
    remarks,
    rank: item.average_score || null,
  };
}

export async function getAnimeList(params: {
  category?: "recent_caption" | "airing" | "top" | "movie" | "finished" | "trending" | "upcoming";
  page?: number;
  genre?: string;
  period?: "day" | "week" | "month" | "all";
  sort?: string;
  year?: string;
}): Promise<AnimeListResponse> {
  const page = params.page || 1;
  const rawCat = params.category;
  const category = rawCat === "recent_caption" ? "trending" : rawCat;

  try {
    // 1. 장르 필터가 지정된 경우 -> 영문 장르 매핑 후 searchAnime 호출
    if (params.genre) {
      const match = REANIME_GENRES.find(
        ([k, v]) => k === params.genre || v.toLowerCase() === params.genre?.toLowerCase()
      );
      const queryGenre = match ? match[1] : params.genre;
      return await searchAnime(queryGenre, page, { year: params.year, sort: params.sort });
    }

    // 2. 카테고리별 분기
    const homeData = await fetchHomeData();
    let rawList: any[] = [];
    let hasNext = false;
    let totalPages = 1;

    switch (params.category) {
      case "trending": {
        if (page === 1 && Array.isArray(homeData.trending) && homeData.trending.length > 0) {
          rawList = homeData.trending;
          hasNext = true;
          totalPages = 100;
        } else {
          // 2페이지 이상이거나 홈 캐시가 부족할 때는 2만편 DB 전체 페이징 API 호출
          return await searchAnime("*", page);
        }
        break;
      }
      case "upcoming": {
        const limit = 20;
        const offset = Math.max(0, (page - 1) * limit);
        const baseUrl = await getBaseUrl();
        const headers = { ...REANIME_HEADERS, Referer: `${baseUrl}/` };

        const searchJson = await fetchReanimeJson<any>(
          `${baseUrl}/api/v1/search?status=Not%20Yet%20Released&sort=popularity_desc&limit=${limit}&offset=${offset}`,
          headers
        );

        const total = Number(searchJson?.total || 0);
        totalPages = total > 0 ? Math.ceil(total / limit) : 1;
        hasNext = offset + limit < total;
        const searchResults: any[] = Array.isArray(searchJson?.results) ? searchJson.results : [];

        if (page === 1) {
          const upcomingList: any[] = Array.isArray(homeData.upcoming) ? homeData.upcoming : [];
          const seenIds = new Set(upcomingList.map((it: any) => it.anime_id));

          rawList = [...upcomingList];
          for (const item of searchResults) {
            if (!seenIds.has(item.anime_id)) {
              rawList.push(item);
              seenIds.add(item.anime_id);
            }
            if (rawList.length >= limit) break;
          }
          if (rawList.length === 0) rawList = upcomingList;
        } else {
          rawList = searchResults;
        }
        break;
      }
      case "top": {
        if (page === 1 && Array.isArray(homeData.trending) && homeData.trending.length > 0) {
          rawList = [...homeData.trending].sort((a, b) => (b.average_score || 0) - (a.average_score || 0));
          hasNext = true;
          totalPages = 50;
        } else {
          return await searchAnime("*", page);
        }
        break;
      }
      case "finished": {
        rawList = (homeData.trending || []).filter((item: any) => item.status === "Finished");
        hasNext = false;
        totalPages = 1;
        break;
      }
      case "movie": {
        return await searchAnime("Movie", page);
      }
      case "airing":
      default: {
        const limit = 20;
        const offset = Math.max(0, (page - 1) * limit);
        const baseUrl = await getBaseUrl();
        const headers = { ...REANIME_HEADERS, Referer: `${baseUrl}/` };

        // ReAnime 방영 중(status=Releasing) 최신순(sort=year_desc) API 호출
        const searchJson = await fetchReanimeJson<any>(
          `${baseUrl}/api/v1/search?status=Releasing&sort=year_desc&limit=${limit}&offset=${offset}`,
          headers
        );

        const total = Number(searchJson?.total || 0);
        totalPages = total > 0 ? Math.ceil(total / limit) : 17;
        hasNext = offset + limit < total;
        const searchResults: any[] = Array.isArray(searchJson?.results) ? searchJson.results : [];

        if (page === 1) {
          // 1페이지: 실시간 최신 방영 에피소드(latest_aired, 12편)를 최상단에 배치하고,
          // 빈자리를 방영작 검색 결과로 채워 총 20편 제공
          const latestAired: any[] = Array.isArray(homeData.latest_aired) ? homeData.latest_aired : [];
          const seenIds = new Set(latestAired.map((it: any) => it.anime_id));

          rawList = [...latestAired];
          for (const item of searchResults) {
            if (!seenIds.has(item.anime_id)) {
              rawList.push(item);
              seenIds.add(item.anime_id);
            }
            if (rawList.length >= limit) break;
          }

          if (rawList.length === 0) {
            rawList = latestAired;
          }
          if (totalPages <= 1 && total > 0) {
            totalPages = Math.ceil(total / limit);
            hasNext = total > limit;
          } else if (totalPages <= 1) {
            totalPages = 17;
            hasNext = true;
          }
        } else {
          // 2페이지 이상: 20편씩 순차 페이징 제공
          rawList = searchResults;
          if (rawList.length === 0 && page > 1) {
            return await searchAnime("*", page);
          }
        }
        break;
      }
    }

    const items = rawList.map(mapRawItemToAnimeListItem);

    return {
      items,
      page,
      has_next: hasNext,
      total_pages: totalPages,
    };
  } catch (error) {
    console.error("[ReAnime] getAnimeList error:", error);
    return { items: [], page: 1, has_next: false, total_pages: 1 };
  }
}

export async function getAnimeListFiltered(params: AnimeListFilterParams): Promise<AnimeListResponse> {
  return await getAnimeList({
    category: params.category,
    page: params.page,
    genre: params.genre,
    period: params.period,
    sort: params.sort,
    year: params.year,
  });
}

// Retain overflow from each upstream batch. Rebuild in the same round/term
// order on a cold page request; never use the UI page as each term's offset.
interface MergedSearchState {
  items: AnimeListItem[];
  seen: Set<string>;
  cursors: { term: string; offset: number; done: boolean }[];
  expires: number;
  pending?: Promise<void>;
}
const mergedSearchCache = new Map<string, MergedSearchState>();
const SEARCH_CACHE_TTL = 60_000;
const SEARCH_CACHE_LIMIT = 32;
const SEARCH_CACHE_ITEM_LIMIT = 2000;

function pruneMergedSearchCache() {
  for (const [key, state] of mergedSearchCache) {
    if (state.expires <= Date.now() && !state.pending) mergedSearchCache.delete(key);
  }
  let count = [...mergedSearchCache.values()].reduce((sum, state) => sum + state.items.length, 0);
  for (const [key, state] of mergedSearchCache) {
    if (mergedSearchCache.size <= SEARCH_CACHE_LIMIT && count <= SEARCH_CACHE_ITEM_LIMIT) break;
    if (state.pending) continue;
    mergedSearchCache.delete(key);
    count -= state.items.length;
  }
}

async function searchMergedCatalog(
  baseUrl: string, terms: string[], page: number,
  options: { year?: string; sort?: string }, headers: Record<string, string>,
): Promise<AnimeListResponse | null> {
  const limit = 20;
  const end = page * limit;
  const key = JSON.stringify([baseUrl, terms, options.year || "", options.sort || ""]);
  pruneMergedSearchCache();
  let state = mergedSearchCache.get(key);
  if (!state) {
    state = { items: [], seen: new Set(), cursors: terms.map(term => ({ term, offset: 0, done: false })),
      expires: Date.now() + SEARCH_CACHE_TTL };
  }
  mergedSearchCache.delete(key);
  mergedSearchCache.set(key, state);
  const snapshot = state;
  try {
    // A real lookahead item makes has_next reliable even when all remaining
    // upstream pages contain duplicates or items excluded by the year filter.
    while (snapshot.items.length <= end && snapshot.cursors.some(cursor => !cursor.done)) {
      if (!snapshot.pending) {
        snapshot.pending = (async () => {
          const active = snapshot.cursors.filter(cursor => !cursor.done);
          const responses = await Promise.all(active.map(async cursor => {
            const params = new URLSearchParams({ offset: String(cursor.offset), limit: String(limit) });
            if (options.year && /^\d{4}$/.test(options.year)) params.set("year", options.year);
            if (options.sort === "year_asc" || options.sort === "year_desc") params.set("sort", options.sort);
            const result = await fetchReanimeJson<any>(
              `${baseUrl}/api/v1/search?q=${encodeURIComponent(cursor.term)}&${params}`, headers);
            if (!result || !Array.isArray(result.results)) throw new Error("ReAnime search batch failed");
            return result;
          }));
          // Commit a complete round only. Failure must not advance a cursor or
          // append partial results ahead of a term that will be retried later.
          responses.forEach((response, index) => {
            const cursor = active[index];
            const raw = response.results;
            cursor.offset += raw.length;
            const total = Number(response.total);
            cursor.done = raw.length === 0 || (Number.isFinite(total) && total >= 0
              ? cursor.offset >= total : raw.length < limit);
            for (const item of raw) {
              const id = String(item.anime_id || "");
              if (!id || snapshot.seen.has(id)) continue;
              if (options.year && String(item.season_year || "") !== options.year) continue;
              snapshot.seen.add(id);
              snapshot.items.push(mapRawItemToAnimeListItem(item));
            }
          });
        })().finally(() => { snapshot.pending = undefined; });
      }
      await snapshot.pending;
    }
    // Preserve the existing title fallback only when the mapped search as a
    // whole is genuinely empty, never merely because this page is empty.
    if (!snapshot.items.length) return null;
    const exact = snapshot.cursors.every(cursor => cursor.done);
    return {
      items: snapshot.items.slice((page - 1) * limit, end), page,
      has_next: snapshot.items.length > end,
      total_pages: Math.max(1, Math.ceil(snapshot.items.length / limit)),
      total_pages_exact: exact,
    };
  } catch {
    return { items: [], page, has_next: false, total_pages: Math.max(1, page),
      total_pages_exact: false, error: "ReAnime 검색 결과를 불러오지 못했습니다. 다시 시도해 주세요." };
  } finally {
    pruneMergedSearchCache();
  }
}

export async function searchAnime(keyword: string, page = 1, options: { year?: string; sort?: string } = {}): Promise<AnimeListResponse> {
  const trimmed = keyword?.trim();
  if (!trimmed) {
    return { items: [], page: 1, has_next: false, total_pages: 1 };
  }

  page = Number.isSafeInteger(page) && page > 0 ? page : 1;
  const limit = 20;
  const offset = (page - 1) * limit;
  const filterParams = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  if (options.year && /^\d{4}$/.test(options.year)) filterParams.set("year", options.year);
  if (options.sort === "year_asc" || options.sort === "year_desc") filterParams.set("sort", options.sort);

  const searchTerms: string[] = [];
  const catalogSearchTerms = [...new Set([
    ...findReanimeSearchTitles(trimmed),
    ...await findReanimeSearchTitlesFromDb(trimmed),
  ])];

  // Stable IDs from the four-source catalog supply the original ReAnime title.
  searchTerms.push(...catalogSearchTerms);

  // 한글 검색어인 경우 애니시아(Anissia)를 통해 원제(일본어)를 최우선 검색어로 배치
  if (/[가-힣]/.test(trimmed)) {
    try {
      const aniRes = await fetch(
        `https://api.anissia.net/anime/list/0?q=${encodeURIComponent(trimmed)}`,
        { signal: AbortSignal.timeout(3500) }
      );
      if (aniRes.ok) {
        const aniData = await aniRes.json();
        const content = aniData.data?.content || [];
        const exact = content.find((it: any) => it.subject?.trim() === trimmed);
        if (exact?.originalSubject) {
          const cleanExact = exact.originalSubject.replace(/[~～〜―—–\-:：].*$/, "").trim();
          if (cleanExact && !searchTerms.includes(cleanExact)) searchTerms.push(cleanExact);
          if (!searchTerms.includes(exact.originalSubject)) searchTerms.push(exact.originalSubject);
        }
        for (const item of content.slice(0, 4)) {
          if (item.originalSubject) {
            const cleanSub = item.originalSubject.replace(/[~～〜―—–\-:：].*$/, "").trim();
            if (cleanSub && !searchTerms.includes(cleanSub)) searchTerms.push(cleanSub);
            if (!searchTerms.includes(item.originalSubject)) searchTerms.push(item.originalSubject);
          }
        }
      }
    } catch {
      // Anissia 실패 시 기본 검색어 유지
    }
  }

  if (!searchTerms.includes(trimmed)) {
    searchTerms.push(trimmed);
  }

  const baseUrl = await getBaseUrl();
  const headers = { ...REANIME_HEADERS, Referer: `${baseUrl}/` };

  // Partial Korean terms can map to several reviewed catalog rows. Search their
  // original ReAnime titles and merge the hits instead of stopping at the first,
  // often unrelated, result for a broad word such as "슬라임".
  if (catalogSearchTerms.length > 0) {
    const merged = await searchMergedCatalog(baseUrl, catalogSearchTerms.slice(0, 6), page, options, headers);
    if (merged) return merged;
  }

  // 순차 검색 시도 (결과가 발견되면 페이징 메타데이터와 함께 반환)
  for (const term of searchTerms) {
    try {
      const queryParam = term === "*" ? "*" : encodeURIComponent(term);
      const json = await fetchReanimeJson<any>(
        `${baseUrl}/api/v1/search?q=${queryParam}&${filterParams.toString()}`,
        headers
      );
      if (!json) continue;

      const rawResults = Array.isArray(json.results) ? json.results : [];
      const results = options.year ? rawResults.filter((item: any) => String(item.season_year || "") === options.year) : rawResults;
      if (results.length > 0) {
        const items = results.map(mapRawItemToAnimeListItem);
        const total = Number(json.total || results.length || 0);
        const totalPages = total > 0 ? Math.ceil(total / limit) : 1;
        const hasNext = offset + results.length < total;

        return {
          items,
          page,
          has_next: hasNext,
          total_pages: totalPages,
        };
      }
    } catch (err) {
      console.warn(`[ReAnime] searchAnime attempt for "${term}" error:`, err);
    }
  }

  return { items: [], page, has_next: false, total_pages: 1 };
}

export async function getAnimeDetail(animeId: string, options: { videoSource?: "rean" | "anikoto" | "linkkf" | "ohli24" } = {}): Promise<AnimeDetail | null> {
  const normalizedId = toReanimeId(animeId);

  // Switching players must not wait for the old provider's REST/Jina/Svelte
  // attempts. Exact catalog metadata is enough to resolve the selected source.
  if (options.videoSource && options.videoSource !== 'rean') {
    const { getLocalReanimeDetail } = await import('../localReanimeDetail');
    const local = await getLocalReanimeDetail(normalizedId);
    if (local) return local;
  }

  const cachedDetail = readCache(detailCache, normalizedId);
  if (cachedDetail) return cachedDetail.data;

  // Metadata-only catalog entries with a reviewed alternate need not probe
  // the unavailable provider first. The explicit ReAnime tab still reads live.
  if (!options.videoSource) {
    try {
      const { getLocalReanimeDetail } = await import('../localReanimeDetail');
      const local = await getLocalReanimeDetail(normalizedId, true);
      if (local) {
        const { getAnikotoPlaybackCandidates } = await import('../anikotoLinks');
        const candidates = await getAnikotoPlaybackCandidates(normalizedId, 1, true);
        if (candidates.some(row => ['manual', 'reviewed', 'multi_reviewed'].includes(row.linkStatus))) return local;
      }
    } catch { /* Older catalog databases retain the live-provider fallback. */ }
  }

  const slug = stripReanimeId(animeId);
  if (!slug) return null;

  const projection = reviewedReanimeProjection(normalizedId);
  if (projection) {
    const complete = await getAnimeDetail(projection.sourceId);
    if (!complete) return null;
    // The connection points to the complete source player. Keep every native
    // video number; the reviewed work range only identifies its subtitles.
    const episodes = complete.sub_episodes.map(e => ({ ...e,
      subtitle_episode: e.number >= projection.start && e.number <= projection.end
        ? e.number - projection.start + 1 : null }));
    const detail = { ...complete, id: normalizedId, title: projection.title, sub_episodes: episodes,
      dub_episodes: [], total_episodes: episodes.length };
    writeCache(detailCache, normalizedId, { data: detail, anilistId: complete.anilist_id || 0, timestamp: Date.now() }, DETAIL_CACHE_LIMIT);
    return detail;
  }

  const baseUrl = await getBaseUrl();
  const headers = { ...REANIME_HEADERS, Referer: `${baseUrl}/` };

  // 1순위: 공식 순수 JSON REST API 시도 (/api/v1/anime/:slug & /episodes)
  try {
    const [rawAnime, epsJson] = await Promise.all([
      fetchReanimeJson<any>(`${baseUrl}/api/v1/anime/${slug}`, headers),
      fetchReanimeJson<any>(`${baseUrl}/api/v1/anime/${slug}/episodes`, headers),
    ]);

    if (rawAnime && (rawAnime.title || rawAnime.anime_id)) {
      const rawEpisodes: any[] = Array.isArray(epsJson?.data) ? epsJson.data : [];
      const anilistId = Number(rawAnime.anilist_id || 0);

      const title =
        getBundledReanimeMatch(normalizedId)?.koreanTitle ||
        rawAnime.title?.english ||
        rawAnime.title?.romaji ||
        rawAnime.title?.native ||
        rawAnime.title?.user_preferred ||
        slug;

      const poster =
        rawAnime.cover_image?.extra_large ||
        rawAnime.cover_image?.large ||
        rawAnime.cover_image?.medium ||
        rawAnime.banner_image ||
        "";

      const subEpisodes: EpisodeItem[] = rawEpisodes.map((ep: any) => {
        const epNum = Number(ep.episode_number ?? ep.number ?? 1);
        return {
          number: epNum,
          title: ep.title ? `${epNum}화 - ${ep.title}` : `${epNum}화`,
          watch_url: `${baseUrl}/watch/${slug}?ep=${epNum}&anilist=${anilistId}`,
        };
      });

      const isFinished = rawAnime.status === "Finished";
      const statusText = isFinished ? "완결" : (rawAnime.status === "Releasing" ? "방영중" : (rawAnime.status || ""));

      const detail: AnimeDetail = {
        id: normalizedId,
        title,
        original_title: rawAnime.title?.native || rawAnime.title?.romaji || "",
        identity_titles: [rawAnime.title?.native, rawAnime.title?.romaji, rawAnime.title?.english]
          .filter((value): value is string => typeof value === "string" && !!value.trim()),
        anilist_id: anilistId,
        video_available: rawAnime.can_watch === true && anilistId > 0,
        poster,
        description: rawAnime.description ? rawAnime.description.replace(/<br\s*[\/]?>/gi, "\n") : "",
        genres: Array.isArray(rawAnime.genres) ? rawAnime.genres : [],
        sub_episodes: subEpisodes,
        dub_episodes: [],
        total_episodes: Number(rawAnime.episodes_total || rawEpisodes.length || 0),
        status_text: statusText,
        year: String(rawAnime.season_year || ""),
        is_finished: isFinished,
      };

      writeCache(detailCache, normalizedId, { data: detail, anilistId, timestamp: Date.now() }, DETAIL_CACHE_LIMIT);
      return detail;
    }
  } catch (err) {
    console.warn(`[ReAnime] REST detail failed for "${slug}", trying SvelteKit fallback:`, err);
  }

  // 2순위: SvelteKit __data.json 백업 엔드포인트
  try {
    const res = await fetch(`${baseUrl}/watch/${slug}/__data.json?ep=1`, {
      headers,
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    });

    if (!res.ok) {
      throw new Error(`Failed to load anime detail: ${res.status}`);
    }

    const json = await res.json();
    const watchNode = json.nodes?.find(
      (n: any) => n?.data?.[0] && ("anime" in n.data[0] || "episodes" in n.data[0])
    );

    if (!watchNode || !watchNode.data) {
      throw new Error("Could not find anime data node in watch response");
    }

    const unflattened = unflatten(watchNode.data);
    const rawAnime = unflattened?.anime || {};
    const rawEpisodes: any[] = Array.isArray(unflattened?.episodes) ? unflattened.episodes : [];

    const anilistId = Number(rawAnime.anilist_id || 0);

    const title =
      getBundledReanimeMatch(normalizedId)?.koreanTitle ||
      rawAnime.title?.english ||
      rawAnime.title?.romaji ||
      rawAnime.title?.native ||
      rawAnime.title?.user_preferred ||
      slug;

    const poster =
      rawAnime.cover_image?.extra_large ||
      rawAnime.cover_image?.large ||
      rawAnime.cover_image?.medium ||
      rawAnime.banner_image ||
      "";

    const subEpisodes: EpisodeItem[] = rawEpisodes.map((ep: any) => {
      const epNum = Number(ep.number ?? ep.episode_number ?? 1);
      return {
        number: epNum,
        title: ep.title ? `${epNum}화 - ${ep.title}` : `${epNum}화`,
        watch_url: `${baseUrl}/watch/${slug}?ep=${epNum}&anilist=${anilistId}`,
      };
    });

    const isFinished = rawAnime.status === "Finished";
    const statusText = isFinished ? "완결" : (rawAnime.status === "Releasing" ? "방영중" : (rawAnime.status || ""));

    const detail: AnimeDetail = {
      id: normalizedId,
      title,
      original_title: rawAnime.title?.native || rawAnime.title?.romaji || "",
      identity_titles: [rawAnime.title?.native, rawAnime.title?.romaji, rawAnime.title?.english]
        .filter((value): value is string => typeof value === "string" && !!value.trim()),
      anilist_id: anilistId,
      video_available: rawAnime.can_watch === true && anilistId > 0,
      poster,
      description: rawAnime.description ? rawAnime.description.replace(/<br\s*[\/]?>/gi, "\n") : "",
      genres: Array.isArray(rawAnime.genres) ? rawAnime.genres : [],
      sub_episodes: subEpisodes,
      dub_episodes: [],
      total_episodes: Number(rawAnime.episodes_total || rawEpisodes.length || 0),
      status_text: statusText,
      year: String(rawAnime.season_year || ""),
      is_finished: isFinished,
    };

    writeCache(detailCache, normalizedId, { data: detail, anilistId, timestamp: Date.now() }, DETAIL_CACHE_LIMIT);
    return detail;
  } catch (error) {
    console.error("[ReAnime] getAnimeDetail error:", error);
    return null;
  }
}

export async function getEpisodeStream(watchUrl: string): Promise<EpisodeStreamInfo | null> {
  const cachedStream = readCache(streamCache, watchUrl);
  if (cachedStream) return cachedStream.data;

  try {
    const baseUrl = await getBaseUrl();
    const url = new URL(watchUrl, baseUrl);
    const ep = url.searchParams.get("ep") || "1";
    let anilistIdStr = url.searchParams.get("anilist");

    if (!anilistIdStr) {
      // Fallback: extract slug and lookup detail
      const slug = url.pathname.replace(/^\/watch\/?/, "").split("/")[0];
      const detail = await getAnimeDetail(slug);
      if (detail?.anilist_id) {
        anilistIdStr = String(detail.anilist_id);
      }
    }

    if (!anilistIdStr) {
      throw new Error(`Unable to determine anilistId for watchUrl: ${watchUrl}`);
    }

    const headers = { ...REANIME_HEADERS, Referer: `${baseUrl}/` };
    const json = await fetchReanimeJson<any>(`${baseUrl}/api/flix/${anilistIdStr}/${ep}`, headers, 10000);

    if (!json || !json.success || !Array.isArray(json.servers) || json.servers.length === 0) {
      throw new Error(`Flix API returned no servers for ${anilistIdStr}/${ep}`);
    }

    const servers: any[] = json.servers;

    // Find preferred server: prefer HD-1 sub, or first available with dataLink
    const preferredServer =
      servers.find((s) => s.serverName === "HD-1" && s.dataType === "sub") ||
      servers.find((s) => s.dataType === "sub") ||
      servers.find((s) => s.dataType === "dub") ||
      servers[0];

    const embedUrl = preferredServer?.dataLink || "";

    if (!embedUrl) {
      throw new Error("No valid embed URL found from Flix servers");
    }

    const serverSources: ServerSource[] = servers.map((s) => ({
      key: `${s.dataType || "sub"}:${s.serverName || "HD"}`,
      id: "rean",
      label: `${s.serverName || "HD"} (${s.dataType || "sub"})`,
      player_url: s.dataLink,
    }));

    const result: EpisodeStreamInfo = {
      success: true,
      m3u8_url: embedUrl,
      embed_url: embedUrl,
      player_url: embedUrl,
      vtt_url: "",
      stream_type: "iframe",
      server_sources: serverSources,
      video_server: serverSources.find(server => server.player_url === embedUrl)?.key,
      video_source: "rean",
      link_next: "",
      link_pre: "",
    };

    writeCache(streamCache, watchUrl, { data: result, timestamp: Date.now() }, STREAM_CACHE_LIMIT);
    return result;
  } catch (error) {
    console.error("[ReAnime] getEpisodeStream error:", error);
    return null;
  }
}

export const reanimeProvider: AnimeProvider = {
  name: "reanime",
  displayName: "ReAnime (1080p)",
  getBaseUrl,
  getAnimeListFiltered,
  getAnimeList,
  searchAnime,
  getAnimeDetail,
  getEpisodeStream,
};

