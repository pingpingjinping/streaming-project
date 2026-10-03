"use client";
import {useState} from 'react';
import {bundleScopeKey,parseBundleScope} from '@/lib/subtitleLocalIdentity';
import type {SubtitleKind} from '@/lib/subtitleLocalIdentity';
export type FolderChoice={folderKey?:string;folderName?:string;provider?:string;sourceFolderKey?:string;sourceFolderLabel?:string;sourceProvider?:string};
export default function SubtitleFolderAssignments({animeId,choices,onSaved}:{animeId:string;choices:FolderChoice[];onSaved:(assignment:{animeId:string;provider:'aniall'|'anissia'|'naver';bundleKey:string;label:string;exclusive:boolean})=>void}) {
  const [saving,setSaving]=useState(''),[notice,setNotice]=useState('');
  const [settings,setSettings]=useState<Record<string,{kind:SubtitleKind;season:number}>>({});
  const rows=[...new Map(choices.flatMap(choice=>{
    const key=choice.folderKey || choice.sourceFolderKey,scope=key?parseBundleScope(key):null;
    return key && scope?.type==='folder' ? [[key,{key,scope} ] as const] : [];
  })).values()];
  const save=async(key:string)=>{
    const scope=parseBundleScope(key);if(scope?.type!=='folder')return;
    const value=settings[key] || scope;
    if(!Number.isInteger(value.season) || value.season<1 || value.season>99){setNotice('시즌 번호를 확인해 주세요.');return;}
    setSaving(key);setNotice('');
    try {
      const response=await fetch('/api/anime/subtitle-bundle',{method:'PUT',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({animeId,provider:scope.provider,bundleKey:bundleScopeKey({...scope,...value})})});
      const data=await response.json();if(!response.ok || !data.success)throw new Error(data.message || '폴더를 지정하지 못했습니다.');
      onSaved(data.assignment);setNotice('폴더를 지정했어. 다음 화도 이 폴더에서 찾아. 버전이 여러 개면 현재 화 파일을 골라 줘.');
      window.dispatchEvent(new CustomEvent('subtitle-settings-changed',{detail:{animeId}}));
    }catch(error){setNotice(error instanceof Error?error.message:'폴더를 지정하지 못했습니다.');}
    finally{setSaving('');}
  };
  if(!rows.length)return null;
  return <section className="my-3 space-y-2 rounded-xl border border-emerald-500/30 p-3 text-xs">
    <h3 className="font-bold text-emerald-200">폴더 전체 지정</h3>
    <p className="text-slate-400">압축을 푼 파일과 하위 폴더에서 회차를 찾아. 아래 형식·시즌은 폴더 안에서 사용할 자막 범위야. 같은 회차의 버전은 고른 파일과 같은 버전으로 유지돼.</p>
    {rows.slice(0,50).map(({key,scope})=>{
      const value=settings[key] || scope;
      return <div key={key} className="space-y-2 rounded-lg bg-slate-900/70 p-2">
        <p className="break-words [overflow-wrap:anywhere] text-white">{scope.provider==='anissia'?'애니시아':'애니올'} · {scope.work}</p>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label={`${scope.work} 형식`} value={value.kind} onChange={e=>setSettings(previous=>({...previous,[key]:{...value,kind:e.target.value as SubtitleKind}}))} className="rounded border border-slate-600 bg-slate-950 p-1.5 text-white">
            <option value="main">TV/본편</option><option value="ova">OVA/OAD</option><option value="special">특전/특별편</option><option value="movie">극장판</option><option value="preview">예고/CM</option><option value="drama">음성드라마</option><option value="unknown">형식 확인 필요</option>
          </select>
          <label className="text-slate-300">시즌 <input aria-label={`${scope.work} 시즌`} type="number" min={1} max={99} value={value.season} onChange={e=>setSettings(previous=>({...previous,[key]:{...value,season:Number(e.target.value)}}))} className="ml-1 w-14 rounded border border-slate-600 bg-slate-950 p-1.5 text-white" /></label>
          <button type="button" disabled={!!saving} onClick={()=>save(key)} className="rounded-lg bg-emerald-600 px-3 py-2 font-bold text-white disabled:opacity-50">{saving===key?'지정 중…':'이 폴더 지정'}</button>
        </div>
      </div>;
    })}
    {notice && <p role="status" className="text-emerald-200">{notice}</p>}
  </section>;
}
