import AdmZip from "adm-zip";
import iconv from "iconv-lite";
import { readEpisodeEvidence, selectEpisodeEntries } from "@/lib/subtitleEpisodes";

export interface SubtitleArchiveEntry {
  index: number;
  filename: string;
  episode: number | null;
  season: number | null;
}

const EXTENSION = /\.(ass|ssa|smi|srt|vtt)$/i;

export function seasonFromSubtitleFilename(filename: string): number | null {
  const evidence = readEpisodeEvidence(filename, true);
  return evidence.multipleSeasons ? null : evidence.season;
}

export function episodeFromSubtitleFilename(filename: string): number | null {
  const evidence = readEpisodeEvidence(filename, true);
  return !evidence.conflict && !evidence.range && evidence.episodes.length === 1 ? evidence.episodes[0] : null;
}

/** Automatic upload uses the same identities as online/local selection. No alphabetical guessing. */
export function automaticArchiveAssignments(entries: SubtitleArchiveEntry[], filename: string,
  season: number | null, startEpisode: number | null) {
  const outer = [readEpisodeEvidence(filename, true)];
  const assignments: Array<{ index: number; episode: number }> = [];
  for (const entry of entries) {
    if (entry.episode === null) continue;
    const episode = readEpisodeEvidence(entry.filename, true).seasonEpisodePair
      ? entry.episode : entry.episode - ((startEpisode || 1) - 1);
    if (episode < 1) continue;
    const request = { episode, sourceEpisode: (startEpisode || 1) + episode - 1, season: season ?? 1 };
    if (selectEpisodeEntries(entries, request, outer).some(item => item.index === entry.index)) {
      assignments.push({ index: entry.index, episode });
    }
  }
  return assignments;
}

export function inspectSubtitleArchive(buffer: Buffer): {
  zip: AdmZip;
  entries: SubtitleArchiveEntry[];
} {
  const zip = new AdmZip(buffer);
  const all = zip.getEntries();
  if (all.length > 1000) throw new Error("압축 파일에 항목이 너무 많습니다.");
  let totalSize = 0;
  const entries: SubtitleArchiveEntry[] = [];
  for (const [index, entry] of all.entries()) {
    if (entry.isDirectory || !EXTENSION.test(entry.entryName) || /(?:^|\/)__MACOSX\//i.test(entry.entryName)) continue;
    if (entry.header.size > 2 * 1024 * 1024) throw new Error("2MB가 넘는 자막 파일은 올릴 수 없습니다.");
    totalSize += entry.header.size;
    if (totalSize > 20 * 1024 * 1024 || entries.length >= 200) throw new Error("자막 묶음이 너무 큽니다.");
    let filename = entry.entryName;
    if (!(entry.header.flags & 0x800) && !/[가-힣]/.test(filename)) {
      const decoded = iconv.decode(entry.rawEntryName, "cp949");
      if (/[가-힣]/.test(decoded)) filename = decoded;
    }
    entries.push({ index, filename, episode: episodeFromSubtitleFilename(filename), season: seasonFromSubtitleFilename(filename) });
  }
  if (!entries.length) throw new Error("압축 파일에 자막이 없습니다.");
  return { zip, entries };
}
