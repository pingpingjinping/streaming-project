import Navbar from "@/components/Navbar";
import { requireAuth } from "@/lib/auth";
import { getDb } from "@/lib/db";
import snapshot0 from "@/data/korean-catalog-0.json";
import snapshot1 from "@/data/korean-catalog-1.json";
import snapshot2 from "@/data/korean-catalog-2.json";
import snapshot3 from "@/data/korean-catalog-3.json";
import snapshot4 from "@/data/korean-catalog-4.json";
import snapshot5 from "@/data/korean-catalog-5.json";
import snapshot6 from "@/data/korean-catalog-6.json";
import snapshot7 from "@/data/korean-catalog-7.json";
import snapshot8 from "@/data/korean-catalog-8.json";
import snapshot9 from "@/data/korean-catalog-9.json";
import Link from "next/link";

interface CatalogItem {
  source: string;
  sourceId: string;
  year: number | null;
  title: string;
  nativeTitle: string;
  englishTitle: string;
  status: string;
  anilistId: string;
  reanimeId: string;
  animeId: string;
}

const catalogSnapshot: CatalogItem[] = [...snapshot0,...snapshot1,...snapshot2,...snapshot3,...snapshot4,
  ...snapshot5,...snapshot6,...snapshot7,...snapshot8,...snapshot9];

export default async function KoreanCatalog({searchParams}: {
  searchParams: Promise<{q?:string; page?:string; source?:string}>;
}) {
  await requireAuth();
  const params=await searchParams;
  const q=(params.q || "").trim().slice(0,100);
  const source=params.source==='Anissia' || params.source==='Onnada' ? params.source : '';
  const page=Math.max(1,Math.min(400,Number.parseInt(params.page || '1',10) || 1));
  let items: CatalogItem[]=[];
  let total=0;
  const sql=getDb();
  let loaded=false;
  if(sql){
    try {
      const pattern=`%${q.replace(/[\\%_]/g,(x)=>`\\${x}`)}%`;
      const [count, rows]=await Promise.all([
        sql`SELECT count(*)::int AS total FROM anime_korean_catalog WHERE
          (${source}='' OR source=${source}) AND
          (${q}='' OR payload->>'title' ILIKE ${pattern} ESCAPE '\\' OR
           payload->>'nativeTitle' ILIKE ${pattern} ESCAPE '\\' OR
           payload->>'englishTitle' ILIKE ${pattern} ESCAPE '\\')`,
        sql`SELECT payload FROM anime_korean_catalog WHERE
          (${source}='' OR source=${source}) AND
          (${q}='' OR payload->>'title' ILIKE ${pattern} ESCAPE '\\' OR
           payload->>'nativeTitle' ILIKE ${pattern} ESCAPE '\\' OR
           payload->>'englishTitle' ILIKE ${pattern} ESCAPE '\\')
          ORDER BY (payload->>'year')::integer DESC NULLS LAST, source_record_id DESC
          LIMIT 30 OFFSET ${(page-1)*30}`,
      ]);
      total=Number(count[0]?.total || 0);
      if(total){items=rows.map((r)=>r.payload as CatalogItem);loaded=true;}
    } catch { /* Bundled snapshot is available before the first Pi import. */ }
  }
  if(!loaded){
    const filtered=(catalogSnapshot as CatalogItem[]).filter((r)=>
      (!source || r.source===source) &&
      (!q || [r.title,r.nativeTitle,r.englishTitle].some((s)=>s.toLocaleLowerCase().includes(q.toLocaleLowerCase()))));
    total=filtered.length;
    items=filtered.sort((a,b)=>(b.year || 0)-(a.year || 0)).slice((page-1)*30,page*30);
  }
  const search=(p:number)=>`/catalog?${new URLSearchParams({q,source,page:String(p)})}`;
  return <div className="min-h-screen bg-[#0b0f19] pb-16">
    <Navbar />
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-black text-white">한글 애니 DB</h1>
      <p className="mt-2 text-sm text-slate-400">온나다와 애니시아 한글 제목 전체 {total.toLocaleString()}건. 확인된 연결은 영어·일본어 제목 표시에도 사용합니다.</p>
      <form action="/catalog" className="mt-6 flex flex-wrap gap-2">
        <input name="q" defaultValue={q} placeholder="한글·영어·일본어 제목 검색"
          className="min-w-48 flex-1 rounded-xl border border-white/10 bg-slate-900 px-4 py-2 text-sm text-white" />
        <select name="source" defaultValue={source} className="rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white">
          <option value="">전체</option><option value="Onnada">온나다</option><option value="Anissia">애니시아</option>
        </select>
        <button className="rounded-xl bg-purple-600 px-4 py-2 text-sm font-bold text-white">검색</button>
      </form>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item)=><div key={`${item.source}:${item.sourceId}`} className="rounded-2xl border border-white/10 bg-slate-900/70 p-4">
          <div className="mb-2 flex items-center gap-2 text-xs text-slate-400">
            <span>{item.source==='Onnada'?'온나다':'애니시아'}</span>
            <span>{item.year || '연도 미상'}</span>
            <span className={item.status==='검토된 사항'?'text-emerald-300':'text-amber-300'}>{item.status}</span>
          </div>
          <div className="font-semibold text-white">{item.title}</div>
          {item.nativeTitle && <div className="mt-1 text-xs text-slate-400">{item.nativeTitle}</div>}
          {item.englishTitle && <div className="mt-1 text-xs text-slate-500">{item.englishTitle}</div>}
          {item.animeId && <Link href={`/anime/${item.animeId}`} className="mt-3 inline-block text-xs font-bold text-purple-300 hover:text-white">작품 보기 →</Link>}
        </div>)}
      </div>
      {!items.length && <p className="py-12 text-center text-sm text-slate-400">검색 결과가 없습니다.</p>}
      <div className="mt-6 flex items-center justify-center gap-4 text-sm text-slate-300">
        {page>1 && <Link href={search(page-1)} className="rounded-lg bg-slate-800 px-3 py-2">이전</Link>}
        <span>{page} / {Math.max(1,Math.ceil(total/30))}</span>
        {page*30<total && <Link href={search(page+1)} className="rounded-lg bg-slate-800 px-3 py-2">다음</Link>}
      </div>
    </main>
  </div>;
}
