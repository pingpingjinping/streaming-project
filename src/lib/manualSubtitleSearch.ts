import { getDb } from "@/lib/db";
import type { AnimeListItem } from "@/lib/providers/types";
import { directManualSearchHref } from "@/lib/catalogDirectPlayback";

export type ManualSubtitleSearchHit = { item: AnimeListItem; memberIds: string[] };
type LinkedRow = { relative_path: string; anime_id: string; work_title: string; member_ids: string[] | null };

function parseWork(id: string): {source: string; id: string} | null {
  const ani = /^ani_(\d+)$/.exec(id);
  if (ani) return {source: "Anissia", id: ani[1]};
  const re = /^re_([A-Za-z0-9_-]+)$/.exec(id);
  if (re) return {source: "ReAnime", id: re[1]};
  const ak = /^ak_([A-Za-z0-9_-]+)$/.exec(id);
  if (ak) return {source: "Anikoto", id: ak[1]};
  const db = /^db_(AniList|Onnada)_([A-Za-z0-9_-]+)$/.exec(id);
  return db ? {source:db[1], id:db[2]} : null;
}
const normalize = (value: string) =>
  value.normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/[^\p{L}\p{N}]+/gu, "");

function preferredId(ids: string[], selected: string) {
  // Prefer a playable video page for groups with both catalog and video refs.
  for (const pattern of [/^ani_\d+$/, /^re_/, /^ak_/, /^db_(AniList|Onnada)_/]) {
    const match = ids.find(id => pattern.test(id));
    if (match) return match;
  }
  return selected;
}

export function mergeManualSubtitleSearchResults(
  remote: AnimeListItem[], linked: ManualSubtitleSearchHit[],
): AnimeListItem[] {
  const results = remote.map(item => ({ ...item }));
  const touched = new Set<string>();
  const additions: AnimeListItem[] = [];
  const addedAliases = new Set<string>();
  for (const hit of linked) {
    const identities = new Set([hit.item.id, ...hit.memberIds]);
    const match = results.find(item => identities.has(item.id));
    if (match) {
      if (touched.has(match.id)) continue;
      touched.add(match.id);
      // A Korean name registered on the Pi takes effect before monthly D1 sync.
      if (/[가-힣]/.test(hit.item.title)) {
        match.original_title = match.original_title || match.title;
        match.title = hit.item.title;
      }
      match.source_name = [match.source_name, hit.item.source_name || "Pi 자막 연결"].filter(Boolean).join(" · ");
      // If the Pi has a verified playable ID, a Cloudflare catalog card
      // should use that work link directly rather than stop at /catalog.
      const directHref = directManualSearchHref(match.id, hit.item.detail_url);
      if (directHref) match.detail_url = directHref;
      continue;
    }
    if ([...identities].some(id => addedAliases.has(id))) continue;
    for (const id of identities) addedAliases.add(id);
    additions.push(hit.item);
  }
  // Keep every Cloudflare result on the same page: no shifting across pagination.
  return [...additions, ...results];
}

export async function searchManualSubtitleLinks(
  keyword: string, limit = 12,
): Promise<ManualSubtitleSearchHit[]> {
  const sql = getDb();
  const query = normalize(keyword.slice(0, 100));
  if (!sql || query.length < 2) return [];

  let links: LinkedRow[];
  try {
    links = await sql`SELECT l.relative_path, l.anime_id, l.work_title,
        array_remove(array_agg(DISTINCT m.anime_id), NULL) AS member_ids
      FROM anime_admin_subtitle_links l
      LEFT JOIN anime_admin_subtitle_link_members m ON m.relative_path=l.relative_path
      GROUP BY l.relative_path,l.anime_id,l.work_title,l.updated_at
      ORDER BY l.updated_at DESC
      LIMIT 500` as LinkedRow[];
  } catch (error: any) {
    if (error?.code === "42P01") return [];
    console.warn("[Manual subtitle DB search]", error);
    return [];
  }
  // A name can be registered before a subtitle folder is attached.
  try {
    const named=await sql`SELECT canonical_id AS anime_id,korean_title AS work_title,
        array_agg(anime_id ORDER BY anime_id) AS member_ids
      FROM anime_admin_work_titles GROUP BY canonical_id,korean_title`;
    const linkedIds=new Set(links.flatMap(row=>[row.anime_id,...(row.member_ids || [])]));
    for(const row of named) {
      const ids=Array.isArray(row.member_ids)?row.member_ids.map(String):[String(row.anime_id)];
      if(ids.some(id=>linkedIds.has(id)))continue;
      links.push({relative_path:"",anime_id:String(row.anime_id),work_title:String(row.work_title),member_ids:ids});
    }
  } catch(error:any) {
    if(error?.code!=="42P01")console.warn("[Manual Korean title search]",error);
  }
  if (!links.length) return [];

  const identities = [...new Set(links.flatMap(row => [row.anime_id, ...(row.member_ids || [])]))];
  const wanted = identities.map(value => ({value,ref:parseWork(value)}))
    .filter((row): row is {value:string;ref:{source:string;id:string}} => row.ref !== null);
  const regular = wanted.filter(row => row.ref.source !== "Anikoto");
  const anikoto = wanted.filter(row => row.ref.source === "Anikoto");
  const regularSources = [...new Set(regular.map(row => row.ref.source))];
  const regularIds = [...new Set(regular.map(row => row.ref.id))];
  const anikotoIds = [...new Set(anikoto.map(row => row.ref.id))];

  // Target the small set of manually linked work IDs, not the full catalog.
  const [catalog, anikotoCatalog] = await Promise.all([
    regularIds.length ? sql`SELECT source, source_record_id, payload FROM anime_catalog_entries
      WHERE source=ANY(${regularSources}::text[])
        AND source_record_id=ANY(${regularIds}::text[])` : Promise.resolve([]),
    anikotoIds.length ? sql`SELECT anikoto_id,payload FROM anime_anikoto_catalog
      WHERE anikoto_id=ANY(${anikotoIds}::text[])` : Promise.resolve([]),
  ]).catch(error => {
    console.warn("[Manual subtitle DB title expansion]", error);
    return [[], []];
  });

  const titles = new Map<string,string[]>();
  const addTitles=(id:string,payload:any)=>{
    if (!payload || typeof payload !== "object") return;
    titles.set(id, [
      payload.title_ko, payload.title, payload.name,
      payload.title_english, payload.english_title, payload.title_native,
      payload.title_romaji, payload.romaji_title,
    ].filter((value):value is string => typeof value === "string" && value.length > 0));
  };
  for (const row of catalog) {
    const id = row.source === "Anissia" ? "ani_" + row.source_record_id
      : row.source === "ReAnime" ? "re_" + row.source_record_id
      : "db_" + row.source + "_" + row.source_record_id;
    addTitles(id,row.payload);
  }
  for (const row of anikotoCatalog) addTitles("ak_" + row.anikoto_id,row.payload);

  const found: ManualSubtitleSearchHit[]=[];
  const existing = new Set<string>();
  for (const link of links) {
    const memberIds = [...new Set([link.anime_id,...(link.member_ids || [])])];
    if (![link.work_title,...memberIds.flatMap(id => titles.get(id) || [])]
      .some(title => normalize(title).includes(query))) continue;
    const id = preferredId(memberIds,link.anime_id);
    if (existing.has(id)) continue;
    existing.add(id);
    const ref = parseWork(id);
    const detailUrl = ref && (ref.source === "AniList" || ref.source === "Onnada")
      ? "/catalog/" + ref.source + "/" + encodeURIComponent(ref.id)
      : "/anime/" + encodeURIComponent(id);
    found.push({
      item: {
        id,title:link.work_title,poster:"",detail_url:detailUrl,
        remarks:link.relative_path ? "수동으로 연결한 Pi 자막" : "직접 등록한 한글 이름",
        source_name:link.relative_path ? "Pi 자막 연결" : "한글 이름 등록",
        caption_count:null,
      },
      memberIds,
    });
    if (found.length >= limit) break;
  }
  return found;
}

