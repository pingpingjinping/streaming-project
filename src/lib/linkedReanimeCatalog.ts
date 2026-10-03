import {getDb} from './db';
import {getReanimeArtwork} from './providers/reanime';
import {fetchAniListMeta} from './providers/anissia';
import type {AnimeListResponse} from './providers/types';

/** Page confirmed DB links before requesting artwork; never filter one remote page. */
export async function getLinkedReanimeCatalog(options:{page?:number;q?:string;year?:string;sort?:string}={}):Promise<AnimeListResponse> {
  const page=Number.isSafeInteger(options.page) && options.page!>0?options.page!:1;
  const empty={items:[],page,has_next:false,total_pages:1};
  const sql=getDb();if(!sql)return empty;
  const query=(options.q || '').normalize('NFKC').trim().toLowerCase();
  const compact=query.replace(/[^\p{L}\p{N}]/gu,'');
  const year=/^\d{4}$/.test(options.year || '')?options.year!:'';
  const sort=options.sort==='year_asc'?'ASC':'DESC';
  const yearExpression="CASE WHEN r.payload->>'year' ~ '^[0-9]{4}$' THEN (r.payload->>'year')::integer END";
  const from=`FROM anime_reanime_matches m
    JOIN anime_catalog_entries r ON r.source='ReAnime' AND r.source_record_id=m.reanime_id
    WHERE m.review_status IN ('검토된 사항','자동확정')
      AND ($1='' OR regexp_replace(lower(concat_ws(' ',m.korean_title,r.payload->>'title_native',
        r.payload->>'title_romaji',r.payload->>'title_english')), '[^[:alnum:]가-힣]', '', 'g') LIKE $2)
      AND ($3='' OR r.payload->>'year'=$3)`;
  const parameters=[query,`%${compact}%`,year];
  try {
    const [counts,rows]=await Promise.all([
      sql.unsafe(`SELECT count(*) AS total ${from}`,parameters),
      sql.unsafe(`SELECT m.reanime_id,m.korean_title,r.payload,${yearExpression} AS work_year ${from}
        ORDER BY work_year ${sort} NULLS LAST,m.korean_title,m.reanime_id LIMIT 20 OFFSET $4`,[...parameters,(page-1)*20]),
    ]);
    const total=Number(counts[0]?.total)||0;
    const items=[];
    for(let i=0;i<rows.length;i+=5)items.push(...await Promise.all(rows.slice(i,i+5).map(async row=>{
      const search=row.payload?.title_native || row.payload?.title_english || row.payload?.title_romaji || row.korean_title;
      const artwork=await getReanimeArtwork(String(row.reanime_id)) || await fetchAniListMeta(String(search));
      const id='re_'+row.reanime_id;
      return {id,title:String(row.korean_title),poster:artwork?.poster || '',detail_url:`/anime/${id}`,
        remarks:`DB 연결 확정${row.work_year?' · '+row.work_year+'년':''}`,rating:artwork?.rating ?? null};
    })));
    return {items,page,has_next:page*20<total,total_pages:Math.max(1,Math.ceil(total/20))};
  }catch(error){console.warn('[linked ReAnime catalog]:',error);return empty;}
}
