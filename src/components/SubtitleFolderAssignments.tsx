"use client";
import {useEffect,useState} from 'react';
import {bundleScopeKey,parseBundleScope} from '@/lib/subtitleLocalIdentity';
import type {SubtitleKind} from '@/lib/subtitleLocalIdentity';

export type FolderChoice={folderKey?:string;folderName?:string;provider?:string;sourceFolderKey?:string;sourceFolderLabel?:string;sourceProvider?:string};
type FolderRange={startEpisode:number;subtitleEpisode:number;season:number;provider:string;folderKey:string;label:string};
const validEpisode=(value:number)=>Number.isInteger(value)&&value>=1&&value<=10000;

export default function SubtitleFolderAssignments({animeId,choices,onSaved,currentEpisode=1}:{
  animeId:string;choices:FolderChoice[];currentEpisode?:number;
  onSaved:(assignment:{animeId:string;provider:'aniall'|'anissia'|'naver';bundleKey:string;label:string;exclusive:boolean})=>void;
}) {
  const [saving,setSaving]=useState(''),[notice,setNotice]=useState('');
  const [settings,setSettings]=useState<Record<string,{kind:SubtitleKind;season:number}>>({});
  const [rangeStart,setRangeStart]=useState(String(currentEpisode));
  const [subtitleStart,setSubtitleStart]=useState('1');
  const [ranges,setRanges]=useState<FolderRange[]>([]);
  useEffect(()=>setRangeStart(String(currentEpisode)),[currentEpisode]);
  useEffect(()=>{
    let cancelled=false;
    fetch(`/api/anime/subtitle-folder-ranges?animeId=${encodeURIComponent(animeId)}`,{cache:'no-store'})
      .then(r=>r.json()).then(data=>{if(!cancelled&&data.success)setRanges(data.ranges||[]);})
      .catch(()=>{if(!cancelled)setNotice('구간 설정을 불러오지 못했어.');});
    return ()=>{cancelled=true;};
  },[animeId]);
  const rows=[...new Map(choices.flatMap(choice=>{
    const key=choice.folderKey || choice.sourceFolderKey,scope=key?parseBundleScope(key):null;
    return key && scope?.type==='folder' ? [[key,{key,scope} ] as const] : [];
  })).values()];

  const save=async(key:string)=>{
    const scope=parseBundleScope(key);if(scope?.type!=='folder')return;
    const value=settings[key] || scope;
    if(!Number.isInteger(value.season)||value.season<1||value.season>99){setNotice('시즌 번호를 확인해 주세요.');return;}
    setSaving(key);setNotice('');
    try {
      const response=await fetch('/api/anime/subtitle-bundle',{method:'PUT',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({animeId,provider:scope.provider,bundleKey:bundleScopeKey({...scope,...value})})});
      const data=await response.json();if(!response.ok||!data.success)throw new Error(data.message||'폴더를 지정하지 못했습니다.');
      onSaved(data.assignment);setNotice('폴더를 지정했어. 다음 화도 이 폴더에서 찾아. 버전이 여러 개면 현재 화 파일을 골라 줘.');
      window.dispatchEvent(new CustomEvent('subtitle-settings-changed',{detail:{animeId}}));
    }catch(error){setNotice(error instanceof Error?error.message:'폴더를 지정하지 못했습니다.');}
    finally{setSaving('');}
  };

  const saveRange=async(key:string)=>{
    const scope=parseBundleScope(key);if(scope?.type!=='folder')return;
    const value=settings[key]||scope,startEpisode=Number(rangeStart),subtitleEpisode=Number(subtitleStart);
    if(!validEpisode(startEpisode)||!validEpisode(subtitleEpisode)
      ||!Number.isInteger(value.season)||value.season<1||value.season>99) {
      setNotice('플레이어 시작 회차, 자막 첫 회차, 시즌 번호를 확인해 줘.');return;
    }
    setSaving('range:'+key);setNotice('');
    try {
      const response=await fetch('/api/anime/subtitle-folder-ranges',{method:'PUT',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({animeId,provider:scope.provider,startEpisode,subtitleEpisode,
          bundleKey:bundleScopeKey({...scope,...value})})});
      const data=await response.json();
      if(!response.ok||!data.success)throw new Error(data.message||'구간을 지정하지 못했어.');
      setRanges(data.ranges||[]);
      setNotice(`${startEpisode}화부터 시즌 ${value.season}의 ${subtitleEpisode}화로 연결했어. 다음 구간을 지정하면 자동으로 전환해.`);
      window.dispatchEvent(new CustomEvent('subtitle-settings-changed',{detail:{animeId}}));
    }catch(error){setNotice(error instanceof Error?error.message:'구간을 지정하지 못했어.');}
    finally{setSaving('');}
  };

  const removeRange=async(startEpisode:number)=>{
    setSaving('delete:'+startEpisode);setNotice('');
    try {
      const response=await fetch(`/api/anime/subtitle-folder-ranges?animeId=${encodeURIComponent(animeId)}&startEpisode=${startEpisode}`,{method:'DELETE'});
      const data=await response.json();
      if(!response.ok||!data.success)throw new Error(data.message||'구간을 삭제하지 못했어.');
      setRanges(data.ranges||[]);setNotice(`${startEpisode}화 구간 지정을 삭제했어.`);
      window.dispatchEvent(new CustomEvent('subtitle-settings-changed',{detail:{animeId}}));
    }catch(error){setNotice(error instanceof Error?error.message:'구간을 삭제하지 못했어.');}
    finally{setSaving('');}
  };
  if(!rows.length && !ranges.length)return null;
  return <section className="my-3 space-y-3 rounded-xl border border-emerald-500/30 p-3 text-xs">
    <h3 className="font-bold text-emerald-200">폴더 전체 / 회차 구간 지정</h3>
    <p className="text-slate-400">기존 폴더 전체 지정은 그대로 쓸 수 있어. 시즌이 다른 자막은 이번 화부터 따로 지정하고, 다음 구간이 시작되면 이전 구간은 자동으로 끝나.</p>
    {rows.length>0&&<div className="flex flex-wrap gap-3 rounded-lg border border-slate-700/70 p-2">
      <label className="text-slate-300">플레이어 시작 화
        <input aria-label="구간 시작 회차" type="number" min={1} max={10000} value={rangeStart}
          onChange={e=>setRangeStart(e.target.value)}
          className="ml-2 w-20 rounded border border-slate-600 bg-slate-950 p-1.5 text-white"/>
      </label>
      <label className="text-slate-300">자막 시작 화
        <input aria-label="구간 자막 첫 회차" type="number" min={1} max={10000} value={subtitleStart}
          onChange={e=>setSubtitleStart(e.target.value)}
          className="ml-2 w-20 rounded border border-slate-600 bg-slate-950 p-1.5 text-white"/>
      </label>
      <p className="w-full text-[11px] text-slate-400">예: 은혼 50화부터 S02 1화 → 플레이어 50 / 자막 1 / 아래 시즌 2</p>
    </div>}
    {rows.slice(0,50).map(({key,scope})=>{
      const value=settings[key] || scope;
      return <div key={key} className="space-y-2 rounded-lg bg-slate-900/70 p-2">
        <p className="break-words [overflow-wrap:anywhere] text-white">{scope.provider==='anissia'?'애니시아':'애니올'} · {scope.work}</p>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label={`${scope.work} 형식`} value={value.kind} onChange={e=>setSettings(previous=>({...previous,[key]:{...value,kind:e.target.value as SubtitleKind}}))}
            className="rounded border border-slate-600 bg-slate-950 p-1.5 text-white">
            <option value="main">TV/본편</option><option value="ova">OVA/OAD</option><option value="special">특전/특별편</option>
            <option value="movie">극장판</option><option value="preview">예고/CM</option><option value="drama">음성드라마</option><option value="unknown">형식 확인 필요</option>
          </select>
          <label className="text-slate-300">자막 시즌 <input aria-label={`${scope.work} 시즌`} type="number" min={1} max={99}
            value={value.season} onChange={e=>setSettings(previous=>({...previous,[key]:{...value,season:Number(e.target.value)}}))}
            className="ml-1 w-14 rounded border border-slate-600 bg-slate-950 p-1.5 text-white" /></label>
          <button type="button" disabled={!!saving} onClick={()=>save(key)}
            className="rounded-lg bg-emerald-600 px-3 py-2 font-bold text-white disabled:opacity-50">
            {saving===key?'지정 중…':'폴더 전체 지정'}</button>
          <button type="button" disabled={!!saving} onClick={()=>saveRange(key)}
            className="rounded-lg bg-purple-700 px-3 py-2 font-bold text-white disabled:opacity-50">
            {saving==='range:'+key?'구간 저장 중…':'이번 화부터 이 폴더 지정'}</button>
        </div>
      </div>;
    })}
    {ranges.length>0&&<div className="space-y-2 rounded-lg border border-slate-600/60 p-2">
      <p className="font-semibold text-emerald-200">저장된 자막 구간 ({ranges.length})</p>
      {ranges.map((range,i)=><div key={range.startEpisode} className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-700 py-1">
        <span className="text-slate-200">{range.startEpisode}~{ranges[i+1]?ranges[i+1].startEpisode-1:'이후'}화
          {' → '}시즌 {range.season} · {range.subtitleEpisode}화부터 · {range.provider==='aniall'?'애니올':'애니시아'}
        </span>
        <button type="button" disabled={!!saving} onClick={()=>removeRange(range.startEpisode)}
          className="rounded border border-red-500/50 px-2 py-1 text-red-300 disabled:opacity-50">구간 삭제</button>
      </div>)}
    </div>}
    {notice&&<p role="status" className="text-emerald-200">{notice}</p>}
  </section>;
}
