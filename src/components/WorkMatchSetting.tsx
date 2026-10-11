'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import AnikotoWorkMatchSetting from './AnikotoWorkMatchSetting';
type Item = {id:string;title:string;nativeTitle?:string;year?:number;format?:string;score?:number;reason?:string};
export default function WorkMatchSetting({animeId,retryPlayback=false,onConnectionSaved}:{animeId:string;retryPlayback?:boolean;onConnectionSaved?:()=>void}) {
  const router = useRouter();
  const [current,setCurrent] = useState<Item|null>(null);
  const [manual,setManual] = useState(false);
  const [candidate,setCandidate] = useState(false);
  const [reason,setReason] = useState('');
  const [query,setQuery] = useState('');
  const [items,setItems] = useState<Item[]>([]);
  const [busy,setBusy] = useState(false);
  const [notice,setNotice] = useState('');
  const [canEdit,setCanEdit] = useState(false);
  const [loaded,setLoaded] = useState(false);
  async function read(q='', signal?:AbortSignal) {
    const response = await fetch(`/api/anime/work-match?animeId=${encodeURIComponent(animeId)}&q=${encodeURIComponent(q)}`,{cache:'no-store',signal});
    const data = await response.json();
    if (!response.ok) throw new Error(data.message);
    return data;
  }
  useEffect(()=>{
    if (!/^(re_|ani_)/.test(animeId)) return;
    const controller = new AbortController();
    read('',controller.signal).then(data=>{setCurrent(data.current);setManual(data.manual);setCandidate(data.matchStatus==='candidate');setReason(data.candidateReason || '');setItems(data.candidates);setCanEdit(data.canEdit);setLoaded(true);})
      .catch(error=>{if(error.name!=='AbortError')setNotice(error.message);});
    return ()=>controller.abort();
  },[animeId]);
  async function search(event:React.FormEvent) {
    event.preventDefault();setBusy(true);setNotice('');
    try {const data=await read(query);setItems(data.candidates);if(!data.candidates.length)setNotice('검색 결과가 없습니다. 다른 언어 제목이나 작품 ID로 검색해 주세요.');}
    catch(error:any){setNotice(error.message);}finally{setBusy(false);}
  }
  async function save(targetId?:string) {
    setBusy(true);setNotice('');
    try {
      const response = await fetch(targetId ? '/api/anime/work-match' : `/api/anime/work-match?animeId=${encodeURIComponent(animeId)}`,{
        method:targetId?'PUT':'DELETE',headers:{'Content-Type':'application/json'},
        ...(targetId?{body:JSON.stringify({animeId,targetId})}:{})});
      const data=await response.json();if(!response.ok)throw new Error(data.message);
      const next=await read();setCurrent(next.current);setManual(next.manual);setCandidate(next.matchStatus==='candidate');setReason(next.candidateReason || '');setItems(next.candidates);
      setNotice(targetId?'작품 연결을 저장했습니다.':'자동 매칭으로 되돌렸습니다.');
      if (targetId && retryPlayback) {
        const params = new URLSearchParams(window.location.search);
        // This control links Anissia to ReAnime. Retry the newly selected
        // provider, even if the failed request explicitly selected Anikoto.
        if (animeId.startsWith('ani_')) params.set('video_source','rean');
        params.delete('manual_source');
        const query = params.toString();
        router.replace(`${window.location.pathname}${query?`?${query}`:''}`);
        onConnectionSaved?.();
      }
      router.refresh();
    }catch(error:any){setNotice(error.message);}finally{setBusy(false);}
  }
  if (!/^(re_|ani_)/.test(animeId)) return null;
  return <><section id="work-match-control" className="mt-5 rounded-2xl border border-purple-500/25 bg-slate-900/60 p-4 text-sm text-slate-300">
    <h2 className="font-bold text-white">작품 연결 {loaded && (manual?'· 수동 확정':candidate?'· 후보 연결':current?'· 확정 연결':'· 연결 없음')}</h2>
    <p className="mt-2">{animeId.startsWith('ani_')?'영상 작품':'자막 작품'}: {current?`${current.title}${current.year?' · '+current.year+'년':''}`:loaded?'연결 없음':'불러오는 중…'}</p>
    {candidate && <p className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-amber-200">후보 연결 · {reason}. 이 작품으로 임시 연결되어 있습니다. 제목과 시즌을 확인해 주세요.</p>}
    {canEdit && <>
      <p className="mt-2 text-xs text-slate-400">제목과 시즌을 확인한 뒤 바꿔 주세요. 모든 사용자에게 적용되며 DB 갱신 후에도 유지됩니다.</p>
      {candidate && current && <button type="button" disabled={busy} onClick={()=>save(current.id)} className="mt-3 rounded-lg bg-amber-600 px-3 py-2 disabled:opacity-50">이 후보로 확정</button>}
      <form onSubmit={search} className="mt-3 flex gap-2">
        <input aria-label="연결할 작품 검색" value={query} onChange={e=>setQuery(e.target.value)} placeholder="작품 제목 또는 ID" className="min-w-0 flex-1 rounded-lg bg-slate-950 p-2" maxLength={200}/>
        <button disabled={busy || query.trim().length<2} className="rounded-lg bg-purple-600 px-3 disabled:opacity-50">검색</button>
      </form>
      {items.length>0 && <p className="mt-3 text-xs text-slate-400">{query.trim()?'검색 결과':'우선 검토 후보'}</p>}
      <ul className="mt-3 space-y-2">{items.map(item=><li key={item.id} className="flex items-center justify-between gap-3 rounded-lg bg-slate-950 p-3">
        <div><p>{item.title} {item.year && `· ${item.year}년`} {item.format && `· ${item.format}`}</p><p className="text-xs text-amber-200">{item.reason}</p><p className="break-all text-xs text-slate-400">{item.nativeTitle} · {item.id}</p></div>
        <button type="button" disabled={busy} onClick={()=>save(item.id)} className="shrink-0 rounded-lg bg-purple-600 px-3 py-2 disabled:opacity-50">{retryPlayback?'연결하고 다시 재생':'이 작품으로 변경'}</button>
      </li>)}</ul>
      {manual && <button type="button" disabled={busy} onClick={()=>save()} className="mt-3 underline disabled:opacity-50">자동 매칭으로 되돌리기</button>}
    </>}
    {notice && <p role="status" className="mt-2 text-xs text-amber-200">{notice}</p>}
  </section>
  <AnikotoWorkMatchSetting animeId={animeId} retryPlayback={retryPlayback}/>
  </>;
}
