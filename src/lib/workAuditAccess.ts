import path from "node:path";
import { lstat, realpath, stat } from "node:fs/promises";

export const AUDIT_SNAPSHOT_FILES = [
  "catalog_snapshot.sqlite",
  "subtitle_files.jsonl.gz",
  "subtitle_zip_members.csv.gz",
  "manifest.json",
] as const;

export const MAX_AUDIT_DOWNLOAD_BYTES = 128 * 1024 * 1024;
const ALLOWED_FOLDERS = new Set(["anissia_subtitles", "aniall_subtitles", "naver_subtitles"]);
const ALLOWED_EXTENSIONS = new Set([".zip", ".7z", ".rar", ".egg", ".alz", ".ass", ".ssa", ".srt", ".smi", ".vtt"]);

export function parseAuditFilePath(value: string): string[] | null {
  if (!value || value.length > 2048 || /[\0\\\r\n]/.test(value)) return null;
  const parts = value.split("/");
  if (parts.length < 2 || !ALLOWED_FOLDERS.has(parts[0]) ||
      parts.some(part => !part || part === "." || part === ".." || part.startsWith(".") || part.length > 255)) return null;
  if (!ALLOWED_EXTENSIONS.has(path.posix.extname(parts.at(-1)!).toLowerCase())) return null;
  return parts;
}

export async function resolveAuditSubtitleFile(value: string): Promise<{ path: string; name: string; size: number } | null> {
  const parts = parseAuditFilePath(value);
  if (!parts) return null;
  const root = process.env.SUBTITLE_STORAGE_DIR || path.join(process.cwd(), "data", "subtitles");
  const rootReal = await realpath(root);
  const providerReal = await realpath(path.join(root, parts[0]));
  if (!providerReal.startsWith(rootReal + path.sep)) return null;
  const candidate = path.join(root, ...parts);
  const rawInfo = await lstat(candidate);
  if (!rawInfo.isFile() || rawInfo.isSymbolicLink()) return null;
  const real = await realpath(candidate);
  if (!real.startsWith(providerReal + path.sep)) return null;
  const info = await stat(real);
  if (info.size < 1 || info.size > MAX_AUDIT_DOWNLOAD_BYTES) return null;
  return { path: real, name: parts.at(-1)!, size: info.size };
}

export async function resolveAuditSnapshotFile(filename: string): Promise<{ path: string; name: string; size: number } | null> {
  if (!(AUDIT_SNAPSHOT_FILES as readonly string[]).includes(filename)) return null;
  const root = process.env.WORK_AUDIT_DIR || path.join(process.cwd(), "data", "work-audit");
  const file = path.join(root, filename);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_AUDIT_DOWNLOAD_BYTES) return null;
  const realRoot = await realpath(root);
  const real = await realpath(file);
  if (path.dirname(real) !== realRoot) return null;
  return { path: real, name: filename, size: info.size };
}
