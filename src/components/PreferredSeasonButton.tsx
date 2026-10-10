"use client";

import {useState} from "react";
import {useRouter} from "next/navigation";

export default function PreferredSeasonButton({
  anikotoId,order,href,currentPreferred,label="이 시즌 우선 연결",
}:{
  anikotoId:string;order:number;href:string;currentPreferred:boolean;label?:string;
}) {
  const router=useRouter();
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  if(currentPreferred)return <span className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">현재 우선 시즌</span>;
  return <div className="inline-flex flex-col items-start gap-1">
    <button type="button" disabled={busy}
      onClick={async()=>{
        setBusy(true);setError("");
        try {
          const response=await fetch("/api/anime/preferred-season",{
            method:"PUT",
            headers:{"Content-Type":"application/json"},
            body:JSON.stringify({anikotoId,order}),
          });
          const payload=await response.json();
          if(!response.ok)throw new Error(payload.message||"시즌 저장 실패");
          router.push(href);
          router.refresh();
        }catch(e:any) {
          setError(e.message||"시즌 우선 연결 실패");
          setBusy(false);
        }
      }}
      className="rounded-lg bg-purple-600 px-3 py-2 text-xs font-semibold text-white hover:bg-purple-500 disabled:opacity-50">
      {busy?"저장 중…":label}
    </button>
    {!!error&&<p role="alert" className="max-w-xs text-xs text-amber-300">{error}</p>}
  </div>;
}
