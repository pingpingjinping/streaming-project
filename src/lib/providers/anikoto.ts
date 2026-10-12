import * as cheerio from "cheerio";
import { fetchHtmlWithChromium } from "@/lib/chromiumFetch";
import { DEFAULT_ANIKOTO_URL, getAnikotoBaseUrl } from "@/lib/db";
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
import { anikotoCatalogUrl, type AnikotoCatalogParams } from "@/lib/anikotoCatalog";

export const ANIKOTO_BASE_URL = DEFAULT_ANIKOTO_URL;

const PAGE_TIMEOUT_MS = 16_000;
const PAGE_CACHE_TTL_MS = 60_000;
const DETAIL_CACHE_TTL_MS = 30_000;
const DETAIL_CACHE_LIMIT = 128;
const detailCache = new Map<string, { detail: AnimeDetail; expires: number }>();
const detailPending = new Map<string, Promise<AnimeDetail | null>>();
const episodeRefreshPending = new Map<string, Promise<string | null>>();
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

export async function getBaseUrl(): Promise<string> {
  return await getAnikotoBaseUrl();
}

function absoluteUrl(value: string, baseUrl = DEFAULT_ANIKOTO_URL): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return trimmed;
  }
}

function extractSlug(href: string, baseUrl = DEFAULT_ANIKOTO_URL): string {
  if (!href) return "";
  try {
    const url = new URL(href, baseUrl);
    const match = url.pathname.match(/^\/watch\/([^/]+)/i);
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  } catch {
    const match = href.match(/\/watch\/([^/?#]+)/i);
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  }
}

function parseCards(html: string, baseUrl: string): AnimeListItem[] {
  const $ = cheerio.load(html);
  const items = new Map<string, AnimeListItem>();

  $("#list-items .item").each((_, el) => {
    const anchor = $(el).find('a[href*="/watch/"]').first();
    const href = anchor.attr("href")?.trim() || "";
    const slug = extractSlug(href, baseUrl);
    if (!slug || items.has(slug)) return;

    const title =
      $(el).find(".name,.d-title").first().text().trim() ||
      anchor.attr("title")?.trim() ||
      anchor.find("img").first().attr("alt")?.trim() ||
      slug.replace(/[-_]+/g, " ");

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
      original_title: anchor.attr("data-jp")?.trim() || undefined,
      poster: absoluteUrl(rawPoster, baseUrl),
      detail_url: `/anime/${id}`,
      remarks: "",
    });
  });

  if (items.size === 0 && $("#list-items").length === 0) {
    $('a[href*="/watch/"]').each((_, el) => {
      const href = $(el).attr("href")?.trim() || "";
      const slug = extractSlug(href, baseUrl);
      if (!slug || items.has(slug)) return;

      const title =
        $(el).find(".name,.d-title,h1,h2,h3,h4,.title").first().text().trim() ||
        $(el).attr("title")?.trim() ||
        $(el).find("img").first().attr("alt")?.trim() ||
        "";

      if (!title) return;

      const img = $(el).find("img").first();
      const rawPoster = img.attr("data-src") || img.attr("data-original") || img.attr("src") || "";
      const id = toAnikotoId(slug);
      items.set(slug, {
        id,
        title,
        poster: absoluteUrl(rawPoster, baseUrl),
        detail_url: `/anime/${id}`,
        remarks: "",
      });
    });
  }

  return [...items.values()];
}

function responseCookies(response: Response): string {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [response.headers.get("set-cookie") || ""];
  return values
    .filter(Boolean)
    .map((value) => value.split(";")[0])
    .join("; ");
}

async function anikotoRequest(
  url: string,
  options: {
    referer?: string;
    ajax?: boolean;
    cookie?: string;
  } = {}
): Promise<{ text: string; cookie: string }> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "en-US,en;q=0.9",
      Accept: options.ajax
        ? "application/json, text/javascript, */*; q=0.01"
        : "text/html,application/xhtml+xml,*/*;q=0.8",
      ...(options.referer ? { Referer: options.referer } : {}),
      ...(options.ajax ? { "X-Requested-With": "XMLHttpRequest" } : {}),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
    },
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Anikoto upstream failed: ${response.status} ${response.statusText}`);
  }

  return {
    text: await response.text(),
    cookie: [options.cookie || "", responseCookies(response)].filter(Boolean).join("; "),
  };
}

function providerResult(payload: any): any {
  if (!payload || Number(payload.status) !== 200 || payload.result === undefined) {
    throw new Error("Invalid Anikoto AJAX response");
  }
  return payload.result;
}

function parseCatalog(html: string, baseUrl: string, page: number): AnimeListResponse {
  const $ = cheerio.load(html);
  if (!$("#list-items").length) throw new Error("Anikoto catalog HTML did not contain its list container");
  const items = parseCards(html, baseUrl);
  let totalPages = page;
  let hasNext = false;
  $(".pagination a[href]").each((_, el) => {
    const link = new URL($(el).attr("href")!, baseUrl);
    const linkedPage = Number(link.searchParams.get("page"));
    if (link.origin !== new URL(baseUrl).origin || !Number.isInteger(linkedPage) || linkedPage < 1) return;
    totalPages = Math.max(totalPages, linkedPage);
    if (linkedPage > page) hasNext = true;
  });
  return { items, page, has_next: hasNext, total_pages: totalPages };
}

async function getCatalog(params: AnikotoCatalogParams): Promise<AnimeListResponse> {
  const page = Math.max(1, Math.trunc(Number(params.page)) || 1);
  const baseUrl = await getBaseUrl();
  const url = anikotoCatalogUrl(baseUrl, { ...params, page });

  try {
    // /filter includes cards and pagination in its HTML. Avoid launching a
    // browser on Pi when a normal request can already read the complete list.
    try {
      const response = await anikotoRequest(url, { referer: baseUrl });
      return parseCatalog(response.text, baseUrl, page);
    } catch {}
    const html = await fetchHtmlWithChromium(url, {
      timeoutMs: PAGE_TIMEOUT_MS,
      cacheTtlMs: PAGE_CACHE_TTL_MS,
    });
    return parseCatalog(html, baseUrl, page);
  } catch (error) {
    console.error("[Anikoto] getCatalog error:", error);
    return { items: [], page, has_next: false, total_pages: page,
      error: "Anikoto 작품 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요." };
  }
}

export async function getAnimeList(params: AnimeListFilterParams): Promise<AnimeListResponse> {
  return getCatalog(params);
}

export async function getAnimeListFiltered(params: AnimeListFilterParams): Promise<AnimeListResponse> {
  return getCatalog(params);
}

export async function searchAnime(keyword: string, page = 1, options: Pick<AnimeListFilterParams, "year" | "sort" | "genre" | "typeLang" | "status"> = {}): Promise<AnimeListResponse> {
  const trimmed = keyword.trim();
  if (!trimmed || trimmed === "*") {
    return getCatalog({ ...options, page });
  }

  const catalog = await getCatalog({ ...options, page, keyword: trimmed });
  if (!catalog.error) return catalog;

  // Quick search has no paging or filters. Only use it for an unfiltered
  // first-page search after catalog transport fails, never for a true empty list.
  if (page !== 1 || options.genre || options.year || options.typeLang || options.status || (options.sort && options.sort !== "default")) return catalog;
  const baseUrl = await getBaseUrl();
  try {
    const url = `${baseUrl}/ajax/anime/search?keyword=${encodeURIComponent(trimmed)}`;
    const { text } = await anikotoRequest(url, { referer: baseUrl, ajax: true });
    const result = providerResult(JSON.parse(text));
    const html = typeof result === "string" ? result : String(result?.html || "");
    return { items: parseCards(html, baseUrl), page, has_next: false, total_pages: 1 };
  } catch { return catalog; }
}

function parseEpisodeNumber(value: string): number | null {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function episodeWatchUrl(canonical: string, slug: string, token: string): string {
  const url = new URL(`${canonical.replace(/\/+$/, "")}/ep-${encodeURIComponent(slug)}`);
  url.searchParams.set("__ak_token", token);
  return url.toString();
}

function copyDetail(detail: AnimeDetail): AnimeDetail {
  return { ...detail, genres: [...detail.genres],
    sub_episodes: detail.sub_episodes.map(e => ({ ...e })),
    dub_episodes: detail.dub_episodes.map(e => ({ ...e })) };
}

async function readAnimeDetail(animeId: string, refresh = false): Promise<AnimeDetail | null> {
  const slug = stripAnikotoId(animeId);
  if (!slug) return null;
  const baseUrl = await getBaseUrl();
  const key = `${baseUrl}|${slug}`;
  const cached = detailCache.get(key);
  if (!refresh && cached && cached.expires > Date.now()) return copyDetail(cached.detail);
  detailCache.delete(key);
  const existing = !refresh && detailPending.get(key);
  if (existing) {
    const detail = await existing;
    return detail ? copyDetail(detail) : null;
  }
  const pending: Promise<AnimeDetail | null> = fetchAnimeDetail(slug, baseUrl).then(detail => {
    // A forced refresh supersedes any older request still in flight.
    if (detail?.sub_episodes.length && detailPending.get(key) === pending) {
      if (detailCache.size >= DETAIL_CACHE_LIMIT) detailCache.delete(detailCache.keys().next().value!);
      detailCache.set(key, { detail, expires: Date.now() + DETAIL_CACHE_TTL_MS });
    }
    return detail;
  }).finally(() => { if (detailPending.get(key) === pending) detailPending.delete(key); });
  detailPending.set(key, pending);
  const detail = await pending;
  return detail ? copyDetail(detail) : null;
}

export async function getAnimeDetail(animeId: string): Promise<AnimeDetail | null> {
  return readAnimeDetail(animeId);
}

async function fetchAnimeDetail(slug: string, baseUrl: string): Promise<AnimeDetail | null> {
  const requestedUrl = `${baseUrl}/watch/${encodeURIComponent(slug)}`;

  try {
    const show = await anikotoRequest(requestedUrl, { referer: baseUrl });
    const $ = cheerio.load(show.text);
    const watchMain = $("#watch-main").first();
    const showId = watchMain.attr("data-id")?.trim() || "";
    const canonicalRaw = watchMain.attr("data-url")?.trim() || "";

    if (!/^\d+$/.test(showId) || !canonicalRaw) {
      throw new Error("Anikoto watch page did not expose show metadata");
    }

    const canonical = absoluteUrl(canonicalRaw, baseUrl).replace(/\/+$/, "");
    const episodeListUrl = new URL(`${baseUrl}/ajax/episode/list/${showId}`);
    episodeListUrl.searchParams.set("style", "grid");
    episodeListUrl.searchParams.set("vrf", "");

    const listResponse = await anikotoRequest(episodeListUrl.toString(), {
      referer: canonical,
      ajax: true,
      cookie: show.cookie,
    });
    const result = providerResult(JSON.parse(listResponse.text));
    const episodeHtml = typeof result === "string" ? result : String(result?.html || "");
    const ep$ = cheerio.load(episodeHtml);

    const episodes: EpisodeItem[] = [];
    const seen = new Set<string>();

    ep$('a[data-num][data-ids]').each((_, el) => {
      const numberText = ep$(el).attr("data-num")?.trim() || "";
      const token = ep$(el).attr("data-ids")?.trim() || "";
      const episodeSlug = ep$(el).attr("data-slug")?.trim() || numberText;
      const hasSub = ep$(el).attr("data-sub") === "1";
      const epNum = parseEpisodeNumber(numberText);

      if (!token || epNum === null || !hasSub) return;
      const key = String(epNum);
      if (seen.has(key)) return;
      seen.add(key);

      episodes.push({
        number: epNum,
        title: `${epNum}화`,
        watch_url: episodeWatchUrl(canonical, episodeSlug, token),
      });
    });

    episodes.sort((a, b) => a.number - b.number);

    const title =
      $("h1").first().text().trim() ||
      $('meta[property="og:title"]').attr("content")?.trim() ||
      $(".name,.d-title").first().text().trim() ||
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

    return {
      id: toAnikotoId(slug),
      title,
      original_title: $("h1[data-jp],.name[data-jp],.d-title[data-jp]").first().attr("data-jp")?.trim() || undefined,
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

function cleanEpisodeUrl(watchUrl: string): { episodeUrl: string; token: string } {
  const parsed = new URL(watchUrl, DEFAULT_ANIKOTO_URL);
  const token = parsed.searchParams.get("__ak_token") || "";
  parsed.searchParams.delete("__ak_token");
  return { episodeUrl: parsed.toString(), token };
}

function parsePreferredServer(html: string): { label: string; token: string } | null {
  const $ = cheerio.load(html);
  const candidates: Array<{ label: string; token: string; kind: string }> = [];

  $("div.type").each((_, group) => {
    const kind = ($(group).attr("data-type") || "").toLowerCase();
    if (kind === "dub") return;

    const groupLabel = $(group).find("label").first().text().trim();
    $(group)
      .find("li[data-link-id]")
      .each((__, item) => {
        const token = $(item).attr("data-link-id")?.trim() || "";
        if (!token) return;
        const label = $(item).text().trim() || groupLabel || "Anikoto";
        candidates.push({ label, token, kind });
      });
  });

  if (!candidates.length) return null;

  const preferred =
    candidates.find((candidate) => /vidplay|vidstream|megaplay|mega/i.test(candidate.label)) ||
    candidates.find((candidate) => candidate.kind === "sub") ||
    candidates[0];

  return { label: preferred.label, token: preferred.token };
}

async function resolveServerEmbed(watchUrl: string): Promise<{ url: string; label: string } | null> {
  const baseUrl = await getBaseUrl();
  const { episodeUrl, token } = cleanEpisodeUrl(watchUrl);
  if (!token) return null;

  const page = await anikotoRequest(episodeUrl, { referer: baseUrl });
  const listUrl = new URL(`${baseUrl}/ajax/server/list`);
  listUrl.searchParams.set("servers", token);

  const list = await anikotoRequest(listUrl.toString(), {
    referer: episodeUrl,
    ajax: true,
    cookie: page.cookie,
  });
  const listResult = providerResult(JSON.parse(list.text));
  const serverHtml = typeof listResult === "string" ? listResult : String(listResult?.html || "");
  const server = parsePreferredServer(serverHtml);
  if (!server) return null;

  const resolveUrl = new URL(`${baseUrl}/ajax/server`);
  resolveUrl.searchParams.set("get", server.token);

  const resolved = await anikotoRequest(resolveUrl.toString(), {
    referer: episodeUrl,
    ajax: true,
    cookie: list.cookie,
  });
  const result = providerResult(JSON.parse(resolved.text));
  const raw =
    typeof result === "string"
      ? result
      : String(result?.url || result?.src || result?.embedUrl || "");

  const url = absoluteUrl(raw, baseUrl);
  return url ? { url, label: server.label } : null;
}

async function resolveCurrentServerEmbed(watchUrl: string): Promise<{ url: string; label: string } | null> {
  let initialError: unknown;
  try {
    const embed = await resolveServerEmbed(watchUrl);
    if (embed) return embed;
  } catch (error) {
    initialError = error;
  }
  const unavailable = (): null => { if (initialError) throw initialError; return null; };
  // Only playlist metadata is cached. If its episode token expired, reload
  // that exact show/episode once; never cache or reuse the signed embed URL.
  const requested = new URL(cleanEpisodeUrl(watchUrl).episodeUrl);
  const match = requested.pathname.match(/^\/watch\/([^/]+)\/ep-[^/]+\/?$/i);
  if (!match) return unavailable();
  const slug = decodeURIComponent(match[1]);
  const baseUrl = await getBaseUrl();
  const refreshKey = `${baseUrl}|${watchUrl}`;
  let refresh = episodeRefreshPending.get(refreshKey);
  if (!refresh) {
    // The source may redirect an old slug to a newer canonical watch URL.
    const cached = detailCache.get(`${baseUrl}|${slug}`) || [...detailCache.entries()]
      .find(([key, value]) => key.startsWith(`${baseUrl}|`) &&
        value.detail.sub_episodes.some(e => cleanEpisodeUrl(e.watch_url).episodeUrl === requested.toString()))?.[1];
    if (!cached) return unavailable();
    const currentEpisode = cached.detail.sub_episodes.find(e =>
      new URL(cleanEpisodeUrl(e.watch_url).episodeUrl).pathname === requested.pathname);
    if (currentEpisode?.watch_url && currentEpisode.watch_url !== watchUrl) {
      return resolveServerEmbed(currentEpisode.watch_url);
    }
    const pending: Promise<string | null> = readAnimeDetail(cached.detail.id, true).then(fresh =>
      fresh?.sub_episodes.find(e => new URL(cleanEpisodeUrl(e.watch_url).episodeUrl).pathname === requested.pathname)?.watch_url || null
    ).finally(() => { if (episodeRefreshPending.get(refreshKey) === pending) episodeRefreshPending.delete(refreshKey); });
    episodeRefreshPending.set(refreshKey, pending);
    refresh = pending;
  }
  const freshUrl = await refresh;
  if (!freshUrl || freshUrl === watchUrl) return unavailable();
  return resolveServerEmbed(freshUrl);
}

export async function getEpisodeStream(watchUrl: string): Promise<EpisodeStreamInfo | null> {
  try {
    const embed = await resolveCurrentServerEmbed(watchUrl);
    if (!embed) return null;

    const serverSources: ServerSource[] = [
      {
        id: "anikoto",
        label: `Anikoto · ${embed.label}`,
        player_url: embed.url,
      },
    ];

    return {
      success: true,
      m3u8_url: "",
      vtt_url: "",
      player_url: embed.url,
      embed_url: embed.url,
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

