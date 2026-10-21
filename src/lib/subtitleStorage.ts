import { toSourceEpisode } from "@/lib/episodeMapping";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { deleteUploadedSubtitle as deleteLegacyUploadedSubtitle, getUploadedSubtitle as getLegacyUploadedSubtitle } from "@/lib/db";
import { extractSubtitleFromBuffer, decodeSubtitleFile } from "@/lib/subtitles";
import { episodeFromSubtitleFilename, inspectSubtitleArchive } from "@/lib/subtitleUpload";
import { parseSeason } from "@/lib/subtitles";
import { readEpisodeEvidence, readWorkTitleEvidence, evidenceAgrees, selectEpisodeEntries } from "@/lib/subtitleEpisodes";
import { normalizeSubtitleTrackFilename, bundleScopeKey, parseBundleScope, localFileKey, parseLocalFileKey, subtitleScope, scopeLabel, bundleScopesOverlap, bundleMatchesAssignment } from './subtitleLocalIdentity';

import {readSubtitleSourceManifest,sourceDigestMatches,sourceTrackIdentity} from './subtitleSourceManifest';
import { inferSiblingEpisodes, type SiblingEpisode } from './subtitleSiblingInference';
import { matchingSubtitleFolderRangePaths } from './subtitleFolderRanges';
import type { SubtitleFolderRange } from './db';
import type {DownloadRecord} from './subtitleSourceManifest';
import { excludeRegisteredLooseFiles } from './reviewedLooseSubtitles';

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
  sourceFolderKey: string;
  sourceFolderLabel: string;
  sourceBundleKey: string;
  sourceBundleLabel: string;
  localFileId: string;
  episodeConfirmed: boolean;
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
  const pending: Array<{ dir: string; depth: number }> = [{ dir: corpus, depth: 0 }];
  // Count-independent traversal: migrated libraries can contain over 50,000
  // files. Truncating here silently omits works based on filesystem order.
  while (pending.length) {
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
      if (entry.name.startsWith(".") || entry.name === "__MACOSX") continue;
      const fullPath = path.join(current.dir, entry.name);
      if (entry.isDirectory() && current.depth < 10) pending.push({ dir: fullPath, depth: current.depth + 1 });
      else if (entry.isFile() && entry.name.toLowerCase() === "finish.txt") {
        finishPaths.push(fullPath);
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

  const finishDirs = new Set(indexed.filter((entry) => entry !== null)
    .map((entry) => path.dirname(entry!.finishPath)));

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

export async function getLocalSubtitleFolder(bundleKey:string) {
  const scope=parseBundleScope(bundleKey);if(scope?.type!=='folder')return null;
  try {
    const base=path.join(root,`${scope.provider}_subtitles`),dir=path.join(base,scope.work);
    const actualRoot=await realpath(root),actualBase=await realpath(base),actual=await realpath(dir);
    if(!actualBase.startsWith(actualRoot+path.sep) || !actual.startsWith(actualBase+path.sep) || !(await stat(dir)).isDirectory())return null;
    // Refuse directory aliases so ownership has exactly one physical name.
    if(actual!==dir || actualBase!==base)return null;
    return {folderName:scope.work,provider:scope.provider,folderKey:bundleKey,
      label:scopeLabel(scope.work.replace(/^[1-9]\d*__/,''),scope)};
  }catch(error:any){if(error.code==='ENOENT' || error.code==='ENOTDIR')return null;throw error;}
}
export async function searchLocalSubtitleFolders(query:string) {
  const needle=normalizeBlogTitle(query);if(needle.length<2)return [];
  const matches:Array<{folderName:string;provider:'aniall'|'anissia';folderKey:string}>=[];
  for(const provider of ['aniall','anissia'] as const) {
    try {
      for(const entry of await readdir(path.join(root,`${provider}_subtitles`),{withFileTypes:true})) {
        if(!entry.isDirectory() || entry.name.startsWith('.') || !normalizeBlogTitle(entry.name).includes(needle))continue;
        const scope=subtitleScope('',entry.name);
        matches.push({folderName:entry.name,provider,folderKey:bundleScopeKey({type:'folder',provider,work:entry.name,...scope})});
      }
    }catch(error:any){if(error.code!=='ENOENT')throw error;}
  }
  return matches.sort((a,b)=>a.folderName.localeCompare(b.folderName,'ko')).slice(0,200);
}

function selectWithSiblingEvidence<T extends {filename:string}>(
  entries:T[], request:{episode:number;sourceEpisode:number;season:number},
  outer:ReturnType<typeof readEpisodeEvidence>[], siblings:Map<string,SiblingEpisode>,
):T[] {
  if (outer.some(e=>!evidenceAgrees(e,request))) return [];
  const parsed=entries.map(entry=>readEpisodeEvidence(entry.filename,true));
  const explicitSeasons=new Set(parsed.flatMap(e=>e.season?[e.season]:[]));
  const combined=explicitSeasons.size>1 || outer.some(e=>e.multipleSeasons);
  const scopedSeason=outer.some(e=>e.season===request.season && !e.multipleSeasons);
  const explicitOffset=request.sourceEpisode!==request.episode;
  // Keep the existing fail-closed rule for mixed-season ZIPs and unscoped
  // season-two filenames, even when the changing digit looks like an episode.
  const inferred=entries.filter(entry=>{
    const sibling=siblings.get(entry.filename);
    if (!sibling) return false;
    const evidence=readEpisodeEvidence(entry.filename,true);
    if (evidence.multipleSeasons || (evidence.season && evidence.season!==request.season)) return false;
    if (!evidence.season && !explicitOffset && (combined || (request.season>1 && !scopedSeason))) return false;
    // An explicitly recognized, contradictory single episode wins over
    // inferred siblings. Inference can still recover an ambiguous filename.
    if (!evidence.range && evidence.episodes.length===1 && evidence.episodes[0]!==sibling.episode) return false;
    const derived={...evidence,episodes:[sibling.episode],conflict:false,range:false,
      seasonRelative:Boolean(evidence.season && evidence.season===request.season)};
    return evidenceAgrees(derived,request);
  });
  // Resolve confident sibling series FIRST, while retaining a legacy
  // fallback for other unrelated files in this same folder/ZIP. Otherwise
  // one recognized series could accidentally hide another valid release.
  const proven=new Set(inferred.map(entry=>entry.filename));
  const fallback=selectEpisodeEntries(entries,request,outer).filter(entry=>
    !siblings.has(entry.filename) && !proven.has(entry.filename));
  return [...inferred,...fallback];
}

function anissiaTrackIdentity(creator: string, archiveFilename: string, entryFilename: string, episode: number, sibling?:SiblingEpisode) {
  const rangePattern = /(?:^|[^\d])\d{1,3}\s*[-~]\s*\d{1,3}(?!\d)/;
  // Only ZIP archives can describe a multi-episode range. In a loose
  // subtitle "S1 - 01.smi", the same digits are season + episode, not a range.
  const archiveBase = path.basename(archiveFilename).replace(/\.(zip)$/i, "");
  const archiveTrackBase = /\.zip$/i.test(archiveFilename) ? archiveBase.replace(rangePattern, "{range}") : archiveBase;
  const legacyArchive = normalizeSubtitleTrackFilename(archiveTrackBase, episode);
  // Prefer consistent sibling evidence when the previous single-file parser
  // could not normalize an episode slot. Preserve existing saved track IDs
  // whenever that parser already produced the {ep} placeholder.
  const normalizedArchive = sibling && !/\.zip$/i.test(archiveFilename) && !legacyArchive.includes('{ep}')
    ? sibling.template : legacyArchive;
  const entryEvidence=readEpisodeEvidence(entryFilename,true);
  const entryEpisode=entryEvidence.episodes.length===1 ? entryEvidence.episodes[0] : episodeFromSubtitleFilename(entryFilename);
  const legacyEntry = entryEpisode === episode ? normalizeSubtitleTrackFilename(entryFilename, episode) : "";
  const normalizedEntry = sibling && !legacyEntry.includes('{ep}') ? sibling.template : legacyEntry;
  const trackKey = [normalizeBlogTitle(creator), normalizeBlogTitle(normalizedArchive), normalizeBlogTitle(normalizedEntry)].join("|");
  const entryTrack = normalizedEntry.match(/\{ep\}[\s._-]*([a-z][a-z0-9._-]*)$/i)?.[1] || "";
  const archiveTrack = normalizedArchive.match(/(?:\{ep\}|\{range\})[\s._-]*([a-z][a-z0-9._-]*)$/i)?.[1] || "";
  const variant = entryTrack || archiveTrack;
  const trackLabel = /^ns$/i.test(variant) ? "논스폰서판"
    : /^s$/i.test(variant) ? "스폰서판"
      : variant ? variant + " 트랙" : "자막 트랙";
  return { localArchiveTrackKey: trackKey, localArchiveTrackLabel: trackLabel };
}

function rawBundleIdentity(provider: 'aniall'|'anissia', relative: string, member: string, creator: string, title: string, sourceRecord?:DownloadRecord, sibling?:SiblingEpisode) {
  const parts=relative.split('/'),filename=parts[parts.length-1];
  const evidence=readEpisodeEvidence(parts[2] || '');
  const fileEvidence=readEpisodeEvidence(member || filename,true);
  const episode=sibling?.episode || (fileEvidence.episodes.length===1 ? fileEvidence.episodes[0] : episodeFromSubtitleFilename(member || filename)) || (evidence.episodes.length===1 ? evidence.episodes[0] : 1);
  const identity=anissiaTrackIdentity(creator,filename,member || filename,episode,sibling);
  const scope=subtitleScope(member || parts.slice(2).join('/'),`${title} ${filename}`,parseSeason(title) || 1);
  return {sourceFolderKey:bundleScopeKey({type:'folder',provider,work:parts[1],...scope}),sourceFolderLabel:scopeLabel(title,scope),
    sourceBundleKey:bundleScopeKey({type:'local',provider,work:parts[1],track:identity.localArchiveTrackKey+(sourceRecord ? '|source:'+sourceTrackIdentity(sourceRecord) : ''),...scope}),
    sourceBundleLabel:scopeLabel(title,scope)};
}
function anissiaSourceCreator(record:DownloadRecord|undefined,fallback:string):string {
  // Registered provenance belongs to these exact bytes; a work-root marker
  // may instead describe a different creator's most recent download.
  const primary=record?.sources[0];
  return primary?.source==='anissia' ? primary.creator?.trim() || fallback : fallback;
}

/** Find an offline Anissia subtitle archive using its adjacent finish.txt metadata. */
export async function getAnissiaArchiveSubtitles(
  titles: string[],
  episode: number,
  animeNo?: number | null,
  seasonNumber?: number | null,
  options: { folderNameQuery?: string; maxResults?: number; localEpisode?: number; bundleKey?: string; manualSearch?: boolean } = {},
): Promise<AnissiaArchiveSubtitle[]> {
  if (!Number.isSafeInteger(episode) || episode < 1) return [];
  const wantedTitles = new Set(titles.map(normalizeBlogTitle).filter((value) => value.length >= 2));
  const folderNameQuery = normalizeBlogTitle(options.folderNameQuery || "");
  const resultLimit = options.maxResults || (folderNameQuery ? 50 : 12);
  const assignedScope = options.bundleKey ? parseBundleScope(options.bundleKey) : null;
  if (options.bundleKey && (!assignedScope || (assignedScope.type!=='local' && assignedScope.type!=='folder') || assignedScope.provider !== 'anissia')) return [];
  const wantedSeason = assignedScope?.season || seasonNumber || titles.map(parseSeason).find((value) => value !== null) || null;
  const request = { episode: options.localEpisode ?? episode, sourceEpisode: episode, season: wantedSeason ?? 1 };
  const index = await getAnissiaArchiveIndex();
  const sourceFiles=await readSubtitleSourceManifest(root);
  const sourceDirectories=new Map<string,Set<string>>();
  for(const [file,record] of Object.entries(sourceFiles)) {
    const directory=file.slice(0,file.lastIndexOf('/'));
    const ids=sourceDirectories.get(directory) || new Set<string>();
    record.sources.filter(s=>s.source==='anissia').forEach(s=>ids.add(s.id));sourceDirectories.set(directory,ids);
  }
  const matched: Array<{ entry: AnissiaArchiveIndexEntry; title: string; creator: string; website: string; order: number }> = [];

  for (const entry of index) {
    const folderParts = anissiaFolderParts(entry.finishPath);
    const workPath = path.relative(path.join(root,'anissia_subtitles'),path.dirname(entry.finishPath)).split(path.sep)[0];
    if ((assignedScope?.type === 'local' || assignedScope?.type === 'folder') && assignedScope.work !== workPath) continue;
    const metadataAnimeNo = recordNumber(entry.record, ["animeNo", "anime_no", "anissiaNo"]);
    if (metadataAnimeNo && folderParts.animeNo && metadataAnimeNo !== folderParts.animeNo) continue;
    const recordAnimeNo = metadataAnimeNo || folderParts.animeNo;
    const folderTitle = folderParts.title || path.basename(path.dirname(path.dirname(path.dirname(entry.finishPath))));
    const recordTitle = recordValue(entry.record, ["subject", "animeTitle", "workTitle", "title", "anime_name", "work"]) || folderTitle;
    const exactTitleMatch = [recordTitle, folderTitle].some((value) => wantedTitles.has(normalizeBlogTitle(value)));
    const folderNameMatch = (assignedScope?.type === 'local' || assignedScope?.type === 'folder') ? true : folderNameQuery
      ? normalizeBlogTitle(folderTitle).includes(folderNameQuery)
      : animeNo && recordAnimeNo ? recordAnimeNo === animeNo : exactTitleMatch;
    const directoryKey=path.relative(root,path.dirname(entry.finishPath)).split(path.sep).join('/');
    const hasSourceId=animeNo && sourceDirectories.get(directoryKey)?.has(String(animeNo));
    if (!folderNameMatch && !hasSourceId) continue;

    // A marker at the work root describes the last download, not every file
    // in a flattened multi-episode folder. Require per-file episode evidence.
    const recordEpisode = folderParts.episode
      ? recordValue(entry.record, ["episode", "episodeNumber", "episode_number", "episodeNo", "ep"]) : "";
    const episodeFolder = folderParts.episode;
    if (!options.manualSearch && [readEpisodeEvidence(recordEpisode), readEpisodeEvidence(episodeFolder)].some(e => !evidenceAgrees(e, request))) continue;

    const titleSeason = parseSeason(recordTitle) || parseSeason(folderTitle);
    if (!options.manualSearch && !assignedScope && wantedSeason && titleSeason && wantedSeason !== titleSeason) continue;
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
    // Only compare sibling filenames in this exact physical directory.
    const looseSiblings = inferSiblingEpisodes(loose);
    const recordEpisode = folderParts.episode
      ? recordValue(candidate.entry.record, ["episode", "episodeNumber", "episode_number", "episodeNo", "ep"]) : "";
    const episodeFolder = folderParts.episode;
    const outer = [...(assignedScope ? [{...readEpisodeEvidence(''),season:assignedScope.season}] : [readWorkTitleEvidence(candidate.title)]),readEpisodeEvidence(recordEpisode),readEpisodeEvidence(episodeFolder)];

    for (const filename of [...archives, ...loose]) {
      try {
        const filePath = path.join(dir, filename);
        const sourceRecord=sourceFiles[path.relative(root,filePath).split(path.sep).join('/')];
        const fileCreator=anissiaSourceCreator(sourceRecord,candidate.creator);
        if(!assignedScope && animeNo && !sourceRecord && recordNumber(candidate.entry.record,["animeNo","anime_no","anissiaNo"]) && recordNumber(candidate.entry.record,["animeNo","anime_no","anissiaNo"])!==animeNo)continue;
        if(!assignedScope && animeNo && sourceRecord && !sourceRecord.sources.some(s=>s.source==='anissia' && s.id===String(animeNo))) continue;
        const info = await stat(filePath);
        if (!info.isFile() || info.size <= 0 || info.size > 100 * 1024 * 1024) continue;

        const addSubtitle = (subtitle: ReturnType<typeof extractSubtitleFromBuffer>, bytes: Buffer, member: string, confirmed: boolean, sibling?:SiblingEpisode) => {
          if (!subtitle?.content) return;
          const identity = anissiaTrackIdentity(fileCreator, filename, member || filename, sibling?.episode || episode, sibling);
          const relative = path.relative(root,filePath).split(path.sep).join('/');
          const scope = subtitleScope(member || filename, `${candidate.title} ${filename}`, parseSeason(candidate.title) || 1);
          const bundle = rawBundleIdentity('anissia',relative,member,fileCreator,candidate.title,sourceRecord,sibling);
          const sourceBundleKey = bundle.sourceBundleKey;
          if (options.bundleKey && !bundleMatchesAssignment(options.bundleKey,sourceBundleKey)) return;
          const expectedKind = assignedScope?.kind || subtitleScope('',titles.join(' ')).kind;
          if (!options.manualSearch && parseBundleScope(sourceBundleKey)!.kind !== expectedKind) return;
          results.push({
            name: subtitle.filename,
            orig_filename: subtitle.orig_filename,
            content: subtitle.content,
            format: subtitle.format,
            is_ass: subtitle.is_ass,
            episode,
            creator: fileCreator,
            website: candidate.website,
            matchedTitle: candidate.title,
            updatedAt: candidate.entry.updatedAt,
            animeNo: sourceRecord ? Number(sourceRecord.sources.find(s=>s.source==='anissia' && (!animeNo || s.id===String(animeNo)))?.id) || null : recordNumber(candidate.entry.record, ["animeNo", "anime_no", "anissiaNo"]) || folderParts.animeNo,
            archiveFilename: filename,
            ...identity, sourceBundleKey, sourceFolderKey:bundle.sourceFolderKey,sourceFolderLabel:bundle.sourceFolderLabel,
            sourceBundleLabel: bundle.sourceBundleLabel,
            localFileId: localFileKey(path.relative(root,filePath).split(path.sep).join('/'),member,createHash('sha256').update(bytes).digest('hex')),
            episodeConfirmed: confirmed,
          });
        };

        if (filename.toLowerCase().endsWith(".zip")) {
          const archiveBytes=await readFile(filePath);if(!sourceDigestMatches(sourceRecord,archiveBytes))continue;
          const { zip, entries } = inspectSubtitleArchive(archiveBytes);
          const zipSiblings = inferSiblingEpisodes(entries.map(item=>item.filename));
          const scoped = options.bundleKey ? entries.filter(item=>bundleMatchesAssignment(options.bundleKey!,rawBundleIdentity('anissia',path.relative(root,filePath).split(path.sep).join('/'),item.filename,fileCreator,candidate.title,sourceRecord,zipSiblings.get(item.filename)).sourceBundleKey)) : entries;
          const archiveEvidence=readEpisodeEvidence(filename,true);
          if(assignedScope) archiveEvidence.season=null;
          const selectedEntries = selectWithSiblingEvidence(scoped, request,[...outer, archiveEvidence],zipSiblings);
          const manualEntries = options.manualSearch ? entries : [];
          for (const item of [...new Map([...selectedEntries,...manualEntries].map(item=>[item.index,item])).values()]) {
            try {
              const bytes = zip.getEntries()[item.index].getData();
              addSubtitle(decodeSubtitleFile(bytes, item.filename),bytes,item.filename,selectedEntries.includes(item),zipSiblings.get(item.filename));
            } catch {}
            if (results.length >= resultLimit) break;
          }
        } else {
          const bytes = await readFile(filePath);if(!sourceDigestMatches(sourceRecord,bytes))continue;
          const inferred = looseSiblings.has(filename) && selectWithSiblingEvidence([{filename}],request,outer,looseSiblings).length===1;
          const exact = inferred ? decodeSubtitleFile(bytes,filename) : extractSubtitleFromBuffer(bytes, episode, filename, true, wantedSeason,
            { localEpisode: request.episode, evidence: outer });
          const manual = options.manualSearch;
          addSubtitle(exact || (manual ? decodeSubtitleFile(bytes,filename) : null),bytes,'',Boolean(exact),looseSiblings.get(filename));
        }
      } catch {}
      if (results.length >= resultLimit) break;
    }
    if (results.length >= resultLimit) break;
  }
  return options.bundleKey ? results : excludeRegisteredLooseFiles(results);
}

async function folderSubtitleFiles(directory:string) {
  const pending=[{dir:directory,depth:0}],files:string[]=[];
  while(pending.length) {
    const current=pending.pop()!;
    for(const entry of await readdir(current.dir,{withFileTypes:true})) {
      if(entry.name.startsWith('.') || entry.name==='__MACOSX')continue;
      const file=path.join(current.dir,entry.name);
      if(entry.isDirectory() && current.depth<10)pending.push({dir:file,depth:current.depth+1});
      else if(entry.isFile() && /\.(?:zip|ass|ssa|smi|srt|vtt)$/i.test(entry.name))files.push(path.relative(directory,file).split(path.sep).join('/'));
    }
    if(files.length>10000)throw new Error('Too many subtitles in selected folder');
  }
  return files;
}

/** Explicit folder browsing is independent of playback season/episode matching.
 * Return only names, not subtitle bodies, and preserve the physical subfolder paths.
 */
const validBrowseRelative = (value: string) => Boolean(value) && value.length <= 2500
  && !value.includes('\\') && !value.includes('\0') && !value.startsWith('/')
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');

export async function listLocalSubtitleFolderFiles(bundleKey: string, offset = 0, filter = '') {
  const folder = await getLocalSubtitleFolder(bundleKey);
  if (!folder || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000
      || filter.length > 200) return null;
  const dir = path.join(root, folder.provider + '_subtitles', folder.folderName);
  const filenames = await folderSubtitleFiles(dir);
  const rows: Array<{path:string;member:string;label:string}> = [];
  for (const filename of filenames) {
    if (!validBrowseRelative(filename)) continue;
    if (!/\.zip$/i.test(filename)) {
      rows.push({path:filename,member:'',label:filename});
      continue;
    }
    try {
      const info = await stat(path.join(dir,filename));
      if (!info.isFile() || !info.size || info.size > 100 * 1024 * 1024) continue;
      const {entries} = inspectSubtitleArchive(await readFile(path.join(dir,filename)));
      for (const entry of entries) {
        if (!validBrowseRelative(entry.filename)) continue;
        rows.push({path:filename,member:entry.filename,label:filename + ' / ' + entry.filename});
        if (rows.length > 20000) throw new Error('Selected folder has too many subtitle entries');
      }
    } catch (error) {
      if (rows.length > 20000) throw error;
      // A corrupt ZIP is not a reason to hide readable sibling subtitle files.
    }
  }
  const needle = filter.normalize('NFKC').toLocaleLowerCase('ko-KR').trim();
  const matches = (needle ? rows.filter(row => row.label.normalize('NFKC').toLocaleLowerCase('ko-KR').includes(needle)) : rows)
    .sort((a,b) => a.label.localeCompare(b.label,'ko',{numeric:true}));
  return {files:matches.slice(offset,offset+100), total:matches.length, nextOffset:offset+100< matches.length ? offset+100:null};
}

/** Resolve exactly the selected folder member on demand; never trust a client file ID. */
export async function getLocalSubtitleFolderFile(bundleKey:string, relative:string, member = '') {
  const folder = await getLocalSubtitleFolder(bundleKey);
  if (!folder || !validBrowseRelative(relative) || (member && !validBrowseRelative(member))) return null;
  if (!/\.(?:zip|ass|ssa|smi|srt|vtt)$/i.test(relative) || (member && !/\.zip$/i.test(relative))) return null;
  const dir = path.join(root,folder.provider + '_subtitles',folder.folderName);
  try {
    const file = path.join(dir,...relative.split('/'));
    const resolved = await realpath(file);
    if (!resolved.startsWith(dir + path.sep)) return null;
    const info = await stat(resolved);
    if (!info.isFile() || !info.size || info.size > (member ? 100 : 2) * 1024 * 1024) return null;
    let bytes: Buffer;
    if (member) {
      const {zip,entries} = inspectSubtitleArchive(await readFile(resolved));
      const entry = entries.find(item=>item.filename===member);
      if (!entry) return null;
      bytes = zip.getEntries()[entry.index].getData();
    } else {
      if (/\.zip$/i.test(relative)) return null;
      bytes = await readFile(resolved);
    }
    const sourceRelative = path.relative(root,file).split(path.sep).join('/');
    return getLocalSubtitleFile(localFileKey(sourceRelative,member,createHash('sha256').update(bytes).digest('hex')));
  } catch { return null; }
}

export async function getAniAllArchiveSubtitles(blogTitle: string, episode: number, seasonNumber: number | null = null,
  startEpisodeOverride: number | null = null, postUrl = '', options: {bundleKey?: string; manualSearch?: boolean} = {}) {
  const corpus = path.join(root, 'aniall_subtitles');
  const assigned = options.bundleKey ? parseBundleScope(options.bundleKey) : null;
  if (options.bundleKey && (!assigned || (assigned.type!=='local' && assigned.type!=='folder') || assigned.provider !== 'aniall')) return [];
  let folders: string[];
  try { folders = (await readdir(corpus, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name); } catch (error: any) { if (error?.code === 'ENOENT') return []; throw error; }
  const postId = postUrl.match(/^https?:\/\/aniall\.tistory\.com\/([1-9]\d*)(?:[/?#]|$)/i)?.[1];
  const sourceFiles=await readSubtitleSourceManifest(root);
  const registeredFolders=postId ? [...new Set(Object.entries(sourceFiles).filter(([p,r])=>p.startsWith('aniall_subtitles/') && r.sources.some(s=>s.source==='aniall' && s.id===postId)).map(([p])=>p.split('/')[1]))].filter(p=>folders.includes(p)) : [];
  if(registeredFolders.length>1 && !assigned) return [];
  const numbered = postId ? folders.filter(name => name.startsWith(`${postId}__`)) : [];
  if (numbered.length > 1) return [];
  const folder = (assigned?.type === 'local' || assigned?.type === 'folder') ? folders.find(name => name === assigned.work)
    : registeredFolders[0] || numbered[0] || folders.find(name => !/^[1-9]\d*__/.test(name) && normalizeBlogTitle(name) === normalizeBlogTitle(blogTitle));
  if (!folder) return [];
  const folderTitle = folder.replace(/^[1-9]\d*__/, '');
  const dir = path.join(corpus,folder), names = assigned ? await folderSubtitleFiles(dir) : await readdir(dir);
  const sourceFor=(filename:string)=>sourceFiles[`aniall_subtitles/${folder}/${filename}`];
  const eligibleFile=(filename:string)=>!sourceFor(filename) || Boolean(options.bundleKey || options.manualSearch || (postId && sourceFor(filename)!.sources.some(s=>s.source==='aniall' && s.id===postId)));
  const request = {episode,sourceEpisode:toSourceEpisode(episode,startEpisodeOverride),season:assigned?.season || seasonNumber || 1};
  const wantedKind = assigned?.kind || subtitleScope('',blogTitle).kind;
  const results: Array<{blogTitle:string;name:string;orig_filename:string;content:string;format:'ASS'|'VTT';is_ass:boolean;
    sourceBundleKey:string;sourceBundleLabel:string;sourceFolderKey:string;sourceFolderLabel:string;localFileId:string;episodeConfirmed:boolean}> = [];
  const add = (filename: string, member: string, bytes: Buffer, confirmed: boolean, sibling?:SiblingEpisode) => {
    const scope = subtitleScope(member || filename, `${folderTitle} ${filename}`,parseSeason(folderTitle) || 1);
    const relative=path.relative(root,path.join(dir,filename)).split(path.sep).join('/');
    const bundle=rawBundleIdentity('aniall',relative,member,'aniall',folderTitle,sourceFor(filename),sibling), key=bundle.sourceBundleKey;
    if ((options.bundleKey && !bundleMatchesAssignment(options.bundleKey,key)) || (!options.manualSearch && scope.kind !== wantedKind)) return;
    const subtitle = decodeSubtitleFile(bytes,member || filename);
    if (!subtitle?.content) return;
    results.push({blogTitle:folderTitle,name:subtitle.filename,orig_filename:subtitle.orig_filename,content:subtitle.content,
      format:subtitle.format,is_ass:subtitle.is_ass,sourceBundleKey:key,sourceBundleLabel:bundle.sourceBundleLabel,sourceFolderKey:bundle.sourceFolderKey,sourceFolderLabel:bundle.sourceFolderLabel,episodeConfirmed:confirmed,
      localFileId:localFileKey(path.relative(root,path.join(dir,filename)).split(path.sep).join('/'),member,createHash('sha256').update(bytes).digest('hex'))});
  };
  for (const filename of names.filter(n=>/\.zip$/i.test(n) && eligibleFile(n)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}))) {
    try {
      const file = path.join(dir,filename), info = await stat(file);
      if (!info.isFile() || !info.size || info.size > 100*1024*1024) continue;
      const archiveBytes=await readFile(file);if(!sourceDigestMatches(sourceFor(filename),archiveBytes))continue;
      const {zip,entries} = inspectSubtitleArchive(archiveBytes);
      const zipSiblings=inferSiblingEpisodes(entries.map(e=>e.filename));
      const scoped=options.bundleKey ? entries.filter(e=>bundleMatchesAssignment(options.bundleKey!,rawBundleIdentity('aniall',path.relative(root,file).split(path.sep).join('/'),e.filename,'aniall',folderTitle,sourceFor(filename),zipSiblings.get(e.filename)).sourceBundleKey)) : entries;
      const archiveEvidence=readEpisodeEvidence(filename,true);if(assigned) archiveEvidence.season=null;
      const selected = selectWithSiblingEvidence(scoped,request,[...(assigned?[{...readEpisodeEvidence(''),season:assigned.season}]:[readWorkTitleEvidence(folderTitle)]),archiveEvidence],zipSiblings);
      const manual = options.manualSearch ? entries : [];
      for (const entry of [...new Map([...selected,...manual].map(e=>[e.index,e])).values()]) {
        add(filename,entry.filename,zip.getEntries()[entry.index].getData(),selected.includes(entry),zipSiblings.get(entry.filename));
        if(results.length>=50) break;
      }
    } catch { /* An unreadable ZIP cannot authorize a different episode. */ }
    if(results.length>=50) break;
  }
  const loose = names.filter(n=>/\.(?:ass|ssa|srt|smi|vtt)$/i.test(n) && eligibleFile(n)).map(filename=>({filename}));
  const looseSiblings = inferSiblingEpisodes(loose.map(item=>item.filename));
  const scopedLoose=options.bundleKey ? loose.filter(e=>bundleMatchesAssignment(options.bundleKey!,rawBundleIdentity('aniall',path.relative(root,path.join(dir,e.filename)).split(path.sep).join('/'),'','aniall',folderTitle,sourceFor(e.filename),looseSiblings.get(e.filename)).sourceBundleKey)) : loose;
  const selected = selectWithSiblingEvidence(scopedLoose,request,assigned ? [{...readEpisodeEvidence(''),season:assigned.season}] : [readWorkTitleEvidence(folderTitle)],looseSiblings);
  const manual = options.manualSearch ? loose : [];
  for (const entry of [...new Map([...selected,...manual].map(e=>[e.filename,e])).values()]) {
    try {
      const file=path.join(dir,entry.filename),info=await stat(file);
      if(info.isFile() && info.size > 0 && info.size <= 2*1024*1024) {const bytes=await readFile(file);if(sourceDigestMatches(sourceFor(entry.filename),bytes))add(entry.filename,'',bytes,selected.includes(entry),looseSiblings.get(entry.filename));}
    } catch { /* Keep other readable candidates available for manual selection. */ }
    if(results.length>=50) break;
  }
  return results;
}

/** Legacy single-result callers never resolve a variant conflict by file order. */
export async function getAniAllArchiveSubtitle(blogTitle: string, episode: number, seasonNumber: number | null = null,
  startEpisodeOverride: number | null = null, postUrl = '') {
  const subtitles = await getAniAllArchiveSubtitles(blogTitle,episode,seasonNumber,startEpisodeOverride,postUrl);
  return subtitles.length === 1 ? subtitles[0] : null;
}

/** Resolve one exact user-selected local file. Its original bytes must still match. */
export async function getLocalSubtitleFile(fileId: string) {
  const reference=parseLocalFileKey(fileId);
  if(!reference) return null;
  const parts=reference.relative.split('/');
  const provider=parts[0]==='aniall_subtitles'?'aniall':parts[0]==='anissia_subtitles'?'anissia':null;
  if(!provider || parts.length<3) return null;
  try {
    const file=path.join(root,reference.relative),resolved=await realpath(file);
    const allowed=await realpath(path.join(root,`${provider}_subtitles`));
    if(!allowed.startsWith((await realpath(root))+path.sep)) return null;
    if(!resolved.startsWith(allowed+path.sep)) return null;
    const info=await stat(resolved);
    if(!info.isFile() || !info.size || info.size>100*1024*1024) return null;
    const sourceRecord=(await readSubtitleSourceManifest(root))[reference.relative];
    const originalBytes=await readFile(resolved);if(!sourceDigestMatches(sourceRecord,originalBytes))return null;
    let bytes: Buffer, filename=path.basename(file);
    let sibling:SiblingEpisode|undefined;
    if(reference.member) {
      if(!/\.zip$/i.test(file)) return null;
      const {zip,entries}=inspectSubtitleArchive(originalBytes);
      const selected=entries.find(e=>e.filename===reference.member);
      if(!selected) return null;
      bytes=zip.getEntries()[selected.index].getData();filename=selected.filename;
      sibling=inferSiblingEpisodes(entries.map(item=>item.filename)).get(reference.member);
    } else {
      if(info.size>2*1024*1024 || !/\.(ass|ssa|smi|srt|vtt)$/i.test(file)) return null;
      bytes=originalBytes;
      sibling=inferSiblingEpisodes(await readdir(path.dirname(file))).get(filename);
    }
    if(createHash('sha256').update(bytes).digest('hex')!==reference.sha256) return null;
    const subtitle=decodeSubtitleFile(bytes,filename);if(!subtitle?.content) return null;
    const entry=provider==='anissia' ? (await getAnissiaArchiveIndex()).find(e=>path.dirname(e.finishPath)===path.dirname(file)) : null;
    const title=parts[1].replace(/^[1-9]\d*__/, '');
    const creator=provider==='aniall'?'aniall':anissiaSourceCreator(sourceRecord,entry ? recordValue(entry.record,['name','creator','creatorName','captionName']) || parts[3] || '로컬 파일' : parts[3] || '로컬 파일');
    const workTitle=entry ? recordValue(entry.record,['subject','animeTitle','workTitle','title','anime_name','work']) || title : title;
    return {name:subtitle.filename,orig_filename:subtitle.orig_filename,content:subtitle.content,format:subtitle.format,is_ass:subtitle.is_ass,
      localFileId:fileId,sourceProvider:provider,sourceMatchedTitle:workTitle,localArchive:true,
      ...rawBundleIdentity(provider,reference.relative,reference.member,creator,workTitle,sourceRecord,sibling)};
  } catch(error:any) { if(error?.code!=='ENOENT' && error?.code!=='ENOTDIR') console.warn('[Local subtitle override unreadable]',error.message); return null; }
}



/**
 * Exact folder-range playback. This intentionally bypasses the normal work-wide
 * season matcher without changing its behavior. A missing or ambiguous slice is
 * fail-closed so playback never silently jumps to a wrong subtitle.
 */
export async function getSubtitleForFolderRange(range: SubtitleFolderRange, episode: number) {
  const scope=parseBundleScope(range.folderKey);
  if(scope?.type!=='folder' || scope.provider!==range.provider || scope.season!==range.season
      || !(await getLocalSubtitleFolder(range.folderKey))) return {subtitle:null,reason:'unavailable' as const};
  const dir=path.join(root,`${scope.provider}_subtitles`,scope.work);
  type Candidate={relative:string;member:string;bytes?:Buffer};
  const candidates:Candidate[]=[];
  let names:string[];
  try {names=await folderSubtitleFiles(dir);} catch {return {subtitle:null,reason:'unavailable' as const};}
  const loose=names.filter(name=>/\.(?:ass|ssa|smi|srt|vtt)$/i.test(name));
  for(const filename of matchingSubtitleFolderRangePaths(loose,range,episode)) {
    candidates.push({relative:path.relative(root,path.join(dir,filename)).split(path.sep).join('/'),member:''});
  }
  for(const filename of names.filter(name=>/\.zip$/i.test(name))) {
    try {
      const file=path.join(dir,filename),info=await stat(file);
      if(!info.isFile() || info.size<=0 || info.size>100*1024*1024)continue;
      const {zip,entries}=inspectSubtitleArchive(await readFile(file));
      const matches=matchingSubtitleFolderRangePaths(entries.map(item=>`${filename}/${item.filename}`),range,episode);
      for(const item of entries) {
        if(!matches.includes(`${filename}/${item.filename}`))continue;
        candidates.push({relative:path.relative(root,file).split(path.sep).join('/'),member:item.filename,
          bytes:zip.getEntries()[item.index].getData()});
      }
    } catch { /* Skip unreadable archive without changing the assigned range. */ }
    if(candidates.length>1)break;
  }
  if(candidates.length!==1)return {subtitle:null,reason:candidates.length?'ambiguous' as const:'missing' as const};
  const candidate=candidates[0];
  try {
    const bytes=candidate.bytes || await readFile(path.join(root,candidate.relative));
    if(bytes.length>2*1024*1024 && !candidate.member) return {subtitle:null,reason:'unavailable' as const};
    const id=localFileKey(candidate.relative,candidate.member,createHash('sha256').update(bytes).digest('hex'));
    const subtitle=await getLocalSubtitleFile(id);
    if(!subtitle || subtitle.sourceProvider!==range.provider)
      return {subtitle:null,reason:'unavailable' as const};
    return {subtitle:{...subtitle,episodeConfirmed:true,bundleAssigned:true,folderRange:true},reason:null};
  } catch {
    return {subtitle:null,reason:'unavailable' as const};
  }
}
