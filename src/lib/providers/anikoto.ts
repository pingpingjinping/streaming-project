import * as cheerio from "cheerio";
import { fetchHtmlWithChromium } from "@/lib/chromiumFetch";
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
import { stripAnikotoId, toAnikotoId } from "./ids";

export const ANIKOTO_BASE_URL = "https://anikoto.to";

const PAGE_TIMEOUT_MS = 16_000;
const PAGE_CACHE_TTL_MS = 60_000;

export async function getBaseUrl(): Promise<string> {
  return ANIKOTO_BASE_URL;
}

function absoluteUrl(value: string, baseUrl = ANIKOTO_BASE_URL): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return trimmed;
  }
}

function extractSlug(href: string): string {
  if (!href) return "";
  try {
    const url = new URL(href, ANIKOTO_BASE_URL);
    const match = url.pathname.match(/^\/watch\/([^/]+)/i);
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  } catch {
    const match = href.match(/\/watch\/([^/?#]+)/i);
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  }
}

function parseCards(html: string): AnimeListItem[] {
  const $ = cheerio.load(html);
  const items = new Map<string, AnimeListItem>();

  $('a[href*="/watch/"]').each((_, el) => {
    const href = $(el).attr("href")?.trim() || "";
    const slug = extractSlug(href);
    if (!slug || items.has(slug)) return;

    const title =
      $(el).find("h1,h2,h3,h4,.title,.name").first().text().trim() ||
      $(el).attr("title")?.trim() ||
      $(el).find("img").first().attr("alt")?.trim() ||
      "";

    if (!title) return;

    const img = $(el).find("img").first();
    const rawPoster =
      img.attr("data-src") ||
      img.attr("data-original") ||
      img.attr("src") ||
      "";

    const id = toAnikotoId(slug);
    items.set(slug, {
      id,
      title,
      poster: absoluteUrl(rawPoster),
      detail_url: `/anime/${id}`,
      remarks: "",
    });
  });

  return [...items.values()];
}

export async function getAnimeList(params: {
  category?: "recent_caption" | "airing" | "top" | "movie" | "finished" | "trending" | "upcoming";
  page?: number;
  genre?: string;
  period?: "day" | "week" | "month" | "all";
  sort?: string;
  day?: number | string;
}): Promise<AnimeListResponse> {
  const page = Math.max(1, Number(params.page) || 1);
  const baseUrl = await getBaseUrl();

  const candidates = [
    page > 1 ? `${baseUrl}/home?page=${page}` : `${baseUrl}/home`,
    page > 1 ? `${baseUrl}/?page=${page}` : baseUrl,
  ];

  for (const url of candidates) {
    try {
      const html = await fetchHtmlWithChromium(url, {
        timeoutMs: PAGE_TIMEOUT_MS,
        cacheTtlMs: PAGE_CACHE_TTL_MS,
      });
      const items = parseCards(html);
      if (items.length > 0) {
        return {
          items,
          page,
          has_next: items.length >= 20,
          total_pages: items.length >= 20 ? page + 1 : page,
        };
      }
    } catch {}
  }

  return { items: [], page, has_next: false, total_pages: 1 };
}

export async function getAnimeListFiltered(params: AnimeListFilterParams): Promise<AnimeListResponse> {
  if (params.genre?.trim()) {
    return searchAnime(params.genre, params.page || 1);
  }
  return getAnimeList({
    category: params.category,
    page: params.page,
    genre: params.genre,
    sort: params.sort,
    day: params.day,
  });
}

export async function searchAnime(keyword: string, page = 1): Promise<AnimeListResponse> {
  const trimmed = keyword.trim();
  if (!trimmed || trimmed === "*") {
    return getAnimeList({ page });
  }

  const baseUrl = await getBaseUrl();
  const urls = [
    `${baseUrl}/filter?keyword=${encodeURIComponent(trimmed)}${page > 1 ? `&page=${page}` : ""}`,
    `${baseUrl}/search?keyword=${encodeURIComponent(trimmed)}${page > 1 ? `&page=${page}` : ""}`,
  ];

  for (const url of urls) {
    try {
      const html = await fetchHtmlWithChromium(url, {
        timeoutMs: PAGE_TIMEOUT_MS,
        cacheTtlMs: PAGE_CACHE_TTL_MS,
      });
      const items = parseCards(html);
      if (items.length > 0) {
        return {
          items,
          page,
          has_next: items.length >= 20,
          total_pages: items.length >= 20 ? page + 1 : page,
        };
      }
    } catch {}
  }

  return { items: [], page, has_next: false, total_pages: 1 };
}

function parseEpisodeNumber(value: string): number | null {
  const normalized = value.replace(/,/g, ".").trim();
  const direct = Number(normalized);
  if (Number.isFinite(direct) && direct > 0) return direct;

  const match = normalized.match(/(?:ep(?:isode)?\s*)?(\d+(?:\.\d+)?)/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function getAnimeDetail(animeId: string): Promise<AnimeDetail | null> {
  const slug = stripAnikotoId(animeId);
  if (!slug) return null;

  const baseUrl = await getBaseUrl();
  const watchUrl = `${baseUrl}/watch/${encodeURIComponent(slug)}`;

  try {
    const html = await fetchHtmlWithChromium(watchUrl, {
      timeoutMs: PAGE_TIMEOUT_MS,
      cacheTtlMs: 120_000,
    });
    const $ = cheerio.load(html);

    const title =
      $('meta[property="og:title"]').attr("content")?.trim() ||
      $("h1").first().text().trim() ||
      $("h2").first().text().trim() ||
      slug.replace(/[-_]+/g, " ");

    const poster = absoluteUrl(
      $('meta[property="og:image"]').attr("content") ||
      $(".poster img,.film-poster img,.detail img").first().attr("src") ||
      $("img").first().attr("src") ||
      "",
      baseUrl
    );

    const description =
      $('meta[name="description"]').attr("content")?.trim() ||
      $(".description,.film-description,.synopsis").first().text().trim() ||
      "";

    const episodes: EpisodeItem[] = [];
    const seen = new Set<string>();

    $("[data-number][data-id]").each((_, el) => {
      const numberText = $(el).attr("data-number")?.trim() || "";
      const epId = $(el).attr("data-id")?.trim() || "";
      const epNum = parseEpisodeNumber(numberText);
      if (!epId || epNum === null) return;

      const key = String(epNum);
      if (seen.has(key)) return;
      seen.add(key);

      const url = new URL(watchUrl);
      url.searchParams.set("epId", epId);
      url.searchParams.set("ep", String(epNum));

      episodes.push({
        number: epNum,
        title: `${epNum}화`,
        watch_url: url.toString(),
      });
    });

    $('a[href*="/watch/"][href*="ep="], a[href*="?ep="]').each((_, el) => {
      const href = $(el).attr("href")?.trim() || "";
      if (!href) return;

      let epNum: number | null = null;
      try {
        const url = new URL(href, watchUrl);
        epNum = parseEpisodeNumber(url.searchParams.get("ep") || "");
      } catch {}

      if (epNum === null) {
        epNum = parseEpisodeNumber($(el).text());
      }
      if (epNum === null) return;

      const key = String(epNum);
      if (seen.has(key)) return;
      seen.add(key);

      episodes.push({
        number: epNum,
        title: $(el).text().trim() || `${epNum}화`,
        watch_url: absoluteUrl(href, watchUrl),
      });
    });

    if (episodes.length === 0) {
      episodes.push({
        number: 1,
        title: "1화",
        watch_url: watchUrl,
      });
    }

    episodes.sort((a, b) => a.number - b.number);

    return {
      id: toAnikotoId(slug),
      title,
      poster,
      description,
      genres: [],
      sub_episodes: episodes,
      dub_episodes: [],
      total_episodes: episodes.length,
      status_text: "",
      year: "",
      is_finished: false,
    };
  } catch (error) {
    console.error("[Anikoto] getAnimeDetail error:", error);
    return null;
  }
}

async function resolveServerEmbed(watchUrl: string): Promise<string> {
  let epId = "";
  try {
    const parsed = new URL(watchUrl, ANIKOTO_BASE_URL);
    epId = parsed.searchParams.get("epId") || "";
  } catch {}

  if (epId) {
    try {
      const baseUrl = await getBaseUrl();
      const apiUrl = `${baseUrl}/api/servers?epId=${encodeURIComponent(epId)}`;
      const response = await fetch(apiUrl, {
        headers: {
          Accept: "application/json, text/plain, */*",
          Referer: watchUrl,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        },
        signal: AbortSignal.timeout(8_000),
      });

      if (response.ok) {
        const json = await response.json();
        const servers = Array.isArray(json?.servers)
          ? json.servers
          : Array.isArray(json?.data)
          ? json.data
          : [];

        const preferred =
          servers.find((server: any) =>
            ["megacloud", "vidstreaming", "streamwish"].includes(
              String(server?.name || server?.serverName || "").toLowerCase()
            )
          ) || servers[0];

        const raw = String(
          preferred?.embedUrl ||
          preferred?.embed_url ||
          preferred?.src ||
          preferred?.url ||
          ""
        ).trim();

        if (raw) return absoluteUrl(raw, baseUrl);
      }
    } catch {}
  }

  try {
    const html = await fetchHtmlWithChromium(watchUrl, {
      timeoutMs: PAGE_TIMEOUT_MS,
      cacheTtlMs: 30_000,
    });
    const $ = cheerio.load(html);
    const raw =
      $("iframe[src]").first().attr("src")?.trim() ||
      $("[data-src*='http']").first().attr("data-src")?.trim() ||
      "";

    return raw ? absoluteUrl(raw, watchUrl) : "";
  } catch {
    return "";
  }
}

export async function getEpisodeStream(watchUrl: string): Promise<EpisodeStreamInfo | null> {
  try {
    const embedUrl = await resolveServerEmbed(watchUrl);
    if (!embedUrl) return null;

    const serverSources: ServerSource[] = [
      {
        id: "anikoto",
        label: "Anikoto",
        player_url: embedUrl,
      },
    ];

    return {
      success: true,
      m3u8_url: "",
      vtt_url: "",
      player_url: embedUrl,
      embed_url: embedUrl,
      stream_type: "iframe",
      server_sources: serverSources,
      link_next: "",
      link_pre: "",
    };
  } catch (error) {
    console.error("[Anikoto] getEpisodeStream error:", error);
    return null;
  }
}

export const anikotoProvider: AnimeProvider = {
  name: "anikoto",
  displayName: "Anikoto",
  getBaseUrl,
  getAnimeListFiltered,
  getAnimeList,
  searchAnime,
  getAnimeDetail,
  getEpisodeStream,
};
