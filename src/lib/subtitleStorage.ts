import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { deleteUploadedSubtitle as deleteLegacyUploadedSubtitle, getUploadedSubtitle as getLegacyUploadedSubtitle } from "@/lib/db";
import { extractSubtitleFromBuffer } from "@/lib/subtitles";
import { episodeFromSubtitleFilename, inspectSubtitleArchive } from "@/lib/subtitleUpload";

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
  await Promise.all(["json", "ass", "vtt"].map((ext) => rm(path.join(dir, `${base}.${ext}`), { force: true })));
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
      let selected = entries.filter((entry) => entry.episode === episode && entry.season === targetSeason);
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
