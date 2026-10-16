/** Online Anissia Google Drive folder listing.
 * Lists filenames only; the caller downloads at most one episode-matched file.
 * This does not touch the Pi's weekly subtitle storage.
 */
import * as cheerio from "cheerio";
import { readEpisodeEvidence, selectEpisodeEntries, type EpisodeRequest } from "./subtitleEpisodes";

export interface DriveFolderFile {
  id: string;
  filename: string;
}

const FOLDER_HOST = "drive.google.com";
const FILE_TYPES = /\.(?:smi|srt|ass|ssa|vtt|zip)$/i;
const MAX_ENTRIES_PER_FOLDER = 49; // embeddedfolderview may truncate at 50
const MAX_FOLDER_DEPTH = 2;
const CACHE_MS = 3 * 60 * 1000;
const MAX_CACHE_FOLDERS = 48;
const folderCache = new Map<string, { until: number; value: Promise<DriveFolderFile[]> }>();

export function driveFolderId(value: string): string | null {
  try {
    const url = new URL(value.replace(/&amp;/g, "&"));
    if (url.hostname.toLowerCase() !== FOLDER_HOST || url.username || url.password || url.port) return null;
    return url.pathname.match(/^\/drive\/folders\/([a-zA-Z0-9_-]{10,})\/?$/)?.[1] || null;
  } catch { return null; }
}

function driveFileId(value: string): string | null {
  try {
    const url = new URL(value.replace(/&amp;/g, "&"));
    if (!["drive.google.com", "docs.google.com"].includes(url.hostname.toLowerCase())) return null;
    if (url.username || url.password || url.port) return null;
    const pathId = url.pathname.match(/^\/file\/d\/([a-zA-Z0-9_-]{10,})(?:\/|$)/)?.[1];
    const queryId = /^\/(?:open|uc)$/.test(url.pathname)
      ? url.searchParams.get("id")?.match(/^[a-zA-Z0-9_-]{10,}$/)?.[0] : null;
    return pathId || queryId || null;
  } catch { return null; }
}

function parseFolderPage(html: string): {
  files: DriveFolderFile[];
  folders: string[];
  count: number;
} {
  const $ = cheerio.load(html);
  const files = new Map<string, DriveFolderFile>();
  const folders = new Set<string>();
  const links = new Set<string>();
  $("a[href]").each((_, node) => {
    const raw = $(node).attr("href") || "";
    let url: string;
    try { url = new URL(raw, "https://drive.google.com").toString(); } catch { return; }
    const fileId = driveFileId(url);
    const folderId = driveFolderId(url);
    if (!fileId && !folderId) return;
    links.add(fileId ? "f:" + fileId : "d:" + folderId);
    if (folderId) { folders.add(folderId); return; }
    const filename = $(node).text().replace(/\s+/g, " ").trim();
    if (filename && FILE_TYPES.test(filename)) files.set(fileId!, { id: fileId!, filename });
  });
  return { files: [...files.values()], folders: [...folders], count: links.size };
}

export async function listOnlineDriveFolder(
  folderUrl: string,
  requestPage: (url: string) => Promise<string> = async url => {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.7" },
      signal: AbortSignal.timeout(6500),
    });
    if (!response.ok) throw new Error("Google Drive folder listing HTTP " + response.status);
    return response.text();
  },
  useCache = true,
): Promise<DriveFolderFile[]> {
  const rootId = driveFolderId(folderUrl);
  if (!rootId) return [];
  const now = Date.now();
  const current = useCache ? folderCache.get(rootId) : null;
  if (current && current.until > now) return current.value;

  const load = async () => {
    const scanned = new Set<string>();
    const collected = new Map<string, DriveFolderFile>();
    async function scan(folderId: string, depth: number) {
      if (scanned.has(folderId)) return;
      if (depth > MAX_FOLDER_DEPTH) throw new Error("Google Drive folder nesting too deep");
      scanned.add(folderId);
      const html = await requestPage("https://drive.google.com/embeddedfolderview?id=" + encodeURIComponent(folderId));
      const page = parseFolderPage(html);
      if (page.count === 0) throw new Error("Google Drive folder is private, empty, or inaccessible");
      if (page.count > MAX_ENTRIES_PER_FOLDER) {
        throw new Error("Google Drive folder listing may be incomplete (50+ entries)");
      }
      for (const file of page.files) {
        collected.set(file.id, file);
        if (collected.size > 250) throw new Error("Google Drive folder has too many subtitles");
      }
      for (const child of page.folders) await scan(child, depth + 1);
    }
    await scan(rootId, 0);
    return [...collected.values()];
  };
  const promise = load();
  if (useCache) {
    if (folderCache.size >= MAX_CACHE_FOLDERS) folderCache.delete(folderCache.keys().next().value!);
    folderCache.set(rootId, { until: now + CACHE_MS, value: promise });
    promise.catch(() => {
      if (folderCache.get(rootId)?.value === promise) folderCache.delete(rootId);
    });
  }
  return promise;
}

/** Only accept explicit per-episode filename evidence.
 * Avoid assigning an OVA/special to a normal TV episode or choosing
 * an unnumbered subtitle by directory order.
 */
export function selectOnlineDriveFolderFile(
  entries: DriveFolderFile[],
  localEpisode: number,
  sourceEpisode: number,
  season: number | null,
): DriveFolderFile | null {
  if (!Number.isSafeInteger(localEpisode) || localEpisode < 1 ||
      !Number.isSafeInteger(sourceEpisode) || sourceEpisode < 1) return null;
  const ordinary = entries.filter(file =>
    FILE_TYPES.test(file.filename) &&
    !/(?:^|[\s._[(\-])(?:ova|oad|special|sp|특전|특별편)(?=$|[\s._)\]\-])/i.test(file.filename));
  const request: EpisodeRequest = { episode: localEpisode, sourceEpisode, season: season ?? 1 };
  const matching = selectEpisodeEntries(ordinary.map(f => ({ ...f, filename: f.filename })), request);
  if (!matching.length) return null;
  const priority = (file: DriveFolderFile) => {
    const ext = file.filename.split(".").pop()?.toLowerCase() || "";
    return ({ ass: 0, ssa: 1, smi: 2, srt: 3, vtt: 4, zip: 5 } as Record<string, number>)[ext] ?? 10;
  };
  matching.sort((a, b) => priority(a) - priority(b));
  // Same-rank variants are ambiguous. Do not silently select one by list order.
  if (matching.length > 1 && priority(matching[0]) === priority(matching[1])) return null;
  const evidence = readEpisodeEvidence(matching[0].filename, true);
  return evidence.episodes.length === 1 && !evidence.range && !evidence.conflict
    ? matching[0] : null;
}

export function driveFileViewUrl(id: string): string {
  if (!/^[a-zA-Z0-9_-]{10,}$/.test(id)) throw new Error("Invalid Google Drive file ID");
  return "https://drive.google.com/file/d/" + encodeURIComponent(id) + "/view";
}
