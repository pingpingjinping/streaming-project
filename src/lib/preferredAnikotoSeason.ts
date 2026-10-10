import {getDb} from "@/lib/db";

/** Verified media targets, not guessed text similarity. Account-specific choice. */
export type AnikotoSeason = {
  anikotoId:string;
  order:number;
  source:string;
  sourceId:string;
  title:string;
  year:string;
  mappingKind:string;
  episodeStart:number|null;
  episodeEnd:number|null;
  linkStatus:string;
};
const PLAYABLE_ID=/^[A-Za-z0-9_-]{1,150}$/;
const VERIFIED=new Set(["reviewed","automatic","multi_reviewed"]);
export const validAnikotoId=(v:string)=>PLAYABLE_ID.test(v);
export const validSeasonOrder=(n:unknown):n is number=>typeof n==="number"&&Number.isInteger(n)&&n>0&&n<1000;

let schemaReady:Promise<void>|null=null;
async function ensurePreferenceTable() {
  const sql=getDb();
  if(!sql)throw new Error("Pi 데이터베이스를 사용할 수 없습니다.");
  if(!schemaReady) {
    schemaReady=(async()=>{
      await sql`CREATE TABLE IF NOT EXISTS anime_account_preferred_seasons (
        user_id VARCHAR(100) NOT NULL,
        anikoto_id VARCHAR(150) NOT NULL,
        target_order INTEGER NOT NULL CHECK (target_order BETWEEN 1 AND 999),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(user_id,anikoto_id)
      )`;
    })().catch(error=>{schemaReady=null;throw error;});
  }
  await schemaReady;
  return sql;
}

export async function getAnikotoSeasons(anikotoId:string):Promise<AnikotoSeason[]> {
  const sql=getDb();
  if(!sql||!validAnikotoId(anikotoId))return [];
  let rows:any[];
  try {
    rows=await sql`SELECT t.anikoto_id, t.target_order, t.target_source,t.target_id,
        t.link_status,t.mapping_kind,t.anikoto_episode_start,t.anikoto_episode_end,
        c.payload
      FROM anime_anikoto_work_targets t
      LEFT JOIN anime_catalog_entries c
        ON c.source=t.target_source AND c.source_record_id=t.target_id
      WHERE t.anikoto_id=${anikotoId} AND t.link_status IN ('automatic','reviewed','multi_reviewed')
        AND t.target_source IN ('AniList','Onnada','Anissia','ReAnime')
      ORDER BY t.target_order LIMIT 40`;
  } catch(error:any) {
    if(error?.code==="42P01")return [];
    throw error;
  }
  return rows.map(row=>{
    const payload=row.payload&&typeof row.payload==="object"?row.payload:{};
    const title=String(payload.title_ko||payload.title||payload.name||
      payload.title_english||payload.english_title||payload.title_native||
      payload.title_romaji||payload.romaji_title||row.target_id);
    const start=row.anikoto_episode_start===null?null:Number(row.anikoto_episode_start);
    const end=row.anikoto_episode_end===null?null:Number(row.anikoto_episode_end);
    return {
      anikotoId:String(row.anikoto_id),
      order:Number(row.target_order),
      source:String(row.target_source),
      sourceId:String(row.target_id),
      title,
      year:String(payload.year||payload.release_year||""),
      mappingKind:String(row.mapping_kind||""),
      episodeStart:Number.isInteger(start)&&start!>0?start:null,
      episodeEnd:Number.isInteger(end)&&end!>0?end:null,
      linkStatus:String(row.link_status),
    };
  }).filter(row=>validSeasonOrder(row.order)&&VERIFIED.has(row.linkStatus));
}

export function anikotoSeasonHref(anikotoId:string,order:number) {
  if(!validAnikotoId(anikotoId)||!validSeasonOrder(order))return null;
  return "/anime/ak_"+encodeURIComponent(anikotoId)+"?season="+order;
}

export function filterSeasonEpisodes<T extends {number:number}>(
  episodes:T[],season:Pick<AnikotoSeason,"episodeStart"|"episodeEnd">|null,
):{episodes:T[];filtered:boolean} {
  if(!season || !season.episodeStart || !season.episodeEnd ||
     season.episodeStart>season.episodeEnd)return {episodes,filtered:false};
  const selected=episodes.filter(ep=>ep.number>=season.episodeStart!&&ep.number<=season.episodeEnd!);
  return selected.length?{episodes:selected,filtered:true}:{episodes,filtered:false};
}

export async function getPreferredAnikotoSeason(userId:string,anikotoId:string):Promise<number|null> {
  if(!userId||!validAnikotoId(anikotoId))return null;
  const sql=await ensurePreferenceTable();
  const found=await sql`SELECT target_order FROM anime_account_preferred_seasons
    WHERE user_id=${userId} AND anikoto_id=${anikotoId} LIMIT 1`;
  const order=Number(found[0]?.target_order);
  return validSeasonOrder(order)?order:null;
}

export async function savePreferredAnikotoSeason(userId:string,anikotoId:string,order:number) {
  if(!userId||userId.length>100||!validAnikotoId(anikotoId)||!validSeasonOrder(order))return false;
  const candidates=await getAnikotoSeasons(anikotoId);
  if(!candidates.some(item=>item.order===order))return false;
  const sql=await ensurePreferenceTable();
  await sql`INSERT INTO anime_account_preferred_seasons(user_id,anikoto_id,target_order,updated_at)
    VALUES(${userId},${anikotoId},${order},CURRENT_TIMESTAMP)
    ON CONFLICT(user_id,anikoto_id) DO UPDATE SET
      target_order=EXCLUDED.target_order,updated_at=CURRENT_TIMESTAMP`;
  return true;
}
