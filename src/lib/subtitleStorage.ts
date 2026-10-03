import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { deleteUploadedSubtitle as deleteLegacyUploadedSubtitle, getUploadedSubtitle as getLegacyUploadedSubtitle } from "@/lib/db";
import { extractSubtitleFromBuffer, decodeSubtitleFile } from "@/lib/subtitles";
import { episodeFromSubtitleFilename, inspectSubtitleArchive } from "@/lib/subtitleUpload";
import { parseSeason } from "@/lib/subtitles";
import { readEpisodeEvidence, evidenceAgrees, selectEpisodeEntries } from "@/lib/subtitleEpisodes";

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
  const identity = parts[0]?.match(/^([1-9]\d*)__([\s\S]+)$/);
  return {
    title: identity?.[2] || parts[0] || "",
    animeNo: identity && Number.isSafeInteger(Number(identity[1])) ? Number(identity[1]) : null,
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

export { getVerifiedSubtitleCache, saveVerifiedSubtitleCache } from "@/lib/subtitleCache";

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
  sourceBundleKey: string;
  sourceBundleLabel: string;
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

export async function searchLocalSubtitleFolders(query: string): Promise<Array<{ folderName: string; provider: "aniall" | "anissia" }>> {
  const needle = normalizeBlogTitle(query);
  if (needle.length < 2) return [];
  const matches: Array<{ folderName: string; provider: "aniall" | "anissia" }> = [];
  try {
    const folders = await readdir(path.join(root, "aniall_subtitles"), { withFileTypes: true });
    for (const folder of folders) {
      if (folder.isDirectory() && normalizeBlogTitle(folder.name).includes(needle)) {
        matches.push({ folderName: folder.name, provider: "aniall" });
      }
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  const seen = new Set<string>();
  for (const entry of await getAnissiaArchiveIndex()) {
    const folderName = anissiaFolderParts(entry.finishPath).title;
    if (!folderName || !normalizeBlogTitle(folderName).includes(needle) || seen.has(folderName)) continue;
    seen.add(folderName);
    matches.push({ folderName, provider: "anissia" });
  }
  return matches.sort((a, b) => a.folderName.localeCompare(b.folderName, "ko")).slice(0, 200);
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
  options: { folderNameQuery?: string; maxResults?: number; localEpisode?: number } = {},
): Promise<AnissiaArchiveSubtitle[]> {
  if (!Number.isSafeInteger(episode) || episode < 1) return [];
  const wantedTitles = new Set(titles.map(normalizeBlogTitle).filter((value) => value.length >= 2));
  const folderNameQuery = normalizeBlogTitle(options.folderNameQuery || "");
  const resultLimit = options.maxResults || (folderNameQuery ? 50 : 12);
  const wantedSeason = seasonNumber || titles.map(parseSeason).find((value) => value !== null) || null;
  const request = { episode: options.localEpisode ?? episode, sourceEpisode: episode, season: wantedSeason ?? 1 };
  const index = await getAnissiaArchiveIndex();
  const matched: Array<{ entry: AnissiaArchiveIndexEntry; title: string; creator: string; website: string; order: number }> = [];

  for (const entry of index) {
    const folderParts = anissiaFolderParts(entry.finishPath);
    const metadataAnimeNo = recordNumber(entry.record, ["animeNo", "anime_no", "anissiaNo"]);
    if (metadataAnimeNo && folderParts.animeNo && metadataAnimeNo !== folderParts.animeNo) continue;
    const recordAnimeNo = metadataAnimeNo || folderParts.animeNo;
    const folderTitle = folderParts.title || path.basename(path.dirname(path.dirname(path.dirname(entry.finishPath))));
    const recordTitle = recordValue(entry.record, ["subject", "animeTitle", "workTitle", "title", "anime_name", "work"]) || folderTitle;
    const exactTitleMatch = [recordTitle, folderTitle].some((value) => wantedTitles.has(normalizeBlogTitle(value)));
    const folderNameMatch = folderNameQuery
      ? normalizeBlogTitle(folderTitle).includes(folderNameQuery)
      : animeNo && recordAnimeNo ? recordAnimeNo === animeNo : exactTitleMatch;
    if (!folderNameMatch) continue;

    const recordEpisode = recordValue(entry.record, ["episode", "episodeNumber", "episode_number", "episodeNo", "ep"]);
    const episodeFolder = folderParts.episode || path.basename(path.dirname(path.dirname(entry.finishPath)));
    if ([readEpisodeEvidence(recordEpisode), readEpisodeEvidence(episodeFolder)].some(e => !evidenceAgrees(e, request))) continue;

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
    const episodeFolder = folderParts.episode || path.basename(path.dirname(path.dirname(candidate.entry.finishPath)));
    const outer = [readEpisodeEvidence(candidate.title), readEpisodeEvidence(recordEpisode), readEpisodeEvidence(episodeFolder)];

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
            animeNo: recordNumber(candidate.entry.record, ["animeNo", "anime_no", "anissiaNo"]) || folderParts.animeNo,
            archiveFilename: filename,
            ...anissiaTrackIdentity(candidate.creator, filename, subtitle.orig_filename, episode),
            sourceBundleKey: anissiaTrackIdentity(candidate.creator, filename, subtitle.orig_filename, episode).localArchiveTrackKey,
            sourceBundleLabel: folderParts.title || candidate.title,
          });
        };

        if (filename.toLowerCase().endsWith(".zip")) {
          const { zip, entries } = inspectSubtitleArchive(await readFile(filePath));
          const selectedEntries = selectEpisodeEntries(entries, request,
            [...outer, readEpisodeEvidence(filename, true)]);

          for (const item of selectedEntries) {
            try {
              addSubtitle(decodeSubtitleFile(zip.getEntries()[item.index].getData(), item.filename));
            } catch {}
            if (results.length >= resultLimit) break;
          }
        } else {
          addSubtitle(extractSubtitleFromBuffer(await readFile(filePath), episode, filename, true, wantedSeason,
            { localEpisode: request.episode, evidence: outer }));
        }
      } catch {}
      if (results.length >= resultLimit) break;
    }
    if (results.length >= resultLimit) break;
  }
  return results;
}

export async function getAniAllArchiveSubtitle(blogTitle: string, episode: number, seasonNumber: number | null = null, startEpisodeOverride: number | null = null, postUrl: string = "") {
  const corpus = path.join(root, "aniall_subtitles");
  let folders: string[];
  try { folders = await readdir(corpus); } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const wanted = normalizeBlogTitle(blogTitle);
  const postId = postUrl.match(/^https?:\/\/aniall\.tistory\.com\/([1-9]\d*)(?:[/?#]|$)/i)?.[1];
  // Numbered weekly folders require their actual post binding. An unmatched
  // new post must not bypass DB review through the legacy title fallback.
  const numbered = postId ? folders.filter(name => name.startsWith(`${postId}__`)) : [];
  if (numbered.length > 1) return null;
  const folder = numbered[0] || folders.find(name => !/^[1-9]\d*__/.test(name) && normalizeBlogTitle(name) === wanted);
  if (!folder) return null;
  const folderTitle = folder.replace(/^[1-9]\d*__/, "");
  const sourceBundleKey = postId ? `post:${postId}` : `folder:${folder}`;
  const sourceBundleLabel = folderTitle;
  const dir = path.join(corpus, folder);
  const files = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith(".zip")).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const filename of files) {
    try {
      const filePath = path.join(dir, filename);
      const info = await stat(filePath);
      if (!info.isFile() || info.size === 0 || info.size > 100 * 1024 * 1024) continue;
      const { zip, entries } = inspectSubtitleArchive(await readFile(filePath));
      const request = { episode, sourceEpisode: (startEpisodeOverride || 1) + episode - 1, season: seasonNumber ?? 1 };
      const selected = selectEpisodeEntries(entries, request,
        [readEpisodeEvidence(folderTitle), readEpisodeEvidence(filename, true)]);
      if (selected.length !== 1) continue;
      const entry = selected[0];
      const subtitle = decodeSubtitleFile(zip.getEntries()[entry.index].getData(), entry.filename);
      if (subtitle?.content) {
        return { blogTitle: folderTitle, name: subtitle.filename, orig_filename: subtitle.orig_filename, content: subtitle.content,
          format: subtitle.format, is_ass: subtitle.is_ass, sourceBundleKey, sourceBundleLabel };
      }
    } catch {}
  }
  // New weekly downloads can be loose files; they do not need repacking or registry rewrites.
  const loose = (await readdir(dir)).filter(name => /\.(?:ass|ssa|srt|smi|vtt)$/i.test(name))
    .map(filename => ({ filename }));
  const selected = selectEpisodeEntries(loose,
    { episode, sourceEpisode: (startEpisodeOverride || 1) + episode - 1, season: seasonNumber ?? 1 },
    [readEpisodeEvidence(folderTitle)]);
  if (selected.length === 1) {
    const filename = selected[0].filename;
    const filePath = path.join(dir, filename);
    const info = await stat(filePath);
    if (info.isFile() && info.size > 0 && info.size <= 2 * 1024 * 1024) {
      const subtitle = decodeSubtitleFile(await readFile(filePath), filename);
      if (subtitle?.content) return { blogTitle: folderTitle, name: subtitle.filename, orig_filename: subtitle.orig_filename,
        content: subtitle.content, format: subtitle.format, is_ass: subtitle.is_ass, sourceBundleKey, sourceBundleLabel };
    }
  }
  return null;
}
