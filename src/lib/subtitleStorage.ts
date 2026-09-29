import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { deleteUploadedSubtitle as deleteLegacyUploadedSubtitle, getUploadedSubtitle as getLegacyUploadedSubtitle } from "@/lib/db";
import { extractSubtitleFromBuffer } from "@/lib/subtitles";
import { episodeFromSubtitleFilename, inspectSubtitleArchive } from "@/lib/subtitleUpload";
import { parseEpisodes, parseSeason } from "@/lib/subtitles";

const root = process.env.SUBTITLE_STORAGE_DIR || path.join(process.cwd(), "data", "subtitles");
const safeSegment = (value: string) => {
  if (!value || value.length > 100) throw new Error("Invalid subtitle storage key");
  return encodeURIComponent(value).replaceAll(".", "%2E");
};
const episodeName = (episode: number) => {
  if (!Number.isSafeInteger(episode) || episode < 1 || episode > 10000) throw new Error("Invalid episode number");
  return String(episode).padStart(4, "0");
};
const formatOf = (format: "ASS" | "VTT") => format === "ASS" ? "ass" : "vtt";
const normalizeBlogTitle = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ko-KR")
  .replace(/[^\p{L}\p{N}]+/gu, "");

function anissiaFolderParts(finishPath: string) {
  const relative = path.relative(path.join(root, "anissia_subtitles"), path.dirname(finishPath));
  const parts = relative.split(path.sep).filter(Boolean);
  return {
    title: parts[0] || "",
    episode: parts[1] || "",
    creator: parts[2] || "",
  };
}

async function atomicWrite(filePath: string, content: string | Buffer) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, content);
  await rename(tempPath, filePath);
}

export async function getUploadedSubtitle(userId: string, animeId: string, episode: number) {
  const legacy = () => getLegacyUploadedSubtitle(userId, animeId, episode);
  try {
    const dir = path.join(root, "uploads", safeSegment(userId), safeSegment(animeId));
    const base = episodeName(episode);
    const meta = JSON.parse(await readFile(path.join(dir, `${base}.json`), "utf8"));
    const content = await readFile(path.join(dir, `${base}.${formatOf(meta.format)}`), "utf8");
    return { name: `Pi 저장: ${meta.filename}`, orig_filename: meta.filename, content,
      format: meta.format as "ASS" | "VTT", is_ass: meta.format === "ASS" };
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    return legacy();
  }
}

export async function getUploadedSubtitles(userId: string, animeId: string, episode: number) {
  const baseDir = path.join(root, "uploads", safeSegment(userId), safeSegment(animeId));
  const candidatesDir = path.join(baseDir, "candidates", episodeName(episode));
  let names: string[] = [];
  try { names = await readdir(candidatesDir); } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  const candidates = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
    try {
      const metadata = JSON.parse(await readFile(path.join(candidatesDir, name), "utf8"));
      const format = metadata.format === "ASS" ? "ASS" : "VTT";
      const hash = name.slice(0, -5);
      const content = await readFile(path.join(candidatesDir, `${hash}.${formatOf(format)}`), "utf8");
      return {
        name: `Pi 저장: ${metadata.filename}`,
        orig_filename: metadata.filename,
        content,
        format,
        is_ass: format === "ASS",
      };
    } catch { return null; }
  }));
  const legacy = await getUploadedSubtitle(userId, animeId, episode);
  const all = [...candidates.filter((item): item is NonNullable<typeof item> => Boolean(item)), ...(legacy ? [legacy] : [])];
  return all.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export async function saveUploadedSubtitleCandidates(userId: string, animeId: string,
  subtitles: Array<{ episode: number; filename: string; content: string; format: "ASS" | "VTT" }>) {
  const animeSegment = safeSegment(animeId);
  const userSegment = safeSegment(userId);
  for (const subtitle of subtitles) {
    const baseDir = path.join(root, "uploads", userSegment, animeSegment, "candidates", episodeName(subtitle.episode));
    const id = createHash("sha256")
      .update(subtitle.filename).update("\\0").update(subtitle.format).update("\\0").update(subtitle.content).digest("hex");
    const format = formatOf(subtitle.format);
    await atomicWrite(path.join(baseDir, `${id}.${format}`), subtitle.content);
    await atomicWrite(path.join(baseDir, `${id}.json`), JSON.stringify({
      filename: subtitle.filename, format: subtitle.format, updatedAt: new Date().toISOString(),
    }));
  }
}

export async function saveUploadedSubtitle(userId: string, animeId: string, episode: number,
  filename: string, content: string, format: "ASS" | "VTT") {
  const dir = path.join(root, "uploads", safeSegment(userId), safeSegment(animeId));
  const base = episodeName(episode);
  const metaPath = path.join(dir, `${base}.json`);
  let previousFormat: "ASS" | "VTT" | null = null;
  try { previousFormat = JSON.parse(await readFile(metaPath, "utf8")).format; } catch {}
  await atomicWrite(path.join(dir, `${base}.${formatOf(format)}`), content);
  await atomicWrite(metaPath, JSON.stringify({ filename, format, updatedAt: new Date().toISOString() }));
  if (previousFormat && previousFormat !== format) {
    await rm(path.join(dir, `${base}.${formatOf(previousFormat)}`), { force: true });
  }
  await deleteLegacyUploadedSubtitle(userId, animeId, episode);
}

export async function saveUploadedSubtitles(userId: string, animeId: string,
  subtitles: Array<{ episode: number; filename: string; content: string; format: "ASS" | "VTT" }>) {
  for (const subtitle of subtitles) {
    await saveUploadedSubtitle(userId, animeId, subtitle.episode, subtitle.filename, subtitle.content, subtitle.format);
  }
}

export async function deleteUploadedSubtitle(userId: string, animeId: string, episode: number) {
  const dir = path.join(root, "uploads", safeSegment(userId), safeSegment(animeId));
  const base = episodeName(episode);
  await Promise.all([
    ...["json", "ass", "vtt"].map((ext) => rm(path.join(dir, `${base}.${ext}`), { force: true })),
    rm(path.join(dir, "candidates", base), { recursive: true, force: true }),
  ]);
  await deleteLegacyUploadedSubtitle(userId, animeId, episode);
}

export async function getVerifiedSubtitleCache(animeId: string, episode: number) {
  const dir = path.join(root, "verified", safeSegment(animeId), episodeName(episode));
  let names: string[];
  try { names = await readdir(dir); } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const entries = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
    try {
      const metadata = JSON.parse(await readFile(path.join(dir, name), "utf8"));
      return { name, metadata, time: Date.parse(metadata.verifiedAt) || 0 };
    } catch { return null; }
  }));
  const latest = entries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .sort((a, b) => b.time - a.time)[0];
  if (!latest) return null;
  const format = latest.metadata.format === "ASS" ? "ASS" : "VTT";
  const hash = latest.name.slice(0, -5);
  const content = await readFile(path.join(dir, `${hash}.${formatOf(format)}`), "utf8");
  return { name: latest.metadata.filename, orig_filename: latest.metadata.filename, content,
    format, is_ass: format === "ASS", sourceProvider: latest.metadata.sourceProvider,
    sourceCreatorWebsite: latest.metadata.sourceUrl, sourceMatchedTitle: latest.metadata.matchedTitle, isCached: true };
}

export async function saveVerifiedSubtitleCache(input: {
  animeId: string; episodeNumber: number; filename: string; content: string; format: "ASS" | "VTT";
  sourceProvider: "aniall" | "anissia"; sourceUrl: string; matchedTitle: string;
}) {
  const animeId = safeSegment(input.animeId);
  const ep = episodeName(input.episodeNumber);
  const hash = createHash("sha256").update(`${animeId}\n${ep}\n${input.sourceProvider}\n${input.sourceUrl}\n${input.matchedTitle}`).digest("hex");
  const dir = path.join(root, "verified", animeId, ep);
  await atomicWrite(path.join(dir, `${hash}.${formatOf(input.format)}`), input.content);
  await atomicWrite(path.join(dir, `${hash}.json`), JSON.stringify({
    filename: input.filename, format: input.format, sourceProvider: input.sourceProvider,
    sourceUrl: input.sourceUrl, matchedTitle: input.matchedTitle, verifiedAt: new Date().toISOString(),
  }));
}



export interface AnissiaArchiveSubtitle {
  name: string;
  orig_filename: string;
  content: string;
  format: "ASS" | "VTT";
  is_ass: boolean;
  episode: number;
  creator: string;
  website: string;
  matchedTitle: string;
  updatedAt: string;
  animeNo: number | null;
  archiveFilename: string;
  localArchiveTrackKey: string;
  localArchiveTrackLabel: string;
}

interface AnissiaArchiveIndexEntry {
  finishPath: string;
  record: Record<string, any>;
  updatedAt: string;
}

let anissiaArchiveIndex: { entries: AnissiaArchiveIndexEntry[]; expiresAt: number } | null = null;
let anissiaArchiveIndexPromise: Promise<AnissiaArchiveIndexEntry[]> | null = null;

function recordObjects(record: Record<string, any>): Record<string, any>[] {
  return [record, record.data, record.anime, record.work, record.caption, record.item]
    .filter((item): item is Record<string, any> => Boolean(item && typeof item === "object" && !Array.isArray(item)));
}

function recordValue(record: Record<string, any>, keys: string[]): string {
  for (const object of recordObjects(record)) {
    for (const key of keys) {
      const value = object[key];
      if (typeof value === "string" || typeof value === "number") {
        const text = String(value).trim();
        if (text) return text;
      }
    }
  }
  return "";
}

function recordNumber(record: Record<string, any>, keys: string[]): number | null {
  const value = recordValue(record, keys);
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

async function loadAnissiaArchiveIndex(): Promise<AnissiaArchiveIndexEntry[]> {
  const corpus = path.join(root, "anissia_subtitles");
  const finishPaths: string[] = [];
  const archiveDirs = new Set<string>();
  const finishDirs = new Set<string>();
  const pending: Array<{ dir: string; depth: number }> = [{ dir: corpus, depth: 0 }];
  let inspected = 0;

  while (pending.length && inspected < 30000) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current.dir, { withFileTypes: true });
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (entries.some((entry) => entry.isFile() && /\.(zip|ass|ssa|smi|srt|vtt)$/i.test(entry.name))) {
      archiveDirs.add(current.dir);
    }
    for (const entry of entries) {
      inspected++;
      if (inspected >= 30000) break;
      if (entry.name.startsWith(".") || entry.name === "__MACOSX") continue;
      const fullPath = path.join(current.dir, entry.name);
      if (entry.isDirectory() && current.depth < 10) pending.push({ dir: fullPath, depth: current.depth + 1 });
      else if (entry.isFile() && entry.name.toLowerCase() === "finish.txt") {
        finishPaths.push(fullPath);
        finishDirs.add(current.dir);
      }
    }
  }

  const indexed = await Promise.all(finishPaths.map(async (finishPath) => {
    try {
      const info = await stat(finishPath);
      if (info.size <= 0 || info.size > 256 * 1024) return null;
      const record = JSON.parse(await readFile(finishPath, "utf8"));
      if (!record || typeof record !== "object" || Array.isArray(record)) return null;
      const updatedAt = recordValue(record, ["updDt", "updatedAt", "updateDate", "updated", "date"]);
      return { finishPath, record, updatedAt };
    } catch {
      return null;
    }
  }));

  // Manually saved Anissia archives may not have finish.txt. Infer metadata
  // from the same title/episode/creator directory layout and ZIP filename.
  const inferred = await Promise.all([...archiveDirs].filter((dir) => !finishDirs.has(dir)).map(async (dir) => {
    try {
      const files = (await readdir(dir)).filter((name) => /\.(zip|ass|ssa|smi|srt|vtt)$/i.test(name));
      const stats = await Promise.all(files.map((name) => stat(path.join(dir, name))));
      const latestModified = Math.max(0, ...stats.map((info) => info.mtimeMs));
      return {
        finishPath: path.join(dir, "finish.txt"),
        record: {},
        updatedAt: latestModified ? new Date(latestModified).toISOString() : "",
      };
    } catch {
      return null;
    }
  }));

  return [...indexed, ...inferred].filter((entry): entry is AnissiaArchiveIndexEntry => Boolean(entry));
}
async function getAnissiaArchiveIndex(): Promise<AnissiaArchiveIndexEntry[]> {
  if (anissiaArchiveIndex && anissiaArchiveIndex.expiresAt > Date.now()) return anissiaArchiveIndex.entries;
  if (!anissiaArchiveIndexPromise) {
    anissiaArchiveIndexPromise = loadAnissiaArchiveIndex()
      .then((entries) => {
        anissiaArchiveIndex = { entries, expiresAt: Date.now() + 60_000 };
        return entries;
      })
      .finally(() => { anissiaArchiveIndexPromise = null; });
  }
  return anissiaArchiveIndexPromise;
}

function normalizeAnissiaTrackFilename(filename: string, episode: number): string {
  const base = path.basename(filename).replace(/\.(ass|ssa|smi|srt|vtt|zip)$/i, "");
  const patterns = [
    new RegExp("(^|[\\s_-])0*" + episode + "(?=[A-Za-z][A-Za-z0-9._-]*$)"),
    new RegExp("(^|[^a-z\\d])(?:episode|ep|e|#)\\s*0*" + episode + "(?!\\d)", "i"),
    new RegExp("((?:제|第\\s*)?0*)" + episode + "(\\s*(?:화|회|편|話))"),
    new RegExp("(^|[\\s_-])0*" + episode + "$"),
  ];
  for (const pattern of patterns) {
    const match = base.match(pattern);
    if (match) {
      const prefix = match[1] || "";
      const suffix = match[2] || "";
      return base.replace(pattern, `${prefix}{ep}${suffix}`);
    }
  }
  return base;
}

function anissiaTrackIdentity(creator: string, archiveFilename: string, entryFilename: string, episode: number) {
  const rangePattern = /(?:^|[^\d])\d{1,3}\s*[-~]\s*\d{1,3}(?!\d)/;
  const archiveBase = path.basename(archiveFilename).replace(/\.(zip)$/i, "").replace(rangePattern, "{range}");
  const normalizedArchive = normalizeAnissiaTrackFilename(archiveBase, episode);
  const entryEpisode = episodeFromSubtitleFilename(entryFilename);
  const normalizedEntry = entryEpisode === episode ? normalizeAnissiaTrackFilename(entryFilename, episode) : "";
  const trackKey = [normalizeBlogTitle(creator), normalizeBlogTitle(normalizedArchive), normalizeBlogTitle(normalizedEntry)].join("|");
  const entryTrack = normalizedEntry.match(/\{ep\}([a-z][a-z0-9._-]*)$/i)?.[1] || "";
  const archiveTrack = normalizedArchive.match(/(?:\{ep\}|\{range\})([a-z][a-z0-9._-]*)$/i)?.[1] || "";
  const variant = entryTrack || archiveTrack;
  const trackLabel = /^ns$/i.test(variant) ? "논스폰서판"
    : /^s$/i.test(variant) ? "스폰서판"
      : variant ? variant + " 트랙" : "자막 트랙";
  return { localArchiveTrackKey: trackKey, localArchiveTrackLabel: trackLabel };
}
/** Find an offline Anissia subtitle archive using its adjacent finish.txt metadata. */
export async function getAnissiaArchiveSubtitles(
  titles: string[],
  episode: number,
  animeNo?: number | null,
  seasonNumber?: number | null,
  options: { folderNameQuery?: string; maxResults?: number } = {},
): Promise<AnissiaArchiveSubtitle[]> {
  if (!Number.isSafeInteger(episode) || episode < 1) return [];
  const wantedTitles = new Set(titles.map(normalizeBlogTitle).filter((value) => value.length >= 2));
  const folderNameQuery = normalizeBlogTitle(options.folderNameQuery || "");
  const resultLimit = options.maxResults || (folderNameQuery ? 50 : 12);
  const wantedSeason = seasonNumber || titles.map(parseSeason).find((value) => value !== null) || null;
  const index = await getAnissiaArchiveIndex();
  const matched: Array<{ entry: AnissiaArchiveIndexEntry; title: string; creator: string; website: string; order: number }> = [];

  for (const entry of index) {
    const recordAnimeNo = recordNumber(entry.record, ["animeNo", "anime_no", "anissiaNo"]);
    const folderParts = anissiaFolderParts(entry.finishPath);
    const folderTitle = folderParts.title || path.basename(path.dirname(path.dirname(path.dirname(entry.finishPath))));
    const recordTitle = recordValue(entry.record, ["subject", "animeTitle", "workTitle", "title", "anime_name", "work"]) || folderTitle;
    const exactTitleMatch = [recordTitle, folderTitle].some((value) => wantedTitles.has(normalizeBlogTitle(value)));
    const folderNameMatch = folderNameQuery
      ? normalizeBlogTitle(folderTitle).includes(folderNameQuery)
      : Boolean(animeNo && recordAnimeNo === animeNo) || exactTitleMatch;
    if (!folderNameMatch) continue;

    const recordEpisode = recordValue(entry.record, ["episode", "episodeNumber", "episode_number", "episodeNo", "ep"]);
    const episodeNumbers = recordEpisode ? parseEpisodes(recordEpisode) : [];
    const episodeFolder = folderParts.episode || path.basename(path.dirname(path.dirname(entry.finishPath)));
    const pathEpisodes = parseEpisodes(episodeFolder);
    const hasEpisodeData = episodeNumbers.length > 0 || pathEpisodes.length > 0;
    if (hasEpisodeData && !episodeNumbers.includes(episode) && !pathEpisodes.includes(episode)) continue;

    const titleSeason = parseSeason(recordTitle) || parseSeason(folderTitle);
    if (wantedSeason && titleSeason && wantedSeason !== titleSeason) continue;
    const creator = recordValue(entry.record, ["name", "creator", "creatorName", "captionName"]) || folderParts.creator || "로컬 파일";
    const website = recordValue(entry.record, ["website", "url", "sourceUrl"]);
    const timestamp = Date.parse(entry.updatedAt) || 0;
    matched.push({ entry, title: recordTitle, creator, website, order: timestamp });
  }

  matched.sort((a, b) => b.order - a.order);
  const results: AnissiaArchiveSubtitle[] = [];
  for (const candidate of matched) {
    const dir = path.dirname(candidate.entry.finishPath);
    const folderParts = anissiaFolderParts(candidate.entry.finishPath);
    let files: string[] = [];
    try { files = await readdir(dir); } catch { continue; }
    const archives = files.filter((name) => name.toLowerCase().endsWith(".zip"))
      .sort((a, b) => Number(b.toLowerCase() === "subtitle.zip") - Number(a.toLowerCase() === "subtitle.zip") ||
        a.localeCompare(b, undefined, { numeric: true }));
    const loose = files.filter((name) => /\.(ass|ssa|smi|srt|vtt)$/i.test(name));
    const recordEpisode = recordValue(candidate.entry.record, ["episode", "episodeNumber", "episode_number", "episodeNo", "ep"]);
    const recordedEpisodes = recordEpisode ? parseEpisodes(recordEpisode) : [];
    const episodeFolder = folderParts.episode || path.basename(path.dirname(path.dirname(candidate.entry.finishPath)));
    const pathEpisodes = parseEpisodes(episodeFolder);
    const recordMatchesEpisode = recordedEpisodes.includes(episode) || pathEpisodes.includes(episode) ||
      (!recordedEpisodes.length && !pathEpisodes.length);

    for (const filename of [...archives, ...loose]) {
      try {
        const filePath = path.join(dir, filename);
        const info = await stat(filePath);
        if (!info.isFile() || info.size <= 0 || info.size > 100 * 1024 * 1024) continue;

        const addSubtitle = (subtitle: ReturnType<typeof extractSubtitleFromBuffer>) => {
          if (!subtitle?.content) return;
          results.push({
            name: subtitle.filename,
            orig_filename: subtitle.orig_filename,
            content: subtitle.content,
            format: subtitle.format,
            is_ass: subtitle.is_ass,
            episode,
            creator: candidate.creator,
            website: candidate.website,
            matchedTitle: candidate.title,
            updatedAt: candidate.entry.updatedAt,
            animeNo: recordNumber(candidate.entry.record, ["animeNo", "anime_no", "anissiaNo"]),
            archiveFilename: filename,
            ...anissiaTrackIdentity(candidate.creator, filename, subtitle.orig_filename, episode),
          });
        };

        if (filename.toLowerCase().endsWith(".zip")) {
          const { zip, entries } = inspectSubtitleArchive(await readFile(filePath));
          const archiveRange = filename.match(/(?:^|[^\\d])(\\d{1,3})\\s*[-~]\\s*(\\d{1,3})(?!\\d)/);
          const archiveStart = archiveRange ? Number(archiveRange[1]) : 0;
          const archiveEnd = archiveRange ? Number(archiveRange[2]) : 0;
          if (archiveRange && (archiveStart < 1 || archiveEnd < archiveStart || episode < archiveStart || episode > archiveEnd)) continue;

          const exactEntries = entries.filter((entry) => entry.episode === episode);
          let selectedEntries = exactEntries;
          if (!selectedEntries.length && archiveRange && archiveEnd - archiveStart + 1 === entries.length) {
            const orderedEntries = [...entries].sort((a, b) =>
              a.filename.localeCompare(b.filename, undefined, { numeric: true }));
            selectedEntries = orderedEntries.filter((_, index) => archiveStart + index === episode);
          }
          if (!selectedEntries.length && !archiveRange && entries.length === 1 && recordMatchesEpisode) {
            selectedEntries = entries;
          }

          for (const item of selectedEntries) {
            try {
              addSubtitle(extractSubtitleFromBuffer(zip.getEntries()[item.index].getData(), episode, item.filename));
            } catch {}
            if (results.length >= resultLimit) break;
          }
        } else if (recordMatchesEpisode) {
          addSubtitle(extractSubtitleFromBuffer(await readFile(filePath), episode, filename));
        }
      } catch {}
      if (results.length >= resultLimit) break;
    }
    if (results.length >= resultLimit) break;
  }
  return results;
}

export async function getAniAllArchiveSubtitle(blogTitle: string, episode: number, seasonNumber: number | null = null, startEpisodeOverride: number | null = null) {
  const corpus = path.join(root, "aniall_subtitles");
  let folders: string[];
  try { folders = await readdir(corpus); } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const wanted = normalizeBlogTitle(blogTitle);
  const folder = folders.find((name) => normalizeBlogTitle(name) === wanted);
  if (!folder) return null;
  const dir = path.join(corpus, folder);
  const files = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith(".zip")).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const filename of files) {
    try {
      const filePath = path.join(dir, filename);
      const info = await stat(filePath);
      if (!info.isFile() || info.size === 0 || info.size > 100 * 1024 * 1024) continue;
      const { zip, entries } = inspectSubtitleArchive(await readFile(filePath));
      const targetSeason = seasonNumber || 1;
      let selected = (!startEpisodeOverride || targetSeason > 1)
        ? entries.filter((entry) => entry.episode === episode && entry.season === targetSeason)
        : [];
      let ambiguousSeasonMapping = false;
      if (!selected.length && startEpisodeOverride && startEpisodeOverride > 0) {
        const sourceEpisode = startEpisodeOverride + episode - 1;
        selected = entries.filter((entry) => entry.season === null && entry.episode === sourceEpisode);
      }
      if (!selected.length) {
        const unseasoned = entries.filter((entry) => entry.season === null && entry.episode !== null);
        const available = [...new Set(unseasoned.map((entry) => entry.episode as number))].sort((a, b) => a - b);
        const first = available[0];
        const contiguous = Boolean(first && available.every((value, index) => value === first + index));
        let sourceEpisode: number | null = null;
        if (targetSeason > 1 && contiguous) {
          if (first > 1) {
            sourceEpisode = available.includes(episode)
              ? episode
              : episode >= 1 && episode <= available.length ? available[episode - 1] : null;
          } else if (available.length > 12 && available.length % targetSeason === 0) {
            const seasonLength = available.length / targetSeason;
            sourceEpisode = episode <= seasonLength
              ? available[(targetSeason - 1) * seasonLength + episode - 1]
              : available.includes(episode) ? episode : null;
          } else if (available.length > 12) {
            sourceEpisode = available.includes(episode) ? episode : null;
            ambiguousSeasonMapping = sourceEpisode === null;
          } else if (available.includes(episode)) {
            sourceEpisode = available[episode - 1];
          }
        } else if (targetSeason <= 1 && available.includes(episode)) {
          sourceEpisode = episode;
        }
        if (sourceEpisode !== null) selected = unseasoned.filter((entry) => entry.episode === sourceEpisode);
      }
      if (!selected.length && !ambiguousSeasonMapping) {
        const range = filename.match(/(?:^|[^\d])(\d{1,3})\s*[-~]\s*(\d{1,3})(?!\d)/);
        const start = range ? Number(range[1]) : 0;
        const end = range ? Number(range[2]) : 0;
        const sourceEpisode = startEpisodeOverride && startEpisodeOverride > 0
          ? startEpisodeOverride + episode - 1
          : seasonNumber && seasonNumber > 1 && episode >= 1 && episode <= end - start + 1
            ? start + episode - 1 : episode;
        if (start > 0 && end >= start && end - start + 1 === entries.length && sourceEpisode >= start && sourceEpisode <= end) {
          selected = [...entries].sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }))
            .filter((_, index) => start + index === sourceEpisode);
        }
      }
      if (selected.length !== 1) continue;
      const entry = selected[0];
      const subtitle = extractSubtitleFromBuffer(zip.getEntries()[entry.index].getData(), episode, entry.filename);
      if (subtitle?.content) {
        return { blogTitle: folder, name: subtitle.filename, orig_filename: subtitle.orig_filename, content: subtitle.content,
          format: subtitle.format, is_ass: subtitle.is_ass };
      }
    } catch {}
  }
  return null;
}
