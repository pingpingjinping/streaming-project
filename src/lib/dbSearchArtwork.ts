import {getDb} from "@/lib/db";
import {getReanimeArtwork} from "@/lib/providers/reanime";
import {getAnimeDetail as getAnikotoDetail} from "@/lib/providers/anikoto";

type SourceRef={source:"Anissia"|"ReAnime"|"AniList"|"Onnada"|"Anikoto";id:string};
type Identity={reanime:string[];anilist:string[];anikoto:string[]};
type PosterChoice={poster:string;source:string}|null;
const ID_PATTERN=/^[A-Za-z0-9_-]{1,150}$/;
const pending=new Map<string,Promise<PosterChoice>>();
let tableReady:Promise<void>|null=null;
const POSITIVE_DAYS=30,NEGATIVE_HOURS=6;

export function parseSearchWorkId(id:string):SourceRef|null {
  const m=/^(ani_|re_|ak_|db_AniList_|db_Onnada_)([A-Za-z0-9_-]{1,150})$/.exec(id);
  if(!m)return null;
  const source=({"ani_":"Anissia","re_":"ReAnime","ak_":"Anikoto",
    "db_AniList_":"AniList","db_Onnada_":"Onnada"} as Record<string,SourceRef["source"]>)[m[1]];
  if(source==="Anissia"&&!/^\d+$/.test(m[2]))return null;
  return {source,id:m[2]};
}

export function safePosterUrl(raw:unknown):string {
  if(typeof raw!=="string"||raw.length>2048)return "";
  try {
    const url=new URL(raw);
    return url.protocol==="https:"&&!url.username&&!url.password&&url.hostname
      ? url.toString():"";
  }catch{return "";}
}

function jsonData(input:unknown):Record<string,any> {
  if(typeof input==="string"){try {return jsonData(JSON.parse(input))}catch{return {};}}
  return input&&typeof input==="object"&&!Array.isArray(input)?input as Record<string,any>:{};
}
function ids(raw:unknown):string[] {
  if(!Array.isArray(raw))return [];
  return [...new Set(raw.map(String).filter(s=>ID_PATTERN.test(s)))].slice(0,8);
}
function cleanIdentity(values:Identity):Identity {
  return {reanime:[...new Set(values.reanime)].filter(x=>/^[a-z0-9][a-z0-9-]{0,149}$/i.test(x)),
    anilist:[...new Set(values.anilist)].filter(x=>/^[1-9]\d{0,11}$/.test(x)),
    anikoto:[...new Set(values.anikoto)].filter(x=>ID_PATTERN.test(x))};
}

/** Resolve sources via DB exact work IDs only. Never fuzzy-match another season by title. */
export async function getVerifiedArtworkIds(sql:any,animeId:string):Promise<Identity> {
  const ref=parseSearchWorkId(animeId);
  if(!ref)return {reanime:[],anilist:[],anikoto:[]};
  const candidate:Identity={
    reanime:ref.source==="ReAnime"?[ref.id]:[],
    anilist:ref.source==="AniList"?[ref.id]:[],
    anikoto:ref.source==="Anikoto"?[ref.id]:[],
  };
  const add=(work:string)=>{
    const other=parseSearchWorkId(work);
    if(other?.source==="ReAnime")candidate.reanime.push(other.id);
    else if(other?.source==="AniList")candidate.anilist.push(other.id);
    else if(other?.source==="Anikoto")candidate.anikoto.push(other.id);
  };
  if(ref.source!=="Anikoto") {
    const rows=await sql`SELECT payload FROM anime_catalog_entries
      WHERE source=${ref.source} AND source_record_id=${ref.id} LIMIT 1`;
    if(rows.length) {
      const cross=jsonData(jsonData(rows[0].payload).cross_source_ids_json);
      ids(cross.reanime_ids).forEach(x=>candidate.reanime.push(x));
      ids(cross.anilist_ids).forEach(x=>candidate.anilist.push(x));
    }
  }
  // The versioned GitHub overlay is a reviewed group of exact source identities.
  try {
    const groupRows=await sql`SELECT m.member_id
      FROM anime_release_reviewed_work_group_members m
      JOIN anime_release_reviewed_work_group_members origin ON origin.group_id=m.group_id
      WHERE origin.member_id=${animeId}`;
    for(const row of groupRows)add(String(row.member_id));
  }catch(error:any){if(error?.code!=="42P01")throw error;}
  // Pi-only manual links are the live overlay until the month-end reviewed release.
  try {
    const groupRows=await sql`SELECT DISTINCT m.anime_id AS member_id
      FROM anime_admin_subtitle_link_members m
      WHERE m.relative_path IN (
        SELECT relative_path FROM anime_admin_subtitle_link_members WHERE anime_id=${animeId}
        UNION SELECT relative_path FROM anime_admin_subtitle_links WHERE anime_id=${animeId}
      ) LIMIT 50`;
    for(const row of groupRows)add(String(row.member_id));
  }catch(error:any){if(error?.code!=="42P01")throw error;}
  if(ref.source==="Anissia") {
    try {
      const matches=await sql`SELECT DISTINCT reanime_id FROM anime_reanime_matches
        WHERE anissia_no=${Number(ref.id)}
          AND review_status IN ('검토된 사항','자동확정')`;
      // A single source with two different confirmed targets cannot be resolved by guessing.
      if(matches.length===1)candidate.reanime.push(String(matches[0].reanime_id));
    }catch(error:any){if(error?.code!=="42P01")throw error;}
  }
  if(ref.source!=="Anikoto") {
    try {
      const videos=await sql`SELECT DISTINCT anikoto_id FROM anime_anikoto_work_lookup
        WHERE source=${ref.source} AND source_record_id=${ref.id}
          AND link_status IN ('reviewed','automatic') LIMIT 5`;
      videos.forEach((row:any)=>candidate.anikoto.push(String(row.anikoto_id)));
    }catch(error:any){if(error?.code!=="42P01")throw error;}
  }
  return cleanIdentity(candidate);
}

async function anilistPosterByExactId(id:string):Promise<string> {
  const response=await fetch("https://graphql.anilist.co",{
    method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},
    body:JSON.stringify({query:"query ($id: Int) { Media(id: $id, type: ANIME) { id coverImage { extraLarge large medium } } }",
      variables:{id:Number(id)}}),
    cache:"no-store",signal:AbortSignal.timeout(3500),
  });
  if(!response.ok)return "";
  const media=(await response.json())?.data?.Media;
  if(String(media?.id)!==id)return "";
  return safePosterUrl(media?.coverImage?.extraLarge||media?.coverImage?.large||media?.coverImage?.medium);
}

export async function resolveArtworkByIdentity(refs:Identity):Promise<PosterChoice> {
  // Never associate an image from an ambiguous same-provider multi-match.
  const linked=cleanIdentity(refs);
  if(linked.reanime.length===1) {
    const artwork=await getReanimeArtwork(linked.reanime[0]).catch(()=>null);
    const poster=safePosterUrl(artwork?.poster);
    if(poster)return {poster,source:"ReAnime"};
  }
  if(linked.anilist.length===1) {
    const poster=await anilistPosterByExactId(linked.anilist[0]).catch(()=>"");
    if(poster)return {poster,source:"AniList"};
  }
  if(linked.anikoto.length===1) {
    const detail=await getAnikotoDetail("ak_"+linked.anikoto[0]).catch(()=>null);
    const poster=safePosterUrl(detail?.poster);
    if(poster)return {poster,source:"Anikoto"};
  }
  return null;
}

async function schema(sql:any) {
  if(!tableReady) tableReady=sql`CREATE TABLE IF NOT EXISTS anime_search_poster_cache (
    work_id VARCHAR(180) PRIMARY KEY,
    poster TEXT NOT NULL DEFAULT '',
    source VARCHAR(30) NOT NULL DEFAULT '',
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
  )`.then(()=>{}).catch((error:unknown)=>{tableReady=null;throw error});
  await tableReady;
}

async function fromDb(workId:string):Promise<PosterChoice|undefined> {
  const sql=getDb();
  if(!sql)return undefined;
  await schema(sql);
  const rows=await sql`SELECT poster,source FROM anime_search_poster_cache
    WHERE work_id=${workId} AND expires_at>now() LIMIT 1`;
  if(!rows.length)return undefined;
  const poster=safePosterUrl(rows[0].poster);
  return poster?{poster,source:String(rows[0].source)}:null;
}

/** Persist the URL, not an image binary. Negative cache prevents repeated misses. */
export async function cachedDbSearchPoster(animeId:string):Promise<PosterChoice> {
  if(!parseSearchWorkId(animeId))return null;
  if(pending.has(animeId))return pending.get(animeId)!;
  const task=(async()=>{
    const sql=getDb();
    if(!sql)return null;
    try {
      const stored=await fromDb(animeId);
      if(stored!==undefined)return stored;
      const refs=await getVerifiedArtworkIds(sql,animeId);
      const found=await resolveArtworkByIdentity(refs);
      await sql`INSERT INTO anime_search_poster_cache (work_id,poster,source,fetched_at,expires_at)
        VALUES(${animeId},${found?.poster||""},${found?.source||""},now(),
          now()+${found?POSITIVE_DAYS*24*3600:NEGATIVE_HOURS*3600}*INTERVAL '1 second')
        ON CONFLICT(work_id) DO UPDATE SET
          poster=EXCLUDED.poster,source=EXCLUDED.source,
          fetched_at=EXCLUDED.fetched_at,expires_at=EXCLUDED.expires_at`;
      return found;
    }catch(error) {
      console.warn("[DB search poster cache]",error);
      return null;
    }
  })().finally(()=>{pending.delete(animeId)});
  pending.set(animeId,task);
  return task;
}
