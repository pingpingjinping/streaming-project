import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import iconv from "iconv-lite";
import { getDb } from "@/lib/db";
import { decodeSubtitleFile, parseSeason } from "@/lib/subtitles";
import { evidenceAgrees, readEpisodeEvidence, selectEpisodeEntries } from "@/lib/subtitleEpisodes";
import { bundleScopeKey, parseBundleScope, subtitleScope, scopeLabel } from './subtitleLocalIdentity';
import { LOOSE_REVIEWED_DATASET, readReviewedLooseBytes } from './reviewedLooseSubtitles';

const DATASET = "reviewed_v6_1109";
const root = () => process.env.SUBTITLE_STORAGE_DIR || path.join(process.cwd(), "data", "subtitles");
type Provider = "aniall" | "naver" | "anissia";
const supportedDataset = (dataset: string) => dataset === DATASET || dataset === LOOSE_REVIEWED_DATASET;
const fileDataset = (file: ReviewedFile) => file.dataset_key || DATASET;
function reviewedIdentity(value: string) {
  for (const dataset of [DATASET, LOOSE_REVIEWED_DATASET]) {
    if (value.startsWith(`${dataset}:`) && value.length <= 300 && value.length > dataset.length + 1)
      return { dataset, pid: value.slice(dataset.length + 1) };
  }
  return null;
}
export interface ReviewedFile {
  dataset_key?: string;
  pid: string; source: Provider; pack_id: string; zip_relative_path: string; member_path: string;
  sha256: string; archive_sha256: string; work_title_ko: string; reanime_id: string | null;
  target_source: string; target_id: string; content_extension: string;
  confirmed_episodes: number[];
}

/** The current work binding is authoritative; historical candidates never enter this query. */
export async function findReviewedFiles(animeId: string, keyword = ""): Promise<ReviewedFile[]> {
  const sql = getDb();
  if (!sql || (!animeId && !keyword)) return [];
  const reanimeId = animeId.startsWith("re_") ? animeId.slice(3) : "";
  const anissiaId = /^(?:ani_)?\d+$/.test(animeId) ? animeId.replace(/^ani_/, "") : "";
  try {
    const rows = await sql`
      SELECT f.*, a.sha256 AS archive_sha256,
        ARRAY(SELECT DISTINCT e.target_episode
          FROM anime_subtitle_file_origins o
          JOIN anime_subtitle_confirmed_episodes e ON e.dataset_key=o.dataset_key AND e.file_id=o.file_id
          WHERE o.dataset_key=f.dataset_key AND o.pid=f.pid AND e.status='confirmed_episode'
            AND ((e.target_source=f.target_source AND e.target_id=f.target_id)
              OR (e.target_source='ReAnime' AND e.target_id=f.reanime_id))
          ORDER BY e.target_episode) AS confirmed_episodes
      FROM anime_subtitle_files f
      JOIN anime_subtitle_archives a ON a.dataset_key=f.dataset_key AND a.pack_id=f.pack_id
      WHERE ((f.dataset_key=${DATASET} AND f.source IN ('aniall','naver'))
          OR (f.dataset_key=${LOOSE_REVIEWED_DATASET} AND f.source='anissia'))
        AND f.work_confirmed=TRUE
        AND ((${keyword}<>'' AND (strpos(lower(COALESCE(f.work_title_ko,'')),lower(${keyword}))>0
            OR strpos(lower(f.zip_relative_path),lower(${keyword}))>0 OR strpos(lower(f.member_path),lower(${keyword}))>0))
          OR (${keyword}='' AND (
            (${reanimeId}<>'' AND (
              (f.dataset_key=${LOOSE_REVIEWED_DATASET} AND f.reanime_id=${reanimeId})
              OR ((f.reanime_id=${reanimeId}
                OR (f.dataset_key=${LOOSE_REVIEWED_DATASET} AND COALESCE(f.reanime_id,'')=''))
                AND EXISTS (
                  SELECT 1 FROM anime_subtitle_work_reanime_links l WHERE l.dataset_key=${DATASET}
                    AND l.target_source=f.target_source AND l.target_id=f.target_id
                    AND l.reanime_id=${reanimeId} AND l.automatic_eligible=TRUE))))
            OR (${anissiaId}<>'' AND f.target_source='Anissia' AND f.target_id=${anissiaId}))))
      ORDER BY f.source,f.pack_id,f.pid LIMIT 5000`;
    return rows as unknown as ReviewedFile[];
  } catch (error: any) {
    // A Pi without the new registry keeps its existing weekly-download readers.
    if (error?.code === "42P01") return [];
    throw error;
  }
}

export async function findReviewedBundleFiles(source: Provider, bundleKey: string): Promise<ReviewedFile[]> {
  const sql = getDb();
  const scope = parseBundleScope(bundleKey);
  if (!sql || !scope || scope.type !== 'reviewed' || !supportedDataset(scope.dataset)) return [];
  const packId = scope.pack;
  try {
    const rows = await sql`
      SELECT f.*, a.sha256 AS archive_sha256,
        ARRAY(SELECT DISTINCT e.target_episode
          FROM anime_subtitle_file_origins o
          JOIN anime_subtitle_confirmed_episodes e ON e.dataset_key=o.dataset_key AND e.file_id=o.file_id
          WHERE o.dataset_key=f.dataset_key AND o.pid=f.pid AND e.status='confirmed_episode'
            AND ((e.target_source=f.target_source AND e.target_id=f.target_id)
              OR (e.target_source='ReAnime' AND e.target_id=f.reanime_id))
          ORDER BY e.target_episode) AS confirmed_episodes
      FROM anime_subtitle_files f
      JOIN anime_subtitle_archives a ON a.dataset_key=f.dataset_key AND a.pack_id=f.pack_id
      WHERE f.dataset_key=${scope.dataset} AND f.work_confirmed=TRUE
        AND f.source=${source} AND f.pack_id=${packId}
        AND f.target_source=${scope.workSource} AND f.target_id=${scope.workId}
      ORDER BY f.pid LIMIT 5000
    `;
    return (rows as unknown as ReviewedFile[]).filter(f => reviewedBundleKey(f) === bundleKey);
  } catch (error: any) {
    if (error?.code === "42P01") return [];
    throw error;
  }
}

export function reviewedBundleKey(file: ReviewedFile) {
  return bundleScopeKey({type:'reviewed',dataset:fileDataset(file),pack:file.pack_id,workSource:file.target_source,workId:file.target_id,
    ...subtitleScope(file.member_path,file.work_title_ko,parseSeason(file.work_title_ko) || 1)});
}

/** Explicit user exceptions may point at another work, but never at held files. */
export async function getReviewedFileForOverride(fileId: string) {
  const sql = getDb();
  const identity = reviewedIdentity(fileId);
  if (!sql || !identity) return null;
  try {
    const rows = await sql`SELECT f.*, a.sha256 AS archive_sha256
      FROM anime_subtitle_files f JOIN anime_subtitle_archives a
        ON a.dataset_key=f.dataset_key AND a.pack_id=f.pack_id
      WHERE f.dataset_key=${identity.dataset} AND f.pid=${identity.pid} AND f.work_confirmed=TRUE
        AND ((f.dataset_key=${DATASET} AND f.source IN ('aniall','naver'))
          OR (f.dataset_key=${LOOSE_REVIEWED_DATASET} AND f.source='anissia')) LIMIT 1`;
    return rows[0] ? readReviewedFile(rows[0] as unknown as ReviewedFile) : null;
  } catch (error: any) { if(error?.code === '42P01') return null; throw error; }
}

export async function findReviewedTitles(keyword: string) {
  const sql = getDb();
  if (!sql || !keyword) return [];
  try {
    const rows = await sql`SELECT DISTINCT source,work_title_ko FROM anime_subtitle_files
      WHERE ((dataset_key=${DATASET} AND source IN ('aniall','naver'))
          OR (dataset_key=${LOOSE_REVIEWED_DATASET} AND source='anissia')) AND work_confirmed=TRUE
        AND work_title_ko IS NOT NULL AND (strpos(lower(work_title_ko),lower(${keyword}))>0
          OR strpos(lower(zip_relative_path),lower(${keyword}))>0 OR strpos(lower(member_path),lower(${keyword}))>0)
      ORDER BY work_title_ko,source LIMIT 200`;
    return rows.map(r => ({folderName: String(r.work_title_ko), provider: r.source as Provider}));
  } catch (error: any) { if (error?.code === '42P01') return []; throw error; }
}

const safeRelative = (value: string) => value && !value.includes("\0") && !path.posix.isAbsolute(value)
  && !value.includes("\\") && value.split("/").every(p => p !== ".." && p !== ".");
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
let archiveIndex: { root: string; expires: number; files: Map<string,string[]> } | null = null;
async function archivePaths(): Promise<Map<string,string[]>> {
  const base = root();
  if (archiveIndex?.root === base && archiveIndex.expires > Date.now()) return archiveIndex.files;
  const files = new Map<string,string[]>();
  let count = 0;
  const walk = async (dir: string, depth: number) => {
    if (depth > 10 || count >= 20000) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch (error: any) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (++count > 20000) break;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(p, depth + 1);
      else if (entry.isFile() && /\.zip$/i.test(entry.name)) {
        files.set(entry.name, [...(files.get(entry.name) || []), p]);
      }
    }
  };
  // Include both the agreed Pi names and the original cleaned source directories.
  for (const dir of ["aniall_subtitles", "naver_subtitles", "aniall", "naver"]) await walk(path.join(base, dir), 0);
  archiveIndex = { root: base, expires: Date.now() + 60000, files };
  return files;
}

const archives = new Map<string, { signature: string; zip: AdmZip; bytes: number }>();
async function verifiedArchive(file: ReviewedFile): Promise<AdmZip | null> {
  if (!safeRelative(file.zip_relative_path) || !/^[a-f\d]{64}$/i.test(file.archive_sha256)) return null;
  const suffix = file.zip_relative_path.replace(/^(?:aniall|naver)\//, "");
  const base = root();
  const paths = [path.join(base, file.zip_relative_path), path.join(base, `${file.source}_subtitles`, suffix),
    path.join(base, `${file.source}_subtitles`, file.zip_relative_path),
    path.join(base, `${file.source}_subtitles`, path.posix.basename(file.zip_relative_path)),
    ...((await archivePaths()).get(path.posix.basename(file.zip_relative_path)) || [])];
  let realBase: string;
  try { realBase = await realpath(base); } catch { return null; }
  for (const p of new Set(paths)) {
    try {
      const resolved = await realpath(p);
      if (!resolved.startsWith(realBase + path.sep)) continue;
      const info = await stat(resolved);
      if (!info.isFile() || !info.size || info.size > 100 * 1024 * 1024) continue;
      const signature = `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${file.archive_sha256}`;
      const cached = archives.get(resolved);
      if (cached?.signature === signature) return cached.zip;
      const buffer = await readFile(resolved);
      if (sha(buffer) !== file.archive_sha256) continue;
      const zip = new AdmZip(buffer);
      if (zip.getEntries().length > 10000) continue;
      // Bound memory on a Pi; a cache entry is always tied to this archive digest.
      while (archives.size && [...archives.values()].reduce((n,v) => n+v.bytes, 0) + buffer.length > 64 * 1024 * 1024) {
        archives.delete(archives.keys().next().value!);
      }
      if (buffer.length <= 64 * 1024 * 1024) archives.set(resolved, { signature, zip, bytes: buffer.length });
      return zip;
    } catch (error: any) {
      if (!['ENOENT','ENOTDIR'].includes(error?.code)) console.warn('[Reviewed archive unreadable]', file.pack_id);
    }
  }
  return null;
}

/** Read exactly the registered member and verify its bytes, even if its suffix was truncated. */
export async function readReviewedFile(file: ReviewedFile) {
  if (!safeRelative(file.member_path) || !/^[a-f\d]{64}$/i.test(file.sha256)) return null;
  if (fileDataset(file) === LOOSE_REVIEWED_DATASET) {
    if (file.source !== 'anissia') return null;
    const buffer = await readReviewedLooseBytes(file.member_path, file.sha256);
    if (!buffer) return null;
    const decoded = decodeSubtitleFile(buffer, file.member_path);
    if (!decoded?.content) return null;
    return { ...decoded, orig_filename: path.posix.basename(file.member_path),
      name: `[로컬 Anissia · ${file.work_title_ko}] ${path.posix.basename(file.member_path)}`,
      sourceProvider: file.source, sourceMatchedTitle: file.work_title_ko,
      sourceBundleKey: reviewedBundleKey(file),
      sourceBundleLabel: scopeLabel(file.work_title_ko,subtitleScope(file.member_path,file.work_title_ko,parseSeason(file.work_title_ko) || 1)),
      reviewedFileId: `${fileDataset(file)}:${file.pid}`, localArchive: true, verifiedMatch: true,
      reanimeLinked: Boolean(file.reanime_id) };
  }
  const zip = await verifiedArchive(file);
  if (!zip) return null;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || entry.header.size > 10 * 1024 * 1024) continue;
    const utf8 = entry.entryName;
    const cp949 = iconv.decode(entry.rawEntryName, "cp949");
    if (utf8 !== file.member_path && cp949 !== file.member_path) continue;
    try {
      const buffer = entry.getData();
      if (buffer.length > 10 * 1024 * 1024 || sha(buffer) !== file.sha256) continue;
      const decoded = decodeSubtitleFile(buffer, file.member_path);
      if (!decoded?.content) continue;
      return { ...decoded, orig_filename: path.posix.basename(file.member_path),
        name: `[로컬 ${file.source === 'aniall' ? 'AniAll' : 'Naver'} · ${file.work_title_ko}] ${path.posix.basename(file.member_path)}`,
        sourceProvider: file.source, sourceMatchedTitle: file.work_title_ko,
        sourceBundleKey: reviewedBundleKey(file),
        sourceBundleLabel: scopeLabel(file.work_title_ko,subtitleScope(file.member_path,file.work_title_ko,parseSeason(file.work_title_ko) || 1)),
        reviewedFileId: `${DATASET}:${file.pid}`, localArchive: true, verifiedMatch: true,
        reanimeLinked: Boolean(file.reanime_id) };
    } catch { /* A bad ZIP member must not select a different file. */ }
  }
  return null;
}

/** Confirmed episode rows win. Otherwise use the existing conservative filename algorithm. */
export function reviewedEpisodeCandidates(files: ReviewedFile[], episode: number, sourceEpisode: number, season: number | null,
  allowLooseFilenameMatching = false) {
  // Work review alone leaves filename numbers as manual suggestions. An
  // explicitly selected set uses the same episode algorithm as existing sets;
  // this playback decision never writes reviewed episode confirmations.
  const loose = allowLooseFilenameMatching ? [] : files.filter(f => fileDataset(f) === LOOSE_REVIEWED_DATASET);
  files = allowLooseFilenameMatching ? files : files.filter(f => fileDataset(f) !== LOOSE_REVIEWED_DATASET);
  const confirmed = files.filter(f => f.confirmed_episodes.length === 1 && Number(f.confirmed_episodes[0]) === episode);
  const unassigned = files.filter(f => f.confirmed_episodes.length === 0);
  const filenameRows = unassigned.map(f => ({ ...f, filename: f.member_path }));
  // A file's exact DB work binding already scopes a mixed archive to this work.
  const declaredSeasons = [...new Set(unassigned.map(f => readEpisodeEvidence(f.member_path, true).season).filter(Boolean))];
  const scopeSeason = season || (declaredSeasons.length === 1 ? declaredSeasons[0]! : 1);
  const selected = selectEpisodeEntries(filenameRows, { episode, sourceEpisode, season: scopeSeason },
    [readEpisodeEvidence(`S${scopeSeason}`)]);
  const unknown = unassigned.filter(f => {
    const e = readEpisodeEvidence(f.member_path, true);
    return !e.episodes.length || e.range || e.conflict || e.multipleSeasons;
  });
  const conflicting = files.filter(f => f.confirmed_episodes.length > 1);
  const competing = selected.length ? [] : unassigned.filter(f => {
    const e = readEpisodeEvidence(f.member_path, true);
    return e.episodes.length === 1 && evidenceAgrees(e, { episode, sourceEpisode, season: scopeSeason });
  });
  const looseCandidates = loose.filter(f => {
    const e = readEpisodeEvidence(f.member_path, true);
    return !e.episodes.length || e.range || e.conflict || e.multipleSeasons
      || evidenceAgrees(e, { episode, sourceEpisode, season: season || e.season || 1 });
  });
  return { exact: [...confirmed, ...selected], manual: [...new Map([...unknown, ...conflicting, ...competing, ...looseCandidates]
    .map(f => [`${fileDataset(f)}:${f.pid}`, f])).values()] };
}

/** Broad searches must not spend the entire read budget on one large bundle. */
function interleaveReviewedBundles(rows: ReviewedFile[]): ReviewedFile[] {
  const groups = new Map<string, ReviewedFile[]>();
  for (const file of rows) {
    const key = reviewedBundleKey(file);
    const group = groups.get(key) || [];
    group.push(file);
    groups.set(key, group);
  }
  const ordered: ReviewedFile[] = [];
  for (let index = 0; ordered.length < Math.min(rows.length, 100); index++) {
    for (const group of groups.values()) {
      if (group[index]) ordered.push(group[index]);
      if (ordered.length >= 100) return ordered;
    }
  }
  return ordered;
}

export async function getReviewedSubtitles(input: { animeId: string; episode: number; sourceEpisode: number;
  season: number | null; source?: Provider; keyword?: string; manualSearch?: boolean; bundleKey?: string;
  isRejected?: (provider: string, key: string) => boolean }) {
  const sourceFiles = input.source && input.bundleKey
    ? await findReviewedBundleFiles(input.source, input.bundleKey)
    : await findReviewedFiles(input.animeId, input.keyword || "");
  const files = sourceFiles
    .filter(f => (!input.source || f.source === input.source)
      && !input.isRejected?.(f.source, `reviewed:${fileDataset(f)}:${f.pid}`));
  const scope = input.bundleKey ? parseBundleScope(input.bundleKey) : null;
  const looseKinds = new Set(files.filter(f => fileDataset(f) === LOOSE_REVIEWED_DATASET)
    .map(f => subtitleScope(f.member_path,f.work_title_ko).kind));
  const expectedKind = scope?.kind || (files.length && files.every(f => fileDataset(f) === LOOSE_REVIEWED_DATASET)
    && looseKinds.size === 1 ? [...looseKinds][0] : subtitleScope('',files[0]?.work_title_ko || '').kind);
  const eligible = input.manualSearch ? files : files.filter(f => subtitleScope(f.member_path,f.work_title_ko).kind === expectedKind);
  const selectedLooseSet = !input.manualSearch && input.source === 'anissia'
    && scope?.type === 'reviewed' && scope.dataset === LOOSE_REVIEWED_DATASET;
  const { exact, manual } = reviewedEpisodeCandidates(eligible, input.episode, input.sourceEpisode,
    scope?.season || input.season, selectedLooseSet);
  const results: Array<NonNullable<Awaited<ReturnType<typeof readReviewedFile>>> & { episode: number; episodeConfirmed: boolean }> = [];
  const seen = new Set<string>();
  const load = async (rows: ReviewedFile[], confirmed: boolean) => {
    for (const file of interleaveReviewedBundles(rows)) {
      if (seen.has(file.sha256)) continue;
      const result = await readReviewedFile(file);
      if (!result) continue;
      seen.add(file.sha256);
      results.push({ ...result, episode: input.episode, episodeConfirmed: confirmed });
      if (results.length >= 50) break;
    }
  };
  await load(exact, true);
  const hasExact = results.length > 0;
  if (results.length < 50 && (input.manualSearch || !hasExact)) {
    // Manual browsing can choose a different season/format/episode for an
    // explicit exception. It never grants that file automatic episode status.
    await load(input.manualSearch ? files.filter(f=>!exact.includes(f)) : manual, false);
  }
  return { subtitles: results, needsManualChoice: results.length > 1 || (!hasExact && results.length > 0) };
}

/** A native-player request may only read a file in this work's exact reviewed binding. */
export async function getReviewedSubtitleById(animeId: string, reviewedFileId: string,
  isRejected?: (provider: string, key: string) => boolean, allowedBundleKey = "") {
  const identity = reviewedIdentity(reviewedFileId);
  if (!identity) return null;
  let file = (await findReviewedFiles(animeId)).find(f => fileDataset(f) === identity.dataset && f.pid === identity.pid);
  if (!file && parseBundleScope(allowedBundleKey)?.type === 'reviewed') {
    for (const source of ["aniall", "naver", "anissia"] as const) {
      file = (await findReviewedBundleFiles(source, allowedBundleKey))
        .find(f => fileDataset(f) === identity.dataset && f.pid === identity.pid);
      if (file) break;
    }
  }
  if (!file || isRejected?.(file.source, `reviewed:${reviewedFileId}`)) return null;
  return readReviewedFile(file);
}

