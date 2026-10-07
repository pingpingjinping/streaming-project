import * as cheerio from "cheerio";
import { decodeSubtitleBuffer, cleanSubtitleText, convertToVtt, decodeSubtitleFile } from "@/lib/subtitleCodec";
export { decodeSubtitleBuffer, cleanSubtitleText, convertToVtt, decodeSubtitleFile } from "@/lib/subtitleCodec";
import { inspectSubtitleArchive } from "@/lib/subtitleUpload";
import { EpisodeEvidence, EpisodeRequest, readEpisodeEvidence, evidenceAgrees, selectEpisodeEntries, subtitleFilenameFromUrl } from "@/lib/subtitleEpisodes";
import { getCachedKoreanAnimeTitle, saveKoreanAnimeTitleMapping, getAniAllMatches, getAniAllCandidates, getSubtitleSourcePriority, getSubtitleRejections } from "@/lib/db";
import { getMonthlyAnissiaCandidates } from "@/lib/reanimeMatches";
import { extractTistoryWinPngFiles } from "@/lib/tistoryWinPng";

export const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
};

export interface SubtitleResult {
  name: string;
  episode: number;
  orig_filename: string;
  format: "ASS" | "VTT";
  is_ass: boolean;
  content: string; // VTT text or raw ASS string
  url?: string;
  matchScore?: number;
  matchedTitle?: string;
  verifiedMatch?: boolean;
  sourceCreatorWebsite?: string;
  sourceMatchedTitle?: string;
  sourceProvider?: "aniall" | "anissia";
}

export interface CreatorInfo {
  name: string;
  episode: string;
  update_date: string;
  website: string;
  is_current_ep: boolean;
  matchScore?: number;
  matchedTitle?: string;
  verifiedMatch?: boolean;
  sourceProvider?: "aniall" | "anissia";
}

// Common Korean anime abbreviation mapping
export const ANIME_ABBREVIATIONS: Record<string, string> = {
  전생슬: "전생했더니 슬라임이었던 건에 대하여",
  전슬라: "전생했더니 슬라임이었던 건에 대하여",
  귀칼: "귀멸의 칼날",
  주술: "주술회전",
  주회: "주술회전",
  프리렌: "장송의 프리렌",
  히로아카: "나의 히어로 아카데미아",
  나히아: "나의 히어로 아카데미아",
  봇치: "봇치 더 록",
  체인소맨: "체인소 맨",
  톱맨: "체인소 맨",
  스파패: "스파이 패밀리",
  최애: "최애의 아이",
  최애의아이: "최애의 아이",
  코노스바: "이 멋진 세계에 축복을!",
  리제로: "Re: 제로부터 시작하는 이세계 생활",
  진격거: "진격의 거인",
  문스독: "문호 스트레이독스",
  단다단: "단다단",
  약사: "약사의 혼잣말",
  괴수8호: "괴수 8호",
  무직전생: "무직 전생",
  나혼렙: "나 혼자만 레벨업",
  도련님: "도망을 잘 치는 도련님",
  도망도련님: "도망을 잘 치는 도련님",
  푸른상자: "푸른 상자",
  블리치: "블리치",
  마지루미에: "주식회사 마지루미에",
  책벌레: "책벌레의 하극상",
  유녀전기: "유녀전기",
  그랑블루: "그랑블루",
  담배고양이: "담배 고양이",

  // English / Romaji popular names
  "that time i got reincarnated as a slime": "전생했더니 슬라임이었던 건에 대하여",
  "slime": "전생했더니 슬라임이었던 건에 대하여",
  "tensei shitara slime": "전생했더니 슬라임이었던 건에 대하여",
  "re:zero": "Re: 제로부터 시작하는 이세계 생활",
  "rezero": "Re: 제로부터 시작하는 이세계 생활",
  "mushoku tensei": "무직 전생",
  "jobless reincarnation": "무직 전생",
  "frieren": "장송의 프리렌",
  "demon slayer": "귀멸의 칼날",
  "kimetsu": "귀멸의 칼날",
  "jujutsu kaisen": "주술회전",
  "solo leveling": "나 혼자만 레벨업",
  "kaiju no. 8": "괴수 8호",
  "kaiju no 8": "괴수 8호",
  "dandadan": "단다단",
  "blue box": "푸른 상자",
  "ao no hako": "푸른 상자",
  "elusive samurai": "도망을 잘 치는 도련님",
  "nigejouzu": "도망을 잘 치는 도련님",
  "chainsaw man": "체인소 맨",
  "spy x family": "스파이 패밀리",
  "bocchi the rock": "봇치 더 록",
  "my hero academia": "나의 히어로 아카데미아",
  "boku no hero": "나의 히어로 아카데미아",
  "attack on titan": "진격의 거인",
  "shingeki no kyojin": "진격의 거인",
  "oshi no ko": "최애의 아이",
  "bleach": "블리치",
  "grand blue": "그랑블루",
  "magilumiere": "주식회사 마지루미에",
  "apothecary diaries": "약사의 혼잣말",
  "kusuriya": "약사의 혼잣말",
  "wind breaker": "윈드 브레이커",
  "blue lock": "블루 록",
  "smoking behind the supermarket": "슈퍼 뒤에서 담배 피우는 두 사람",
  "super no ura": "슈퍼 뒤에서 담배 피우는 두 사람",
  "yani neko": "담배 고양이",
  "mebius dust": "뫼비우스 더스트",
  "moebius dust": "뫼비우스 더스트",
};

// Memory cache for resolved Korean titles to avoid redundant fetches
const koreanTitleCache = new Map<string, string>();

// Prefer a NamuWiki article ID when an exact English Wikidata alias matches.
// If that ID is absent, accept only a unique Korean label on the same entity.
function normalizeLookupTitle(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[’']/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function titleKind(value: string): "movie" | "ova" | "season" | "series" {
  if (/\b(movie|film|theatrical|gekijouban|gekijoban)\b|劇場版|극장판/i.test(value)) return "movie";
  if (/\b(ova|oad|special)\b|\b스페셜\b/i.test(value)) return "ova";
  if (/\b(?:season|part|cour)\s*\d+\b|\b\d+(?:st|nd|rd|th)\s+season\b|\d+기|第?\d+期/i.test(value)) return "season";
  return "series";
}

// Verified titles missing Korean labels and NamuWiki IDs on Wikidata.
const VERIFIED_KOREAN_TITLES = new Map([
  [normalizeLookupTitle("Ascendance of a Bookworm: Adopted Daughter of an Archduke").replace(/\s+/g, ""),
    "책벌레의 하극상 ~사서가 되기 위해서라면 뭐든지 할 수 있어~ 영주의 양녀"],
]);

async function findVerifiedKoreanTitle(rawTitle: string): Promise<{ title: string; source: string } | null> {
  const searched = normalizeLookupTitle(rawTitle);
  if (searched.length < 3) return null;
  const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(rawTitle)}&language=en&format=json&limit=10`;
  const headers = { "User-Agent": "NetizenAnime/1.0 (https://github.com/pingpingjinping/streaming-project)", Accept: "application/json" };
  const searchResponse = await fetch(url, { headers, signal: AbortSignal.timeout(6500) });
  if (!searchResponse.ok) return null;
  const searchData = await searchResponse.json();
  const ids = (searchData.search || []).map((item: { id?: string }) => item.id)
    .filter((id: unknown): id is string => typeof id === "string" && /^Q\d+$/.test(id));
  if (!ids.length) return null;
  const entityUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids.join("|")}&props=labels|aliases|claims&languages=en|ko&format=json`;
  const response = await fetch(entityUrl, { headers, signal: AbortSignal.timeout(6500) });
  if (!response.ok) return null;
  const data = await response.json();
  const matches = new Map<string, string>();
  const fallbackMatches = new Set<string>();
  for (const entity of Object.values(data.entities || {}) as Array<any>) {
    const names: string[] = [entity.labels?.en?.value, ...(entity.aliases?.en || []).map((alias: { value: string }) => alias.value)]
      .filter((name): name is string => typeof name === "string");
    if (!names.some((name) => normalizeLookupTitle(name).replace(/\s+/g, "") === searched.replace(/\s+/g, ""))) continue;
    for (const claim of entity.claims?.P8885 || []) {
      const title = claim.mainsnak?.datavalue?.value;
      if (typeof title !== "string" || !/[가-힣]{2}/.test(title)) continue;
      // A franchise page must never become an OVA/movie/season subtitle search.
      if (titleKind(rawTitle) !== titleKind(title)) continue;
      if (titleKind(rawTitle) === "season" && parseSeason(rawTitle) !== parseSeason(title)) continue;
      matches.set(title, "namuwiki-id");
    }
    // Some anime have a Korean Wikidata label but no linked NamuWiki ID.
    // Matching the entire English name and requiring one unambiguous result
    // prevents the previous "first Korean label wins" false positives.
    const label = entity.labels?.ko?.value;
    if (typeof label === "string" && /[가-힣]{2}/.test(label) &&
        titleKind(rawTitle) === titleKind(label) &&
        (titleKind(rawTitle) !== "season" || parseSeason(rawTitle) === parseSeason(label))) {
      fallbackMatches.add(label);
    }
  }
  if (matches.size === 0 && fallbackMatches.size === 1) {
    matches.set([...fallbackMatches][0], "wikidata-exact");
  }
  if (matches.size !== 1) return null;
  const [title, source] = [...matches][0];
  return { title, source };
}

/** Resolve English anime titles using verified Korean titles when available. */
export async function resolveKoreanTitle(rawTitle: string): Promise<string> {
  if (!rawTitle) return "";
  const trimmed = rawTitle.trim();
  if (koreanTitleCache.has(trimmed)) return koreanTitleCache.get(trimmed)!;

  const verifiedTitle = VERIFIED_KOREAN_TITLES.get(normalizeLookupTitle(trimmed).replace(/\s+/g, ""));
  if (verifiedTitle) {
    koreanTitleCache.set(trimmed, verifiedTitle);
    await saveKoreanAnimeTitleMapping(trimmed, verifiedTitle, "verified-namuwiki");
    return verifiedTitle;
  }

  const storedTitle = await getCachedKoreanAnimeTitle(trimmed);
  if (storedTitle) {
    koreanTitleCache.set(trimmed, storedTitle);
    return storedTitle;
  }

  const lower = trimmed.toLowerCase();
  for (const [abbr, full] of Object.entries(ANIME_ABBREVIATIONS)) {
    if (!lower.includes(abbr.toLowerCase())) continue;
    // Short aliases apply only to the whole title; otherwise a movie or sequel
    // could be silently mapped to the parent series.
    if (normalizeLookupTitle(trimmed) !== normalizeLookupTitle(abbr)) continue;
    koreanTitleCache.set(trimmed, full);
    await saveKoreanAnimeTitleMapping(trimmed, full, "alias");
    return full;
  }

  if (/[가-힣]{2,}/.test(trimmed)) return trimmed;
  try {
    const found = await findVerifiedKoreanTitle(trimmed);
    if (found) {
      koreanTitleCache.set(trimmed, found.title);
      await saveKoreanAnimeTitleMapping(trimmed, found.title, found.source);
      return found.title;
    }
  } catch (error) {
    console.warn("[findVerifiedKoreanTitle warning]:", error);
  }
  koreanTitleCache.set(trimmed, trimmed);
  return trimmed;
}

// 1. Title cleaner
export function cleanTitle(text: string): string {
  if (!text) return "";
  let t = text.replace(/\[.*?\]|\(.*?\)|【.*?】|<.*?>/g, " ");
  t = t.replace(/\bBD\b/gi, " ");
  t = t.replace(/\s+\d+화(?:\s|$)/g, " ");
  t = t.replace(/[^\w\s가-힣a-zA-Z0-9~-]/g, " ");
  return t.replace(/\s+/g, " ").trim();
}

// 2. Safe filename
export function safeFilename(text: string): string {
  return text.replace(/[^a-zA-Z0-9가-힣_-]/g, "_").replace(/^_+|_+$/g, "");
}

// 3. Season parser (로마 숫자 I~VI, 유니코드 Ⅰ~Ⅵ, Part/파트, 기수 등 완벽 지원)
export function parseSeason(text: string): number | null {
  if (!text) return null;

  // 1) 유니코드 로마 숫자 (Ⅰ~Ⅹ)
  if (/Ⅹ/i.test(text)) return 10;
  if (/Ⅸ/i.test(text)) return 9;
  if (/Ⅷ/i.test(text)) return 8;
  if (/Ⅶ/i.test(text)) return 7;
  if (/Ⅵ/i.test(text)) return 6;
  if (/Ⅴ/i.test(text)) return 5;
  if (/Ⅳ/i.test(text)) return 4;
  if (/Ⅲ/i.test(text)) return 3;
  if (/Ⅱ/i.test(text)) return 2;
  if (/Ⅰ/i.test(text)) return 1;

  // 2) 단어 단위 아스키 로마 숫자 (VI, IV, III, II)
  if (/\bVI\b/i.test(text)) return 6;
  if (/\bV\b/i.test(text)) return 5;
  if (/\bIV\b/i.test(text)) return 4;
  if (/\bIII\b/i.test(text)) return 3;
  if (/\bII\b/i.test(text)) return 2;

  // 3) 파트 / Part / 시즌 / 기
  const m = text.match(/(\d+)\s*기|\b(\d+)(?:st|nd|rd|th)\b|season\s*(\d+)|\bs(\d+)\b|파트\s*(\d+)|part\s*(\d+)/i);
  if (m) {
    for (let i = 1; i <= 6; i++) {
      if (m[i]) return parseInt(m[i], 10);
    }
  }

  // 4) 한글/영문 바로 뒤 숫자 (예: 신의탑2)
  const m2 = text.match(/(?<=[가-힣a-zA-Z])([2-9])(?=\s|$|[^\w가-힣])/);
  if (m2) {
    return parseInt(m2[1], 10);
  }
  return null;
}

// 4. Episode numbers parser
export function parseEpisodes(text: string): number[] {
  if (!text) return [];
  const base = text.split(/[\\/]/).pop() || text;
  const eps = new Set<number>();

  // Range patterns: 1-12, 1~12, 01~12화
  const rangeRegex = /(?:^|[^\d])0*(\d{1,3})\s*(?:~|-|_|\.\.|to)\s*0*(\d{1,3})\s*(?:화|편|ep|e|#)?/gi;
  let match: RegExpExecArray | null;
  while ((match = rangeRegex.exec(base)) !== null) {
    const s = parseInt(match[1], 10);
    const e = parseInt(match[2], 10);
    if (s >= 1 && s < e && e <= 150 && e - s <= 100) {
      if (![720, 1080, 480].includes(s) && ![720, 1080, 480].includes(e)) {
        for (let i = s; i <= e; i++) eps.add(i);
      }
    }
  }

  // Explicit units: 01화, 1편, ep2, #3
  const explicitRegex = /(?:^|[^\d])0*(\d{1,3})\s*(?:화|편|ep|e|#)/gi;
  while ((match = explicitRegex.exec(base)) !== null) {
    const val = parseInt(match[1], 10);
    if (val >= 1 && val <= 200) eps.add(val);
  }

  // Fallback: standalone numbers after removing season tokens
  if (eps.size === 0) {
    let clean = base.replace(/\b\d+(?:st|nd|rd|th)\b/gi, " ");
    clean = clean.replace(/\b\d+\s*기\b/g, " ");
    clean = clean.replace(/season\s*\d+/gi, " ");
    clean = clean.replace(/\bs\d+\b/gi, " ");
    clean = clean.replace(/(?<=[가-힣a-zA-Z])\d(?=\s|$|\.|\-|_)/g, " ");
    // Strip standalone season number when immediately followed by episode number: " 4 01." -> " 01."
    clean = clean.replace(/(?<=[^\d]|^)\d+\s+(?=0*\d{1,3}(?:\.|\s|$))/g, " ");

    const numRegex = /(?:^|[^\d])0*(\d{1,3})(?=[^\d]|$)/g;
    while ((match = numRegex.exec(clean)) !== null) {
      const val = parseInt(match[1], 10);
      if (
        ![720, 1080, 480, 2020, 2021, 2022, 2023, 2024, 2025, 2026].includes(val) &&
        val >= 1 &&
        val <= 200
      ) {
        eps.add(val);
      }
    }
  }

  return Array.from(eps).sort((a, b) => a - b);
}

export function mapProviderEpisodeNumber(episodeLabel: string, episodeNumber: number, seasonNumber: number | null): number {
  const listedEpisodes = parseEpisodes(episodeLabel);
  if (!seasonNumber || seasonNumber <= 1 || listedEpisodes.includes(episodeNumber)) return episodeNumber;
  if (!listedEpisodes.length || episodeNumber < 1 || episodeNumber > listedEpisodes.length) return episodeNumber;
  const first = listedEpisodes[0];
  const contiguous = listedEpisodes.every((episode, index) => episode === first + index);
  return contiguous && first > 1 ? listedEpisodes[episodeNumber - 1] : episodeNumber;
}

// 7. In-memory ZIP extractor & subtitle reader
export interface SubtitleExtractionContext {
  localEpisode?: number;
  evidence?: EpisodeEvidence[];
}

export function extractSubtitleFromBuffer(
  buffer: Buffer, episodeNumber: number, urlPath: string, strictEpisode = false,
  targetSeason: number | null = null, context: SubtitleExtractionContext = {},
): ReturnType<typeof decodeSubtitleFile> {
  const request: EpisodeRequest = { episode: context.localEpisode ?? episodeNumber,
    sourceEpisode: episodeNumber, season: targetSeason ?? 1 };
  const filename = subtitleFilenameFromUrl(urlPath);
  const evidence = [...(context.evidence || []), readEpisodeEvidence(filename, true)];
  if (evidence.some(item => !evidenceAgrees(item, request))) return null;
  const isZip = buffer.subarray(0, 2).equals(Buffer.from("PK"));
  if (isZip) {
    try {
      const { zip, entries } = inspectSubtitleArchive(buffer);
      const selected = selectEpisodeEntries(entries, request, evidence, !strictEpisode);
      const priority: Record<string, number> = { ass: 1, ssa: 2, smi: 3, srt: 4, vtt: 5 };
      selected.sort((a, b) => (priority[a.filename.split('.').pop()!.toLowerCase()] || 9)
        - (priority[b.filename.split('.').pop()!.toLowerCase()] || 9));
      // Multiple release variants of the same identified episode remain valid.
      // Different numbering interpretations must not be resolved by file order.
      const identities = new Set(selected.map(e => `${e.season}:${e.episode}`));
      if (identities.size > 1) return null;
      for (const entry of selected) {
        const result = decodeSubtitleFile(zip.getEntries()[entry.index].getData(), entry.filename);
        if (result) return result;
      }
    } catch (error) { console.warn("[Zip Extractor error]", error); }
    return null;
  }
  const selected = selectEpisodeEntries([{ filename }], request, evidence, !strictEpisode);
  return selected.length ? decodeSubtitleFile(buffer, filename || urlPath) : null;
}

export function extractGdriveId(url: string): string | null {
  if (!url) return null;
  const cleanUrl = url.replace(/&amp;/g, "&");
  const m = cleanUrl.match(/(?:\/file\/d\/|[\?&]id=)([a-zA-Z0-9_-]{25,})/i);
  return m ? m[1] : null;
}

// 8. Convert Google Drive and cloud links to direct download URLs
export function convertToDirectDownloadUrl(url: string): string {
  if (!url) return url;
  const id = extractGdriveId(url);
  if (id) {
    return `https://drive.usercontent.google.com/download?id=${id}&export=download`;
  }
  return url;
}

// 9. Download file helper with timeout & Google Drive support
async function downloadFileWithMetadata(
  url: string,
  referer?: string,
  timeoutMs = 4500
): Promise<{ buffer: Buffer; filename: string } | null> {
  try {
    const headers: Record<string, string> = { ...HEADERS };
    if (referer) headers["Referer"] = referer;

    const directUrl = convertToDirectDownloadUrl(url);

    let res = await fetch(directUrl, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });

    // Fallback for Google Drive
    if (!res.ok && directUrl.includes("drive.usercontent.google.com")) {
      const gId = extractGdriveId(url);
      if (gId) {
        res = await fetch(
          `https://docs.google.com/uc?export=download&id=${gId}&confirm=t`,
          {
            headers,
            signal: AbortSignal.timeout(timeoutMs),
          }
        );
      }
    }

    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);

    // Reject HTML responses
    if (buf.length > 0) {
      const sample = buf.subarray(0, 300).toString("utf-8").toLowerCase();
      if (sample.includes("<!doctype html") || sample.includes("<html")) {
        return null;
      }
    }

    const disposition = res.headers.get("content-disposition") || "";
    const encodedName = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
    const plainName = disposition.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
    let filename = plainName?.[1] || plainName?.[2]?.trim() || "";
    if (encodedName) { try { filename = decodeURIComponent(encodedName.trim()); } catch {} }
    return { buffer: buf, filename };
  } catch {
    return null;
  }
}

export async function downloadFileWithTimeout(url: string, referer?: string, timeoutMs = 4500): Promise<Buffer | null> {
  return (await downloadFileWithMetadata(url, referer, timeoutMs))?.buffer || null;
}

function subtitlePostTitle($: cheerio.CheerioAPI): string {
  return $(".post-title, .entry-title, .title_post, .tit_post, .se-title-text").first().text().trim()
    || $('meta[property="og:title"]').attr("content")?.trim() || $("title").text().trim();
}

/** All blog adapters feed the same evidence check; rejected links cannot re-enter via another scan. */
export async function extractSubtitleFromBlogPage(
  html: string, postUrl: string, creatorName: string, episodeNumber: number,
  targetSeason: number | null, timeoutMs = 5000, localEpisode = episodeNumber,
): Promise<SubtitleResult | null> {
  const $ = cheerio.load(html);
  const request = { episode: localEpisode, sourceEpisode: episodeNumber, season: targetSeason ?? 1 };
  const postEvidence = readEpisodeEvidence(subtitlePostTitle($));
  if (!evidenceAgrees(postEvidence, request)) return null;
  const content = $(".tt_article_useless_p_margin, .post-body, .entry-content, .se-main-container, #postViewArea").first();
  const scope = content.length ? content : $("body");
  scope.find("nav, aside, header, footer, .related-articles, .another_category, script, style").remove();
  const links = new Map<string, { url: string; evidence: EpisodeEvidence[]; filename: string }>();
  const add = (url: string, evidence: EpisodeEvidence[], filename = "") => {
    const identity = extractGdriveId(url) || url;
    const prior = links.get(identity);
    if (prior) { prior.evidence.push(...evidence); return; }
    links.set(identity, { url, evidence, filename });
  };
  scope.find("a[href]").each((_, anchor) => {
    if ($(anchor).closest("nav, aside, header, footer, .related-articles, .another_category").length) return;
    const raw = $(anchor).attr("href")?.trim() || "";
    let url: string;
    try { url = new URL(raw, postUrl).toString(); } catch { return; }
    if (!/^https?:/i.test(url)) return;
    const filename = subtitleFilenameFromUrl(url);
    const label = $(anchor).text().trim();
    if (!extractGdriveId(url) && !filename && !/tfile|attachment|kakaocdn\.net|download\.blog|blogfiles\.naver|attach/i.test(url)
        && !/\.(zip|ass|ssa|srt|smi|vtt)\b|자막\s*다운/i.test(label)) return;
    if (/\.(?:png|jpe?g|gif|webp)(?:[?#]|$)/i.test(url)) return;
    const labels = [label, $(anchor).attr("download") || "", $(anchor).attr("title") || "",
      ...$(anchor).find("img").toArray().flatMap(img => [$(img).attr("alt") || "", $(img).attr("title") || ""])];
    add(url, [...labels.filter(Boolean).map(value => readEpisodeEvidence(value, true, false)),
      readEpisodeEvidence(filename, true)], filename);
  });
  // Only links absent from anchor discovery may use this fallback. A conflicting
  // anchor stays in the map and can never be resurrected as an unlabelled URL.
  for (const match of (scope.html() || "").matchAll(/https?:\/\/(?:drive|docs)\.google\.com\/(?:file\/d\/|uc\?[^"'\s<>]*?id=|open\?id=)([a-zA-Z0-9_-]{25,})/gi)) {
    if (!links.has(match[1])) add(match[0], []);
  }
  for (const item of links.values()) {
    const outer = [postEvidence, ...item.evidence, readEpisodeEvidence(item.filename, true)];
    if (outer.some(e => !evidenceAgrees(e, request))) continue;
    const downloaded = await downloadFileWithMetadata(item.url, postUrl, Math.max(timeoutMs + 1500, 12000));
    if (!downloaded) continue;
    const extracted = extractSubtitleFromBuffer(downloaded.buffer, episodeNumber,
      downloaded.filename || item.filename || item.url, true, targetSeason,
      { localEpisode, evidence: outer });
    if (extracted) return { name: creatorName, episode: localEpisode, ...extracted,
      url: postUrl, sourceCreatorWebsite: postUrl };
  }

  // Newer Tistory posts can hide JMK/ASS/SMI files inside WinPNG images instead
  // of exposing a normal attachment link. Run the author's own viewer in the
  // system Chromium only after the ordinary attachment path found nothing.
  try {
    const host = new URL(postUrl).hostname.toLowerCase();
    if (host === "tistory.com" || host.endsWith(".tistory.com")) {
      const winPngFiles = await extractTistoryWinPngFiles(postUrl, {
        // Match the weekly downloader's proven Jamaker allowance. Self-hosted
        // Pi requests can safely wait longer than the old short web fallback.
        timeoutMs: Math.max(60000, Math.min(90000, timeoutMs + 70000)),
      });
      const priority: Record<string, number> = {
        ass: 1, ssa: 2, smi: 3, srt: 4, vtt: 5, zip: 6,
      };
      winPngFiles.sort((a, b) => {
        const extA = a.path.split(".").pop()?.toLowerCase() || "";
        const extB = b.path.split(".").pop()?.toLowerCase() || "";
        return (priority[extA] || 99) - (priority[extB] || 99)
          || Number(b.generated) - Number(a.generated);
      });

      if (!winPngFiles.length) {
        console.warn("[Tistory WinPNG] no playable converted files", { postUrl });
      }
      for (const file of winPngFiles) {
        const pathParts = file.path.split(/[\\/]/).filter(Boolean);
        const fileEvidence = readEpisodeEvidence(file.path, true);
        // A numbered subtitle filename is stronger than its containing folder.
        // Example: "1화/02.ass" is episode 2, not episode 1. Only when the
        // filename itself has no episode evidence do we fall back to the
        // nearest parent folder such as "1화/main.ass".
        const nearestFolderEvidence = pathParts.slice(0, -1).reverse()
          .map((part) => readEpisodeEvidence(part))
          .find((evidence) => evidence.episodes.length || evidence.season);
        const folderEvidence = !fileEvidence.episodes.length && nearestFolderEvidence
          ? [nearestFolderEvidence]
          : [];
        const outer = [postEvidence, ...folderEvidence, fileEvidence];
        if (outer.some((e) => !evidenceAgrees(e, request))) {
          console.warn("[Tistory WinPNG] subtitle candidate rejected by episode evidence", {
            postUrl,
            path: file.path,
            request,
            postEvidence,
            folderEvidence,
            fileEvidence,
          });
          continue;
        }
        const extracted = extractSubtitleFromBuffer(
          file.data,
          episodeNumber,
          file.path,
          true,
          targetSeason,
          { localEpisode, evidence: outer },
        );
        if (extracted) {
          return {
            name: creatorName,
            episode: localEpisode,
            ...extracted,
            url: postUrl,
            sourceCreatorWebsite: postUrl,
          };
        }
        console.warn("[Tistory WinPNG] converted candidate not selected", {
          postUrl,
          path: file.path,
          request,
          fileEvidence,
        });
      }
    }
  } catch (error) {
    console.warn("[Tistory WinPNG subtitle fallback]", {
      postUrl,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return null;
}

// Compare work identities across punctuation and spacing differences, while
// keeping distinguishing subtitles such as ~사서가 되기 위해서라면 뭐든지 할 수 있어~.
function normalizeWorkTitle(text: string): string {
  return cleanTitle(text).toLocaleLowerCase("ko-KR").replace(/[^\p{L}\p{N}]+/gu, "");
}

// 9. Kairan blog subtitle searcher
export async function findKairanSubtitle(
  title: string,
  episodeNumber: number,
  timeoutMs = 3500,
  localEpisode = episodeNumber
): Promise<SubtitleResult | null> {
  try {
    const resolvedTitle = await resolveKoreanTitle(title);
    const targetSeason = parseSeason(resolvedTitle) || parseSeason(title);
    const targetEp = episodeNumber;

    let cleanBase = resolvedTitle.replace(/[\(\[\{<].*?[\]\)\}>]/g, "").replace(/~/g, " ").trim();
    cleanBase = cleanBase.replace(/\s+\d+기$/g, "").trim();
    cleanBase = cleanBase.replace(/\b\d+(?:st|nd|rd|th)\b/gi, "").trim();
    cleanBase = cleanBase.replace(/season\s*\d+/gi, "").trim();
    cleanBase = cleanTitle(cleanBase);

    const words = cleanBase
      .split(/\s+/)
      .filter((w) => !["시즌", "더빙", "자막", "극장판", "애니"].includes(w));
    const searchTerm = cleanBase || words[0];
    if (!searchTerm) return null;

    const queries: string[] = [];
    if (targetSeason) {
      queries.push(`${searchTerm} ${targetSeason}th ${targetEp}`);
      queries.push(`${searchTerm} ${targetSeason}기 ${targetEp}`);
      queries.push(`${searchTerm} ${targetSeason}th`);
      queries.push(`${searchTerm} ${targetSeason}기`);
    }
    queries.push(`${searchTerm} ${targetEp}화`);
    queries.push(`${searchTerm} ${targetEp}`);
    queries.push(`${searchTerm}`);

    for (const q of queries) {
      const searchUrl = `https://kairan03.blogspot.com/search?q=${encodeURIComponent(q)}`;
      const res = await fetch(searchUrl, {
        headers: HEADERS,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) continue;
      const html = await res.text();
      const $ = cheerio.load(html);

      let matchedPostUrl = "";
      $(".post, .date-outer, .entry").each((_, p) => {
        if (matchedPostUrl) return;
        const titleEl = $(p).find(".post-title a, h3 a, .entry-title a").first();
        if (!titleEl.length) return;

        const postTitle = titleEl.text().trim();
        const postUrl = titleEl.attr("href")?.trim() || "";
        if (!postUrl || postUrl.includes("report-abuse")) return;
        if (!normalizeWorkTitle(postTitle).includes(normalizeWorkTitle(cleanBase))) return;

        const postSeason = parseSeason(postTitle);
        const postEps = readEpisodeEvidence(postTitle).episodes;

        if (targetSeason !== null && postSeason !== null && targetSeason !== postSeason) {
          return;
        }

        if (postEps.includes(targetEp)) {
          matchedPostUrl = postUrl;
        }
      });

      if (matchedPostUrl) {
        // Download post page to find attachment link
        const postRes = await fetch(matchedPostUrl, {
          headers: HEADERS,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!postRes.ok) continue;

        const postHtml = await postRes.text();
        const subtitle = await extractSubtitleFromBlogPage(postHtml, matchedPostUrl,
          "카이란", targetEp, targetSeason, timeoutMs, localEpisode);
        if (subtitle) return subtitle;
      }
    }
  } catch (e) {
    console.error("[Kairan Subtitle] error:", e);
  }
  return null;
}

// 10. Creator blog search (Tistory, Naver Blog, Blogspot)
export async function searchBlogForEpisode(
  domain: string,
  website: string,
  animeTitle: string,
  episodeNumber: number,
  timeoutMs = 5000,
  workTitleHint = ""
): Promise<string | null> {
  const resolvedTitle = await resolveKoreanTitle(animeTitle);
  const targetSeason = parseSeason(resolvedTitle) || parseSeason(animeTitle);
  const targetEp = episodeNumber;

  let cleanBase = resolvedTitle.replace(/[\(\[\{<].*?[\]\)\}>]/g, "").replace(/~/g, " ").trim();
  cleanBase = cleanBase.replace(/\s+\d+기$/g, "").trim();
  cleanBase = cleanBase.replace(/\b\d+(?:st|nd|rd|th)\b/gi, "").trim();
  cleanBase = cleanBase.replace(/season\s*\d+/gi, "").trim();
  cleanBase = cleanTitle(cleanBase);

  const words = cleanBase
    .split(/\s+/)
    .filter((w) => !["시즌", "더빙", "자막", "극장판", "애니"].includes(w));
  const searchTerm = words.length >= 2 ? words.slice(0, 2).join(" ") : words[0] || cleanBase;
  const expectedWork = cleanTitle(workTitleHint || cleanBase);
  const normalizedExpectedWork = normalizeWorkTitle(expectedWork);

  const queries: string[] = [];
  if (expectedWork) queries.push(`${expectedWork} ${targetEp}화`);
  if (targetSeason) {
    queries.push(`${searchTerm} ${targetSeason}기 ${targetEp}화`);
    queries.push(`${searchTerm} ${targetSeason}기`);
  }
  queries.push(`${searchTerm} ${targetEp}화`);
  queries.push(`${searchTerm} ${String(targetEp).padStart(2, "0")}`);
  queries.push(`${searchTerm}`);

  try {
    // 1. Google Blogger (blogspot.com)
    if (domain.includes("blogspot.com")) {
      for (const q of queries) {
        const searchUrl = `https://${domain}/search?q=${encodeURIComponent(q)}`;
        const res = await fetch(searchUrl, {
          headers: HEADERS,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) continue;

        const html = await res.text();
        const $ = cheerio.load(html);

        let foundUrl = "";
        $(".post-title a, h3 a, .entry-title a").each((_, a) => {
          if (foundUrl) return;
          const title = $(a).text().trim();
          const href = $(a).attr("href")?.trim() || "";
          if (!href || href.includes("report-abuse")) return;

          const postSeason = parseSeason(title);
          const postEps = readEpisodeEvidence(title).episodes;

          if (targetSeason !== null && postSeason !== null && targetSeason !== postSeason) {
            return;
          }

          if (normalizedExpectedWork && !normalizeWorkTitle(title).includes(normalizedExpectedWork)) return;
          if (postEps.includes(targetEp)) {
            foundUrl = href;
          }
        });

        if (foundUrl) return foundUrl;
      }
    }
    // 2. Tistory
    else if (domain.includes("tistory.com")) {
      for (const q of queries) {
        const searchUrl = `https://${domain}/search/${encodeURIComponent(q)}`;
        const res = await fetch(searchUrl, {
          headers: HEADERS,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) continue;

        const html = await res.text();
        const $ = cheerio.load(html);

        let foundUrl = "";
        $(".link-article, .link_article, .post-item a, .title a, a[href*='/entry/'], article a, .article-content a, .entry-content a").each((_, a) => {
          if (foundUrl) return;
          let title = $(a).text().trim();
          if (!title) {
            title = $(a).attr("title") || $(a).closest("article, .post-item, .article-content, li").text().trim();
          }
          const href = $(a).attr("href")?.trim() || "";
          if (!href || href.startsWith("#") || href.includes("category")) return;

          const postSeason = parseSeason(title);
          const postEps = readEpisodeEvidence(title).episodes;

          if (targetSeason !== null && postSeason !== null && targetSeason !== postSeason) {
            return;
          }

          if (normalizeWorkTitle(title).includes(normalizedExpectedWork) && postEps.includes(targetEp)) {
            foundUrl = new URL(href, website).toString();
          }
        });

        if (foundUrl) return foundUrl;
      }
    }
    // 3. Naver Blog
    else if (domain.includes("blog.naver.com")) {
      const m = website.match(/blog\.naver\.com\/([^/?#]+)/);
      if (m) {
        const blogId = m[1];
        for (const q of queries.slice(0, 2)) {
          const searchUrl = `https://blog.naver.com/PostSearchList.naver?blogId=${blogId}&searchText=${encodeURIComponent(q)}`;
          const res = await fetch(searchUrl, {
            headers: HEADERS,
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!res.ok) continue;

          const html = await res.text();
          const $ = cheerio.load(html);

          let foundUrl = "";
          $("a.link, .title a, a[href*='logNo=']").each((_, a) => {
            if (foundUrl) return;
            const href = $(a).attr("href")?.trim() || "";
            const title = $(a).text().trim();
            if (!href) return;

            const postSeason = parseSeason(title);
            const postEps = readEpisodeEvidence(title).episodes;

            if (targetSeason !== null && postSeason !== null && targetSeason !== postSeason) {
              return;
            }

            if (expectedWork && !cleanTitle(title).includes(expectedWork)) return;
            if (postEps.includes(targetEp)) {
              foundUrl = href;
            }
          });

          if (foundUrl) return foundUrl;
        }
      }
    }
  } catch (e) {
    console.warn("[searchBlogForEpisode error]:", e);
  }
  return null;
}

// 11. Fetch creator subtitle with shared episode evidence checks
export async function fetchCreatorSubtitle(
  creatorName: string,
  website: string,
  animeTitle: string,
  episodeNumber: number,
  timeoutMs = 5000,
  localEpisode = episodeNumber
): Promise<SubtitleResult | null> {
  if (!website) return null;
  try {
    const domain = new URL(website).hostname.toLowerCase();
    // Cloudflare Turnstile 보안 캡차가 적용된 독자 사이트(erulabo.com 등)는 자동 다운로드가 불가하므로 불필요한 타임아웃 방지를 위해 즉시 스킵
    if (domain.includes("erulabo.com") || creatorName.includes("에루샤")) {
      return null;
    }

    const resolvedTitle = await resolveKoreanTitle(animeTitle);
    const targetSeason = parseSeason(resolvedTitle) || parseSeason(animeTitle);

    // 단일 페이지에서 자막 파일(첨부파일/구글드라이브/다운로드링크) 추출 헬퍼 함수
    const tryExtractFromPage = async (targetUrl: string, providedHtml?: string): Promise<SubtitleResult | null> => {
      try {
        let postUrl = targetUrl;
        if (domain.includes("blog.naver.com")) {
          const match = targetUrl.match(/blog\.naver\.com\/([^/?&]+)\/(\d+)/);
          if (match) postUrl = `https://blog.naver.com/PostView.naver?blogId=${match[1]}&logNo=${match[2]}`;
        }
        let html = postUrl === targetUrl ? providedHtml : undefined;
        if (!html) {
          const response = await fetch(postUrl, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
          if (!response.ok) return null;
          html = await response.text();
        }
        return await extractSubtitleFromBlogPage(html, postUrl, creatorName, episodeNumber,
          targetSeason, timeoutMs, localEpisode);
      } catch (error) { console.warn("[tryExtractFromPage error]", error); return null; }
    };

    // 🌟 1단계: 초기 등록 링크(website) 자체가 포스트/회차 글인지 확인 후 직접 추출 시도
    const isSpecificPost =
      /\.(?:html|htm)$/i.test(website) ||
      /\/(?:\d+|entry\/[^\/]+)$/i.test(website) ||
      website.includes("blog-post_") || /[?&]logNo=\d+/.test(website);

    let isInitialUrlCurrentEp = false;
    let postSeasonMatch = true;
    let initialPageHtml = "";
    let initialWorkTitle = "";

    try {
      const initRes = await fetch(website, {
        headers: HEADERS,
        signal: AbortSignal.timeout(domain.includes("tistory.com") ? 8000 : 4000),
      });
      if (initRes.ok) {
        const initHtml = await initRes.text();
        initialPageHtml = initHtml;
        const $init = cheerio.load(initHtml);
        const pageTitle = subtitlePostTitle($init);
        const postHeading = pageTitle;
        initialWorkTitle = postHeading.match(/^(.+?)\s*\d+\s*화/)?.[1]?.trim() || "";
        const pSeason = readEpisodeEvidence(pageTitle).season;
        const pEps = readEpisodeEvidence(postHeading || pageTitle).episodes;

        if (targetSeason !== null && pSeason !== null && targetSeason !== pSeason) {
          postSeasonMatch = false;
        }

        if (postSeasonMatch && pEps.includes(episodeNumber)) {
          isInitialUrlCurrentEp = true;
        }

        // A single Blogger post can hold individually labelled Drive links or
        // a range ZIP, while the post title itself has no episode number.
        if (domain.includes("blogspot.com") && isSpecificPost && postSeasonMatch && !isInitialUrlCurrentEp) {
          isInitialUrlCurrentEp = $init("a[href]").toArray().some((a) => {
            const href = $init(a).attr("href") || "";
            return Boolean(extractGdriveId(href)) && readEpisodeEvidence($init(a).text()).episodes.includes(episodeNumber);
          });
        }

        // Tistory's latest post usually links to the entire subtitle category.
        // Search that category for the requested episode before relying on
        // site search, whose query may not match an English provider title.
        if (domain.includes("tistory.com") && isSpecificPost && !isInitialUrlCurrentEp) {
          // Match the current work's category before checking its episodes.
          const workTitle = pageTitle.match(/^(.+?)\s*\d+\s*화/)?.[1]?.trim() || "";
          const normalizedWorkTitle = cleanTitle(workTitle);
          const category = normalizedWorkTitle ? $init('a[href*="/category/"]').toArray()
            .map((a) => $init(a).attr("href") || "")
            .find((href) => {
              try {
                const path = decodeURIComponent(new URL(href, website).pathname);
                return path.startsWith("/category/") &&
                  cleanTitle(path.split("/").pop() || "") === normalizedWorkTitle;
              } catch { return false; }
            }) : undefined;
          if (category) {
            const categoryUrl = new URL(category, website).toString();
            const categoryResponse = await fetch(categoryUrl, {
              headers: HEADERS,
              signal: AbortSignal.timeout(10000),
            });
            if (categoryResponse.ok) {
              const $category = cheerio.load(await categoryResponse.text());
              let matchingPost = "";
              $category(".article-content a.link-article").each((_, a) => {
                const heading = $category(a).text().trim().split(/\r?\n/)[0].trim();
                const href = $category(a).attr("href") || "";
                if (!matchingPost && /\d+\s*화/.test(heading) &&
                    cleanTitle(heading).includes(normalizedWorkTitle) &&
                    readEpisodeEvidence(heading).episodes.includes(episodeNumber) &&
                    /^\/\d+(?:\?|$)/.test(href)) {
                  matchingPost = new URL(href, categoryUrl).toString();
                }
              });
              if (matchingPost) {
                const categorySubtitle = await tryExtractFromPage(matchingPost);
                if (categorySubtitle) return categorySubtitle;
              }
            }
          }


        }
      }
    } catch {}

    if (isSpecificPost && postSeasonMatch) {
      const initExtracted = await tryExtractFromPage(website, initialPageHtml);
      if (initExtracted) return initExtracted;
    }

    // 🌟 2단계: 초기 URL이 해당 회차가 아니거나 추출 실패 시, 블로그 전체에서 현재 회차 포스트 자동 탐색
    const matchedPostUrl = await searchBlogForEpisode(domain, website, animeTitle, episodeNumber, timeoutMs, initialWorkTitle);
    if (matchedPostUrl) {
      const searchExtracted = await tryExtractFromPage(matchedPostUrl);
      if (searchExtracted) return searchExtracted;
    }
  } catch (e) {
    console.error(`[fetchCreatorSubtitle error] ${creatorName}:`, e);
  }
  return null;
}

// 12-1. Generate smart search queries for Anissia (다단계 스마트 검색어 생성)
export function generateAnissiaSearchQueries(rawTitle: string): string[] {
  const queries = new Set<string>();
  if (!rawTitle) return [];

  let t = rawTitle;
  // 1) 괄호류 태그 제거 ([BD], (더빙) 등)
  t = t.replace(/\[.*?\]|\(.*?\)|【.*?】|<.*?>/g, " ");
  // 2) 끝에 붙은 "1130화", "1화" 등 회차 제거
  t = t.replace(/\s+\d+화(?:\s|$)/g, " ");
  // 3) BD, Rip, 더빙, 자막 제거
  t = t.replace(/\b(BD|Rip|더빙|자막)\b/gi, " ");

  // 한글 부분 추출 (영문 부제 분리: 예 "뫼비우스 더스트 Mebius Dust" -> "뫼비우스 더스트")
  let korOnly = "";
  const matchKor = t.match(/[가-힣0-9\s~:-]+/g);
  if (matchKor) {
    korOnly = matchKor.join(" ").replace(/\s+/g, " ").trim();
  }

  // 시즌/기수 제거
  const removeSeason = (str: string) => {
    return str
      .replace(/\s*\d+\s*기\b/g, "")
      .replace(/season\s*\d+/gi, "")
      .replace(/\b\d+(?:st|nd|rd|th)\b/gi, "")
      .replace(/\s+[ⅠⅡⅢⅣⅤⅥII|III|IV|V|VI]\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  };

  // 구분자(~, -, :, 「, 『) 앞의 대표명사 추출
  const getMainBeforeSeparator = (str: string) => {
    for (const sep of ["~", "-", ":", "「", "『"]) {
      if (str.includes(sep) && !str.startsWith(sep)) {
        return str.split(sep)[0].trim();
      }
    }
    return "";
  };

  const addCandidates = (base: string) => {
    if (!base) return;
    const cleaned = base.replace(/[^\w\s가-힣a-zA-Z0-9]/g, " ").replace(/\s+/g, " ").trim();
    if (cleaned.length >= 2) {
      queries.add(cleaned);

      // 띄어쓰기 변형 (공백 없는 4글자 이상 한글: 예 "무직전생" -> "무직 전생")
      if (!cleaned.includes(" ") && cleaned.length >= 4) {
        queries.add(cleaned.slice(0, 2) + " " + cleaned.slice(2));
      }

      // 첫 1~2단어 (불용어 제외)
      const words = cleaned.split(/\s+/).filter((w) => !["시즌", "더빙", "자막", "극장판", "애니", "1기", "2기", "3기", "4기", "5기"].includes(w));
      if (words.length >= 1 && words[0].length >= 2) {
        queries.add(words[0]);
      }
      if (words.length >= 2) {
        queries.add(`${words[0]} ${words[1]}`);
      }
    }
  };

  const mainSep = getMainBeforeSeparator(t);
  if (mainSep) {
    addCandidates(removeSeason(mainSep));
    addCandidates(mainSep);
  }

  if (korOnly) {
    addCandidates(removeSeason(korOnly));
    addCandidates(korOnly);
  }

  const baseCleaned = removeSeason(t);
  addCandidates(baseCleaned);
  addCandidates(t);

  return Array.from(queries).filter((q) => q.length >= 2);
}

// 12-2. Anime Match Scorer (가중치 기반 최적 작품 매칭기 - 오매칭 원천 차단)
export function scoreAnimeMatch(
  rawTitle: string,
  targetSeason: number | null,
  item: { animeNo: number; subject: string },
  resolvedTitle?: string
): number {
  const itemSubject = item.subject || "";
  const itemSeason = parseSeason(itemSubject);

  let score = 0;

  // 1) 제목 완전 일치 또는 상호 포함 여부 (영문 원제 및 번역된 한국어 제목 모두 대조)
  const cleanRaw = rawTitle.replace(/[^\w가-힣0-9]/g, "").toLowerCase();
  const cleanComp = (resolvedTitle || rawTitle).replace(/[^\w가-힣0-9]/g, "").toLowerCase();
  const cleanItem = itemSubject.replace(/[^\w가-힣0-9]/g, "").toLowerCase();

  if (cleanRaw === cleanItem || cleanComp === cleanItem) {
    score += 150;
  } else if (
    cleanItem.includes(cleanRaw) ||
    cleanRaw.includes(cleanItem) ||
    cleanItem.includes(cleanComp) ||
    cleanComp.includes(cleanItem)
  ) {
    score += 80;
  }

  // 2) 시즌 일치 점수
  if (targetSeason === null) {
    // 1기이거나 단편인 경우
    if (itemSeason === null || itemSeason === 1) {
      score += 40;
    } else {
      // 대상이 2기, 3기 등 후속작이면 큰 감점
      score -= 60;
    }
  } else {
    // 특정 시즌(2기 이상)인 경우
    if (itemSeason === targetSeason) {
      score += 60;
    } else if (itemSeason === null) {
      score -= 20;
    } else {
      // 시즌이 완전히 다른 경우 대폭 감점 (예: 2기 찾는데 5기)
      score -= 100;
    }
  }

  // 3) 극장판 / 외전 패널티
  const isTargetMovie = /극장판|movie/i.test(rawTitle) || (resolvedTitle ? /극장판|movie/i.test(resolvedTitle) : false);
  const isItemMovie = /극장판|movie/i.test(itemSubject);
  if (isTargetMovie && isItemMovie) {
    score += 40;
  } else if (!isTargetMovie && isItemMovie) {
    score -= 40; // TV 시리즈 찾는데 극장판이면 감점
  }

  const isTargetSpinOff = /외전|팬레터|스페셜|멍!/i.test(rawTitle) || (resolvedTitle ? /외전|팬레터|스페셜|멍!/i.test(resolvedTitle) : false);
  const isItemSpinOff = /외전|팬레터|스페셜|멍!/i.test(itemSubject);
  if (!isTargetSpinOff && isItemSpinOff) {
    score -= 50; // 본편 찾는데 스핀오프면 감점
  }

  // 4) 단어 오버랩 점수
  const checkWords = (resolvedTitle || rawTitle).split(/\s+/).filter((w) => w.length >= 2);
  let overlapWords = 0;
  for (const w of checkWords) {
    if (itemSubject.includes(w)) overlapWords++;
  }
  score += overlapWords * 15;

  // A separately named sequel must not inherit subtitles from its parent
  // series merely because their long shared prefix has more matching words.
  const sequelName = (resolvedTitle || rawTitle).match(/~[^~]+~\s+(.+)$/)?.[1];
  if (sequelName && sequelName.length >= 3) {
    const normalizedSequel = sequelName.replace(/\s+/g, "");
    const normalizedSubject = itemSubject.replace(/\s+/g, "");
    score += normalizedSubject.includes(normalizedSequel) ? 140 : -140;
  }

  return score;
}

// 12-3. Anissia API query for subtitle creators with smart multi-stage search
export async function getAnissiaCreators(
  title: string,
  episodeNumber: number,
  timeoutMs = 3500,
  directAnimeNo?: number | null,
  referenceTitle = title,
  animeId?: string,
  broadSearch = false
): Promise<CreatorInfo[]> {
  const results: CreatorInfo[] = [];
  try {
    const candidates = new Map<number, { animeNo: number; subject: string; searchScore: number; matchScore?: number; verifiedMatch?: boolean }>();
    const monthlyIds = new Set<number>();

    // 만약 애니시아 animeNo가 직접 전달된 경우 (애니시아 허브 모드) 0.05초 직통 조회
    if (directAnimeNo && directAnimeNo > 0) {
      candidates.set(directAnimeNo, { animeNo: directAnimeNo, subject: title, searchScore: 150, verifiedMatch: true });
    } else {
      // Persisted monthly suggestions remain visible even if title search misses them.
      for (const item of broadSearch ? [] : await getMonthlyAnissiaCandidates(animeId || "")) {
        candidates.set(item.animeNo, { animeNo: item.animeNo, subject: item.subject,
          searchScore: item.score, matchScore: item.score, verifiedMatch: false });
        monthlyIds.add(item.animeNo);
      }
      const resolvedTitle = await resolveKoreanTitle(title);
      const targetSeason = parseSeason(resolvedTitle) || parseSeason(title);
      const queries = generateAnissiaSearchQueries(resolvedTitle);
      if (resolvedTitle !== title) {
        for (const q of generateAnissiaSearchQueries(title)) {
          if (!queries.includes(q)) queries.push(q);
        }
      }

      // Manual keyword search follows every result page; automatic matching
      // keeps its small shortlist to avoid unnecessary requests during playback.
      for (const q of broadSearch ? [title] : queries.slice(0, 4)) {
        let page = 0;
        let hasNext = true;
        const seenPageIds = new Set<number>();
        while (hasNext) {
          try {
            const url = `https://api.anissia.net/anime/list/${page}?q=${encodeURIComponent(q)}`;
            const res = await fetch(url, {
              headers: HEADERS,
              signal: AbortSignal.timeout(timeoutMs),
            });
            if (!res.ok) break;
            const json = await res.json();
            const content: Array<{ animeNo: number; subject: string }> = json?.data?.content || [];
            if (content.length === 0) break;
            // Stop if a provider ignores pagination and repeats the same page.
            const fresh = content.filter((item) => !seenPageIds.has(item.animeNo));
            if (!fresh.length) break;
            for (const item of fresh) {
              seenPageIds.add(item.animeNo);
              const sc = scoreAnimeMatch(title, targetSeason, item, resolvedTitle);
              const broadTitleMatch = broadSearch && normalizeWorkTitle(item.subject).includes(normalizeWorkTitle(title));
              if ((sc >= 50 || broadTitleMatch) && !candidates.has(item.animeNo)) {
                candidates.set(item.animeNo, { ...item, searchScore: sc,
                  matchScore: scoreAnimeMatch(referenceTitle, parseSeason(referenceTitle), item, title) });
              }
            }
            page += 1;
            hasNext = broadSearch && (json?.data?.last === false ||
              page < Number(json?.data?.totalPages || 0));
          } catch { break; }
        }
      }
    }

    const ranked = [...candidates.values()].sort((a, b) =>
      Number(monthlyIds.has(b.animeNo)) - Number(monthlyIds.has(a.animeNo)) ||
      (b.matchScore ?? b.searchScore) - (a.matchScore ?? a.searchScore));
    const selected = broadSearch ? ranked : ranked.slice(0, 4);
    const fetchCaptions = async (anime: (typeof ranked)[number]): Promise<CreatorInfo[]> => {
      try {
        const capRes = await fetch(`https://api.anissia.net/anime/caption/animeNo/${anime.animeNo}`, {
          headers: HEADERS, signal: AbortSignal.timeout(timeoutMs),
        });
        if (!capRes.ok) return [];
        const capJson = await capRes.json();
        const seenNames = new Set<string>();
        return (Array.isArray(capJson?.data) ? capJson.data : []).flatMap((c: any) => {
          const name = String(c.name || "제작자").trim();
          if (seenNames.has(name)) return [];
          seenNames.add(name);
          const epStr = String(c.episode || "");
          const providedEpisodes = parseEpisodes(epStr);
          const targetSeason = parseSeason(referenceTitle) || parseSeason(title) || parseSeason(anime.subject);
          const sourceEpisode = mapProviderEpisodeNumber(epStr, episodeNumber, targetSeason);
          return [{ name, episode: epStr,
            update_date: String(c.updDt || "").replace("T", " ").slice(0, 16),
            website: String(c.website || "").trim(),
            is_current_ep: providedEpisodes.includes(sourceEpisode),
            matchedTitle: anime.subject, matchScore: anime.matchScore,
            verifiedMatch: anime.verifiedMatch }];
        });
      } catch { return []; }
    };
    // Bound network concurrency while retaining every manual-search candidate.
    for (let offset = 0; offset < selected.length; offset += 6) {
      const captionLists = await Promise.all(selected.slice(offset, offset + 6).map(fetchCaptions));
      results.push(...captionLists.flat());
    }
  } catch (e) {
    console.error("[getAnissiaCreators error]:", e);
  }
  return results;
}

// 13. High-level parallel searcher with 13-Second Safety Guard
export async function searchAllSubtitlesParallel(
  title: string,
  episodeNumber: number,
  maxTotalTimeMs = 45000,
  directAnimeNo?: number | null,
  referenceTitle = title,
  animeId = "",
  sourceEpisodeStart: number | null = null,
  includeKairan = true,
  broadSearch = false
): Promise<{
  subtitles: SubtitleResult[];
  creators: CreatorInfo[];
  needsManualSubtitleChoice: boolean;
}> {
  // Create an overall timeout promise that resolves at 13 seconds
  let timeoutHandle: NodeJS.Timeout;
  const timeoutPromise = new Promise<null>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(null), maxTotalTimeMs);
  });

  const workerPromise = (async () => {
    const configuredSourceEpisode = sourceEpisodeStart && sourceEpisodeStart > 0
      ? sourceEpisodeStart + episodeNumber - 1
      : episodeNumber;
    const resolvedTitle = await resolveKoreanTitle(title);
    const targetTitle = resolvedTitle || title;

    // Fetch both indexed AniAll posts and current Anissia results concurrently.
    const [anissiaCreators, aniallMatches, aniallCandidates, kairanSub, sourcePriority, rejected] = await Promise.all([
      getAnissiaCreators(targetTitle, episodeNumber, 3500, directAnimeNo, referenceTitle, animeId, broadSearch),
      getAniAllMatches(targetTitle, animeId, true),
      getAniAllCandidates(targetTitle, animeId),
      includeKairan ? findKairanSubtitle(targetTitle, configuredSourceEpisode, 3500, episodeNumber) : Promise.resolve(null),
      getSubtitleSourcePriority(),
      getSubtitleRejections(animeId),
    ]);
    const isRejected = (provider: string, sourceKey: string) =>
      rejected.some((entry) => entry.provider === provider && entry.sourceKey === sourceKey);
    const aniallCreators: CreatorInfo[] = aniallMatches.map((match) => ({
      name: `AniAll · ${match.blogTitle}`, episode: "게시글 첨부 자막", update_date: "",
      website: match.postUrl, is_current_ep: true, matchScore: match.confidence,
      matchedTitle: match.canonicalTitle, verifiedMatch: match.confidence >= 90,
      sourceProvider: "aniall",
    }));
    const aniallReviewCreators: CreatorInfo[] = aniallCandidates.map((match) => ({
      name: `AniAll 후보 · ${match.blogTitle}`, episode: "매칭 검토 필요", update_date: "",
      website: match.postUrl, is_current_ep: false, matchScore: match.confidence,
      matchedTitle: match.canonicalTitle, verifiedMatch: false,
      sourceProvider: "aniall",
    }));
    const allCreators = [
      ...anissiaCreators.map((creator) => ({ ...creator, sourceProvider: "anissia" as const })),
      ...aniallCreators,
      ...aniallReviewCreators,
    ].filter((creator) => !isRejected(creator.sourceProvider || "anissia", creator.website || creator.name));

    const collectedSubs: SubtitleResult[] = [];
    if (kairanSub && !isRejected("anissia", kairanSub.sourceCreatorWebsite || kairanSub.url || kairanSub.name)) {
      collectedSubs.push({ ...kairanSub, sourceProvider: "anissia" });
    }

    // 2. Filter valid creators who have an active blog for this episode
    const candidateCreators = allCreators.filter(
      (c) => c.website && c.website.startsWith("http") && !c.name.startsWith("AniAll 후보 ·")
    ).sort((a, b) => {
      if (a.sourceProvider !== b.sourceProvider) return a.sourceProvider === sourcePriority ? -1 : 1;
      if (a.verifiedMatch !== b.verifiedMatch) return a.verifiedMatch ? -1 : 1;
      return (b.matchScore ?? -Infinity) - (a.matchScore ?? -Infinity);
    });

    // Spread downloads across distinct candidate titles before taking second creators.
    const firstPerTitle = new Set<string>();
    const distinctCreators = candidateCreators.filter((c) => {
      const key = `${c.sourceProvider}:${c.website}:${c.matchedTitle || c.name}`;
      if (firstPerTitle.has(key)) return false;
      firstPerTitle.add(key);
      return true;
    });
    const preferredCreators = distinctCreators.filter((c) => c.sourceProvider === sourcePriority).slice(0, 2);
    const otherCreators = distinctCreators.filter((c) => c.sourceProvider !== sourcePriority).slice(0, 2);
    const topCreators = [...preferredCreators, ...otherCreators].slice(0, 4);

    // 3. Parallel fetch creator subtitles with individual 3.5s timeouts
    const creatorSubPromises = topCreators.map(async (c) => {
      const targetSeason = parseSeason(c.matchedTitle || targetTitle) || parseSeason(targetTitle);
      const sourceEpisode = sourceEpisodeStart && sourceEpisodeStart > 0
        ? sourceEpisodeStart + episodeNumber - 1
        : mapProviderEpisodeNumber(c.episode, episodeNumber, targetSeason);
      const subtitle = await fetchCreatorSubtitle(c.name, c.website, c.matchedTitle || targetTitle, sourceEpisode, 10000, episodeNumber);
      return subtitle ? { ...subtitle, matchScore: c.matchScore,
        matchedTitle: c.matchedTitle, verifiedMatch: c.verifiedMatch,
        sourceCreatorWebsite: c.website, sourceMatchedTitle: c.matchedTitle,
        sourceProvider: c.sourceProvider } : null;
    });

    const settled = await Promise.allSettled(creatorSubPromises);
    const needsManualSubtitleChoice = Boolean(
      topCreators.length > 0 &&
      (settled[0]?.status !== "fulfilled" || settled[0].value === null)
    );
    for (const s of settled) {
      if (s.status === "fulfilled" && s.value) {
        collectedSubs.push(s.value);
      }
    }
    collectedSubs.sort((a, b) => {
      if (a.sourceProvider !== b.sourceProvider) return a.sourceProvider === sourcePriority ? -1 : 1;
      if (a.verifiedMatch !== b.verifiedMatch) return a.verifiedMatch ? -1 : 1;
      return (b.matchScore ?? -Infinity) - (a.matchScore ?? -Infinity) || 0;
    });

    return {
      subtitles: collectedSubs,
      creators: allCreators.sort((a, b) => {
        if (a.sourceProvider !== b.sourceProvider) return a.sourceProvider === sourcePriority ? -1 : 1;
        if (a.verifiedMatch !== b.verifiedMatch) return a.verifiedMatch ? -1 : 1;
        return (b.matchScore ?? -Infinity) - (a.matchScore ?? -Infinity);
      }),
      needsManualSubtitleChoice,
    };
  })();

  try {
    const winner = await Promise.race([workerPromise, timeoutPromise]);
    clearTimeout(timeoutHandle!);
    if (winner) {
      return winner;
    }
    // If timed out at 13s, return whatever is empty or basic fallback safely
    return { subtitles: [], creators: [], needsManualSubtitleChoice: false };
  } catch {
    clearTimeout(timeoutHandle!);
    return { subtitles: [], creators: [], needsManualSubtitleChoice: false };
  }
}
