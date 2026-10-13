import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rmdir, stat, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { getDb, initDb } from "@/lib/db";
import { getLocalSubtitleNameEntries, refreshLocalSubtitleNameIndex } from "@/lib/localSubtitleNameIndex";
import { inspectSubtitleArchive } from "@/lib/subtitleUpload";
import { decodeSubtitleFile } from "@/lib/subtitles";
import { readEpisodeEvidence, selectEpisodeEntries } from "@/lib/subtitleEpisodes";
import { subtitleScope } from "@/lib/subtitleLocalIdentity";
import { buildReviewedWorkGroups, type WorkRef, type Source, type SourceWork } from "@/lib/adminSubtitleWorkGroups";

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
  const anissia=/^ani_([1-9]\d*)$/.exec(value);
  if(anissia)return {source:"Anissia",id:anissia[1]};
  const reanime=/^re_([a-zA-Z0-9_-]+)$/.exec(value);
  if(reanime)return {source:"ReAnime",id:reanime[1]};
  const anikoto=/^ak_([a-zA-Z0-9_-]+)$/.exec(value);
  if(anikoto)return {source:"Anikoto",id:anikoto[1]};
  const db=/^db_(AniList|Onnada)_([a-zA-Z0-9_-]+)$/.exec(value);
  return db?{source:db[1],id:db[2]}:null;
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
      await sql`CREATE TABLE IF NOT EXISTS anime_admin_subtitle_link_members (
        relative_path TEXT NOT NULL REFERENCES anime_admin_subtitle_links(relative_path)
          ON DELETE CASCADE ON UPDATE CASCADE,
        anime_id VARCHAR(150) NOT NULL,
        PRIMARY KEY (relative_path, anime_id)
      )`;
      await sql`CREATE INDEX IF NOT EXISTS idx_anime_admin_subtitle_link_members_work
        ON anime_admin_subtitle_link_members(anime_id)`;
    })().catch(error => {
      subtitleLinkSchemaReady = null;
      throw error;
    });
  }
  await subtitleLinkSchemaReady;
  return sql;
}

function sourceWork(row: any): SourceWork {
  const source=String(row.source) as Source, id=String(row.source_record_id || row.anikoto_id);
  const payload=typeof row.payload==="object" && row.payload!==null ? row.payload : {};
  const title=String(payload.title_ko || payload.title || payload.name ||
    payload.title_english || payload.english_title || payload.title_native ||
    payload.title_romaji || payload.romaji_title || id);
  return {source,id,animeId:source==="Anissia"?"ani_"+id:source==="ReAnime"?"re_"+id
    :source==="Anikoto"?"ak_"+id:"db_"+source+"_"+id,
    title,year:String(payload.year || payload.release_year || ""),
    format:String(payload.format || "")};
}
function jsonField(raw: unknown): any {
  if(raw && typeof raw==="object")return raw;
  if(typeof raw==="string")try{return JSON.parse(raw)}catch{}
  return {};
}
const normalizedIdentityTitle=(v:unknown)=>String(v||"").normalize("NFKC").toLocaleLowerCase("en")
  .replace(/[^\p{L}\p{N}]/gu,"");
function compatibleSourceRows(a:any,b:any):boolean {
  const ay=String(a.year||""),by=String(b.year||"");
  const af=String(a.format||"").toUpperCase(),bf=String(b.format||"").toUpperCase();
  if((ay && by && ay!==by) || (af && bf && af!==bf))return false;
  const titles=(row:any)=>new Set(["title_ko","title_native","title_romaji","title_english"]
    .map(k=>normalizedIdentityTitle(row[k])).filter(t=>t.length>=4));
  const t1=titles(a),t2=titles(b);
  if(![...t1].some(t=>t2.has(t)))return false;
  const count=(row:any)=>{
    const meta=jsonField(row.source_metadata_json);
    const value=meta.episodes||meta.episodes_total||meta.onnada_episodes;
    const n=Number(value);return Number.isInteger(n)&&n>0?n:0;
  };
  const ac=count(a),bc=count(b);
  return !ac || !bc || ac===bc;
}

/** Search by title, expand only reviewed ID edges, then hydrate member titles.
 * This is admin-only and executes on explicit search, not on each keystroke.
 */
export async function findCatalogWorks(q: string, exactAnimeId?: string) {
  const query=q.normalize("NFKC").trim().slice(0,120);
  const exact=exactAnimeId?parseWorkId(exactAnimeId):null;
  if(query.length<2&&!exact)return [];
  const sql=getDb();if(!sql)return [];
  const escaped=query.replace(/[\\%_]/g,"\\$&");
  const pattern="%"+escaped+"%";
  await initDb();
  const exactCore=exact&&exact.source!=="Anikoto"
    ? sql`SELECT source,source_record_id,payload FROM anime_catalog_entries
      WHERE source=${exact.source} AND source_record_id=${exact.id} LIMIT 1` : exact ? Promise.resolve([]) : null;
  const exactAk=exact&&exact.source==="Anikoto"
    ? sql`SELECT anikoto_id,payload FROM anime_anikoto_catalog
      WHERE anikoto_id=${exact.id} LIMIT 1` : exact ? Promise.resolve([]) : null;
  const [matched,akMatched,korean,rematches,manual,crossRe,anilinks]=await Promise.all([
    exactCore || sql`SELECT source,source_record_id,payload FROM anime_catalog_entries
      WHERE source IN ('Anissia','ReAnime','AniList','Onnada')
        AND (source_record_id=${query}
          OR CONCAT_WS(' ',payload->>'title_ko',payload->>'title_native',
            payload->>'title_romaji',payload->>'title_english') ILIKE ${pattern})
      ORDER BY CASE source WHEN 'Anissia' THEN 0 WHEN 'ReAnime' THEN 1 ELSE 2 END,
        payload->>'year' DESC NULLS LAST LIMIT 120`,
    exactAk || sql`SELECT anikoto_id,payload FROM anime_anikoto_catalog
      WHERE anikoto_id=${query} OR CONCAT_WS(' ',payload->>'title',payload->>'name',
        payload->>'title_english',payload->>'english_title',
        payload->>'title_romaji',payload->>'title_native') ILIKE ${pattern}
      LIMIT 40`,
    sql`SELECT source,source_record_id,payload->>'status' AS status,
        payload->>'anilistId' AS anilist_id,payload->>'reanimeId' AS reanime_id
      FROM anime_korean_catalog WHERE payload->>'status' IN ('검토된 사항','자동확정')`,
    sql`SELECT reanime_id,anissia_no,review_status FROM anime_reanime_matches
      WHERE anissia_no IS NOT NULL AND review_status IN ('검토된 사항','자동확정')`,
    sql`SELECT reanime_id,anissia_no FROM anime_work_match_overrides`,
    sql`SELECT source_record_id,payload FROM anime_catalog_entries
      WHERE source='ReAnime' AND payload->>'cross_source_ids_json' LIKE '%anilist_ids%'`,
    sql`SELECT source,source_record_id,anikoto_id,link_status,mapping_kind
      FROM anime_anikoto_work_lookup
      WHERE link_status IN ('reviewed','automatic','multi_reviewed')`,
  ]);
  const seeds:WorkRef[]=[...matched.map(x=>({source:String(x.source) as Source,id:String(x.source_record_id)})),
    ...akMatched.map(x=>({source:"Anikoto" as const,id:String(x.anikoto_id)}))];
  if(!seeds.length)return [];
  // A declared AniList ID from ReAnime alone is not enough to prove identity.
  const cross:Array<{reanimeId:string;anilistId:string;compatible:boolean}>=[];
  const wantedIds=[...new Set(crossRe.flatMap(row=>{
    const parsed=jsonField(row.payload?.cross_source_ids_json);
    return Array.isArray(parsed.anilist_ids)?parsed.anilist_ids.map(String):[];
  }))].filter(id=>id.length && id.length<100);
  const anilist=wantedIds.length?await sql`SELECT source_record_id,payload FROM anime_catalog_entries
    WHERE source='AniList' AND source_record_id=ANY(${wantedIds}::text[])`:[];
  const byAni=new Map(anilist.map(row=>[String(row.source_record_id),row.payload]));
  for(const row of crossRe) {
    const parsed=jsonField(row.payload?.cross_source_ids_json);
    const ids=Array.isArray(parsed.anilist_ids)?parsed.anilist_ids:[];
    for(const id of ids.slice(0,12)) {
      const aid=String(id),other=byAni.get(aid);
      if(other && compatibleSourceRows(row.payload,other))cross.push({
        reanimeId:String(row.source_record_id),anilistId:aid,compatible:true,
      });
    }
  }
  const releaseRows=await sql`SELECT member_id,group_id FROM anime_release_reviewed_work_group_members
    ORDER BY group_id,member_id`.catch((error: any)=>{
    if(error?.code==="42P01")return [];
    throw error;
  });
  const releases=new Map<string,string[]>();
  for(const row of releaseRows) {
    const gid=String(row.group_id);
    if(!releases.has(gid))releases.set(gid,[]);
    releases.get(gid)!.push(String(row.member_id));
  }
  const evidence={
    release:[...releases.values()].map(members=>({members})),
    korean:korean.map(row=>({source:String(row.source) as Source,id:String(row.source_record_id),
      status:String(row.status||""),anilistId:String(row.anilist_id||""),
      reanimeId:String(row.reanime_id||"")})),
    reanime:rematches.map(row=>({reanimeId:String(row.reanime_id),
      anissiaNo:Number(row.anissia_no),reviewStatus:String(row.review_status)})),
    manual:manual.map(row=>({reanimeId:String(row.reanime_id),anissiaNo:Number(row.anissia_no)})),
    cross,
    anikoto:anilinks.map(row=>({anikotoId:String(row.anikoto_id),
      target:{source:String(row.source) as Source,id:String(row.source_record_id)},
      status:String(row.link_status),mappingKind:String(row.mapping_kind||"")}))
  };
  const preliminary=buildReviewedWorkGroups({seeds,catalog:[
    ...matched.map(sourceWork),...akMatched.map(row=>sourceWork({...row,source:"Anikoto"}))],
    ...evidence,limit:100,hydrateMissing:true});
  const refs=[...new Set(preliminary.flatMap(group=>group.members)
    .filter(m=>m.source!=="Anikoto").map(m=>m.source+":"+m.id))];
  const akIds=[...new Set(preliminary.flatMap(group=>group.members)
    .filter(m=>m.source==="Anikoto").map(m=>m.id))];
  const [expanded,akExpanded]=await Promise.all([
    refs.length?sql`SELECT source,source_record_id,payload FROM anime_catalog_entries
      WHERE (source||':'||source_record_id)=ANY(${refs}::text[])`:Promise.resolve([]),
    akIds.length?sql`SELECT anikoto_id,payload FROM anime_anikoto_catalog
      WHERE anikoto_id=ANY(${akIds}::text[])`:Promise.resolve([]),
  ]);
  const groups=buildReviewedWorkGroups({seeds,catalog:[
    ...expanded.map(sourceWork),
    ...akExpanded.map(row=>sourceWork({...row,source:"Anikoto"}))],
    ...evidence,limit:100});
  const order=new Map(seeds.map((ref,i)=>[ref.source+":"+ref.id,i]));
  return groups.sort((a,b)=>{
    const rank=(group:typeof a)=>Math.min(...group.members.map(m=>order.get(m.source+":"+m.id)??9999));
    return rank(a)-rank(b)||a.title.localeCompare(b.title,"ko");
  }).slice(0,60);
}

/** Browse an existing on-disk name index; no ZIP decompression or DB title lookup.
 * Return total count too, since the admin UI intentionally renders only 200 rows.
 */
export async function browseLocalEntries(q = "") {
  const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ko-KR")
    .replace(/[^\p{L}\p{N}]+/gu, "");
  const needle = normalize(q);
  const entries = await getLocalSubtitleNameEntries(storageRoot());
  const indexed = entries.map(e => ({
    relativePath: e.relativePath, type: e.choice.entryType, name: e.choice.folderName,
    source: e.choice.provider,
  }));
  // Playback search skips Naver work directories; admin linking supports those.
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
  // Also match parent work-folder names when a nested ZIP is named "01.zip".
  const matched = [...indexed, ...naverFolders]
    .filter(entry => !needle || normalize(entry.relativePath).includes(needle))
    .sort((a,b) => a.relativePath.localeCompare(b.relativePath, "ko"));
  return { items: matched.slice(0, 200), total: matched.length };
}

export async function getAdminSubtitleLinks(animeId?: string) {
  const sql = await ensureSubtitleLinksTable();
  const rows = animeId ? await sql`SELECT l.* FROM anime_admin_subtitle_links l
      WHERE l.anime_id=${animeId} OR EXISTS (
        SELECT 1 FROM anime_admin_subtitle_link_members m
        WHERE m.relative_path=l.relative_path AND m.anime_id=${animeId})
      ORDER BY l.updated_at DESC LIMIT 200`
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
  const current = await verifiedLocalEntry(values.relativePath, values.type);
  if (!current) throw new Error("Pi에 해당 폴더/ZIP이 없거나 접근할 수 없습니다.");
  const id = parseWorkId(values.animeId)!;
  const sql = await ensureSubtitleLinksTable();
  const rows = id.source==="Anikoto"
    ? await sql`SELECT payload FROM anime_anikoto_catalog WHERE anikoto_id=${id.id} LIMIT 1`
    : await sql`SELECT payload FROM anime_catalog_entries WHERE source=${id.source} AND source_record_id=${id.id} LIMIT 1`;
  if (!rows.length) throw new Error("작품 DB에 존재하지 않는 ID입니다.");
  const payload = rows[0].payload;
  let title = String(payload?.title_ko || payload?.title || payload?.name ||
    payload?.title_english || payload?.title_native ||
    payload?.title_romaji || id.id).slice(0, 300);
  const reviewedGroups=await findCatalogWorks(id.id,values.animeId);
  const reviewedGroup=reviewedGroups.find(group=>group.members.some(member=>member.animeId===values.animeId));
  if(!reviewedGroup)throw new Error("선택한 작품의 확정 연결 정보를 다시 확인해 주세요.");
  title=reviewedGroup.title.slice(0,300);
  // Multi-target Anikoto URL must not implicitly attach unrelated seasons.
  const memberIds=[...new Set(reviewedGroup.members
    .filter(member=>!reviewedGroup.multiAnikotoIds.includes(member.animeId))
    .map(member=>member.animeId).concat(values.animeId))];

  const sourceRoot = values.relativePath.split("/")[0];
  const destinationRoot = path.join(storageRoot(), sourceRoot);
  // Reuse only a VERIFIED, explicitly linked folder for the same reviewed work,
  // subtitle type, season and provider. A matching title alone is not proof.
  const existingRows = await sql`SELECT relative_path, anime_id FROM anime_admin_subtitle_links
    WHERE entry_type='folder' AND anime_id=ANY(${memberIds}::text[])
      AND subtitle_kind=${values.kind} AND season=${values.season}
      AND relative_path LIKE ${sourceRoot + "/%"}
    ORDER BY updated_at ASC LIMIT 100`;
  let existingTarget: { full: string; name: string } | null = null;
  for (const row of existingRows) {
    const folderPath = String(row.relative_path);
    const verified = await verifiedLocalEntry(folderPath, "folder");
    if (verified) {
      existingTarget = { full: verified.full, name: path.basename(verified.full) };
      break;
    }
  }
  const target = existingTarget || await allocateCanonicalFolder(destinationRoot, title,
    values.type === "folder" ? current.full : undefined);

  // Preflight: never rename a folder holding somebody else's stored links or
  // legacy per-account player assignment. Those pointers would become stale.
  if (values.type === "folder" && target.full !== current.full) {
    const nested = await sql`SELECT relative_path FROM anime_admin_subtitle_links
      WHERE relative_path LIKE ${values.relativePath + "/%"} AND relative_path != ${values.relativePath} LIMIT 1`;
    if (nested.length) throw new Error("하위 ZIP에 다른 DB 연결이 있어 폴더명을 변경할 수 없습니다.");
    const users = await sql`SELECT 1 FROM subtitle_bundle_assignments
      WHERE provider=${sourceRoot.replace("_subtitles", "")}
        AND bundle_key LIKE ${"%" + values.relativePath.split("/")[1] + "%"} LIMIT 1`;
    if (users.length) throw new Error("다른 계정의 자막 묶음 지정이 있는 폴더라 이동할 수 없습니다. 새 폴더에 복사한 후 연결해 주세요.");
  }

  let moved = false, extracted = false;
  let scratch: string | null = null;
  let merge: Awaited<ReturnType<typeof mergeSubtitleFolders>> | null = null;
  try {
    if (existingTarget && target.full !== current.full) {
      if (values.type === "zip") {
        // A Pi ZIP is never modified; expand it in a private temporary folder.
        scratch = await mkdtemp(path.join(destinationRoot, ".admin-merge-"));
        const expanded = path.join(scratch, "unpacked");
        await extractZipAsFolder(await readFile(current.full), expanded);
        merge = await mergeSubtitleFolders(expanded, target.full);
      } else {
        merge = await mergeSubtitleFolders(current.full, target.full);
      }
    } else if (values.type === "zip") {
      // No linked folder yet: create a canonical work folder and retain the ZIP.
      await extractZipAsFolder(await readFile(current.full), target.full);
      extracted = true;
    } else if (target.full !== current.full) {
      await rename(current.full, target.full);
      moved = true;
    }
    const relativePath = [sourceRoot, path.basename(target.full)].join("/");
    const former = values.relativePath;
    // Two work IDs may not silently claim the same physical folder.
    const owners = await sql`SELECT relative_path,anime_id FROM anime_admin_subtitle_links
      WHERE relative_path IN (${relativePath},${former}) FOR UPDATE`;
    const newOwner = owners.find(row => row.relative_path === relativePath);
    if (newOwner && !memberIds.includes(String(newOwner.anime_id)) && former !== relativePath)
      throw new Error("같은 폴더에 다른 작품 연결이 있습니다.");
    const formerOwner = owners.find(row => row.relative_path === former);
    if (merge && formerOwner && !memberIds.includes(String(formerOwner.anime_id)))
      throw new Error("다른 작품으로 연결된 원본 폴더는 병합할 수 없습니다.");

    await sql.begin(async tx => {
      await tx`DELETE FROM anime_admin_subtitle_links WHERE relative_path=${former}`;
      await tx`INSERT INTO anime_admin_subtitle_links (
        relative_path, entry_type, anime_id, work_title, subtitle_kind, season, updated_by
      ) VALUES (${relativePath},'folder',${values.animeId},${title},${values.kind},${values.season},${values.admin})
      ON CONFLICT(relative_path) DO UPDATE SET
        entry_type=EXCLUDED.entry_type, anime_id=EXCLUDED.anime_id, work_title=EXCLUDED.work_title,
        subtitle_kind=EXCLUDED.subtitle_kind, season=EXCLUDED.season, updated_by=EXCLUDED.updated_by,
        updated_at=CURRENT_TIMESTAMP`;
      await tx`DELETE FROM anime_admin_subtitle_link_members WHERE relative_path=${relativePath}`;
      for(const memberId of memberIds)await tx`INSERT INTO anime_admin_subtitle_link_members(relative_path,anime_id)
        VALUES(${relativePath},${memberId}) ON CONFLICT DO NOTHING`;
    });
    // Commit succeeded: only now can the temporary upload folder be removed.
    // A failed cleanup leaves a harmless extra copy rather than losing data.
    if (merge && values.type === "folder") {
      try { await rm(current.full, { recursive: true, force: true }); }
      catch (error) { console.warn("[Admin subtitle merged source cleanup deferred]", error); }
    }
    try { await refreshLocalSubtitleNameIndex(storageRoot()); }
    catch (error) { console.warn("[Admin subtitle index refresh deferred]", error); }
    return { relativePath, type: "folder" as const, animeId: values.animeId, title,
      merged: merge ? { added: merge.added, skipped: merge.skipped, renamed: merge.renamed } : null };
  } catch (error) {
    if (merge) await merge.rollback().catch(rollback => {
      console.error("[Admin subtitle merge rollback failed]", rollback);
    });
    // Never delete an existing Pi archive on failure.
    if (moved) {
      try { await rename(target.full, current.full); } catch (rollback) {
        console.error("[Admin subtitle folder rename rollback failed]", rollback);
      }
    }
    if (extracted) await rm(target.full, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

export async function deleteAdminSubtitleLink(relativePath: string) {
  const sql = await ensureSubtitleLinksTable();
  await sql`DELETE FROM anime_admin_subtitle_links WHERE relative_path=${relativePath}`;
}

const cleanName = (raw: string) => raw.normalize("NFKC").replace(/[<>:"\/\\|?*\x00-\x1f]/g, "_")
  .replace(/\s+/g, " ").replace(/^\.+|\.+$/g, "").slice(0, 110).trim() || "자막";
export function safeUploadSegments(value: unknown): string[] | null {
  if (typeof value !== "string" || value.length > 700 || value.startsWith("/") ||
    value.includes("\\") || value.includes("\0"))
    return null;
  const parts = value.split("/");
  if (parts.length < 1 || parts.length > 8 ||
    parts.some(p => !p || p === "." || p === ".." || p.startsWith(".") || p.length > 180))
    return null;
  return parts.map(cleanName);
}

async function exists(target: string): Promise<boolean> {
  try { await lstat(target); return true; }
  catch (error: any) { if (error.code === "ENOENT") return false; throw error; }
}

/** Use exactly the DB title unless already occupied; then add a safe suffix. */
export async function allocateCanonicalFolder(providerRoot: string, dbTitle: string, current?: string) {
  const base = cleanName(dbTitle);
  for (let n = 1; n <= 999; n++) {
    const name = n === 1 ? base : base + " (" + n + ")";
    const full = path.join(providerRoot, name);
    if (full === current || !(await exists(full))) return { full, name };
  }
  throw new Error("같은 작품명의 폴더가 너무 많습니다.");
}

/** Extract bounded subtitle-only ZIP entries. Reject unsafe members, never overwrite. */
export async function extractZipAsFolder(bytes: Buffer, destination: string) {
  const { zip, entries } = inspectSubtitleArchive(bytes);
  const names = entries.map(entry => safeUploadSegments(entry.filename));
  if (names.some(name => !name)) throw new Error("ZIP 안에 안전하지 않은 경로가 있습니다.");
  const seen = new Set<string>();
  for (const parts of names as string[][]) {
    const relative = parts.join("/");
    if (seen.has(relative)) throw new Error("ZIP 안에 중복된 자막 파일명이 있습니다.");
    seen.add(relative);
  }
  await mkdir(destination, { recursive: false });
  try {
    for (let i = 0; i < entries.length; i++) {
      const rel = names[i] as string[];
      const full = path.join(destination, ...rel);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, zip.getEntries()[entries[i].index].getData(), { flag: "wx" });
    }
  } catch (error) {
    await rm(destination, { force: true, recursive: true });
    throw error;
  }
  return entries.length;
}

/** Merge into an already linked work folder without replacing any Pi file.
 * Identical contents are skipped, and different files with the same path gain
 * a suffix. The source remains intact until the DB transaction commits.
 */
export async function mergeSubtitleFolders(source: string, destination: string) {
  if (source === destination) return { added: 0, skipped: 0, renamed: 0, rollback: async () => {} };
  const listFiles = async (root: string) => {
    const files: string[] = [];
    const visit = async (dir: string, depth: number): Promise<void> => {
      if (depth > 8) throw new Error("자막 폴더 중첩 깊이가 너무 깊습니다.");
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error("심볼릭 링크가 있는 폴더는 병합할 수 없습니다.");
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await visit(full, depth + 1);
        else if (entry.isFile()) {
          files.push(full);
          if (files.length > 1200) throw new Error("자막 파일이 너무 많아 병합할 수 없습니다.");
        } else throw new Error("지원하지 않는 파일 유형이 있어 병합할 수 없습니다.");
      }
    };
    await visit(root, 0);
    return files;
  };
  const [oldFiles, newFiles] = await Promise.all([listFiles(destination), listFiles(source)]);
  if (!newFiles.length) throw new Error("병합할 자막 파일이 없습니다.");
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const readSafe = async (file: string) => {
    if ((await stat(file)).size > 32 * 1024 * 1024)
      throw new Error("32MB가 넘는 파일은 병합할 수 없습니다.");
    return readFile(file);
  };
  const contents = new Set<string>();
  for (const file of oldFiles) contents.add(digest(await readSafe(file)));

  const addedFiles: string[] = [];
  const newDirs: string[] = [];
  const rollback = async () => {
    for (const file of addedFiles.reverse()) await rm(file, { force: true });
    for (const dir of newDirs.reverse()) await rmdir(dir).catch(() => {});
  };
  let skipped = 0, renamed = 0;
  try {
    for (const file of newFiles) {
      const bytes = await readSafe(file);
      const hash = digest(bytes);
      if (contents.has(hash)) { skipped++; continue; }
      const relative = path.relative(source, file);
      const parsed = path.parse(relative);
      let target = path.join(destination, relative);
      if (!target.startsWith(destination + path.sep)) throw new Error("병합 경로가 올바르지 않습니다.");
      let suffix = 2;
      while (await exists(target)) {
        target = path.join(destination, parsed.dir, parsed.name + " (추가-" + suffix++ + ")" + parsed.ext);
        if (suffix > 1000) throw new Error("같은 이름의 자막이 너무 많습니다.");
      }
      if (suffix > 2) renamed++;
      const missing: string[] = [];
      for (let dir = path.dirname(target); dir !== destination; dir = path.dirname(dir)) {
        if (!dir.startsWith(destination + path.sep)) throw new Error("병합 폴더 경로가 올바르지 않습니다.");
        if (await exists(dir)) break;
        missing.unshift(dir);
      }
      for (const dir of missing) { await mkdir(dir); newDirs.push(dir); }
      await writeFile(target, bytes, { flag: "wx" });
      addedFiles.push(target);
      contents.add(hash);
    }
  } catch (error) {
    await rollback();
    throw error;
  }
  return { added: addedFiles.length, skipped, renamed, rollback };
}

/** ZIP uploads are extracted upon receipt; uploaded folders keep relative paths.
 * Both get a temporary name until the final DB work title is known.
 */
export async function uploadAdminSubtitles(files: Array<{ name: string; bytes: Buffer }>, label: string) {
  if (!files.length || files.length > 120) throw new Error("파일은 한 번에 120개까지 가능합니다.");
  if (files.some(f => !safeUploadSegments(f.name) || f.bytes.length < 1 ||
      f.bytes.length > (f.name.toLowerCase().endsWith(".zip") ? 32 : 16) * 1024 * 1024) ||
    files.reduce((n, f) => n + f.bytes.length, 0) > 48 * 1024 * 1024)
    throw new Error("파일 경로 또는 업로드 용량이 허용 범위를 넘었습니다.");
  if (files.some(f => !/\.(?:zip|ass|ssa|smi|srt|vtt)$/i.test(f.name)))
    throw new Error("자막 및 ZIP만 업로드할 수 있어요.");
  const root = storageRoot();
  const providerRoot = path.join(root, "anissia_subtitles");
  await mkdir(providerRoot, { recursive: true });
  const actualProviderRoot = await realpath(providerRoot);
  if (!actualProviderRoot.startsWith((await realpath(root)) + path.sep))
    throw new Error("자막 저장소 경로를 확인해 주세요.");

  const folder = cleanName(label) + " (수동-" + randomUUID().slice(0, 8) + ")";
  const dest = path.join(actualProviderRoot, folder);
  await mkdir(dest, { recursive: false });
  let count = 0;
  try {
    for (const file of files) {
      const segments = safeUploadSegments(file.name)!;
      if (/\.zip$/i.test(file.name)) {
        if (!file.bytes.subarray(0, 2).equals(Buffer.from("PK")))
          throw new Error("ZIP 파일 형식이 올바르지 않습니다.");
        const basename = cleanName(path.basename(file.name).replace(/\.zip$/i, ""));
        // Multiple uploaded ZIPs stay separated by release name; a single ZIP
        // is unpacked straight into its pending work directory.
        const parent = files.length === 1 ? dest : path.join(dest, ...segments.slice(0,-1), basename);
        if (parent === dest) {
          const { zip, entries } = inspectSubtitleArchive(file.bytes);
          for (const entry of entries) {
            const member = safeUploadSegments(entry.filename);
            if (!member) throw new Error("ZIP 내부 파일 경로가 올바르지 않습니다.");
            const full = path.join(dest, ...member);
            await mkdir(path.dirname(full), { recursive: true });
            await writeFile(full, zip.getEntries()[entry.index].getData(), { flag: "wx" });
            count++;
          }
        } else count += await extractZipAsFolder(file.bytes, parent);
      } else {
        const full = path.join(dest, ...segments);
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, file.bytes, { flag: "wx" });
        count++;
      }
    }
    if (!count) throw new Error("유효한 자막이 없습니다.");
  } catch (error) {
    await rm(dest, { recursive: true, force: true });
    throw error;
  }
  try { await refreshLocalSubtitleNameIndex(root); }
  catch (error) { console.warn("[Admin ZIP extraction index refresh deferred]", error); }
  return { relativePath: "anissia_subtitles/" + folder, type: "folder" as const, count };
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
