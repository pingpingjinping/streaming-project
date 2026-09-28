import AdmZip from "adm-zip";
import iconv from "iconv-lite";

export interface SubtitleArchiveEntry {
  index: number;
  filename: string;
  episode: number | null;
  season: number | null;
}

const EXTENSION = /\.(ass|ssa|smi|srt|vtt)$/i;

export function seasonFromSubtitleFilename(filename: string): number | null {
  const base = filename.split(/[\\/]/).pop()?.replace(EXTENSION, "") || "";
  const match = base.match(/(?:^|[^a-z\d])s\s*0*(\d{1,2})\s*e\s*0*\d{1,3}(?!\d)/i);
  return match ? Number(match[1]) : null;
}

export function episodeFromSubtitleFilename(filename: string): number | null {
  const base = filename.split(/[\\/]/).pop()?.replace(EXTENSION, "") || "";
  // A range such as "01-12화" describes a bundle, not episode 12.
  if (/(?:^|[^\d])\d{1,3}\s*[-~]\s*\d{1,3}\s*(?:화|회|편|話)?(?:$|[^\d])/u.test(base)) return null;
  const matches = [
    ...base.matchAll(/(?:^|[^a-z\d])(?:episode|ep|e|#)\s*0*(\d{1,3})(?!\d)/gi),
    ...base.matchAll(/(?:^|[^a-z\d])(?:s\d{1,2}\s*e)\s*0*(\d{1,3})(?!\d)/gi),
    ...base.matchAll(/(?:제|第\s*)?0*(\d{1,3})\s*(?:화|회|편|話)(?![가-힣])/g),
    ...base.matchAll(/\[\s*0*(\d{1,3})\s*\]/g),
  ].map((match) => Number(match[1]));
  const looksLikeRange = /(?:^|[^\d])\d{1,3}\s*[-~]\s*\d{1,3}(?:$|[^\d])/.test(base);
  if (!looksLikeRange && (/^0*\d{1,3}$/.test(base) || /(?:^|[\s_-])0*\d{1,3}$/.test(base))) {
    const end = base.match(/0*(\d{1,3})$/);
    if (end) matches.push(Number(end[1]));
  }
  const unique = [...new Set(matches.filter((ep) => ep > 0 && ep <= 200))];
  return unique.length === 1 ? unique[0] : null;
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
    if (!/[가-힣]/.test(filename)) {
      const decoded = iconv.decode(entry.rawEntryName, "cp949");
      if (/[가-힣]/.test(decoded)) filename = decoded;
    }
    entries.push({ index, filename, episode: episodeFromSubtitleFilename(filename), season: seasonFromSubtitleFilename(filename) });
  }
  if (!entries.length) throw new Error("압축 파일에 자막이 없습니다.");
  return { zip, entries };
}
