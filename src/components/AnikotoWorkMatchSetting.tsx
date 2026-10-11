"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

type Work = { id:string;title:string;year?:string|number;format?:string };

export default function AnikotoWorkMatchSetting({animeId,retryPlayback=false}:{
  animeId:string;retryPlayback?:boolean;
}) {
  const router=useRouter();
  const [query,setQuery]=useState("");
  const [items,setItems]=useState<Work[]>([]);
  const [current,setCurrent]=useState<Work|null>(null);
  const [manual,setManual]=useState(false);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState("");
  const [loaded,setLoaded]=useState(false);

  async function read(q="") {
    const resp=await fetch("/api/anime/anikoto-work-match?animeId="+
      encodeURIComponent(animeId)+"&q="+encodeURIComponent(q),{cache:"no-store"});
    const data=await resp.json();
    if(!resp.ok)throw Error(data.message);
    setManual(data.manual);setCurrent(data.current);setItems(data.candidates);
    setLoaded(true);
    return data;
  }
  async function search(event:React.FormEvent) {
    event.preventDefault();setBusy(true);setNotice("");
    try {
      const data=await read(query);
      if(!data.candidates.length)setNotice("검색 결과가 없습니다. 제목이나 Anikoto ID로 검색해 주세요.");
    } catch(e:any){setNotice(e.message);}finally{setBusy(false);}
  }
  async function save(targetId?:string) {
    setBusy(true);setNotice("");
    try {
      const response=await fetch(targetId?"/api/anime/anikoto-work-match":
        "/api/anime/anikoto-work-match?animeId="+encodeURIComponent(animeId),{
        method:targetId?"PUT":"DELETE",
        headers:{"Content-Type":"application/json"},
        ...(targetId?{body:JSON.stringify({animeId,targetId})}:{})
      });
      const result=await response.json();
      if(!response.ok)throw Error(result.message);
      await read();
      setNotice(targetId?"Anikoto 작품 연결을 저장했습니다.":"Anikoto 수동 연결을 해제했습니다.");
      if(targetId && retryPlayback) {
        const params=new URLSearchParams(window.location.search);
        params.set("video_source","anikoto");params.delete("manual_source");
        router.replace(window.location.pathname+"?"+params.toString());
      }
      router.refresh();
    } catch(e:any){setNotice(e.message);}finally{setBusy(false);}
  }
  if(!/^ani_[1-9]\d*$/.test(animeId))return null;
  return <section className="mt-4 rounded-2xl border border-purple-500/25 bg-slate-900/60 p-4 text-sm text-slate-300">
    <h2 className="font-bold text-white">Anikoto 작품 연결 {manual?"· 수동 확정":""}</h2>
    <p className="mt-2 text-xs text-slate-400">ReAnime에 없는 작품도 Anikoto 영상 DB로 직접 연결할 수 있습니다.
      여러 시즌을 공유하는 Anikoto 영상은 검수된 회차 범위가 있을 때만 허용합니다.</p>
    {!loaded && <button type="button" disabled={busy}
      onClick={async()=>{setBusy(true);try{await read();}catch(e:any){setNotice(e.message);}finally{setBusy(false);}}}
      className="mt-3 rounded-lg bg-purple-700 px-3 py-2">Anikoto 연결 확인</button>}
    {loaded && <p className="mt-2">현재 연결: {current?current.title:"없음"}</p>}
    <form onSubmit={search} className="mt-3 flex gap-2">
      <input aria-label="Anikoto 작품 검색" value={query} onChange={e=>setQuery(e.target.value)}
        placeholder="Anikoto 제목 또는 ID" className="min-w-0 flex-1 rounded-lg bg-slate-950 p-2" maxLength={160}/>
      <button disabled={busy||query.trim().length<2} className="rounded-lg bg-purple-600 px-3 disabled:opacity-50">검색</button>
    </form>
    <ul className="mt-3 space-y-2">{items.map(item=><li key={item.id}
      className="flex items-center justify-between gap-3 rounded-lg bg-slate-950 p-3">
      <div><p>{item.title} {item.year&&" · "+item.year}</p>
      <p className="break-all text-xs text-slate-400">{item.id}</p></div>
      <button type="button" disabled={busy} onClick={()=>save(item.id)}
        className="shrink-0 rounded-lg bg-purple-600 px-3 py-2 disabled:opacity-50">
        {retryPlayback?"연결하고 재생":"이 작품으로 연결"}</button>
    </li>)}</ul>
    {manual&&<button type="button" disabled={busy} onClick={()=>save()}
      className="mt-3 underline disabled:opacity-50">Anikoto 수동 연결 해제</button>}
    {notice&&<p role="status" className="mt-2 text-xs text-amber-200">{notice}</p>}
  </section>;
}
