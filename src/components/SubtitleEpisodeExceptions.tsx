"use client";
import {useEffect,useState} from 'react';

export interface ExceptionCandidate {
  name:string;sourceProvider?:'aniall'|'anissia'|'naver';localFileId?:string;reviewedFileId?:string;
}
type Exception = {episodeNumber:number;provider:string;fileId:string;label:string};
export default function SubtitleEpisodeExceptions({animeId,animeTitle,currentEpisode,candidate,onCancel,onSaved}: {
  animeId:string;animeTitle:string;currentEpisode:number;candidate:ExceptionCandidate|null;
  onCancel:()=>void;onSaved?:(subtitle:any,episode:number)=>void;
}) {
  const [exceptions,setExceptions]=useState<Exception[]>([]);
  const [targetEpisode,setTargetEpisode]=useState(String(currentEpisode));
  const [saving,setSaving]=useState(false),[notice,setNotice]=useState('');
  useEffect(()=>{setTargetEpisode(String(currentEpisode));if(candidate)setNotice('');},[candidate,currentEpisode]);
  useEffect(()=>{
    let cancelled=false;
    fetch(`/api/anime/subtitle-exceptions?animeId=${encodeURIComponent(animeId)}`,{cache:'no-store'})
      .then(async r=>{const data=await r.json();if(!r.ok || !data.success) throw new Error(data.message || '예외 목록을 불러오지 못했습니다.');return data;})
      .then(data=>{if(!cancelled)setExceptions(data.exceptions || []);})
      .catch(error=>{if(!cancelled)setNotice(error.message);});
    return()=>{cancelled=true;};
  },[animeId]);
  const changed=()=>window.dispatchEvent(new CustomEvent('subtitle-settings-changed',{detail:{animeId}}));
  const save=async()=>{
    const episode=Number(targetEpisode),fileId=candidate?.reviewedFileId || candidate?.localFileId;
    if(!candidate?.sourceProvider || !fileId || !Number.isInteger(episode) || episode<1 || episode>10000) {
      setNotice('예외로 지정할 파일과 적용 회차를 확인해 주세요.');return;
    }
    setSaving(true);setNotice('');
    try {
      const response=await fetch('/api/anime/subtitle-exceptions',{method:'PUT',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({animeId,episodeNumber:episode,provider:candidate.sourceProvider,fileId})});
      const data=await response.json();if(!response.ok || !data.success) throw new Error(data.message || '예외를 저장하지 못했습니다.');
      setExceptions(data.exceptions || []);setNotice(`${episode}화 예외를 저장했어. 이 회차에만 적용돼.`);
      changed();onSaved?.(data.subtitle,episode);onCancel();
    } catch(error) {setNotice(error instanceof Error?error.message:'예외를 저장하지 못했습니다.');}
    finally {setSaving(false);}
  };
  const remove=async(episode:number)=>{
    setSaving(true);setNotice('');
    try {
      const response=await fetch(`/api/anime/subtitle-exceptions?animeId=${encodeURIComponent(animeId)}&ep=${episode}`,{method:'DELETE'});
      const data=await response.json();if(!response.ok || !data.success) throw new Error(data.message || '예외를 해제하지 못했습니다.');
      setExceptions(data.exceptions || []);setNotice(`${episode}화 예외를 해제했어.`);changed();
    } catch(error) {setNotice(error instanceof Error?error.message:'예외를 해제하지 못했습니다.');}
    finally {setSaving(false);}
  };
  if(!candidate && !exceptions.length && !notice) return null;
  return <section className="my-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
    <h3 className="font-bold text-amber-100">회차별 자막 예외</h3>
    {candidate && <div className="mt-2 space-y-2">
      <p className="break-words text-slate-300">선택한 파일: {candidate.name}</p>
      <p className="text-slate-400">{animeTitle}의 지정한 한 회차에만 사용해. TV·OVA 파일은 각각 선택할 수 있어.</p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-slate-300">적용 회차 <input aria-label="예외 적용 회차" type="number" min={1} max={10000}
          value={targetEpisode} onChange={e=>setTargetEpisode(e.target.value)}
          className="ml-2 w-20 rounded-lg border border-slate-600 bg-slate-950 px-2 py-1.5 text-white" /></label>
        <button type="button" disabled={saving} onClick={save} className="rounded-lg bg-amber-600 px-3 py-2 font-bold text-white disabled:opacity-50">{saving?'저장 중…':'예외 저장'}</button>
        <button type="button" disabled={saving} onClick={onCancel} className="rounded-lg px-3 py-2 text-slate-300">취소</button>
      </div>
    </div>}
    {!!exceptions.length && <ul className="mt-2 max-h-40 space-y-2 overflow-y-auto">
      {exceptions.map(e=><li key={e.episodeNumber} className="flex items-center gap-2">
        <span className="min-w-0 flex-1 break-words text-slate-300">{e.episodeNumber}화 · {e.label}</span>
        <button type="button" disabled={saving} onClick={()=>remove(e.episodeNumber)} className="shrink-0 rounded-lg border border-slate-600 px-2 py-1 text-slate-300 disabled:opacity-50">예외 해제</button>
      </li>)}
    </ul>}
    {notice && <p role="status" className="mt-2 text-amber-200">{notice}</p>}
  </section>;
}
