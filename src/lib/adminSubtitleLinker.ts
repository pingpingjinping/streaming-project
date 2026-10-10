import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getDb, initDb } from "@/lib/db";
import { getLocalSubtitleNameEntries, refreshLocalSubtitleNameIndex } from "@/lib/localSubtitleNameIndex";
import { inspectSubtitleArchive } from "@/lib/subtitleUpload";
import { decodeSubtitleFile } from "@/lib/subtitles";
import { readEpisodeEvidence, selectEpisodeEntries } from "@/lib/subtitleEpisodes";
import { subtitleScope } from "@/lib/subtitleLocalIdentity";

const PROVIDERS = ["anissia", "aniall", "naver"] as const;
const EXT = /\.(?:ass|ssa|smi|srt|vtt)$/i;
const KINDS = ["main", "ova", "special", "movie", "preview", "drama", "unknown"] as const;
type Kind = (typeof KINDS)[number];
type EntryType = "zip" | "folder";
export type LinkedSubtitle = {
  relativePath: string; type: EntryType; animeId: string; title: string;
  kind: Kind; season: number; updatedAt: string;
};
const storageRoot = () => path.resolve(process.env.SUBTITLE_STORAGE_DIR || path.join(process.cwd(), "data", "subtitles"));

export function parseWorkId(value: unknown): { source: string; id: string } | null {
  if (typeof value !== "string" || value.length > 150) return null;
  const match = /^(ani_([1-9]\d*)|re_([a-zA-Z0-9_-]+)|db_(AniList|Onnada)_([a-zA-Z0-9_-]+))$/.exec(value);
  return match ? match[2] ? { source: "Anissia", id: match[2] }
    : match[3] ? { source: "ReAnime", id: match[3] }
      : { source: match[4], id: match[5] } : null;
}

export function safeSubtitlePath(value: unknown, type: unknown): value is string {
  if (typeof value !== "string" || value.length > 1800 ||
    !["zip", "folder"].includes(String(type)) || value.includes("\0") ||
    value.includes("\\") || value.startsWith("/")) return false;
  const parts = value.split("/");
  if (parts.length < 2 || parts.some(v => !v || v === "." || v === ".." || v.startsWith("."))) return false;
  if (!PROVIDERS.some(p => parts[0] === p + "_subtitles")) return false;
  return type === "folder" ? parts.length === 2 : parts.length >= 2 && /\.zip$/i.test(parts[parts.length - 1]);
}

/** Both browsing and saving must prove a real file in one allowed Pi source root. */
export async function verifiedLocalEntry(relativePath: string, type: EntryType) {
  if (!safeSubtitlePath(relativePath, type)) return null;
  try {
    const root = await realpath(storageRoot());
    const providerDir = path.join(root, relativePath.split("/")[0]);
    const base = await realpath(providerDir);
    const full = path.join(root, ...relativePath.split("/"));
    const actual = await realpath(full);
    const info = await lstat(full);
    if (!base.startsWith(root + path.sep) || !actual.startsWith(base + path.sep) ||
      actual !== full || (type === "folder" ? !info.isDirectory() : !info.isFile()) ||
      (type === "zip" && (info.size > 32 * 1024 * 1024 || info.size < 1))) return null;
    return { full, info };
  } catch { return null; }
}

let subtitleLinkSchemaReady: Promise<void> | null = null;
export async function ensureSubtitleLinksTable() {
  const sql = getDb();
  if (!sql) throw new Error("PostgreSQL 연결이 필요합니다.");
  if (!subtitleLinkSchemaReady) {
    subtitleLinkSchemaReady = (async () => {
      await initDb();
      await sql`CREATE TABLE IF NOT EXISTS anime_admin_subtitle_links (
        relative_path TEXT PRIMARY KEY,
        entry_type VARCHAR(8) NOT NULL CHECK (entry_type IN ('folder','zip')),
        anime_id VARCHAR(150) NOT NULL,
        work_title TEXT NOT NULL,
        subtitle_kind VARCHAR(16) NOT NULL,
        season SMALLINT NOT NULL CHECK (season BETWEEN 1 AND 99),
        updated_by VARCHAR(100) NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`;
      await sql`CREATE INDEX IF NOT EXISTS idx_anime_admin_subtitle_links_work ON anime_admin_subtitle_links(anime_id)`;
    })().catch(error => {
      subtitleLinkSchemaReady = null;
      throw error;
    });
  }
  await subtitleLinkSchemaReady;
  return sql;
}

export async function findCatalogWorks(q: string) {
  const query = q.normalize("NFKC").trim().slice(0, 120);
  if (query.length < 2) return [];
  const sql = getDb();
  if (!sql) return [];
  const escaped = query.replace(/[\\%_]/g, "\\$&");
  const pattern = "%" + escaped + "%";
  const rows = await sql`SELECT source, source_record_id, payload
    FROM anime_catalog_entries
    WHERE source IN ('Anissia','ReAnime','AniList','Onnada')
      AND (source_record_id = ${query} OR
        CONCAT_WS(' ',payload->>'title_ko',payload->>'title_native',payload->>'title_romaji',payload->>'title_english') ILIKE ${pattern})
    ORDER BY CASE source WHEN 'Anissia' THEN 0 WHEN 'ReAnime' THEN 1 ELSE 2 END,
      payload->>'year' DESC NULLS LAST
    LIMIT 40`;
  return rows.map(row => {
    const source = String(row.source), id = String(row.source_record_id);
    const animeId = source === "Anissia" ? "ani_" + id : source === "ReAnime" ? "re_" + id : "db_" + source + "_" + id;
    return { animeId, source, title: String(row.payload?.title_ko || row.payload?.title_english ||
      row.payload?.title_native || row.payload?.title_romaji || id), year: row.payload?.year || "" };
  });
}

export async function browseLocalEntries(q = "") {
  const needle = q.normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/[^\\p{L}\\p{N}]+/gu, "");
  const entries = await getLocalSubtitleNameEntries(storageRoot());
  const indexed = entries.map(e => ({
    relativePath: e.relativePath, type: e.choice.entryType, name: e.choice.folderName,
    source: e.choice.provider,
  }));
  // The playback index intentionally skips Naver work directories, but the
  // administrator must also be able to link an already-present Naver folder.
  const naverFolders: typeof indexed = [];
  try {
    for (const entry of await readdir(path.join(storageRoot(), "naver_subtitles"), { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        naverFolders.push({ relativePath: "naver_subtitles/" + entry.name,
          type: "folder", name: entry.name, source: "naver" });
      }
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  return [...indexed, ...naverFolders]
    .filter(e => !needle || e.name.normalize("NFKC").toLocaleLowerCase("ko-KR")
      .replace(/[^\\p{L}\\p{N}]+/gu, "").includes(needle))
    .sort((a,b) => a.relativePath.localeCompare(b.relativePath, "ko"))
    .slice(0, 200);
}

export async function getAdminSubtitleLinks(animeId?: string) {
  const sql = await ensureSubtitleLinksTable();
  const rows = animeId ? await sql`SELECT * FROM anime_admin_subtitle_links WHERE anime_id=${animeId} ORDER BY updated_at DESC LIMIT 200`
    : await sql`SELECT * FROM anime_admin_subtitle_links ORDER BY updated_at DESC LIMIT 300`;
  return rows.map(r => ({
    relativePath: String(r.relative_path), type: String(r.entry_type) as EntryType,
    animeId: String(r.anime_id), title: String(r.work_title), kind: String(r.subtitle_kind) as Kind,
    season: Number(r.season), updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

export async function saveAdminSubtitleLink(values: {
  relativePath: string; type: EntryType; animeId: string; kind: Kind; season: number; admin: string;
}) {
  if (!safeSubtitlePath(values.relativePath, values.type) || !parseWorkId(values.animeId) ||
    !KINDS.includes(values.kind) || !Number.isInteger(values.season) || values.season < 1 || values.season > 99)
    throw new Error("파일·작품·시즌 정보를 확인해 주세요.");
  if (!(await verifiedLocalEntry(values.relativePath, values.type)))
    throw new Error("Pi에 해당 폴더/ZIP이 없거나 접근할 수 없습니다.");
  const id = parseWorkId(values.animeId)!;
  const sql = await ensureSubtitleLinksTable();
  const rows = await sql`SELECT payload FROM anime_catalog_entries WHERE source=${id.source} AND source_record_id=${id.id} LIMIT 1`;
  if (!rows.length) throw new Error("작품 DB에 존재하지 않는 ID입니다.");
  const payload = rows[0].payload;
  const title = String(payload?.title_ko || payload?.title_english || payload?.title_native ||
    payload?.title_romaji || id.id).slice(0, 300);
  await sql`INSERT INTO anime_admin_subtitle_links (
    relative_path, entry_type, anime_id, work_title, subtitle_kind, season, updated_by
  ) VALUES (${values.relativePath},${values.type},${values.animeId},${title},${values.kind},${values.season},${values.admin})
  ON CONFLICT(relative_path) DO UPDATE SET
    entry_type=EXCLUDED.entry_type, anime_id=EXCLUDED.anime_id, work_title=EXCLUDED.work_title,
    subtitle_kind=EXCLUDED.subtitle_kind, season=EXCLUDED.season, updated_by=EXCLUDED.updated_by,
    updated_at=CURRENT_TIMESTAMP`;
  return { relativePath: values.relativePath, animeId: values.animeId, title };
}

export async function deleteAdminSubtitleLink(relativePath: string) {
  const sql = await ensureSubtitleLinksTable();
  await sql`DELETE FROM anime_admin_subtitle_links WHERE relative_path=${relativePath}`;
}

const cleanName = (raw: string) => raw.normalize("NFKC").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
  .replace(/\s+/g, " ").replace(/^\.+|\.+$/g, "").slice(0, 110).trim() || "자막";
export function safeUploadSegments(value: unknown): string[] | null {
  if (typeof value !== "string" || value.length > 700 || value.startsWith("/") || value.includes("\\") || value.includes("\0"))
    return null;
  const parts = value.split("/");
  if (parts.length < 1 || parts.length > 8 || parts.some(p => !p || p === "." || p === ".." || p.startsWith(".") || p.length > 180))
    return null;
  return parts.map(cleanName);
}

/** Uploaded files are sandboxed under a unique Anissia-local work folder. */
export async function uploadAdminSubtitles(files: Array<{ name: string; bytes: Buffer }>, label: string) {
  if (!files.length || files.length > 120) throw new Error("파일은 한 번에 120개까지 가능합니다.");
  if (files.some(f => !safeUploadSegments(f.name) || f.bytes.length < 1 || f.bytes.length > (f.name.toLowerCase().endsWith('.zip') ? 32 : 16) * 1024 * 1024) ||
    files.reduce((n, f) => n + f.bytes.length, 0) > 48 * 1024 * 1024)
    throw new Error("파일 경로 또는 업로드 용량이 허용 범위를 넘었습니다.");
  if (files.some(f => !/\.(?:zip|ass|ssa|smi|srt|vtt)$/i.test(f.name))) throw new Error("자막 및 ZIP만 업로드할 수 있어요.");
  for (const file of files.filter(f => /\.zip$/i.test(f.name))) {
    if (!file.bytes.subarray(0, 2).equals(Buffer.from("PK"))) throw new Error("ZIP 파일 형식을 확인해 주세요.");
    inspectSubtitleArchive(file.bytes);
  }
  const folder = cleanName(label) + " (수동-" + randomUUID().slice(0, 8) + ")";
  const root = storageRoot();
  const providerRoot = path.join(root, "anissia_subtitles");
  await mkdir(providerRoot, { recursive: true });
  const actualProviderRoot = await realpath(providerRoot);
  if (!actualProviderRoot.startsWith((await realpath(root)) + path.sep))
    throw new Error("자막 저장소 경로를 확인해 주세요.");
  const dest = path.join(actualProviderRoot, folder);
  await mkdir(dest, { recursive: false });
  for (const file of files) {
    const segments = safeUploadSegments(file.name)!;
    const relative = path.join(dest, ...segments);
    await mkdir(path.dirname(relative), { recursive: true });
    await writeFile(relative, file.bytes, { flag: "wx" });
  }
  await refreshLocalSubtitleNameIndex(root);
  return { relativePath: "anissia_subtitles/" + folder, type: "folder" as const, count: files.length };
}

async function collectSubtitleFiles(rootDir: string) {
  const files: string[] = [];
  async function scan(dir: string, depth: number) {
    if (depth > 6 || files.length > 400) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await scan(full, depth + 1);
      else if (entry.isFile() && (/\.(?:zip|ass|ssa|smi|srt|vtt)$/i.test(entry.name))) files.push(full);
      if (files.length > 400) return;
    }
  }
  await scan(rootDir, 0);
  return files.length > 400 ? [] : files.sort((a, b) => a.localeCompare(b, "ko", { numeric: true }));
}

export async function getAdminLinkedSubtitles(animeId: string, episode: number, sourceEpisode: number) {
  if (!parseWorkId(animeId)) return [];
  const links = await getAdminSubtitleLinks(animeId);
  const results: Array<{name: string; orig_filename: string; content: string; format: "ASS" | "VTT";
    is_ass: boolean; sourceProvider: "anissia" | "aniall" | "naver"; sourceMatchedTitle: string;
    localArchive: boolean; episodeConfirmed: boolean; verifiedMatch: boolean; adminLinked: boolean}> = [];
  for (const link of links.slice(0, 12)) {
    const verified = await verifiedLocalEntry(link.relativePath, link.type);
    if (!verified) continue;
    const request = { episode, sourceEpisode, season: link.season };
    const provider = link.relativePath.split("/")[0].replace("_subtitles","") as "anissia" | "aniall" | "naver";
    // The administrator explicitly selected this work's season.
    const seasonEvidence = readEpisodeEvidence(link.season + "기");
    const files = link.type === "folder" ? await collectSubtitleFiles(verified.full) : [verified.full];
    for (const file of files.slice(0, 60)) {
      try {
        const relativeName = path.relative(link.type === "folder" ? verified.full : path.dirname(verified.full), file);
        const inferredKind = subtitleScope(relativeName, link.relativePath).kind;
        // Explicit OVA/movie/special filename markers may not leak into TV
        // links. Generic filenames are allowed when the admin supplies kind.
        if (inferredKind === "unknown" || (inferredKind !== "main" && inferredKind !== link.kind)) continue;
        const info = await stat(file);
        if (!info.isFile() || info.size > 32 * 1024 * 1024 || info.size < 1) continue;
        if (/\.zip$/i.test(file)) {
          const { zip, entries } = inspectSubtitleArchive(await readFile(file));
          // The linked work/season is explicit; each member must still prove its episode.
          const selected = selectEpisodeEntries(entries, request,
            [seasonEvidence, readEpisodeEvidence(path.basename(file), true)],
            episode === 1 && ["movie", "ova", "special"].includes(link.kind));
          for (const entry of selected.slice(0, 10)) {
            const parsed = decodeSubtitleFile(zip.getEntries()[entry.index].getData(), entry.filename);
            if (parsed?.content) results.push({...parsed, name: "[DB 연결] " + entry.filename,
              sourceProvider: provider, sourceMatchedTitle: link.title,
              localArchive: true, episodeConfirmed: true, verifiedMatch: true, adminLinked: true});
          }
        } else if (EXT.test(file)) {
          const filename = path.relative(verified.full, file).split(path.sep).join("/");
          const basename = path.basename(file);
          const evidence = readEpisodeEvidence(basename, true);
          // Some manually downloaded sets put unnumbered filenames inside a
          // numbered episode directory, e.g. 1화/main.srt. Never override
          // contradictory evidence in the filename itself.
          const parent = filename.split("/").slice(0,-1).reverse()
            .map(part => readEpisodeEvidence(part, true))
            .find(e => e.episodes.length > 0 || e.multipleSeasons || e.conflict);
          if (evidence.conflict || evidence.range || evidence.multipleSeasons ||
            evidence.episodes.length > 1 || (!evidence.episodes.length && !parent?.episodes.length) ||
            !selectEpisodeEntries([{ filename: basename }], request,
              [seasonEvidence, ...(parent ? [parent] : [])], Boolean(!evidence.episodes.length && parent?.episodes.length === 1)).length)
            continue;
          const parsed = decodeSubtitleFile(await readFile(file), filename);
          if (parsed?.content) results.push({...parsed, name: "[DB 연결] " + filename,
            sourceProvider: provider, sourceMatchedTitle: link.title,
            localArchive: true, episodeConfirmed: true, verifiedMatch: true, adminLinked: true});
        }
        if (results.length >= 15) return results;
      } catch { /* Bad/corrupt member must not stop other subtitle files. */ }
    }
  }
  return results;
}
