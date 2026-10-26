import * as cheerio from "cheerio";
import { fetchLinkaniHtml } from "@/lib/linkaniFetch";
import { getLinkkfBaseUrl, DEFAULT_LINKKF_URL } from "@/lib/db";
import { isLegacyLinkkfUrl } from "@/lib/linkaniSettings";
import {
  AnimeDetail,
  AnimeListItem,
  AnimeListResponse,
  AnimeProvider,
  EpisodeItem,
  EpisodeStreamInfo,
  ServerSource,
} from "./types";

export const BASE_URL = DEFAULT_LINKKF_URL;

export async function getBaseUrl(): Promise<string> {
  return await getLinkkfBaseUrl();
}

export const LINKKF_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Referer: `${BASE_URL}/`,
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
};

export const LINKKF_GENRES: [string, string][] = [
  ["Action", "액션"],
  ["Fantasy", "판타지"],
  ["Romance", "로맨스"],
  ["Comedy", "코미디"],
  ["Slice of Life", "일상"],
  ["Sci-Fi", "SF"],
  ["School", "학원"],
  ["Mystery", "미스터리"],
  ["Adventure", "모험"],
  ["Supernatural", "초자연"],
  ["Drama", "드라마"],
  ["Horror", "공포"],
  ["Suspense", "스릴러"],
  ["Sports", "스포츠"],
  ["Music", "음악"],
  ["Gourmet", "요리"],
  ["Military", "밀리터리"],
  ["Webtoon", "웹툰"],
  ["Shounen", "소년"],
  ["Seinen", "청년"],
  ["Shoujo", "순정"],
  ["Boys Love", "BL"],
  ["Girls Love", "백합"],
  ["Avant Garde", "아방가르드"],
  ["CN Animation", "중국애니"],
];

const CURRENT_YEAR = new Date().getFullYear();
export const LINKKF_YEARS: string[] = Array.from(
  { length: Math.max(1, CURRENT_YEAR - 1989) },
  (_, i) => String(CURRENT_YEAR - i)
);

export const LINKKF_TYPES: [string, string][] = [
  ["TV", "TV 시리즈"],
  ["Movie", "Movie 극장판"],
  ["OVA", "OVA"],
];

// In-memory caches with timestamps
const detailCache: Record<string, { data: AnimeDetail; timestamp: number }> = {};
const streamCache: Record<string, { data: EpisodeStreamInfo; expires: number }> = {};

export function normalizeImageUrl(url: string | null | undefined, customBaseUrl?: string): string {
  if (!url || url.includes("loading.gif")) return "";
  const trimmed = url.trim();
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  if (trimmed.startsWith("/")) return `${customBaseUrl || BASE_URL}${trimmed}`;

  const proxyPrefixes = ["/370x/", "/550x/", "/600x/", "/720x/"];
  for (const prefix of proxyPrefixes) {
    if (trimmed.includes(prefix)) {
      const idx = trimmed.indexOf(prefix);
      const orig = trimmed.slice(idx + prefix.length);
      if (orig.startsWith("http://") || orig.startsWith("https://")) {
        return orig;
      }
    }
  }
  return trimmed;
}

export function extractAnimeId(href: string): string {
  if (!href) return "";
  const clean = href.replace(/\/+$/, "");
  const m = clean.match(/\/(?:ani|view|movie|vod)\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  return clean.split("/").pop() || "";
}

export async function getAnimeListFiltered(params: {
  section?: string;
  genre?: string;
  year?: string;
  typeLang?: string;
  page?: number;
}): Promise<AnimeListResponse> {
  const { section = "2", genre = "", year = "", typeLang = "", page = 1 } = params;
  const baseUrl = await getBaseUrl();
  const parts = [`/list/${section || "2"}/`];

  if (genre) parts.push(`class/${encodeURIComponent(genre.trim())}/`);
  if (year) parts.push(`year/${encodeURIComponent(year.trim())}/`);
  if (typeLang) parts.push(`lang/${encodeURIComponent(typeLang.trim())}/`);
  if (page > 1) parts.push(`page/${page}/`);

  const path = parts.join("").replace(/\/+/g, "/");
  const url = `${baseUrl}${path}`;

  try {
    const headers = { ...LINKKF_HEADERS, Referer: `${baseUrl}/` };
    const html = await fetchLinkaniHtml(String(url), { headers, cacheTtlMs: 60_000 });
    const $ = cheerio.load(html);
    const items: AnimeListItem[] = [];

    $("div.vod-item").each((_, el) => {
      const titleEl = $(el).find("h3.vod-item-title a, h3 a, a.search-title").first();
      if (!titleEl.length) return;

      const title = titleEl.text().trim();
      const href = titleEl.attr("href")?.trim() || "";
      const animeId = extractAnimeId(href);

      const imgEl = $(el).find(".img-wrapper, img").first();
      const rawImg = imgEl.attr("data-original") || imgEl.attr("src") || "";
      const poster = normalizeImageUrl(rawImg, baseUrl);

      const remarksEl = $(el).find(".vod-item-score, .vod-item-status, .item-status, .item-label").first();
      const remarks = remarksEl.text().trim();

      items.push({
        id: animeId,
        title,
        poster,
        detail_url: `/anime/${animeId}`,
        remarks,
      });
    });

    let maxPage = page;
    $("a[href*='/page/']").each((_, a) => {
      const href = $(a).attr("href") || "";
      const m = href.match(/\/page\/(\d+)/);
      if (m) {
        const p = parseInt(m[1], 10);
        if (p > maxPage) maxPage = p;
      }
    });

    const numText = $(".ewave-page .num, .num").first().text().trim();
    const numMatch = numText.match(/\/(\d+)/);
    if (numMatch) {
      const p = parseInt(numMatch[1], 10);
      if (p > maxPage) maxPage = p;
    }

    const hasNext = maxPage > page || items.length === 30;
    return {
      items,
      page,
      has_next: hasNext,
      total_pages: maxPage,
    };
  } catch (error) {
    console.error("[Linkani] getAnimeListFiltered error:", error);
    return { items: [], page, has_next: false, total_pages: 1 };
  }
}

export async function getAnimeList(params: {
  category?: "recent_caption" | "airing" | "top" | "movie" | "finished";
  page?: number;
  genre?: string;
  period?: "day" | "week" | "month" | "all";
}): Promise<AnimeListResponse> {
  const { category: rawCategory = "airing", page = 1, genre = "", period = "day" } = params;
  const category = rawCategory === "recent_caption" ? "airing" : rawCategory;
  const baseUrl = await getBaseUrl();
  let url = `${baseUrl}/list/2/`;

  if (category === "top") {
    if (period === "week") url = `${baseUrl}/label/week/`;
    else if (period === "month") url = `${baseUrl}/label/month/`;
    else if (period === "all") url = `${baseUrl}/label/view/`;
    else url = `${baseUrl}/label/topday/`;
  } else if (category === "movie") {
    url = page > 1 ? `${baseUrl}/list/2/lang/Movie/page/${page}/` : `${baseUrl}/list/2/lang/Movie/`;
  } else if (genre) {
    const encodedGenre = encodeURIComponent(genre.trim());
    url = page > 1 ? `${baseUrl}/list/2/class/${encodedGenre}/page/${page}/` : `${baseUrl}/list/2/class/${encodedGenre}/`;
  } else {
    url = page > 1 ? `${baseUrl}/list/2/page/${page}/` : `${baseUrl}/list/2/`;
  }

  try {
    const headers = { ...LINKKF_HEADERS, Referer: `${baseUrl}/` };
    const html = await fetchLinkaniHtml(String(url), { headers, cacheTtlMs: 60_000 });
    const $ = cheerio.load(html);
    const items: AnimeListItem[] = [];

    $("div.vod-item").each((idx, el) => {
      const titleEl = $(el).find("h3.vod-item-title a, h3 a, a.search-title").first();
      if (!titleEl.length) return;

      const title = titleEl.text().trim();
      const href = titleEl.attr("href")?.trim() || "";
      const animeId = extractAnimeId(href);

      const imgEl = $(el).find(".img-wrapper, img").first();
      const rawImg = imgEl.attr("data-original") || imgEl.attr("src") || "";
      const poster = normalizeImageUrl(rawImg, baseUrl);

      const remarksEl = $(el).find(".vod-item-score, .vod-item-status, .item-status, .item-label").first();
      let remarks = remarksEl.text().trim();
      const rank = category === "top" ? idx + 1 : null;
      if (category === "top" && !remarks) {
        remarks = `${rank}위`;
      }

      items.push({
        id: animeId,
        title,
        poster,
        detail_url: `/anime/${animeId}`,
        remarks,
        rank,
      });
    });

    let maxPage = page;
    $("a[href*='/page/']").each((_, a) => {
      const href = $(a).attr("href") || "";
      const m = href.match(/\/page\/(\d+)/);
      if (m) {
        const p = parseInt(m[1], 10);
        if (p > maxPage) maxPage = p;
      }
    });

    const numText = $(".ewave-page .num, .num").first().text().trim();
    const numMatch = numText.match(/\/(\d+)/);
    if (numMatch) {
      const p = parseInt(numMatch[1], 10);
      if (p > maxPage) maxPage = p;
    }

    const hasNext = maxPage > page || (items.length === 30 && category !== "top");
    return {
      items,
      page,
      has_next: hasNext,
      total_pages: maxPage,
    };
  } catch (error) {
    console.error("[Linkani] getAnimeList error:", error);
    return { items: [], page, has_next: false, total_pages: 1 };
  }
}

export async function searchAnime(keyword: string, page = 1): Promise<AnimeListResponse> {
  const trimmed = keyword.trim();
  if (!trimmed) {
    return { items: [], page: 1, has_next: false, total_pages: 1 };
  }

  const baseUrl = await getBaseUrl();
  // Linkani's form uses query parameters; the old /wd/... path returns an
  // unfiltered catalog even with HTTP 200.
  const url = new URL(`${baseUrl}/view/`);
  url.searchParams.set("wd", trimmed);
  if (page > 1) url.searchParams.set("page", String(page));

  try {
    const headers = { ...LINKKF_HEADERS, Referer: `${baseUrl}/` };
    const html = await fetchLinkaniHtml(String(url), { headers, cacheTtlMs: 60_000 });
    const $ = cheerio.load(html);
    const items: AnimeListItem[] = [];

    $("div.vod-item").each((_, el) => {
      const titleEl = $(el).find("h3.vod-item-title a, h3 a, a.search-title").first();
      if (!titleEl.length) return;

      const title = titleEl.text().trim();
      const href = titleEl.attr("href")?.trim() || "";
      const animeId = extractAnimeId(href);

      const imgEl = $(el).find(".img-wrapper, img").first();
      const rawImg = imgEl.attr("data-original") || imgEl.attr("src") || "";
      const poster = normalizeImageUrl(rawImg, baseUrl);

      const remarksEl = $(el).find(".vod-item-score, .vod-item-status, .item-status, .item-label").first();
      const remarks = remarksEl.text().trim();

      items.push({
        id: animeId,
        title,
        poster,
        detail_url: `/anime/${animeId}`,
        remarks,
      });
    });

    let maxPage = page;
    $(".ewave-page a[href]").each((_, a) => {
      const href = $(a).attr("href") || "";
      const pageUrl = new URL(href, baseUrl);
      const p = Number(pageUrl.searchParams.get("page") || href.match(/\/page\/(\d+)/)?.[1] || 1);
      if (Number.isInteger(p) && p > maxPage) maxPage = p;
    });

    const numText = $(".ewave-page .num, .num").first().text().trim();
    const numMatch = numText.match(/\/(\d+)/);
    if (numMatch) {
      const p = parseInt(numMatch[1], 10);
      if (p > maxPage) maxPage = p;
    }

    const hasNext = maxPage > page;
    return {
      items,
      page,
      has_next: hasNext,
      total_pages: maxPage,
    };
  } catch (error) {
    console.error("[Linkani] searchAnime error:", error);
    return { items: [], page, has_next: false, total_pages: 1 };
  }
}

export async function getAnimeDetail(animeId: string): Promise<AnimeDetail | null> {
  const cached = detailCache[animeId];
  if (cached && Date.now() - cached.timestamp < 300_000) {
    return cached.data;
  }

  const baseUrl = await getBaseUrl();
  const url = `${baseUrl}/ani/${animeId}/`;
  try {
    const headers = { ...LINKKF_HEADERS, Referer: `${baseUrl}/` };
    const html = await fetchLinkaniHtml(url, { headers, cacheTtlMs: 120_000 });
    const $ = cheerio.load(html);

    const titleEl = $(".detail-info-title, h1.title, .page-title").first();
    const title = titleEl.text().trim();

    const imgEl = $(".detail-img img, .detail-pic img, .img-wrapper img, .poster img, img.lazyload").first();
    const rawImg = imgEl.attr("data-original") || imgEl.attr("data-src") || imgEl.attr("src") || "";
    const poster = normalizeImageUrl(rawImg, baseUrl);

    const descEl = $(".detail-desc-content, .detail-desc, .desc").first();
    const description = descEl.text().trim();

    const genres: string[] = [];
    $(".detail-info-desc li, .info-list li").each((_, li) => {
      if ($(li).text().includes("장르")) {
        $(li).find("a").each((__, a) => {
          const g = $(a).text().trim();
          if (g) genres.push(g);
        });
      }
    });

    const subEpisodes: EpisodeItem[] = [];
    let epLinks1 = $(".episode-box ul#ewave-playlist-1 a.ep, #playlist1 a.ep");
    if (!epLinks1.length) {
      epLinks1 = $(".episode-box a.ep");
    }

    epLinks1.each((_, a) => {
      const epText = $(a).text().trim();
      const href = $(a).attr("href")?.trim() || "";
      const watchUrl = href.startsWith("/") ? `${baseUrl}${href}` : href;
      const m = epText.match(/\d+/);
      const epNum = m ? parseInt(m[0], 10) : 1;

      subEpisodes.push({
        number: epNum,
        title: epText.includes("화") ? epText : `${epNum}화`,
        watch_url: watchUrl,
      });
    });

    subEpisodes.sort((a, b) => a.number - b.number);

    const dubEpisodes: EpisodeItem[] = [];
    const epLinks2 = $(".episode-box ul#ewave-playlist-2 a.ep, #playlist2 a.ep");
    epLinks2.each((_, a) => {
      const epText = $(a).text().trim();
      const href = $(a).attr("href")?.trim() || "";
      const watchUrl = href.startsWith("/") ? `${baseUrl}${href}` : href;
      const m = epText.match(/\d+/);
      const epNum = m ? parseInt(m[0], 10) : 1;

      dubEpisodes.push({
        number: epNum,
        title: `${epNum}화 (더빙)`,
        watch_url: watchUrl,
      });
    });

    dubEpisodes.sort((a, b) => a.number - b.number);

    let statusText = "";
    let yearText = "";
    $(".detail-info-desc li, .info-list li, .data li").each((_, li) => {
      const txt = $(li).text().trim();
      if (txt.includes("총화수")) {
        statusText = txt.replace("총화수：", "").replace("총화수:", "").trim();
      } else if (txt.includes("년")) {
        yearText = txt.replace("년 ：", "").replace("년:", "").trim();
      }
    });

    let isFinished = false;
    const mCount = statusText.match(/(\d+)\s*(?:Rip)?\s*\/\s*(\d+)/);
    if (mCount) {
      const curC = parseInt(mCount[1], 10);
      const maxC = parseInt(mCount[2], 10);
      if (curC >= maxC) isFinished = true;
    } else if (
      title.includes("[BD]") ||
      title.toUpperCase().split(" ").includes("BD") ||
      title.includes("극장판") ||
      title.includes("Movie") ||
      title.includes("OVA")
    ) {
      isFinished = true;
    } else if (
      yearText &&
      !yearText.includes(String(CURRENT_YEAR)) &&
      !yearText.includes(String(CURRENT_YEAR - 1))
    ) {
      isFinished = true;
    }

    const detail: AnimeDetail = {
      id: animeId,
      title,
      poster,
      description,
      genres,
      sub_episodes: subEpisodes,
      dub_episodes: dubEpisodes,
      total_episodes: subEpisodes.length,
      status_text: statusText,
      year: yearText,
      is_finished: isFinished,
    };

    detailCache[animeId] = { data: detail, timestamp: Date.now() };
    return detail;
  } catch (error) {
    console.error("[Linkani] getAnimeDetail error:", error);
    return null;
  }
}

export async function getEpisodeStream(watchUrl: string): Promise<EpisodeStreamInfo | null> {
  const baseUrl = await getBaseUrl();
  if (isLegacyLinkkfUrl(watchUrl)) {
    const old = new URL(watchUrl);
    watchUrl = `${baseUrl}${old.pathname}${old.search}`;
  }
  const cached = streamCache[watchUrl];
  if (cached && Date.now() < cached.expires) {
    return cached.data;
  }
  delete streamCache[watchUrl];

  try {
    const headers = { ...LINKKF_HEADERS, Referer: `${baseUrl}/` };
    const html = await fetchLinkaniHtml(watchUrl, { headers, cacheTtlMs: 0 });
    const $ = cheerio.load(html);

    const serverSources: ServerSource[] = [];
    $(".btn-switch-server").each((_, b) => {
      const label = $(b).text().trim();
      const dataUrl = $(b).attr("data-url")?.trim() || "";
      if (dataUrl) serverSources.push({ label, player_url: dataUrl });
    });

    let playerData: Record<string, unknown> = {};
    $("script").each((_, s) => {
      const content = $(s).html() || "";
      if (content.includes("player_aaaa")) {
        const match = content.match(/var\s+player_aaaa\s*=\s*(\{[\s\S]*?\});/);
        if (match) {
          try {
            playerData = JSON.parse(match[1]);
          } catch {}
        }
      }
    });

    let actualPlayerUrl = (playerData.actual_url as string) || (playerData.url as string) || "";
    if (!actualPlayerUrl && serverSources.length > 0) {
      actualPlayerUrl = serverSources[0].player_url;
    }

    if (!actualPlayerUrl) return null;
    actualPlayerUrl = new URL(actualPlayerUrl, watchUrl).toString();

    const playerHeaders = {
      "User-Agent": LINKKF_HEADERS["User-Agent"],
      Referer: watchUrl,
    };

    // Linkani supplies a signed HLS URL directly, rather than an HTML player.
    // Preserve the HTML-player fallback for custom mirrors.
    const isDirectStream = /\.m3u8(?:[?#]|$)/i.test(actualPlayerUrl);
    let pHtml = "";
    if (!isDirectStream) {
      pHtml = await fetchLinkaniHtml(actualPlayerUrl, { headers: playerHeaders, cacheTtlMs: 0 });
    }

    let m3u8Url = isDirectStream ? actualPlayerUrl : "";
    const m3u8Match = pHtml.match(/(?:url|videoUrl)\s*:\s*["']([^"']+\.m3u8[^"']*)["']/) || pHtml.match(/["']([^"']+\.m3u8[^"']*)["']/);

    if (m3u8Match) {
      const rawM3u8 = m3u8Match[1].trim();
      if (rawM3u8.startsWith("//")) {
        const parsed = new URL(actualPlayerUrl);
        m3u8Url = `${parsed.protocol}${rawM3u8}`;
      } else {
        m3u8Url = new URL(rawM3u8, actualPlayerUrl).toString();
      }
    }

    let vttUrl = typeof playerData.subtitle_url === "string" && playerData.subtitle_url
      ? new URL(playerData.subtitle_url, watchUrl).toString()
      : "";
    const vttMatch = pHtml.match(/["']file["']\s*:\s*["']([^"']+\.vtt[^"']*)["']/) || pHtml.match(/["']([^"']+\.vtt[^"']*)["']/);
    if (!vttUrl && vttMatch) {
      const rawVtt = vttMatch[1].trim();
      if (rawVtt.startsWith("//")) {
        const parsed = new URL(actualPlayerUrl);
        vttUrl = `${parsed.protocol}${rawVtt}`;
      } else {
        vttUrl = new URL(rawVtt, actualPlayerUrl).toString();
      }
    }

    const linkNext = (playerData.link_next as string) || "";
    const linkPre = (playerData.link_pre as string) || "";

    // Never embed an upstream Linkani player or run its scripts (including
    // P2P engines). A page without a direct HLS stream is unavailable here.
    if (!m3u8Url) return null;

    const result: EpisodeStreamInfo = {
      success: true,
      stream_type: "m3u8",
      m3u8_url: m3u8Url,
      vtt_url: vttUrl,
      player_url: isDirectStream ? watchUrl : actualPlayerUrl,
      server_sources: serverSources,
      link_next: linkNext ? new URL(linkNext, watchUrl).toString() : "",
      link_pre: linkPre ? new URL(linkPre, watchUrl).toString() : "",
      vod_data: (playerData.vod_data as Record<string, unknown>) || {},
    };

    if (m3u8Url) {
      let expires = Date.now() + 300_000;
      for (const signedUrl of [m3u8Url, vttUrl]) {
        if (!signedUrl) continue;
        const expiry = Number(new URL(signedUrl).searchParams.get("expires"));
        if (expiry > 0) expires = Math.min(expires, expiry * 1000 - 30_000);
      }
      streamCache[watchUrl] = { data: result, expires };
    }

    return result;
  } catch (error) {
    console.error("[Linkani] getEpisodeStream error:", error);
    return null;
  }
}

export const linkkfProvider: AnimeProvider = {
  name: "linkkf",
  displayName: "Linkani",
  getBaseUrl,
  getAnimeListFiltered,
  getAnimeList,
  searchAnime,
  getAnimeDetail,
  getEpisodeStream,
};
